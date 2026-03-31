// Web Worker for file downloads
// Creates independent SDK instance, downloads via downloadStreaming,
// posts decrypted chunks back via Transferable ArrayBuffers (zero-copy).

import init, { AppKey, Builder, DownloadOptions } from './pkg/indexd_wasm.js';
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

    const seed = fromHex(keyHex);
    const appKey = new AppKey(seed);
    const builder = new Builder(indexerUrl);

    const sdk = await builder.connected(appKey);
    if (!sdk) {
      self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
      return;
    }

    const obj = objectUrl.startsWith('sia://')
      ? await sdk.sharedObject(objectUrl)
      : await sdk.object(objectUrl);

    // Send size metadata before download starts
    self.postMessage({ type: 'metadata', size: obj.size() });

    // Stream download — post chunks back to main thread
    let byteOffset = 0;
    const opts = new DownloadOptions();
    opts.maxInflight = maxDownloads;
    await sdk.downloadStreaming(
      obj,
      opts,
      (chunk) => {
        const buf = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength,
        );
        self.postMessage(
          { type: 'chunk', offset: byteOffset, size: chunk.byteLength, data: buf },
          [buf],
        );
        byteOffset += chunk.byteLength;
      },
      (current, total) => {
        self.postMessage({ type: 'progress', current, total });
      },
    );

    self.postMessage({ type: 'complete' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
