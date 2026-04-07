// Wallet module — manages seed generation, encryption, scanning, UTXO tracking,
// transaction building, and mempool integration.

import { _esc } from './utils.js';
import { kdfEncrypt, kdfDecrypt } from './kdf.js';
import { openOrActivateInternalTab } from './tabs.js';
import {
  getActiveNetwork, getNetworkConfig, getGenesisHex,
  getFilterUrl, getUtxoIndexUrl,
  getMempool, getMempoolTransactions, onMempoolChange, addToMempool,
  onChange as chainOnChange, getSyncState,
} from './chain.js';
import { explore as explorerQuery, exploreTransaction, buildTransactionCard, highlightMempoolTxn } from './explorer.js';
import {
  generate_mnemonic, mnemonic_to_entropy, entropy_to_mnemonic,
  derive_addresses, build_v2_transaction, broadcast_v2_transaction,
  compute_utxo_proofs, v2_output_id,
} from './pkg/syncer_wasm.js';

// ========== Wallet ==========

let _walletEntropy = null;
let _walletLockTimer = null;
let _walletHasSaved = false;
let _walletLockSuspended = false;
const WALLET_LOCK_TIMEOUT = 5 * 60 * 1000;

function walletLog(msg, type) {
  const el = document.getElementById('wallet-status-text');
  const color = type === 'err' ? '#f87171' : type === 'ok' ? '#4ade80' : type === 'info' ? '#60a5fa' : '#888';
  el.textContent = msg;
  el.style.color = color;
}

function walletScanLog(msg, type) {
  const el = document.getElementById('wallet-scan-log');
  const color = type === 'err' ? '#f87171' : type === 'ok' ? '#4ade80' : type === 'info' ? '#60a5fa' : type === 'data' ? '#f59e0b' : '#888';
  const ts = new Date().toLocaleTimeString();
  const prefix = '[' + ts + '] ';
  // "progress" type replaces the last log line (for counters like header sync)
  if (type === 'progress') {
    let last = el.querySelector('[data-progress]');
    if (!last) {
      last = document.createElement('div');
      last.setAttribute('data-progress', '1');
      el.appendChild(last);
    }
    last.style.color = color;
    last.textContent = prefix + msg;
  } else {
    // Remove any stale progress line when a non-progress message arrives
    const prog = el.querySelector('[data-progress]');
    if (prog) prog.removeAttribute('data-progress');
    const div = document.createElement('div');
    div.style.color = color;
    div.textContent = prefix + msg;
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function walletUpdateUI() {
  const icon = document.getElementById('wallet-lock-icon');
  const text = document.getElementById('wallet-status-text');
  const status = document.getElementById('wallet-status');
  const deriveSection = document.getElementById('wallet-derive-section');
  const utxoSection = document.getElementById('wallet-utxo-section');
  const txbuilderSection = document.getElementById('wallet-txbuilder-section');
  const logSection = document.getElementById('wallet-log-section');
  const setupUI = document.getElementById('wallet-setup-ui');
  const unlockUI = document.getElementById('wallet-unlock-ui');
  const activeUI = document.getElementById('wallet-active-ui');

  if (_walletEntropy) {
    // Unlocked
    icon.innerHTML = '&#x1F513;';
    text.textContent = 'Unlocked';
    status.classList.remove('wallet-locked');
    status.classList.add('wallet-unlocked');
    setupUI.style.display = 'none';
    unlockUI.style.display = 'none';
    activeUI.style.display = '';
    deriveSection.style.display = '';
    utxoSection.style.display = '';
    txbuilderSection.style.display = '';
    logSection.style.display = '';
  } else {
    // Locked
    icon.innerHTML = '&#x1F512;';
    text.textContent = 'Locked';
    status.classList.remove('wallet-unlocked');
    status.classList.add('wallet-locked');
    activeUI.style.display = 'none';
    deriveSection.style.display = 'none';
    utxoSection.style.display = 'none';
    txbuilderSection.style.display = 'none';
    logSection.style.display = 'none';
    if (_walletHasSaved) {
      // Show compact unlock
      unlockUI.style.display = '';
      setupUI.style.display = 'none';
    } else {
      // Show full setup
      unlockUI.style.display = 'none';
      setupUI.style.display = '';
    }
  }
}

function walletResetLockTimer() {
  if (_walletLockTimer) clearTimeout(_walletLockTimer);
  if (_walletLockSuspended) return;
  if (_walletEntropy) {
    _walletLockTimer = setTimeout(() => {
      walletLock();
      walletLog('Auto-locked after 5 minutes of inactivity.', 'info');
    }, WALLET_LOCK_TIMEOUT);
  }
}

function walletLock() {
  _walletEntropy = null;
  _lastWalletScanResult = null;
  if (_walletLockTimer) { clearTimeout(_walletLockTimer); _walletLockTimer = null; }
  if (_seedDisplayTimer) { clearTimeout(_seedDisplayTimer); _seedDisplayTimer = null; }
  document.getElementById('wallet-mnemonic').value = '';
  document.getElementById('wallet-password-unlock').value = '';
  document.getElementById('wallet-seed-display').style.display = 'none';
  document.getElementById('wallet-seed-phrase').value = '';
  document.getElementById('wallet-addresses').innerHTML = '';
  document.getElementById('wallet-history-body').innerHTML = '';
  document.getElementById('wallet-utxo-body').innerHTML = '';
  document.getElementById('wallet-tab-stats').innerHTML = '';
  document.getElementById('wallet-balance-box').style.display = 'none';
  document.getElementById('wallet-scan-stats').style.display = 'none';
  document.getElementById('wallet-tab-wrap').style.display = 'none';
  walletUpdateUI();
}

async function walletDelete() {
  if (!confirm('Delete saved wallet from browser storage? This cannot be undone. Make sure you have your seed phrase backed up.')) return;
  await walletDbSave('encrypted_entropy', undefined);
  _walletHasSaved = false;
  walletLock();
  walletLog('Wallet deleted from browser storage.', 'info');
}

// IndexedDB helpers
function walletDbSave(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_wallet', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('vault');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('vault', 'readwrite');
      tx.objectStore('vault').put(value, key);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => { req.result.close(); reject(tx.error); };
    };
  });
}

function walletDbLoad(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_wallet', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('vault');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('vault', 'readonly');
      const get = tx.objectStore('vault').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result); };
      get.onerror = () => { req.result.close(); reject(get.error); };
    };
  });
}

function walletGenerateSeed(wordCount = 24) {
  try {
    const phrase = generate_mnemonic(wordCount);
    document.getElementById('wallet-mnemonic').value = phrase;
    walletLog(`Generated ${wordCount}-word seed phrase.`, 'ok');
  } catch (e) {
    walletLog('Error: ' + e, 'err');
  }
}

async function walletEncryptAndSave() {
  const phrase = document.getElementById('wallet-mnemonic').value.trim();
  const password = document.getElementById('wallet-password').value;
  if (!phrase) { walletLog('Enter or generate a seed phrase first.', 'err'); return; }
  if (!password) { walletLog('Enter a password.', 'err'); return; }

  try {
    document.getElementById('wallet-status-text').textContent = 'Encrypting...';
    const entropyHex = mnemonic_to_entropy(phrase);
    const encrypted = await kdfEncrypt(entropyHex, password);
    await walletDbSave('encrypted_entropy', encrypted);
    _walletEntropy = entropyHex;
    _walletHasSaved = true;
    document.getElementById('wallet-password').value = '';
    document.getElementById('wallet-mnemonic').value = '';
    walletUpdateUI();
    walletResetLockTimer();
    walletScanUtxos();
  } catch (e) {
    walletLog('Error: ' + e, 'err');
  }
}

async function walletLoadAndDecrypt() {
  // Try unlock field first, fall back to setup field
  const unlockPw = document.getElementById('wallet-password-unlock').value;
  const setupPw = document.getElementById('wallet-password').value;
  const password = unlockPw || setupPw;
  if (!password) { walletLog('Enter the password used when saving.', 'err'); return; }

  try {
    const encrypted = await walletDbLoad('encrypted_entropy');
    if (!encrypted) { walletLog('No saved wallet found in browser storage.', 'err'); return; }
    document.getElementById('wallet-status-text').textContent = 'Decrypting...';
    const entropyHex = await kdfDecrypt(encrypted, password);
    _walletEntropy = entropyHex;
    _walletHasSaved = true;
    document.getElementById('wallet-password').value = '';
    document.getElementById('wallet-password-unlock').value = '';
    document.getElementById('wallet-mnemonic').value = '';
    walletUpdateUI();
    walletResetLockTimer();
    walletScanUtxos();
  } catch (e) {
    walletLog('Decryption failed: wrong password or corrupted data.', 'err');
  }
}

let _seedDisplayTimer = null;
function walletExportSeed() {
  if (!_walletEntropy) { walletLog('Wallet is locked.', 'err'); return; }
  try {
    const phrase = entropy_to_mnemonic(_walletEntropy);
    const display = document.getElementById('wallet-seed-display');
    const seedInput = document.getElementById('wallet-seed-phrase');
    seedInput.value = phrase;
    display.style.display = '';
    walletResetLockTimer();
    walletLog('Seed phrase displayed. It will be hidden after 60 seconds.', 'info');
    // Auto-hide seed phrase after 60 seconds
    if (_seedDisplayTimer) clearTimeout(_seedDisplayTimer);
    _seedDisplayTimer = setTimeout(() => {
      seedInput.value = '';
      display.style.display = 'none';
      _seedDisplayTimer = null;
    }, 60_000);
  } catch (e) {
    walletLog('Error: ' + e, 'err');
  }
}

function walletDeriveAddresses() {
  if (!_walletEntropy) { walletLog('Wallet is locked.', 'err'); return; }
  const start = parseInt(document.getElementById('wallet-derive-start', 10).value) || 0;
  const count = parseInt(document.getElementById('wallet-derive-count', 10).value) || 5;

  try {
    const json = derive_addresses(_walletEntropy, start, count);
    const addrs = JSON.parse(json);

    let html = '<table><thead><tr><th>Index</th><th>Address</th><th>Public Key</th></tr></thead><tbody>';
    for (const a of addrs) {
      html += `<tr>
        <td style="color:#f59e0b; white-space:nowrap;">${_esc(String(a.index))}</td>
        <td><span class="addr-link" data-addr="${_esc(a.address)}" title="Open in Explorer">${_esc(a.address)}</span></td>
        <td style="color:#888;">${_esc(a.public_key)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    document.getElementById('wallet-addresses').innerHTML = html;

    // Make addresses clickable → Explorer
    document.getElementById('wallet-addresses').querySelectorAll('.addr-link').forEach(el => {
      el.addEventListener('click', () => {
        const addr = el.dataset.addr;
        openOrActivateInternalTab('explorer');
        setTimeout(() => {
          document.getElementById('exp-query').value = addr;
          explorerQuery();
        }, 100);
      });
    });

    walletResetLockTimer();
    walletLog(`Derived ${addrs.length} addresses (${start}..${start + count - 1}).`, 'ok');
  } catch (e) {
    walletLog('Error: ' + e, 'err');
  }
}

function walletTruncate(s) {
  if (!s || s.length < 16) return s || '';
  return s.slice(0, 8) + '...' + s.slice(-8);
}

let _lastWalletScanResult = null;

// --- Wallet tab switching (mirrors explorer) ---
function walletSwitchTab(tabName) {
  document.querySelectorAll('.wscan-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.style.background = isActive ? '#151515' : '#0a0a0a';
    btn.style.color = isActive ? '#10b981' : '#888';
    btn.style.borderColor = isActive ? '#2a2a2a' : '#1a1a1a';
    btn.classList.toggle('active', isActive);
  });
  document.getElementById('wallet-tab-history').style.display = tabName === 'history' ? '' : 'none';
  document.getElementById('wallet-tab-utxos').style.display = tabName === 'utxos' ? '' : 'none';
  document.getElementById('wallet-tab-stats').style.display = tabName === 'stats' ? '' : 'none';
}

// --- Wallet history table (mirrors explorer populateHistoryTable) ---
function walletPopulateHistoryTable(allUtxos) {
  const body = document.getElementById('wallet-history-body');
  body.innerHTML = '';
  for (const u of allUtxos) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #1a1a1a';
    const isRecv = u.direction === 'received';

    const tdHeight = document.createElement('td');
    tdHeight.style.padding = '5px 8px';
    const hLink = document.createElement('span');
    hLink.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    hLink.textContent = u.height;
    hLink.className = 'wallet-height-link';
    hLink.dataset.height = u.height;
    tdHeight.appendChild(hLink);

    const tdAddr = document.createElement('td');
    tdAddr.style.cssText = 'padding:5px 8px; font-size:0.75rem;';
    const addrLink = document.createElement('span');
    addrLink.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    addrLink.textContent = '#' + (u._addrIndex != null ? u._addrIndex : '?');
    addrLink.title = u._address || '';
    addrLink.className = 'addr-link';
    addrLink.dataset.addr = u._address || '';
    tdAddr.appendChild(addrLink);

    const tdDir = document.createElement('td');
    tdDir.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
    tdDir.textContent = isRecv ? '+' : '-';

    const tdAmt = document.createElement('td');
    tdAmt.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
    tdAmt.textContent = u.amount;

    const tdTxid = document.createElement('td');
    tdTxid.style.padding = '5px 8px';
    if (u.txid) {
      const link = document.createElement('span');
      link.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline; font-size:0.75rem;';
      link.textContent = walletTruncate(u.txid);
      link.title = u.txid;
      link.className = 'wallet-tx-link';
      link.dataset.txid = u.txid;
      link.dataset.height = u.height;
      tdTxid.appendChild(link);
    } else {
      tdTxid.textContent = u.source === 'miner_payout' ? 'coinbase' : '\u2014';
      tdTxid.style.color = '#888';
      tdTxid.style.fontSize = '0.75rem';
    }

    const tdSrc = document.createElement('td');
    tdSrc.style.cssText = 'padding:5px 8px; color:#888; font-size:0.75rem;';
    tdSrc.textContent = u.source;

    tr.append(tdHeight, tdAddr, tdDir, tdAmt, tdTxid, tdSrc);
    body.appendChild(tr);
  }
}

// --- Wallet UTXO table (mirrors explorer populateUtxoTable) ---
function walletPopulateUtxoTable(allUtxos) {
  const body = document.getElementById('wallet-utxo-body');
  body.innerHTML = '';

  // Use SUXI-confirmed unspent IDs when available (more reliable than
  // spent-ID matching which depends on fetching every spend block)
  const suxiIds = _lastWalletScanResult?.unspentOutputIds;
  let unspent;
  if (suxiIds) {
    const suxiSet = new Set(suxiIds);
    unspent = allUtxos.filter(u => u.direction === 'received' && u.outputId && suxiSet.has(u.outputId));
  } else {
    const spentIds = new Set();
    for (const u of allUtxos) {
      if (u.direction === 'sent' && u.outputId) spentIds.add(u.outputId);
    }
    unspent = allUtxos.filter(u => u.direction === 'received' && u.outputId && !spentIds.has(u.outputId));
  }

  for (const u of unspent) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #1a1a1a';

    const tdHeight = document.createElement('td');
    tdHeight.style.padding = '5px 8px';
    const hLink2 = document.createElement('span');
    hLink2.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    hLink2.textContent = u.height;
    hLink2.className = 'wallet-height-link';
    hLink2.dataset.height = u.height;
    tdHeight.appendChild(hLink2);

    const tdAddr = document.createElement('td');
    tdAddr.style.cssText = 'padding:5px 8px; font-size:0.75rem;';
    const addrLink = document.createElement('span');
    addrLink.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    addrLink.textContent = '#' + (u._addrIndex != null ? u._addrIndex : '?');
    addrLink.title = u._address || '';
    addrLink.className = 'addr-link';
    addrLink.dataset.addr = u._address || '';
    tdAddr.appendChild(addrLink);

    const tdAmt = document.createElement('td');
    tdAmt.style.cssText = 'padding:5px 8px; color:#4ade80;';
    tdAmt.textContent = u.amount;

    const tdId = document.createElement('td');
    tdId.style.cssText = 'padding:5px 8px; font-size:0.75rem; color:#888;';
    tdId.textContent = walletTruncate(u.outputId);
    tdId.title = u.outputId;

    const tdSrc = document.createElement('td');
    tdSrc.style.cssText = 'padding:5px 8px; color:#888; font-size:0.75rem;';
    tdSrc.textContent = u.source;

    tr.append(tdHeight, tdAddr, tdAmt, tdId, tdSrc);
    body.appendChild(tr);
  }

  // Update tab label with count
  const utxoTab = document.querySelector('.wscan-tab[data-tab="utxos"]');
  if (utxoTab) utxoTab.textContent = 'UTXOs (' + unspent.length + ')';
}

// --- Wallet stats tab (mirrors explorer populateStatsTab) ---
function walletPopulateStatsTab(result, allUtxos) {
  const el = document.getElementById('wallet-tab-stats');

  const suxiIds2 = _lastWalletScanResult?.unspentOutputIds;
  let unspent;
  if (suxiIds2) {
    const suxiSet2 = new Set(suxiIds2);
    unspent = allUtxos.filter(u => u.direction === 'received' && u.outputId && suxiSet2.has(u.outputId));
  } else {
    const spentIds = new Set();
    for (const u of allUtxos) {
      if (u.direction === 'sent' && u.outputId) spentIds.add(u.outputId);
    }
    unspent = allUtxos.filter(u => u.direction === 'received' && u.outputId && !spentIds.has(u.outputId));
  }

  const heights = allUtxos.map(u => u.height);
  const tipHeight = Math.max(...heights);
  const firstHeight = Math.min(...heights);
  const MATURITY_DELAY = 144;

  const immatureSources = new Set(['storageproof_host', 'storageproof_renter', 'miner_payout']);
  const immature = unspent.filter(u => immatureSources.has(u.source) && (u.height + MATURITY_DELAY) > tipHeight);
  const immatureTotal = immature.reduce((s, u) => s + BigInt(u.amountHastings), 0n);
  const matureTotal = unspent.reduce((s, u) => s + BigInt(u.amountHastings), 0n) - immatureTotal;

  const bySource = {};
  for (const u of allUtxos) {
    if (!bySource[u.source]) bySource[u.source] = { count: 0, total: 0n };
    bySource[u.source].count++;
    bySource[u.source].total += BigInt(u.amountHastings);
  }

  let maxRecv = { amount: '0', amountHastings: '0' };
  let maxSent = { amount: '0', amountHastings: '0' };
  for (const u of allUtxos) {
    if (u.direction === 'received' && BigInt(u.amountHastings) > BigInt(maxRecv.amountHastings)) maxRecv = u;
    if (u.direction === 'sent' && BigInt(u.amountHastings) > BigInt(maxSent.amountHastings)) maxSent = u;
  }

  const hostSources = ['renewal_final_host', 'storageproof_host', 'expiration_host'];
  const renterSources = ['renewal_final_renter', 'storageproof_renter', 'expiration_renter'];
  const hostCount = allUtxos.filter(u => hostSources.includes(u.source)).length;
  const renterCount = allUtxos.filter(u => renterSources.includes(u.source)).length;
  let role = 'Wallet';
  if (hostCount > 0 && hostCount > renterCount) role = 'Host';
  else if (renterCount > 0) role = 'Renter';

  const renewals = allUtxos.filter(u => u.source.startsWith('renewal_')).length;
  const proofs = allUtxos.filter(u => u.source.startsWith('storageproof_')).length;
  const expirations = allUtxos.filter(u => u.source.startsWith('expiration_')).length;

  const sc = (hastings) => {
    const n = Number(hastings / 100000000000000000000n);
    return (n / 10000).toFixed(4) + ' SC';
  };
  const row = (label, value, color) =>
    '<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #1a1a1a;">' +
    '<span style="color:#888;">' + _esc(label) + '</span>' +
    '<span style="color:' + (color || '#e0e0e0') + ';">' + _esc(value) + '</span></div>';

  let html = '';

  // Role badge
  const roleColor = role === 'Host' ? '#f59e0b' : role === 'Renter' ? '#a78bfa' : '#10b981';
  html += '<div style="margin-bottom:0.75rem;"><span style="background:' + roleColor + '22; color:' + roleColor + '; padding:3px 10px; border-radius:4px; font-size:0.85rem; border:1px solid ' + roleColor + '44;">' + role + '</span></div>';

  // Balance breakdown
  html += '<div style="margin-bottom:0.75rem; font-size:0.85rem; color:#888; font-weight:bold;">Balance</div>';
  html += row('Spendable (mature)', sc(matureTotal), '#4ade80');
  if (immatureTotal > 0n) {
    html += row('Immature (' + immature.length + ' outputs, matures in ' + MATURITY_DELAY + ' blocks)', sc(immatureTotal), '#f59e0b');
  }
  html += row('UTXO count', unspent.length.toLocaleString());
  html += row('Total received', result.totalReceivedSC, '#4ade80');
  html += row('Total sent', result.totalSentSC, '#f87171');

  // Activity
  html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">Activity</div>';
  const uniqueTxns = new Set(allUtxos.map(u => u.txid).filter(Boolean));
  html += row('Addresses scanned', result.addressesScanned.toLocaleString());
  html += row('Addresses with activity', result.addressesWithActivity.toLocaleString());
  html += row('Transactions', uniqueTxns.size.toLocaleString());
  html += row('First active', '<span class="wallet-height-link" data-height="' + firstHeight + '" style="color:#60a5fa; cursor:pointer; text-decoration:underline;">' + firstHeight.toLocaleString() + '</span>');
  html += row('Last active', '<span class="wallet-height-link" data-height="' + tipHeight + '" style="color:#60a5fa; cursor:pointer; text-decoration:underline;">' + tipHeight.toLocaleString() + '</span>');
  html += row('Span', (tipHeight - firstHeight).toLocaleString() + ' blocks');
  html += row('Largest inflow', maxRecv.amount, '#4ade80');
  html += row('Largest outflow', maxSent.amount, '#f87171');

  // Contract activity
  if (renewals + proofs + expirations > 0) {
    html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">Contracts</div>';
    if (renewals > 0) html += row('Renewals', renewals.toLocaleString());
    if (proofs > 0) html += row('Storage proofs', proofs.toLocaleString());
    if (expirations > 0) html += row('Expirations', expirations.toLocaleString());
  }

  // Source breakdown
  html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">By Source</div>';
  const sourceOrder = Object.keys(bySource).sort((a, b) => bySource[b].count - bySource[a].count);
  for (const src of sourceOrder) {
    const s = bySource[src];
    html += row(src.replace(/_/g, ' '), s.count + ' events / ' + sc(s.total));
  }

  el.innerHTML = html;
}

// --- Wallet JSON export (mirrors explorer) ---
function walletSaveResultAsJson() {
  if (!_lastWalletScanResult) return;
  const data = {
    network: getActiveNetwork(),
    exportedAt: new Date().toISOString(),
    ..._lastWalletScanResult,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sia-wallet-scan.json';
  a.click();
  URL.revokeObjectURL(url);
}

// --- Mempool overlay for wallet ---
// Build a map of ALL wallet addresses (including inactive ones beyond scan results)
function _buildWalletAddrMap() {
  const walletAddrs = new Map(); // address string -> { index, address }
  // Include addresses from scan results
  for (const a of (_lastWalletScanResult?.addresses || [])) {
    walletAddrs.set(a.address, a);
  }
  // Derive all scanned addresses so we can detect pending outputs to fresh addresses
  if (_walletEntropy && _lastWalletScanResult) {
    try {
      const count = _lastWalletScanResult.addressesScanned || 0;
      if (count > 0) {
        const derived = JSON.parse(derive_addresses(_walletEntropy, 0, count));
        for (const d of derived) {
          if (!walletAddrs.has(d.address)) {
            walletAddrs.set(d.address, { index: d.index, address: d.address });
          }
        }
      }
    } catch (e) { console.warn('derive_addresses failed:', e); }
  }
  return walletAddrs;
}

function walletApplyMempool() {
  if (!_lastWalletScanResult) return;

  // Remove any previous mempool rows before re-applying
  const histBody = document.getElementById('wallet-history-body');
  histBody.querySelectorAll('tr[data-mempool]').forEach(r => r.remove());

  // Reset balance and meta to confirmed values
  const confirmedBalance = BigInt(_lastWalletScanResult.totalBalance || '0');
  document.getElementById('wallet-balance-value').textContent = _formatSC(confirmedBalance);
  const baseMeta = _lastWalletScanResult.addressesScanned + ' addresses scanned, ' +
    _lastWalletScanResult.addressesWithActivity + ' with activity (gap limit: ' + _lastWalletScanResult.gapLimit + ')';
  document.getElementById('wallet-scan-meta').textContent = baseMeta;

  const net = getActiveNetwork();
  const pool = getMempool(net);
  const txns = Object.values(pool);
  if (txns.length === 0) return;

  const walletAddrs = _buildWalletAddrMap();

  let pendingReceived = 0n;
  let pendingSent = 0n;
  let pendingCount = 0;

  for (const txn of txns) {
    // Check inputs (sends from our wallet)
    for (const inp of (txn.inputs || [])) {
      if (walletAddrs.has(inp.address)) {
        const val = BigInt(inp.value || '0');
        pendingSent += val;
        const addrInfo = walletAddrs.get(inp.address);
        _appendMempoolRow(histBody, 'pending', addrInfo.index, '-', _formatSC(val), txn.id, 'unconfirmed', inp.address);
        pendingCount++;
      }
    }

    // Check outputs (receives to our wallet)
    for (const out of (txn.outputs || [])) {
      if (walletAddrs.has(out.address)) {
        const val = BigInt(out.value || '0');
        pendingReceived += val;
        const addrInfo = walletAddrs.get(out.address);
        _appendMempoolRow(histBody, 'pending', addrInfo.index, '+', _formatSC(val), txn.id, 'unconfirmed', out.address);
        pendingCount++;
      }
    }
  }

  // Update balance display with pending amounts
  if (pendingCount > 0) {
    const pendingBalance = confirmedBalance + pendingReceived - pendingSent;
    document.getElementById('wallet-balance-value').textContent = _formatSC(pendingBalance >= 0n ? pendingBalance : 0n);
    document.getElementById('wallet-scan-meta').textContent = baseMeta + ' | ' + pendingCount + ' pending';
  }
}

function _appendMempoolRow(tbody, height, addrIndex, dir, amount, txid, source, address) {
  const tr = document.createElement('tr');
  tr.dataset.mempool = '1';
  tr.style.borderBottom = '1px solid #1a1a1a';
  tr.style.opacity = '0.6';
  const isRecv = dir === '+';

  const tdHeight = document.createElement('td');
  tdHeight.style.cssText = 'padding:5px 8px; color:#f59e0b;';
  tdHeight.textContent = '\u23f3'; // hourglass
  tdHeight.title = 'Unconfirmed (in mempool)';

  const tdAddr = document.createElement('td');
  tdAddr.style.cssText = 'padding:5px 8px; font-size:0.75rem;';
  const addrLink = document.createElement('span');
  addrLink.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
  addrLink.textContent = '#' + addrIndex;
  addrLink.title = address;
  addrLink.className = 'addr-link';
  addrLink.dataset.addr = address;
  tdAddr.appendChild(addrLink);

  const tdDir = document.createElement('td');
  tdDir.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
  tdDir.textContent = dir;

  const tdAmt = document.createElement('td');
  tdAmt.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
  tdAmt.textContent = amount;

  const tdTxid = document.createElement('td');
  tdTxid.style.padding = '5px 8px';
  const link = document.createElement('span');
  link.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline; font-size:0.75rem;';
  link.textContent = walletTruncate(txid);
  link.title = txid;
  link.className = 'wallet-tx-link';
  link.dataset.txid = txid;
  tdTxid.appendChild(link);

  const tdSrc = document.createElement('td');
  tdSrc.style.cssText = 'padding:5px 8px; color:#f59e0b; font-size:0.75rem;';
  tdSrc.textContent = source;

  tr.append(tdHeight, tdAddr, tdDir, tdAmt, tdTxid, tdSrc);
  // Insert at top of table
  if (tbody.firstChild) {
    tbody.insertBefore(tr, tbody.firstChild);
  } else {
    tbody.appendChild(tr);
  }
}

function _formatSC(hastings) {
  if (typeof hastings === 'bigint') {
    const s = hastings.toString();
    if (s.length <= 24) {
      const decimal = s.padStart(24, '0');
      return '0.' + decimal.slice(0, 4) + ' SC';
    }
    const whole = s.slice(0, s.length - 24);
    const frac = s.slice(s.length - 24, s.length - 20);
    return whole + '.' + frac + ' SC';
  }
  return hastings + ' SC';
}

// Subscribe to mempool changes — update wallet display in real time
onMempoolChange((net, pool) => {
  if (net === getActiveNetwork() && _lastWalletScanResult) {
    // Re-render: reset to confirmed state, then overlay mempool
    const allUtxos = [];
    for (const a of (_lastWalletScanResult.addresses || [])) {
      for (const u of (a.utxos || [])) {
        allUtxos.push({ ...u, _addrIndex: a.index, _address: a.address });
      }
    }
    allUtxos.sort((a, b) => (b.height || 0) - (a.height || 0));
    walletPopulateHistoryTable(allUtxos);
    document.getElementById('wallet-balance-value').textContent = _lastWalletScanResult.totalBalanceSC;
    document.getElementById('wallet-received').textContent = '+' + _lastWalletScanResult.totalReceivedSC + ' received';
    document.getElementById('wallet-sent').textContent = '-' + _lastWalletScanResult.totalSentSC + ' sent';
    document.getElementById('wallet-scan-meta').textContent =
      _lastWalletScanResult.addressesScanned + ' addresses scanned, ' +
      _lastWalletScanResult.addressesWithActivity + ' with activity (gap limit: ' + _lastWalletScanResult.gapLimit + ')';
    walletApplyMempool();
    txbRefreshFromMempool();
  }
});

// --- SC/Hastings conversion ---
const SC_HASTINGS = 1000000000000000000000000n; // 10^24

function hastingsToSC(hastingsStr) {
  if (!hastingsStr) return '0';
  const h = BigInt(hastingsStr);
  const whole = h / SC_HASTINGS;
  const frac = h % SC_HASTINGS;
  if (frac === 0n) return whole.toString();
  const fracStr = (frac * 10000n / SC_HASTINGS).toString().padStart(4, '0');
  return `${whole}.${fracStr}`;
}

// --- Transaction Builder ---
function scToHastings(sc) {
  const s = sc.trim();
  if (!s || s === '0') return '0';
  const parts = s.split('.');
  const whole = parts[0] || '0';
  let frac = parts[1] || '';
  if (frac.length > 24) frac = frac.slice(0, 24);
  frac = frac.padEnd(24, '0');
  const result = BigInt(whole) * SC_HASTINGS + BigInt(frac);
  return result.toString();
}

function txbFormatSC(hastingsStr) {
  return hastingsToSC(hastingsStr) + ' SC';
}

let _txbUtxos = []; // current unspent UTXOs available for selection
let _txbBaseUtxos = []; // base UTXOs from wallet scan (before mempool adjustments)
let _utxoProofs = {}; // outputId -> { leafIndex, merkleProof }

function txbPopulateUtxos(allUtxos) {
  // Store base UTXOs for mempool-aware refresh
  const suxiIds3 = _lastWalletScanResult?.unspentOutputIds;
  if (suxiIds3) {
    const suxiSet3 = new Set(suxiIds3);
    _txbBaseUtxos = allUtxos.filter(u => u.direction === 'received' && u.outputId && suxiSet3.has(u.outputId));
  } else {
    const spentIds = new Set();
    for (const u of allUtxos) {
      if (u.direction === 'sent' && u.outputId) spentIds.add(u.outputId);
    }
    _txbBaseUtxos = allUtxos.filter(u => u.direction === 'received' && u.outputId && !spentIds.has(u.outputId));
  }

  // Reset proofs
  _utxoProofs = {};
  const proofSection = document.getElementById('txb-proof-section');
  if (proofSection) {
    document.getElementById('txb-proof-status').textContent = 'Merkle proofs not computed.';
    document.getElementById('txb-proof-status').style.color = '#888';
  }

  txbRenderUtxoList(_txbBaseUtxos);
}

// Refresh the transaction builder's UTXO list to account for mempool state.
// Removes UTXOs spent by mempool txns, adds pending outputs to wallet addresses.
function txbRefreshFromMempool() {
  if (!_lastWalletScanResult) return;

  const net = getActiveNetwork();
  const pool = getMempool(net);
  const txns = Object.values(pool);

  if (txns.length === 0) {
    txbRenderUtxoList(_txbBaseUtxos);
    return;
  }

  const walletAddrs = _buildWalletAddrMap();

  // Collect all output IDs spent by mempool transactions
  const mempoolSpentIds = new Set();
  for (const txn of txns) {
    for (const inp of (txn.inputs || [])) {
      if (inp.outputId) mempoolSpentIds.add(inp.outputId);
    }
  }

  // Filter base UTXOs: remove any spent by mempool
  const available = _txbBaseUtxos.filter(u => !mempoolSpentIds.has(u.outputId));

  // Add pending outputs from mempool that go to our wallet
  for (const txn of txns) {
    const outputs = txn.outputs || [];
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i];
      if (walletAddrs.has(out.address)) {
        const addrInfo = walletAddrs.get(out.address);
        available.push({
          outputId: txn.id ? v2_output_id(txn.id, i) : '',
          txid: txn.id || '',
          amountHastings: out.value || '0',
          amount: _formatSC(BigInt(out.value || '0')),
          height: 0,
          direction: 'received',
          source: 'pending',
          _addrIndex: addrInfo.index,
          _address: addrInfo.address,
          _pending: true,
        });
      }
    }
  }

  txbRenderUtxoList(available);
}

function txbRenderUtxoList(utxos) {
  const list = document.getElementById('txb-utxo-list');
  list.innerHTML = '';
  _txbUtxos = utxos;

  const proofSection = document.getElementById('txb-proof-section');
  if (proofSection) {
    proofSection.style.display = _txbUtxos.length > 0 ? '' : 'none';
  }

  if (_txbUtxos.length === 0) {
    list.innerHTML = '<div style="padding:0.75rem; color:#666; font-size:0.8rem; text-align:center;">No unspent outputs found.</div>';
    txbUpdateSummary();
    return;
  }

  for (let i = 0; i < _txbUtxos.length; i++) {
    const u = _txbUtxos[i];
    const item = document.createElement('div');
    item.className = 'txb-utxo-item';
    item.dataset.index = i;
    if (u._pending) item.style.opacity = '0.6';

    const left = document.createElement('div');
    left.className = 'utxo-left';

    const idx = document.createElement('span');
    idx.className = 'utxo-idx';
    idx.textContent = '#' + (u._addrIndex != null ? u._addrIndex : '?');

    const addr = document.createElement('span');
    addr.className = 'utxo-addr';
    const txidStr = u.txid || u.outputId || '';
    addr.textContent = txidStr.slice(0, 12) + '...' + txidStr.slice(-8);
    addr.title = txidStr;

    left.append(idx, addr);

    const meta = document.createElement('span');
    meta.className = 'utxo-meta';
    meta.textContent = u._pending ? 'pending' : (u.source || '');
    if (u._pending) meta.style.color = '#f59e0b';

    const val = document.createElement('span');
    val.className = 'utxo-val';
    val.textContent = u.amount;

    item.append(left, meta, val);

    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      txbUpdateSummary();
    });

    list.appendChild(item);
  }

  txbUpdateSummary();
}

async function txbComputeProofs() {
  const statusEl = document.getElementById('txb-proof-status');
  const btn = document.getElementById('txb-btn-compute-proofs');

  if (_txbUtxos.length === 0) {
    statusEl.textContent = 'No UTXOs to compute proofs for.';
    statusEl.style.color = '#f87171';
    return;
  }

  const net = getActiveNetwork();
  const config = getNetworkConfig(net);
  if (!config.peerUrl) {
    statusEl.textContent = 'No peer URL configured.';
    statusEl.style.color = '#f87171';
    return;
  }

  const genesisHex = getGenesisHex();
  const certHash = config.certHash || undefined;

  // Build UTXO list for the WASM function (skip pending — they use unassigned leaf index)
  const utxoList = _txbUtxos.filter(u => !u._pending).map(u => ({
    outputId: u.outputId,
    amountHastings: u.amountHastings,
    maturityHeight: u.maturityHeight || 0,
    addressIndex: u._addrIndex || 0,
    height: u.height || 0,
  }));

  btn.disabled = true;
  statusEl.textContent = 'Computing merkle proofs...';
  statusEl.style.color = '#f59e0b';

  try {
    const resultJson = await compute_utxo_proofs(
      JSON.stringify(utxoList),
      config.peerUrl,
      genesisHex,
      (msg, cls) => {
        statusEl.textContent = msg;
        statusEl.style.color = cls === 'err' ? '#f87171' : cls === 'ok' ? '#4ade80' : '#f59e0b';
      },
      certHash
    );

    const proofs = JSON.parse(resultJson);
    _utxoProofs = {};
    for (const p of proofs) {
      _utxoProofs[p.outputId] = {
        leafIndex: p.leafIndex,
        merkleProof: p.merkleProof,
      };
    }
    // Auto-assign unassigned leaf index for pending (mempool) UTXOs
    for (const u of _txbUtxos) {
      if (u._pending && !_utxoProofs[u.outputId]) {
        _utxoProofs[u.outputId] = {
          leafIndex: '10101010101010101010',
          merkleProof: [],
        };
      }
    }

    const found = Object.keys(_utxoProofs).length;
    const total = _txbUtxos.length;
    statusEl.textContent = `Proofs computed: ${found}/${total} UTXOs proven.`;
    statusEl.style.color = found >= total ? '#4ade80' : (found > 0 ? '#f59e0b' : '#f87171');
  } catch (e) {
    console.error('[compute-proofs]', e);
    statusEl.textContent = 'Error: ' + (e.message || e);
    statusEl.style.color = '#f87171';
  } finally {
    btn.disabled = false;
  }
}

function txbUpdateSummary() {
  const selected = document.querySelectorAll('.txb-utxo-item.selected');
  let total = 0n;
  for (const el of selected) {
    const u = _txbUtxos[parseInt(el.dataset.index, 10)];
    if (u) total += BigInt(u.amountHastings);
  }
  document.getElementById('txb-selected-summary').textContent =
    selected.length + ' selected · ' + txbFormatSC(total.toString());
  txbUpdateBalanceSummary();
}

function txbAddOutputRow() {
  const container = document.getElementById('txb-outputs');
  const row = document.createElement('div');
  row.className = 'txb-output-row';

  const addrInput = document.createElement('input');
  addrInput.type = 'text';
  addrInput.placeholder = 'Recipient address';
  addrInput.className = 'txb-output-addr';

  const amtInput = document.createElement('input');
  amtInput.type = 'text';
  amtInput.placeholder = '0';
  amtInput.className = 'txb-output-amount';
  amtInput.addEventListener('input', txbUpdateBalanceSummary);

  const scLabel = document.createElement('span');
  scLabel.style.cssText = 'color:#666; font-size:0.75rem;';
  scLabel.textContent = 'SC';

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '×';
  removeBtn.style.cssText = 'padding:0.2rem 0.5rem; font-size:0.85rem; color:#f87171; cursor:pointer;';
  removeBtn.addEventListener('click', () => {
    row.remove();
    txbUpdateBalanceSummary();
  });

  row.append(addrInput, amtInput, scLabel, removeBtn);
  // Insert before change row so it stays last
  const changeRow = container.querySelector('.txb-change-row');
  if (changeRow) {
    container.insertBefore(row, changeRow);
  } else {
    container.appendChild(row);
  }
}

function txbAddChangeRow() {
  if (!_walletEntropy) {
    document.getElementById('txb-status').style.color = '#f87171';
    document.getElementById('txb-status').textContent = 'Wallet is locked.';
    return;
  }

  // Only one change row allowed
  if (document.querySelector('.txb-output-row.txb-change-row')) return;

  // Find the next unused address index
  let nextIndex = 0;
  if (_lastWalletScanResult) {
    for (const a of (_lastWalletScanResult.addresses || [])) {
      if (a.index >= nextIndex) nextIndex = a.index + 1;
    }
  }

  // Derive the address
  let changeAddr;
  try {
    const json = derive_addresses(_walletEntropy, nextIndex, 1);
    const addrs = JSON.parse(json);
    changeAddr = addrs[0].address;
  } catch (e) {
    document.getElementById('txb-status').style.color = '#f87171';
    document.getElementById('txb-status').textContent = 'Failed to derive change address: ' + e;
    return;
  }

  const container = document.getElementById('txb-outputs');
  const row = document.createElement('div');
  row.className = 'txb-output-row txb-change-row';

  const addrInput = document.createElement('input');
  addrInput.type = 'text';
  addrInput.className = 'txb-output-addr';
  addrInput.value = changeAddr;
  addrInput.style.color = '#10b981';

  const changeLabel = document.createElement('span');
  changeLabel.style.cssText = 'color:#10b981; font-size:0.7rem; font-weight:600;';
  changeLabel.textContent = 'CHANGE';

  const amtInput = document.createElement('input');
  amtInput.type = 'text';
  amtInput.className = 'txb-output-amount';
  amtInput.readOnly = true;
  amtInput.style.color = '#10b981';

  const scLabel = document.createElement('span');
  scLabel.style.cssText = 'color:#666; font-size:0.75rem;';
  scLabel.textContent = 'SC';

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '×';
  removeBtn.style.cssText = 'padding:0.2rem 0.5rem; font-size:0.85rem; color:#f87171; cursor:pointer;';
  removeBtn.addEventListener('click', () => { row.remove(); txbUpdateBalanceSummary(); });

  row.append(addrInput, changeLabel, amtInput, scLabel, removeBtn);
  container.appendChild(row);
  txbUpdateBalanceSummary();
}

function txbUpdateBalanceSummary() {
  const summaryEl = document.getElementById('txb-balance-summary');

  // Total inputs
  const selected = document.querySelectorAll('.txb-utxo-item.selected');
  let totalIn = 0n;
  for (const el of selected) {
    const u = _txbUtxos[parseInt(el.dataset.index, 10)];
    if (u) totalIn += BigInt(u.amountHastings);
  }

  // Total outputs (excluding change row)
  let totalOut = 0n;
  const outputRows = document.querySelectorAll('.txb-output-row:not(.txb-change-row)');
  for (const row of outputRows) {
    const amtStr = row.querySelector('.txb-output-amount').value.trim();
    if (amtStr) {
      try { totalOut += BigInt(scToHastings(amtStr)); } catch (_) { /* skip */ }
    }
  }

  // Fee
  let fee = 0n;
  const feeStr = document.getElementById('txb-miner-fee').value.trim();
  if (feeStr) {
    try { fee = BigInt(scToHastings(feeStr)); } catch (_) { /* skip */ }
  }

  const allOutputRows = document.querySelectorAll('.txb-output-row');
  if (selected.length === 0 && allOutputRows.length === 0) {
    summaryEl.style.display = 'none';
    return;
  }

  const totalSpend = totalOut + fee;
  const change = totalIn >= totalSpend ? totalIn - totalSpend : 0n;
  const deficit = totalIn < totalSpend;

  // Auto-update change row amount
  const changeRow = document.querySelector('.txb-change-row');
  if (changeRow) {
    const changeAmt = changeRow.querySelector('.txb-output-amount');
    changeAmt.value = deficit ? '0' : hastingsToSC(change.toString());
    // Keep change row last
    const container = document.getElementById('txb-outputs');
    if (changeRow !== container.lastElementChild) {
      container.appendChild(changeRow);
    }
  }

  summaryEl.style.display = '';
  summaryEl.innerHTML =
    '<div style="display:flex; justify-content:space-between;"><span style="color:#888;">Total In:</span><span style="color:#4ade80;">' + _esc(txbFormatSC(totalIn.toString())) + '</span></div>' +
    '<div style="display:flex; justify-content:space-between;"><span style="color:#888;">Total Out:</span><span>' + _esc(txbFormatSC(totalOut.toString())) + '</span></div>' +
    '<div style="display:flex; justify-content:space-between;"><span style="color:#888;">Fee:</span><span>' + _esc(txbFormatSC(fee.toString())) + '</span></div>' +
    '<div style="display:flex; justify-content:space-between; border-top:1px solid #2a2a2a; margin-top:4px; padding-top:4px;"><span style="color:#888;">Change:</span><span style="color:' + (deficit ? '#f87171' : '#10b981') + ';">' +
    (deficit ? 'Insufficient funds (' + _esc(txbFormatSC((totalSpend - totalIn).toString())) + ' short)' : _esc(txbFormatSC(change.toString()))) + '</span></div>';
}

async function txbBuildTransaction() {
  const statusEl = document.getElementById('txb-status');
  const resultEl = document.getElementById('txb-result');
  resultEl.style.display = 'none';

  if (!_walletEntropy) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Wallet is locked.';
    return;
  }

  // Collect selected UTXOs
  const selected = document.querySelectorAll('.txb-utxo-item.selected');
  if (selected.length === 0) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Select at least one UTXO input.';
    return;
  }

  const inputs = [];
  let missingProofs = 0;
  for (const el of selected) {
    const u = _txbUtxos[parseInt(el.dataset.index, 10)];
    const proof = _utxoProofs[u.outputId];
    if (!proof) missingProofs++;
    inputs.push({
      id: u.outputId,
      value: u.amountHastings,
      maturityHeight: u.maturityHeight || 0,
      leafIndex: proof ? proof.leafIndex : 0,
      merkleProof: proof ? proof.merkleProof : [],
      addressIndex: u._addrIndex,
    });
  }
  if (missingProofs > 0) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = `${missingProofs} selected UTXO(s) missing merkle proofs. Click "Compute Proofs" first.`;
    return;
  }

  // Collect outputs
  const outputRows = document.querySelectorAll('.txb-output-row');
  if (outputRows.length === 0) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Add at least one output.';
    return;
  }

  const outputs = [];
  for (const row of outputRows) {
    const addr = row.querySelector('.txb-output-addr').value.trim();
    const amtSC = row.querySelector('.txb-output-amount').value.trim();
    if (!addr || !amtSC) {
      statusEl.style.color = '#f87171';
      statusEl.textContent = 'Fill in all output addresses and amounts.';
      return;
    }
    outputs.push({ address: addr, value: scToHastings(amtSC) });
  }

  // Fee
  const feeSC = document.getElementById('txb-miner-fee').value.trim() || '0';
  const feeHastings = scToHastings(feeSC);

  try {
    statusEl.style.color = '#888';
    statusEl.textContent = 'Building and signing...';

    // Pass a dummy change address — change should already be in outputs via "Add Change"
    // The WASM function only adds a change output if inputs > outputs + fee
    // Build attestation JSON if enabled (must be included before signing)
    const attEnabled = document.getElementById('txb-att-private').checked;
    let attestationsJson = undefined;
    if (attEnabled) {
      const attUrl = document.getElementById('txb-att-url').value.trim();
      if (!attUrl) {
        statusEl.style.color = '#f87171';
        statusEl.textContent = 'Attestation enabled but no manifest URL provided.';
        return;
      }
      const network = (() => {
        const net = getActiveNetwork();
        if (net === 'mainnet' || net === 'mainnet_v2') return 'mainnet';
        if (net === 'zen') return 'zen';
        return 'mainnet';
      })();
      const attAccount = parseInt(document.getElementById('txb-att-account', 10).value) || 0;
      // Find next unused manifest index by scanning the attestation index
      const attIndex = await mfstFindNextIndex(attAccount);
      const attTxnJson = build_private_manifest_transaction(_walletEntropy, attAccount, attIndex, attUrl, '0', network);
      const attTxn = JSON.parse(attTxnJson);
      attestationsJson = JSON.stringify(attTxn.attestations);
    }

    const txnJson = build_v2_transaction(
      _walletEntropy,
      0, // account
      JSON.stringify(inputs),
      JSON.stringify(outputs),
      feeHastings,
      'addr:0000000000000000000000000000000000000000000000000000000000000000000000000000',
      attestationsJson
    );

    const txnObj = JSON.parse(txnJson);
    document.getElementById('txb-txn-json').textContent = txnJson;
    document.getElementById('txb-txn-json').style.display = 'none';

    // Render explorer-style transaction card
    const cardContainer = document.getElementById('txb-txn-card');
    cardContainer.innerHTML = '';
    const card = buildTransactionCard(txnObj, 0, true);
    cardContainer.appendChild(card);

    resultEl.style.display = '';
    statusEl.style.color = '#4ade80';
    statusEl.textContent = attestationsJson
      ? 'Transaction built with private manifest attestation.'
      : 'Transaction built and signed successfully.';
  } catch (e) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Build error: ' + e;
  }
}

async function txbBroadcastTransaction() {
  const statusEl = document.getElementById('txb-status');
  const txnJson = document.getElementById('txb-txn-json').textContent;
  if (!txnJson) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'No transaction to broadcast. Build one first.';
    return;
  }

  const net = getActiveNetwork();
  const config = getNetworkConfig(net);
  if (!config.peerUrl) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'No peer URL configured. Set it in the Syncer page.';
    return;
  }

  const genesisHex = getGenesisHex(net);
  const certHash = config.certHash || undefined;

  try {
    statusEl.style.color = '#888';
    statusEl.textContent = 'Broadcasting transaction to peer...';

    const btn = document.getElementById('txb-btn-broadcast');
    btn.disabled = true;
    btn.textContent = 'Broadcasting...';

    // Build transaction set: parent transactions first, then the primary
    const builtTxn = JSON.parse(txnJson);
    const txnSet = [];
    const mempoolTxns = getMempoolTransactions(net);
    const mempoolById = {};
    for (const mt of mempoolTxns) {
      if (mt.rawJson) mempoolById[mt.id] = mt.rawJson;
    }
    // Find parent transactions for any inputs with UnassignedLeafIndex
    // (10101010101010101010 loses precision in JS → ~1.01e19, check empty proof instead)
    const seen = new Set();
    for (const inp of (builtTxn.siacoinInputs || [])) {
      const se = inp.parent?.stateElement;
      const isUnassigned = se && Array.isArray(se.merkleProof) && se.merkleProof.length === 0;
      if (isUnassigned) {
        // Find which mempool transaction created this output
        const parentId = inp.parent?.id;
        if (parentId) {
          for (const mt of mempoolTxns) {
            if (seen.has(mt.id)) continue;
            // Check if this mempool txn created the output we're spending
            const rawJson = mt.rawJson;
            if (!rawJson) continue;
            const parentTxn = JSON.parse(rawJson);
            const parentTxid = mt.id;
            const outputs = parentTxn.siacoinOutputs || [];
            for (let oi = 0; oi < outputs.length; oi++) {
              const expectedId = v2_output_id(parentTxid, oi);
              if (expectedId === parentId) {
                txnSet.push(parentTxn);
                seen.add(mt.id);
                break;
              }
            }
          }
        }
      }
    }
    txnSet.push(builtTxn);

    const txid = await broadcast_v2_transaction(
      config.peerUrl,
      genesisHex,
      JSON.stringify(txnSet),
      certHash
    );

    // Add to mempool immediately after successful broadcast
    try {
      const inputs = (builtTxn.siacoinInputs || []).map(inp => ({
        address: inp.parent?.siacoinOutput?.address || '',
        value: inp.parent?.siacoinOutput?.value || '0',
        outputId: inp.parent?.id || '',
      }));
      const outputs = (builtTxn.siacoinOutputs || []).map((out, i) => ({
        address: out.address || '',
        value: out.value || '0',
        outputId: '',
      }));
      const minerFee = builtTxn.minerFee || '0';
      addToMempool(net, [{
        id: txid,
        inputs,
        outputs,
        minerFee,
        attestations: builtTxn.attestations || [],
        rawJson: txnJson,
      }], 0, '');
      walletApplyMempool();
      txbRefreshFromMempool();
    } catch (e2) { console.warn('mempool add failed:', e2); }

    statusEl.style.color = '#4ade80';
    const short = txid.slice(0, 12) + '...' + txid.slice(-8);
    statusEl.textContent = '';
    statusEl.appendChild(document.createTextNode('Transaction accepted by peer. TxID: '));
    const txidSpan = document.createElement('span');
    txidSpan.style.cssText = 'font-family:var(--font-mono); color:#60a5fa; cursor:pointer; text-decoration:underline;';
    txidSpan.textContent = short;
    txidSpan.title = 'Click to view in Explorer';
    txidSpan.addEventListener('click', () => {
      openOrActivateInternalTab('explorer');
      setTimeout(() => {
        // Try explorer lookup first (works for confirmed txns)
        document.getElementById('exp-query').value = txid;
        explorerQuery();
      }, 150);
    });
    statusEl.appendChild(txidSpan);
    btn.textContent = 'Broadcast Transaction';
    btn.disabled = false;

    // Reset transaction builder after successful broadcast
    document.getElementById('txb-outputs').innerHTML = '';
    document.getElementById('txb-txn-json').textContent = '';
    document.getElementById('txb-txn-json').style.display = 'none';
    document.querySelectorAll('.txb-utxo-item.selected').forEach(el => el.classList.remove('selected'));
    document.getElementById('txb-selected-summary').textContent = '0 selected · 0 SC';
    txbUpdateBalanceSummary();
  } catch (e) {
    statusEl.style.color = '#f87171';
    const errStr = String(e);
    if (errStr.includes('ephemeral') || errStr.includes('Merkle proof')) {
      statusEl.textContent = 'Broadcast error: ' + errStr + ' — a pending input may have confirmed. Rescan wallet to get fresh proofs.';
    } else {
      statusEl.textContent = 'Broadcast error: ' + errStr;
    }
    const btn = document.getElementById('txb-btn-broadcast');
    btn.textContent = 'Broadcast Transaction';
    btn.disabled = false;
  }
}

let _walletScanWorker = null;

async function walletScanUtxos() {
  if (!_walletEntropy) { walletLog('Unlock wallet first.', 'err'); return; }

  const net = getActiveNetwork();
  const account = parseInt(document.getElementById('wallet-account', 10).value) || 0;

  // Wait for any active sync to complete so filters are fresh
  const syncState = getSyncState(net);
  if (syncState && syncState.status === 'syncing') {
    walletScanLog('Waiting for background sync to finish...', 'info');
    await new Promise(resolve => {
      const unsub = chainOnChange(() => {
        const s = getSyncState(net);
        if (!s || s.status !== 'syncing') { unsub(); resolve(); }
      });
      // Timeout after 60s — don't block forever
      setTimeout(() => { unsub(); resolve(); }, 60000);
    });
    walletScanLog('Sync complete, starting wallet scan.', 'info');
  }

  const filterUrl = getFilterUrl();
  if (!filterUrl) {
    walletScanLog('No filters loaded for ' + net + '. Sync filters first in the Syncer page.', 'err');
    return;
  }

  const config = getNetworkConfig(net);
  if (!config.peerUrl) {
    walletScanLog('No peer URL configured for ' + net + '. Set it in the Syncer page.', 'err');
    return;
  }

  const genesisHex = getGenesisHex(net);
  const certHash = config.certHash || undefined;

  // Reset UI
  document.getElementById('wallet-balance-box').style.display = 'none';
  document.getElementById('wallet-scan-stats').style.display = 'none';
  document.getElementById('wallet-tab-wrap').style.display = 'none';
  document.getElementById('wallet-history-body').innerHTML = '';
  document.getElementById('wallet-utxo-body').innerHTML = '';
  document.getElementById('wallet-tab-stats').innerHTML = '';
  walletScanLog('Scanning wallet UTXOs on ' + net + ' (account ' + account + ')...', 'info');
  document.getElementById('wallet-scan-log').scrollIntoView({ behavior: 'smooth' });

  const startTime = performance.now();

  try {
    const utxoIndexUrl = getUtxoIndexUrl();

    // Run scan in a Web Worker to avoid blocking the main thread
    const resultJson = await new Promise((resolve, reject) => {
      if (_walletScanWorker) { _walletScanWorker.terminate(); }
      const worker = new Worker('./wallet-scan-worker.js', { type: 'module' });
      _walletScanWorker = worker;

      worker.onmessage = (e) => {
        switch (e.data.type) {
          case 'ready':
            worker.postMessage({
              type: 'scan',
              entropyHex: _walletEntropy,
              account,
              peerUrl: config.peerUrl,
              genesisHex,
              filterUrl,
              utxoIndexUrl: utxoIndexUrl || undefined,
              certHash: certHash || undefined,
            });
            break;
          case 'log':
            walletScanLog(e.data.msg, e.data.cls);
            break;
          case 'result':
            worker.terminate();
            _walletScanWorker = null;
            resolve(e.data.resultJson);
            break;
          case 'error':
            worker.terminate();
            _walletScanWorker = null;
            reject(new Error(e.data.error));
            break;
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        _walletScanWorker = null;
        reject(new Error(err.message));
      };
      worker.postMessage({ type: 'init', wasmUrl: './pkg/syncer_wasm_bg.wasm' });
    });

    const result = JSON.parse(resultJson);
    _lastWalletScanResult = result;

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    // Balance box
    document.getElementById('wallet-balance-value').textContent = result.totalBalanceSC;
    document.getElementById('wallet-received').textContent = '+' + result.totalReceivedSC + ' received';
    document.getElementById('wallet-sent').textContent = '-' + result.totalSentSC + ' sent';
    document.getElementById('wallet-scan-meta').textContent =
      result.addressesScanned + ' addresses scanned, ' +
      result.addressesWithActivity + ' with activity (gap limit: ' + result.gapLimit + ')';
    document.getElementById('wallet-balance-box').style.display = '';

    // Aggregate all utxos across addresses, annotated with address info
    const allUtxos = [];
    for (const a of (result.addresses || [])) {
      if (!a.utxos || a.utxos.length === 0) continue;
      for (const u of a.utxos) {
        allUtxos.push({ ...u, _addrIndex: a.index, _address: a.address });
      }
    }

    // Sort newest first
    allUtxos.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (allUtxos.length > 0) {
      // Stats summary
      document.getElementById('wallet-scan-stats').style.display = 'block';
      document.getElementById('wallet-stat-summary').textContent =
        result.addressesWithActivity + ' addresses, ' + new Set(allUtxos.map(u => u.txid || u.outputId)).size + ' transactions | ' + elapsed + 's';

      // Populate tables and stats (mirrors explorer)
      walletPopulateHistoryTable(allUtxos);
      walletPopulateUtxoTable(allUtxos);
      walletPopulateStatsTab(result, allUtxos);
      txbPopulateUtxos(allUtxos);
      document.getElementById('wallet-tab-wrap').style.display = 'block';
      walletApplyMempool();
      txbRefreshFromMempool();

    }

    walletResetLockTimer();
    walletScanLog('Scan complete in ' + elapsed + 's.', 'ok');
  } catch (e) {
    walletScanLog('Error: ' + e, 'err');
  } finally {
  }
}

// Wire up wallet buttons
document.getElementById('btn-wallet-gen24').addEventListener('click', () => walletGenerateSeed(24));
document.getElementById('btn-wallet-gen12').addEventListener('click', () => walletGenerateSeed(12));
document.getElementById('btn-wallet-save').addEventListener('click', walletEncryptAndSave);
document.getElementById('btn-wallet-unlock').addEventListener('click', walletLoadAndDecrypt);
document.getElementById('btn-wallet-lock').addEventListener('click', walletLock);
document.getElementById('btn-wallet-export').addEventListener('click', walletExportSeed);
document.getElementById('btn-wallet-hide-seed').addEventListener('click', () => {
  document.getElementById('wallet-seed-display').style.display = 'none';
  document.getElementById('wallet-seed-phrase').value = '';
});
document.getElementById('btn-wallet-delete').addEventListener('click', walletDelete);
document.getElementById('btn-wallet-derive').addEventListener('click', walletDeriveAddresses);
document.getElementById('btn-wallet-show-setup').addEventListener('click', () => {
  document.getElementById('wallet-unlock-ui').style.display = 'none';
  document.getElementById('wallet-setup-ui').style.display = '';
});
document.getElementById('wallet-password-unlock').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') walletLoadAndDecrypt();
});
document.getElementById('btn-wallet-clear-log').addEventListener('click', () => {
  document.getElementById('wallet-scan-log').innerHTML = '';
});
document.getElementById('wallet-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') walletEncryptAndSave();
});

// Wallet tab switching
document.querySelectorAll('.wscan-tab').forEach(btn => {
  btn.addEventListener('click', () => walletSwitchTab(btn.dataset.tab));
});

// Wallet JSON export
document.getElementById('btn-wallet-save-json').addEventListener('click', walletSaveResultAsJson);

// Transaction Builder event listeners
document.getElementById('txb-btn-add-output').addEventListener('click', txbAddOutputRow);
document.getElementById('txb-btn-add-change').addEventListener('click', txbAddChangeRow);
document.getElementById('txb-btn-compute-proofs').addEventListener('click', txbComputeProofs);
document.getElementById('txb-btn-build').addEventListener('click', txbBuildTransaction);
document.getElementById('txb-btn-broadcast').addEventListener('click', txbBroadcastTransaction);
document.getElementById('txb-btn-copy').addEventListener('click', () => {
  const json = document.getElementById('txb-txn-json').textContent;
  navigator.clipboard.writeText(json).then(() => {
    document.getElementById('txb-status').style.color = '#4ade80';
    document.getElementById('txb-status').textContent = 'Copied to clipboard.';
  });
});
document.getElementById('txb-miner-fee').addEventListener('input', txbUpdateBalanceSummary);

// Attestation toggle
document.getElementById('txb-btn-att-private').addEventListener('click', () => {
  const cb = document.getElementById('txb-att-private');
  const section = document.getElementById('txb-attestation-section');
  const btn = document.getElementById('txb-btn-att-private');
  const info = document.getElementById('txb-att-info');
  cb.checked = !cb.checked;
  section.style.display = cb.checked ? '' : 'none';
  btn.textContent = cb.checked ? '- Remove Manifest' : '+ Private Manifest';
  txbUpdateAttInfo();
});

async function txbUpdateAttInfo() {
  const info = document.getElementById('txb-att-info');
  const cb = document.getElementById('txb-att-private');
  if (cb.checked && _walletEntropy) {
    const account = parseInt(document.getElementById('txb-att-account', 10).value) || 0;
    try {
      const nextIdx = await mfstFindNextIndex(account);
      const json = derive_manifest_info(_walletEntropy, account, nextIdx);
      const manifest = JSON.parse(json);
      info.innerHTML = 'Next index: <span style="color:#f59e0b;">' + _esc(String(nextIdx)) +
        '</span> · Pubkey: <span style="color:#10b981; font-family:monospace;">' +
        _esc(manifest.publicKey.slice(0, 24)) + '...</span>';
    } catch (err) { info.textContent = ''; }
  } else {
    info.textContent = '';
  }
}

document.getElementById('txb-att-account').addEventListener('change', txbUpdateAttInfo);
document.getElementById('txb-btn-toggle-json').addEventListener('click', () => {
  const jsonEl = document.getElementById('txb-txn-json');
  const btn = document.getElementById('txb-btn-toggle-json');
  if (jsonEl.style.display === 'none') {
    jsonEl.style.display = '';
    btn.textContent = 'Hide Raw JSON';
  } else {
    jsonEl.style.display = 'none';
    btn.textContent = 'Show Raw JSON';
  }
});

// Event delegation for wallet scan results (tx links, addr links)
document.getElementById('wallet-tab-wrap').addEventListener('click', (e) => {
  // TxID link
  const txLink = e.target.closest('.wallet-tx-link');
  if (txLink) {
    e.stopPropagation();
    const txid = txLink.dataset.txid;
    const height = txLink.dataset.height ? parseInt(txLink.dataset.height, 10) : undefined;
    openOrActivateInternalTab('explorer');
    setTimeout(() => {
      exploreTransaction(txid, height);
    }, 100);
    return;
  }
  // Address link
  const addrLink = e.target.closest('.addr-link');
  if (addrLink) {
    e.stopPropagation();
    const addr = addrLink.dataset.addr;
    openOrActivateInternalTab('explorer');
    setTimeout(() => {
      document.getElementById('exp-query').value = addr;
      explorerQuery();
    }, 100);
    return;
  }
  // Height link
  const heightLink = e.target.closest('.wallet-height-link');
  if (heightLink) {
    e.stopPropagation();
    const h = heightLink.dataset.height;
    openOrActivateInternalTab('explorer');
    setTimeout(() => {
      document.getElementById('exp-query').value = h;
      explorerQuery();
    }, 100);
    return;
  }
});

// Check if a saved wallet exists and show compact unlock UI
try {
  const saved = await walletDbLoad('encrypted_entropy');
  if (saved) _walletHasSaved = true;
} catch (e) {
  console.warn('Failed to check saved wallet:', e);
}
walletUpdateUI();

// Re-scan wallet when network changes (scan results are network-specific)
let _walletLastNet = getActiveNetwork();
chainOnChange(() => {
  const net = getActiveNetwork();
  if (net !== _walletLastNet) {
    _walletLastNet = net;
    _lastWalletScanResult = null;
    document.getElementById('wallet-balance-box').style.display = 'none';
    document.getElementById('wallet-scan-stats').style.display = 'none';
    document.getElementById('wallet-tab-wrap').style.display = 'none';
    document.getElementById('wallet-history-body').innerHTML = '';
    document.getElementById('wallet-utxo-body').innerHTML = '';
    document.getElementById('wallet-tab-stats').innerHTML = '';
    if (_walletEntropy) walletScanUtxos();
  }
});

// Refresh transaction builder when a new block arrives
let _walletLastTipHeight = null;
chainOnChange(() => {
  const net = getActiveNetwork();
  const s = getSyncState(net);
  const tipH = s.currentHeight;
  if (tipH != null && tipH !== _walletLastTipHeight) {
    const prev = _walletLastTipHeight;
    _walletLastTipHeight = tipH;
    // Skip the initial population (prev === null) — only refresh on actual new blocks
    if (prev !== null && _txbBaseUtxos.length > 0) {
      txbRefreshFromMempool();
    }
  }
});

// --- Exports ---

// State accessors (read-only for importers via getters)
export function getWalletEntropy() { return _walletEntropy; }
export function setWalletEntropy(v) { _walletEntropy = v; }
export function getWalletHasSaved() { return _walletHasSaved; }
export function setWalletHasSaved(v) { _walletHasSaved = v; }
export function getWalletLockSuspended() { return _walletLockSuspended; }
export function setWalletLockSuspended(v) { _walletLockSuspended = v; }

export {
  walletLog, walletScanLog, walletUpdateUI, walletResetLockTimer,
  walletLock, walletDelete, walletDbSave, walletDbLoad,
  walletGenerateSeed, walletEncryptAndSave, walletLoadAndDecrypt,
  walletExportSeed, walletDeriveAddresses, walletScanUtxos,
  walletSaveResultAsJson, scToHastings,
};
