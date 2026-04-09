// Single web worker for downloading files via one SDK instance.
// Keeps the main thread responsive while using a single connection pool.

import init, { AppKey, SdkBuilder, DownloadOptions, set_log_level } from './pkg/sia_storage_wasm.js';
import { fromHex } from './worker-utils.js';

let sdk = null;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    const { indexerUrl, keyHex, maxDownloads, logLevel } = e.data;
    try {
      await init();
      if (logLevel) set_log_level(logLevel);

      
      const appKey = AppKey.fromHex(keyHex);
      const builder = new SdkBuilder(indexerUrl, 'c0000000000000000000000000000000000000000000000000000000000000de', 'Sialo', 'Sialo Browser worker', 'https://sialo.io');
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
      const obj = isShareUrl ? await sdk.sharedObject(input) : await sdk.object(input);
      const size = obj.size();
      self.postMessage({ type: 'metadata', size });

      // Download with streaming chunks
      const opts = new DownloadOptions(maxDownloads || null);

      await sdk.downloadStreaming(obj,
        (chunk) => {
          // Transfer chunk to main thread (zero-copy)
          const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          self.postMessage({ type: 'chunk', data: buf, length: chunk.length }, [buf]);
        },
        (current, total) => {
          self.postMessage({ type: 'progress', current, total });
        },
        (host) => {
          self.postMessage({ type: 'host-active', host });
        },
      );

      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }
};
