// Web Worker for parallel block filter + txindex generation.
// Each worker loads its own WASM instance and connects to the peer independently.

import init, { generate_filters_chunk } from './pkg/syncer_wasm.js';

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

  if (type === 'generate') {
    if (!wasmReady) {
      self.postMessage({ type: 'error', error: 'WASM not initialized' });
      return;
    }

    const { workerId, url, genesisHex, certHash, historyBlockIdHex,
            chunkStart, maxBlocks, headerIdsSlice } = e.data;

    const logFn = (msg, cls) => {
      self.postMessage({ type: 'log', workerId, msg, cls });
    };

    try {
      const result = await generate_filters_chunk(
        url, genesisHex, certHash || undefined,
        historyBlockIdHex,
        BigInt(chunkStart), BigInt(maxBlocks),
        headerIdsSlice, logFn
      );
      // Transfer the buffer to avoid copying
      self.postMessage({ type: 'done', workerId, data: result }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', workerId, error: String(err) });
    }
  }
};
