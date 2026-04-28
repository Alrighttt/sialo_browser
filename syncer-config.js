// Syncer Config panel — manages P2P peer connections, auto-sync, and sync log
// Consumes chain.js for all state and WASM calls.

import * as chain from './chain.js';
import { connectSdk } from './config.js';
import { parallelUpload } from './upload.js';
import { updateCard } from './net-status.js';

// --- Logging ---

const MAX_LOG_LINES = 500;
let logCount = 0;

function log(msg, cls) {
  const el = document.getElementById('sc-log');
  if (!el) return;
  const span = document.createElement('span');
  span.style.color = cls === 'ok' ? '#4ade80' : cls === 'err' ? '#f87171' : cls === 'info' ? '#60a5fa' : cls === 'data' ? '#f59e0b' : '#e0e0e0';
  const ts = new Date().toLocaleTimeString();
  span.textContent = '[' + ts + '] ' + msg + '\n';
  el.appendChild(span);
  logCount++;
  // Trim old lines
  while (logCount > MAX_LOG_LINES && el.firstChild) {
    el.removeChild(el.firstChild);
    logCount--;
  }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// --- UI update ---

let _lastRenderedNet = null;

function updateStatus() {
  const net = document.getElementById('sc-network').value;
  const config = chain.getNetworkConfig(net);
  const syncState = chain.getSyncState(net);

  // Only update config inputs when network changes (avoid overwriting user edits during sync)
  if (net !== _lastRenderedNet) {
    document.getElementById('sc-peer-url').value = config.peerUrl || '';
    document.getElementById('sc-cert-hash').value = config.certHash || '';
    document.getElementById('sc-auto-sync').checked = config.enabled;
    _lastRenderedNet = net;
  }

  // Sync now button
  document.getElementById('sc-btn-sync-now').disabled = !config.peerUrl;

  // Update all network status cards
  updateNetCard('mainnet');
  updateNetCard('mainnet_v2');
  updateNetCard('zen');
}

function updateNetCard(net) {
  updateCard(document.getElementById('sc-net-status-' + net), net);
}

// --- Save config ---

function isValidPeerUrl(url) {
  if (!url) return true; // empty is allowed (disables sync)
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  } catch { return false; }
}

function saveConfig() {
  const net = document.getElementById('sc-network').value;
  const peerUrl = document.getElementById('sc-peer-url').value.trim();
  if (peerUrl && !isValidPeerUrl(peerUrl)) {
    log('Invalid peer URL: must use https:// or wss:// protocol.', 'err');
    return;
  }
  chain.setNetworkConfig(net, {
    peerUrl,
    certHash: document.getElementById('sc-cert-hash').value.trim() || null,
  });
}

// --- Initialization ---

export function initSyncerConfig() {
  const networkSelect = document.getElementById('sc-network');
  const peerUrlInput = document.getElementById('sc-peer-url');
  const certHashInput = document.getElementById('sc-cert-hash');
  const autoSyncCheckbox = document.getElementById('sc-auto-sync');
  const syncNowBtn = document.getElementById('sc-btn-sync-now');
  const clearLogBtn = document.getElementById('sc-btn-clear-log');

  // Workers config
  const numWorkersInput = document.getElementById('sc-num-workers');
  if (numWorkersInput) {
    numWorkersInput.value = localStorage.getItem('sync-num-workers') || '10';
    numWorkersInput.addEventListener('input', () => {
      const val = Math.max(1, Math.min(16, parseInt(numWorkersInput.value, 10) || 10));
      numWorkersInput.value = val;
      localStorage.setItem('sync-num-workers', String(val));
    });
  }

  // Set initial network to active network
  networkSelect.value = chain.getActiveNetwork();

  // Network switch — show that network's config (does NOT change active network)
  networkSelect.addEventListener('change', () => {
    updateStatus();
    updateResetLabel();
  });

  // Save config on input change
  peerUrlInput.addEventListener('change', saveConfig);
  certHashInput.addEventListener('change', saveConfig);

  // Auto-sync toggle
  autoSyncCheckbox.addEventListener('change', () => {
    const net = networkSelect.value;
    const enabled = autoSyncCheckbox.checked;
    chain.setNetworkConfig(net, { enabled });
    if (enabled) {
      log('[' + net + '] Auto-sync enabled', 'info');
      chain.startSync();
    } else {
      log('[' + net + '] Auto-sync disabled', 'info');
      // Stop loop if no networks enabled
      if (chain.getEnabledNetworks().length === 0) {
        chain.stopSync();
      }
    }
  });

  // Sync now button
  syncNowBtn.addEventListener('click', () => {
    const net = networkSelect.value;
    const config = chain.getNetworkConfig(net);
    if (!config.peerUrl) {
      log('Please enter a peer URL first.', 'err');
      return;
    }
    // Temporarily enable if not enabled, for a one-off sync
    if (!config.enabled) {
      chain.setNetworkConfig(net, { enabled: true });
    }
    log('[' + net + '] Manual sync triggered', 'info');
    chain.syncNow(net, { restart: true });
  });

  // Clear log
  clearLogBtn.addEventListener('click', () => {
    document.getElementById('sc-log').innerHTML = '';
    logCount = 0;
  });

  // --- Backup & Restore ---
  //
  // Backup: pack the active network's blobs (filter, txindex, utxo,
  // attestation, headers) into the SBKP envelope, upload as a single
  // Sia object, return a share URL. Restore: download an SBKP from a
  // share URL and replace local data. Same logic the manifest panel
  // uses, scoped to its own status / progress / URL elements.
  const backupBtn = document.getElementById('sc-btn-backup');
  const restoreBtn = document.getElementById('sc-btn-restore');
  const backupStatusEl = document.getElementById('sc-backup-status');
  const backupProgressEl = document.getElementById('sc-backup-progress');
  const backupResultEl = document.getElementById('sc-backup-result');
  const backupUrlEl = document.getElementById('sc-backup-share-url');
  const restoreUrlInput = document.getElementById('sc-restore-url');
  const copyUrlBtn = document.getElementById('sc-btn-copy-url');

  function setBackupStatus(text, color) {
    backupStatusEl.textContent = text;
    backupStatusEl.style.color = color || '#888';
  }

  // Pause auto-sync for one network so backup/restore don't race
  // against an in-flight sync worker writing fresh blobs into
  // IndexedDB. `stopNetwork` terminates the worker and disables
  // auto-sync; we capture the prior enabled state so we can flip it
  // back on after the operation. Returns a function that restores
  // the prior state when called — drives a try/finally.
  async function pauseSyncForNet(net) {
    const wasEnabled = chain.getNetworkConfig(net).enabled;
    if (wasEnabled || chain.getSyncState(net).status === 'syncing') {
      log('[' + net + '] pausing sync for backup/restore', 'info');
      chain.stopNetwork(net);
    }
    return () => {
      if (wasEnabled) {
        // Re-enable + kick an immediate sync. `startSync()` alone only
        // schedules the interval (default 5 min), so the user would
        // see `idle` for minutes after a restore even though the
        // restored data is ready and a verification sync is wanted.
        // `syncNow({ restart: true })` triggers right away and the
        // interval picks up subsequent rounds.
        chain.setNetworkConfig(net, { enabled: true });
        chain.startSync();
        chain.syncNow(net, { restart: true });
        log('[' + net + '] sync resumed', 'info');
      }
    };
  }

  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      const net = chain.getActiveNetwork();
      // Gate on full sync — backing up partial data writes a torn
      // SBKP that wouldn't restore cleanly.
      const syncState = chain.getSyncState(net);
      if (syncState.status !== 'synced') {
        log('Cannot backup: ' + net + ' is not fully synced (status: ' + syncState.status + ').', 'err');
        return;
      }

      backupBtn.disabled = true;
      backupResultEl.style.display = 'none';
      const resumeSync = await pauseSyncForNet(net);
      try {
        setBackupStatus('Packing ' + net + ' sync data...');
        const packed = await chain.exportNetworkData(net);
        if (!packed || packed.length < 10) {
          log('No sync data to backup for ' + net + '.', 'err');
          setBackupStatus('');
          return;
        }
        log('Packed ' + (packed.length / 1024 / 1024).toFixed(1) + ' MB for ' + net + '.', 'info');

        backupProgressEl.style.display = 'block';
        const backupFile = new File([packed], `backup-${net}.dat`, { type: 'application/octet-stream' });
        const { obj, elapsed, size } = await parallelUpload(backupFile, backupStatusEl, backupProgressEl);
        log('Uploaded ' + size + ' bytes in ' + elapsed + 's.', 'ok');

        const sdk = await connectSdk(backupStatusEl);
        if (!sdk) { log('Failed to connect to indexer.', 'err'); return; }

        // 1-year share URL — same default the manifest backup uses.
        const validUntilMs = Date.now() + (365 * 24 * 60 * 60 * 1000);
        const shareUrl = sdk.shareObject(obj, validUntilMs);
        log('Share URL: ' + shareUrl, 'data');

        try { await sdk.pinObject(obj); log('Object pinned.', 'ok'); }
        catch (pinErr) { log('Pin failed: ' + pinErr, 'info'); }

        backupUrlEl.textContent = shareUrl;
        backupUrlEl.onclick = () => {
          navigator.clipboard.writeText(shareUrl).then(() => log('Share URL copied.', 'ok'));
        };
        backupResultEl.style.display = '';
        setBackupStatus('Backup complete for ' + net + '.', '#4ade80');
        backupProgressEl.style.display = 'none';
      } catch (e) {
        log('Backup error: ' + e, 'err');
        setBackupStatus('Backup failed: ' + e, '#f87171');
        backupProgressEl.style.display = 'none';
      } finally {
        backupBtn.disabled = false;
        resumeSync();
      }
    });
  }

  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      const url = restoreUrlInput.value.trim();
      if (!url) { log('Enter a share URL.', 'err'); return; }
      if (!url.startsWith('sia://')) { log('URL must start with sia://', 'err'); return; }

      const net = chain.getActiveNetwork();
      restoreBtn.disabled = true;
      const resumeSync = await pauseSyncForNet(net);
      try {
        setBackupStatus('Connecting to indexer...');
        const sdk = await connectSdk(backupStatusEl);
        if (!sdk) { log('Failed to connect to indexer.', 'err'); return; }

        setBackupStatus('Downloading backup...');
        backupProgressEl.style.display = 'block';
        const obj = await sdk.sharedObject(url);
        const totalSize = obj.size();
        const stream = sdk.download(obj);
        const reader = stream.getReader();
        const parts = [];
        let off = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          off += value.byteLength;
          backupProgressEl.max = totalSize;
          backupProgressEl.value = off;
          setBackupStatus('Downloading... ' + (off / 1024 / 1024).toFixed(1) +
            ' / ' + (totalSize / 1024 / 1024).toFixed(1) + ' MB');
        }
        const totalLen = parts.reduce((s, p) => s + p.length, 0);
        const packed = new Uint8Array(totalLen);
        let p = 0;
        for (const part of parts) { packed.set(part, p); p += part.length; }
        log('Downloaded ' + (totalLen / 1024 / 1024).toFixed(1) + ' MB.', 'ok');

        setBackupStatus('Restoring data for ' + net + '...');
        // Per-entry visibility — without this the user sees the
        // status freeze for tens of seconds on mainnet's filter blob.
        await chain.importNetworkData(net, packed, ({ stage, name, dataLen }) => {
          const fmt = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
          if (stage === 'writing') {
            setBackupStatus('Restoring ' + name + ' (' + fmt(dataLen) + ')...');
          } else if (stage === 'wrote') {
            log('Wrote ' + name + ' (' + fmt(dataLen) + ').', 'data');
          } else if (stage === 'loading-filters') {
            setBackupStatus('Loading filter index for ' + net + '...');
          } else if (stage === 'filters-loaded') {
            log('Filter index loaded.', 'ok');
          }
        });
        log('Sync data restored for ' + net + '.', 'ok');
        setBackupStatus('Restore complete for ' + net + '.', '#4ade80');
        backupProgressEl.style.display = 'none';
      } catch (e) {
        log('Restore failed: ' + e, 'err');
        setBackupStatus('Restore failed: ' + e, '#f87171');
        backupProgressEl.style.display = 'none';
      } finally {
        restoreBtn.disabled = false;
        resumeSync();
      }
    });
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', () => {
      const url = backupUrlEl.textContent;
      if (url) {
        navigator.clipboard.writeText(url).then(() => log('Share URL copied.', 'ok'));
      }
    });
  }

  // Data management buttons
  const clearStatus = document.getElementById('sc-clear-status');
  const clearAllBtn = document.getElementById('sc-btn-clear-all');

  const NET_LABELS = { mainnet: 'Mainnet', mainnet_v2: 'V2-only', zen: 'Zen' };
  function updateResetLabel() {
    const label = NET_LABELS[networkSelect.value] || networkSelect.value;
    clearAllBtn.textContent = 'Reset ' + label;
  }
  updateResetLabel();

  // Shared wrapper for data management actions: status updates, try/catch, log
  async function runDataAction(progressMsg, action, successMsg, logMsg) {
    clearStatus.textContent = progressMsg;
    clearStatus.style.color = '#60a5fa';
    try {
      await action();
      clearStatus.textContent = successMsg;
      clearStatus.style.color = '#4ade80';
      if (logMsg) log(logMsg, 'info');
    } catch (e) {
      clearStatus.textContent = 'Error: ' + e;
      clearStatus.style.color = '#f87171';
    }
    updateStatus();
  }

  function requirePeerUrl(net) {
    const config = chain.getNetworkConfig(net);
    if (!config.peerUrl) {
      log('Please enter a peer URL first.', 'err');
      return false;
    }
    return true;
  }

  document.getElementById('sc-btn-clear-filters').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!confirm('Clear all filter data for ' + net + '? You will need to re-sync.')) return;
    await runDataAction('Clearing filters...', () => chain.clearFilters(net),
      'Filters cleared for ' + net, '[' + net + '] Filters cleared');
  });

  document.getElementById('sc-btn-clear-txindex').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!confirm('Clear transaction index for ' + net + '? You will need to re-sync.')) return;
    await runDataAction('Clearing transaction index...', () => chain.clearTxindex(net),
      'Transaction index cleared for ' + net, '[' + net + '] Transaction index cleared');
  });

  document.getElementById('sc-btn-clear-all').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!confirm('Clear ALL sync data for ' + net + '? This will stop syncing, disconnect the relay, and clear all filters, transaction index, and checkpoints.')) return;
    await runDataAction('Stopping operations...', async () => {
      chain.stopNetwork(net);
      log('[' + net + '] Stopped sync and relay', 'info');
      autoSyncCheckbox.checked = false;
      clearStatus.textContent = 'Clearing all data...';
      await chain.clearAllData(net);
    }, 'All data cleared for ' + net, '[' + net + '] All sync data cleared');
  });

  document.getElementById('sc-btn-rebuild-filters').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!requirePeerUrl(net)) return;
    if (!confirm('Rebuild all filters for ' + net + '? This will clear existing filters and transaction index, then re-sync from scratch.')) return;
    log('[' + net + '] Rebuilding filters from scratch', 'info');
    await runDataAction('Clearing data...', () => chain.rebuildFilters(net),
      'Rebuild started for ' + net, null);
  });

  document.getElementById('sc-btn-clear-utxoindex').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!confirm('Clear UTXO index for ' + net + '? You will need to re-sync.')) return;
    await runDataAction('Clearing UTXO index...', () => chain.clearUtxoIndex(net),
      'UTXO index cleared for ' + net, '[' + net + '] UTXO index cleared');
  });

  document.getElementById('sc-btn-rebuild-txindex').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!requirePeerUrl(net)) return;
    if (!confirm('Rebuild transaction index for ' + net + '? This will clear the existing txindex then re-sync.')) return;
    log('[' + net + '] Rebuilding txindex from scratch', 'info');
    await runDataAction('Clearing txindex...', () => chain.regenerateTxindex(net),
      'Rebuild started for ' + net, null);
  });

  document.getElementById('sc-btn-rebuild-utxoindex').addEventListener('click', async () => {
    const net = networkSelect.value;
    if (!requirePeerUrl(net)) return;
    if (!confirm('Rebuild UTXO index for ' + net + '? This will clear the existing UTXO index then re-sync.')) return;
    log('[' + net + '] Rebuilding UTXO index from scratch', 'info');
    await runDataAction('Clearing UTXO index...', () => chain.regenerateUtxoIndex(net),
      'Rebuild started for ' + net, null);
  });

  // Subscribe to sync log events from chain.js
  chain.onSyncLog((net, msg, cls) => {
    log('[' + net + '] ' + msg, cls);
  });

  // Subscribe to state changes to update UI
  chain.onChange(() => {
    updateStatus();
  });

  // Initial render
  updateStatus();
  log('Syncer config initialized', 'info');

  // Show which networks are enabled
  const enabled = chain.getEnabledNetworks();
  if (enabled.length > 0) {
    log('Auto-sync enabled for: ' + enabled.join(', '), 'info');
  }
}
