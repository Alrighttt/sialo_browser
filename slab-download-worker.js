// Web Worker for parallel slab downloads.
// Each worker creates its own SDK instance and downloads individual slabs
// on demand. A pool of these workers enables true parallel slab downloads.

import init, { AppKey, Builder, setLogger } from './pkg/sia_storage_wasm.js';
import { fromHex } from './worker-utils.js';

let sdk = null;
let obj = null;
let maxDownloads = 8;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    const {
      indexerUrl,
      keyHex,
      maxDownloads: maxDownloadsInit,
      objectUrl,
      logLevel,
    } = e.data;

    try {
      maxDownloads = maxDownloadsInit || maxDownloads;
      self.postMessage({ type: 'status', phase: 'wasm' });
      await init();
      if (logLevel) setLogger((msg) => console.log(msg), logLevel);

      const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
      const builder = new Builder(indexerUrl, { appId: 'c0000000000000000000000000000000000000000000000000000000000000de', name: 'Sialo', description: 'Sialo Browser worker', serviceUrl: 'https://sialo.io' });

      self.postMessage({ type: 'status', phase: 'connecting' });
      sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
        return;
      }

      self.postMessage({ type: 'status', phase: 'metadata' });
      obj = objectUrl.startsWith('sia://')
        ? await sdk.sharedObject(objectUrl)
        : await sdk.object(objectUrl);

      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }

  if (type === 'download-slab') {
    const { slabIndex } = e.data;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const data = await sdk.downloadSlab(obj, slabIndex);
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        self.postMessage(
          { type: 'slab-data', slabIndex, data: buf },
          [buf], // Transferable — zero-copy to main thread
        );
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = 1000 * (attempt + 1) + Math.random() * 1000; // backoff + jitter
          console.warn(`Slab ${slabIndex} attempt ${attempt + 1} failed: ${err.message}, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          self.postMessage({ type: 'slab-error', slabIndex, message: err.message || String(err) });
        }
      }
    }
    return;
  }
};
