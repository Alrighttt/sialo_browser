// Web Worker for parallel slab encoding (compute-only, no networking).
// Each worker loads the WASM module and performs erasure coding + encryption.
// Encoded shards are sent back to the main thread for upload via the SDK.

import init, { encodeSlab, setLogLevel } from './pkg/indexd_wasm.js';

let ready = false;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    const { workerIndex, logLevel } = e.data;
    try {
      await init(); // Load WASM only — no SDK, no connections
      if (logLevel) setLogLevel(logLevel);
      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }

  if (type === 'encode-slab') {
    if (!ready) {
      self.postMessage({ type: 'encode-error', slabIndex: e.data.slabIndex, message: 'Worker not ready' });
      return;
    }
    const { slabIndex, data, dataKey, streamOffset, dataShards, parityShards } = e.data;
    try {
      const slabData = new Uint8Array(data);
      const dataKeyBytes = new Uint8Array(dataKey);
      const result = encodeSlab(slabData, dataKeyBytes, streamOffset, dataShards, parityShards);

      // Collect shard ArrayBuffers for zero-copy transfer
      const shardBuffers = [];
      const shardArrays = [];
      for (let i = 0; i < result.shards.length; i++) {
        const shard = result.shards[i];
        // Copy to a standalone ArrayBuffer for transfer
        const buf = shard.buffer.slice(shard.byteOffset, shard.byteOffset + shard.byteLength);
        shardBuffers.push(buf);
        shardArrays.push(buf);
      }

      // Transfer slab key as a standalone buffer too
      const slabKeyBuf = result.slabKey.buffer.slice(
        result.slabKey.byteOffset,
        result.slabKey.byteOffset + result.slabKey.byteLength
      );

      self.postMessage({
        type: 'slab-encoded',
        slabIndex,
        slabKey: slabKeyBuf,
        shards: shardArrays,
        length: result.length,
        minShards: result.minShards,
      }, [slabKeyBuf, ...shardBuffers]); // Transfer, not clone
    } catch (err) {
      self.postMessage({
        type: 'encode-error',
        slabIndex: e.data.slabIndex,
        message: err.message || String(err),
      });
    }
    return;
  }
};
