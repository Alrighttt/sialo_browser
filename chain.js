// chain.js — Singleton chain service
// Owns all blockchain state (network, filters, txindex, peer config)
// and syncer WASM functions. DOM-free — panels manage their own UI.
// Supports multi-network background sync.

const GENESIS_IDS = {
  mainnet: '25f6e3b9295a61f69fcb956aca9f0076234ecf2e02d399db5448b6e22f26e81c',
  mainnet_v2: '25f6e3b9295a61f69fcb956aca9f0076234ecf2e02d399db5448b6e22f26e81c',
  zen: '172fb3d508c86ac628f93c3362ba60312251466c77d63a8c99ea87717e4112c3',
};

const DEFAULT_URLS = {
  mainnet: 'https://localhost:9984/sia/syncer',
  mainnet_v2: 'https://localhost:9984/sia/syncer',
  zen: 'https://localhost:9985/sia/syncer',
};

const V2_REQUIRE_HEIGHTS = { mainnet: 530000, mainnet_v2: 530000, zen: 50 };

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_INTERVAL_RELAY_MS = 30 * 60 * 1000; // 30 minutes when relay is connected

// --- State ---

let _wasm = null;
let _listeners = [];

// Active network = the one the UI is viewing (explorer, etc.)
let _activeNetwork = localStorage.getItem('chain:activeNetwork')
  || localStorage.getItem('chain:network') // migrate old key
  || 'mainnet';

// Per-network config: { peerUrl, certHash, enabled }
let _networks = loadNetworkConfigs();

// Filter/txindex/utxoindex/attestationindex blob URLs for the active network
let _filterBlobUrl = null;
let _filterType = null; // 'v2' | 'all' | null
let _txindexBlobUrl = null;
let _utxoindexBlobUrl = null;
let _attestationindexBlobUrl = null;
let _utxoPrefixes = null;   // Sorted Uint8Array of unique 8-byte address prefixes from SUXI
let _utxoPrefixCount = 0;

// Per-network sync state: { status, error, lastSync, lastMsg }
let _syncState = {};
let _syncInterval = null;
let _syncRunning = false; // guard against overlapping cycles
let _syncLogListeners = []; // (net, msg, cls) => void
let _syncWorkers = {}; // Per-network active sync worker reference

// Per-network mempool: { [net]: { [txid]: { id, inputs, outputs, minerFee, timestamp, height, blockId } } }
let _mempool = (() => {
  try { return JSON.parse(localStorage.getItem('chain:mempool') || '{}'); }
  catch (_) { return {}; }
})();
let _mempoolListeners = []; // (net, mempool) => void

function _saveMempool() {
  try { localStorage.setItem('chain:mempool', JSON.stringify(_mempool)); }
  catch (_) {}
}

// Per-network relay listener state: { running, reconnectTimer }
let _relayListeners = {};

// --- IndexedDB helpers ---

function filterDbLoad(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_filters', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const tx = req.result.transaction('files', 'readonly');
      const get = tx.objectStore('files').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result || null); };
      get.onerror = () => { req.result.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function syncerDbLoad(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readonly');
      const get = tx.objectStore('cache').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result || null); };
      get.onerror = () => { req.result.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function syncerDbSave(key, data) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readwrite');
      tx.objectStore('cache').put(data, key);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => { req.result.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function syncerDbDelete(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readwrite');
      const del = tx.objectStore('cache').delete(key);
      del.onsuccess = () => { req.result.close(); resolve(); };
      del.onerror = () => { req.result.close(); reject(del.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function filterDbDelete(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_filters', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const tx = req.result.transaction('files', 'readwrite');
      const del = tx.objectStore('files').delete(key);
      del.onsuccess = () => { req.result.close(); resolve(); };
      del.onerror = () => { req.result.close(); reject(del.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function netKey(net, key) {
  return net + ':' + key;
}

// mainnet_v2 shares mainnet's genesis ID, so WASM writes to "mainnet:..." keys.
// This maps the JS network name to the WASM-compatible IndexedDB key prefix.
function wasmNetKey(net, key) {
  const prefix = (net === 'mainnet_v2') ? 'mainnet' : net;
  return prefix + ':' + key;
}

export function isV2Network(net) { return net === 'mainnet_v2'; }

// Returns the specific IndexedDB keys each network uses (no cross-pollination).
function networkDataKeys(net) {
  if (net === 'mainnet_v2') {
    return {
      filter: wasmNetKey(net, 'filter_entries_v2'),
      filterLegacy: wasmNetKey(net, 'filters_v2'),
      txindex: wasmNetKey(net, 'txindex_entries_v2'),
      txindexCheckpoint: wasmNetKey(net, 'txindex_entries_v2_checkpoint'),
      txindexLegacy: wasmNetKey(net, 'txindex_v2'),
      headers: wasmNetKey(net, 'header_ids_v2'),
      utxoindex: wasmNetKey(net, 'utxoindex_v2'),
      attestationindex: wasmNetKey(net, 'attestationindex_v2'),
    };
  }
  return {
    filter: netKey(net, 'filter_entries'),
    filterLegacy: netKey(net, 'filters_all'),
    txindex: netKey(net, 'txindex_entries'),
    txindexCheckpoint: null,
    txindexLegacy: null,
    headers: netKey(net, 'header_ids'),
    utxoindex: netKey(net, 'utxoindex'),
    attestationindex: netKey(net, 'attestationindex'),
  };
}

// --- Persist helpers ---

function loadNetworkConfigs() {
  const saved = localStorage.getItem('chain:networks');
  if (saved) {
    try {
      const configs = JSON.parse(saved);
      // Migration: add mainnet_v2 if it doesn't exist yet
      if (!configs.mainnet_v2) {
        configs.mainnet_v2 = {
          peerUrl: configs.mainnet?.peerUrl || DEFAULT_URLS.mainnet_v2,
          certHash: configs.mainnet?.certHash || null,
          enabled: false,
        };
        // If mainnet was in V2 mode, transfer its state to mainnet_v2
        if (configs.mainnet?.syncMode === 'v2') {
          configs.mainnet_v2.enabled = configs.mainnet.enabled;
          configs.mainnet_v2.peerUrl = configs.mainnet.peerUrl;
          configs.mainnet_v2.certHash = configs.mainnet.certHash;
          configs.mainnet.enabled = false;
        }
      }
      // Strip syncMode from all configs (no longer used)
      for (const net of Object.keys(configs)) {
        delete configs[net].syncMode;
      }
      saveNetworkConfigs(configs);
      return configs;
    } catch (e) { /* fall through */ }
  }
  // Migrate from old single-network keys if present
  const oldPeer = localStorage.getItem('chain:peerUrl');
  const oldCert = localStorage.getItem('chain:certHash');
  const oldNet = localStorage.getItem('chain:network') || 'mainnet';
  const configs = {
    mainnet: { peerUrl: DEFAULT_URLS.mainnet, certHash: null, enabled: false },
    mainnet_v2: { peerUrl: DEFAULT_URLS.mainnet_v2, certHash: null, enabled: false },
    zen: { peerUrl: DEFAULT_URLS.zen, certHash: null, enabled: false },
  };
  if (oldPeer) configs[oldNet].peerUrl = oldPeer;
  if (oldCert) configs[oldNet].certHash = oldCert;
  saveNetworkConfigs(configs);
  return configs;
}

function saveNetworkConfigs(configs) {
  localStorage.setItem('chain:networks', JSON.stringify(configs || _networks));
}

// --- Notify listeners (throttled during sync) ---

let _notifyTimer = null;
let _notifyPending = false;

function _notify() {
  if (_syncRunning) {
    // Throttle during sync to avoid flooding UI updates
    _notifyPending = true;
    if (!_notifyTimer) {
      _notifyTimer = setTimeout(() => {
        _notifyTimer = null;
        if (_notifyPending) {
          _notifyPending = false;
          _notifyImmediate();
        }
      }, 250);
    }
  } else {
    _notifyImmediate();
  }
}

function _notifyImmediate() {
  for (const fn of _listeners) {
    try { fn(); } catch (e) { console.error('chain.js listener error:', e); }
  }
}

// --- Public API: Multi-network config ---

export function getNetworkConfig(net) {
  return _networks[net] || { peerUrl: DEFAULT_URLS[net] || '', certHash: null, enabled: false };
}

export function setNetworkConfig(net, config) {
  _networks[net] = { ...(_networks[net] || {}), ...config };
  saveNetworkConfigs();
  _notify();
}

export function getEnabledNetworks() {
  return Object.keys(_networks).filter(n => _networks[n].enabled && _networks[n].peerUrl);
}

export function getActiveNetwork() { return _activeNetwork; }

export async function setActiveNetwork(net) {
  if (net === _activeNetwork) return;
  _activeNetwork = net;
  localStorage.setItem('chain:activeNetwork', net);
  await loadFilters();
  _notify();
}

// --- Public API: Backward-compat config accessors (operate on active network) ---

export function getNetwork() { return _activeNetwork; }

export function setNetwork(net) {
  setActiveNetwork(net);
}

export function getPeerUrl() {
  return getNetworkConfig(_activeNetwork).peerUrl;
}

export function setPeerUrl(url) {
  setNetworkConfig(_activeNetwork, { peerUrl: url });
}

export function getCertHash() {
  return getNetworkConfig(_activeNetwork).certHash;
}

export function setCertHash(hash) {
  setNetworkConfig(_activeNetwork, { certHash: hash || null });
}

export function getGenesisHex(net) {
  return GENESIS_IDS[net || _activeNetwork] || GENESIS_IDS.mainnet;
}

export function getDefaultUrl(net) {
  return DEFAULT_URLS[net || _activeNetwork];
}

// --- Public API: Filter/TxIndex state (for active network) ---

export function getFilterUrl() { return _filterBlobUrl; }
export function getFilterType() { return _filterType; }
export function getTxindexUrl() { return _txindexBlobUrl; }
export function getUtxoIndexUrl() { return _utxoindexBlobUrl; }
export function getAttestationIndexUrl() { return _attestationindexBlobUrl; }
export function isReady() { return !!_filterBlobUrl; }
export function getUtxoPrefixCount() { return _utxoPrefixCount; }

// UTXO pre-filter: O(log N) binary search on sorted unique address prefixes
export function checkUtxoPrefilter(addressHex) {
  if (!_utxoPrefixes || _utxoPrefixCount === 0) return false;
  // Parse first 8 bytes of address hex
  const hex = addressHex.length > 16 ? addressHex.slice(0, 16) : addressHex;
  const target = new Uint8Array(8);
  for (let i = 0; i < 8; i++) target[i] = parseInt(hex.substr(i * 2, 2), 16);

  let lo = 0, hi = _utxoPrefixCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const off = mid * 8;
    let cmp = 0;
    for (let i = 0; i < 8; i++) {
      cmp = _utxoPrefixes[off + i] - target[i];
      if (cmp !== 0) break;
    }
    if (cmp < 0) lo = mid + 1;
    else if (cmp > 0) hi = mid;
    else return true;
  }
  return false;
}

// --- Public API: Storage sizes ---

function getDbEntrySize(dbName, storeName, key) {
  return new Promise((resolve) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => {
      const tx = req.result.transaction(storeName, 'readonly');
      const get = tx.objectStore(storeName).get(key);
      get.onsuccess = () => {
        req.result.close();
        const val = get.result;
        if (!val) { resolve(0); return; }
        if (val.byteLength !== undefined) { resolve(val.byteLength); return; }
        if (val.length !== undefined) { resolve(val.length); return; }
        resolve(0);
      };
      get.onerror = () => { req.result.close(); resolve(0); };
    };
    req.onerror = () => resolve(0);
  });
}

export async function getStorageSizes(net) {
  const keys = networkDataKeys(net);
  const [headers, filters, filtersLegacy, txindex, txindexLegacy, utxoindex, attestationindex] = await Promise.all([
    getDbEntrySize('sia_syncer', 'cache', keys.headers),
    getDbEntrySize('sia_syncer', 'cache', keys.filter),
    keys.filterLegacy ? getDbEntrySize('sia_filters', 'files', keys.filterLegacy) : 0,
    getDbEntrySize('sia_syncer', 'cache', keys.txindex),
    keys.txindexLegacy ? getDbEntrySize('sia_filters', 'files', keys.txindexLegacy) : 0,
    getDbEntrySize('sia_syncer', 'cache', keys.utxoindex),
    getDbEntrySize('sia_syncer', 'cache', keys.attestationindex),
  ]);
  return {
    headers,
    filters: filters + filtersLegacy,
    txindex: txindex + (txindexLegacy || 0),
    utxoindex,
    attestationindex,
    total: headers + filters + filtersLegacy + txindex + (txindexLegacy || 0) + utxoindex + attestationindex,
  };
}

// --- Public API: Clear cached data ---

export async function clearFilters(net) {
  const n = net || _activeNetwork;
  const keys = networkDataKeys(n);
  const deletes = [syncerDbDelete(keys.filter)];
  if (keys.filterLegacy) deletes.push(filterDbDelete(keys.filterLegacy));
  await Promise.all(deletes);
  if (n === _activeNetwork) await loadFilters();
}

export async function clearTxindex(net) {
  const n = net || _activeNetwork;
  const keys = networkDataKeys(n);
  const deletes = [syncerDbDelete(keys.txindex)];
  if (keys.txindexCheckpoint) deletes.push(syncerDbDelete(keys.txindexCheckpoint));
  if (keys.txindexLegacy) deletes.push(filterDbDelete(keys.txindexLegacy));
  await Promise.all(deletes);
  if (n === _activeNetwork) await loadFilters();
}

export async function clearUtxoIndex(net) {
  const n = net || _activeNetwork;
  const keys = networkDataKeys(n);
  await syncerDbDelete(keys.utxoindex);
}

export async function clearAllData(net) {
  await clearFilters(net);
  await clearTxindex(net);
  await clearUtxoIndex(net);
  const n = net || _activeNetwork;
  const keys = networkDataKeys(n);
  await Promise.all([
    syncerDbDelete(keys.headers),
    syncerDbDelete(keys.attestationindex),
  ]);
  if (n === _activeNetwork) await loadFilters();
}

// Clear filters+txindex then re-sync from scratch
export async function rebuildFilters(net) {
  const n = net || _activeNetwork;
  await clearFilters(n);
  await clearTxindex(n);
  await clearUtxoIndex(n);
  await syncerDbDelete(networkDataKeys(n).attestationindex);
  // Temporarily enable if not enabled
  if (!_networks[n]?.enabled) {
    setNetworkConfig(n, { enabled: true });
  }
  syncNetwork(n);
}

// Clear only block filters then re-sync (regenerates filters, txindex untouched)
export async function regenerateFilters(net) {
  const n = net || _activeNetwork;
  await clearFilters(n);
  if (!_networks[n]?.enabled) {
    setNetworkConfig(n, { enabled: true });
  }
  return syncNetwork(n);
}

// Clear only txindex then re-sync (regenerates txindex, filters untouched)
export async function regenerateTxindex(net) {
  const n = net || _activeNetwork;
  await clearTxindex(n);
  if (!_networks[n]?.enabled) {
    setNetworkConfig(n, { enabled: true });
  }
  return syncNetwork(n);
}

// Clear only utxoindex then re-sync (regenerates utxoindex, filters+txindex untouched)
export async function regenerateUtxoIndex(net) {
  const n = net || _activeNetwork;
  await clearUtxoIndex(n);
  if (!_networks[n]?.enabled) {
    setNetworkConfig(n, { enabled: true });
  }
  return syncNetwork(n);
}

// Stop all operations for a network: disable auto-sync, stop relay, reset state
export function stopNetwork(net) {
  const n = net || _activeNetwork;
  // Disable auto-sync
  if (_networks[n]) {
    _networks[n].enabled = false;
    saveNetworkConfigs();
  }
  // Stop relay listener
  stopRelayListener(n);
  // Terminate active sync worker if running
  if (_syncWorkers[n]) {
    _syncWorkers[n].terminate();
    delete _syncWorkers[n];
  }
  _syncState[n] = { status: 'idle', phase: null, error: null, lastMsg: null };
  // Stop sync interval if no networks remain enabled
  if (getEnabledNetworks().length === 0) {
    stopSync();
  }
  _notify();
}

// --- Public API: Export/Import all sync data for a network ---

// Pack all sync data for a network into a single Uint8Array.
// Format: [magic:4][version:1][entryCount:2][...entries]
// Each entry: [keyLen:2][key:keyLen][dataLen:4][data:dataLen]
const BACKUP_MAGIC = new Uint8Array([0x53, 0x42, 0x4B, 0x50]); // "SBKP"
const BACKUP_VERSION = 1;

export async function exportNetworkData(net) {
  const keys = networkDataKeys(net);
  const keyNames = ['filter', 'txindex', 'utxoindex', 'attestationindex', 'headers'];
  const entries = [];

  for (const name of keyNames) {
    const dbKey = keys[name];
    if (!dbKey) continue;
    const data = await syncerDbLoad(dbKey);
    if (!data || !(data instanceof ArrayBuffer || data instanceof Uint8Array || ArrayBuffer.isView(data))) continue;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    if (bytes.length === 0) continue;
    entries.push({ name, bytes });
  }

  // Calculate total size
  let totalSize = 4 + 1 + 2; // magic + version + entry count
  for (const e of entries) {
    totalSize += 2 + e.name.length + 4 + e.bytes.length;
  }

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let pos = 0;

  buf.set(BACKUP_MAGIC, pos); pos += 4;
  buf[pos++] = BACKUP_VERSION;
  view.setUint16(pos, entries.length, true); pos += 2;

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    view.setUint16(pos, nameBytes.length, true); pos += 2;
    buf.set(nameBytes, pos); pos += nameBytes.length;
    view.setUint32(pos, e.bytes.length, true); pos += 4;
    buf.set(e.bytes, pos); pos += e.bytes.length;
  }

  return buf;
}

export async function importNetworkData(net, packed) {
  const arr = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);

  // Validate magic
  if (arr[0] !== 0x53 || arr[1] !== 0x42 || arr[2] !== 0x4B || arr[3] !== 0x50) {
    throw new Error('Invalid backup: wrong magic bytes');
  }
  const version = arr[4];
  if (version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup version: ' + version);
  }

  const entryCount = view.getUint16(5, true);
  const keys = networkDataKeys(net);
  let pos = 7;

  for (let i = 0; i < entryCount; i++) {
    const nameLen = view.getUint16(pos, true); pos += 2;
    const name = new TextDecoder().decode(arr.subarray(pos, pos + nameLen)); pos += nameLen;
    const dataLen = view.getUint32(pos, true); pos += 4;
    const data = arr.slice(pos, pos + dataLen); pos += dataLen;

    const dbKey = keys[name];
    if (dbKey) {
      await syncerDbSave(dbKey, data);
    }
  }

  // Reload filters if this is the active network
  if (net === _activeNetwork) await loadFilters();
}

// --- Public API: Load filters from IndexedDB (for active network) ---

export async function loadFilters() {
  // Clean up old blob URLs
  if (_filterBlobUrl) { URL.revokeObjectURL(_filterBlobUrl); _filterBlobUrl = null; }
  if (_txindexBlobUrl) { URL.revokeObjectURL(_txindexBlobUrl); _txindexBlobUrl = null; }
  if (_utxoindexBlobUrl) { URL.revokeObjectURL(_utxoindexBlobUrl); _utxoindexBlobUrl = null; }
  if (_attestationindexBlobUrl) { URL.revokeObjectURL(_attestationindexBlobUrl); _attestationindexBlobUrl = null; }
  _utxoPrefixes = null; _utxoPrefixCount = 0;
  _filterType = null;

  const net = _activeNetwork;
  const keys = networkDataKeys(net);

  // Load filter data: try WASM-generated key, then legacy
  let filterData = null;
  const syncerFilter = await syncerDbLoad(keys.filter);
  if (syncerFilter && syncerFilter.byteLength > 0) {
    filterData = syncerFilter;
  } else if (keys.filterLegacy) {
    const legacyFilter = await filterDbLoad(keys.filterLegacy);
    if (legacyFilter && legacyFilter.byteLength > 0) {
      filterData = legacyFilter;
    }
  }

  if (filterData) {
    _filterType = isV2Network(net) ? 'v2' : 'all';
    _filterBlobUrl = URL.createObjectURL(new Blob([filterData], { type: 'application/octet-stream' }));
  }

  // Load txindex data
  let txdata = await syncerDbLoad(keys.txindex);
  if ((!txdata || !txdata.byteLength) && keys.txindexLegacy) {
    txdata = await filterDbLoad(keys.txindexLegacy);
  }
  if (txdata && txdata.byteLength > 0) {
    _txindexBlobUrl = URL.createObjectURL(new Blob([txdata], { type: 'application/octet-stream' }));
  }

  // Load utxoindex data
  const utxodata = await syncerDbLoad(keys.utxoindex);
  if (utxodata && utxodata.byteLength > 0) {
    _utxoindexBlobUrl = URL.createObjectURL(new Blob([utxodata], { type: 'application/octet-stream' }));

    // Extract sorted unique address prefixes for pre-filter
    const arr = new Uint8Array(utxodata instanceof ArrayBuffer ? utxodata : utxodata.buffer || utxodata);
    if (arr.length >= 16 && arr[0] === 0x53 && arr[1] === 0x55 && arr[2] === 0x58 && arr[3] === 0x49) {
      const dv = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      const count = dv.getUint32(8, true);
      const prefixes = [];
      let prevA = -1, prevB = -1;
      for (let i = 0; i < count; i++) {
        const off = 16 + i * 20;
        const a = dv.getUint32(off, true);
        const b = dv.getUint32(off + 4, true);
        if (a !== prevA || b !== prevB) {
          prefixes.push(off);
          prevA = a; prevB = b;
        }
      }
      _utxoPrefixes = new Uint8Array(prefixes.length * 8);
      for (let i = 0; i < prefixes.length; i++) {
        _utxoPrefixes.set(arr.subarray(prefixes[i], prefixes[i] + 8), i * 8);
      }
      _utxoPrefixCount = prefixes.length;
    }
  }

  // Load attestation index data
  const attdata = await syncerDbLoad(keys.attestationindex);
  if (attdata && attdata.byteLength > 0) {
    _attestationindexBlobUrl = URL.createObjectURL(new Blob([attdata], { type: 'application/octet-stream' }));
  }

  _notify();
}

// --- Public API: WASM operations ---

export async function exploreAddress(addr, logFn) {
  if (!_filterBlobUrl) throw new Error('No filters loaded');
  const config = getNetworkConfig(_activeNetwork);
  if (!config.peerUrl) throw new Error('No peer URL configured');

  const resultJson = await _wasm.scan_balance_filtered(
    config.peerUrl, getGenesisHex(), addr, _filterBlobUrl,
    logFn || (() => {}),
    config.certHash || undefined,
    1000
  );
  return JSON.parse(resultJson);
}

export async function exploreAddressUnlimited(addr, logFn) {
  if (!_filterBlobUrl) throw new Error('No filters loaded');
  const config = getNetworkConfig(_activeNetwork);
  if (!config.peerUrl) throw new Error('No peer URL configured');

  const resultJson = await _wasm.scan_balance_filtered(
    config.peerUrl, getGenesisHex(), addr, _filterBlobUrl,
    logFn || (() => {}),
    config.certHash || undefined,
    null
  );
  return JSON.parse(resultJson);
}

export async function lookupTransaction(txid, logFn) {
  if (!_txindexBlobUrl) throw new Error('No txindex loaded');
  const config = getNetworkConfig(_activeNetwork);
  if (!config.peerUrl) throw new Error('No peer URL configured');

  const resultJson = await _wasm.lookup_txid(
    config.peerUrl, getGenesisHex(), txid, _txindexBlobUrl,
    logFn || (() => {}),
    config.certHash || undefined
  );

  if (resultJson === 'not_found') return null;
  return JSON.parse(resultJson);
}

export async function exploreQuery(query, logFn) {
  const config = getNetworkConfig(_activeNetwork);
  if (!config.peerUrl) throw new Error('No peer URL configured. Set one in the Syncer page.');

  const resultJson = await _wasm.explore_query(
    config.peerUrl, getGenesisHex(), query,
    _txindexBlobUrl || undefined,
    logFn || (() => {}),
    config.certHash || undefined
  );

  return JSON.parse(resultJson);
}

export async function lookupUtxos(address, logFn) {
  if (!_utxoindexBlobUrl) throw new Error('No UTXO index loaded');
  const config = getNetworkConfig(_activeNetwork);
  if (!config.peerUrl) throw new Error('No peer URL configured');

  const resultJson = await _wasm.lookup_utxos(
    config.peerUrl, getGenesisHex(), address, _utxoindexBlobUrl,
    logFn || (() => {}),
    config.certHash || undefined
  );

  return JSON.parse(resultJson);
}

// --- Public API: Attestation Index ---

// Load and parse the raw SAPI binary. Returns array of {pubkeyHex, keyHashHex, height}.
export async function loadAttestationEntries() {
  if (!_attestationindexBlobUrl) return [];
  const resp = await fetch(_attestationindexBlobUrl);
  const buf = await resp.arrayBuffer();
  const arr = new Uint8Array(buf);
  if (arr.length < 16) return [];
  // Validate magic "SAPI"
  if (arr[0] !== 0x53 || arr[1] !== 0x41 || arr[2] !== 0x50 || arr[3] !== 0x49) return [];
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const count = view.getUint32(8, true);
  const entries = [];
  let pos = 16;
  for (let i = 0; i < count; i++) {
    const pubkeyHex = bytesToHex(arr, pos, 32); pos += 32;
    const keyHashHex = bytesToHex(arr, pos, 8); pos += 8;
    const height = view.getUint32(pos, true); pos += 4;
    entries.push({ pubkeyHex, keyHashHex, height });
  }
  return entries;
}

function bytesToHex(arr, offset, len) {
  let hex = '';
  for (let i = 0; i < len; i++) {
    hex += arr[offset + i].toString(16).padStart(2, '0');
  }
  return hex;
}

// --- Public API: Mempool ---

export function getMempool(net) {
  net = net || _activeNetwork;
  return _mempool[net] || {};
}

export function getMempoolTransactions(net) {
  const pool = getMempool(net);
  return Object.values(pool).sort((a, b) => b.timestamp - a.timestamp);
}

export function onMempoolChange(callback) {
  _mempoolListeners.push(callback);
  return () => { _mempoolListeners = _mempoolListeners.filter(fn => fn !== callback); };
}

function _addToMempool(net, transactions, height, blockId) {
  if (!_mempool[net]) _mempool[net] = {};
  let added = 0;
  for (const txn of transactions) {
    if (!_mempool[net][txn.id]) {
      _mempool[net][txn.id] = {
        ...txn,
        timestamp: Date.now(),
        height,
        blockId,
      };
      added++;
    }
  }
  if (added > 0) {
    _saveMempool();
    for (const fn of _mempoolListeners) {
      try { fn(net, _mempool[net]); } catch (e) { console.error('mempool listener error:', e); }
    }
  }
  return added;
}

function _removeFromMempool(net, txids) {
  if (!_mempool[net]) return 0;
  let removed = 0;
  for (const txid of txids) {
    if (_mempool[net][txid]) {
      delete _mempool[net][txid];
      removed++;
    }
  }
  if (removed > 0) {
    _saveMempool();
    for (const fn of _mempoolListeners) {
      try { fn(net, _mempool[net]); } catch (e) { console.error('mempool listener error:', e); }
    }
  }
  return removed;
}

export function addToMempool(net, transactions, height, blockId) {
  return _addToMempool(net || _activeNetwork, transactions, height || 0, blockId || '');
}

export function clearMempool(net) {
  _mempool[net || _activeNetwork] = {};
  _saveMempool();
  for (const fn of _mempoolListeners) {
    try { fn(net || _activeNetwork, {}); } catch (e) { console.error('mempool listener error:', e); }
  }
}

// Check mempool txids against the txindex to find confirmed transactions.
// The txindex is a sorted array of 12-byte entries: txid_prefix[8] + height[4].
async function _findConfirmedTxids(net) {
  const pool = _mempool[net];
  if (!pool || !_txindexBlobUrl) return [];

  const resp = await fetch(_txindexBlobUrl);
  const buf = await resp.arrayBuffer();
  const data = new Uint8Array(buf);

  // Validate header: "STXI" + version(4) + count(4) + tip_height(4)
  if (data.length < 16) return [];
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== 'STXI') return [];
  const count = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24); // LE u32 at offset 4.. wait

  // Re-check: magic(4) + version(4) + count(4) + tip_height(4)
  const dv = new DataView(buf);
  const version = dv.getUint32(4, true);
  if (version !== 1) return [];
  const entryCount = dv.getUint32(8, true);
  const headerSize = 16;
  const entrySize = 12; // 8-byte prefix + 4-byte height

  const confirmed = [];
  for (const txid of Object.keys(pool)) {
    // Convert first 8 bytes of txid hex to a prefix
    const prefixHex = txid.slice(0, 16); // 8 bytes = 16 hex chars
    if (prefixHex.length < 16) continue;
    const prefix = new Uint8Array(8);
    for (let i = 0; i < 8; i++) prefix[i] = parseInt(prefixHex.slice(i * 2, i * 2 + 2), 16);

    // Binary search
    let lo = 0, hi = entryCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const off = headerSize + mid * entrySize;
      let cmp = 0;
      for (let i = 0; i < 8; i++) {
        cmp = data[off + i] - prefix[i];
        if (cmp !== 0) break;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }

    if (lo < entryCount) {
      const off = headerSize + lo * entrySize;
      let match = true;
      for (let i = 0; i < 8; i++) {
        if (data[off + i] !== prefix[i]) { match = false; break; }
      }
      if (match) confirmed.push(txid);
    }
  }
  return confirmed;
}

// --- Public API: Access raw WASM functions (for advanced panels) ---

export function getWasm() { return _wasm; }

// --- Public API: Subscribe to state changes ---

export function onChange(callback) {
  _listeners.push(callback);
  return () => {
    _listeners = _listeners.filter(fn => fn !== callback);
  };
}

// --- Background Sync ---

export function getSyncState(net) {
  return _syncState[net || _activeNetwork] || { status: 'idle' };
}

export function isSyncing() {
  return Object.values(_syncState).some(s => s.status === 'syncing');
}

export function onSyncLog(callback) {
  _syncLogListeners.push(callback);
  return () => { _syncLogListeners = _syncLogListeners.filter(fn => fn !== callback); };
}

function _emitSyncLog(net, msg, cls) {
  for (const fn of _syncLogListeners) {
    try { fn(net, msg, cls); } catch (e) { console.error('syncLog listener error:', e); }
  }
}

// --- Relay Listener ---

async function startRelayListener(net) {
  const config = _networks[net];
  if (!config || !config.peerUrl || !config.enabled) return;
  if (_relayListeners[net]?.running) return;

  _relayListeners[net] = { running: true, reconnectTimer: null };
  _emitSyncLog(net, 'Relay listener connecting...', 'info');
  _notifyImmediate();

  let syncDebounce = null;

  const onEvent = (eventType, eventJson) => {
    // Log status events (for debugging relay connection), skip noise
    if (eventType === 'status') {
      _emitSyncLog(net, 'Relay: status ' + eventJson, 'data');
    } else {
      _emitSyncLog(net, 'Relay: ' + eventType + ' ' + eventJson, 'data');
    }

    // Add relayed transactions to mempool
    if (eventType === 'relay_txns') {
      try {
        const data = JSON.parse(eventJson);
        if (data.transactions && data.transactions.length > 0) {
          const added = _addToMempool(net, data.transactions, data.height, data.blockId);
          if (added > 0) {
            _emitSyncLog(net, `Mempool: +${added} txn(s), ${Object.keys(_mempool[net] || {}).length} total`, 'data');
          }
        }
      } catch (e) {
        console.error('Failed to parse relay_txns:', e);
      }
    }

    // Remove confirmed transactions from mempool when a new block arrives
    if (eventType === 'relay_header' || eventType === 'relay_block') {
      // Block confirmation — clear matching txids after sync completes
      // (we don't know which txids are in the block from the header alone,
      //  but the sync will rebuild filters; for now, age out stale entries)
    }

    // Only trigger re-sync for events that indicate new chain data
    const syncTriggers = ['relay_header', 'relay_block', 'relay_txns'];
    if (!syncTriggers.includes(eventType)) return;

    // Debounce: wait 2s after last relay event, then trigger sync
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      syncDebounce = null;
      _emitSyncLog(net, 'Relay triggered re-sync', 'info');
      syncNetwork(net);
    }, 2000);
  };

  try {
    const genesisHex = GENESIS_IDS[net];
    await _wasm.listen_for_relays(
      config.peerUrl, genesisHex, onEvent,
      config.certHash || undefined
    );
    // Returned = disconnected
    _emitSyncLog(net, 'Relay listener disconnected', 'info');
  } catch (e) {
    _emitSyncLog(net, 'Relay listener error: ' + e, 'err');
  }

  _relayListeners[net].running = false;
  _notifyImmediate();

  // Auto-reconnect after 10 seconds if still enabled
  if (_networks[net]?.enabled) {
    _relayListeners[net].reconnectTimer = setTimeout(() => {
      startRelayListener(net);
    }, 10000);
  }
}

function stopRelayListener(net) {
  if (_relayListeners[net]) {
    _relayListeners[net].running = false;
    if (_relayListeners[net].reconnectTimer) {
      clearTimeout(_relayListeners[net].reconnectTimer);
      _relayListeners[net].reconnectTimer = null;
    }
  }
}

export function getRelayState(net) {
  return _relayListeners[net || _activeNetwork] || { running: false };
}

function hasActiveRelay() {
  return Object.values(_relayListeners).some(r => r.running);
}

// --- Network sync via Web Workers ---

// Parse progress from WASM log messages and update sync state
function parseAndUpdateProgress(net, msg) {
  _syncState[net].lastMsg = msg;
  // Format: "  Blocks: {current} / ~{total} ({pct}%) | ..."
  const blockMatch = msg.match(/Blocks:\s*(\d+)\s*\/\s*~?(\d+)/);
  if (blockMatch) {
    _syncState[net].currentHeight = parseInt(blockMatch[1]);
    _syncState[net].networkHeight = parseInt(blockMatch[2]);
  }
  // Format: "  Headers: {current} / ~{total}"
  const headerMatch = msg.match(/Headers:\s*(\d+)\s*\/\s*~(\d+)/);
  if (headerMatch) {
    _syncState[net].currentHeight = parseInt(headerMatch[1]);
    _syncState[net].networkHeight = parseInt(headerMatch[2]);
  }
  // Format: "Chain tip at height {N}" or "  Tip height:       {N}"
  const tipMatch = msg.match(/Chain tip at height (\d+)/) || msg.match(/Tip height:\s+(\d+)/);
  if (tipMatch) {
    const tipHeight = parseInt(tipMatch[1]);
    if (tipHeight > 0) {
      _syncState[net].currentHeight = tipHeight;
      _syncState[net].networkHeight = tipHeight;
    }
  }
}

// Runs a network sync in a dedicated Web Worker with its own WASM instance
function syncNetworkInWorker(net, config, genesisHex, v2, startHeight) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./network-sync-worker.js', { type: 'module' });
    _syncWorkers[net] = worker;

    worker.onmessage = (e) => {
      switch (e.data.type) {
        case 'ready':
          worker.postMessage({
            type: 'sync', net,
            peerUrl: config.peerUrl,
            genesisHex,
            certHash: config.certHash || null,
            v2,
            startHeight: startHeight ? Number(startHeight) : null,
            filterKey: netKey(net, 'filter_entries'),
            txindexKey: netKey(net, 'txindex_entries'),
            utxoindexKey: netKey(net, 'utxoindex'),
            attestationKey: netKey(net, 'attestationindex'),
            numWorkers: parseInt(localStorage.getItem('sync-num-workers') || '10', 10) || 10,
          });
          break;
        case 'log':
          parseAndUpdateProgress(e.data.net, e.data.msg);
          _emitSyncLog(e.data.net, e.data.msg, e.data.cls);
          _notify();
          break;
        case 'phase':
          _syncState[e.data.net].phase = e.data.phase;
          _notifyImmediate();
          break;
        case 'progress':
          if (e.data.currentHeight != null) _syncState[e.data.net].currentHeight = e.data.currentHeight;
          if (e.data.networkHeight != null) _syncState[e.data.net].networkHeight = e.data.networkHeight;
          _notify();
          break;
        case 'done':
          delete _syncWorkers[net];
          worker.terminate();
          resolve();
          break;
        case 'error':
          delete _syncWorkers[net];
          worker.terminate();
          reject(new Error(e.data.error));
          break;
      }
    };

    worker.onerror = (e) => {
      delete _syncWorkers[net];
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage({ type: 'init', wasmUrl: './pkg/syncer_wasm_bg.wasm' });
  });
}

// --- Sync ---

async function syncNetwork(net) {
  const config = _networks[net];
  if (!config || !config.peerUrl || !config.enabled) return;

  const prev = _syncState[net] || {};
  if (prev.status === 'syncing') return; // already running

  // Preserve previous heights so the status bar doesn't flash "syncing" with no data
  _syncState[net] = {
    status: 'syncing', phase: 'filters', error: null, lastMsg: null,
    currentHeight: prev.currentHeight || null,
    networkHeight: prev.networkHeight || null,
  };
  _emitSyncLog(net, 'Starting sync...', 'info');
  _notify();

  const genesisHex = GENESIS_IDS[net];
  const v2 = isV2Network(net);
  const startHeight = v2 ? V2_REQUIRE_HEIGHTS[net] : undefined;

  try {
    await syncNetworkInWorker(net, config, genesisHex, v2, startHeight);

    const currentHeight = _syncState[net].currentHeight;
    const networkHeight = _syncState[net].networkHeight;
    const behind = currentHeight && networkHeight && currentHeight < networkHeight;
    _syncState[net] = {
      status: 'synced', phase: null, error: null, lastSync: Date.now(), lastMsg: null,
      currentHeight: behind ? currentHeight : networkHeight,
      networkHeight: networkHeight,
      needsCatchup: behind,
    };
    if (behind) {
      _emitSyncLog(net, 'Sync complete (behind: ' + currentHeight + '/' + networkHeight + ', will re-sync)', 'info');
    } else {
      _emitSyncLog(net, 'Sync complete', 'ok');
    }

    // Reload blob URLs if this is the active network
    if (net === _activeNetwork) await loadFilters();

    // Prune confirmed transactions from mempool by checking the txindex
    if (_mempool[net] && Object.keys(_mempool[net]).length > 0 && _txindexBlobUrl && net === _activeNetwork) {
      try {
        const confirmed = await _findConfirmedTxids(net);
        if (confirmed.length > 0) {
          _removeFromMempool(net, confirmed);
          _emitSyncLog(net, `Mempool: pruned ${confirmed.length} confirmed txn(s), ${Object.keys(_mempool[net]).length} remaining`, 'data');
        }
      } catch (e) { console.warn('mempool prune failed:', e); }
    }

    // Height-based pruning: if the chain tip has advanced 2+ blocks past when
    // a mempool entry was relayed, it's either confirmed or dropped by the network.
    // This covers cases where the STXI is incomplete or the network isn't active.
    const tipHeight = _syncState[net]?.currentHeight || _syncState[net]?.networkHeight || 0;
    if (_mempool[net] && Object.keys(_mempool[net]).length > 0 && tipHeight > 0) {
      const stale = Object.keys(_mempool[net]).filter(txid => {
        const entry = _mempool[net][txid];
        return entry.height && tipHeight - entry.height >= 2;
      });
      if (stale.length > 0) {
        _removeFromMempool(net, stale);
        _emitSyncLog(net, `Mempool: pruned ${stale.length} stale txn(s) (tip=${tipHeight}), ${Object.keys(_mempool[net]).length} remaining`, 'data');
      }
    }

    // Start relay listener if not already running
    if (!_relayListeners[net]?.running) {
      startRelayListener(net);
    }

  } catch (e) {
    console.error('chain.js sync error (' + net + '):', e);
    _syncState[net] = { status: 'error', phase: null, error: String(e), lastSync: Date.now(), lastMsg: null };
    _emitSyncLog(net, 'Sync error: ' + e, 'err');
  }
  _notifyImmediate();
}

async function runSyncCycle() {
  if (_syncRunning) return;
  _syncRunning = true;
  try {
    const enabled = getEnabledNetworks();
    // Sync networks sequentially — multiple simultaneous WebTransport
    // connections to the same peer can conflict at the browser level
    for (const net of enabled) {
      await syncNetwork(net);
    }
    // If any network is behind, schedule an immediate re-sync
    const needsCatchup = enabled.some(n => _syncState[n] && _syncState[n].needsCatchup);
    if (needsCatchup) {
      _syncRunning = false; // allow re-entry
      setTimeout(runSyncCycle, 1000); // brief delay before retry
      return;
    }
  } finally {
    _syncRunning = false;
  }
}

export function startSync() {
  if (_syncInterval) return;
  runSyncCycle(); // run immediately
  const interval = hasActiveRelay() ? SYNC_INTERVAL_RELAY_MS : SYNC_INTERVAL_MS;
  _syncInterval = setInterval(runSyncCycle, interval);
}

export function stopSync() {
  if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; }
  // Terminate all active sync workers
  for (const net of Object.keys(_syncWorkers)) {
    _syncWorkers[net].terminate();
    delete _syncWorkers[net];
  }
  // Stop all relay listeners
  for (const net of Object.keys(_relayListeners)) {
    stopRelayListener(net);
  }
}

export function syncNow(net, { restart = false } = {}) {
  if (net) {
    if (restart && _syncWorkers[net]) {
      _syncWorkers[net].terminate();
      delete _syncWorkers[net];
      _syncState[net] = { status: 'idle', phase: null, error: null, lastMsg: null };
      _notify();
    }
    syncNetwork(net);
  } else {
    runSyncCycle();
  }
}

// --- Initialization ---

export function init(wasmFunctions) {
  _wasm = wasmFunctions;
  loadFilters();

  // Auto-start sync if any networks are enabled
  if (getEnabledNetworks().length > 0) {
    startSync();
  }
}
