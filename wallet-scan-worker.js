// Web Worker for wallet UTXO scanning.
// Runs scan_wallet_utxos off the main thread so the UI stays responsive.

import init, { scan_wallet_utxos } from './pkg/syncer_wasm.js';

let wasmReady = false;

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
