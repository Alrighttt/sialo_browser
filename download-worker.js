// Web Worker for file downloads
// Creates independent SDK instance, downloads via ReadableStream,
// posts decrypted chunks back via Transferable ArrayBuffers (zero-copy).

import init, { AppKey, Builder } from './pkg/sia_storage_wasm.js';
import { fromHex } from './worker-utils.js';

self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;

  const {
    indexerUrl,
    keyHex,
    maxDownloads,
    objectUrl,
  } = e.data;

  try {
    await init();

    
    const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
    const builder = new Builder(indexerUrl, { appId: 'c0000000000000000000000000000000000000000000000000000000000000de', name: 'Sialo', description: 'Sialo Browser worker', serviceUrl: 'https://sialo.io' });

    const sdk = await builder.connected(appKey);
    if (!sdk) {
      self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
      return;
    }

    const obj = objectUrl.startsWith('sia://')
      ? await sdk.objectFromShareUrl(objectUrl)
      : await sdk.object(objectUrl);

    // Send size metadata before download starts
    self.postMessage({ type: 'metadata', size: obj.size() });

    // Stream download — post chunks back to main thread
    let byteOffset = 0;
    const stream = sdk.download(obj, { maxInflight: maxDownloads });
    const reader = stream.getReader();
    const totalSize = obj.size();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
      self.postMessage(
        { type: 'chunk', offset: byteOffset, size: value.byteLength, data: buf },
        [buf],
      );
      byteOffset += value.byteLength;
      self.postMessage({ type: 'progress', current: byteOffset, total: totalSize });
    }

    self.postMessage({ type: 'complete' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
