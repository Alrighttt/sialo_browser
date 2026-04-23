// Browser module — decentralized content viewer with navigation, history,
// sia:// link interception, iframe video streaming, and content auto-detection.

import { _dbg, _dbgWarn, _esc, formatSize } from './utils.js';
import {
  connectSdk, resolveObject, resolveSharedObject, webcodecStream, transmuxAndStream, getMaxDownloads, getDownloadWorkers,
} from './config.js';
import {
  tabs, activeTabId, streamingTabId, loadContentInProgress,
  getOrCreateActiveBrowserTab, getActiveTab, getActiveTabIframe,
  findTabByIframeWindow, activateTab, renderTabBar,
  pushTabNav, updateNavButtons, isNavInProgress, setNavInProgress,
  setBrowserView, setStreamingTabId, setLastBrowserUrl, setLoadContentInProgress,
  saveTabState, goBack, createTab, openOrActivateInternalTab,
  activePanel, tabStatusProxy,
} from './tabs.js';
import {
  streamingDownload, parallelDownload, parallelDownloadViaSW,
} from './download.js';
import { fileTypeFromBlob } from './vendor/file-type.bundle.js';
import { createFile as createMP4Box, DataStream, Endianness } from './vendor/mp4box.bundle.js';
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { loadSite as loadSiaSiteIntoIframe, HOSTED_ORIGIN as SIA_HOSTED_ORIGIN } from './sia-site.js';

// -- Decentralized Browser (HTML Viewer with Navigation) --

// --- Sia link interception via postMessage ---
// The iframe uses sandbox="allow-scripts" (no allow-same-origin), so
// JavaScript inside it runs in an isolated opaque origin that CANNOT
// access the parent's variables, localStorage, or cookies.
//
// We inject a small script into every HTML page that intercepts clicks
// on sia:// links and sends a postMessage to the parent.  The parent
// then downloads the target via the SDK (which holds the app key) and
// loads it back into the iframe.

// Scripts injected into every HTML page loaded in the iframe.
// video-pipeline-core.js provides shared rendering/timing/audio functions.
// sia-injected.js intercepts sia:// links and handles video streaming.
let SIA_INJECTED_SCRIPT = '';
const siaInjectedReady = Promise.all([
  fetch('./video-pipeline-core.js').then(r => r.text()),
  fetch('./sia-injected.js').then(r => r.text()),
]).then(([coreJs, injectedJs]) => {
  SIA_INJECTED_SCRIPT = '<script>' + coreJs + '<\/script><script>' + injectedJs + '<\/script>';
});

// Render a text string as styled markdown HTML and return a blob URL.
// Uses marked for parsing and DOMPurify for sanitization.
function renderMarkdownHtml(text) {
  const rawHtml = marked.parse(text);
  const s = DOMPurify.sanitize(rawHtml, {
    ALLOWED_URI_REGEXP: /^(?:https?|sia):\/\/|^[#./]/i,
    ADD_TAGS: ['img'],
    ADD_ATTR: ['target'],
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:system-ui,-apple-system,sans-serif;padding:2rem;background:#0a0a0a;color:#e0e0e0;margin:0;max-width:800px;margin:0 auto;line-height:1.7;}
h1,h2,h3,h4,h5,h6{color:#f0f0f0;margin:1.5em 0 0.5em;}
h1{font-size:2em;border-bottom:1px solid #333;padding-bottom:0.3em;}
h2{font-size:1.5em;border-bottom:1px solid #333;padding-bottom:0.2em;}
a{color:#58a6ff;}
pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:1rem;overflow-x:auto;}
code{background:#161b22;padding:0.2em 0.4em;border-radius:3px;font-size:0.9em;font-family:'Courier New',monospace;}
pre code{background:none;padding:0;}
blockquote{border-left:4px solid #3b82f6;margin:1rem 0;padding:0.5rem 1rem;color:#999;background:#111;}
ul{padding-left:1.5rem;}
li{margin:0.3em 0;}
hr{border:none;border-top:1px solid #333;margin:2rem 0;}
img{border-radius:6px;margin:1rem 0;max-width:100%;}
p{margin:0.8em 0;}
table{border-collapse:collapse;width:100%;margin:1rem 0;}
th,td{border:1px solid #333;padding:0.5rem 0.75rem;text-align:left;}
th{background:#161b22;color:#f0f0f0;}
</style></head><body>${s}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

// (original inline script moved to sia-injected.js)
// Inject the interceptor script into HTML before loading into the iframe.
async function createHtmlBlobUrl(htmlString) {
  await siaInjectedReady; // ensure sia-injected.js has been fetched
  let injected;
  const bodyClose = htmlString.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    injected = htmlString.slice(0, bodyClose) + SIA_INJECTED_SCRIPT + htmlString.slice(bodyClose);
  } else {
    injected = htmlString + SIA_INJECTED_SCRIPT;
  }
  const blob = new Blob([injected], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

// Listen for messages from the sandboxed iframe.
window.addEventListener('message', (event) => {
  const d = event.data;
  if (!d) return;

  // Only accept messages from our own iframes (source must match a known tab)
  const sourceTab = event.source ? findTabByIframeWindow(event.source) : null;
  if (!sourceTab) return; // reject messages from unknown sources

  // 1. Link navigation — navigate within the source tab
  if (d.type === 'SIA_NAVIGATE' && typeof d.url === 'string') {
    _dbg('🔗 Sia link clicked in iframe:', d.url);
    if (sourceTab) {
      sourceTab.url = d.url;
      sourceTab.label = d.url.length > 30 ? d.url.substring(0, 30) + '...' : d.url;
      if (sourceTab.id === activeTabId) {
        document.getElementById('chrome-address-bar').value = d.url;
        setLastBrowserUrl(d.url);
      }
      renderTabBar();
    }
    // Set address bar and load (loadContentWithAutoDetect reads from address bar)
    document.getElementById('chrome-address-bar').value = d.url;
    loadContentWithAutoDetect();
    return;
  }

  // 2. Embedded resource request — route to source tab's iframe
  if (d.type === 'SIA_RESOURCE' && typeof d.url === 'string' && d.requestId) {
    handleSiaResourceRequest(d.url, d.requestId, sourceTab);
    return;
  }

  // 3. Video streaming request — route to source tab's iframe
  if (d.type === 'SIA_STREAM_REQUEST' && typeof d.url === 'string' && d.sessionId) {
    _dbg('[iframe-stream] Stream request:', d.url);
    handleSiaStreamRequest(d.url, d.sessionId, sourceTab);
  }

  // 4. Video seek request from iframe
  if (d.type === 'SIA_STREAM_SEEK' && typeof d.timeSec === 'number' && d.sessionId) {
    // Find the tab that owns this stream
    const streamTab = sourceTab || tabs.find(t => t.iframeStreamAbort && t.iframeStreamAbort.sessionId === d.sessionId);
    if (streamTab && streamTab.iframeStreamAbort && streamTab.iframeStreamAbort.sessionId === d.sessionId && streamTab.iframeStreamAbort.seek) {
      _dbg('[iframe-stream] Seek request:', d.timeSec.toFixed(2) + 's');
      streamTab.iframeStreamAbort.seek(d.timeSec);
    }
  }
});

// Parse a `sia-site://` URL into the resolvable form the SDK expects
// (either a bare hex object ID or a full `sia://…` share URL) plus
// the 64-char hex object ID for display. Accepts both:
//   • sia-site://<hex>
//   • sia-site://<host>/objects/<hex>/shared?…#encryption_key=…
// Returns null for anything that doesn't match.
function parseSiaSiteUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('sia-site://')) return null;
  const rest = url.slice('sia-site://'.length).replace(/\/+$/, '');
  if (/^[0-9a-fA-F]{64}$/.test(rest)) {
    return { resolvable: rest, objectId: rest };
  }
  // Share-URL form. Convert back to `sia://<rest>` so resolveObject's
  // existing sharedObject() path handles it.
  const shareUrl = 'sia://' + rest;
  const m = rest.match(/objects\/([0-9a-fA-F]{64})(?:\/|$)/);
  return { resolvable: shareUrl, objectId: m ? m[1] : null };
}

// Save a Blob to disk, always asking the user for a filename first.
// On Chrome/Edge this is `showSaveFilePicker` (full save-as dialog with
// location + name). On Firefox/Safari we fall back to an inline
// `prompt()` because those browsers quietly save to ~/Downloads
// otherwise. Returns the final filename if saved, null if cancelled.
async function saveBlobAsDownload(blob, suggestedName, mime, ext) {
  if (window.showSaveFilePicker) {
    try {
      const opts = { suggestedName };
      if (mime && ext) {
        opts.types = [{ description: mime, accept: { [mime]: ['.' + ext] } }];
      }
      const handle = await window.showSaveFilePicker(opts);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name || suggestedName;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      // fall through to the prompt fallback
    }
  }
  const chosenName = window.prompt('Save file as:', suggestedName);
  if (chosenName === null) return null;
  const name = chosenName.trim() || suggestedName;
  const a = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  a.href = objectUrl;
  a.download = name;
  a.click();
  URL.revokeObjectURL(objectUrl);
  return name;
}

// Queue for sia:// resource requests — serialized to avoid re-entering the WASM tokio runtime.
const _siaResourceQueue = [];
let _siaResourceProcessing = false;

function handleSiaResourceRequest(url, requestId, sourceTab) {
  _siaResourceQueue.push({ url, requestId, sourceTab });
  if (!_siaResourceProcessing) {
    _processSiaResourceQueue();
  }
}

async function _processSiaResourceQueue() {
  _siaResourceProcessing = true;
  while (_siaResourceQueue.length > 0) {
    const { url, requestId, sourceTab } = _siaResourceQueue.shift();
    // Use the source tab's iframe, or fall back to active tab's iframe
    const iframe = (sourceTab && sourceTab.iframeEl) || getActiveTabIframe();
    if (!iframe || !iframe.contentWindow) continue;

    try {
      const dummyStatus = document.createElement('span');
      const dummyProgress = document.createElement('progress');
      const result = await parallelDownload(url, dummyStatus, dummyProgress, 'Resource');
      const blob = result.blob;

      const detected = await fileTypeFromBlob(blob);
      const mimeType = detected ? detected.mime : 'application/octet-stream';
      const arrayBuffer = await blob.arrayBuffer();

      iframe.contentWindow.postMessage({
        type: 'SIA_RESOURCE_RESPONSE',
        requestId,
        data: arrayBuffer,
        mimeType,
      }, '*', [arrayBuffer]);
    } catch (e) {
      console.error('[parent] Failed to download sia:// resource:', url, e);
      iframe.contentWindow.postMessage({
        type: 'SIA_RESOURCE_RESPONSE',
        requestId,
        error: e.message,
      }, '*');
    }
  }
  _siaResourceProcessing = false;
}

// --- Iframe video streaming: parent-side relay ---
// Downloads video via worker, demuxes with mp4box on the main thread,
// relays codec config + video samples + audio segments to iframe via postMessage.
async function handleSiaStreamRequest(url, sessionId, sourceTab) {
  const tab = sourceTab || getActiveTab();
  const iframe = tab && tab.iframeEl;
  if (!iframe || !iframe.contentWindow) return;

  // Abort any existing stream on this tab
  if (tab.iframeStreamAbort) {
    tab.iframeStreamAbort.abort();
    tab.iframeStreamAbort = null;
  }

  const mp4box = createMP4Box();
  let byteOffset = 0;
  let aborted = false;
  // audioMode is set inside onReady, used by onSamples
  let _audioMode = null;

  function post(msg, transfers) {
    if (aborted || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(msg, '*', transfers || []);
  }

  mp4box.onReady = (info) => {
    const mediaTracks = info.tracks.filter(t => t.video || t.audio);
    if (mediaTracks.length === 0) {
      post({ type: 'SIA_STREAM_ERROR', sessionId, error: 'No media tracks found' });
      return;
    }

    const duration = (info.duration && info.timescale) ? info.duration / info.timescale : 0;

    // Video track + codec description
    let videoTrackId = null;
    let videoConfig = null;
    for (const track of mediaTracks) {
      if (!track.video || videoTrackId !== null) continue;
      videoTrackId = track.id;
      try {
        const trak = mp4box.getTrackById(track.id);
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const descBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        let descBuf = null;
        if (descBox) {
          const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
          descBox.write(s);
          descBuf = s.buffer.slice(8);
        }
        videoConfig = {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          description: descBuf,
        };
      } catch (e) {
        console.error('[iframe-stream] video config extraction failed:', e);
      }
    }

    // Audio track — pass 1: fMP4 MSE, pass 2: raw MSE
    let audioTrackId = null;
    let audioConfig = null;
    const rawMimeMap = { 'mp4a.6b': 'audio/mpeg', 'mp4a.69': 'audio/mpeg' };

    for (const track of mediaTracks) {
      if (!track.audio) continue;
      const mime = `video/mp4; codecs="${track.codec}"`;
      if (window.MediaSource && MediaSource.isTypeSupported(mime)) {
        audioTrackId = track.id;
        _audioMode = 'fmp4-mse';
        mp4box.setSegmentOptions(audioTrackId, 'audio', { nbSamples: 100, rapAlignment: true });
        break;
      }
    }
    if (!audioTrackId) {
      for (const track of mediaTracks) {
        if (!track.audio) continue;
        const rawMime = rawMimeMap[track.codec];
        if (rawMime && window.MediaSource && MediaSource.isTypeSupported(rawMime)) {
          audioTrackId = track.id;
          _audioMode = 'raw-mse';
          break;
        }
      }
    }

    // Set extraction options SYNCHRONOUSLY before mp4box.start()
    if (videoTrackId !== null) {
      mp4box.setExtractionOptions(videoTrackId, 'video', { nbSamples: 200 });
    }
    if (audioTrackId !== null && _audioMode === 'raw-mse') {
      mp4box.setExtractionOptions(audioTrackId, 'audio', { nbSamples: 200 });
    }

    // Init segment for fMP4 audio
    let audioInitBuf = null;
    let audioMime = null;
    if (audioTrackId !== null && _audioMode === 'fmp4-mse') {
      const initResult = mp4box.initializeSegmentation();
      audioInitBuf = initResult.buffer || null;
      const t = mediaTracks.find(x => x.id === audioTrackId);
      audioMime = `video/mp4; codecs="${t.codec}"`;
    } else if (audioTrackId !== null && _audioMode === 'raw-mse') {
      const t = mediaTracks.find(x => x.id === audioTrackId);
      audioMime = rawMimeMap[t.codec];
    }
    if (audioTrackId !== null) {
      audioConfig = { mode: _audioMode, mime: audioMime, initSegment: audioInitBuf };
    }

    mp4box.start();

    const transfers = [];
    if (videoConfig && videoConfig.description) transfers.push(videoConfig.description);
    if (audioConfig && audioConfig.initSegment) transfers.push(audioConfig.initSegment);
    post({ type: 'SIA_STREAM_INIT', sessionId, videoConfig, audioConfig, duration }, transfers);
  };

  mp4box.onSamples = (trackId, user, samples) => {
    if (aborted) return;
    if (user === 'audio' && _audioMode === 'raw-mse') {
      for (const sample of samples) {
        if (aborted) break;
        const buf = sample.data.buffer.slice(sample.data.byteOffset, sample.data.byteOffset + sample.data.byteLength);
        post({ type: 'SIA_STREAM_AUDIO', sessionId, buffer: buf }, [buf]);
      }
      return;
    }
    if (user !== 'video') return;
    const batch = [];
    const transfers = [];
    for (const sample of samples) {
      if (aborted) break;
      const buf = sample.data.buffer.slice(sample.data.byteOffset, sample.data.byteOffset + sample.data.byteLength);
      batch.push({ data: buf, cts: sample.cts, duration: sample.duration, timescale: sample.timescale, is_sync: sample.is_sync });
      transfers.push(buf);
    }
    if (batch.length > 0) {
      post({ type: 'SIA_STREAM_VIDEO', sessionId, samples: batch }, transfers);
    }
  };

  mp4box.onSegment = (trackId, user, buffer) => {
    if (aborted || user !== 'audio') return;
    post({ type: 'SIA_STREAM_AUDIO', sessionId, buffer: buffer }, [buffer]);
  };

  mp4box.onError = (e) => console.error('[iframe-stream] mp4box error:', e);

  // Download via worker (separate WASM instance — no tokio re-entrancy)
  const worker = new Worker('./worker.js', { type: 'module' });
  const streamPromise = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'chunk') {
        if (aborted) return;
        const _t0 = performance.now();
        const buf = msg.data;
        buf.fileStart = msg.offset;
        byteOffset += msg.size;
        mp4box.appendBuffer(buf);
        const _dt = performance.now() - _t0;
        if (_dt > 10) _dbgWarn(`[iframe-perf] appendBuffer: ${_dt.toFixed(1)}ms (${msg.size} bytes, offset=${msg.offset})`);
      } else if (msg.type === 'progress') {
        if (aborted) return;
        post({ type: 'SIA_STREAM_PROGRESS', sessionId, current: msg.current, total: msg.total });
      } else if (msg.type === 'complete') {
        resolve();
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => reject(new Error(`Worker error: ${e.message}`));
  });

  worker.postMessage({
    type: 'start',
    indexerUrl: getUrl(),
    keyHex: getKeyHex(),
    maxDownloads: getMaxDownloads(),
    objectUrl: url,
    logLevel: getLogLevel(),
  });

  tab.iframeStreamAbort = {
    sessionId,
    seek: (timeSec) => {
      if (aborted) return;
      mp4box.stop();
      mp4box.seek(timeSec, true);
      // Clear stale sample accumulators left over from pre-stop extraction.
      // Without this, start() mixes old samples into the first post-seek batch.
      // Must be AFTER seek() so trak.nextSample is set to the seek position.
      if (mp4box.extractedTracks) {
        for (const t of mp4box.extractedTracks) t.samples = [];
      }
      if (mp4box.fragmentedTracks) {
        for (const t of mp4box.fragmentedTracks) {
          const ns = t.trak.nextSample;
          t.segmentStream = undefined;
          if (t.state) {
            t.state.lastFragmentSampleNumber = ns;
            t.state.lastSegmentSampleNumber = ns;
            t.state.accumulatedSize = 0;
          }
        }
      }
      post({ type: 'SIA_STREAM_SEEK_FLUSH', sessionId, timeSec });
      mp4box.start();
    },
    abort: () => {
      if (aborted) return;
      aborted = true;
      worker.terminate();
      try { mp4box.flush(); } catch (e) { }
    }
  };

  try {
    await streamPromise;
    if (!aborted) {
      const _flushT0 = performance.now();
      mp4box.flush();
      _dbgWarn(`[iframe-perf] mp4box.flush() on main thread: ${(performance.now() - _flushT0).toFixed(1)}ms`);
      post({ type: 'SIA_STREAM_END', sessionId });
    }
  } catch (e) {
    if (!aborted) {
      post({ type: 'SIA_STREAM_ERROR', sessionId, error: e.message });
    }
    aborted = true;
    worker.terminate();
  }

  if (tab.iframeStreamAbort && tab.iframeStreamAbort.sessionId === sessionId) {
    tab.iframeStreamAbort = null;
  }
}

const HISTORY_STORAGE_KEY = 'sia-browser-history';
const browserHistory = [];
let currentHistoryIndex = -1;

// Load history from localStorage on page load
function loadHistoryFromStorage() {
  try {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Restore history items (blob URLs will be null after refresh)
      browserHistory.push(...parsed);
      _dbg(`📚 Restored ${browserHistory.length} history items from localStorage`);
      updateBrowserUI();
    }
  } catch (e) {
    console.error('Failed to load history from storage:', e);
  }
}

// Save history to localStorage
function saveHistoryToStorage() {
  try {
    // Save history without blob URLs (they're temporary)
    const toSave = browserHistory.map(item => ({
      displayUrl: item.displayUrl,
      title: item.title,
      external: item.external,
      originalUrl: item.originalUrl,
      fileType: item.fileType,
      blobUrl: null  // Don't save blob URLs - they won't work after refresh
    }));
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.error('Failed to save history to storage:', e);
  }
}

// Load history when page loads
loadHistoryFromStorage();

function updateBrowserUI() {
  const addressBar = document.getElementById('chrome-address-bar');
  const historyList = document.getElementById('history-list');

  // Only update address bar when viewing the browser panel
  if (activePanel === 'browser') {
    if (currentHistoryIndex >= 0 && browserHistory[currentHistoryIndex]) {
      const current = browserHistory[currentHistoryIndex];
      const url = current.originalUrl || current.displayUrl;
      addressBar.value = url;
      setLastBrowserUrl(url);
      addressBar.title = current.displayUrl;
    } else {
      addressBar.value = '';
      addressBar.placeholder = 'Paste Sia share URL or object ID...';
    }
  } else if (currentHistoryIndex >= 0 && browserHistory[currentHistoryIndex]) {
    // Still track the last browser URL even if not viewing it
    setLastBrowserUrl(browserHistory[currentHistoryIndex].originalUrl || browserHistory[currentHistoryIndex].displayUrl);
  }

  // Update history list
  historyList.innerHTML = '';
  browserHistory.forEach((item, index) => {
    const historyItem = document.createElement('div');
    let classes = 'history-item';
    if (index === currentHistoryIndex) classes += ' active';
    if (item.blobUrl) classes += ' downloaded';
    historyItem.className = classes;

    // Only show warning for external HTML tabs, not for PDFs (which are safe)
    const isPdf = item.displayUrl && item.displayUrl.startsWith('PDF:');
    const showWarning = item.external && !isPdf;

    const itemText = (showWarning ? '⚠️ ' : '') + (item.title || item.displayUrl);
    historyItem.innerHTML = `
      <span class="history-title">${itemText}</span>
      ${item.blobUrl ? '<button class="history-download" style="opacity: 0; transition: opacity 0.2s; background: none; border: none; color: #10b981; cursor: pointer; padding: 0 0.5rem; font-size: 1rem; line-height: 1;" title="Download">⬇</button>' : ''}
      <button class="history-delete" style="opacity: 0; transition: opacity 0.2s; background: none; border: none; color: #ef4444; cursor: pointer; padding: 0 0.5rem; font-size: 1.2rem; line-height: 1;" title="Delete">×</button>
    `;
    historyItem.title = (showWarning ? '[External Tab] ' : '') + item.displayUrl;

    // Show buttons on hover
    historyItem.addEventListener('mouseenter', () => {
      const deleteBtn = historyItem.querySelector('.history-delete');
      const downloadBtn = historyItem.querySelector('.history-download');
      if (deleteBtn) deleteBtn.style.opacity = '1';
      if (downloadBtn) downloadBtn.style.opacity = '1';
    });
    historyItem.addEventListener('mouseleave', () => {
      const deleteBtn = historyItem.querySelector('.history-delete');
      const downloadBtn = historyItem.querySelector('.history-download');
      if (deleteBtn) deleteBtn.style.opacity = '0';
      if (downloadBtn) downloadBtn.style.opacity = '0';
    });

    // Navigate on title click
    historyItem.querySelector('.history-title').addEventListener('click', () => navigateToHistory(index));

    // Download on ⬇ click
    const downloadBtn = historyItem.querySelector('.history-download');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadHistoryItem(index);
      });
    }

    // Delete on X click
    historyItem.querySelector('.history-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(index);
    });

    historyList.appendChild(historyItem);
  });
}

function deleteHistoryItem(index) {
  if (index < 0 || index >= browserHistory.length) return;

  // Revoke the blob URL to free memory
  const item = browserHistory[index];
  if (item.blobUrl && item.blobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(item.blobUrl);
  }

  // Remove the item
  browserHistory.splice(index, 1);

  // Update current index
  if (currentHistoryIndex === index) {
    // Deleted the current item - move to previous or clear
    currentHistoryIndex = Math.max(0, index - 1);
    if (browserHistory.length === 0) {
      currentHistoryIndex = -1;
      // Clear the active browser tab's iframe
      const iframe = getActiveTabIframe();
      const videoContainer = document.getElementById('video-container');
      const video = document.getElementById('mse-video');
      if (iframe) { iframe.src = ''; iframe.style.display = 'block'; }
      videoContainer.style.display = 'none';
      setBrowserView(false);
      video.src = '';
    }
  } else if (currentHistoryIndex > index) {
    // Deleted an item before the current - adjust index
    currentHistoryIndex--;
  }

  updateBrowserUI();
  saveHistoryToStorage();
}

function downloadHistoryItem(index) {
  if (index < 0 || index >= browserHistory.length) return;

  const item = browserHistory[index];
  if (!item.blobUrl) {
    alert('This item has not been downloaded yet. Click on it to load it first.');
    return;
  }

  // Generate a filename from the display URL or object ID
  let filename = 'download';
  try {
    // Try to extract a meaningful filename
    const url = item.originalUrl || item.displayUrl;
    if (url.includes('/')) {
      // Get the last part of the URL
      const parts = url.split('/');
      filename = parts[parts.length - 1];
    } else if (url.length === 64) {
      // Looks like an object ID - use shortened version
      filename = `object_${url.substring(0, 8)}`;
    } else {
      filename = 'download';
    }

    // Add extension based on file type if we can guess it
    if (item.fileType && !filename.includes('.')) {
      const extensions = {
        'image': '.jpg',
        'video': '.mp4',
        'audio': '.mp3',
        'pdf': '.pdf',
        'html': '.html',
        'text': '.txt'
      };
      if (extensions[item.fileType]) {
        filename += extensions[item.fileType];
      }
    }
  } catch (e) {
    console.error('Error generating filename:', e);
  }

  // Trigger download
  const a = document.createElement('a');
  a.href = item.blobUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  _dbg(`📥 Downloaded history item: ${filename}`);
}

async function navigateToHistory(index) {
  if (index < 0 || index >= browserHistory.length) return;
  currentHistoryIndex = index;
  const item = browserHistory[index];

  // Get or create a browser tab for this history item
  const tab = getOrCreateActiveBrowserTab();

  // Stop any active stream on this tab
  if (tab.streamAbort) { tab.streamAbort.abort(); tab.streamAbort = null; }
  if (tab.iframeStreamAbort) { tab.iframeStreamAbort.abort(); tab.iframeStreamAbort = null; }
  if (streamingTabId === tab.id) setStreamingTabId(null);
  tab.isStreaming = false;

  // If blob URL is null (e.g., after page refresh or streaming video), re-download the file
  if (!item.blobUrl) {
    _dbg('🔄 Blob URL missing, re-downloading:', item.originalUrl);
    await redownloadHistoryItem(item, index);
    return;
  }

  // If this is an external tab item, reopen it in external tab
  if (item.external) {
    window.open(item.blobUrl, '_blank');
  } else {
    // Show tab's iframe, hide video
    const iframe = tab.iframeEl;
    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('mse-video');

    if (iframe) iframe.style.display = 'block';
    videoContainer.style.display = 'none';
    setBrowserView(false);
    video.src = '';

    // Load in the tab's iframe
    if (iframe) iframe.src = item.blobUrl;
    tab.contentLoaded = true;
  }

  tab.url = item.originalUrl || item.displayUrl;
  tab.label = item.title || item.displayUrl;
  setLastBrowserUrl(tab.url);
  renderTabBar();
  pushTabNav(tab, { url: tab.url, blobUrl: item.blobUrl || null, label: tab.label, fileType: item.fileType || 'html' });
  updateBrowserUI();
}

// Re-download a history item (when blob URL is missing after refresh)
async function redownloadHistoryItem(item, index) {
  const tab = getOrCreateActiveBrowserTab();
  const { status, progress } = tabStatusProxy(tab);
  const iframe = tab.iframeEl;
  const videoContainer = document.getElementById('video-container');
  const canvas = document.getElementById('stream-canvas');
  const video = document.getElementById('mse-video');

  progress.style.display = 'none';
  progress.value = 0;

  // Stop any active stream on this tab
  if (tab.streamAbort) { tab.streamAbort.abort(); tab.streamAbort = null; }
  if (tab.iframeStreamAbort) { tab.iframeStreamAbort.abort(); tab.iframeStreamAbort = null; }
  if (streamingTabId === tab.id) setStreamingTabId(null);
  tab.isStreaming = false;

  try {
    const sdk = await connectSdk(status);
    if (!sdk) return;

    // For video items, re-stream via WebCodecs (or MSE fallback)
    if (item.fileType === 'video') {
      status.textContent = 'Re-streaming video...';
      const resolved = await resolveObject(item.originalUrl, sdk);
      sdk = resolved.sdk;
      const obj = resolved.obj;

      iframe.style.display = 'none';
      videoContainer.style.display = 'block';
      setBrowserView(true);

      // Mark streaming active immediately so closeTab knows to abort
      tab.isStreaming = true;
      setStreamingTabId(tab.id);
      updateBrowserUI();

      // Try WebCodecs first
      if (typeof VideoDecoder !== 'undefined') {
        try {
          canvas.style.display = 'block';
          video.style.display = 'none';
          const replayOverride = resolved.fallback ? { indexerUrl: resolved.indexerUrl, keyHex: resolved.keyHex } : null;
          const resultPromise = webcodecStream(sdk, obj, canvas, status, progress, item.originalUrl, replayOverride);
          // The abort handle isn't available until the function returns,
          // but we can set up a fallback abort via the video element
          tab.streamAbort = {
            abort: () => {
              canvas.width = 0;
              resultPromise.then(r => r && r.abort && r.abort()).catch(() => {});
            }
          };
          const result = await resultPromise;
          tab.streamAbort = result;
          status.innerHTML = `<span class="pass">${status.textContent}</span>`;
          return;
        } catch (e) {
          console.error('[browser] WebCodecs re-stream failed:', e);
        }
      }

      // Fall back to MSE
      try {
        canvas.style.display = 'none';
        video.style.display = 'block';
        const resultPromise = transmuxAndStream(sdk, obj, video, status, progress);
        tab.streamAbort = {
          abort: () => {
            video.src = '';
            video.load();
            resultPromise.then(r => r && r.abort && r.abort()).catch(() => {});
          }
        };
        const result = await resultPromise;
        tab.streamAbort = result;
        status.innerHTML = `<span class="pass">${status.textContent}</span>`;
        return;
      } catch (e) {
        console.error('[browser] MSE re-stream failed:', e);
        videoContainer.style.display = 'none';
        iframe.style.display = 'block';
        setBrowserView(false);
        status.textContent = 'Streaming failed, re-downloading...';
      }
    }

    status.textContent = `Re-downloading ${item.fileType}...`;

    const { blob: downloadedBlob } = await parallelDownload(item.originalUrl, status, progress, 'Downloading');
    const data = new Uint8Array(await downloadedBlob.arrayBuffer());

    // Create blob with appropriate MIME type and wrapper
    let mimeType = 'text/html';
    if (item.fileType === 'pdf') mimeType = 'application/pdf';
    else if (item.fileType === 'image') mimeType = 'image/jpeg';
    else if (item.fileType === 'video') mimeType = 'video/mp4';
    else if (item.fileType === 'audio') mimeType = 'audio/mpeg';
    else if (item.fileType === 'text') mimeType = 'text/plain';

    // Create blob with appropriate wrapper for better display
    let blobUrl;
    if (item.fileType === 'text') {
      // Render text as markdown
      const text = new TextDecoder().decode(data);
      blobUrl = renderMarkdownHtml(text);
    } else if (item.fileType === 'audio') {
      // Wrap audio in HTML with styled player
      const audioBlob = new Blob([data], { type: mimeType });
      const audioUrl = URL.createObjectURL(audioBlob);
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;}audio{width:90%;max-width:600px;}</style></head><body><h2 style="margin-bottom:2rem;">🎵 Audio Player</h2><audio controls autoplay><source src="${audioUrl}" type="${_esc(mimeType)}">Your browser does not support the audio element.</audio></body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      blobUrl = URL.createObjectURL(blob);
    } else if (item.fileType === 'html') {
      // HTML: rewrite sia:// links for in-page navigation
      const htmlText = new TextDecoder().decode(data);
      blobUrl = await createHtmlBlobUrl(htmlText);
    } else if (item.fileType === 'image') {
      const imgBlob = new Blob([data], { type: mimeType });
      let html;
      try {
        const bitmap = await createImageBitmap(imgBlob);
        const cvs = document.createElement('canvas');
        cvs.width = bitmap.width;
        cvs.height = bitmap.height;
        cvs.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngDataUrl = cvs.toDataURL('image/png');
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${pngDataUrl}" alt="Image"></body></html>`;
      } catch {
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;text-align:center;}.msg{max-width:500px;}h2{margin-bottom:1rem;}p{color:#888;line-height:1.6;}</style></head><body><div class="msg"><h2>Unsupported Image Format</h2><p>${_esc(mimeType)} is not supported by this browser.</p><p>Try opening this file in Safari, or convert it to JPEG/PNG first.</p></div></body></html>`;
      }
      const blob = new Blob([html], { type: 'text/html' });
      blobUrl = URL.createObjectURL(blob);
    } else {
      // For other types, load directly
      const blob = new Blob([data], { type: mimeType });
      blobUrl = URL.createObjectURL(blob);
    }

    // Update history item with new blob URL
    browserHistory[index].blobUrl = blobUrl;

    // Load the file
    if (item.external || item.fileType === 'pdf') {
      window.open(blobUrl, '_blank');
      status.innerHTML = '<span class="pass">✓ Reopened in new tab!</span>';
    } else {
      iframe.src = blobUrl;
      status.innerHTML = '<span class="pass">✓ Loaded!</span>';
    }
    tab.contentLoaded = true;

    if (!isNavInProgress()) pushTabNav(tab, { url: item.originalUrl || item.displayUrl, blobUrl, label: item.title || item.displayUrl, fileType: item.fileType || 'html' });
    updateBrowserUI();
  } catch (e) {
    status.innerHTML = `<span class="fail">Error re-downloading: ${_esc(e.message)}</span>`;
  }
}

function addToHistory(displayUrl, blobUrl, title = null, external = false, originalUrl = '', fileType = 'html') {
  _dbg('🔍 addToHistory called:', {
    displayUrl,
    external,
    originalUrl,
    fileType,
    currentHistoryIndex,
    historyLength: browserHistory.length
  });

  // Check if this URL already exists in history (by original URL, not blob URL)
  const existingIndex = browserHistory.findIndex(item =>
    item.originalUrl === originalUrl && item.fileType === fileType
  );

  if (existingIndex !== -1) {
    // URL already exists - update it with the new blob URL
    _dbg(`📍 URL already exists at index ${existingIndex}, updating blob URL`);
    browserHistory[existingIndex].blobUrl = blobUrl;
    browserHistory[existingIndex].title = title || displayUrl;
    currentHistoryIndex = existingIndex;
    updateBrowserUI();
    saveHistoryToStorage();
    return;
  }

  // New URL - always append to the end (tab bar behavior)
  browserHistory.push({
    displayUrl,
    blobUrl,
    title: title || displayUrl,
    external,
    originalUrl,
    fileType
  });
  currentHistoryIndex = browserHistory.length - 1;

  _dbg('✅ History updated:', {
    newHistoryLength: browserHistory.length,
    newCurrentIndex: currentHistoryIndex,
    allTitles: browserHistory.map(h => h.title || h.displayUrl)
  });

  updateBrowserUI();
  saveHistoryToStorage();
}



// Auto-detect file type using MIME sniffing
async function loadContentWithAutoDetect() {
  if (loadContentInProgress) {
    _dbg('[browser] loadContentWithAutoDetect already in progress, ignoring');
    return;
  }
  setLoadContentInProgress(true);

  const addressBar = document.getElementById('chrome-address-bar');
  const url = addressBar.value.trim();

  if (!url) {
    setLoadContentInProgress(false);
    return;
  }

  // Ensure we have an active browser tab
  const tab = getOrCreateActiveBrowserTab();
  tab.url = url;
  setLastBrowserUrl(url);

  const { status, progress } = tabStatusProxy(tab);
  const iframe = tab.iframeEl;
  const videoContainer = document.getElementById('video-container');
  const canvas = document.getElementById('stream-canvas');
  const video = document.getElementById('mse-video');

  if (!iframe) { setLoadContentInProgress(false); return; }

  // sia-site:// — decentralised multi-file hosting. The URL after the
  // scheme is either:
  //   • a bare 64-hex object ID                      →  sia-site://<hex>
  //   • a share URL path (host/objects/…/shared?…)   →  sia-site://sia.storage/objects/<hex>/shared?…#encryption_key=…
  // The share form is portable across accounts; we convert it back into
  // a full sia:// URL and hand it to resolveObject, which already
  // handles both.
  if (url.startsWith('sia-site://')) {
    try {
      const parsed = parseSiaSiteUrl(url);
      if (!parsed) throw new Error('invalid sia-site URL');
      iframe.style.display = 'block';
      videoContainer.style.display = 'none';
      setBrowserView(false);
      tab.isStreaming = false;
      status.textContent = 'Loading Sia site…';
      loadSiaSiteIntoIframe(iframe, parsed.resolvable);
      const shortId = (parsed.objectId || parsed.resolvable).slice(0, 12);
      tab.label = 'Sia site: ' + shortId + '…';
      tab.contentLoaded = true;
      renderTabBar();
      if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl: null, label: tab.label, fileType: 'sia-site' });
      updateNavButtons();
      status.innerHTML = '<span class="pass">Site loaded</span>';
    } catch (e) {
      status.innerHTML = `<span class="fail">${_esc(e.message || String(e))}</span>`;
    } finally {
      updateNavButtons();
      setLoadContentInProgress(false);
    }
    return;
  }

  // Reset display: show this tab's iframe, hide video
  iframe.style.display = 'block';
  videoContainer.style.display = 'none';
  setBrowserView(false);
  tab.isStreaming = false;
  canvas.style.display = 'block';
  video.style.display = 'none';
  video.src = '';

  // If this tab previously hosted a Sia site, its iframe has a relaxed
  // sandbox (allow-same-origin, required for service-worker registration).
  // Reset to the strict sandbox so blob: URLs we're about to load run in
  // an opaque origin with no access to the main app's localStorage.
  iframe.setAttribute('sandbox', 'allow-scripts');

  progress.style.display = 'none';
  progress.value = 0;

  // Stop any active stream on this tab
  if (tab.streamAbort) {
    tab.streamAbort.abort();
    tab.streamAbort = null;
  }
  if (tab.iframeStreamAbort) {
    tab.iframeStreamAbort.abort();
    tab.iframeStreamAbort = null;
  }
  if (streamingTabId === tab.id) setStreamingTabId(null);

  try {
    let sdk = await connectSdk(status);
    if (!sdk) return;

    status.textContent = 'Fetching object...';
    const resolved = await resolveObject(url, sdk);
    sdk = resolved.sdk;
    const obj = resolved.obj;
    if (resolved.fallback) status.textContent = `Found on fallback indexer: ${resolved.fallback}`;
    const size = obj.size();

    // Large files: route through the Sia-site video viewer. This uses a
    // native <video> element inside an iframe on the sandbox origin,
    // backed by the same SW bridge that powers sia-sites. The browser makes Range
    // requests naturally on seek; the SW forwards offset/length into
    // sdk.download(), so jumping to byte N doesn't require downloading
    // 0..N-1 first. Zero WebCodecs, zero mp4box.js demuxing in the worker.
    const canStream = size > 40000000;
    if (canStream) {
      try {
        const viewerUrl = SIA_HOSTED_ORIGIN + '/_sia-video-viewer.html#' + encodeURIComponent(url);
        iframe.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
        );
        iframe.style.display = 'block';
        videoContainer.style.display = 'none';
        setBrowserView(false);
        tab.isStreaming = false;
        canvas.style.display = 'none';
        video.style.display = 'none';
        // removeAttribute instead of assigning '' — empty string triggers
        // a load of an invalid URI and logs "Invalid URI" in Firefox.
        video.removeAttribute('src');
        video.load();
        iframe.src = viewerUrl;
        tab.label = 'Video: ' + (url.length > 20 ? url.substring(0, 20) + '...' : url);
        tab.contentLoaded = true;
        renderTabBar();
        const displayUrl = `Video (streaming): ${url}`;
        addToHistory(displayUrl, null, displayUrl, false, url, 'video');
        if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl: null, label: tab.label, fileType: 'video' });
        status.innerHTML = '<span class="pass">Loading video…</span>';
        return;
      } catch (viewerErr) {
        console.error('[browser] video viewer setup failed, falling back to legacy pipelines:', viewerErr);
      }
    }

    // Legacy WebCodecs / MSE streaming pipelines. Reached only if the
    // viewer setup above threw (otherwise that block returns). Kept as
    // a fallback for edge cases where the SW bridge can't serve the
    // object — eventually we can delete this whole block once the
    // viewer path proves sturdy enough.
    if (canStream) {
      if (typeof VideoDecoder !== 'undefined') {
        status.textContent = 'Large file detected. Attempting WebCodecs streaming...';
        try {
          iframe.style.display = 'none';
          videoContainer.style.display = 'block';
          setBrowserView(true);
          tab.isStreaming = true;
          setStreamingTabId(tab.id);
          canvas.style.display = 'block';
          video.style.display = 'none';

          const overrideConfig = resolved.fallback ? { indexerUrl: resolved.indexerUrl, keyHex: resolved.keyHex } : null;
          const result = await webcodecStream(sdk, obj, canvas, status, progress, url, overrideConfig);
          const _callerT0 = performance.now();
          tab.streamAbort = result;
          tab.contentLoaded = true;

          tab.label = 'Video: ' + (url.length > 20 ? url.substring(0, 20) + '...' : url);
          renderTabBar();

          const displayUrl = `Video (streaming): ${url}`;
          addToHistory(displayUrl, null, displayUrl, false, url, 'video');
          if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl: null, label: tab.label, fileType: 'video' });
          status.innerHTML = `<span class="pass">${status.textContent}</span>`;
          _dbg(`[perf] caller continuation done in ${(performance.now() - _callerT0).toFixed(1)}ms`);
          return;
        } catch (wcErr) {
          console.error('[browser] WebCodecs streaming failed:', wcErr);
          tab.streamAbort = null;
          tab.isStreaming = false;
          setStreamingTabId(null);
        }
      }

      // Fall back to MSE if WebCodecs failed or unavailable
      if (window.MediaSource) {
        status.textContent = 'Trying MSE streaming...';
        try {
          iframe.style.display = 'none';
          videoContainer.style.display = 'block';
          setBrowserView(true);
          tab.isStreaming = true;
          setStreamingTabId(tab.id);
          canvas.style.display = 'none';
          video.style.display = 'block';

          const result = await transmuxAndStream(sdk, obj, video, status, progress);
          tab.streamAbort = result;
          tab.contentLoaded = true;

          tab.label = 'Video: ' + (url.length > 20 ? url.substring(0, 20) + '...' : url);
          renderTabBar();

          const displayUrl = `Video (streaming): ${url}`;
          addToHistory(displayUrl, null, displayUrl, false, url, 'video');
          if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl: null, label: tab.label, fileType: 'video' });
          status.innerHTML = `<span class="pass">${status.textContent}</span>`;
          return;
        } catch (mseErr) {
          console.error('[browser] MSE streaming failed, falling back to full download:', mseErr);
          tab.streamAbort = null;
          tab.isStreaming = false;
          setStreamingTabId(null);
        }
      }

      // Both streaming methods failed — fall through to full download
      iframe.style.display = 'block';
      videoContainer.style.display = 'none';
      setBrowserView(false);
      tab.isStreaming = false;
      status.textContent = 'Streaming unavailable, downloading full file...';
    }

    // Full download path (non-video files or streaming fallback)
    status.textContent = 'Downloading...';
    const result = await parallelDownload(url, status, progress, 'Downloading');
    const downloadedBlob = result.blob;
    const downloadElapsed = result.elapsed;

    // Detect type from the full file
    status.textContent = 'Detecting file type...';
    const detectedType = await fileTypeFromBlob(downloadedBlob);

    let mimeType = 'application/octet-stream';
    let typeLabel = 'Unknown';
    let fileType = 'unknown';

    if (detectedType) {
      mimeType = detectedType.mime;
      typeLabel = detectedType.ext.toUpperCase();

      // Categorize for history tracking
      if (mimeType.startsWith('image/')) {
        fileType = 'image';
        typeLabel = 'Image';
      } else if (mimeType.startsWith('video/')) {
        fileType = 'video';
        typeLabel = 'Video';
      } else if (mimeType.startsWith('audio/')) {
        fileType = 'audio';
        typeLabel = 'Audio';
      } else if (mimeType === 'application/pdf') {
        fileType = 'pdf';
        typeLabel = 'PDF';
      } else if (mimeType === 'text/html') {
        fileType = 'html';
        typeLabel = 'HTML';
      } else if (mimeType.startsWith('text/')) {
        fileType = 'text';
        typeLabel = 'Text';
      } else if (
        mimeType === 'application/zip' ||
        mimeType === 'application/x-zip-compressed' ||
        mimeType === 'application/x-7z-compressed' ||
        mimeType === 'application/x-rar-compressed' ||
        mimeType === 'application/x-tar' ||
        mimeType === 'application/gzip' ||
        mimeType === 'application/x-bzip2'
      ) {
        fileType = 'archive';
        typeLabel = detectedType.ext.toUpperCase();
      }

      status.textContent = `Detected: ${mimeType} (${detectedType.ext})`;
      _dbg('🔍 Type detected:', { mimeType, typeLabel, fileType, ext: detectedType.ext });
    } else {
      // Fallback: try to detect text by checking if it's valid UTF-8
      try {
        const sample = await downloadedBlob.slice(0, 1024).arrayBuffer();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
        // If we got here, it's valid UTF-8 text
        if (text.includes('<html') || text.includes('<!DOCTYPE')) {
          mimeType = 'text/html';
          typeLabel = 'HTML';
          fileType = 'html';
        } else {
          mimeType = 'text/plain';
          typeLabel = 'Text';
          fileType = 'text';
        }
        status.textContent = `Detected: ${typeLabel} (fallback UTF-8 detection)`;
      } catch {
        // Not text, treat as binary
        status.textContent = 'Could not detect file type, treating as binary';
      }
    }

    // Create blob with appropriate wrapper for better display
    let blobUrl;

    if (fileType === 'video') {
      // Video that was too small to stream or streaming failed — use iframe player
      const videoBlob = new Blob([downloadedBlob], { type: mimeType });
      const videoUrl = URL.createObjectURL(videoBlob);
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;padding:2rem;}video{width:100%;max-width:1200px;background:#000;}</style></head><body><video controls autoplay><source src="${videoUrl}" type="${_esc(mimeType)}">Your browser does not support the video element.</video><p style="margin-top:1rem;color:#888;">File size: ${formatSize(size)} | Type: ${_esc(mimeType)}</p></body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      blobUrl = URL.createObjectURL(blob);

    } else if (fileType === 'text') {
      // Render text as markdown
      const text = new TextDecoder().decode(new Uint8Array(await downloadedBlob.arrayBuffer()));
      blobUrl = renderMarkdownHtml(text);

    } else if (fileType === 'audio') {
      const audioBlob = new Blob([downloadedBlob], { type: mimeType });
      const audioUrl = URL.createObjectURL(audioBlob);
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;}audio{width:90%;max-width:600px;}</style></head><body><h2 style="margin-bottom:2rem;">🎵 Audio Player</h2><audio controls autoplay><source src="${audioUrl}" type="${_esc(mimeType)}">Your browser does not support the audio element.</audio></body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      blobUrl = URL.createObjectURL(blob);

    } else if (fileType === 'pdf') {
      const pdfBlob = new Blob([downloadedBlob], { type: 'application/pdf' });
      blobUrl = URL.createObjectURL(pdfBlob);
      window.open(blobUrl, '_blank');

      const displayUrl = `PDF: ${url}`;
      addToHistory(displayUrl, blobUrl, displayUrl, true, url, 'pdf');
      if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl, label: displayUrl, fileType: 'pdf' });

      status.innerHTML = `Size: ${formatSize(size)}\nDetected: ${_esc(mimeType)}\nLoaded in ${downloadElapsed}s\n<span class="pass">PDF opened in new tab!</span>`;
      return;

    } else if (fileType === 'html') {
      // HTML: rewrite sia:// links so they work as in-page navigations
      const htmlText = new TextDecoder().decode(new Uint8Array(await downloadedBlob.arrayBuffer()));
      blobUrl = await createHtmlBlobUrl(htmlText);
    } else if (fileType === 'image') {
      // Convert image to PNG via canvas so it works inside the sandboxed iframe.
      // Falls back to an error message for formats the browser can't decode (e.g. HEIC on Chrome).
      const imgBlob = new Blob([downloadedBlob], { type: mimeType });
      let html;
      try {
        const bitmap = await createImageBitmap(imgBlob);
        const cvs = document.createElement('canvas');
        cvs.width = bitmap.width;
        cvs.height = bitmap.height;
        cvs.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngDataUrl = cvs.toDataURL('image/png');
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${pngDataUrl}" alt="Image"></body></html>`;
      } catch {
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;text-align:center;}.msg{max-width:500px;}h2{margin-bottom:1rem;}p{color:#888;line-height:1.6;}</style></head><body><div class="msg"><h2>Unsupported Image Format</h2><p>${_esc(mimeType)} is not supported by this browser.</p><p>Try opening this file in Safari, or convert it to JPEG/PNG first.</p></div></body></html>`;
      }
      const blob = new Blob([html], { type: 'text/html' });
      blobUrl = URL.createObjectURL(blob);
    } else if (fileType === 'archive' || !detectedType) {
      // Archives (.zip, .7z, .rar, .tar, .gz, .bz2) and unknown binary
      // formats aren't viewable — prompt the user to save the file to
      // disk instead of silently loading a binary blob into the iframe.
      const ext = detectedType?.ext ? '.' + detectedType.ext : '.bin';
      const fallbackName = (url.match(/[0-9a-fA-F]{16,}/)?.[0] || 'object').slice(0, 16) + ext;
      const savedName = await saveBlobAsDownload(
        new Blob([downloadedBlob], { type: mimeType }),
        fallbackName,
        detectedType?.mime || 'application/octet-stream',
        detectedType?.ext,
      );
      status.innerHTML =
        `Size: ${formatSize(size)}\nDetected: ${_esc(mimeType)}\nLoaded in ${downloadElapsed}s\n` +
        (savedName
          ? `<span class="pass">✓ Saved as ${_esc(savedName)}</span>`
          : `<span style="color:#888;">Save cancelled</span>`);
      const displayUrl = `${typeLabel}: ${url}`;
      addToHistory(displayUrl, null, displayUrl, false, url, fileType);
      if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl: null, label: displayUrl, fileType });
      return;
    } else {
      // Unknown viewable types: load directly in the iframe.
      blobUrl = URL.createObjectURL(new Blob([downloadedBlob], { type: mimeType }));
    }

    iframe.src = blobUrl;
    tab.contentLoaded = true;

    // Update tab metadata
    tab.label = typeLabel + ': ' + (url.length > 20 ? url.substring(0, 20) + '...' : url);
    renderTabBar();
    saveTabState();

    const displayUrl = `${typeLabel}: ${url}`;
    addToHistory(displayUrl, blobUrl, displayUrl, false, url, fileType);
    if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl, label: tab.label, fileType });

    status.innerHTML = `Size: ${formatSize(size)}\nDetected: ${_esc(mimeType)}\nLoaded in ${downloadElapsed}s\n<span class="pass">${typeLabel} loaded!</span>`;
  } catch (e) {
    console.error('loadContent error:', e);
    status.innerHTML = `<span class="fail">Error: ${_esc(e.message || e.toString?.() || String(e))}</span>`;
  } finally {
    updateNavButtons();
    setLoadContentInProgress(false);
  }
}

// Go button - checks pseudo-URLs first, then auto-detects
// handleChromeBarNavigation is defined in app.js and attached to window
document.getElementById('btn-go').addEventListener('click', () => {
  if (window.handleChromeBarNavigation) window.handleChromeBarNavigation();
});

// Back/Forward buttons
document.getElementById('btn-back').addEventListener('click', goBack);

// Open in external tab (with warning)
document.getElementById('btn-external-tab').addEventListener('click', async () => {
  // Show warning first
  const confirmed = confirm('⚠️ WARNING: This will allow the downloaded page to execute JavaScript!\n\nOpening content in an external tab removes all sandbox protections. Only proceed if you trust the content.\n\nUse the Go button (sandboxed iframe) for untrusted content.');

  if (!confirmed) return;

  const tab = getOrCreateActiveBrowserTab();
  const { status, progress } = tabStatusProxy(tab);

  // Check if we have a current history item with blob URL - reuse it!
  if (currentHistoryIndex >= 0 && browserHistory[currentHistoryIndex]) {
    const currentItem = browserHistory[currentHistoryIndex];
    if (currentItem.blobUrl) {
      _dbg('Reusing already-downloaded blob for external tab');
      window.open(currentItem.blobUrl, '_blank');
      status.innerHTML = '<span class="pass">✓ Opened in external tab (reused downloaded file)!</span>';
      return;
    }
  }

  // No current blob URL - need to download from address bar
  const addressBar = document.getElementById('chrome-address-bar');
  const url = addressBar.value.trim();

  if (!url) {
    status.innerHTML = '<span style="color:#f59e0b">⚠️ Enter a URL in the address bar first.</span>';
    return;
  }

  progress.style.display = 'none';
  progress.value = 0;

  try {
    status.textContent = 'Downloading for external tab...';

    const { blob: downloadedBlob } = await parallelDownload(url, status, progress, 'Downloading');

    // Detect MIME type
    status.textContent = 'Detecting file type...';
    const detectedType = await fileTypeFromBlob(downloadedBlob);

    let mimeType = 'application/octet-stream';
    let fileType = 'external';

    if (detectedType) {
      mimeType = detectedType.mime;
      _dbg('External tab - detected MIME type:', mimeType);

      // Categorize for history
      if (mimeType.startsWith('image/')) fileType = 'image';
      else if (mimeType.startsWith('video/')) fileType = 'video';
      else if (mimeType.startsWith('audio/')) fileType = 'audio';
      else if (mimeType === 'application/pdf') fileType = 'pdf';
      else if (mimeType === 'text/html') fileType = 'html';
      else if (mimeType.startsWith('text/')) fileType = 'text';
    } else {
      // Fallback: check if it's valid UTF-8 text
      try {
        const sample = await downloadedBlob.slice(0, 1024).arrayBuffer();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
        if (text.includes('<html') || text.includes('<!DOCTYPE')) {
          mimeType = 'text/html';
          fileType = 'html';
        } else {
          mimeType = 'text/plain';
          fileType = 'text';
        }
      } catch {
        // Binary file, use default
        _dbg('External tab - could not detect type, using default');
      }
    }

    // Open in external tab with detected MIME type
    const blob = new Blob([downloadedBlob], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');

    // Add to history with external flag
    const displayUrl = `External (${fileType}): ${url}`;
    addToHistory(displayUrl, blobUrl, displayUrl, true, url, fileType);

    status.innerHTML = `<span class="pass">✓ Opened in external tab as ${_esc(mimeType)}!</span>`;
  } catch (e) {
    status.innerHTML = `<span class="fail">Error: ${_esc(e.message)}</span>`;
  }
});

// Listen for messages from iframe (e.g., from example.html buttons)
window.addEventListener('message', async (event) => {
  // Only accept messages from our own iframes
  if (event.source && !findTabByIframeWindow(event.source)) return;
  const { type, url, title } = event.data;

  if (type === 'LOAD_IN_VIEWER') {
    // Load the share URL in a browser tab
    const tab = getOrCreateActiveBrowserTab();
    tab.url = url;
    tab.label = title || (url.length > 30 ? url.substring(0, 30) + '...' : url);
    setLastBrowserUrl(url);
    renderTabBar();

    const { status, progress } = tabStatusProxy(tab);
    const iframe = tab.iframeEl;

    progress.style.display = 'none';
    progress.value = 0;

    try {
      status.textContent = `Loading ${title || 'file'}...`;

      const { blob, elapsed, size } = await parallelDownload(url, status, progress, 'Downloading');

      // Rewrite sia:// links in HTML content before loading
      const htmlText = await blob.text();
      const blobUrl = await createHtmlBlobUrl(htmlText);
      if (iframe) iframe.src = blobUrl;
      tab.contentLoaded = true;

      // Add to history
      const displayUrl = title || url;
      addToHistory(displayUrl, blobUrl, title, false, url, 'html');
      if (!isNavInProgress()) pushTabNav(tab, { url, blobUrl, label: displayUrl, fileType: 'html' });

      status.innerHTML = `Size: ${formatSize(size)}\nLoaded in ${elapsed}s\n<span class="pass">${title || 'File'} loaded!</span>`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
    }
  } else if (type === 'LOAD_IN_NEW_TAB') {
    // Download and open in new tab
    const tab = getOrCreateActiveBrowserTab();
    const { status, progress } = tabStatusProxy(tab);

    progress.style.display = 'none';
    progress.value = 0;

    try {
      status.textContent = `Downloading ${title || 'file'}...`;

      const { blob, elapsed, size } = await parallelDownload(url, status, progress, 'Downloading');

      // Open in new tab (let browser detect content type)
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');

      status.innerHTML = `Size: ${formatSize(size)}\nDownloaded in ${elapsed}s\n<span class="pass">${title || 'File'} opened in new tab!</span>`;

      // Clean up blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
    }
  }
});

export { loadContentWithAutoDetect, renderMarkdownHtml, createHtmlBlobUrl, addToHistory };
