// Web Worker for parallel slab uploads.
// Each worker creates its own SDK instance and uploads individual slabs
// on demand. A pool of these workers enables true parallel slab uploads.

import init, { AppKey, Builder, UploadOptions, setLogLevel } from './pkg/indexd_wasm.js';

function fromHex(h) {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return bytes;
}

let sdk = null;
let maxUploads = 8;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    const {
      indexerUrl,
      keyHex,
      maxUploads: maxUploadsInit,
      workerIndex,
      numWorkers,
      logLevel,
    } = e.data;

    try {
      maxUploads = maxUploadsInit || maxUploads;
      await init();
      const _debugEnabled = !!logLevel;
      if (logLevel) setLogLevel(logLevel);
      if (_debugEnabled) console.log(`[upload-worker ${workerIndex}] init: numWorkers=${numWorkers}`);

      const seed = fromHex(keyHex);
      const appKey = new AppKey(seed);
      const builder = new Builder(indexerUrl);

      sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
        return;
      }

      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }

  if (type === 'upload-slab') {
    const { slabIndex, data, dataKey, streamOffset } = e.data;
    try {
      const dataKeyBytes = new Uint8Array(dataKey);
      const slabData = new Uint8Array(data);

      const opts = new UploadOptions();
      opts.maxInflight = maxUploads;
      const slabJson = await sdk.uploadSlab(
        slabData,
        dataKeyBytes,
        streamOffset,
        opts,
        (current, total) => {
          self.postMessage({ type: 'shard-progress', slabIndex, current, total });
        },
        (host) => {
          self.postMessage({ type: 'host-active', slabIndex, host });
        },
      );

      self.postMessage({ type: 'slab-uploaded', slabIndex, slabJson });
    } catch (err) {
      self.postMessage({ type: 'slab-error', slabIndex, message: err.message || String(err) });
    }
    return;
  }
};
