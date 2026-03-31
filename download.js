// Download helpers — streaming download, parallel slab download via Web Workers,
// service worker streaming, and disk-based download.

import { _dbg, _dbgWarn, formatSize } from './utils.js';
import { getUrl, getKeyHex, getMaxDownloads, getDownloadWorkers, getLogLevel } from './config.js';
import { DownloadOptions } from './pkg/indexd_wasm.js';

async function streamingDownload(sdk, obj, status, progress, label) {
  progress.style.display = 'block';
  status.textContent = label || 'Downloading...';

  const downloadStart = performance.now();
  let lastProgressUpdate = 0;
  const PROGRESS_THROTTLE_MS = 100;

  const blobParts = [];
  const dlOpts = new DownloadOptions();
  dlOpts.maxInflight = getMaxDownloads();
  await sdk.downloadStreaming(obj, dlOpts,
    (chunk) => { blobParts.push(chunk); },
    (current, total) => {
      const now = performance.now();
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || current === total) {
        progress.max = total;
        progress.value = current;
        status.textContent = `${label || 'Downloading'}... ${current}/${total} slabs`;
        lastProgressUpdate = now;
      }
    },
  );

  const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
  progress.value = progress.max;
  return { blob: new Blob(blobParts), elapsed };
}

// ── Shared helpers for parallel download functions ────────────────────

// Creates a pool of Web Workers, each with its own SDK instance.
// Returns { workers, readyPromises } — await readyPromises before assigning work.
function createWorkerPool(numWorkers, objectUrl) {
  const config = {
    type: 'init',
    indexerUrl: getUrl(),
    keyHex: getKeyHex(),
    maxDownloads: getMaxDownloads(),
    objectUrl,
    logLevel: getLogLevel(),
  };
  const workers = [];
  const readyPromises = [];
  for (let i = 0; i < numWorkers; i++) {
    const w = new Worker('./slab-download-worker.js', { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', handler); resolve(); }
        if (e.data.type === 'error') { w.removeEventListener('message', handler); reject(new Error(e.data.message)); }
      };
      w.addEventListener('message', handler);
    });
    w.postMessage(config);
    workers.push(w);
    readyPromises.push(ready);
  }
  return { workers, readyPromises };
}

// Initializes workerStatusRef after workers are ready.
function initWorkerStatus(workerStatusRef, workers) {
  if (!workerStatusRef) return;
  workerStatusRef.length = 0;
  for (let i = 0; i < workers.length; i++) {
    workerStatusRef.push({ currentSlab: null, completed: 0, bytes: 0, activeHost: null });
  }
}

// Manages slab assignment, message handling, retries, and completion.
//
// options:
//   workerStatusRef  — array for per-worker status tracking
//   hostStatsRef     — Map for per-host stats
//   slabLengths      — array of per-slab byte lengths (if null, uses data.byteLength)
//   bytesCallback    — optional (totalBytes) => void
//   onSlabData(idx, data) — called with each completed slab's ArrayBuffer
//   onAllDone()      — called when all slabs complete; may return a Promise
//   onFatalError(msg)— optional; called on unrecoverable slab error
//   isCancelled()    — optional; returns boolean (for SW cancel support)
function runSlabDownload(workers, slabCount, progress, options) {
  const {
    workerStatusRef, hostStatsRef, slabLengths,
    bytesCallback, onSlabData, onAllDone, onFatalError, isCancelled,
  } = options;

  let nextSlab = 0;
  let completedSlabs = 0;
  let bytesDownloaded = 0;
  const slabRetryCounts = new Map();
  const maxSlabRetries = 3;

  return new Promise((resolve, reject) => {
    let rejected = false;
    const workerIndexMap = new Map();

    function assignWork(worker) {
      if (nextSlab >= slabCount || rejected) return;
      if (isCancelled && isCancelled()) return;
      const idx = nextSlab++;
      const wi = workerIndexMap.get(worker);
      if (wi !== undefined && workerStatusRef) workerStatusRef[wi].currentSlab = idx;
      worker.postMessage({ type: 'download-slab', slabIndex: idx });
    }

    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      workerIndexMap.set(w, i);
      w.onmessage = (e) => {
        if (rejected) return;
        if (isCancelled && isCancelled()) return;

        if (e.data.type === 'host-active') {
          const host = e.data.host;
          const key = host.publicKey;
          const wi = workerIndexMap.get(w);
          if (wi !== undefined && workerStatusRef) workerStatusRef[wi].activeHost = key;
          if (hostStatsRef) {
            const t = performance.now();
            if (!hostStatsRef.has(key)) hostStatsRef.set(key, { host, sectors: 0, firstSeen: t, lastSeen: t });
            const hs = hostStatsRef.get(key);
            hs.sectors++;
            hs.lastSeen = t;
          }
          return;
        }

        if (e.data.type === 'slab-data') {
          const idx = e.data.slabIndex;
          const wi = workerIndexMap.get(w);
          const slabBytes = slabLengths ? slabLengths[idx] : e.data.data.byteLength;
          if (wi !== undefined && workerStatusRef) {
            workerStatusRef[wi].completed++;
            workerStatusRef[wi].bytes += slabBytes;
            workerStatusRef[wi].currentSlab = null;
            workerStatusRef[wi].activeHost = null;
          }
          onSlabData(idx, e.data.data);
          completedSlabs++;
          bytesDownloaded += slabBytes;
          if (bytesCallback) bytesCallback(bytesDownloaded);

          progress.max = slabCount;
          progress.value = completedSlabs;

          if (completedSlabs === slabCount) {
            workers.forEach(w => w.terminate());
            progress.value = progress.max;
            Promise.resolve(onAllDone()).then(resolve, reject);
          } else {
            assignWork(w);
          }
        }

        if (e.data.type === 'slab-error') {
          const idx = e.data.slabIndex;
          const retries = (slabRetryCounts.get(idx) || 0) + 1;
          slabRetryCounts.set(idx, retries);
          if (retries <= maxSlabRetries) {
            const delay = 3000 * retries + Math.random() * 2000;
            console.warn(`Slab ${idx} failed (attempt ${retries}/${maxSlabRetries}), re-queuing in ${(delay/1000).toFixed(1)}s...`);
            const wi = workerIndexMap.get(w);
            if (wi !== undefined && workerStatusRef) workerStatusRef[wi].currentSlab = null;
            setTimeout(() => {
              if (rejected) return;
              if (isCancelled && isCancelled()) return;
              const wi = workerIndexMap.get(w);
              if (wi !== undefined && workerStatusRef) workerStatusRef[wi].currentSlab = idx;
              w.postMessage({ type: 'download-slab', slabIndex: idx });
            }, delay);
          } else {
            rejected = true;
            if (onFatalError) onFatalError(e.data.message);
            workers.forEach(w => w.terminate());
            reject(new Error(`Slab ${idx}: ${e.data.message} (after ${retries} attempts)`));
          }
        }
      };
      assignWork(w);
    }
  });
}

// Parallel slab download — spawns a pool of Web Workers, each with its own
// SDK instance and thread, to download slabs in true parallelism.
// Falls back to streamingDownload for files with <= 2 slabs.
async function parallelDownload(objectUrl, status, progress, label, numWorkers, workerStatusRef, hostStatsRef) {
  numWorkers = numWorkers || getDownloadWorkers();
  progress.style.display = 'block';

  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const sdk = await connectSdk(noopStatus);
  if (!sdk) return null;
  const obj = objectUrl.startsWith('sia://')
    ? await sdk.sharedObject(objectUrl)
    : await sdk.object(objectUrl);
  const slabCount = obj.slabCount();
  const totalSize = obj.size();
  progress.max = slabCount;

  if (slabCount <= 2) {
    return streamingDownload(sdk, obj, status, progress, label);
  }

  const actualWorkers = Math.min(numWorkers, slabCount);
  const { workers, readyPromises } = createWorkerPool(actualWorkers, objectUrl);
  await Promise.all(readyPromises);
  initWorkerStatus(workerStatusRef, workers);

  const downloadStart = performance.now();
  const slabData = new Array(slabCount);

  return runSlabDownload(workers, slabCount, progress, {
    workerStatusRef, hostStatsRef,
    onSlabData: (idx, data) => { slabData[idx] = data; },
    onAllDone: () => {
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
      return { blob: new Blob(slabData), elapsed, size: totalSize };
    },
  });
}

// Parallel slab download to disk via File System Access API.
// Writes slabs to a FileSystemWritableStream in order as they complete.
async function parallelDownloadToDisk(objectUrl, writable, status, progress, bytesCallback, numWorkers, workerStatusRef, hostStatsRef) {
  numWorkers = numWorkers || getDownloadWorkers();

  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const sdk = await connectSdk(noopStatus);
  if (!sdk) return null;

  const obj = objectUrl.startsWith('sia://')
    ? await sdk.sharedObject(objectUrl)
    : await sdk.object(objectUrl);
  const slabCount = obj.slabCount();
  const slabLengths = Array.from(obj.slabLengths());
  const totalSize = obj.size();
  progress.max = slabCount;

  const actualWorkers = Math.min(numWorkers, slabCount);
  const { workers, readyPromises } = createWorkerPool(actualWorkers, objectUrl);
  await Promise.all(readyPromises);
  initWorkerStatus(workerStatusRef, workers);

  const downloadStart = performance.now();
  let nextSlabToWrite = 0;
  const pendingSlabs = new Map();
  let flushDone = Promise.resolve();
  let flushing = false;
  let writeError = null;

  function tryFlush() {
    if (flushing || writeError) return;
    flushing = true;
    flushDone = (async () => {
      try {
        while (pendingSlabs.has(nextSlabToWrite)) {
          const data = pendingSlabs.get(nextSlabToWrite);
          await writable.write(new Uint8Array(data));
          pendingSlabs.delete(nextSlabToWrite);
          nextSlabToWrite++;
        }
      } catch (e) {
        writeError = e;
        throw e;
      } finally {
        flushing = false;
      }
    })();
  }

  return runSlabDownload(workers, slabCount, progress, {
    workerStatusRef, hostStatsRef, slabLengths, bytesCallback,
    onSlabData: (idx, data) => { pendingSlabs.set(idx, data); tryFlush(); },
    onAllDone: () => flushDone.then(() => {
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
      return { elapsed, size: totalSize };
    }),
  });
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

// Parallel slab download via Service Worker streaming.
// Pushes ordered slab data through a MessagePort to the SW, which
// responds to a synthetic fetch with a ReadableStream — giving the
// browser a normal streaming download with download-bar progress.
async function parallelDownloadViaSW(objectUrl, filename, size, status, progress, bytesCallback, numWorkers, workerStatusRef, onMetadata, hostStatsRef) {
  numWorkers = numWorkers || getDownloadWorkers();

  // Trigger the browser download immediately — before any SDK connection.
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

  // Spawn workers in parallel with main-thread SDK connection
  const { workers, readyPromises } = createWorkerPool(numWorkers, objectUrl);

  const noopStatus = { set textContent(_) {}, set innerHTML(_) {} };
  const sdkPromise = connectSdk(noopStatus);
  const [sdk] = await Promise.all([sdkPromise, Promise.all(readyPromises)]);
  if (!sdk) {
    sw.postMessage({ type: 'download-error', uuid, error: 'SDK connection failed' });
    workers.forEach(w => w.terminate());
    cleanup();
    return null;
  }

  if (cancelled) { workers.forEach(w => w.terminate()); cleanup(); return null; }
  const obj = objectUrl.startsWith('sia://')
    ? await sdk.sharedObject(objectUrl)
    : await sdk.object(objectUrl);
  const slabCount = obj.slabCount();
  const slabLengths = Array.from(obj.slabLengths());
  const totalSize = obj.size();
  progress.max = slabCount;

  if (onMetadata) onMetadata({ size: totalSize, slabCount });
  if (cancelled) { workers.forEach(w => w.terminate()); cleanup(); return null; }

  // Trim excess workers if fewer slabs than workers
  while (workers.length > Math.min(numWorkers, slabCount)) {
    workers.pop().terminate();
  }
  initWorkerStatus(workerStatusRef, workers);

  let nextSlabToWrite = 0;
  const pendingSlabs = new Map();

  function tryFlush() {
    while (pendingSlabs.has(nextSlabToWrite)) {
      const data = pendingSlabs.get(nextSlabToWrite);
      pendingSlabs.delete(nextSlabToWrite);
      sw.postMessage({ type: 'download-chunk', uuid, data }, [data]);
      nextSlabToWrite++;
    }
  }

  return runSlabDownload(workers, slabCount, progress, {
    workerStatusRef, hostStatsRef, slabLengths, bytesCallback,
    isCancelled: () => cancelled,
    onSlabData: (idx, data) => { pendingSlabs.set(idx, data); tryFlush(); },
    onAllDone: () => {
      sw.postMessage({ type: 'download-end', uuid });
      cleanup();
      return { size: totalSize };
    },
    onFatalError: (msg) => {
      sw.postMessage({ type: 'download-error', uuid, error: msg });
      cleanup();
    },
  });
}


export {
  streamingDownload,
  createWorkerPool,
  initWorkerStatus,
  runSlabDownload,
  parallelDownload,
  parallelDownloadToDisk,
  getActiveServiceWorker,
  parallelDownloadViaSW,
};
