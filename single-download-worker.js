// Single web worker for downloading files via one SDK instance.
// Keeps the main thread responsive while using a single connection pool.

import init, { AppKey, Builder, setLogger } from './pkg/sia_storage_wasm.js';
import { fromHex } from './worker-utils.js';

let sdk = null;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    const { indexerUrl, keyHex, maxDownloads, logLevel } = e.data;
    try {
      await init();
      if (logLevel) setLogger((msg) => console.log(msg), logLevel);

      const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
      const builder = new Builder(indexerUrl, { appId: 'c0000000000000000000000000000000000000000000000000000000000000de', name: 'Sialo', description: 'Sialo Browser worker', serviceUrl: 'https://sialo.io' });
      sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'error', message: 'SDK connection failed' });
        return;
      }
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }

  if (type === 'download') {
    const { input, maxDownloads } = e.data;
    try {
      // Fetch object metadata
      const isShareUrl = input.startsWith('sia://') || input.startsWith('https://');
      const obj = isShareUrl ? await sdk.objectFromShareUrl(input) : await sdk.object(input);
      const size = obj.size();
      self.postMessage({ type: 'metadata', size });

      // Download with streaming chunks
      const stream = sdk.download(obj, { maxInflight: maxDownloads || undefined });
      const reader = stream.getReader();
      const totalSize = obj.size();
      let byteOffset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        self.postMessage({ type: 'chunk', data: buf, length: value.byteLength }, [buf]);
        byteOffset += value.byteLength;
        self.postMessage({ type: 'progress', current: byteOffset, total: totalSize });
      }

      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }
};
