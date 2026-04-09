import init, {
  generateRecoveryPhrase,
  AppKey,
  Builder,
  setLogLevel,
} from './pkg/indexd_wasm.js';

// Import registration wizard
import { initRegistrationWizard } from './register.js';

// Import syncer WASM, chain service, and explorer module
import syncerInit, {
  connect_and_discover_ip, sync_chain, scan_balance_filtered,
  generate_filters, generate_txindex, lookup_txid, lookup_utxos,
  listen_for_relays, sync_headers, explore_query,
  scan_wallet_utxos,
  generate_mnemonic, mnemonic_to_entropy, entropy_to_mnemonic,
  encrypt_entropy, decrypt_entropy, derive_addresses,
  derive_manifest_info,
  build_private_manifest_transaction, build_public_manifest_transaction,
  build_channel_manifest_transaction, build_group_manifest_transaction,
  open_private_manifest, open_channel_manifest, open_group_manifest,
  build_v2_transaction, broadcast_v2_transaction,
  compute_utxo_proofs, v2_output_id, attestation_key_hash,
  set_cached_header_ids,
} from './pkg/syncer_wasm.js';
import { init as chainInit, onChange as chainOnChange, getSyncState, getEnabledNetworks, getNetworkConfig, getGenesisHex, getAttestationIndexUrl, getActiveNetwork, setActiveNetwork, getRelayState, getMempool, getMempoolTransactions, clearMempool, loadAttestationEntries, exploreQuery as chainExploreQuery, isReady } from './chain.js';
import { initExplorer, explore as explorerQuery } from './explorer.js';
import { initSyncerConfig } from './syncer-config.js';
import { createNetSelector } from './net-selector.js';

// Extracted modules
import { _dbg, _dbgWarn, _esc, hex, fromHex, randomHex } from './utils.js';
import { initKdfWorker } from './kdf.js';
import {
  getWalletEntropy, walletUpdateUI, walletResetLockTimer, walletLock,
  walletDbLoad, walletScanUtxos, walletEncryptAndSave, walletLoadAndDecrypt,
  walletGenerateSeed, walletExportSeed, walletDeriveAddresses, walletDelete,
  walletSaveResultAsJson,
} from './wallet.js';
import {
  connectSdk, webcodecStream, transmuxAndStream, getUrl, getKeyHex,
} from './config.js';
import { initDownloadUI } from './download-ui.js';
import { initUploadUI } from './upload-ui.js';
import { initBenchmarkUI } from './benchmark-ui.js';
import { initObjectsUI } from './objects-ui.js';
import { initAccountUI } from './account-ui.js';
import { initCorsUI } from './cors-ui.js';
import { loadContentWithAutoDetect } from './browser.js';
import { setLoadContentHandler as setManifestLoadContent } from './manifest.js';
import {
  PANEL_URLS, URL_TO_PANEL, PANEL_TITLES,
  tabs, activeTabId, streamingTabId, loadContentInProgress,
  activePanel, lastBrowserUrl,
  setLoadContentHandler, setLoadContentInProgress, setStreamingTabId, setLastBrowserUrl, setActivePanel,
  initStatusObserver, saveTabState, loadTabState,
  createTab, activateTab, closeTab, renderTabBar,
  getActiveTab, getActiveTabIframe, findTabByIframeWindow,
  openOrActivateInternalTab, getOrCreateActiveBrowserTab,
  updateAddressBarForTab, highlightActiveMenuItem,
  updateConnectionStatus, setBrowserView,
  pushTabNav, updateNavButtons, isNavInProgress, setNavInProgress,
  goBack, navigateTabNavEntry,
} from './tabs.js';

// Debug helpers (accessible from console)
window._dbg = { getMempool, getMempoolTransactions };

// Check browser compatibility on page load
window.addEventListener('DOMContentLoaded', () => {
  // Register download streaming Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw-download.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }

  _dbg('🌐 Browser compatibility check:');
  _dbg('  WebTransport:', typeof WebTransport !== 'undefined' ? '✅ Available' : '❌ Not available');
  _dbg('  Secure context:', window.isSecureContext ? '✅ Yes' : '❌ No (requires HTTPS)');
  _dbg('  Browser:', navigator.userAgent);

  if (typeof WebTransport === 'undefined') {
    const warning = document.createElement('div');
    warning.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:white;padding:1rem;text-align:center;z-index:9999;font-weight:bold;';
    warning.innerHTML = '⚠️ WebTransport not supported in this browser. Downloads will fail.<br>Please use Chrome 97+, Edge 97+, or check Safari Feature Flags (Develop → Feature Flags → WebTransport)';
    document.body.prepend(warning);
  } else if (!window.isSecureContext) {
    const warning = document.createElement('div');
    warning.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:white;padding:1rem;text-align:center;z-index:9999;font-weight:bold;';
    warning.innerHTML = '⚠️ Page must be served over HTTPS for WebTransport to work. Use https://localhost or deploy to HTTPS server.';
    document.body.prepend(warning);
  }
});

// Tab management, nav history, panel URLs → tabs.js
initStatusObserver();
// Wire loadContentWithAutoDetect into tabs.js (async function declarations are hoisted)
setLoadContentHandler(loadContentWithAutoDetect);


// --- Attestation Explorer ---
function initAttestationExplorer() {
  const queryEl = document.getElementById('att-query');
  const btnEl = document.getElementById('att-btn-search');
  const summaryEl = document.getElementById('att-summary');
  const resultsEl = document.getElementById('att-results');
  const bodyEl = document.getElementById('att-results-body');
  if (!queryEl || !btnEl) return;

  async function doSearch() {
    const raw = queryEl.value.trim();
    if (!raw) return;
    btnEl.disabled = true;
    summaryEl.style.display = 'none';
    resultsEl.style.display = 'none';
    bodyEl.innerHTML = '';

    try {
      if (!getAttestationIndexUrl()) {
        summaryEl.textContent = 'No attestation index loaded. Sync a network first.';
        summaryEl.style.display = 'block';
        return;
      }

      const entries = await loadAttestationEntries();
      if (!entries.length) {
        summaryEl.textContent = 'Attestation index is empty.';
        summaryEl.style.display = 'block';
        return;
      }

      let matches;
      let queryType;
      const stripped = raw.startsWith('ed25519:') ? raw.slice(8) : raw;
      if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
        // Pubkey search
        const pk = stripped.toLowerCase();
        matches = entries.filter(e => e.pubkeyHex === pk);
        queryType = 'pubkey';
      } else {
        // Key string search — hash to 8-byte prefix
        const kh = attestation_key_hash(raw).toLowerCase();
        matches = entries.filter(e => e.keyHashHex === kh);
        queryType = 'key';
      }

      if (!matches.length) {
        summaryEl.textContent = queryType === 'pubkey'
          ? 'No attestations found for this public key.'
          : `No attestations found for key "${raw}".`;
        summaryEl.style.display = 'block';
        return;
      }

      // Show most recent first
      matches.sort((a, b) => b.height - a.height);

      // Unique pubkeys for summary
      const uniquePubkeys = new Set(matches.map(m => m.pubkeyHex));
      summaryEl.textContent = `${matches.length} attestation${matches.length > 1 ? 's' : ''} found` +
        (queryType === 'key' ? ` from ${uniquePubkeys.size} public key${uniquePubkeys.size > 1 ? 's' : ''}` : '') +
        '. Fetching details...';
      summaryEl.style.display = 'block';

      // Build rows with placeholders
      const rows = [];
      for (const m of matches) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid #222;';

        const pkFull = 'ed25519:' + m.pubkeyHex;
        const pkShort = 'ed25519:' + m.pubkeyHex.slice(0, 8) + '…' + m.pubkeyHex.slice(-6);
        const keyCol = queryType === 'key' ? raw : m.keyHashHex.slice(0, 12) + '…';
        tr.innerHTML =
          `<td style="padding:6px 8px; font-family:monospace; color:#aaa; cursor:pointer;" title="Click to copy: ${_esc(pkFull)}" class="att-pubkey-cell">${_esc(pkShort)}</td>` +
          `<td style="padding:6px 8px; text-align:right;"><a href="#" style="color:#60a5fa; text-decoration:none;" class="att-height-link">${_esc(m.height.toLocaleString())}</a></td>` +
          `<td class="att-key-cell" style="padding:6px 8px; color:#ccc;">${_esc(keyCol)}</td>` +
          `<td class="att-val-cell" style="padding:6px 8px; color:#666; font-size:0.75rem;">loading…</td>`;

        tr.querySelector('.att-pubkey-cell').addEventListener('click', () => {
          navigator.clipboard.writeText('ed25519:' + m.pubkeyHex).then(() => {
            const cell = tr.querySelector('.att-pubkey-cell');
            const orig = cell.textContent;
            cell.textContent = 'copied!';
            cell.style.color = '#4ade80';
            setTimeout(() => { cell.textContent = orig; cell.style.color = '#aaa'; }, 1200);
          });
        });

        tr.querySelector('.att-height-link').addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('exp-query').value = String(m.height);
          explorerQuery();
        });
        bodyEl.appendChild(tr);
        rows.push({ tr, m });
      }

      resultsEl.style.display = 'block';

      // Fetch blocks to fill in key + value — one fetch per unique height
      const uniqueHeights = [...new Set(matches.map(m => m.height))];
      const blockCache = {};
      let fetched = 0;
      for (const h of uniqueHeights) {
        try {
          const result = await chainExploreQuery(String(h), () => { });
          if (result?.type === 'block' && result.block?.v2?.transactions) {
            // Collect all attestations from this block
            const atts = [];
            for (const txn of result.block.v2.transactions) {
              for (const att of (txn.attestations || [])) {
                atts.push(att);
              }
            }
            blockCache[h] = atts;
          }
        } catch (e) {
          console.warn('Failed to fetch block', h, e);
        }
        fetched++;
        summaryEl.textContent = `${matches.length} attestation${matches.length > 1 ? 's' : ''} found` +
          (queryType === 'key' ? ` from ${uniquePubkeys.size} public key${uniquePubkeys.size > 1 ? 's' : ''}` : '') +
          `. Fetching details... ${fetched}/${uniqueHeights.length}`;
      }

      // Fill in key + value from fetched blocks
      for (const { tr, m } of rows) {
        const atts = blockCache[m.height] || [];
        // Match by pubkey (block data has ed25519: prefix)
        const match = atts.find(a =>
          (a.publicKey || '').replace('ed25519:', '').toLowerCase() === m.pubkeyHex
        );
        const keyCell = tr.querySelector('.att-key-cell');
        const valCell = tr.querySelector('.att-val-cell');
        if (match) {
          keyCell.textContent = match.key || '—';
          let decoded = '';
          try { decoded = atob(match.value || ''); } catch (_) { decoded = match.value || ''; }
          valCell.textContent = decoded || '—';
          valCell.title = decoded;
          valCell.style.color = '#aaa';
        } else {
          valCell.textContent = '—';
        }
      }

      summaryEl.textContent = `${matches.length} attestation${matches.length > 1 ? 's' : ''} found` +
        (queryType === 'key' ? ` from ${uniquePubkeys.size} public key${uniquePubkeys.size > 1 ? 's' : ''}` : '') + '.';
    } catch (e) {
      summaryEl.textContent = 'Error: ' + e;
      summaryEl.style.display = 'block';
      console.error('Attestation search error:', e);
    } finally {
      btnEl.disabled = false;
    }
  }

  btnEl.addEventListener('click', doSearch);
  queryEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

// --- Mempool actions ---
function initMempoolActions() {
  const clearBtn = document.getElementById('exp-mempool-clear');
  const rebroadcastBtn = document.getElementById('exp-mempool-rebroadcast');
  const statusEl = document.getElementById('exp-mempool-status');

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const net = getActiveNetwork();
      clearMempool(net);
      if (statusEl) { statusEl.style.display = 'none'; }
    });
  }

  if (rebroadcastBtn) {
    rebroadcastBtn.addEventListener('click', async () => {
      const net = getActiveNetwork();
      const config = getNetworkConfig(net);
      if (!config.peerUrl) {
        if (statusEl) {
          statusEl.textContent = 'No peer URL configured.';
          statusEl.style.color = '#f87171';
          statusEl.style.display = 'block';
        }
        return;
      }

      const txns = getMempoolTransactions(net);
      const broadcastable = txns.filter(t => t.rawJson);
      if (!broadcastable.length) {
        if (statusEl) {
          statusEl.textContent = 'No transactions with raw data to rebroadcast.';
          statusEl.style.color = '#f87171';
          statusEl.style.display = 'block';
        }
        return;
      }

      rebroadcastBtn.disabled = true;
      rebroadcastBtn.textContent = 'Broadcasting...';
      if (statusEl) {
        statusEl.textContent = `Rebroadcasting ${broadcastable.length} transaction${broadcastable.length > 1 ? 's' : ''}...`;
        statusEl.style.color = '#888';
        statusEl.style.display = 'block';
      }

      const genesisHex = getGenesisHex(net);
      const certHash = config.certHash || undefined;
      let ok = 0, fail = 0;

      // Build a single transaction set: all broadcastable txns in one RPC call
      const txnSet = broadcastable.map(t => JSON.parse(t.rawJson));
      try {
        await broadcast_v2_transaction(config.peerUrl, genesisHex, JSON.stringify(txnSet), certHash);
        ok = broadcastable.length;
      } catch (e) {
        console.warn('Mempool rebroadcast failed:', e);
        fail = broadcastable.length;
      }

      rebroadcastBtn.disabled = false;
      rebroadcastBtn.textContent = 'Rebroadcast';
      if (statusEl) {
        if (fail === 0) {
          statusEl.textContent = `Rebroadcast ${ok} transaction${ok > 1 ? 's' : ''} successfully.`;
          statusEl.style.color = '#4ade80';
        } else {
          statusEl.textContent = `Rebroadcast failed: ${fail} transaction${fail > 1 ? 's' : ''}.`;
          statusEl.style.color = '#f87171';
        }
        statusEl.style.display = 'block';
      }
    });
  }
}

// Gear menu setup (runs after DOM ready)
function initGearMenu() {
  const gearBtn = document.getElementById('gear-btn');
  const gearMenu = document.getElementById('gear-menu');
  if (!gearBtn || !gearMenu) return;

  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gearMenu.style.display = gearMenu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => {
    gearMenu.style.display = 'none';
  });

  gearMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll('.gear-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const panelName = item.dataset.panel;
      if (item.disabled) return;

      if (panelName === 'register') {
        const hasKey = !!localStorage.getItem('app-key');
        const hasUrl = !!localStorage.getItem('indexer-url');
        if (hasKey || hasUrl) {
          if (!confirm('You already have an indexer URL and app key configured. Re-registering will overwrite them. Continue?')) {
            gearMenu.style.display = 'none';
            return;
          }
        }
        // Initialize wizard handlers if not already done
        if (!window._wizardInitialized) {
          initRegistrationWizard({
            Builder, generateRecoveryPhrase, hex, fromHex, randomHex, AppKey,
            closeTab, activateTab, tabs,
          });
          window._wizardInitialized = true;
        }
      }

      openOrActivateInternalTab(panelName);
      gearMenu.style.display = 'none';
    });
  });

  // Address bar: detect internal pseudo-URLs on Enter
  const chromeBar = document.getElementById('chrome-address-bar');
  if (chromeBar) {
    chromeBar.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleChromeBarNavigation();
      }
    });
  }
}

window.handleChromeBarNavigation = function handleChromeBarNavigation() {
  const bar = document.getElementById('chrome-address-bar');
  if (!bar) return;
  const url = bar.value.trim();
  if (!url) return;

  // Check for internal panel pseudo-URLs
  const panelName = URL_TO_PANEL[url];
  if (panelName) {
    openOrActivateInternalTab(panelName);
    return;
  }

  // Detect Sia addresses: 76 hex chars (with checksum) — explorer lookup
  // Note: 64 hex chars are treated as object IDs, not addresses
  if (/^[0-9a-fA-F]{76}$/.test(url)) {
    openOrActivateInternalTab('explorer');
    document.getElementById('exp-query').value = url;
    explorerQuery();
    return;
  }

  // sia:// content — load into the active browser tab, or create one
  const browserTab = getOrCreateActiveBrowserTab();
  browserTab.url = url;
  browserTab.label = url.length > 30 ? url.substring(0, 30) + '...' : url;
  setLastBrowserUrl(url);
  bar.value = url; // restore after activateTab may have cleared it
  renderTabBar();
  loadContentWithAutoDetect();
}

// Streaming download helper — avoids holding the entire file in WASM memory.
// Returns { blob, elapsed } where blob is assembled from streamed chunks.
// Download helpers → download.js
// Upload helpers → upload.js

// Auto-restore config from localStorage on page load
const urlInput = document.getElementById('cfg-url');
const keyInput = document.getElementById('cfg-key');
const maxDownloadsInput = document.getElementById('cfg-max-downloads');
const maxUploadsInput = document.getElementById('cfg-max-uploads');
const debugLoggingCheckbox = document.getElementById('cfg-debug-logging');

// --- Indexer Profile Management ---
const PROFILES_KEY = 'indexer-profiles';
const profileSelect = document.getElementById('cfg-profile-select');

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY)) || null; } catch { return null; }
}

function saveProfiles(data) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(data));
  const active = data.profiles[data.active];
  if (active) {
    localStorage.setItem('indexer-url', active.url || '');
    localStorage.setItem('app-key', active.key || '');
  }
  window.dispatchEvent(new CustomEvent('profile-updated'));
}

function migrateToProfiles() {
  const existing = loadProfiles();
  if (existing && Object.keys(existing.profiles).length > 0) return existing;
  const url = localStorage.getItem('indexer-url') || '';
  const key = localStorage.getItem('app-key') || '';
  const name = url ? new URL(url).hostname : 'default';
  const data = { profiles: { [name]: { url, key } }, active: name };
  saveProfiles(data);
  return data;
}

const objectsProfileSelect = document.getElementById('objects-profile-select');

function renderProfileSelect(data) {
  for (const sel of [profileSelect, objectsProfileSelect]) {
    sel.innerHTML = '';
    for (const name of Object.keys(data.profiles)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === data.active) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

function activateProfile(data, name) {
  data.active = name;
  const profile = data.profiles[name] || { url: '', key: '' };
  urlInput.value = profile.url || '';
  keyInput.value = profile.key || '';
  saveProfiles(data);
  renderProfileSelect(data);
}

function saveActiveProfile(data) {
  if (!data.active) return;
  data.profiles[data.active] = { url: urlInput.value.trim(), key: keyInput.value.trim() };
  saveProfiles(data);
}

let profileData = migrateToProfiles();
renderProfileSelect(profileData);
activateProfile(profileData, profileData.active);

// Load non-profile settings
const savedMaxDownloads = localStorage.getItem('max-downloads');
const savedMaxUploads = localStorage.getItem('max-uploads');
const savedLogLevel = localStorage.getItem('log-level');
if (savedMaxDownloads) maxDownloadsInput.value = savedMaxDownloads;
if (savedMaxUploads) maxUploadsInput.value = savedMaxUploads;
if (savedLogLevel === 'debug') debugLoggingCheckbox.checked = true;

profileSelect.addEventListener('change', () => {
  activateProfile(profileData, profileSelect.value);
});

objectsProfileSelect.addEventListener('change', () => {
  activateProfile(profileData, objectsProfileSelect.value);
});

document.getElementById('cfg-profile-add').addEventListener('click', () => {
  const name = prompt('Profile name (e.g. indexer hostname):');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (profileData.profiles[trimmed]) { alert('Profile already exists.'); return; }
  profileData.profiles[trimmed] = { url: '', key: '' };
  activateProfile(profileData, trimmed);
});

document.getElementById('cfg-profile-delete').addEventListener('click', () => {
  const names = Object.keys(profileData.profiles);
  if (names.length <= 1) { alert('Cannot delete the only profile.'); return; }
  if (!confirm(`Delete profile "${profileData.active}"?`)) return;
  delete profileData.profiles[profileData.active];
  const remaining = Object.keys(profileData.profiles)[0];
  activateProfile(profileData, remaining);
});

// Save URL and key to active profile on input
urlInput.addEventListener('input', () => { saveActiveProfile(profileData); });
keyInput.addEventListener('input', () => { saveActiveProfile(profileData); });

// Listen for profile updates from other modules (e.g. register wizard)
window.addEventListener('profile-updated', () => { saveActiveProfile(profileData); });
document.getElementById('cfg-key-toggle').addEventListener('click', () => {
  const btn = document.getElementById('cfg-key-toggle');
  if (keyInput.type === 'password') { keyInput.type = 'text'; btn.textContent = 'hide'; }
  else { keyInput.type = 'password'; btn.textContent = 'show'; }
});
maxDownloadsInput.addEventListener('input', () => {
  localStorage.setItem('max-downloads', maxDownloadsInput.value);
});
maxUploadsInput.addEventListener('input', () => {
  localStorage.setItem('max-uploads', maxUploadsInput.value);
});
debugLoggingCheckbox.addEventListener('change', () => {
  const level = debugLoggingCheckbox.checked ? 'debug' : 'info';
  localStorage.setItem('log-level', level);
  setLogLevel(level);
});

// Browser compatibility checks
(async () => {
  const container = document.getElementById('compat-checks');
  if (!container) return;

  const check = (label, supported, tooltip) => {
    const labelEl = document.createElement('div');
    labelEl.style.color = '#999';
    labelEl.style.fontSize = '0.85rem';
    labelEl.textContent = label + ': ';
    if (tooltip) {
      const tip = document.createElement('span');
      tip.className = 'info-tip';
      tip.textContent = '\u2139';
      const tipText = document.createElement('span');
      tipText.className = 'info-tip-text';
      tipText.textContent = tooltip;
      tip.appendChild(tipText);
      labelEl.appendChild(tip);
    }
    const statusEl = document.createElement('div');
    statusEl.style.textAlign = 'right';
    statusEl.innerHTML = supported
      ? '<span style="color:#10b981;">&#10003; Supported</span>'
      : '<span style="color:#ef4444;">&#10007; Not available</span>';
    container.appendChild(labelEl);
    container.appendChild(statusEl);
  };

  check('WebTransport', typeof WebTransport !== 'undefined',
    'Required for connecting to Sia hosts. Without this, downloads and uploads will not work.');
  check('File System Access API', !!window.showSaveFilePicker,
    'Streams large files directly to disk without memory limits. Falls back to Service Worker or in-memory download if unavailable.');
  check('WebCodecs', typeof VideoDecoder !== 'undefined',
    'Hardware-accelerated streaming video playback. Falls back to Media Source Extensions if unavailable.');
  check('Media Source Extensions', typeof MediaSource !== 'undefined',
    'Buffered video playback via SourceBuffer. Used as a fallback when WebCodecs is not available.');
})();

// Config helpers, SDK connection → config.js

await init();
_dbg('[JS] WASM module initialized successfully');

// Initialize syncer WASM, chain service, and explorer panel
await syncerInit();
_dbg('[JS] Syncer WASM module initialized');
initKdfWorker();
await chainInit({
  connect_and_discover_ip, sync_chain, scan_balance_filtered,
  generate_filters, generate_txindex, lookup_txid, lookup_utxos,
  listen_for_relays, sync_headers, explore_query, scan_wallet_utxos,
  generate_mnemonic, mnemonic_to_entropy, entropy_to_mnemonic,
  encrypt_entropy, decrypt_entropy, derive_addresses,
  set_cached_header_ids,
});
initExplorer();
initAttestationExplorer();
initMempoolActions();
initSyncerConfig();

// --- Network status bars (embedded in each blockchain panel) ---
const NET_LABELS = { mainnet: 'Mainnet', mainnet_v2: 'V2-only', zen: 'Zen' };
const netBarSelectors = [];

document.querySelectorAll('.net-bar').forEach(bar => {
  bar.innerHTML = `
    <span class="nb-dot">&#9679;</span>
    <span class="nb-name" style="cursor:pointer;" title="Open Syncer">Mainnet</span>
    <span class="nb-state" style="cursor:pointer;" title="Open Syncer">Disabled</span>
    <span class="nb-phase" style="cursor:pointer;" title="Open Syncer"></span>
    <span class="nb-relay" style="cursor:pointer;" title="Open Syncer">Relay: off</span>
    <span class="nb-sep"></span>
    <span style="flex:1;"></span>
    <span class="nb-sel-mount"></span>`;
  // Click status area to open syncer page
  for (const cls of ['.nb-name', '.nb-state', '.nb-phase', '.nb-relay']) {
    bar.querySelector(cls).addEventListener('click', () => openOrActivateInternalTab('syncer-config'));
  }
  const sel = createNetSelector({
    mode: 'single',
    initial: getActiveNetwork(),
    onChange: async (net) => {
      await setActiveNetwork(net);
      updateNetBars();
    },
  });
  bar.querySelector('.nb-sel-mount').appendChild(sel.el);
  netBarSelectors.push(sel);

  // Position fixed tooltips on hover so they escape overflow containers
  bar.addEventListener('mouseenter', (e) => {
    const tip = e.target.closest('.info-tip');
    if (!tip) return;
    const text = tip.querySelector('.info-tip-text');
    if (!text) return;
    const rect = tip.getBoundingClientRect();
    text.style.top = (rect.bottom + 6) + 'px';
    text.style.left = rect.left + 'px';
  }, true);
});

function updateNetBars() {
  const enabled = getEnabledNetworks();
  const enabledSet = new Set(enabled);
  const allNets = ['mainnet', 'mainnet_v2', 'zen'];
  const disabledSet = new Set(allNets.filter(n => !enabledSet.has(n)));

  // If active network is disabled, switch to first enabled one
  let net = getActiveNetwork();
  if (!enabledSet.has(net) && enabled.length > 0) {
    net = enabled[0];
    setActiveNetwork(net);
  }

  for (const sel of netBarSelectors) {
    sel.setDisabled(disabledSet);
    sel.setSelected(net);
  }

  const config = getNetworkConfig(net);
  const syncState = getSyncState(net);
  const relayState = getRelayState(net);

  document.querySelectorAll('.net-bar').forEach(bar => {
    bar.querySelector('.nb-name').textContent = NET_LABELS[net] || net;

    const dotEl = bar.querySelector('.nb-dot');
    const stateEl = bar.querySelector('.nb-state');
    const phaseEl = bar.querySelector('.nb-phase');

    if (syncState.status === 'syncing') {
      const isHeaders = syncState.phase === 'headers';
      const color = isHeaders ? '#f59e0b' : '#60a5fa';
      dotEl.style.color = color;
      stateEl.textContent = 'Syncing';
      stateEl.style.color = color;
      const pct = syncState.currentHeight && syncState.networkHeight
        ? ' ' + Math.round(syncState.currentHeight / syncState.networkHeight * 100) + '%'
        : '';
      phaseEl.textContent = pct;
      phaseEl.style.color = color;
    } else if (syncState.status === 'synced') {
      dotEl.style.color = '#4ade80';
      stateEl.textContent = 'Synced';
      stateEl.style.color = '#4ade80';
      phaseEl.textContent = syncState.lastSync ? 'Last: ' + new Date(syncState.lastSync).toLocaleTimeString() : '';
      phaseEl.style.color = '#888';
    } else if (syncState.status === 'error') {
      dotEl.style.color = '#f87171';
      stateEl.textContent = 'Error';
      stateEl.style.color = '#f87171';
      phaseEl.textContent = '';
    } else {
      dotEl.style.color = '#555';
      stateEl.textContent = config.enabled ? 'Idle' : 'Disabled';
      stateEl.style.color = '#888';
      phaseEl.textContent = '';
    }

    const relayEl = bar.querySelector('.nb-relay');
    if (relayState.connected) {
      relayEl.textContent = 'Relay: connected';
      relayEl.style.color = '#4ade80';
    } else if (relayState.running) {
      relayEl.textContent = 'Relay: connecting';
      relayEl.style.color = '#f59e0b';
    } else {
      relayEl.textContent = 'Relay: off';
      relayEl.style.color = '#666';
    }

  });
}

updateNetBars();
chainOnChange(updateNetBars);

// Toggle chain-dependent pages based on active networks
function updateChainPageAvailability() {
  const enabled = getEnabledNetworks();
  const hasSynced = isReady() || enabled.some(net => {
    const s = getSyncState(net);
    return s.status === 'synced';
  });
  for (const prefix of ['exp', 'wallet', 'manifest']) {
    const overlay = document.getElementById(`${prefix}-disabled-overlay`);
    const content = document.getElementById(`${prefix}-main-content`);
    if (overlay && content) {
      overlay.style.display = hasSynced ? 'none' : '';
      content.style.display = hasSynced ? '' : 'none';
    }
  }
}
updateChainPageAvailability();
chainOnChange(updateChainPageAvailability);

// Sync indicator in chrome bar + status bar height display
const syncHeightEl = document.getElementById('sync-height-indicator');
const syncHeightSep = document.getElementById('sync-height-sep');
const syncHeightDot = document.getElementById('sync-height-dot');
syncHeightEl.addEventListener('click', (e) => {
  const heightEl = e.target.closest('[data-block-height]');
  if (heightEl) {
    const height = heightEl.dataset.blockHeight;
    const net = heightEl.dataset.net;
    if (net) setActiveNetwork(net);
    openOrActivateInternalTab('explorer');
    setTimeout(() => {
      document.getElementById('exp-query').value = height;
      explorerQuery();
    }, 150);
  } else {
    openOrActivateInternalTab('syncer-config');
  }
});

chainOnChange(() => {
  const enabled = getEnabledNetworks();
  if (enabled.length === 0) {
    syncHeightEl.style.display = 'none';
    syncHeightSep.style.display = 'none';
    syncHeightDot.style.display = 'none';
    return;
  }

  // Collect height info from all enabled networks, coloring each individually
  let spans = [];
  let worstStatus = 'synced'; // track worst for the dot: synced < syncing < error

  for (const net of enabled) {
    const s = getSyncState(net);
    const showLabel = enabled.length > 1;
    const label = net === 'mainnet' ? 'M' : net === 'mainnet_v2' ? 'V2' : net === 'zen' ? 'Z' : net.slice(0, 2).toUpperCase();
    const prefix = showLabel ? label + ':' : '';
    let text, color;
    if (s.status === 'syncing') {
      if (s.currentHeight != null && s.networkHeight != null && s.currentHeight < s.networkHeight) {
        text = prefix + s.currentHeight.toLocaleString() + '/' + s.networkHeight.toLocaleString();
      } else if (s.currentHeight != null && s.networkHeight != null) {
        text = prefix + s.networkHeight.toLocaleString();
      } else {
        text = prefix + 'syncing';
      }
      color = '#60a5fa';
      if (worstStatus === 'synced') worstStatus = 'syncing';
    } else if (s.status === 'synced') {
      text = s.networkHeight != null ? prefix + s.networkHeight.toLocaleString() : prefix + 'synced';
      color = '#4ade80';
    } else if (s.status === 'error') {
      text = prefix + 'err';
      color = '#f87171';
      worstStatus = 'error';
    } else {
      text = prefix + 'idle';
      color = '#888';
    }
    const height = s.networkHeight || s.currentHeight;
    if (height != null && (s.status === 'synced' || s.status === 'syncing')) {
      spans.push('<span style="color:' + color + '">' + prefix + '<span data-block-height="' + height + '" data-net="' + net + '" style="cursor:pointer;" title="View block ' + height + ' in Explorer">' + height.toLocaleString() + '</span></span>');
    } else {
      spans.push('<span style="color:' + color + '; cursor:pointer;" title="Open Syncer">' + text + '</span>');
    }
  }

  // Status bar: dot + per-network colored text
  if (spans.length > 0) {
    const dotColor = worstStatus === 'error' ? '#f87171' : worstStatus === 'syncing' ? '#60a5fa' : '#4ade80';
    syncHeightDot.style.display = '';
    syncHeightDot.style.background = dotColor;
    syncHeightEl.style.display = '';
    syncHeightEl.innerHTML = spans.join(' <span style="color:#333">|</span> ');
    syncHeightEl.style.color = '';
    syncHeightSep.style.display = '';
  } else {
    syncHeightEl.style.display = 'none';
    syncHeightSep.style.display = 'none';
    syncHeightDot.style.display = 'none';
  }
});

// Long task detection: logs any task that blocks the main thread > 50ms
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        _dbgWarn(`[LONG-TASK] ${entry.duration.toFixed(1)}ms at ${entry.startTime.toFixed(1)} (name: ${entry.name})`);
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: false });
    _dbg('[JS] Long task observer installed');
  } catch (e) {
    _dbgWarn('[JS] Long task observer not supported:', e.message);
  }
}

// rAF gap detector: logs when any animation frame takes > 50ms gap
let _rafGapLast = performance.now();
function _rafGapCheck() {
  const now = performance.now();
  const gap = now - _rafGapLast;
  if (gap > 50) {
    _dbgWarn(`[RAF-GAP] ${gap.toFixed(1)}ms between frames at ${now.toFixed(1)}`);
  }
  _rafGapLast = now;
  requestAnimationFrame(_rafGapCheck);
}
requestAnimationFrame(_rafGapCheck);
if (debugLoggingCheckbox.checked) setLogLevel('debug');
document.getElementById('loading').style.display = 'none';
document.getElementById('app').style.display = 'flex';

// Initialize gear menu and tab bar
initGearMenu();

// Wire up "+" new tab button
document.getElementById('tab-new').addEventListener('click', () => {
  const tab = createTab({ type: 'browser', label: 'New Tab' });
  activateTab(tab.id);
  const bar = document.getElementById('chrome-address-bar');
  if (bar) { bar.value = ''; bar.focus(); }
});

// Create initial tabs based on whether user has registered
const homepageUrl = 'sia://app.sia.storage/objects/a7653b7c62bf0653f1c0ec025ee2857f1d8eb52cb29498b23693e434de73692a/shared?sv=2376599154&sc=nmS95u9mPXfFkjj8fkVfCw28mgyVgq9IQOUQYBykQNs%3D&ss=Jd7rlRzhEspDkp7Tn0ADdCs3yoyi5tCo5PBdkOQyBjcuyJ6OrifL7OXSnF5Dob2yUCTW6QGVV_2NFCW3d_yRAA%3D%3D#encryption_key=__jJLf9TDtrcZx7XlS1o32YK2n4RqaXa6xANJXjRkd4=';
const isFirstRun = !localStorage.getItem('app-key');

const savedState = loadTabState();
if (savedState && savedState.tabs && savedState.tabs.length > 0) {
  // Restore tabs from previous session
  for (const saved of savedState.tabs) {
    if (saved.type === 'internal') {
      if (saved.panelName === 'register' && !window._wizardInitialized) {
        initRegistrationWizard({
          Builder, generateRecoveryPhrase, hex, fromHex, randomHex, AppKey,
          closeTab, activateTab, tabs,
        });
        window._wizardInitialized = true;
      }
      openOrActivateInternalTab(saved.panelName);
    } else {
      createTab({ type: 'browser', url: saved.url, label: saved.label });
    }
  }
  // Activate the previously active tab
  const idx = savedState.activeIndex >= 0 && savedState.activeIndex < tabs.length
    ? savedState.activeIndex : tabs.length - 1;
  if (tabs[idx]) activateTab(tabs[idx].id);
} else if (isFirstRun) {
  // First run, no saved tabs: show registration wizard + Homepage
  initRegistrationWizard({
    Builder, generateRecoveryPhrase, hex, fromHex, randomHex, AppKey,
    closeTab, activateTab, tabs,
  });
  window._wizardInitialized = true;
  openOrActivateInternalTab('register');
  createTab({ type: 'browser', label: 'Homepage', url: homepageUrl });
} else {
  // Returning user, no saved tabs: go straight to Homepage
  const hpTab = createTab({ type: 'browser', label: 'Homepage', url: homepageUrl });
  activateTab(hpTab.id);
}

// -- Performance Presets --
function setPreset(maxDl, maxUl) {
  document.getElementById('cfg-max-downloads').value = maxDl;
  document.getElementById('cfg-max-uploads').value = maxUl;
  localStorage.setItem('max-downloads', maxDl);
  localStorage.setItem('max-uploads', maxUl);
}

document.getElementById('preset-conservative').addEventListener('click', () => setPreset(4, 4));
document.getElementById('preset-balanced').addEventListener('click', () => setPreset(8, 8));
document.getElementById('preset-fast').addEventListener('click', () => setPreset(16, 16));


// Account dashboard, host balances, prune → account-ui.js
initAccountUI();

// CORS diagnostics → cors-ui.js
initCorsUI();

// Upload UI → upload-ui.js
initUploadUI();

// Download UI → download-ui.js
initDownloadUI();


// Benchmarks (upload + download) → benchmark-ui.js
initBenchmarkUI();

// Objects list, share, view, delete, info → objects-ui.js
initObjectsUI();

// Migration tool temporarily removed — see matt/migration-tool branch

// Browser module → browser.js

// Wallet & Manifest extracted to wallet.js and manifest.js
// Wire late-binding handler for manifest → loadContentWithAutoDetect
setManifestLoadContent(loadContentWithAutoDetect);
