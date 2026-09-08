// Single web worker for downloading files via one SDK instance.
// Keeps the main thread responsive while using a single connection pool.

import init, { AppKey, Builder, setLogger } from './pkg/sia_storage_wasm.js';
import { fromHex } from './worker-utils.js';
import { downloadOptions } from './transfer-options.js';
import { classifyObjectInput } from './object-input.js';

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
      // Fetch object metadata. Classified the same way the page does, so an
      // input the page would refuse can't reach the SDK by another route and
      // come back as a hex-decoding error.
      const parsed = classifyObjectInput(input);
      if (parsed.kind === 'invalid') throw new Error(parsed.reason);
      if (parsed.kind === 'site') {
        throw new Error('That is a sialo:// address, not a single object.');
      }
      const obj = parsed.kind === 'publishUrl'
        ? await sdk.objectFromShareUrl(parsed.value)
        : await sdk.object(parsed.value);
      const size = obj.size();
      self.postMessage({ type: 'metadata', size });

      // Download with streaming chunks. Each shard's host is relayed to the
      // main thread: the SDK runs in here, so the page has no other way to
      // learn which hosts are actually serving the transfer.
      const stream = sdk.download(obj, downloadOptions(maxDownloads, {
        onShardDownloaded: (p) => {
          self.postMessage({ type: 'shard', hostKey: p.hostKey });
        },
      }));
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
