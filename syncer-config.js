// Syncer Config panel — manages P2P peer connections, auto-sync, and sync log
// Consumes chain.js for all state and WASM calls.

import * as chain from './chain.js';
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

function saveConfig() {
  const net = document.getElementById('sc-network').value;
  chain.setNetworkConfig(net, {
    peerUrl: document.getElementById('sc-peer-url').value.trim(),
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
