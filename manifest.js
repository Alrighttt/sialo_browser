// Manifest Pointers module — build, resolve, and manage manifest attestations
// on the Sia blockchain.

import { _esc } from './utils.js';
import { explore as explorerQuery } from './explorer.js';
import { kdfDecrypt } from './kdf.js';
import { createTab, activateTab, openOrActivateInternalTab } from './tabs.js';
import {
  getActiveNetwork, getNetworkConfig, getGenesisHex,
  loadAttestationEntries, exploreQuery as chainExploreQuery,
  getAttestationIndexUrl, exportNetworkData, importNetworkData,
  onChange as chainOnChange, onMempoolChange, getMempoolTransactions,
} from './chain.js';
import {
  derive_manifest_info,
  build_private_manifest_transaction, build_public_manifest_transaction,
  build_channel_manifest_transaction, build_group_manifest_transaction,
  open_private_manifest, open_channel_manifest, open_group_manifest,
  broadcast_v2_transaction, build_v2_transaction,
  compute_utxo_proofs, v2_output_id, v2_transaction_id,
} from './pkg/syncer_wasm.js';
import {
  getWalletEntropy, setWalletEntropy, getWalletHasSaved, setWalletHasSaved, getWalletLockSuspended, setWalletLockSuspended,
  walletDbLoad, walletUpdateUI, walletResetLockTimer, walletScanUtxos, scToHastings,
} from './wallet.js';

// Late-binding: loadContentWithAutoDetect is defined in the main script
let _loadContentWithAutoDetect = null;
export function setLoadContentHandler(fn) { _loadContentWithAutoDetect = fn; }

// ========== Manifest Pointers ==========

function mfstLog(msg, cls) {
  const el = document.getElementById('mfst-log');
  if (!el) return;
  const span = document.createElement('span');
  span.style.color = cls === 'ok' ? '#4ade80' : cls === 'err' ? '#f87171' : cls === 'info' ? '#60a5fa' : cls === 'data' ? '#f59e0b' : '#e0e0e0';
  span.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function mfstGetNetwork() {
  const net = getActiveNetwork();
  if (net === 'mainnet' || net === 'mainnet_v2') return 'mainnet';
  if (net === 'zen') return 'zen';
  return 'mainnet';
}

function mfstUpdateUI() {
  const hasEntropy = !!getWalletEntropy();
  const statusEl = document.getElementById('mfst-wallet-status');
  const createSection = document.getElementById('mfst-create-section');
  const unlockUI = document.getElementById('mfst-unlock-ui');

  const resolveSection = document.getElementById('mfst-resolve-section');
  const backupSection = document.getElementById('mfst-backup-section');
  const logSection = document.getElementById('mfst-log-section');

  if (hasEntropy) {
    statusEl.innerHTML = '<span style="color:#4ade80;">&#x1F513; Unlocked</span>';
    createSection.style.display = '';
    resolveSection.style.display = '';
    backupSection.style.display = '';
    logSection.style.display = '';
    unlockUI.style.display = 'none';
    mfstDerive();
  } else {
    statusEl.innerHTML = '<span style="color:#888;">&#x1F512; Locked</span>';
    createSection.style.display = 'none';
    resolveSection.style.display = 'none';
    backupSection.style.display = 'none';
    logSection.style.display = 'none';
    document.getElementById('mfst-output-section').style.display = 'none';
    if (!getWalletHasSaved()) {
      document.getElementById('mfst-unlock-hint').textContent = 'No wallet saved. Create one on the Wallet page first.';
      unlockUI.style.display = '';
      document.getElementById('mfst-password').style.display = 'none';
      document.getElementById('btn-mfst-unlock').style.display = 'none';
    } else {
      document.getElementById('mfst-unlock-hint').textContent = 'Unlock your wallet to use manifest pointers.';
      unlockUI.style.display = '';
      document.getElementById('mfst-password').style.display = '';
      document.getElementById('btn-mfst-unlock').style.display = '';
    }
  }
  mfstUpdateTypeFields();
}

async function mfstUnlock() {
  const password = document.getElementById('mfst-password').value;
  if (!password) { mfstLog('Enter your wallet password.', 'err'); return; }
  try {
    const encrypted = await walletDbLoad('encrypted_entropy');
    if (!encrypted) { mfstLog('No saved wallet found.', 'err'); return; }
    const entropyHex = await kdfDecrypt(encrypted, password);
    setWalletEntropy(entropyHex);
    setWalletHasSaved(true);
    document.getElementById('mfst-password').value = '';
    walletUpdateUI();
    walletResetLockTimer();
    walletScanUtxos();
    mfstUpdateUI();
    mfstLog('Wallet unlocked.', 'ok');
  } catch (e) {
    mfstLog('Wrong password.', 'err');
  }
}

function mfstUpdateTypeFields() {
  const type = document.getElementById('mfst-type')?.value;
  if (!type) return;
  const needsAddrIndex = type !== 'private';
  document.getElementById('mfst-address-index-row').style.display = needsAddrIndex ? '' : 'none';
  document.getElementById('mfst-channel-fields').style.display = type === 'channel' ? '' : 'none';
  document.getElementById('mfst-group-fields').style.display = type === 'group' ? '' : 'none';
  mfstDerive();
}

function mfstUpdateResolveFields() {
  const type = document.getElementById('mfst-resolve-type').value;
  const needsPubkey = type === 'public' || type === 'channel';
  document.getElementById('mfst-resolve-pubkey-row').style.display = needsPubkey ? '' : 'none';
  document.getElementById('mfst-resolve-channel-fields').style.display = type === 'channel' ? '' : 'none';
  document.getElementById('mfst-resolve-group-fields').style.display = type === 'group' ? '' : 'none';
}

function mfstDerive() {
  if (!getWalletEntropy()) return;
  const account = parseInt(document.getElementById('mfst-account', 10)?.value) || 0;
  try {
    const json = derive_manifest_info(getWalletEntropy(), account, 0);
    const info = JSON.parse(json);
    const el = document.getElementById('mfst-pubkey-display');
    if (el) el.textContent = info.path + ' (index 0)';
  } catch (e) {
    mfstLog('Derivation error: ' + e, 'err');
  }
}

// Render text with clickable sia:// and https:// links
function mfstRenderLinkedText(text, container) {
  const urlRegex = /((?:sia|https?):\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const linkUrl = match[1];
    const link = document.createElement('a');
    link.href = '#';
    link.style.cssText = 'color:#4ade80; text-decoration:underline; cursor:pointer;';
    link.textContent = linkUrl;
    if (linkUrl.startsWith('sia://')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = createTab({ type: 'browser', label: linkUrl.length > 30 ? linkUrl.substring(0, 30) + '...' : linkUrl, url: linkUrl });
        activateTab(tab.id);
        document.getElementById('chrome-address-bar').value = linkUrl;
        if (_loadContentWithAutoDetect) _loadContentWithAutoDetect();
      });
    } else {
      link.addEventListener('click', (e) => { e.preventDefault(); window.open(linkUrl, '_blank'); });
    }
    container.appendChild(link);
    lastIndex = urlRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

// Scan attestation index to find the next unused manifest key index for this account.
// Derives pubkeys at i=0,1,2... and checks if any attestation exists for each.
async function mfstFindNextIndex(account) {
  const allEntries = await loadAttestationEntries();
  const pubkeySet = new Set(allEntries.map(e => e.pubkeyHex.toLowerCase()));
  for (let i = 0; i < 1000; i++) {
    try {
      const json = derive_manifest_info(getWalletEntropy(), account, i);
      const info = JSON.parse(json);
      const pk = info.publicKey.replace('ed25519:', '').toLowerCase();
      if (!pubkeySet.has(pk)) return i;
    } catch (e) { return i; }
  }
  return 0;
}

async function mfstBuildTransaction() {
  if (!getWalletEntropy()) { mfstLog('Wallet is locked.', 'err'); return; }
  const type = document.getElementById('mfst-type').value;
  const account = parseInt(document.getElementById('mfst-account', 10).value) || 0;
  const addrIdx = parseInt(document.getElementById('mfst-address-index', 10).value) || 0;
  const url = document.getElementById('mfst-share-url').value.trim();
  const feeInput = document.getElementById('mfst-miner-fee').value.trim() || '0';
  const fee = scToHastings(feeInput);
  const network = mfstGetNetwork();
  if (!url) { mfstLog('Enter a URL.', 'err'); return; }

  try {
    let txnJson;
    if (type === 'private') {
      const nextIdx = await mfstFindNextIndex(account);
      mfstLog('Using manifest index ' + nextIdx + ' (next unused)', 'info');
      txnJson = build_private_manifest_transaction(getWalletEntropy(), account, nextIdx, url, fee, network);
    } else if (type === 'public') {
      txnJson = build_public_manifest_transaction(getWalletEntropy(), account, addrIdx, url, fee, network);
    } else if (type === 'channel') {
      const chName = document.getElementById('mfst-channel-name').value.trim();
      const chKey = document.getElementById('mfst-channel-key').value.trim();
      if (!chName) { mfstLog('Enter a channel name.', 'err'); return; }
      if (!chKey || chKey.length !== 64) { mfstLog('Channel key must be 64 hex characters.', 'err'); return; }
      txnJson = build_channel_manifest_transaction(getWalletEntropy(), account, addrIdx, chName, chKey, url, fee, network);
    } else if (type === 'group') {
      const secret = document.getElementById('mfst-group-secret').value.trim();
      if (!secret || secret.length !== 64) { mfstLog('Group secret must be 64 hex characters.', 'err'); return; }
      txnJson = build_group_manifest_transaction(getWalletEntropy(), account, addrIdx, secret, url, fee, network);
    }
    document.getElementById('mfst-txn-json').textContent = txnJson;
    document.getElementById('mfst-output-section').style.display = '';
    mfstLog('Built ' + type + ' manifest attestation transaction.', 'ok');
  } catch (e) {
    mfstLog('Build error: ' + e, 'err');
  }
}

// Cache for resolved attestation results: keyed by resolve type + params
// Each cache entry: { results: [...], maxHeight: N }
// On re-resolve, we only fetch blocks above maxHeight
const _mfstResolveCache = {};

function _mfstCacheKey(type, account) {
  if (type === 'private') return 'private:' + account;
  return type + ':' + (document.getElementById('mfst-resolve-pubkey')?.value || '').trim().toLowerCase();
}

async function mfstResolve() {
  const type = document.getElementById('mfst-resolve-type').value;
  const resultsDiv = document.getElementById('mfst-resolve-body');
  const resultsWrap = document.getElementById('mfst-resolve-results');
  resultsDiv.innerHTML = '';
  resultsWrap.style.display = 'none';

  const attIndexUrl = getAttestationIndexUrl();
  if (!attIndexUrl) {
    mfstLog('No attestation index loaded. Sync the chain first.', 'err');
    return;
  }

  try {
    let pubkeyHex;

    if (type === 'private') {
      if (!getWalletEntropy()) { mfstLog('Wallet is locked.', 'err'); return; }
      const account = parseInt(document.getElementById('mfst-account', 10).value) || 0;
      // Scan all manifest indices (gap-based, like HD wallet addresses)
      // Check both the on-chain attestation index AND the mempool
      const allEntries = await loadAttestationEntries();
      const pubkeySet = new Set(allEntries.map(e => e.pubkeyHex.toLowerCase()));

      // Also collect pubkeys from mempool attestations
      const mempoolNet = getActiveNetwork();
      const mempoolTxns = getMempoolTransactions(mempoolNet);
      for (const mt of mempoolTxns) {
        if (!mt.rawJson) continue;
        try {
          const txn = JSON.parse(mt.rawJson);
          for (const att of (txn.attestations || [])) {
            const pk = (att.publicKey || att.public_key || '').replace('ed25519:', '').toLowerCase();
            if (pk) pubkeySet.add(pk);
          }
        } catch (_) {}
      }

      let matchedPubkeys = [];
      let gap = 0;
      for (let i = 0; gap < 20; i++) {
        try {
          const info = JSON.parse(derive_manifest_info(getWalletEntropy(), account, i));
          const pk = info.publicKey.replace('ed25519:', '').toLowerCase();
          if (pubkeySet.has(pk)) {
            matchedPubkeys.push({ index: i, pubkeyHex: pk });
            gap = 0;
          } else {
            gap++;
          }
        } catch (e) { break; }
      }
      if (matchedPubkeys.length === 0) {
        mfstLog('No manifest attestations found in index or mempool.', 'info');
        return;
      }
      // Collect all matching entries
      const entries = [];
      for (const mp of matchedPubkeys) {
        for (const e of allEntries) {
          if (e.pubkeyHex.toLowerCase() === mp.pubkeyHex) {
            entries.push({ ...e, manifestIndex: mp.index });
          }
        }
      }

      // Check cache — only fetch blocks above cached maxHeight
      const cacheKey = _mfstCacheKey('private', account);
      const cached = _mfstResolveCache[cacheKey] || { results: [], maxHeight: -1 };
      const newEntries = entries.filter(e => e.height > cached.maxHeight);

      if (newEntries.length === 0 && cached.results.length > 0) {
        mfstLog('Using cached results (' + cached.results.length + ' attestations). No new blocks to fetch.', 'info');
      } else if (newEntries.length > 0) {
        mfstLog('Found ' + matchedPubkeys.length + ' manifest key(s). Fetching ' + newEntries.length + ' new block(s) (' + (entries.length - newEntries.length) + ' cached)...', 'info');

        // Download new blocks and extract attestation values
        for (const entry of newEntries) {
          try {
            const blockJson = await chainExploreQuery(entry.height.toString());
            if (!blockJson) continue;
            const block = typeof blockJson === 'string' ? JSON.parse(blockJson) : blockJson;
            const blk = block.block || block;
            const v2txns = blk.v2?.transactions || [];

            for (let ti = 0; ti < v2txns.length; ti++) {
              const txn = v2txns[ti];
              if (!txn.attestations || txn.attestations.length === 0) continue;
              let txid = txn.id || txn.ID || null;
              if (!txid) { try { txid = v2_transaction_id(JSON.stringify(txn)); } catch (_) {} }
              for (const att of txn.attestations) {
                const attPk = (att.publicKey || att.public_key || '').replace('ed25519:', '');
                if (attPk.toLowerCase() !== entry.pubkeyHex.toLowerCase()) continue;

                let url = null;
                let valueBytes;
                try {
                  const b64 = typeof att.value === 'string' ? att.value : '';
                  const bin = atob(b64);
                  valueBytes = new Uint8Array(bin.length);
                  for (let j = 0; j < bin.length; j++) valueBytes[j] = bin.charCodeAt(j);
                } catch (e) { continue; }
                const valueHex = Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join('');

                try { url = open_private_manifest(getWalletEntropy(), account, entry.manifestIndex, valueHex); } catch (e) { /* wrong key */ }
                cached.results.push({ height: entry.height, key: att.key, url, raw: att.value, account, index: entry.manifestIndex, txid });
              }
            }
            if (entry.height > cached.maxHeight) cached.maxHeight = entry.height;
          } catch (e) {
            mfstLog('Failed to fetch block ' + entry.height + ': ' + e, 'err');
          }
        }
        _mfstResolveCache[cacheKey] = cached;
      }

      const results = [...cached.results];

      // Also scan mempool for unconfirmed private manifest attestations
      const mempoolTxns2 = getMempoolTransactions(mempoolNet);
      for (const mt of mempoolTxns2) {
        if (!mt.rawJson) continue;
        try {
          const txn = JSON.parse(mt.rawJson);
          if (!txn.attestations || txn.attestations.length === 0) continue;
          const txid = mt.id || null;
          for (const att of txn.attestations) {
            const attPk = (att.publicKey || att.public_key || '').replace('ed25519:', '');
            const matchedMp = matchedPubkeys.find(mp => mp.pubkeyHex === attPk.toLowerCase());
            if (!matchedMp) continue;

            let url = null;
            let valueBytes;
            try {
              const b64 = typeof att.value === 'string' ? att.value : '';
              const bin = atob(b64);
              valueBytes = new Uint8Array(bin.length);
              for (let j = 0; j < bin.length; j++) valueBytes[j] = bin.charCodeAt(j);
            } catch (_) { continue; }
            const valueHex = Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join('');

            try { url = open_private_manifest(getWalletEntropy(), account, matchedMp.index, valueHex); } catch (_) {}
            results.push({ height: 'mempool', key: att.key, url, raw: att.value, account, index: matchedMp.index, txid });
          }
        } catch (_) {}
      }

      // Display results
      if (results.length === 0) {
        mfstLog('No attestations found in blocks or mempool.', 'info');
        return;
      }

      resultsWrap.style.display = '';
      results.sort((a, b) => {
        if (a.height === 'mempool') return -1;
        if (b.height === 'mempool') return 1;
        return b.height - a.height;
      });
      for (const r of results) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:0.4rem 0; border-bottom:1px solid #1a1a1a;';
        const metaSpan = document.createElement('span');
        metaSpan.style.cssText = 'font-size:0.75rem;';
        let metaParts = ['Height ' + _esc(String(r.height))];
        if (r.account !== null && r.account !== undefined) metaParts.push('Account ' + _esc(String(r.account)));
        if (r.index !== null && r.index !== undefined) metaParts.push('Index ' + _esc(String(r.index)));
        metaSpan.innerHTML = '<span style="color:#60a5fa;">' + metaParts.join(' · ') + '</span>';
        row.appendChild(metaSpan);
        if (r.txid) {
          const txLink = document.createElement('a');
          txLink.href = '#';
          txLink.style.cssText = 'font-size:0.7rem; color:#888; margin-left:0.5rem; font-family:monospace;';
          txLink.textContent = 'tx:' + r.txid.slice(0, 8) + '…' + r.txid.slice(-8);
          txLink.title = r.txid;
          txLink.addEventListener('click', (e) => {
            e.preventDefault();
            openOrActivateInternalTab('explorer');
            setTimeout(() => {
              document.getElementById('exp-query').value = r.txid;
              explorerQuery();
            }, 100);
          });
          metaSpan.appendChild(txLink);
        }

        if (r.url) {
          const urlDiv = document.createElement('div');
          urlDiv.style.cssText = 'margin-top:0.25rem; word-break:break-all; font-family:monospace; font-size:0.75rem; color:#e0e0e0;';
          mfstRenderLinkedText(r.url, urlDiv);
          row.appendChild(urlDiv);
        } else {
          const rawDiv = document.createElement('div');
          rawDiv.style.cssText = 'margin-top:0.25rem; color:#f59e0b; font-size:0.7rem; word-break:break-all;';
          rawDiv.textContent = '(could not decrypt)';
          row.appendChild(rawDiv);
        }
        resultsDiv.appendChild(row);
      }
      mfstLog('Resolved ' + results.length + ' attestation(s) across ' + matchedPubkeys.length + ' key(s).', 'ok');
      return;

    } else if (type === 'public' || type === 'channel') {
      const pk = document.getElementById('mfst-resolve-pubkey').value.trim();
      if (!pk) { mfstLog('Enter a public key or key hash.', 'err'); return; }
      if (pk.startsWith('ed25519:')) {
        pubkeyHex = pk.replace('ed25519:', '');
        mfstLog('Looking up attestations for ed25519:' + pubkeyHex.slice(0, 16) + '...', 'info');
      } else {
        // Treat as raw hex — could be a pubkey or a key hash
        pubkeyHex = pk;
        mfstLog('Looking up attestations for ' + pubkeyHex.slice(0, 16) + '...', 'info');
      }
    } else if (type === 'group') {
      const secret = document.getElementById('mfst-resolve-group-secret').value.trim();
      if (!secret || secret.length !== 64) { mfstLog('Group secret must be 64 hex characters.', 'err'); return; }
      // For groups, we search by key hash — need to scan the attestation index differently
      // For now, log that group resolve requires SAPI key-hash lookup
      mfstLog('Group manifest resolution via SAPI key-hash lookup is not yet implemented in the local index.', 'err');
      return;
    }

    // Search attestation index — match by pubkey or key hash
    mfstLog('Searching for: ' + pubkeyHex, 'data');
    const allEntries = await loadAttestationEntries();
    const searchLower = pubkeyHex.toLowerCase();
    let entries = allEntries.filter(e => e.pubkeyHex.toLowerCase() === searchLower);
    // If no pubkey match and the input is shorter (key hash), search by key hash prefix
    if (entries.length === 0 && searchLower.length <= 16) {
      entries = allEntries.filter(e => e.keyHashHex.toLowerCase().startsWith(searchLower));
      if (entries.length > 0) {
        mfstLog(`No pubkey match, found ${entries.length} key hash match(es)`, 'info');
      }
    }
    if (entries.length === 0) {
      mfstLog('No attestations found for this public key (' + allEntries.length + ' total entries scanned). Try rebuilding filters in the Syncer page if the attestation was recently confirmed.', 'info');
      return;
    }
    mfstLog('Found ' + entries.length + ' attestation(s). Downloading blocks...', 'info');

    // Download blocks and extract attestation values
    const results = [];
    for (const entry of entries) {
      try {
        const blockJson = await chainExploreQuery(entry.height.toString());
        if (!blockJson) continue;
        const block = typeof blockJson === 'string' ? JSON.parse(blockJson) : blockJson;
        // chainExploreQuery returns { block: { v2: { transactions: [...] }, ... }, blockHeight, type }
        const blk = block.block || block;
        const v2txns = blk.v2?.transactions || [];
        const v1txns = blk.v1Transactions || blk.transactions || [];
        const txns = [...v2txns, ...v1txns];
        mfstLog('Block ' + entry.height + ': ' + v2txns.length + ' v2 txn(s)', 'data');

        for (const txn of txns) {
          if (!txn.attestations || txn.attestations.length === 0) continue;
          let txid = txn.id || txn.ID || null;
          if (!txid) { try { txid = v2_transaction_id(JSON.stringify(txn)); } catch (_) {} }
          for (const att of txn.attestations) {
            const attPk = (att.publicKey || att.public_key || '').replace('ed25519:', '');
            if (attPk.toLowerCase() !== pubkeyHex.toLowerCase()) continue;

            let url = null;
            let valueBytes;
            try {
              const b64 = typeof att.value === 'string' ? att.value : '';
              const bin = atob(b64);
              valueBytes = new Uint8Array(bin.length);
              for (let j = 0; j < bin.length; j++) valueBytes[j] = bin.charCodeAt(j);
            } catch (e) { continue; }
            const valueHex = Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join('');

            if (type === 'private' && getWalletEntropy()) {
              const account = parseInt(document.getElementById('mfst-account', 10).value) || 0;
              try { url = open_private_manifest(getWalletEntropy(), account, valueHex); } catch (e) { /* wrong key */ }
            } else if (type === 'public') {
              try { url = new TextDecoder().decode(valueBytes); } catch (e) { /* not utf8 */ }
            } else if (type === 'channel') {
              const chKey = document.getElementById('mfst-resolve-channel-key').value.trim();
              if (chKey) {
                try { url = open_channel_manifest(chKey, valueHex); } catch (e) { /* wrong key */ }
              }
            }

            const acct = (type === 'private') ? (parseInt(document.getElementById('mfst-account', 10).value) || 0) : null;
            results.push({ height: entry.height, key: att.key, url, raw: att.value, account: acct, txid });
          }
        }
      } catch (e) {
        mfstLog('Failed to fetch block ' + entry.height + ': ' + e, 'err');
      }
    }

    // Also scan mempool for unconfirmed attestations
    const net = getActiveNetwork();
    const mempoolTxns = getMempoolTransactions(net);
    for (const mt of mempoolTxns) {
      if (!mt.rawJson) continue;
      try {
        const txn = JSON.parse(mt.rawJson);
        if (!txn.attestations || txn.attestations.length === 0) continue;
        for (const att of txn.attestations) {
          const attPk = (att.publicKey || att.public_key || '').replace('ed25519:', '');
          // For private type, check all derived pubkeys; for public/channel, check the searched key
          let matchesPubkey = false;
          if (type === 'private') {
            // Private: we already found matchedPubkeys from the index scan above
            // For mempool, check if the attestation pubkey matches any derived key
            if (typeof matchedPubkeys !== 'undefined') {
              matchesPubkey = matchedPubkeys.some(mp => mp.pubkeyHex === attPk.toLowerCase());
            }
          } else {
            matchesPubkey = attPk.toLowerCase() === pubkeyHex.toLowerCase();
          }
          if (!matchesPubkey) continue;

          let url = null;
          let valueBytes;
          try {
            const b64 = typeof att.value === 'string' ? att.value : '';
            const bin = atob(b64);
            valueBytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) valueBytes[j] = bin.charCodeAt(j);
          } catch (_) { continue; }
          const valueHex = Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join('');

          if (type === 'private' && getWalletEntropy()) {
            const acct = parseInt(document.getElementById('mfst-account', 10).value) || 0;
            try { url = open_private_manifest(getWalletEntropy(), acct, valueHex); } catch (_) {}
          } else if (type === 'public') {
            try { url = new TextDecoder().decode(valueBytes); } catch (_) {}
          } else if (type === 'channel') {
            const chKey = document.getElementById('mfst-resolve-channel-key').value.trim();
            if (chKey) {
              try { url = open_channel_manifest(chKey, valueHex); } catch (_) {}
            }
          }

          results.push({ height: 'mempool', key: att.key, url, raw: att.value, account: null });
        }
      } catch (_) {}
    }
    if (results.length > 0 && mempoolTxns.length > 0) {
      mfstLog(`Also checked ${mempoolTxns.length} mempool transaction(s).`, 'data');
    }

    // Display results
    if (results.length === 0) {
      mfstLog('No matching attestations found in blocks or mempool.', 'info');
      return;
    }

    resultsWrap.style.display = '';
    // Show newest first (mempool entries at the top)
    results.sort((a, b) => {
      if (a.height === 'mempool') return -1;
      if (b.height === 'mempool') return 1;
      return b.height - a.height;
    });
    for (const r of results) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:0.4rem 0; border-bottom:1px solid #1a1a1a;';
      const metaSpan = document.createElement('span');
      metaSpan.style.cssText = 'font-size:0.75rem; color:#888;';
      let metaText = r.height === 'mempool' ? 'Mempool (unconfirmed)' : 'Height ' + r.height;
      if (r.account !== null && r.account !== undefined) metaText += ' · Account ' + r.account;
      const metaColor = r.height === 'mempool' ? '#f59e0b' : '#60a5fa';
      metaSpan.innerHTML = '<span style="color:' + metaColor + ';">' + _esc(metaText) + '</span>';
      row.appendChild(metaSpan);
      if (r.txid) {
        const txLink = document.createElement('a');
        txLink.href = '#';
        txLink.style.cssText = 'font-size:0.7rem; color:#888; margin-left:0.5rem; font-family:monospace;';
        txLink.textContent = 'tx:' + r.txid.slice(0, 8) + '…' + r.txid.slice(-8);
        txLink.title = r.txid;
        txLink.addEventListener('click', (e) => {
          e.preventDefault();
          openOrActivateInternalTab('explorer');
          setTimeout(() => {
            document.getElementById('exp-query').value = r.txid;
            explorerQuery();
          }, 100);
        });
        metaSpan.appendChild(txLink);
      }

      if (r.url) {
        const urlDiv = document.createElement('div');
        urlDiv.style.cssText = 'margin-top:0.25rem; word-break:break-all; font-family:monospace; font-size:0.75rem; color:#e0e0e0;';
        mfstRenderLinkedText(r.url, urlDiv);
        row.appendChild(urlDiv);
      } else {
        const rawDiv = document.createElement('div');
        rawDiv.style.cssText = 'margin-top:0.25rem; color:#f59e0b; font-size:0.7rem; word-break:break-all;';
        rawDiv.textContent = '(encrypted/unreadable) ' + (typeof r.raw === 'string' ? r.raw.slice(0, 60) + '...' : '');
        row.appendChild(rawDiv);
      }
      resultsDiv.appendChild(row);
    }
    mfstLog('Resolved ' + results.length + ' attestation(s). Latest at height ' + results[0].height, 'ok');

  } catch (e) {
    mfstLog('Resolve error: ' + e, 'err');
  }
}

// ---- Backup & Restore ----

async function mfstBackup() {
  const statusEl = document.getElementById('mfst-backup-status');
  const progressEl = document.getElementById('mfst-backup-progress');
  if (!getWalletEntropy()) { mfstLog('Wallet is locked.', 'err'); return; }

  const net = getActiveNetwork();
  const network = mfstGetNetwork();
  const account = parseInt(document.getElementById('mfst-account', 10)?.value) || 0;

  // Verify chain is fully synced
  const syncState = getSyncState(net);
  if (syncState.status !== 'synced') {
    mfstLog('Cannot backup: ' + net + ' is not fully synced (status: ' + syncState.status + '). Wait for sync to complete.', 'err');
    return;
  }

  try {
    // Step 1: Export data
    statusEl.textContent = 'Packing ' + net + ' sync data...';
    statusEl.style.color = '#888';
    const packed = await exportNetworkData(net);
    if (!packed || packed.length < 10) {
      mfstLog('No sync data to backup for ' + net + '.', 'err');
      statusEl.textContent = '';
      return;
    }
    mfstLog('Packed ' + (packed.length / 1024 / 1024).toFixed(1) + ' MB for ' + net, 'info');

    // Step 2: Upload via web workers for parallel slab uploads
    // Suspend wallet auto-lock for the duration of the backup
    setWalletLockSuspended(true);
    if (_walletLockTimer) { clearTimeout(_walletLockTimer); _walletLockTimer = null; }
    const backupFile = new File([packed], `backup-${net}.dat`, { type: 'application/octet-stream' });
    const { obj, elapsed, size } = await parallelUpload(backupFile, statusEl, progressEl);
    mfstLog(`Uploaded ${size} bytes in ${elapsed}s.`, 'ok');

    // Step 3: Connect SDK for share URL and pin
    const sdk = await connectSdk(statusEl);
    if (!sdk) { mfstLog('Failed to connect to indexer.', 'err'); return; }

    // Step 4: Generate share URL (1 year expiry)
    const validUntilMs = Date.now() + (365 * 24 * 60 * 60 * 1000);
    const shareUrl = sdk.shareObject(obj, validUntilMs);
    mfstLog('Share URL: ' + shareUrl, 'data');

    // Step 5: Pin object
    statusEl.textContent = 'Pinning...';
    try {
      await sdk.pinObject(obj);
      mfstLog('Object pinned.', 'ok');
    } catch (pinErr) {
      mfstLog('Pin failed: ' + pinErr, 'warn');
    }

    // Step 6: Show share URL to user
    const resultEl = document.getElementById('mfst-backup-result');
    const urlEl = document.getElementById('mfst-backup-share-url');
    urlEl.textContent = shareUrl;
    urlEl.addEventListener('click', () => {
      navigator.clipboard.writeText(shareUrl);
      mfstLog('Share URL copied to clipboard.', 'ok');
    });
    resultEl.style.display = '';

    statusEl.style.color = '#4ade80';
    statusEl.textContent = 'Backup complete for ' + net + '. Save the share URL below.';
    progressEl.style.display = 'none';

    setWalletLockSuspended(false);
    walletResetLockTimer();

  } catch (e) {
    setWalletLockSuspended(false);
    walletResetLockTimer();
    mfstLog('Backup error: ' + e, 'err');
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Backup failed: ' + e;
    progressEl.style.display = 'none';
  }
}

// Shared download+import logic for both restore modes
async function mfstDownloadAndRestore(shareUrl) {
  const statusEl = document.getElementById('mfst-backup-status');
  const progressEl = document.getElementById('mfst-backup-progress');
  const net = getActiveNetwork();

  statusEl.textContent = 'Connecting to indexer...';
  statusEl.style.color = '#888';
  const sdk = await connectSdk(statusEl);
  if (!sdk) { mfstLog('Failed to connect to indexer.', 'err'); return; }

  statusEl.textContent = 'Downloading backup...';
  progressEl.style.display = 'block';
  const obj = await sdk.sharedObject(shareUrl);

  const blobParts = [];
  const totalSize = obj.size();
  const stream = sdk.download(obj);
  const reader = stream.getReader();
  let dlByteOffset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    blobParts.push(value);
    dlByteOffset += value.byteLength;
    progressEl.max = totalSize;
    progressEl.value = dlByteOffset;
    statusEl.textContent = 'Downloading... ' + (dlByteOffset / 1024 / 1024).toFixed(1) + ' / ' + (totalSize / 1024 / 1024).toFixed(1) + ' MB';
  }
  const totalLen = blobParts.reduce((s, p) => s + p.length, 0);
  const packed = new Uint8Array(totalLen);
  let off = 0;
  for (const part of blobParts) { packed.set(part, off); off += part.length; }
  mfstLog('Downloaded ' + (totalLen / 1024 / 1024).toFixed(1) + ' MB.', 'ok');

  statusEl.textContent = 'Restoring data for ' + net + '...';
  await importNetworkData(net, packed);
  mfstLog('Sync data restored for ' + net + '.', 'ok');

  statusEl.style.color = '#4ade80';
  statusEl.textContent = 'Restore complete for ' + net + '.';
  progressEl.style.display = 'none';
}

async function mfstRestoreFromUrl() {
  const statusEl = document.getElementById('mfst-backup-status');
  const progressEl = document.getElementById('mfst-backup-progress');
  const url = document.getElementById('mfst-restore-url').value.trim();
  if (!url) { mfstLog('Enter a share URL.', 'err'); return; }
  if (!url.startsWith('sia://')) { mfstLog('URL must start with sia://', 'err'); return; }

  try {
    await mfstDownloadAndRestore(url);

  } catch (e) {
    mfstLog('Restore error: ' + e, 'err');
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Restore failed: ' + e;
    progressEl.style.display = 'none';
  }
}

async function mfstRestoreFromManifest() {
  const statusEl = document.getElementById('mfst-backup-status');
  const progressEl = document.getElementById('mfst-backup-progress');
  if (!getWalletEntropy()) { mfstLog('Wallet is locked.', 'err'); return; }

  const net = getActiveNetwork();
  const account = parseInt(document.getElementById('mfst-account', 10)?.value) || 0;

  try {
    statusEl.textContent = 'Resolving manifest for ' + net + '...';
    statusEl.style.color = '#888';

    const allEntries = await loadAttestationEntries();
    const pubkeySet = new Set(allEntries.map(e => e.pubkeyHex.toLowerCase()));

    let latestUrl = null;
    let latestHeight = -1;
    let gap = 0;

    for (let i = 0; gap < 20; i++) {
      let pk;
      try {
        const info = JSON.parse(derive_manifest_info(getWalletEntropy(), account, i));
        pk = info.publicKey.replace('ed25519:', '').toLowerCase();
      } catch (e) { break; }

      if (!pubkeySet.has(pk)) { gap++; continue; }
      gap = 0;

      const matching = allEntries.filter(e => e.pubkeyHex.toLowerCase() === pk);
      for (const entry of matching) {
        try {
          const blockJson = await chainExploreQuery(entry.height.toString());
          if (!blockJson) continue;
          const block = typeof blockJson === 'string' ? JSON.parse(blockJson) : blockJson;
          const blk = block.block || block;
          const txns = blk.v2?.transactions || [];

          for (const txn of txns) {
            if (!txn.attestations) continue;
            for (const att of txn.attestations) {
              const attPk = (att.publicKey || att.public_key || '').replace('ed25519:', '');
              if (attPk.toLowerCase() !== pk) continue;

              let valueBytes;
              try {
                const bin = atob(att.value);
                valueBytes = new Uint8Array(bin.length);
                for (let j = 0; j < bin.length; j++) valueBytes[j] = bin.charCodeAt(j);
              } catch (e) { continue; }
              const valueHex = Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join('');

              try {
                const url = open_private_manifest(getWalletEntropy(), account, i, valueHex);
                if (url && url.startsWith('sia://') && entry.height > latestHeight) {
                  latestUrl = url;
                  latestHeight = entry.height;
                }
              } catch (e) { /* wrong key */ }
            }
          }
        } catch (e) {
          mfstLog('Failed to fetch block ' + entry.height + ': ' + e, 'err');
        }
      }
    }

    if (!latestUrl) {
      mfstLog('No backup manifest found for ' + net + '.', 'info');
      statusEl.textContent = 'No backup found.';
      return;
    }
    mfstLog('Found backup at height ' + latestHeight + ': ' + latestUrl.slice(0, 60) + '...', 'ok');
    await mfstDownloadAndRestore(latestUrl);

  } catch (e) {
    mfstLog('Restore error: ' + e, 'err');
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Restore failed: ' + e;
    progressEl.style.display = 'none';
  }
}

async function mfstSaveOnChain() {
  const statusEl = document.getElementById('mfst-backup-status');
  const shareUrl = document.getElementById('mfst-backup-share-url').textContent;
  if (!shareUrl) { mfstLog('No share URL to save.', 'err'); return; }
  if (!getWalletEntropy()) { mfstLog('Wallet is locked.', 'err'); return; }

  const net = getActiveNetwork();
  const network = mfstGetNetwork();
  const account = parseInt(document.getElementById('mfst-account', 10)?.value) || 0;
  const previewEl = document.getElementById('mfst-txn-preview');

  try {
    statusEl.textContent = 'Building attestation transaction...';
    const nextIdx = await mfstFindNextIndex(account);
    const attTxnJson = build_private_manifest_transaction(getWalletEntropy(), account, nextIdx, shareUrl, '0', network);
    const attTxn = JSON.parse(attTxnJson);
    const attestationsJson = JSON.stringify(attTxn.attestations);

    const FEE_HASTINGS = '10000000000000000000000'; // 0.01 SC
    if (!_txbBaseUtxos || _txbBaseUtxos.length === 0) {
      mfstLog('No UTXOs available. Scan wallet first.', 'err');
      return;
    }

    const mempoolSpentIds = new Set();
    for (const mt of getMempoolTransactions(net)) {
      for (const inp of (mt.inputs || [])) {
        if (inp.outputId) mempoolSpentIds.add(inp.outputId);
      }
    }

    const sortedUtxos = [..._txbBaseUtxos]
      .filter(u => u.amountHastings && BigInt(u.amountHastings) >= BigInt(FEE_HASTINGS) && !mempoolSpentIds.has(u.outputId))
      .sort((a, b) => {
        const diff = BigInt(a.amountHastings) - BigInt(b.amountHastings);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });

    if (sortedUtxos.length === 0) {
      mfstLog('No UTXO large enough to cover 0.01 SC fee.', 'err');
      return;
    }

    const utxo = sortedUtxos[0];
    if (!_utxoProofs || !_utxoProofs[utxo.outputId]) {
      mfstLog('Computing merkle proofs...', 'info');
      await txbComputeProofs();
    }

    const proof = _utxoProofs[utxo.outputId];
    const input = {
      id: utxo.outputId,
      value: utxo.amountHastings,
      leafIndex: proof?.leafIndex || '0',
      merkleProof: proof?.merkleProof || [],
      addressIndex: utxo._addrIndex || 0,
      maturityHeight: 0,
    };

    const maxIdx = _txbBaseUtxos.reduce((m, u) => Math.max(m, u._addrIndex || 0), 0);
    const changeAddrs = JSON.parse(derive_addresses(getWalletEntropy(), maxIdx + 1, 1));
    const changeAddr = changeAddrs[0].address;

    const txnJson = build_v2_transaction(
      getWalletEntropy(), 0,
      JSON.stringify([input]), JSON.stringify([]),
      FEE_HASTINGS, changeAddr, attestationsJson
    );
    const txnObj = JSON.parse(txnJson);

    // Show preview
    previewEl.innerHTML = '';
    previewEl.appendChild(buildTransactionCard(txnObj, 0, true));

    const broadcastBtn = document.createElement('button');
    broadcastBtn.textContent = 'Broadcast Attestation';
    broadcastBtn.style.cssText = 'font-size:0.85rem; padding:0.4rem 0.8rem; margin-top:0.5rem;';
    previewEl.appendChild(broadcastBtn);

    statusEl.textContent = 'Review the attestation transaction, then click Broadcast.';
    statusEl.style.color = '#facc15';

    broadcastBtn.addEventListener('click', async () => {
      broadcastBtn.disabled = true;
      broadcastBtn.textContent = 'Broadcasting...';
      const config = getNetworkConfig(net);
      try {
        const txid = await broadcast_v2_transaction(
          config.peerUrl, getGenesisHex(net), JSON.stringify([txnObj]),
          config.certHash || undefined
        );
        try {
          addToMempool(net, [{
            id: txid,
            inputs: (txnObj.siacoinInputs || []).map(inp => ({ address: inp.parent?.siacoinOutput?.address || '', value: inp.parent?.siacoinOutput?.value || '0', outputId: inp.parent?.id || '' })),
            outputs: (txnObj.siacoinOutputs || []).map(out => ({ address: out.address || '', value: out.value || '0', outputId: '' })),
            minerFee: txnObj.minerFee || '0',
            attestations: txnObj.attestations || [],
            rawJson: txnJson,
          }], 0, '');
          walletApplyMempool();
          txbRefreshFromMempool();
        } catch (e2) { console.warn('mempool add failed:', e2); }

        mfstLog('Manifest attestation broadcast! TxID: ' + txid, 'ok');
        statusEl.style.color = '#4ade80';
        statusEl.textContent = 'Manifest saved on-chain.';
        broadcastBtn.style.display = 'none';
      } catch (e) {
        mfstLog('Broadcast failed: ' + e, 'err');
        broadcastBtn.textContent = 'Retry Broadcast';
        broadcastBtn.disabled = false;
      }
    });
  } catch (e) {
    mfstLog('Save on-chain error: ' + e, 'err');
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Failed: ' + e;
  }
}

// Event listeners
document.getElementById('btn-mfst-unlock').addEventListener('click', mfstUnlock);
document.getElementById('mfst-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mfstUnlock();
});
document.getElementById('btn-mfst-build').addEventListener('click', mfstBuildTransaction);
document.getElementById('btn-mfst-backup').addEventListener('click', mfstBackup);
document.getElementById('btn-mfst-copy-url').addEventListener('click', () => {
  const url = document.getElementById('mfst-backup-share-url').textContent;
  navigator.clipboard.writeText(url).then(() => mfstLog('Share URL copied to clipboard.', 'ok'));
});
document.getElementById('btn-mfst-save-onchain').addEventListener('click', mfstSaveOnChain);
document.getElementById('mfst-restore-mode').addEventListener('change', () => {
  const mode = document.getElementById('mfst-restore-mode').value;
  document.getElementById('mfst-restore-url').style.display = mode === 'url' ? '' : 'none';
});
document.getElementById('btn-mfst-restore').addEventListener('click', () => {
  const mode = document.getElementById('mfst-restore-mode').value;
  if (mode === 'url') {
    mfstRestoreFromUrl();
  } else {
    mfstRestoreFromManifest();
  }
});
document.getElementById('btn-mfst-resolve').addEventListener('click', mfstResolve);
document.getElementById('btn-mfst-copy').addEventListener('click', () => {
  const json = document.getElementById('mfst-txn-json').textContent;
  navigator.clipboard.writeText(json).then(() => mfstLog('Copied to clipboard.', 'ok'));
});
document.getElementById('btn-mfst-clear-log').addEventListener('click', () => {
  document.getElementById('mfst-log').innerHTML = '';
});
document.getElementById('mfst-type').addEventListener('change', mfstUpdateTypeFields);
document.getElementById('mfst-resolve-type').addEventListener('change', mfstUpdateResolveFields);
document.getElementById('mfst-account').addEventListener('change', () => {
  if (getWalletEntropy()) mfstDerive();
});
mfstUpdateResolveFields();
mfstUpdateUI();

// Update manifest page when wallet state changes (unlock/lock from wallet page)
// Poll every 500ms since wallet unlock can happen from the wallet tab
setInterval(() => {
  const statusEl = document.getElementById('mfst-wallet-status');
  if (!statusEl) return;
  const isUnlocked = !!getWalletEntropy();
  const showsUnlocked = statusEl.innerHTML.includes('Unlocked');
  if (isUnlocked !== showsUnlocked) mfstUpdateUI();
}, 500);

// Expose for wallet.js transaction builder (avoids circular import)
window.mfstFindNextIndex = mfstFindNextIndex;

