// Download helpers — streaming download, parallel slab download via Web Workers,
// service worker streaming, and disk-based download.

import { _dbg, _dbgWarn, formatSize } from './utils.js';
import { connectSdk, resolveObject, getMaxDownloads } from './config.js';

async function streamingDownload(sdk, obj, status, progress, label, signal) {
  progress.style.display = 'block';
  status.textContent = label || 'Downloading...';

  const downloadStart = performance.now();
  let lastProgressUpdate = 0;
  const PROGRESS_THROTTLE_MS = 100;

  const blobParts = [];
  const totalSize = obj.size();
  const stream = sdk.download(obj, { maxInflight: getMaxDownloads() });
  const reader = stream.getReader();
  const onAbort = () => { reader.cancel('aborted').catch(() => {}); };
  if (signal) {
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    signal.addEventListener('abort', onAbort);
  }
  let byteOffset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      blobParts.push(value);
      byteOffset += value.byteLength;
      const now = performance.now();
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || byteOffset === totalSize) {
        progress.max = totalSize;
        progress.value = byteOffset;
        const pct = totalSize > 0 ? Math.round((byteOffset / totalSize) * 100) : 0;
        status.textContent = `${label || 'Downloading'}... ${pct}% (${formatSize(byteOffset)} / ${formatSize(totalSize)})`;
        lastProgressUpdate = now;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (signal && signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

  const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
  progress.value = progress.max;
  return { blob: new Blob(blobParts), elapsed };
}

// Download an object through the SDK's built-in parallel shard fetching.
// The multi-worker Web Worker pool is kept around (see parallelDownloadToDisk)
// for the write-to-disk path, but is disabled for in-memory downloads —
// multiple SDK instances compete for Chrome's 64 WebTransport session limit
// and the SDK already parallelises shards internally.
async function parallelDownload(objectUrl, status, progress, label, _numWorkers, _workerStatusRef, _hostStatsRef, signal) {
  progress.style.display = 'block';

  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const primarySdk = await connectSdk(noopStatus);
  if (!primarySdk) return null;
  const { sdk, obj, fallback } = await resolveObject(objectUrl, primarySdk);
  if (fallback) status.textContent = `Found on fallback indexer: ${fallback}`;
  progress.max = obj.slabs().length;

  return streamingDownload(sdk, obj, status, progress, label, signal);
}

// Stream an object to a writable destination via the SDK's built-in
// parallel shard download. `writable` is anything with an `async write(bytes)`
// method — a FileSystemWritableStream from `showSaveFilePicker`, or a
// CRC-tracking proxy from the ZIP builder. `bytesCallback(totalBytes)`
// is invoked after each chunk for UI updates.
async function parallelDownloadToDisk(objectUrl, writable, status, progress, bytesCallback, _numWorkers, _workerStatusRef, _hostStatsRef) {
  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const primarySdk = await connectSdk(noopStatus);
  if (!primarySdk) return null;

  const { sdk, obj } = await resolveObject(objectUrl, primarySdk);
  const totalSize = Number(obj.size());
  progress.max = totalSize || 1;
  progress.value = 0;

  const reader = sdk.download(obj).getReader();
  const downloadStart = performance.now();
  let bytesWritten = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      await writable.write(bytes);
      bytesWritten += bytes.length;
      progress.value = bytesWritten;
      if (bytesCallback) bytesCallback(bytesWritten);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }

  const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
  return { elapsed, size: totalSize };
}

// Check if the download streaming Service Worker is ready
// Returns the active SW registration, or null if unavailable.
// Uses reg.active (not navigator.serviceWorker.controller, which can
// be null even when the SW is active and intercepting fetches).
async function getActiveServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return reg.active || null;
  } catch {
    return null;
  }
}

// Streaming download via Service Worker. The SW intercepts a synthetic
// /_download/<uuid> fetch and serves a ReadableStream that we feed
// chunk-by-chunk — giving the browser a native download entry with
// progress bar. We pull bytes straight from sdk.download(obj) and post
// each chunk across. Unused `numWorkers` / `workerStatusRef` / `hostStatsRef`
// params stay for callsite compatibility.
async function parallelDownloadViaSW(objectUrl, filename, size, status, progress, bytesCallback, _numWorkers, _workerStatusRef, onMetadata, _hostStatsRef) {
  const uuid = crypto.randomUUID();
  const sw = await getActiveServiceWorker();
  sw.postMessage({ type: 'start-download', uuid, filename, size: size || 0 });

  let cancelled = false;
  const onSWMessage = (e) => {
    if (e.data.type === 'download-cancelled' && e.data.uuid === uuid) cancelled = true;
  };
  navigator.serviceWorker.addEventListener('message', onSWMessage);

  await new Promise((r) => setTimeout(r, 50));

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = `/_download/${uuid}`;
  document.body.appendChild(iframe);

  function cleanup() {
    navigator.serviceWorker.removeEventListener('message', onSWMessage);
    iframe.remove();
  }

  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const primarySdk = await connectSdk(noopStatus);
  if (!primarySdk) {
    sw.postMessage({ type: 'download-error', uuid, error: 'SDK connection failed' });
    cleanup();
    return null;
  }

  if (cancelled) { cleanup(); return null; }
  const { sdk, obj } = await resolveObject(objectUrl, primarySdk);
  const totalSize = Number(obj.size());
  if (onMetadata) onMetadata({ size: totalSize, slabCount: obj.slabs().length });
  progress.max = totalSize || 1;
  progress.value = 0;

  const reader = sdk.download(obj).getReader();
  let bytesWritten = 0;
  try {
    for (;;) {
      if (cancelled) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Hand the chunk to the SW. Transfer the buffer so no copy is made.
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      sw.postMessage({ type: 'download-chunk', uuid, data: buf }, [buf]);
      bytesWritten += bytes.length;
      progress.value = bytesWritten;
      if (bytesCallback) bytesCallback(bytesWritten);
    }
    if (cancelled) {
      sw.postMessage({ type: 'download-error', uuid, error: 'cancelled' });
    } else {
      sw.postMessage({ type: 'download-end', uuid });
    }
  } catch (e) {
    sw.postMessage({ type: 'download-error', uuid, error: e.message || String(e) });
    throw e;
  } finally {
    try { reader.releaseLock(); } catch (_) {}
    cleanup();
  }
  return { size: totalSize };
}


export {
  streamingDownload,
  parallelDownload,
  parallelDownloadToDisk,
  getActiveServiceWorker,
  parallelDownloadViaSW,
};
