// Tab Management System for the Sia Browser.
//
// Manages browser tabs and internal panel tabs: creation, activation,
// closing, drag-and-drop reordering, per-tab navigation history,
// and address bar synchronization.

// ── Panel ↔ URL mappings ──

export const PANEL_URLS = {
  'setup':       'sialo://settings',
  'dashboard':   'sialo://dashboard',
  'upload-file': 'sialo://upload',
  'upload-text': 'sialo://upload/text',
  'download':    'sialo://download',
  'objects':     'sialo://objects',
  'share':       'sialo://share',
  'cors':        'sialo://diagnostics',
  'history':     'sialo://history',
  'explorer':    'sialo://explorer',
  'wallet':      'sialo://wallet',
  'syncer-config': 'sialo://syncer',
  'manifest':      'sialo://manifest',
};
export const URL_TO_PANEL = Object.fromEntries(Object.entries(PANEL_URLS).map(([k, v]) => [v, k]));

export const PANEL_TITLES = {
  'register': 'Register', 'setup': 'Settings', 'dashboard': 'Dashboard', 'upload-file': 'Upload File',
  'upload-text': 'Upload Text', 'download': 'Download', 'objects': 'My Objects',
  'share': 'Share', 'cors': 'CORS Diagnostics', 'history': 'History', 'explorer': 'Explorer',
  'wallet': 'Wallet', 'manifest': 'Manifest', 'syncer-config': 'Syncer',
};

// ── Shared state ──

// Backward-compat globals (derived from active tab)
export let activePanel = null;
export let lastBrowserUrl = '';

export let tabs = [];
export let activeTabId = null;
let nextTabId = 1;
export let streamingTabId = null;
export let loadContentInProgress = false;

// Late-binding: set by the browser module once it's initialized
let _loadContentWithAutoDetect = null;
export function setLoadContentHandler(fn) { _loadContentWithAutoDetect = fn; }

export function setLoadContentInProgress(v) { loadContentInProgress = v; }
export function setStreamingTabId(v) { streamingTabId = v; }
export function setLastBrowserUrl(v) { lastBrowserUrl = v; }
export function setActivePanel(v) { activePanel = v; }

// ── Persistence ──

export function saveTabState() {
  try {
    const activeIdx = tabs.findIndex(t => t.id === activeTabId);
    const serializable = tabs.map(t => ({
      type: t.type,
      panelName: t.panelName,
      url: t.url,
      label: t.label,
    }));
    localStorage.setItem('tab-state', JSON.stringify({
      tabs: serializable,
      activeIndex: activeIdx,
    }));
  } catch (e) { /* ignore quota errors */ }
}

export function loadTabState() {
  try {
    const raw = localStorage.getItem('tab-state');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// ── Status observer ──

export function initStatusObserver() {
  const el = document.getElementById('iframe-status');
  if (el) {
    new MutationObserver(() => {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab) tab.statusHTML = el.innerHTML;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
}

// ── Tab CRUD ──

export function createTab({ type, panelName, url, label }) {
  const id = 'tab-' + (nextTabId++);
  const tab = {
    id,
    type,              // 'browser' or 'internal'
    panelName: panelName || null,
    label: label || (panelName ? PANEL_TITLES[panelName] : 'New Tab'),
    url: url || '',
    iframeEl: null,
    isStreaming: false,
    streamAbort: null,
    iframeStreamAbort: null,
    navHistory: [],    // per-tab navigation history: [{ url, blobUrl, label, fileType }]
    navIndex: -1,      // current position in navHistory
    contentLoaded: false, // true once content has been loaded into this tab
    statusHTML: '',    // per-tab status bar text (saved/restored on tab switch)
    progressValue: 0,  // per-tab progress bar state
    progressMax: 100,
    progressVisible: false,
  };

  if (type === 'browser') {
    const iframe = document.createElement('iframe');
    iframe.className = 'viewport-panel';
    iframe.dataset.tabId = id;
    iframe.style.cssText = 'border:none; background:white; display:none; width:100%; height:100%;';
    iframe.sandbox = 'allow-scripts';
    iframe.allowFullscreen = true;
    document.getElementById('viewport').appendChild(iframe);
    tab.iframeEl = iframe;
  }

  tabs.push(tab);
  renderTabBar();
  saveTabState();
  return tab;
}

export function activateTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  if (activeTabId === tabId) return; // already active

  // Save previous tab's status and progress
  const iframeStatus = document.getElementById('iframe-status');
  const progressEl = document.getElementById('browser-progress');
  const prevTab = tabs.find(t => t.id === activeTabId);
  if (prevTab) {
    if (iframeStatus) prevTab.statusHTML = iframeStatus.innerHTML;
    if (progressEl) {
      prevTab.progressValue = progressEl.value;
      prevTab.progressMax = progressEl.max;
      prevTab.progressVisible = progressEl.style.display !== 'none' && progressEl.style.display !== '';
    }
  }

  // Hide previous tab's content
  if (prevTab) {
    if (prevTab.type === 'browser') {
      if (prevTab.iframeEl) prevTab.iframeEl.style.display = 'none';
      if (prevTab.isStreaming) {
        document.getElementById('video-container').style.display = 'none';
      }
    } else {
      const panel = document.getElementById('panel-' + prevTab.panelName);
      if (panel) panel.style.display = 'none';
    }
  } else {
    // No previous tab — hide everything
    document.querySelectorAll('#viewport > .viewport-panel').forEach(el => {
      el.style.display = 'none';
    });
  }

  // Show new tab's content
  if (tab.type === 'browser') {
    if (tab.isStreaming && tab.id === streamingTabId) {
      document.getElementById('video-container').style.display = 'block';
      if (tab.iframeEl) tab.iframeEl.style.display = 'none';
    } else if (tab.iframeEl) {
      tab.iframeEl.style.display = 'block';
    }
    activePanel = 'browser';
    lastBrowserUrl = tab.url;
  } else {
    const panel = document.getElementById('panel-' + tab.panelName);
    if (panel) panel.style.display = panel.classList.contains('has-net-bar') ? 'flex' : 'block';
    activePanel = tab.panelName;
  }

  activeTabId = tabId;
  updateAddressBarForTab(tab);
  highlightActiveMenuItem(tab.type === 'internal' ? tab.panelName : null);
  renderTabBar();
  updateNavButtons();

  // Restore this tab's status text and progress bar
  if (iframeStatus) iframeStatus.innerHTML = tab.statusHTML;
  if (progressEl) {
    progressEl.value = tab.progressValue;
    progressEl.max = tab.progressMax;
    progressEl.style.display = tab.progressVisible ? 'block' : 'none';
  }

  saveTabState();

  // Auto-load browser tabs that have a URL but haven't loaded content yet
  if (tab.type === 'browser' && tab.url && !tab.contentLoaded) {
    if (_loadContentWithAutoDetect) _loadContentWithAutoDetect();
  }
}

export function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const tab = tabs[idx];

  // Clean up browser tab resources
  if (tab.type === 'browser') {
    if (tab.streamAbort) { tab.streamAbort.abort(); tab.streamAbort = null; }
    if (tab.iframeStreamAbort) { tab.iframeStreamAbort.abort(); tab.iframeStreamAbort = null; }
    if (tab.iframeEl) tab.iframeEl.remove();
    if (tab.isStreaming && tab.id === streamingTabId) {
      document.getElementById('video-container').style.display = 'none';
      const mseVideo = document.getElementById('mse-video');
      mseVideo.pause();
      mseVideo.src = '';
      mseVideo.load();
      streamingTabId = null;
    }
    tab.isStreaming = false;
    // Clear streaming status from status bar
    const iframeStatus = document.getElementById('iframe-status');
    if (iframeStatus && iframeStatus.textContent.includes('Streaming')) {
      iframeStatus.textContent = '';
    }
  } else {
    // Hide the internal panel
    const panel = document.getElementById('panel-' + tab.panelName);
    if (panel) panel.style.display = 'none';
  }

  tabs.splice(idx, 1);

  if (activeTabId === tabId) {
    activeTabId = null;
    if (tabs.length === 0) {
      const newTab = createTab({ type: 'browser', label: 'New Tab' });
      activateTab(newTab.id);
    } else {
      const newIdx = Math.min(idx, tabs.length - 1);
      activateTab(tabs[newIdx].id);
    }
  }
  renderTabBar();
  saveTabState();
}

// ── Tab bar rendering ──

let _dragTabId = null;

export function renderTabBar() {
  const tabList = document.getElementById('tab-list');
  if (!tabList) return;
  tabList.innerHTML = '';

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.draggable = true;

    el.addEventListener('dragstart', (e) => {
      _dragTabId = tab.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      _dragTabId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.tab.drag-over').forEach(t => t.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (_dragTabId && _dragTabId !== tab.id) {
        el.classList.add('drag-over');
      }
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (!_dragTabId || _dragTabId === tab.id) return;
      const fromIdx = tabs.findIndex(t => t.id === _dragTabId);
      const toIdx = tabs.findIndex(t => t.id === tab.id);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      renderTabBar();
      saveTabState();
    });

    const labelSpan = document.createElement('span');
    labelSpan.className = 'tab-label';
    labelSpan.textContent = tab.label;
    labelSpan.title = tab.url || tab.label;

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    el.appendChild(labelSpan);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => activateTab(tab.id));
    tabList.appendChild(el);
  }
}

// ── Lookup helpers ──

export function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

export function getActiveTabIframe() {
  const tab = getActiveTab();
  if (tab && tab.type === 'browser' && tab.iframeEl) return tab.iframeEl;
  return null;
}

export function findTabByIframeWindow(win) {
  return tabs.find(t => t.type === 'browser' && t.iframeEl && t.iframeEl.contentWindow === win) || null;
}

export function openOrActivateInternalTab(panelName) {
  const existing = tabs.find(t => t.type === 'internal' && t.panelName === panelName);
  if (existing) {
    activateTab(existing.id);
    return existing;
  }
  const tab = createTab({
    type: 'internal',
    panelName,
    url: PANEL_URLS[panelName],
    label: PANEL_TITLES[panelName] || panelName,
  });
  activateTab(tab.id);
  return tab;
}

export function getOrCreateActiveBrowserTab() {
  const active = getActiveTab();
  if (active && active.type === 'browser') return active;
  // Create a new browser tab
  const tab = createTab({ type: 'browser', label: 'New Tab' });
  activateTab(tab.id);
  return tab;
}

// ── Address bar & menu ──

export function updateAddressBarForTab(tab) {
  const bar = document.getElementById('chrome-address-bar');
  if (!bar) return;
  if (tab.type === 'browser') {
    bar.value = tab.url || '';
  } else {
    bar.value = PANEL_URLS[tab.panelName] || '';
  }
}

export function highlightActiveMenuItem(panelName) {
  document.querySelectorAll('.gear-menu-item').forEach(item => {
    item.classList.toggle('active', item.dataset.panel === panelName);
  });
}

export function updateConnectionStatus(connected, detail) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (dot) dot.classList.toggle('connected', connected);
  if (text) text.textContent = detail || (connected ? 'Connected' : 'Not connected');
}

// Track which browser element is active (iframe or video) for the current streaming tab
export function setBrowserView(showVideo) {
  const vc = document.getElementById('video-container');
  if (vc) vc.dataset.active = showVideo ? 'true' : 'false';
}

// ── Per-tab back/forward navigation ──

// Push a new entry to the active browser tab's nav history.
// Truncates any forward history (just like a real browser).
export function pushTabNav(tab, entry) {
  if (!tab || tab.type !== 'browser') return;
  // Avoid duplicate consecutive entries for the same URL
  if (tab.navIndex >= 0 && tab.navHistory[tab.navIndex] &&
      tab.navHistory[tab.navIndex].url === entry.url) {
    // Update blobUrl in case it changed (re-download)
    tab.navHistory[tab.navIndex].blobUrl = entry.blobUrl;
    return;
  }
  // Truncate forward history
  tab.navHistory.splice(tab.navIndex + 1);
  tab.navHistory.push(entry);
  tab.navIndex = tab.navHistory.length - 1;
  updateNavButtons();
}

export function updateNavButtons() {
  const tab = getActiveTab();
  const back = document.getElementById('btn-back');
  if (!back) return;
  back.disabled = !(tab && tab.type === 'browser' && tab.navIndex > 0);
}

let navInProgress = false; // guard to prevent pushTabNav during back/forward
export function isNavInProgress() { return navInProgress; }
export function setNavInProgress(v) { navInProgress = v; }

export function goBack() {
  const tab = getActiveTab();
  if (!tab || tab.type !== 'browser' || tab.navIndex <= 0) return;
  tab.navIndex--;
  navigateTabNavEntry(tab);
}

export function navigateTabNavEntry(tab) {
  const entry = tab.navHistory[tab.navIndex];
  if (!entry) return;

  navInProgress = true; // prevent pushTabNav from re-pushing during this load

  tab.url = entry.url;
  tab.label = entry.label || (entry.url.length > 30 ? entry.url.substring(0, 30) + '...' : entry.url);
  lastBrowserUrl = entry.url;
  renderTabBar();

  const addressBar = document.getElementById('chrome-address-bar');
  if (addressBar) addressBar.value = entry.url;

  if (entry.blobUrl) {
    // We have a cached blob — load it directly without re-downloading
    const iframe = tab.iframeEl;
    if (iframe) iframe.src = entry.blobUrl;
    updateNavButtons();
    navInProgress = false;
  } else {
    // No cached blob — re-download
    addressBar.value = entry.url;
    if (_loadContentWithAutoDetect) {
      _loadContentWithAutoDetect().finally(() => { navInProgress = false; });
    } else {
      navInProgress = false;
    }
  }
}
