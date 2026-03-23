// net-status.js — Shared network status card renderer
// Used by both the syncer and explorer pages for consistent styling.

import * as chain from './chain.js';

const NET_LABELS = { mainnet: 'Mainnet', mainnet_v2: 'V2-only', zen: 'Zen' };

export function fmtSize(bytes) {
  if (!bytes) return '0';
  if (bytes < 1e3) return bytes + ' B';
  if (bytes < 1e6) return (bytes / 1e3).toFixed(1) + ' KB';
  if (bytes < 1e9) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e9).toFixed(2) + ' GB';
}

/**
 * Build the inner HTML for a status card. Returns an HTML string.
 * @param {string} net - Network key (mainnet, mainnet_v2, zen)
 * @param {string} [id] - Optional id attribute for the card div
 */
export function createCardHTML(net, id) {
  const label = NET_LABELS[net] || net;
  const idAttr = id ? ` id="${id}"` : '';
  return `<div${idAttr} class="sc-net-status-card">
  <div style="display:flex; align-items:center; gap:0.4rem; margin-bottom:0.3rem;">
    <span class="sc-net-dot" style="font-size:12px; color:#555;">&#9679;</span>
    <span class="sc-net-name" style="font-weight:600; font-size:0.85rem; color:#ccc;">${label}</span>
    <span class="sc-net-state" style="font-size:0.8rem; color:#888; margin-left:auto;">Disabled</span>
  </div>
  <div class="sc-net-phase" style="display:none; color:#888; font-size:0.78rem; margin-bottom:0.3rem;"></div>
  <div class="sc-net-relay" style="color:#666; font-size:0.75rem; margin-bottom:0.3rem;">Relay: off</div>
  <div style="display:flex; gap:1rem; font-size:0.75rem; color:#666;">
    <span class="nb-idx"><span class="sc-net-filters">\u274C SCBF</span><span class="info-tip">&#9432;<span class="info-tip-text">Sia Compact Block Filters — address activity index built from block headers</span></span></span>
    <span class="nb-idx"><span class="sc-net-txindex">\u274C STXI</span><span class="info-tip">&#9432;<span class="info-tip-text">Sia Transaction Index — maps transaction IDs to block heights for fast lookup</span></span></span>
    <span class="nb-idx"><span class="sc-net-utxoindex">\u274C SUXI</span><span class="info-tip">&#9432;<span class="info-tip-text">Sia UTXO Index — tracks unspent transaction outputs by address prefix</span></span></span>
    <span class="nb-idx"><span class="sc-net-attestationindex">\u274C SAPI</span><span class="info-tip">&#9432;<span class="info-tip-text">Sia Attestation Pubkey Index — maps public keys to attestation entries</span></span></span>
  </div>
  <div class="sc-net-storage" style="font-size:0.7rem; color:#555; margin-top:0.3rem;"></div>
</div>`;
}

/**
 * Update a status card element with current chain state for the given network.
 * @param {HTMLElement} card - The .sc-net-status-card element
 * @param {string} net - Network key
 */
export function updateCard(card, net) {
  if (!card) return;

  const config = chain.getNetworkConfig(net);
  const syncState = chain.getSyncState(net);
  const nameEl = card.querySelector('.sc-net-name');
  const dot = card.querySelector('.sc-net-dot');
  const stateEl = card.querySelector('.sc-net-state');
  const phaseEl = card.querySelector('.sc-net-phase');
  const relayEl = card.querySelector('.sc-net-relay');
  const filterEl = card.querySelector('.sc-net-filters');
  const txindexEl = card.querySelector('.sc-net-txindex');
  const utxoindexEl = card.querySelector('.sc-net-utxoindex');
  const attestationindexEl = card.querySelector('.sc-net-attestationindex');
  const storageEl = card.querySelector('.sc-net-storage');

  if (nameEl) nameEl.textContent = NET_LABELS[net] || net;

  // Sync status
  if (syncState.status === 'syncing') {
    const isHeaders = syncState.phase === 'headers';
    const color = isHeaders ? '#f59e0b' : '#60a5fa';
    dot.style.color = color;
    stateEl.textContent = 'Syncing';
    stateEl.style.color = color;
    const phase = isHeaders ? 'Syncing headers...'
      : syncState.phase === 'filters' ? 'Building filters...'
      : syncState.phase === 'txindex' ? 'Building txindex...'
      : '...';
    const progress = syncState.currentHeight && syncState.networkHeight
      ? ' (' + Math.round(syncState.currentHeight / syncState.networkHeight * 100) + '%)'
      : '';
    phaseEl.textContent = phase + progress;
    phaseEl.style.color = color;
    phaseEl.style.display = 'block';
  } else if (syncState.status === 'synced') {
    dot.style.color = '#4ade80';
    stateEl.textContent = 'Synced';
    stateEl.style.color = '#4ade80';
    phaseEl.textContent = syncState.lastSync ? 'Last: ' + new Date(syncState.lastSync).toLocaleTimeString() : '';
    phaseEl.style.display = syncState.lastSync ? 'block' : 'none';
  } else if (syncState.status === 'error') {
    dot.style.color = '#f87171';
    stateEl.textContent = 'Error';
    stateEl.style.color = '#f87171';
    phaseEl.textContent = syncState.error || 'Unknown error';
    phaseEl.style.display = 'block';
  } else {
    dot.style.color = '#555';
    stateEl.textContent = config.enabled ? 'Idle' : 'Disabled';
    stateEl.style.color = '#888';
    phaseEl.style.display = 'none';
  }

  // Relay
  const relayState = chain.getRelayState(net);
  if (relayState.running) {
    relayEl.textContent = 'Relay: connected';
    relayEl.style.color = '#4ade80';
  } else {
    relayEl.textContent = 'Relay: off';
    relayEl.style.color = '#666';
  }

  // Filter/txindex/utxoindex
  const isActive = net === chain.getActiveNetwork();
  if (isActive) {
    // Active network: check blob URLs for definitive loaded status
    if (chain.getFilterUrl()) {
      filterEl.textContent = '\u2705 SCBF';
      filterEl.style.color = '#4ade80';
    } else {
      filterEl.textContent = '\u274C SCBF';
      filterEl.style.color = '#666';
    }
    if (chain.getTxindexUrl()) {
      txindexEl.textContent = '\u2705 STXI';
      txindexEl.style.color = '#4ade80';
    } else {
      txindexEl.textContent = '\u274C STXI';
      txindexEl.style.color = '#666';
    }
    if (chain.getUtxoIndexUrl()) {
      utxoindexEl.textContent = '\u2705 SUXI';
      utxoindexEl.style.color = '#4ade80';
    } else {
      utxoindexEl.textContent = '\u274C SUXI';
      utxoindexEl.style.color = '#666';
    }
    if (chain.getAttestationIndexUrl()) {
      attestationindexEl.textContent = '\u2705 SAPI';
      attestationindexEl.style.color = '#4ade80';
    } else {
      attestationindexEl.textContent = '\u274C SAPI';
      attestationindexEl.style.color = '#666';
    }
  } else {
    // Non-active network: infer from sync state
    const synced = syncState.status === 'synced';
    filterEl.textContent = synced ? '\u2705 SCBF' : '\u274C SCBF';
    filterEl.style.color = synced ? '#4ade80' : '#555';
    txindexEl.textContent = synced ? '\u2705 STXI' : '\u274C STXI';
    txindexEl.style.color = synced ? '#4ade80' : '#555';
    utxoindexEl.textContent = synced ? '\u2705 SUXI' : '\u274C SUXI';
    utxoindexEl.style.color = synced ? '#4ade80' : '#555';
    attestationindexEl.textContent = synced ? '\u2705 SAPI' : '\u274C SAPI';
    attestationindexEl.style.color = synced ? '#4ade80' : '#555';
  }

  // Storage sizes
  if (storageEl) {
    chain.getStorageSizes(net).then(sizes => {
      if (sizes.total === 0) {
        storageEl.textContent = '';
      } else {
        const parts = [];
        if (sizes.headers) parts.push('headers: ' + fmtSize(sizes.headers));
        if (sizes.filters) parts.push('filters: ' + fmtSize(sizes.filters));
        if (sizes.txindex) parts.push('txindex: ' + fmtSize(sizes.txindex));
        if (sizes.utxoindex) parts.push('utxos: ' + fmtSize(sizes.utxoindex));
        if (sizes.attestationindex) parts.push('attestations: ' + fmtSize(sizes.attestationindex));
        parts.push('total: ' + fmtSize(sizes.total));
        storageEl.textContent = parts.join(' | ');
      }
    });
  }
}
