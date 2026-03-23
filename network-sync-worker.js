// Web Worker for per-network sync.
// Each network gets its own worker with an independent WASM instance,
// enabling all networks to sync in parallel.

import init, { sync_headers, generate_filters, generate_txindex }
  from './pkg/syncer_wasm.js';

const DEFAULT_NUM_WORKERS = 10;
const CHUNK_SIZE = 5000; // blocks per work unit — small chunks enable work-stealing

// --- IndexedDB helpers (same as chain.js, available in workers) ---

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

// --- Binary helpers ---

function comparePrefixes(a, b) {
  for (let i = 0; i < 8; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Sort N×16 byte records lexicographically using an index array.
// Returns a new sorted Uint8Array (does not modify input).
function sortBinary16Records(data) {
  const count = data.byteLength / 16;
  if (count <= 1) return data.slice();
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  indices.sort((a, b) => {
    const ao = a * 16, bo = b * 16;
    for (let j = 0; j < 16; j++) {
      if (data[ao + j] !== data[bo + j]) return data[ao + j] - data[bo + j];
    }
    return 0;
  });
  const sorted = new Uint8Array(data.byteLength);
  for (let i = 0; i < count; i++) {
    sorted.set(data.subarray(indices[i] * 16, indices[i] * 16 + 16), i * 16);
  }
  return sorted;
}

// Binary search for a 16-byte key in a flat sorted 16-byte-record array.
function spentContains(sortedSpent, key16) {
  let lo = 0, hi = (sortedSpent.byteLength / 16) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const off = mid * 16;
    let cmp = 0;
    for (let j = 0; j < 16; j++) {
      cmp = sortedSpent[off + j] - key16[j];
      if (cmp !== 0) break;
    }
    if (cmp === 0) return true;
    if (cmp < 0) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

// Generic min-heap k-way merge for fixed-size binary records.
// chunks: array of {bytes: Uint8Array, count: number}
// recordSize: bytes per record; keyLen: bytes to compare (from start of record)
// Returns a flat sorted Uint8Array of totalEntries * recordSize bytes.
function kWayMergeBinary(chunks, recordSize, keyLen) {
  const totalEntries = chunks.reduce((sum, c) => sum + c.count, 0);
  const result = new Uint8Array(totalEntries * recordSize);
  const pos = new Uint32Array(chunks.length); // current index in each chunk

  // Min-heap of chunk indices, ordered by current record's key
  const heap = [];
  for (let k = 0; k < chunks.length; k++) {
    if (chunks[k].count > 0) heap.push(k);
  }

  function keyAt(k) { return chunks[k].bytes.subarray(pos[k] * recordSize, pos[k] * recordSize + keyLen); }
  function less(ak, bk) {
    const a = keyAt(ak), b = keyAt(bk);
    for (let j = 0; j < keyLen; j++) {
      if (a[j] !== b[j]) return a[j] < b[j];
    }
    return false;
  }
  function siftDown(i) {
    const n = heap.length;
    while (true) {
      let m = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && less(heap[l], heap[m])) m = l;
      if (r < n && less(heap[r], heap[m])) m = r;
      if (m === i) break;
      const tmp = heap[i]; heap[i] = heap[m]; heap[m] = tmp;
      i = m;
    }
  }

  // Build heap (heapify bottom-up)
  for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) siftDown(i);

  let outPos = 0;
  while (heap.length > 0) {
    const k = heap[0];
    const srcOff = pos[k] * recordSize;
    result.set(chunks[k].bytes.subarray(srcOff, srcOff + recordSize), outPos);
    outPos += recordSize;
    pos[k]++;
    if (pos[k] >= chunks[k].count) {
      heap[0] = heap[heap.length - 1];
      heap.pop();
    }
    if (heap.length > 0) siftDown(0);
  }
  return result;
}

function kWayMergeSpentBinary(chunks) {
  return kWayMergeBinary(chunks, 16, 16);
}

function kWayMergeTxindexBinary(chunks) {
  return kWayMergeBinary(chunks, 12, 8);
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function parseChunkResult(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  const filterCount = view.getUint32(pos, true); pos += 4;
  const filters = [];
  for (let i = 0; i < filterCount; i++) {
    const height = Number(view.getBigUint64(pos, true)); pos += 8;
    const blockId = data.slice(pos, pos + 32); pos += 32;
    const addrCount = view.getUint16(pos, true); pos += 2;
    const dataLen = view.getUint32(pos, true); pos += 4;
    const filterData = data.slice(pos, pos + dataLen); pos += dataLen;
    filters.push({ height, blockId, addrCount, filterData });
  }

  // txindex entries — return as raw binary (12 bytes per entry: 8 prefix + 4 height)
  const txindexCount = view.getUint32(pos, true); pos += 4;
  const txindexBytes = data.subarray(pos, pos + txindexCount * 12); pos += txindexCount * 12;

  // UTXO created entries — return as raw binary (20 bytes per entry: 8 addrPrefix + 8 oidPrefix + 4 height)
  const utxoCreatedCount = view.getUint32(pos, true); pos += 4;
  const utxoCreatedBytes = data.subarray(pos, pos + utxoCreatedCount * 20); pos += utxoCreatedCount * 20;

  // UTXO spent entries — return as raw binary (16 bytes per entry: 8 addrPrefix + 8 oidPrefix)
  const utxoSpentCount = view.getUint32(pos, true); pos += 4;
  const utxoSpentBytes = data.subarray(pos, pos + utxoSpentCount * 16); pos += utxoSpentCount * 16;

  // Attestation entries (may be absent in older chunks)
  const attestations = [];
  if (pos < data.byteLength) {
    const attCount = view.getUint32(pos, true); pos += 4;
    for (let i = 0; i < attCount; i++) {
      const pubkey = data.slice(pos, pos + 32); pos += 32;
      const keyHash = data.slice(pos, pos + 8); pos += 8;
      const height = view.getUint32(pos, true); pos += 4;
      attestations.push({ pubkey, keyHash, height });
    }
  }

  return { filters, txindexBytes, txindexCount, utxoCreatedBytes, utxoCreatedCount, utxoSpentBytes, utxoSpentCount, attestations };
}

function parseExistingFilters(data) {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const count = view.getUint32(8, true);
  let pos = 24; // skip header: magic(4) + version(4) + count(4) + p(4) + tipHeight(8)
  const entries = [];
  for (let i = 0; i < count; i++) {
    const height = Number(view.getBigUint64(pos, true)); pos += 8;
    const blockId = arr.slice(pos, pos + 32); pos += 32;
    const addrCount = view.getUint16(pos, true); pos += 2;
    const dataLen = view.getUint32(pos, true); pos += 4;
    const filterData = arr.slice(pos, pos + dataLen); pos += dataLen;
    entries.push({ height, blockId, addrCount, filterData });
  }
  return entries;
}

function parseExistingTxindexBinary(data) {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const count = view.getUint32(8, true);
  // entries start at offset 16 (header: magic(4) + version(4) + count(4) + tipHeight(4))
  return { bytes: arr.slice(16, 16 + count * 12), count };
}

function parseExistingUtxoIndex(data) {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const count = view.getUint32(8, true);
  let pos = 16; // skip header: magic(4) + version(4) + count(4) + tipHeight(4)
  const entries = [];
  for (let i = 0; i < count; i++) {
    const addrPrefix = arr.slice(pos, pos + 8); pos += 8;
    const oidPrefix = arr.slice(pos, pos + 8); pos += 8;
    const height = view.getUint32(pos, true); pos += 4;
    entries.push({ addrPrefix, oidPrefix, height });
  }
  return entries;
}

function parseExistingAttestationIndex(data) {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const count = view.getUint32(8, true);
  let pos = 16; // skip header: magic(4) + version(4) + count(4) + tipHeight(4)
  const entries = [];
  for (let i = 0; i < count; i++) {
    const pubkey = arr.slice(pos, pos + 32); pos += 32;
    const keyHash = arr.slice(pos, pos + 8); pos += 8;
    const height = view.getUint32(pos, true); pos += 4;
    entries.push({ pubkey, keyHash, height });
  }
  return entries;
}

function serializeFilterFile(entries, tipHeight) {
  const p = 19;
  let totalDataLen = 0;
  for (const e of entries) totalDataLen += e.filterData.length;
  const headerSize = 24;
  const perEntry = 46;
  const buf = new Uint8Array(headerSize + entries.length * perEntry + totalDataLen);
  const view = new DataView(buf.buffer);
  let pos = 0;

  buf.set([0x53, 0x43, 0x42, 0x46], pos); pos += 4; // "SCBF"
  view.setUint32(pos, 1, true); pos += 4;
  view.setUint32(pos, entries.length, true); pos += 4;
  view.setUint32(pos, p, true); pos += 4;
  view.setBigUint64(pos, BigInt(tipHeight), true); pos += 8;

  for (const e of entries) {
    view.setBigUint64(pos, BigInt(e.height), true); pos += 8;
    buf.set(e.blockId, pos); pos += 32;
    view.setUint16(pos, e.addrCount, true); pos += 2;
    view.setUint32(pos, e.filterData.length, true); pos += 4;
    buf.set(e.filterData, pos); pos += e.filterData.length;
  }

  return buf;
}

function serializeTxindex(sortedBytes, count, tipHeight) {
  const buf = new Uint8Array(16 + sortedBytes.byteLength);
  const view = new DataView(buf.buffer);
  buf.set([0x53, 0x54, 0x58, 0x49], 0); // "STXI"
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, tipHeight, true);
  buf.set(sortedBytes, 16);
  return buf;
}

function serializeUtxoIndex(entries, tipHeight) {
  const buf = new Uint8Array(16 + entries.length * 20);
  const view = new DataView(buf.buffer);
  let pos = 0;

  buf.set([0x53, 0x55, 0x58, 0x49], pos); pos += 4; // "SUXI"
  view.setUint32(pos, 1, true); pos += 4;
  view.setUint32(pos, entries.length, true); pos += 4;
  view.setUint32(pos, tipHeight, true); pos += 4;

  for (const e of entries) {
    buf.set(e.addrPrefix, pos); pos += 8;
    buf.set(e.oidPrefix, pos); pos += 8;
    view.setUint32(pos, e.height, true); pos += 4;
  }

  return buf;
}

function serializeAttestationIndex(entries, tipHeight) {
  const buf = new Uint8Array(16 + entries.length * 44);
  const view = new DataView(buf.buffer);
  let pos = 0;

  buf.set([0x53, 0x41, 0x50, 0x49], pos); pos += 4; // "SAPI"
  view.setUint32(pos, 1, true); pos += 4;
  view.setUint32(pos, entries.length, true); pos += 4;
  view.setUint32(pos, tipHeight, true); pos += 4;

  for (const e of entries) {
    buf.set(e.pubkey, pos); pos += 32;
    buf.set(e.keyHash, pos); pos += 8;
    view.setUint32(pos, e.height, true); pos += 4;
  }

  return buf;
}

// --- Full-chain parallel sync (spawns filter sub-workers) ---

async function syncFullChain(net, peerUrl, genesisHex, certHash, filterKey, txindexKey, utxoindexKey, attestationKey, logFn, numWorkers) {
  // Step 1: Sync headers
  self.postMessage({ type: 'phase', net, phase: 'headers' });
  logFn('Syncing headers (full chain mode)...', 'info');

  const headerIdsBytes = await sync_headers(
    peerUrl, genesisHex, logFn, certHash || undefined
  );
  const totalBlocks = headerIdsBytes.length / 32;
  if (totalBlocks === 0) {
    logFn('No headers synced', 'err');
    return;
  }
  logFn(`${totalBlocks} headers synced`, 'ok');
  self.postMessage({ type: 'progress', net, currentHeight: null, networkHeight: totalBlocks });

  // Step 2: Check existing cached data — skip if already up to date
  let cachedFilterTip = 0;
  let cachedTxindexTip = 0;
  let cachedUtxoTip = 0;
  const existingFilters = await syncerDbLoad(filterKey);
  if (existingFilters && existingFilters.byteLength >= 24) {
    try {
      const arr = existingFilters instanceof ArrayBuffer ? new Uint8Array(existingFilters) : existingFilters;
      const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      cachedFilterTip = Number(view.getBigUint64(16, true));
    } catch (e) { /* ignore parse errors, will rebuild */ }
  }
  const existingTxindex = await syncerDbLoad(txindexKey);
  if (existingTxindex && existingTxindex.byteLength >= 16) {
    try {
      const arr = existingTxindex instanceof ArrayBuffer ? new Uint8Array(existingTxindex) : existingTxindex;
      const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      cachedTxindexTip = view.getUint32(12, true);
    } catch (e) { /* ignore parse errors, will rebuild */ }
  }
  const existingUtxo = await syncerDbLoad(utxoindexKey);
  if (existingUtxo && existingUtxo.byteLength >= 16) {
    try {
      const arr = existingUtxo instanceof ArrayBuffer ? new Uint8Array(existingUtxo) : existingUtxo;
      const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      cachedUtxoTip = view.getUint32(12, true);
    } catch (e) { /* ignore parse errors, will rebuild */ }
  }
  let cachedAttestationTip = 0;
  const existingAttestation = await syncerDbLoad(attestationKey);
  if (existingAttestation && existingAttestation.byteLength >= 16) {
    try {
      const arr = existingAttestation instanceof ArrayBuffer ? new Uint8Array(existingAttestation) : existingAttestation;
      const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      cachedAttestationTip = view.getUint32(12, true);
    } catch (e) { /* ignore parse errors, will rebuild */ }
  }

  // Sanity check
  if (cachedFilterTip > totalBlocks + 100) {
    logFn(`Filter cache has wrong data (tip ${cachedFilterTip} > chain ${totalBlocks}) — clearing`, 'err');
    await syncerDbDelete(filterKey);
    cachedFilterTip = 0;
  }
  if (cachedTxindexTip > totalBlocks + 100) {
    logFn(`Txindex cache has wrong data (tip ${cachedTxindexTip} > chain ${totalBlocks}) — clearing`, 'err');
    await syncerDbDelete(txindexKey);
    cachedTxindexTip = 0;
  }
  if (cachedUtxoTip > totalBlocks + 100) {
    logFn(`UTXO index has wrong data (tip ${cachedUtxoTip} > chain ${totalBlocks}) — clearing`, 'err');
    await syncerDbDelete(utxoindexKey);
    cachedUtxoTip = 0;
  }
  if (cachedAttestationTip > totalBlocks + 100) {
    logFn(`Attestation index has wrong data (tip ${cachedAttestationTip} > chain ${totalBlocks}) — clearing`, 'err');
    await syncerDbDelete(attestationKey);
    cachedAttestationTip = 0;
  }

  // If cached data covers the chain tip exactly, skip
  if (cachedFilterTip >= totalBlocks && cachedTxindexTip >= totalBlocks && cachedUtxoTip >= totalBlocks && cachedAttestationTip >= totalBlocks) {
    logFn(`Full-chain data already up to date (filters: ${cachedFilterTip}, txindex: ${cachedTxindexTip}, utxos: ${cachedUtxoTip}, attestations: ${cachedAttestationTip}, chain: ${totalBlocks})`, 'ok');
    self.postMessage({ type: 'progress', net, currentHeight: totalBlocks, networkHeight: totalBlocks });
    return;
  }

  // Determine incremental start — only rebuild blocks we don't have
  const minCachedTip = Math.min(cachedFilterTip, cachedTxindexTip, cachedUtxoTip, cachedAttestationTip);
  const startFrom = (minCachedTip > 0) ? minCachedTip : 0;

  // Parse existing cached data for incremental merge
  let existingFilterEntries = [];
  let existingTxindexBinary = { bytes: new Uint8Array(0), count: 0 };
  let existingUtxoEntries = [];
  let existingAttestationEntries = [];
  if (startFrom > 0) {
    logFn(`Incremental update: blocks ${startFrom}–${totalBlocks} (${totalBlocks - startFrom} new, cache covers 0–${startFrom - 1})`, 'info');
    if (existingFilters) existingFilterEntries = parseExistingFilters(existingFilters).filter(e => e.height < startFrom);
    if (existingTxindex) existingTxindexBinary = parseExistingTxindexBinary(existingTxindex);
    if (existingUtxo) existingUtxoEntries = parseExistingUtxoIndex(existingUtxo);
    if (existingAttestation) existingAttestationEntries = parseExistingAttestationIndex(existingAttestation).filter(e => e.height < startFrom);
  } else {
    logFn(`Cache: filters tip=${cachedFilterTip}, txindex tip=${cachedTxindexTip}, utxos tip=${cachedUtxoTip}, attestations tip=${cachedAttestationTip}, chain=${totalBlocks} — full rebuild...`, 'info');
  }

  self.postMessage({ type: 'phase', net, phase: 'filters' });

  // Step 3: Work-stealing parallel filter generation with incremental checkpointing
  const wipMetaKey = filterKey + ':wip_meta';
  const wipChunkKey = (start) => filterKey + ':wip:' + start;

  // Build chunks — start from cached tip (or 0 for full rebuild)
  const allChunkDefs = [];
  for (let s = startFrom; s < totalBlocks; s += CHUNK_SIZE) {
    allChunkDefs.push({ start: s, size: Math.min(CHUNK_SIZE, totalBlocks - s) });
  }
  const numChunks = allChunkDefs.length;

  // Check for existing work-in-progress checkpoint
  const completedSet = new Set();
  let resumedBlocks = 0;
  try {
    const wipMeta = await syncerDbLoad(wipMetaKey);
    if (wipMeta) {
      const meta = JSON.parse(wipMeta);
      if (meta.totalBlocks === totalBlocks && meta.chunkSize === CHUNK_SIZE && (meta.startFrom || 0) === startFrom && Array.isArray(meta.completed)) {
        for (const cs of meta.completed) completedSet.add(cs);
        resumedBlocks = meta.completed.length * CHUNK_SIZE;
        logFn(`Resuming from checkpoint: ${meta.completed.length}/${numChunks} chunks already done`, 'ok');
      } else {
        logFn('Checkpoint mismatch (chain changed), starting fresh', 'info');
        await cleanupWip();
      }
    }
  } catch (e) { /* no checkpoint, start fresh */ }

  async function cleanupWip() {
    const deletes = [syncerDbDelete(wipMetaKey)];
    for (const chunk of allChunkDefs) {
      deletes.push(syncerDbDelete(wipChunkKey(chunk.start)));
    }
    await Promise.all(deletes);
  }

  // Remaining chunks to process
  const remainingChunks = allChunkDefs.filter(c => !completedSet.has(c.start));
  const effectiveWorkers = Math.min(numWorkers, remainingChunks.length);

  if (remainingChunks.length === 0) {
    logFn('All chunks already checkpointed, merging...', 'ok');
  } else {
    logFn(`Spawning ${effectiveWorkers} workers (${remainingChunks.length}/${numChunks} chunks remaining, work-stealing)...`, 'info');
  }

  // Work queue — only remaining chunks
  let nextIdx = 0;
  function takeNextChunk() {
    if (nextIdx >= remainingChunks.length) return null;
    return remainingChunks[nextIdx++];
  }

  // Progress tracking
  const workerProgress = new Array(effectiveWorkers).fill(0);
  const workerAddrs = new Array(effectiveWorkers).fill(0);
  const workerCumulativeBlocks = new Array(effectiveWorkers).fill(0);
  const workerCumulativeAddrs = new Array(effectiveWorkers).fill(0);
  const workerCurrentChunkStart = new Array(effectiveWorkers).fill(0);
  const workerCurrentChunkSize = new Array(effectiveWorkers).fill(0);
  let lastProgressLog = 0;
  let totalCompletedBlocks = resumedBlocks + startFrom; // count cached + checkpointed blocks

  function logAggregateProgress() {
    const now = Date.now();
    if (now - lastProgressLog < 500) return;
    lastProgressLog = now;
    const workerDone = workerProgress.reduce((a, b) => a + b, 0);
    const totalDone = totalCompletedBlocks + workerDone;
    const totalAddrs = workerAddrs.reduce((a, b) => a + b, 0);
    const pct = totalBlocks > 0 ? (totalDone / totalBlocks * 100).toFixed(1) : '0';
    logFn(`Generating filters: ${totalDone} / ${totalBlocks} blocks (${pct}%) | ${totalAddrs} addrs`, 'data');
    self.postMessage({ type: 'progress', net, currentHeight: totalDone, networkHeight: totalBlocks });
  }

  function assignChunk(worker, workerId, chunk) {
    workerCurrentChunkStart[workerId] = chunk.start;
    workerCurrentChunkSize[workerId] = chunk.size;
    const headerSlice = new Uint8Array(
      headerIdsBytes.buffer,
      headerIdsBytes.byteOffset + chunk.start * 32,
      chunk.size * 32
    );
    const headerSliceCopy = new Uint8Array(headerSlice);

    let historyBlockIdHex = '';
    if (chunk.start > 0) {
      const idSlice = headerIdsBytes.slice(
        (chunk.start - 1) * 32,
        chunk.start * 32
      );
      historyBlockIdHex = bytesToHex(idSlice);
    }

    worker.postMessage({
      type: 'generate',
      workerId,
      url: peerUrl,
      genesisHex,
      certHash: certHash || null,
      historyBlockIdHex,
      chunkStart: chunk.start,
      maxBlocks: chunk.size,
      headerIdsSlice: headerSliceCopy,
    }, [headerSliceCopy.buffer]);
  }

  async function saveChunkCheckpoint(chunkStart, resultBytes) {
    completedSet.add(chunkStart);
    await Promise.all([
      syncerDbSave(wipChunkKey(chunkStart), resultBytes),
      syncerDbSave(wipMetaKey, JSON.stringify({
        totalBlocks, chunkSize: CHUNK_SIZE, startFrom, completed: Array.from(completedSet),
      })),
    ]);
  }

  // Run workers (if any remaining)
  if (effectiveWorkers > 0) {
    const workerDonePromises = [];
    for (let w = 0; w < effectiveWorkers; w++) {
      const donePromise = new Promise((resolve, reject) => {
        const worker = new Worker('./filter-worker.js', { type: 'module' });

        worker.onmessage = async (e) => {
          if (e.data.type === 'ready') {
            const chunk = takeNextChunk();
            if (chunk) assignChunk(worker, w, chunk);
            else { worker.terminate(); resolve(); }
          } else if (e.data.type === 'log') {
            const m = e.data.msg.match(/(\d+)\/(\d+)\s*\(/);
            if (m) {
              workerProgress[w] = workerCumulativeBlocks[w] + parseInt(m[1]);
              const a = e.data.msg.match(/([\d]+)\s*addrs/);
              if (a) workerAddrs[w] = workerCumulativeAddrs[w] + parseInt(a[1]);
              logAggregateProgress();
            } else if (e.data.cls === 'err' || e.data.cls === 'info') {
              logFn(`[W${w}] ${e.data.msg}`, e.data.cls);
            }
          } else if (e.data.type === 'done') {
            const chunkStart = workerCurrentChunkStart[w];
            const chunkSize = workerCurrentChunkSize[w];

            // Save checkpoint to IndexedDB
            await saveChunkCheckpoint(chunkStart, e.data.data);

            workerCumulativeBlocks[w] += chunkSize;
            workerCumulativeAddrs[w] = workerAddrs[w];
            workerProgress[w] = workerCumulativeBlocks[w];
            logAggregateProgress();

            const chunk = takeNextChunk();
            if (chunk) {
              assignChunk(worker, w, chunk);
            } else {
              worker.terminate();
              resolve();
            }
          } else if (e.data.type === 'error') {
            worker.terminate();
            reject(new Error(`Worker ${w}: ${e.data.error}`));
          }
        };

        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(`Worker ${w} error: ${e.message}`));
        };

        worker.postMessage({
          type: 'init',
          wasmUrl: './pkg/syncer_wasm_bg.wasm',
        });
      });

      workerDonePromises.push(donePromise);
    }

    await Promise.all(workerDonePromises);
  }

  // Step 4: Load all chunk results from checkpoints and merge in height order
  logFn('All chunks done, loading and merging results...', 'info');

  const allChunkResults = [];
  for (const chunk of allChunkDefs) {
    const data = await syncerDbLoad(wipChunkKey(chunk.start));
    if (data) {
      const parsed = parseChunkResult(new Uint8Array(
        data instanceof ArrayBuffer ? data : data.buffer ? data : new Uint8Array(data)
      ));
      allChunkResults.push({
        chunkStart: chunk.start, filters: parsed.filters,
        txindexBytes: parsed.txindexBytes, txindexCount: parsed.txindexCount,
        utxoCreatedBytes: parsed.utxoCreatedBytes, utxoCreatedCount: parsed.utxoCreatedCount,
        utxoSpentBytes: parsed.utxoSpentBytes, utxoSpentCount: parsed.utxoSpentCount,
        attestations: parsed.attestations,
      });
    }
  }

  allChunkResults.sort((a, b) => a.chunkStart - b.chunkStart);

  // Merge filters: existing cached entries + new chunk entries
  let allFilters = existingFilterEntries;
  for (const chunk of allChunkResults) {
    allFilters = allFilters.concat(chunk.filters);
  }

  const tipHeight = allFilters.length > 0
    ? allFilters[allFilters.length - 1].height
    : totalBlocks;

  // Step 5a: Save filters, then free filter data to reclaim memory before txindex merge
  logFn('Saving filters to IndexedDB...', 'info');
  const filterBytes = serializeFilterFile(allFilters, tipHeight);
  await syncerDbSave(filterKey, filterBytes);
  allFilters = null;
  for (const c of allChunkResults) c.filters = null;
  logFn('Filters saved', 'ok');

  // Step 5b: K-way merge txindex binary — each chunk's data is already sorted by prefix
  logFn('K-way merging transaction index...', 'info');
  const txindexChunks = [];
  if (existingTxindexBinary.count > 0) txindexChunks.push(existingTxindexBinary);
  for (const c of allChunkResults) {
    if (c.txindexCount > 0) txindexChunks.push({ bytes: c.txindexBytes, count: c.txindexCount });
  }
  const mergedTxindexBytes = kWayMergeTxindexBinary(txindexChunks);
  const totalTxCount = mergedTxindexBytes.byteLength / 12;
  logFn(`Merged ${totalTxCount} txindex entries`, 'ok');

  logFn('Saving transaction index to IndexedDB...', 'info');
  await syncerDbSave(txindexKey, serializeTxindex(mergedTxindexBytes, totalTxCount, tipHeight));
  for (const c of allChunkResults) c.txindexBytes = null;
  logFn('Transaction index saved', 'ok');

  // Build UTXO index: existing unspent + new creates - new spends.
  // Sort each chunk's spent entries then k-way merge into a global sorted array.
  // Binary search replaces Set to avoid V8's 16.7M Set entry limit.
  logFn('Building UTXO index...', 'info');

  // Pass 1: sort spent entries per chunk (small, fast), then k-way merge into one sorted array
  logFn('Sorting and merging spent entries...', 'info');
  const sortedSpentChunks = [];
  let totalSpent = 0;
  for (const chunk of allChunkResults) {
    if (chunk.utxoSpentCount > 0) {
      sortedSpentChunks.push({ bytes: sortBinary16Records(chunk.utxoSpentBytes), count: chunk.utxoSpentCount });
      totalSpent += chunk.utxoSpentCount;
    }
  }
  const sortedSpentBytes = sortedSpentChunks.length > 0 ? kWayMergeSpentBinary(sortedSpentChunks) : new Uint8Array(0);
  logFn(`${totalSpent} spent entries indexed`, 'info');

  // Pass 2: filter existing + new creates inline using binary search
  const lookupKey = new Uint8Array(16); // reused buffer for existing-entry lookups
  const unspent = existingUtxoEntries.filter(c => {
    lookupKey.set(c.addrPrefix, 0);
    lookupKey.set(c.oidPrefix, 8);
    return !spentContains(sortedSpentBytes, lookupKey);
  });
  let totalCreated = 0;
  for (const chunk of allChunkResults) {
    const { utxoCreatedBytes, utxoCreatedCount } = chunk;
    const createdView = new DataView(utxoCreatedBytes.buffer, utxoCreatedBytes.byteOffset, utxoCreatedBytes.byteLength);
    for (let i = 0; i < utxoCreatedCount; i++) {
      const off = i * 20;
      if (!spentContains(sortedSpentBytes, utxoCreatedBytes.subarray(off, off + 16))) {
        unspent.push({
          addrPrefix: utxoCreatedBytes.subarray(off, off + 8),
          oidPrefix: utxoCreatedBytes.subarray(off + 8, off + 16),
          height: createdView.getUint32(off + 16, true),
        });
      }
    }
    totalCreated += utxoCreatedCount;
  }

  // Sort by address prefix, then output ID prefix
  unspent.sort((a, b) => {
    const cmp = comparePrefixes(a.addrPrefix, b.addrPrefix);
    if (cmp !== 0) return cmp;
    return comparePrefixes(a.oidPrefix, b.oidPrefix);
  });
  logFn(`UTXO index: ${totalCreated} created, ${totalSpent} spent, ${unspent.length} unspent`, 'ok');

  logFn('Saving UTXO index to IndexedDB...', 'info');
  const utxoBytes = serializeUtxoIndex(unspent, tipHeight);
  await syncerDbSave(utxoindexKey, utxoBytes);
  for (const c of allChunkResults) { c.utxoCreatedBytes = null; c.utxoSpentBytes = null; }
  logFn('UTXO index saved', 'ok');

  // Build attestation index: existing entries + new chunk entries, sorted by (pubkey, keyHash, height)
  logFn('Building attestation index...', 'info');
  let allAttestations = existingAttestationEntries.slice();
  for (const chunk of allChunkResults) {
    for (const a of chunk.attestations) allAttestations.push(a);
  }
  allAttestations.sort((a, b) => {
    const cmp = comparePrefixes(a.pubkey, b.pubkey);
    if (cmp !== 0) return cmp;
    const cmp2 = comparePrefixes(a.keyHash, b.keyHash);
    if (cmp2 !== 0) return cmp2;
    return a.height - b.height;
  });
  logFn(`Attestation index: ${allAttestations.length} entries`, 'ok');

  logFn('Saving attestation index to IndexedDB...', 'info');
  const attestationBytes = serializeAttestationIndex(allAttestations, tipHeight);
  await syncerDbSave(attestationKey, attestationBytes);
  logFn('Attestation index saved', 'ok');

  // Clean up WIP checkpoint data
  logFn('Cleaning up checkpoints...', 'info');
  await cleanupWip();
  logFn('Done', 'ok');

  self.postMessage({ type: 'progress', net, currentHeight: tipHeight, networkHeight: tipHeight });
}

// --- Message handler ---

let wasmReady = false;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await init({ module_or_path: e.data.wasmUrl });
      wasmReady = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', net: '', error: 'WASM init failed: ' + err });
    }
    return;
  }

  if (type === 'sync') {
    if (!wasmReady) {
      self.postMessage({ type: 'error', net: e.data.net, error: 'WASM not initialized' });
      return;
    }

    const { net, peerUrl, genesisHex, certHash, v2, startHeight, filterKey, txindexKey, utxoindexKey, attestationKey, numWorkers: msgNumWorkers } = e.data;
    const logFn = (msg, cls) => self.postMessage({ type: 'log', net, msg, cls });

    try {
      if (v2) {
        // V2-only: sequential generate_filters + generate_txindex
        self.postMessage({ type: 'phase', net, phase: 'filters' });
        logFn('Generating V2 block filters...', 'info');
        await generate_filters(peerUrl, genesisHex, logFn, certHash || undefined, BigInt(startHeight));
        logFn('V2 block filters updated', 'ok');

        self.postMessage({ type: 'phase', net, phase: 'txindex' });
        logFn('Generating V2 transaction index...', 'info');
        await generate_txindex(peerUrl, genesisHex, logFn, certHash || undefined, BigInt(startHeight));
        logFn('V2 transaction index updated', 'ok');
      } else {
        // Full-chain: headers + parallel chunk workers + merge + save
        await syncFullChain(net, peerUrl, genesisHex, certHash, filterKey, txindexKey, utxoindexKey, attestationKey, logFn, msgNumWorkers || DEFAULT_NUM_WORKERS);
      }
      self.postMessage({ type: 'done', net });
    } catch (err) {
      self.postMessage({ type: 'error', net, error: String(err) });
    }
  }
};
