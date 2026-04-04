import init, {
  generateRecoveryPhrase,
  AppKey,
  Builder,
  UploadOptions,
  DownloadOptions,
  setLogLevel,
} from './pkg/indexd_wasm.js';

// Import file-type for MIME detection
import { fileTypeFromBlob } from './vendor/file-type.bundle.js';

// Import mp4box for MP4 demuxing (WebCodecs video streaming)
import { createFile as createMP4Box, DataStream, Endianness } from './vendor/mp4box.bundle.js';

// Import video streaming pipelines
import { webcodecStream as _webcodecStream, transmuxAndStream as _transmuxAndStream } from './video-streaming.js';

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
import { init as chainInit, onChange as chainOnChange, isSyncing, getSyncState, getEnabledNetworks, getNetworkConfig, getGenesisHex, getFilterUrl, getTxindexUrl, getUtxoIndexUrl, getAttestationIndexUrl, getActiveNetwork, setActiveNetwork, getRelayState, getMempool, getMempoolTransactions, onMempoolChange, addToMempool, clearMempool, loadAttestationEntries, exploreQuery as chainExploreQuery, exportNetworkData, importNetworkData, getStorageSizes, isReady } from './chain.js';
import { initExplorer, explore as explorerQuery, exploreTransaction, buildTransactionCard, highlightMempoolTxn } from './explorer.js';
import { initSyncerConfig } from './syncer-config.js';
import { createNetSelector } from './net-selector.js';

// Vendor libraries
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

// Extracted modules
import { _dbg, _dbgWarn, _esc, hex, fromHex, randomHex, formatSize } from './utils.js';
import { initKdfWorker, kdfEncrypt, kdfDecrypt } from './kdf.js';
import {
  getWalletEntropy, walletUpdateUI, walletResetLockTimer, walletLock,
  walletDbLoad, walletScanUtxos, walletEncryptAndSave, walletLoadAndDecrypt,
  walletGenerateSeed, walletExportSeed, walletDeriveAddresses, walletDelete,
  walletSaveResultAsJson,
} from './wallet.js';
import {
  getUrl, getKeyHex, getMaxDownloads, getMaxUploads,
  getDownloadWorkers, getUploadWorkers, getLogLevel,
  connectSdk, webcodecStream, transmuxAndStream,
} from './config.js';
import {
  streamingDownload, createWorkerPool, initWorkerStatus, runSlabDownload,
  parallelDownload, parallelDownloadToDisk, getActiveServiceWorker, parallelDownloadViaSW,
} from './download.js';
import { parallelUpload, parallelEncodeUpload } from './upload.js';
import { initDownloadUI } from './download-ui.js';
import { initUploadUI } from './upload-ui.js';
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

        const pkShort = m.pubkeyHex.slice(0, 8) + '…' + m.pubkeyHex.slice(-6);
        const keyCol = queryType === 'key' ? raw : m.keyHashHex.slice(0, 12) + '…';
        tr.innerHTML =
          `<td style="padding:6px 8px; font-family:monospace; color:#aaa; cursor:pointer;" title="Click to copy: ${_esc(m.pubkeyHex)}" class="att-pubkey-cell">${_esc(pkShort)}</td>` +
          `<td style="padding:6px 8px; text-align:right;"><a href="#" style="color:#60a5fa; text-decoration:none;" class="att-height-link">${_esc(m.height.toLocaleString())}</a></td>` +
          `<td class="att-key-cell" style="padding:6px 8px; color:#ccc;">${_esc(keyCol)}</td>` +
          `<td class="att-val-cell" style="padding:6px 8px; color:#666; font-size:0.75rem;">loading…</td>`;

        tr.querySelector('.att-pubkey-cell').addEventListener('click', () => {
          navigator.clipboard.writeText(m.pubkeyHex).then(() => {
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

function handleChromeBarNavigation() {
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

  // Detect Sia addresses: 76 hex chars (with checksum) or 64 hex chars (raw)
  if (/^[0-9a-fA-F]{76}$/.test(url) || /^[0-9a-fA-F]{64}$/.test(url)) {
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
const downloadWorkersInput = document.getElementById('cfg-download-workers');
const uploadWorkersInput = document.getElementById('cfg-upload-workers');
const debugLoggingCheckbox = document.getElementById('cfg-debug-logging');

const savedUrl = localStorage.getItem('indexer-url');
const savedKey = localStorage.getItem('app-key');
const savedMaxDownloads = localStorage.getItem('max-downloads');
const savedMaxUploads = localStorage.getItem('max-uploads');
const savedDownloadWorkers = localStorage.getItem('download-workers');
const savedUploadWorkers = localStorage.getItem('upload-workers');
const savedLogLevel = localStorage.getItem('log-level');

if (savedUrl) urlInput.value = savedUrl;
if (savedKey) keyInput.value = savedKey;
if (savedMaxDownloads) maxDownloadsInput.value = savedMaxDownloads;
if (savedMaxUploads) maxUploadsInput.value = savedMaxUploads;
if (savedDownloadWorkers) downloadWorkersInput.value = savedDownloadWorkers;
if (savedUploadWorkers) uploadWorkersInput.value = savedUploadWorkers;
if (savedLogLevel === 'debug') {
  debugLoggingCheckbox.checked = true;
}



// Save to localStorage when config changes
urlInput.addEventListener('input', () => {
  localStorage.setItem('indexer-url', urlInput.value.trim());
});
keyInput.addEventListener('input', () => {
  localStorage.setItem('app-key', keyInput.value.trim());
});
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
downloadWorkersInput.addEventListener('input', () => {
  localStorage.setItem('download-workers', downloadWorkersInput.value);
});
uploadWorkersInput.addEventListener('input', () => {
  localStorage.setItem('upload-workers', uploadWorkersInput.value);
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
function setPreset(maxDl, maxUl, dlWorkers, ulWorkers) {
  document.getElementById('cfg-max-downloads').value = maxDl;
  document.getElementById('cfg-max-uploads').value = maxUl;
  document.getElementById('cfg-download-workers').value = dlWorkers;
  document.getElementById('cfg-upload-workers').value = ulWorkers;
  localStorage.setItem('max-downloads', maxDl);
  localStorage.setItem('max-uploads', maxUl);
  localStorage.setItem('download-workers', dlWorkers);
  localStorage.setItem('upload-workers', ulWorkers);
}

document.getElementById('preset-conservative').addEventListener('click', () => setPreset(4, 4, 4, 4));
document.getElementById('preset-balanced').addEventListener('click', () => setPreset(8, 8, 8, 8));
document.getElementById('preset-fast').addEventListener('click', () => setPreset(16, 16, 16, 16));

// -- Account Dashboard --
async function loadAccountDashboard() {
  const status = document.getElementById('account-status');
  const dashboard = document.getElementById('account-dashboard');

  try {
    status.textContent = 'Loading account data...';

    const sdk = await connectSdk(status);
    if (!sdk) {
      return;
    }

    // Fetch account data
    const accountData = await sdk.account();
    _dbg('Account data:', accountData);

    // Fetch object count
    const objectsJson = await sdk.listObjects(null); // Get all objects
    const objects = JSON.parse(objectsJson);
    const objectCount = objects.filter(o => !o.deleted).length;

    // Calculate storage metrics (accountData is a Map)
    const usedBytes = accountData.get('pinnedData');
    const maxBytes = accountData.get('maxPinnedData');
    const freeBytes = maxBytes - usedBytes;
    const usedPercent = maxBytes > 0 ? (usedBytes / maxBytes * 100) : 0;

    // Update storage bar
    document.getElementById('account-storage-bar').style.width = `${usedPercent}%`;
    document.getElementById('account-storage-text').textContent =
      `${formatSize(usedBytes)} / ${formatSize(maxBytes)} (${usedPercent.toFixed(1)}%)`;
    document.getElementById('account-used-label').textContent = `Used: ${formatSize(usedBytes)}`;
    document.getElementById('account-free-label').textContent = `Free: ${formatSize(freeBytes)}`;

    // Change bar color based on usage
    const bar = document.getElementById('account-storage-bar');
    if (usedPercent >= 90) {
      bar.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)'; // Red
    } else if (usedPercent >= 75) {
      bar.style.background = 'linear-gradient(90deg, #f59e0b, #d97706)'; // Orange
    } else {
      bar.style.background = 'linear-gradient(90deg, #10b981, #059669)'; // Green
    }

    // Update quick stats
    document.getElementById('account-objects-count').textContent = objectCount.toLocaleString();
    document.getElementById('account-pinned-data').textContent = formatSize(usedBytes);
    document.getElementById('account-capacity-percent').textContent = `${usedPercent.toFixed(1)}%`;

    // Update account details (app is also a Map)
    const app = accountData.get('app');
    document.getElementById('account-app-name').textContent = app.get('description') || 'Unknown';

    const accountKey = accountData.get('accountKey');
    const shortKey = accountKey.substring(0, 24) + '...';
    const keyEl = document.getElementById('account-key');
    keyEl.textContent = shortKey;
    keyEl.title = accountKey; // Full key in tooltip

    // Format last used time
    const lastUsed = new Date(accountData.get('lastUsed'));
    const now = new Date();
    const diffMs = now - lastUsed;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    let lastUsedText;
    if (diffMins < 1) lastUsedText = 'Just now';
    else if (diffMins < 60) lastUsedText = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    else if (diffHours < 24) lastUsedText = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    else lastUsedText = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    document.getElementById('account-last-used').textContent = lastUsedText;
    document.getElementById('account-max-storage').textContent = formatSize(maxBytes);

    // Clear status
    status.innerHTML = '<span class="pass">✓ Account data loaded</span>';

    // Show warning if storage is almost full
    if (usedPercent >= 80) {
      status.innerHTML = '<span style="color:#f59e0b;">⚠️ Storage is ' + usedPercent.toFixed(1) + '% full. Consider deleting unused objects or pruning slabs.</span>';
    }
  } catch (e) {
    console.error('Failed to load account:', e);
    status.innerHTML = `<span class="fail">Failed to load account: ${_esc(e.message)}</span>`;
  }
}

document.getElementById('btn-refresh-account').addEventListener('click', loadAccountDashboard);

// -- Host Balances --
const SC_HASTINGS = 1000000000000000000000000n; // 10^24

function hastingsToSC(hastingsStr) {
  if (!hastingsStr) return '0';
  const h = BigInt(hastingsStr);
  const whole = h / SC_HASTINGS;
  const frac = h % SC_HASTINGS;
  if (frac === 0n) return whole.toString();
  // Show 4 decimal places
  const fracStr = (frac * 10000n / SC_HASTINGS).toString().padStart(4, '0');
  return `${whole}.${fracStr}`;
}

function bandwidthRemaining(balanceStr, pricePerByteStr) {
  if (!balanceStr || !pricePerByteStr) return null;
  const balance = BigInt(balanceStr);
  const price = BigInt(pricePerByteStr);
  if (price === 0n) return null; // free / unknown
  return Number(balance / price);
}

document.getElementById('btn-check-balances').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-balances');
  const statusEl = document.getElementById('host-balance-status');
  const summaryEl = document.getElementById('host-balance-summary');
  const tableEl = document.getElementById('host-balance-table');
  const tbody = document.getElementById('host-balance-rows');

  btn.disabled = true;
  btn.textContent = 'Checking...';
  statusEl.textContent = 'Connecting...';
  summaryEl.style.display = 'none';
  tableEl.style.display = 'none';
  tbody.innerHTML = '';

  try {
    const sdk = await connectSdk(statusEl);
    if (!sdk) { btn.disabled = false; btn.textContent = 'Check Balances'; return; }

    const hostKeys = Array.from(sdk.knownHosts());
    const total = hostKeys.length;
    let completed = 0, funded = 0, unfunded = 0, errored = 0;
    let totalDownloadBytes = 0;

    // Create placeholder rows for every host
    const rowMap = new Map(); // hostKey -> <tr>
    for (const hk of hostKeys) {
      const shortKey = hk.substring(0, 16) + '...';
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #1a1a1a';
      tr.innerHTML = `
        <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#555;" title="${hk}">${shortKey}</td>
        <td colspan="3" style="padding:0.5rem 0.75rem; color:#555; text-align:right;">querying...</td>`;
      tbody.appendChild(tr);
      rowMap.set(hk, tr);
    }
    tableEl.style.display = 'block';
    summaryEl.style.display = 'block';
    document.getElementById('hosts-funded-count').textContent = '0';
    document.getElementById('hosts-unfunded-count').textContent = '0';
    document.getElementById('hosts-error-count').textContent = '0';
    document.getElementById('hosts-total-download').textContent = '-';
    statusEl.textContent = `Querying 0 / ${total} hosts...`;

    // Update a single row with results and re-sort the table
    function applyResult(h) {
      completed++;
      const tr = rowMap.get(h.hostKey);
      const shortKey = h.hostKey.substring(0, 16) + '...';
      if (h.balanceError) {
        errored++;
        tr.dataset.sort = '2'; // errors last
        tr.dataset.bal = '0';
        tr.innerHTML = `
          <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#888;" title="${h.hostKey}">${shortKey}</td>
          <td colspan="3" style="padding:0.5rem 0.75rem; color:#ef4444; text-align:right;">${h.balanceError}</td>`;
      } else {
        const bal = BigInt(h.balance);
        if (bal === 0n) { unfunded++; tr.dataset.sort = '1'; } else { funded++; tr.dataset.sort = '0'; }
        tr.dataset.bal = h.balance;
        const sc = hastingsToSC(h.balance);
        const dl = bandwidthRemaining(h.balance, h.egressPrice);
        const ul = bandwidthRemaining(h.balance, h.ingressPrice);
        if (dl !== null) totalDownloadBytes += dl;
        const balColor = bal > 0n ? '#e0e0e0' : '#666';
        tr.innerHTML = `
          <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#888;" title="${h.hostKey}">${shortKey}</td>
          <td style="padding:0.5rem 0.75rem; text-align:right; color:${balColor}; font-family:monospace;">${sc} SC</td>
          <td style="padding:0.5rem 0.75rem; text-align:right; color:#38bdf8; font-family:monospace;">${dl !== null ? formatSize(dl) : '-'}</td>
          <td style="padding:0.5rem 0.75rem; text-align:right; color:#a78bfa; font-family:monospace;">${ul !== null ? formatSize(ul) : '-'}</td>`;
      }
      // Update summary
      document.getElementById('hosts-funded-count').textContent = funded;
      document.getElementById('hosts-unfunded-count').textContent = unfunded;
      document.getElementById('hosts-error-count').textContent = errored;
      document.getElementById('hosts-total-download').textContent = totalDownloadBytes > 0 ? formatSize(totalDownloadBytes) : '-';
      statusEl.textContent = `Queried ${completed} / ${total} hosts...`;

      // Re-sort: completed rows on top (funded > unfunded > error by balance desc), pending at bottom
      const rows = Array.from(tbody.children);
      rows.sort((a, b) => {
        const sa = a.dataset.sort ?? '3'; // pending = 3
        const sb = b.dataset.sort ?? '3';
        if (sa !== sb) return sa.localeCompare(sb);
        const ba = BigInt(a.dataset.bal || '0');
        const bb = BigInt(b.dataset.bal || '0');
        return ba > bb ? -1 : ba < bb ? 1 : 0;
      });
      for (const r of rows) tbody.appendChild(r);
    }

    // Query hosts with concurrency limit of 8
    const CONCURRENCY = 8;
    let idx = 0;
    async function next() {
      while (idx < hostKeys.length) {
        const hk = hostKeys[idx++];
        try {
          const h = await sdk.hostAccountInfo(hk);
          applyResult(h);
        } catch (e) {
          applyResult({ hostKey: hk, balanceError: e.message || String(e) });
        }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, hostKeys.length); i++) {
      workers.push(next());
    }
    await Promise.all(workers);

    statusEl.innerHTML = `<span class="pass">Queried ${total} hosts</span>`;
  } catch (e) {
    console.error('Failed to check balances:', e);
    statusEl.innerHTML = `<span class="fail">Failed: ${_esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check Balances';
  }
});

// -- Prune Slabs --
document.getElementById('btn-prune-slabs').addEventListener('click', async () => {
  const button = document.getElementById('btn-prune-slabs');
  const status = document.getElementById('account-status');
  const originalText = button.textContent;

  // Confirmation dialog
  if (!confirm('🧹 Prune Unused Slabs?\n\nThis will remove slabs that are not referenced by any pinned objects.\n\nThis operation cannot be undone. Continue?')) {
    return;
  }

  try {
    // Show loading state
    button.textContent = '⏳ Pruning...';
    button.disabled = true;
    status.textContent = 'Pruning unused slabs...';

    const sdk = await connectSdk(status);
    if (!sdk) {
      button.textContent = originalText;
      button.disabled = false;
      return;
    }

    // Call prune slabs
    await sdk.pruneSlabs();

    // Success!
    status.innerHTML = '<span class="pass">✓ Slabs pruned successfully! Refreshing account data...</span>';

    // Restore button
    button.textContent = originalText;
    button.disabled = false;

    // Refresh account data to show updated storage
    setTimeout(() => {
      loadAccountDashboard();
    }, 1000);
  } catch (e) {
    console.error('Failed to prune slabs:', e);
    status.innerHTML = `<span class="fail">Failed to prune slabs: ${_esc(e.message)}</span>`;
    button.textContent = originalText;
    button.disabled = false;
  }
});

// Auto-load account dashboard when SDK is configured
window.addEventListener('load', async () => {
  // Wait a bit for user to configure SDK
  setTimeout(async () => {
    const url = getUrl();
    const keyHex = getKeyHex();
    if (url && keyHex) {
      await loadAccountDashboard();
    }
  }, 1000);
});

// -- CORS Diagnostics --
document.getElementById('btn-cors-run-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-cors-run-all');
  const resultsDiv = document.getElementById('cors-results');
  const url = getUrl();

  if (!url) {
    resultsDiv.innerHTML = '<span class="fail">Configure indexer URL first</span>';
    return;
  }

  const fakeId = randomHex(32);
  const fakeReqId = randomHex(16);

  // All routes from the Go server, with the method that triggers preflight
  const tests = [
    // CORS-enabled routes (should pass)
    { method: 'POST', path: '/auth/connect', expect: true },
    { method: 'GET', path: `/auth/connect/${fakeReqId}/status`, expect: true },
    { method: 'POST', path: `/auth/connect/${fakeReqId}/register`, expect: true },
    { method: 'GET', path: '/auth/check', expect: true },
    { method: 'GET', path: '/hosts', expect: true },
    { method: 'GET', path: '/objects', expect: true },
    { method: 'GET', path: `/objects/${fakeId}`, expect: true },
    { method: 'GET', path: `/objects/${fakeId}/shared`, expect: true },
    { method: 'POST', path: '/objects', expect: true },
    { method: 'DELETE', path: `/objects/${fakeId}`, expect: true },
    { method: 'GET', path: '/slabs', expect: true },
    { method: 'POST', path: '/slabs', expect: true },
    { method: 'POST', path: '/slabs/prune', expect: true },
    { method: 'GET', path: `/slabs/${fakeId}`, expect: true },
    { method: 'DELETE', path: `/slabs/${fakeId}`, expect: true },
    // CORS-disabled routes (should fail)
    { method: 'GET', path: `/auth/connect/${fakeReqId}`, expect: false, note: 'CORS intentionally disabled (UI route)' },
    { method: 'POST', path: `/auth/connect/${fakeReqId}`, expect: false, note: 'CORS intentionally disabled (UI route)' },
  ];

  btn.disabled = true;
  btn.textContent = 'Testing...';
  resultsDiv.innerHTML = '';

  let passed = 0, failed = 0, expectedFails = 0;

  for (const t of tests) {
    const label = `${t.method} ${t.path.replace(fakeId, ':id').replace(fakeReqId, ':reqID')}`;
    const row = document.createElement('div');
    row.style.cssText = 'padding:0.4rem 0.6rem; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center;';
    row.innerHTML = `<span style="font-family:monospace;">${label}</span><span style="color:#888;">testing...</span>`;
    resultsDiv.appendChild(row);

    // Send the actual method with a custom header to force the browser to
    // automatically send an OPTIONS preflight. If preflight fails, fetch throws.
    try {
      const resp = await fetch(`${url}${t.path}`, {
        method: t.method,
        headers: {
          'X-CORS-Test': '1', // non-simple header forces preflight
        },
      });
      // If we got here, preflight succeeded
      if (t.expect) {
        row.lastChild.innerHTML = `<span class="pass">PASS (${resp.status})</span>`;
        passed++;
      } else {
        row.lastChild.innerHTML = `<span style="color:#f59e0b;">UNEXPECTED PASS (${resp.status})</span>`;
        passed++;
      }
    } catch (e) {
      if (!t.expect) {
        row.lastChild.innerHTML = `<span style="color:#888;">BLOCKED (expected) — ${t.note}</span>`;
        expectedFails++;
      } else {
        row.lastChild.innerHTML = '<span class="fail">FAIL — preflight rejected</span>';
        failed++;
      }
    }
  }

  const summary = document.createElement('div');
  summary.style.cssText = 'padding:0.75rem; margin-top:0.5rem; background:#0a0a0a; border-radius:4px; border:1px solid #222;';
  const color = failed === 0 ? '#10b981' : '#ef4444';
  summary.innerHTML = `<span style="color:${color}; font-weight:600;">${passed} passed, ${failed} failed, ${expectedFails} intentionally blocked</span>`;
  resultsDiv.appendChild(summary);

  btn.disabled = false;
  btn.textContent = 'Run All CORS Tests';
});


// Upload UI → upload-ui.js
initUploadUI();

// Download UI → download-ui.js
initDownloadUI();

// -- Benchmark --
(() => {
  let benchStopped = false;
  const statusEl = () => document.getElementById('bench-status');
  const progressEl = () => document.getElementById('bench-progress');
  const resultsEl = () => document.getElementById('bench-results');
  const tbodyEl = () => document.getElementById('bench-tbody');

  function generateDummyData(sizeMB) {
    const size = sizeMB * 1024 * 1024;
    const data = new Uint8Array(size);
    // Fill with pseudo-random data (compressible data would skew results)
    for (let i = 0; i < size; i += 4) {
      const v = (i * 2654435761) >>> 0; // simple hash
      data[i] = v & 0xff;
      if (i + 1 < size) data[i + 1] = (v >> 8) & 0xff;
      if (i + 2 < size) data[i + 2] = (v >> 16) & 0xff;
      if (i + 3 < size) data[i + 3] = (v >> 24) & 0xff;
    }
    return new File([data], `bench_${sizeMB}mb.dat`, { type: 'application/octet-stream' });
  }

  function benchResultToRow(r) {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid #1a1a1a;';
    tr.innerHTML = `
      <td style="padding:0.5rem 0.75rem;">${r.sizeMB} MB</td>
      <td style="padding:0.5rem 0.5rem;">${r.method}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.inflight}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.workers || '\u2014'}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.elapsed.toFixed(1)}s</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${(r.speed / 1e6).toFixed(2)} MB/s</td>
      <td style="padding:0.5rem 0.75rem; text-align:right;">${(r.wireSpeed / 1e6).toFixed(2)} MB/s</td>
    `;
    return tr;
  }

  function saveBenchResults(results) {
    localStorage.setItem('bench-results', JSON.stringify(results));
  }

  function loadBenchResults() {
    try {
      return JSON.parse(localStorage.getItem('bench-results') || '[]');
    } catch { return []; }
  }

  function renderBenchResults(results) {
    tbodyEl().innerHTML = '';
    resultsEl().style.display = results.length ? '' : 'none';
    for (const r of [...results].reverse()) tbodyEl().appendChild(benchResultToRow(r));
  }

  function addResult(sizeMB, method, inflight, workers, elapsed, fileSizeBytes) {
    const speed = fileSizeBytes / elapsed;
    const SECTOR_SIZE = 4 * 1024 * 1024;
    const dataShards = 10;
    const totalShards = 30;
    const slabCount = Math.ceil(fileSizeBytes / (dataShards * SECTOR_SIZE));
    const wireBytes = slabCount * totalShards * SECTOR_SIZE;
    const wireSpeed = wireBytes / elapsed;
    const r = { sizeMB, method, inflight, workers, elapsed, speed, wireSpeed, timestamp: Date.now() };
    const results = loadBenchResults();
    results.push(r);
    saveBenchResults(results);
    tbodyEl().prepend(benchResultToRow(r));
    resultsEl().style.display = '';
  }

  // Restore saved results on page load
  { const saved = loadBenchResults(); if (saved.length) renderBenchResults(saved); }

  document.getElementById('btn-bench-run').addEventListener('click', async () => {
    benchStopped = false;
    document.getElementById('btn-bench-run').disabled = true;
    document.getElementById('btn-bench-stop').style.display = '';

    const sizes = [];
    if (document.getElementById('bench-size-10').checked) sizes.push(10);
    if (document.getElementById('bench-size-50').checked) sizes.push(50);
    if (document.getElementById('bench-size-100').checked) sizes.push(100);
    if (document.getElementById('bench-size-500').checked) sizes.push(500);

    const methods = [];
    if (document.getElementById('bench-method-single').checked) methods.push('single');
    if (document.getElementById('bench-method-workers').checked) methods.push('workers');
    if (document.getElementById('bench-method-encode').checked) methods.push('encode');

    const inflights = [];
    if (document.getElementById('bench-inflight-4').checked) inflights.push(4);
    if (document.getElementById('bench-inflight-8').checked) inflights.push(8);
    if (document.getElementById('bench-inflight-16').checked) inflights.push(16);
    if (document.getElementById('bench-inflight-24').checked) inflights.push(24);

    const workerCounts = [];
    if (document.getElementById('bench-workers-4').checked) workerCounts.push(4);
    if (document.getElementById('bench-workers-8').checked) workerCounts.push(8);
    if (document.getElementById('bench-workers-16').checked) workerCounts.push(16);
    if (document.getElementById('bench-workers-24').checked) workerCounts.push(24);

    if (sizes.length === 0 || methods.length === 0 || inflights.length === 0) {
      statusEl().textContent = 'Select at least one size, method, and inflight setting.';
      document.getElementById('btn-bench-run').disabled = false;
      document.getElementById('btn-bench-stop').style.display = 'none';
      return;
    }

    // Build test matrix
    const tests = [];
    for (const size of sizes) {
      for (const method of methods) {
        for (const inflight of inflights) {
          if (method === 'single') {
            // Single-threaded doesn't use workers
            tests.push({ size, method, inflight, workers: null });
          } else {
            // Web workers and encode workers vary worker count
            const wCounts = workerCounts.length > 0 ? workerCounts : [8];
            for (const workers of wCounts) {
              tests.push({ size, method, inflight, workers });
            }
          }
        }
      }
    }

    resultsEl().style.display = '';
    progressEl().style.display = 'block';
    progressEl().max = tests.length;
    progressEl().value = 0;

    for (let i = 0; i < tests.length; i++) {
      if (benchStopped) break;
      const { size, method, inflight, workers } = tests[i];
      const methodLabel = method === 'single' ? 'Single-threaded' : method === 'workers' ? 'Web Workers' : 'Encode Workers';
      const workerLabel = workers ? ` \u2022 workers=${workers}` : '';
      statusEl().textContent = `[${i + 1}/${tests.length}] ${size} MB \u2022 ${methodLabel} \u2022 inflight=${inflight}${workerLabel}`;
      statusEl().style.color = '#60a5fa';

      try {
        // Generate dummy file
        const file = generateDummyData(size);
        const dummyStatus = document.createElement('div');
        const dummyProgress = document.createElement('div');
        dummyProgress.style = { display: 'none' };

        // Override max uploads for this test
        const origMaxUploads = document.getElementById('cfg-max-uploads').value;
        const origUploadWorkers = document.getElementById('cfg-upload-workers').value;
        document.getElementById('cfg-max-uploads').value = inflight;

        const start = performance.now();
        let result;

        if (method === 'single') {
          // Single-threaded upload via main thread SDK
          const sdk = await connectSdk(statusEl());
          if (!sdk) continue;
          const ulOpts = new UploadOptions();
          ulOpts.maxInflight = inflight;
          const upload = sdk.streamingUpload(file.size, ulOpts, () => { });
          const CHUNK_SIZE = 128 * 1024 * 1024;
          const data = new Uint8Array(await file.arrayBuffer());
          (async () => {
            for (let off = 0; off < data.length; off += CHUNK_SIZE) {
              upload.pushChunk(data.subarray(off, off + CHUNK_SIZE));
            }
            upload.pushChunk(null);
          })();
          const obj = await upload.promise;
          result = { obj, size: file.size };
        } else if (method === 'workers') {
          document.getElementById('cfg-upload-workers').value = workers;
          result = await parallelUpload(file, dummyStatus, dummyProgress);
        } else if (method === 'encode') {
          document.getElementById('cfg-upload-workers').value = workers;
          result = await parallelEncodeUpload(file, dummyStatus, dummyProgress);
        }

        const elapsed = (performance.now() - start) / 1000;

        // Restore settings
        document.getElementById('cfg-max-uploads').value = origMaxUploads;
        document.getElementById('cfg-upload-workers').value = origUploadWorkers;

        if (result) {
          addResult(size, methodLabel, inflight, workers, elapsed, file.size);
        }
      } catch (e) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid #1a1a1a; color:#f87171;';
        tr.innerHTML = `
          <td style="padding:0.5rem 0.75rem;">${size} MB</td>
          <td style="padding:0.5rem 0.5rem;">${method}</td>
          <td style="padding:0.5rem 0.5rem; text-align:right;">${inflight}</td>
          <td colspan="3" style="padding:0.5rem 0.5rem;">Error: ${e.message || e}</td>
        `;
        tbodyEl().appendChild(tr);
      }

      progressEl().value = i + 1;
    }

    statusEl().textContent = benchStopped ? 'Benchmark stopped.' : 'Benchmark complete.';
    statusEl().style.color = benchStopped ? '#f59e0b' : '#4ade80';
    progressEl().style.display = 'none';
    document.getElementById('btn-bench-run').disabled = false;
    document.getElementById('btn-bench-stop').style.display = 'none';
  });

  document.getElementById('btn-bench-stop').addEventListener('click', () => {
    benchStopped = true;
    statusEl().textContent = 'Stopping after current test...';
    statusEl().style.color = '#f59e0b';
  });

  document.getElementById('btn-bench-clear').addEventListener('click', () => {
    localStorage.removeItem('bench-results');
    tbodyEl().innerHTML = '';
    resultsEl().style.display = 'none';
    statusEl().textContent = 'Results cleared.';
    statusEl().style.color = '#888';
  });
})();

// -- Download Benchmark --
(() => {
  const statusEl = () => document.getElementById('dl-bench-status');
  const tbodyEl = () => document.getElementById('dl-bench-tbody');
  const resultsEl = () => document.getElementById('dl-bench-results');
  const progressEl = () => document.getElementById('dl-bench-progress');
  let dlBenchStopped = false;

  function dlBenchResultToRow(r) {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid #1a1a1a;';
    tr.innerHTML = `
      <td style="padding:0.5rem 0.5rem;">${r.method}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.inflight}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.workers || '\u2014'}</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${(r.sizeBytes / 1e6).toFixed(1)} MB</td>
      <td style="padding:0.5rem 0.5rem; text-align:right;">${r.elapsed.toFixed(1)}s</td>
      <td style="padding:0.5rem 0.75rem; text-align:right;">${(r.speed / 1e6).toFixed(2)} MB/s</td>
    `;
    return tr;
  }

  function saveDlBenchResults(results) {
    localStorage.setItem('dl-bench-results', JSON.stringify(results));
  }

  function loadDlBenchResults() {
    try { return JSON.parse(localStorage.getItem('dl-bench-results') || '[]'); }
    catch { return []; }
  }

  function renderDlBenchResults(results) {
    tbodyEl().innerHTML = '';
    resultsEl().style.display = results.length ? '' : 'none';
    for (const r of [...results].reverse()) tbodyEl().appendChild(dlBenchResultToRow(r));
  }

  function addDlResult(method, inflight, workers, sizeBytes, elapsed) {
    const speed = sizeBytes / elapsed;
    const r = { method, inflight, workers, sizeBytes, elapsed, speed, timestamp: Date.now() };
    const results = loadDlBenchResults();
    results.push(r);
    saveDlBenchResults(results);
    tbodyEl().prepend(dlBenchResultToRow(r));
    resultsEl().style.display = '';
  }

  // Restore saved results on load
  { const saved = loadDlBenchResults(); if (saved.length) renderDlBenchResults(saved); }

  document.getElementById('btn-dl-bench-run').addEventListener('click', async () => {
    dlBenchStopped = false;
    document.getElementById('btn-dl-bench-run').disabled = true;
    document.getElementById('btn-dl-bench-stop').style.display = '';

    const urlInput = document.getElementById('dl-bench-url').value.trim();
    if (!urlInput) {
      statusEl().textContent = 'Enter an object ID or share URL.';
      statusEl().style.color = '#f87171';
      document.getElementById('btn-dl-bench-run').disabled = false;
      document.getElementById('btn-dl-bench-stop').style.display = 'none';
      return;
    }

    const methods = [];
    if (document.getElementById('dl-bench-method-workers').checked) methods.push('workers');
    if (document.getElementById('dl-bench-method-single').checked) methods.push('single');

    const inflights = [];
    if (document.getElementById('dl-bench-inflight-4').checked) inflights.push(4);
    if (document.getElementById('dl-bench-inflight-8').checked) inflights.push(8);
    if (document.getElementById('dl-bench-inflight-16').checked) inflights.push(16);
    if (document.getElementById('dl-bench-inflight-24').checked) inflights.push(24);

    const workerCounts = [];
    if (document.getElementById('dl-bench-workers-4').checked) workerCounts.push(4);
    if (document.getElementById('dl-bench-workers-8').checked) workerCounts.push(8);
    if (document.getElementById('dl-bench-workers-16').checked) workerCounts.push(16);
    if (document.getElementById('dl-bench-workers-24').checked) workerCounts.push(24);

    if (methods.length === 0 || inflights.length === 0) {
      statusEl().textContent = 'Select at least one method and inflight setting.';
      statusEl().style.color = '#f87171';
      document.getElementById('btn-dl-bench-run').disabled = false;
      document.getElementById('btn-dl-bench-stop').style.display = 'none';
      return;
    }

    // Determine if input is a share URL or object ID
    const isShareUrl = urlInput.startsWith('sia://') || urlInput.startsWith('https://');

    // Build test matrix
    const tests = [];
    for (const method of methods) {
      for (const inflight of inflights) {
        if (method === 'single') {
          tests.push({ method, inflight, workers: null });
        } else {
          const wCounts = workerCounts.length > 0 ? workerCounts : [8];
          for (const workers of wCounts) {
            tests.push({ method, inflight, workers });
          }
        }
      }
    }

    progressEl().style.display = 'block';
    progressEl().max = tests.length;
    progressEl().value = 0;

    for (let i = 0; i < tests.length; i++) {
      if (dlBenchStopped) break;
      const { method, inflight, workers } = tests[i];
      const methodLabel = method === 'workers' ? 'Web Workers' : 'Single Worker';
      const workerLabel = workers ? ` \u2022 workers=${workers}` : '';
      statusEl().textContent = `[${i + 1}/${tests.length}] ${methodLabel} \u2022 inflight=${inflight}${workerLabel}`;
      statusEl().style.color = '#60a5fa';

      try {
        const origMaxDownloads = document.getElementById('cfg-max-downloads').value;
        const origDownloadWorkers = document.getElementById('cfg-download-workers').value;
        document.getElementById('cfg-max-downloads').value = inflight;

        const start = performance.now();
        let totalBytes = 0;

        if (method === 'single') {
          // Single worker download via dedicated worker
          document.getElementById('cfg-max-downloads').value = inflight;
          const url = getUrl();
          const keyHex = getKeyHex();
          if (!url || !keyHex) { statusEl().textContent = 'Set Indexer URL and App Key first'; continue; }

          totalBytes = await new Promise((resolve, reject) => {
            const worker = new Worker('./single-download-worker.js', { type: 'module' });
            let bytes = 0;
            const readyP = new Promise((res, rej) => {
              const h = (e) => {
                if (e.data.type === 'ready') { worker.removeEventListener('message', h); res(); }
                if (e.data.type === 'error') { worker.removeEventListener('message', h); rej(new Error(e.data.message)); }
              };
              worker.addEventListener('message', h);
            });
            worker.postMessage({ type: 'init', indexerUrl: url, keyHex, maxDownloads: inflight, logLevel: getLogLevel() });
            readyP.then(() => {
              worker.postMessage({ type: 'download', input: urlInput, maxDownloads: inflight });
              worker.onmessage = (e) => {
                if (e.data.type === 'chunk') bytes += e.data.length;
                if (e.data.type === 'done') { worker.terminate(); resolve(bytes); }
                if (e.data.type === 'error') { worker.terminate(); reject(new Error(e.data.message)); }
              };
            }).catch(reject);
          });
        } else if (method === 'workers') {
          document.getElementById('cfg-download-workers').value = workers;
          const dummyStatus = { set textContent(_) { }, set innerHTML(_) { } };
          const dummyProgress = document.createElement('progress');
          dummyProgress.style.display = 'none';
          const result = await parallelDownload(urlInput, dummyStatus, dummyProgress, null, workers);
          if (result && result.blob) totalBytes = result.blob.size;
          else if (result && result.size) totalBytes = result.size;
        }

        const elapsed = (performance.now() - start) / 1000;

        document.getElementById('cfg-max-downloads').value = origMaxDownloads;
        document.getElementById('cfg-download-workers').value = origDownloadWorkers;

        addDlResult(methodLabel, inflight, workers, totalBytes, elapsed);
      } catch (e) {
        console.error('Download benchmark error:', e);
        addDlResult(methodLabel + ' (ERROR)', inflight, workers, 0, 0);
      }

      progressEl().value = i + 1;
    }

    statusEl().textContent = dlBenchStopped ? 'Benchmark stopped.' : 'Download benchmark complete.';
    statusEl().style.color = dlBenchStopped ? '#f59e0b' : '#4ade80';
    progressEl().style.display = 'none';
    document.getElementById('btn-dl-bench-run').disabled = false;
    document.getElementById('btn-dl-bench-stop').style.display = 'none';
  });

  document.getElementById('btn-dl-bench-stop').addEventListener('click', () => {
    dlBenchStopped = true;
    statusEl().textContent = 'Stopping after current test...';
    statusEl().style.color = '#f59e0b';
  });

  document.getElementById('btn-dl-bench-clear').addEventListener('click', () => {
    localStorage.removeItem('dl-bench-results');
    tbodyEl().innerHTML = '';
    resultsEl().style.display = 'none';
    statusEl().textContent = 'Results cleared.';
    statusEl().style.color = '#888';
  });
})();

// -- List Objects --
document.getElementById('btn-list-objects').addEventListener('click', async () => {
  const status = document.getElementById('list-status');
  const objectsList = document.getElementById('objects-list');
  const limit = parseInt(document.getElementById('list-limit', 10).value, 10) || 50;

  status.textContent = 'Loading...';
  objectsList.innerHTML = '';

  try {
    const sdk = await connectSdk(status);
    if (!sdk) return;

    status.textContent = 'Fetching objects...';
    const objectsJson = await sdk.listObjects(limit);
    const objects = JSON.parse(objectsJson);

    if (objects.length === 0) {
      objectsList.innerHTML = '<div style="padding:1rem; color:#888; text-align:center;">No objects found. Upload something first!</div>';
      status.innerHTML = '<span style="color:#888;">No objects found</span>';
      return;
    }

    // Display objects in a table
    let html = `
      <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <thead>
          <tr style="border-bottom:2px solid #333; text-align:left;">
            <th style="padding:0.5rem;">Object ID</th>
            <th style="padding:0.5rem;">Size</th>
            <th style="padding:0.5rem;">Updated</th>
            <th style="padding:0.5rem;">Status</th>
            <th style="padding:0.5rem;">Actions</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const obj of objects) {
      const shortId = obj.id.substring(0, 8) + '...' + obj.id.substring(obj.id.length - 8);
      const size = obj.size ? formatSize(obj.size) : 'N/A';
      const date = new Date(obj.updated_at).toLocaleString();
      const status = obj.deleted ? '<span class="fail">Deleted</span>' : '<span class="pass">Active</span>';

      html += `
        <tr style="border-bottom:1px solid #222;">
          <td style="padding:0.5rem; font-family:monospace; font-size:0.85rem;" title="${obj.id}">${shortId}</td>
          <td style="padding:0.5rem;">${size}</td>
          <td style="padding:0.5rem;">${date}</td>
          <td style="padding:0.5rem;">${status}</td>
          <td style="padding:0.5rem;">
            ${!obj.deleted ? `
              <button onclick="viewObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open in browser viewer">View</button>
              <button onclick="shareObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#10b981; color:white; margin-left:0.25rem;" title="Generate share URL">Share</button>
              <button onclick="showObjectInfo('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#8b5cf6; color:white; margin-left:0.25rem;" title="Show details">Info</button>
              <button onclick="downloadObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;">Download</button>
              <button onclick="copyToClipboard('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;">Copy ID</button>
              <button onclick="deleteObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem; background:#dc2626; color:white;">Delete</button>
            ` : ''}
          </td>
        </tr>
      `;
    }

    html += `
        </tbody>
      </table>
    `;

    objectsList.innerHTML = html;
    status.innerHTML = `<span class="pass">✓ Found ${objects.length} object${objects.length !== 1 ? 's' : ''}</span>`;
  } catch (e) {
    status.innerHTML = `<span class="fail">Error: ${_esc(e.message)}</span>`;
    objectsList.innerHTML = '';
  }
});

// Helper function to download an object by ID
window.downloadObjectById = async (objectId) => {
  const dlUrl = document.getElementById('dl-url');
  const dlFilename = document.getElementById('dl-filename');

  dlUrl.value = objectId;
  dlFilename.value = 'download_' + objectId.substring(0, 8);

  // Switch to download tab and trigger download
  openOrActivateInternalTab('download');
  setTimeout(() => {
    document.getElementById('btn-download').click();
  }, 100);
};

// Helper function to copy to clipboard
window.copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    alert('Object ID copied to clipboard!');
  } catch (e) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    alert('Object ID copied to clipboard!');
  }
};

// Helper function to delete an object
window.deleteObjectById = async (objectId) => {
  const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

  if (!confirm(`⚠️ Are you sure you want to delete object ${shortId}?\n\nThis action cannot be undone!`)) {
    return;
  }

  const status = document.getElementById('list-status');
  const originalStatus = status.innerHTML;

  try {
    status.innerHTML = '<span style="color:#f59e0b;">⏳ Deleting...</span>';

    const sdk = await connectSdk(status);
    if (!sdk) return;

    await sdk.deleteObject(objectId);

    status.innerHTML = '<span class="pass">✓ Object deleted successfully!</span>';

    // Refresh the list after a short delay
    setTimeout(() => {
      document.getElementById('btn-list-objects').click();
    }, 500);
  } catch (e) {
    status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message)}</span>`;

    // Restore original status after showing error for 3 seconds
    setTimeout(() => {
      status.innerHTML = originalStatus;
    }, 3000);
  }
};

// Helper function to view an object in the browser
window.viewObjectById = async (objectId) => {
  const tab = getOrCreateActiveBrowserTab();
  tab.url = objectId;
  tab.label = objectId.length > 30 ? objectId.substring(0, 30) + '...' : objectId;
  setLastBrowserUrl(objectId);
  renderTabBar();

  const addressBar = document.getElementById('chrome-address-bar');
  addressBar.value = objectId;
  loadContentWithAutoDetect();
};

// Helper function to share an object (generate share URL)
window.shareObjectById = async (objectId) => {
  const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

  // Show configuration modal first
  const configModal = document.createElement('div');
  configModal.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8); display: flex; align-items: center;
    justify-content: center; z-index: 1000;
  `;

  configModal.innerHTML = `
    <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:500px; width:90%; border:1px solid #333;">
      <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Generate Share URL</h3>
      <p style="color:#888; margin-bottom:1.5rem;">Object: ${shortId}</p>

      <div style="margin-bottom:1.5rem;">
        <div style="color:#e0e0e0; margin-bottom:0.5rem; font-size:0.9rem;">Expires in</div>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <input id="share-modal-duration" type="number" value="24" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
          <select id="share-modal-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
            <option value="3600000">hours</option>
            <option value="86400000" selected>days</option>
            <option value="604800000">weeks</option>
          </select>
        </div>
      </div>

      <div style="display:flex; gap:0.5rem;">
        <button id="btn-generate-share" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">
          Generate Link
        </button>
        <button id="btn-cancel-share" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
          Cancel
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(configModal);

  // Close on background click
  configModal.addEventListener('click', (e) => {
    if (e.target === configModal) configModal.remove();
  });

  // Cancel button
  configModal.querySelector('#btn-cancel-share').addEventListener('click', () => {
    configModal.remove();
  });

  // Generate button
  configModal.querySelector('#btn-generate-share').addEventListener('click', async () => {
    const generateBtn = configModal.querySelector('#btn-generate-share');
    const originalText = generateBtn.textContent;
    generateBtn.textContent = '⏳ Generating...';
    generateBtn.disabled = true;

    try {
      const duration = parseFloat(configModal.querySelector('#share-modal-duration').value);
      const unit = parseInt(configModal.querySelector('#share-modal-unit', 10).value);

      const status = document.getElementById('list-status');
      const sdk = await connectSdk(status);
      if (!sdk) {
        configModal.remove();
        return;
      }

      // Fetch the object
      const obj = await sdk.object(objectId);

      // Generate share URL with configured duration
      const validUntilMs = Date.now() + (duration * unit);
      const shareUrl = sdk.shareObject(obj, validUntilMs);

      // Calculate human-readable duration
      let durationText = `${duration} ${configModal.querySelector('#share-modal-unit').selectedOptions[0].text}`;

      // Remove config modal
      configModal.remove();

      // Show result modal
      const resultModal = document.createElement('div');
      resultModal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
      `;

      resultModal.innerHTML = `
        <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
          <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Share URL Generated</h3>
          <p style="color:#888; margin-bottom:1rem;">Object: ${shortId}</p>
          <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem; word-break:break-all; font-family:monospace; font-size:0.9rem;">
            ${shareUrl}
          </div>
          <p style="color:#888; font-size:0.9rem; margin-bottom:1rem;">
            ⏰ Valid for ${durationText}<br>
            🔒 Includes encryption key in URL
          </p>
          <div style="display:flex; gap:0.5rem;">
            <button onclick="navigator.clipboard.writeText('${shareUrl.replace(/'/g, "\\'")}').then(() => alert('Share URL copied!')); this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
              📋 Copy URL
            </button>
            <button onclick="this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
              Close
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(resultModal);

      // Close on background click
      resultModal.addEventListener('click', (e) => {
        if (e.target === resultModal) resultModal.remove();
      });
    } catch (e) {
      configModal.remove();
      alert(`Share failed: ${e.message}`);
    }
  });
};

// Helper function to show object info/details
window.showObjectInfo = async (objectId) => {
  const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

  try {
    // Show loading state
    const button = event.target;
    const originalText = button.textContent;
    button.textContent = '⏳';
    button.disabled = true;

    const status = document.getElementById('list-status');
    const sdk = await connectSdk(status);
    if (!sdk) {
      button.textContent = originalText;
      button.disabled = false;
      return;
    }

    // Fetch the object
    const obj = await sdk.object(objectId);
    const size = obj.size();

    // Calculate number of slabs (each slab holds 10 shards * 4MB = ~40MB of data)
    const SLAB_DATA_SIZE = 10 * 4 * 1024 * 1024; // 40 MB
    const numSlabs = size === 0 ? 0 : Math.ceil(size / SLAB_DATA_SIZE);

    // Show info in a modal
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8); display: flex; align-items: center;
      justify-content: center; z-index: 1000;
    `;

    modal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#8b5cf6;">ℹ️ Object Details</h3>
        <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem;">
          <div style="margin-bottom:0.75rem;">
            <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Object ID:</div>
            <div style="font-family:monospace; font-size:0.9rem; word-break:break-all;">${_esc(objectId)}</div>
          </div>
          <div style="margin-bottom:0.75rem;">
            <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Size:</div>
            <div>${formatSize(size)} (${size.toLocaleString()} bytes)</div>
          </div>
          <div style="margin-bottom:0.75rem;">
            <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Slabs:</div>
            <div>${numSlabs} slab${numSlabs !== 1 ? 's' : ''} (~${(numSlabs * 40).toFixed(0)} MB encoded)</div>
          </div>
          <div style="margin-bottom:0.75rem;">
            <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
            <div>10 data shards + 20 parity shards (need any 10 of 30)</div>
          </div>
          <div>
            <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
            <div>10 data + 20 parity (${formatSize(size)} pinned)</div>
          </div>
        </div>
        <button onclick="this.parentElement.parentElement.remove();" style="width:100%; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
          Close
        </button>
      </div>
    `;

    document.body.appendChild(modal);

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Restore button
    button.textContent = originalText;
    button.disabled = false;
  } catch (e) {
    alert(`Failed to load info: ${e.message}`);
    event.target.textContent = 'Info';
    event.target.disabled = false;
  }
};

// -- Share Object --
document.getElementById('btn-share').addEventListener('click', async () => {
  const status = document.getElementById('share-status');
  const objectId = document.getElementById('share-object-id').value.trim();
  const duration = parseFloat(document.getElementById('share-duration').value);
  const unit = parseInt(document.getElementById('share-unit', 10).value);

  if (!objectId) {
    status.innerHTML = '<span class="fail">Enter an Object ID</span>';
    return;
  }

  try {
    const sdk = await connectSdk(status);
    if (!sdk) return;

    status.textContent = 'Fetching object...';
    const obj = await sdk.object(objectId);

    const validUntilMs = Date.now() + (duration * unit);
    const shareUrl = sdk.shareObject(obj, validUntilMs);

    const expiresAt = new Date(validUntilMs).toLocaleString();
    status.textContent = '';
    const passSpan = document.createElement('span');
    passSpan.className = 'pass';
    passSpan.textContent = 'Share link created!';
    status.appendChild(passSpan);
    status.appendChild(document.createTextNode('\nExpires: ' + expiresAt + '\n\n'));
    const link = document.createElement('a');
    link.href = shareUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.cssText = 'color:#60a5fa; word-break:break-all;';
    link.textContent = shareUrl;
    status.appendChild(link);
  } catch (e) {
    const errSpan = document.createElement('span');
    errSpan.className = 'fail';
    errSpan.textContent = 'Error: ' + e.message;
    status.appendChild(document.createTextNode('\n'));
    status.appendChild(errSpan);
  }
});

// Browser module → browser.js

// Wallet & Manifest extracted to wallet.js and manifest.js
// Wire late-binding handler for manifest → loadContentWithAutoDetect
setManifestLoadContent(loadContentWithAutoDetect);

