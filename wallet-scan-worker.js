// Web Worker for wallet UTXO scanning.
// Runs scan_wallet_utxos off the main thread so the UI stays responsive.

import init, { scan_wallet_utxos, set_cached_header_ids } from './pkg/syncer_wasm.js';

let wasmReady = false;

// Load header IDs from OPFS (same as main thread uses)
async function loadHeadersFromOpfs(net) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(net + ':header_ids');
    const file = await fh.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (e) {
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

    const { entropyHex, account, peerUrl, genesisHex, filterUrl, utxoIndexUrl, certHash } = e.data;

    // Inject cached header IDs from OPFS so the scan doesn't re-sync headers
    const net = genesisHex.startsWith('25f6e3b9') ? 'mainnet' : genesisHex.startsWith('172fb3d5') ? 'zen' : 'unknown';
    const headerBytes = await loadHeadersFromOpfs(net);
    if (headerBytes && headerBytes.byteLength > 0) {
      set_cached_header_ids(genesisHex, headerBytes);
    }

    const logFn = (msg, cls) => {
      self.postMessage({ type: 'log', msg, cls });
    };

    try {
      const resultJson = await scan_wallet_utxos(
        entropyHex, account, peerUrl, genesisHex, filterUrl,
        utxoIndexUrl || undefined,
        logFn, certHash || undefined
      );
      self.postMessage({ type: 'result', resultJson });
    } catch (err) {
      self.postMessage({ type: 'error', error: '' + err });
    }
    return;
  }
};
