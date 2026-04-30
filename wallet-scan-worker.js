// Web Worker for wallet UTXO scanning.
// Runs scan_wallet_utxos off the main thread so the UI stays responsive.

import init, { scan_wallet_utxos } from './pkg/syncer_wasm.js';

let wasmReady = false;

// Reading the OPFS file directly inside the worker and creating a
// worker-local blob URL avoids cross-context blob URL flakiness —
// URLs created on the main thread aren't reliably fetchable from a
// worker, particularly when backed by OPFS Files or after a memory
// pressure event invalidates the underlying blob storage. Workers
// have their own access to OPFS; opening the file here gives us a
// blob URL that's local to this worker and guaranteed reachable.
async function loadOpfsBlobUrl(key) {
  if (!key) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(key);
    const file = await handle.getFile();
    if (!file || file.size === 0) return null;
    return { url: URL.createObjectURL(file), file };
  } catch (_) {
    return null;
  }
}

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await init({ module_or_path: e.data.wasmUrl });
      wasmReady = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: 'WASM init failed: ' + err });
    }
    return;
  }

  if (type === 'scan') {
    if (!wasmReady) {
      self.postMessage({ type: 'error', error: 'WASM not initialized' });
      return;
    }

    const {
      entropyHex, account, peerUrl, genesisHex,
      filterOpfsKey, utxoOpfsKey,
      // Legacy fields — kept so a stale main-thread caller still works
      // even though the blob URLs themselves won't be reachable.
      filterUrl, utxoIndexUrl,
      certHash,
    } = e.data;

    const logFn = (msg, cls) => {
      self.postMessage({ type: 'log', msg, cls });
    };

    const filterRes = filterOpfsKey ? await loadOpfsBlobUrl(filterOpfsKey) : null;
    const utxoRes = utxoOpfsKey ? await loadOpfsBlobUrl(utxoOpfsKey) : null;

    const effectiveFilterUrl = filterRes ? filterRes.url : (filterUrl || '');
    const effectiveUtxoUrl = utxoRes ? utxoRes.url : (utxoIndexUrl || undefined);

    try {
      const resultJson = await scan_wallet_utxos(
        entropyHex, account, peerUrl, genesisHex, effectiveFilterUrl,
        effectiveUtxoUrl || undefined,
        logFn, certHash || undefined
      );
      self.postMessage({ type: 'result', resultJson });
    } catch (err) {
      self.postMessage({ type: 'error', error: '' + err });
    } finally {
      if (filterRes) URL.revokeObjectURL(filterRes.url);
      if (utxoRes) URL.revokeObjectURL(utxoRes.url);
    }
    return;
  }
};
