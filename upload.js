// Upload helpers — parallel slab upload via Web Workers and
// compute-worker encoding with main-thread upload.

import { _dbg, formatSize } from './utils.js';
import { getUrl, getKeyHex, getMaxUploads, getUploadWorkers, getLogLevel, connectSdk } from './config.js';
import { UploadOptions } from './pkg/indexd_wasm.js';

// ── Parallel Slab Upload via Web Worker Pool ──────────────────────────
//
// Splits a file into slab-sized chunks (~40 MB each), distributes them
// to a pool of Web Workers, each with its own SDK instance, and uploads
// slabs in parallel. Returns a PinnedObject ready to pin to the indexer.
//
// For small files (≤2 slabs) falls back to single-threaded upload.

async function parallelUpload(file, status, progress, numWorkers) {
  numWorkers = numWorkers || getUploadWorkers();
  progress.style.display = 'block';

  // 1. Get metadata on main thread
  const sdk = await connectSdk(status);
  if (!sdk) return null;

  const fileSize = file.size;
  const SLAB_DATA_SIZE = sdk.slabDataSize(); // 10 * 4 MiB = 41,943,040
  const slabCount = fileSize === 0 ? 0 : Math.ceil(fileSize / SLAB_DATA_SIZE);

  // 2. Generate shared data key on main thread
  const dataKey = sdk.generateDataKey(); // Uint8Array(32)
  // Copy key to a plain ArrayBuffer for transfer to workers
  const dataKeyBuf = dataKey.buffer.slice(dataKey.byteOffset, dataKey.byteOffset + dataKey.byteLength);

  // 3. Spawn worker pool
  const actualWorkers = numWorkers;

  const config = {
    type: 'init',
    indexerUrl: getUrl(),
    keyHex: getKeyHex(),
    maxUploads: getMaxUploads(),
    logLevel: getLogLevel(),
  };

  status.textContent = `Connecting ${actualWorkers} upload workers...`;
  const workers = [];
  const readyPromises = [];

  for (let i = 0; i < actualWorkers; i++) {
    const w = new Worker('./slab-upload-worker.js', { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', handler); resolve(); }
        if (e.data.type === 'error') { w.removeEventListener('message', handler); reject(new Error(e.data.message)); }
      };
      w.addEventListener('message', handler);
    });
    w.postMessage({ ...config, workerIndex: i, numWorkers: actualWorkers });
    workers.push(w);
    readyPromises.push(ready);
  }

  await Promise.all(readyPromises);

  // 4. Assign slabs to workers round-robin and collect results
  const uploadStart = performance.now();
  const slabJsons = new Array(slabCount);
  const totalShards = slabCount * 30;
  const slabShards = new Array(slabCount).fill(0);
  let nextSlab = 0;
  let completedSlabs = 0;
  const hostStats = new Map();
  const SECTOR_SIZE = 4 * 1024 * 1024;
  const HOST_STALE_MS = 15000;
  const speedSamples = [];
  const SPEED_WINDOW_MS = 5000;
  let shardsUploaded = 0;

  const countryFlag = (cc) => {
    if (!cc || cc.length !== 2) return '';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
  };
  const fmtHost = (host) => {
    if (!host) return '';
    const flag = host.countryCode ? countryFlag(host.countryCode) + ' ' : '';
    const addr = host.addresses && host.addresses.length > 0
      ? host.addresses[0].address : host.publicKey.slice(0, 16) + '\u2026';
    let h = addr.replace(/^https?:\/\//, '').replace(/\/sia\/rhp\/v4$/, '');
    if (h.includes('.sia.host')) {
      const colIdx = h.lastIndexOf(':');
      const name = colIdx > 0 ? h.slice(0, colIdx) : h;
      const port = colIdx > 0 ? h.slice(colIdx) : '';
      const prefix = name.slice(0, name.indexOf('.sia.host'));
      h = prefix.slice(0, 8) + '\u2026sia.host' + port;
    }
    return flag + h;
  };
  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const updateUploadProgress = () => {
    const now = performance.now();
    const elapsed = (now - uploadStart) / 1000;
    const bytesUploaded = shardsUploaded * SECTOR_SIZE;

    speedSamples.push({ time: now, bytes: bytesUploaded });
    const cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 1 && speedSamples[0].time < cutoff) speedSamples.shift();
    const oldest = speedSamples[0];
    const dt = (now - oldest.time) / 1000;
    const speed = dt > 0.5 ? (bytesUploaded - oldest.bytes) / dt : 0;
    const totalBytes = fileSize * 3; // rough: 10-of-30 = 3x redundancy
    const remaining = totalBytes - bytesUploaded;
    const eta = speed > 0 ? remaining / speed : 0;

    const active = Array.from(hostStats.entries())
      .map(([key, s]) => {
        const stale = (now - s.lastSeen) > HOST_STALE_MS;
        const shardElapsed = (now - s.shardStart) / 1000;
        const hostElapsed = (now - s.firstSeen) / 1000;
        const times = s.shardTimes || [];
        const avgMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
        const expectedSec = avgMs > 0 ? avgMs / 1000 : 10; // default 10s estimate
        const pct = Math.min(shardElapsed / expectedSec, 1.0);
        return { host: s.host, stale, shardElapsed, pct, completed: times.length };
      })
      .filter(h => !h.stale)
      .sort((a, b) => b.shardElapsed - a.shardElapsed);

    const hostLines = active.slice(0, 10)
      .map(h => {
        const barLen = 16;
        const filled = Math.round(h.pct * barLen);
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLen - filled);
        return `  ${fmtHost(h.host)} ${bar}`;
      })
      .join('\n');

    const pct = totalShards > 0 ? ((shardsUploaded / totalShards) * 100).toFixed(1) : '0';
    const speedStr = (speed / 1e6).toFixed(2);
    const line1 = `Uploading ${file.name}... ${shardsUploaded}/${totalShards} shards (${pct}%) \u2022 ${actualWorkers} workers`;
    const line2 = `${speedStr} MB/s \u2022 ${formatTime(elapsed)} elapsed` + (eta > 0 ? ` \u2022 ~${formatTime(eta)} remaining` : '');
    status.textContent = hostLines ? `${line1}\n${line2}\n${hostLines}` : `${line1}\n${line2}`;
  };
  const progressInterval = setInterval(updateUploadProgress, 200);

  return new Promise((resolve, reject) => {
    let rejected = false;

    function sendSlabToWorker(worker, idx) {
      const slabOffset = idx * SLAB_DATA_SIZE;
      const slabEnd = Math.min(slabOffset + SLAB_DATA_SIZE, fileSize);
      const blob = file.slice(slabOffset, slabEnd);
      blob.arrayBuffer().then((buf) => {
        worker.postMessage({
          type: 'upload-slab',
          slabIndex: idx,
          data: buf,
          dataKey: dataKeyBuf,
          streamOffset: slabOffset,
        }, [buf]);
      });
    }

    function assignWork(worker) {
      if (nextSlab >= slabCount || rejected) return;
      const idx = nextSlab++;
      sendSlabToWorker(worker, idx);
    }

    for (const w of workers) {
      w.onmessage = (e) => {
        if (rejected) return;

        if (e.data.type === 'shard-progress') {
          slabShards[e.data.slabIndex] = e.data.current;
          shardsUploaded = slabShards.reduce((a, b) => a + b, 0);
          progress.max = totalShards;
          progress.value = shardsUploaded;
        }

        if (e.data.type === 'host-active') {
          const host = e.data.host;
          const key = host.publicKey;
          const t = performance.now();
          if (!hostStats.has(key)) {
            hostStats.set(key, { host, firstSeen: t, lastSeen: t, shardStart: t });
          } else {
            const hs = hostStats.get(key);
            hs.lastSeen = t;
            hs.shardStart = t;
          }
        }

        if (e.data.type === 'slab-uploaded') {
          slabJsons[e.data.slabIndex] = e.data.slabJson;
          completedSlabs++;

          if (completedSlabs === slabCount) {
            clearInterval(progressInterval);
            workers.forEach(w => w.terminate());

            // Assemble the object on the main thread
            try {
              const combinedSlabs = '[' + slabJsons.join(',') + ']';
              const obj = sdk.assembleObject(dataKey, combinedSlabs);
              const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
              progress.value = progress.max;
              resolve({ obj, elapsed, size: fileSize });
            } catch (err) {
              reject(err);
            }
          } else {
            assignWork(w);
          }
        }

        if (e.data.type === 'slab-error') {
          rejected = true;
          clearInterval(progressInterval);
          workers.forEach(w => w.terminate());
          reject(new Error(`Slab ${e.data.slabIndex}: ${e.data.message}`));
        }
      };
      assignWork(w);
    }
  });
}

// ── Compute-worker upload: encode in workers, upload from main thread ──
async function parallelEncodeUpload(file, status, progress, numWorkers) {
  numWorkers = numWorkers || getUploadWorkers();
  progress.style.display = 'block';

  // 1. Connect SDK on main thread (single connection pool)
  const sdk = await connectSdk(status);
  if (!sdk) return null;

  const fileSize = file.size;
  const SLAB_DATA_SIZE = sdk.slabDataSize();
  const slabCount = fileSize === 0 ? 0 : Math.ceil(fileSize / SLAB_DATA_SIZE);
  const dataShards = 10;
  const parityShards = 20;
  const totalShards = slabCount * (dataShards + parityShards);

  // 2. Generate shared data key
  const dataKey = sdk.generateDataKey();
  const dataKeyBuf = dataKey.buffer.slice(dataKey.byteOffset, dataKey.byteOffset + dataKey.byteLength);

  // 3. Spawn encode-only workers
  const actualWorkers = Math.min(numWorkers, slabCount || 1);
  status.textContent = `Starting ${actualWorkers} encode workers...`;
  const workers = [];
  const readyPromises = [];

  for (let i = 0; i < actualWorkers; i++) {
    const w = new Worker('./slab-encode-worker.js', { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', handler); resolve(); }
        if (e.data.type === 'error') { w.removeEventListener('message', handler); reject(new Error(e.data.message)); }
      };
      w.addEventListener('message', handler);
    });
    w.postMessage({ type: 'init', workerIndex: i, logLevel: getLogLevel() });
    workers.push(w);
    readyPromises.push(ready);
  }
  await Promise.all(readyPromises);

  // 4. Orchestrate: encode in workers, upload from main thread
  const uploadStart = performance.now();
  const slabJsons = new Array(slabCount);
  let nextSlab = 0;
  let completedSlabs = 0;
  let shardsUploaded = 0;
  const hostStats = new Map();
  const SECTOR_SIZE = 4 * 1024 * 1024;
  const HOST_STALE_MS = 15000;
  const speedSamples = [];
  const SPEED_WINDOW_MS = 5000;

  const countryFlag = (cc) => {
    if (!cc || cc.length !== 2) return '';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
  };
  const fmtHost = (host) => {
    if (!host) return '';
    const flag = host.countryCode ? countryFlag(host.countryCode) + ' ' : '';
    const addr = host.addresses && host.addresses.length > 0
      ? host.addresses[0].address : host.publicKey.slice(0, 16) + '\u2026';
    let h = addr.replace(/^https?:\/\//, '').replace(/\/sia\/rhp\/v4$/, '');
    if (h.includes('.sia.host')) {
      const colIdx = h.lastIndexOf(':');
      const name = colIdx > 0 ? h.slice(0, colIdx) : h;
      const port = colIdx > 0 ? h.slice(colIdx) : '';
      const prefix = name.slice(0, name.indexOf('.sia.host'));
      h = prefix.slice(0, 8) + '\u2026sia.host' + port;
    }
    return flag + h;
  };
  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  // Show the info card
  const infoCard = document.getElementById('uf-info-card');
  infoCard.style.display = '';
  document.getElementById('uf-card-filename').textContent = file.name;
  document.getElementById('uf-card-size').textContent = `(${formatSize(fileSize)})`;
  const hostTable = document.getElementById('uf-host-table');
  hostTable.style.display = '';
  const hostTbody = document.getElementById('uf-host-tbody');

  const fmtHostAddr = (host) => {
    if (!host) return '';
    const addr = host.addresses && host.addresses.length > 0
      ? host.addresses[0].address : host.publicKey.slice(0, 16) + '\u2026';
    let h = addr.replace(/^https?:\/\//, '').replace(/\/sia\/rhp\/v4$/, '');
    if (h.includes('.sia.host')) {
      const colIdx = h.lastIndexOf(':');
      const name = colIdx > 0 ? h.slice(0, colIdx) : h;
      const port = colIdx > 0 ? h.slice(colIdx) : '';
      const prefix = name.slice(0, name.indexOf('.sia.host'));
      h = prefix.slice(0, 8) + '\u2026sia.host' + port;
    }
    return h;
  };

  const updateProgress = () => {
    const now = performance.now();
    const elapsed = (now - uploadStart) / 1000;
    const bytesUploaded = shardsUploaded * SECTOR_SIZE;

    speedSamples.push({ time: now, bytes: bytesUploaded });
    const cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 1 && speedSamples[0].time < cutoff) speedSamples.shift();
    const oldest = speedSamples[0];
    const dt = (now - oldest.time) / 1000;
    const speed = dt > 0.5 ? (bytesUploaded - oldest.bytes) / dt : 0;
    const totalBytes = fileSize * 3;
    const remaining = totalBytes - bytesUploaded;
    const eta = speed > 0 ? remaining / speed : 0;

    // Update info card
    progress.max = totalShards;
    progress.value = shardsUploaded;
    document.getElementById('uf-card-speed').textContent = `${(speed / 1e6).toFixed(1)} MB/s`;
    document.getElementById('uf-card-detail').textContent = `${shardsUploaded}/${totalShards} shards \u2022 ${completedSlabs}/${slabCount} slabs`;
    document.getElementById('uf-card-elapsed').textContent = formatTime(elapsed);
    document.getElementById('uf-card-shards-done').textContent = `${shardsUploaded} shards`;
    document.getElementById('uf-card-eta').textContent = eta > 0 ? formatTime(eta) : '--';
    document.getElementById('uf-card-hosts-active').textContent = `${hostStats.size} hosts`;

    // Update host table
    const active = Array.from(hostStats.entries())
      .map(([key, s]) => {
        const stale = (now - s.lastSeen) > HOST_STALE_MS;
        const shardElapsed = (now - s.shardStart) / 1000;
        const times = s.shardTimes || [];
        const avgMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
        const hostSpeed = avgMs > 100 ? (SECTOR_SIZE / (avgMs / 1000)) : 0;
        const expectedSec = avgMs > 0 ? avgMs / 1000 : 10;
        const pct = Math.min(shardElapsed / expectedSec, 1.0);
        return { host: s.host, stale, shardElapsed, hostSpeed, pct, completed: times.length };
      })
      .filter(h => !h.stale)
      .sort((a, b) => b.shardElapsed - a.shardElapsed);

    hostTbody.innerHTML = '';
    for (const h of active.slice(0, 15)) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #1a1a1a;';

      // Host cell: flag + address + location
      const tdHost = document.createElement('td');
      tdHost.style.cssText = 'padding:0.5rem 0.75rem;';
      const cc = h.host.countryCode;
      const flag = cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0))) + ' ' : '';
      tdHost.textContent = flag + fmtHostAddr(h.host);
      tr.appendChild(tdHost);

      // Speed cell
      const tdSpeed = document.createElement('td');
      tdSpeed.style.cssText = 'padding:0.5rem 0.5rem; text-align:right; color:#888;';
      tdSpeed.textContent = h.hostSpeed > 0 ? `${(h.hostSpeed / 1e6).toFixed(1)} MB/s` : '--';
      tr.appendChild(tdSpeed);

      // Shard progress cell
      const tdProg = document.createElement('td');
      tdProg.style.cssText = 'padding:0.5rem 0.75rem; text-align:right; white-space:nowrap;';
      const countSpan = document.createElement('span');
      countSpan.style.cssText = 'font-size:0.75rem; color:#666; margin-right:0.4rem; vertical-align:middle;';
      countSpan.textContent = `${h.completed}`;
      tdProg.appendChild(countSpan);
      const barOuter = document.createElement('div');
      barOuter.style.cssText = 'width:60px; height:6px; background:#222; border-radius:3px; display:inline-block; vertical-align:middle;';
      const barInner = document.createElement('div');
      barInner.style.cssText = `width:${(h.pct * 100).toFixed(0)}%; height:100%; background:#4ade80; border-radius:3px; transition:width 0.2s;`;
      barOuter.appendChild(barInner);
      tdProg.appendChild(barOuter);
      tr.appendChild(tdProg);

      hostTbody.appendChild(tr);
    }
  };
  const progressInterval = setInterval(updateProgress, 200);

  // Upload queue: encoded slabs waiting to be uploaded
  const uploadQueue = [];
  let uploading = false;

  async function processUploadQueue() {
    if (uploading) return;
    uploading = true;
    while (uploadQueue.length > 0) {
      const { slabIndex, slabKey, shards, length, minShards, streamOffset } = uploadQueue.shift();

      const shardsArray = [];
      for (let i = 0; i < shards.length; i++) {
        shardsArray.push(new Uint8Array(shards[i]));
      }

      try {
        const opts = new UploadOptions();
        opts.maxInflight = getMaxUploads();
        const slabJson = await sdk.uploadEncodedShards(
          shardsArray,
          new Uint8Array(slabKey),
          length,
          streamOffset,
          minShards,
          opts,
          (current, total) => {
            shardsUploaded = completedSlabs * (dataShards + parityShards) + current;
            progress.max = totalShards;
            progress.value = shardsUploaded;
          },
          (host) => {
            const key = host.publicKey;
            const t = performance.now();
            if (!hostStats.has(key)) {
              hostStats.set(key, { host, firstSeen: t, lastSeen: t, shardStart: t, shardTimes: [] });
            } else {
              const hs = hostStats.get(key);
              hs.lastSeen = t;
              hs.shardStart = t;
            }
          },
          (sc) => {
            const key = sc.hostKey;
            if (hostStats.has(key)) {
              const hs = hostStats.get(key);
              hs.shardTimes.push(sc.elapsedMs);
            }
          },
        );
        slabJsons[slabIndex] = slabJson;
        completedSlabs++;
      } catch (e) {
        clearInterval(progressInterval);
        workers.forEach(w => w.terminate());
        throw e;
      }
    }
    uploading = false;
  }

  return new Promise((resolve, reject) => {
    let rejected = false;
    let encodedCount = 0;

    function sendSlabToWorker(worker, idx) {
      const slabOffset = idx * SLAB_DATA_SIZE;
      const slabEnd = Math.min(slabOffset + SLAB_DATA_SIZE, fileSize);
      const blob = file.slice(slabOffset, slabEnd);
      blob.arrayBuffer().then((buf) => {
        worker.postMessage({
          type: 'encode-slab',
          slabIndex: idx,
          data: buf,
          dataKey: dataKeyBuf,
          streamOffset: slabOffset,
          dataShards,
          parityShards,
        }, [buf]);
      });
    }

    function assignWork(worker) {
      if (nextSlab >= slabCount || rejected) return;
      const idx = nextSlab++;
      sendSlabToWorker(worker, idx);
    }

    for (const w of workers) {
      w.onmessage = (e) => {
        if (rejected) return;

        if (e.data.type === 'slab-encoded') {
          encodedCount++;
          // Queue for upload on main thread
          uploadQueue.push({
            slabIndex: e.data.slabIndex,
            slabKey: e.data.slabKey,
            shards: e.data.shards,
            length: e.data.length,
            minShards: e.data.minShards,
            streamOffset: e.data.slabIndex * SLAB_DATA_SIZE,
          });
          processUploadQueue().then(() => {
            if (completedSlabs === slabCount) {
              clearInterval(progressInterval);
              workers.forEach(w => w.terminate());
              try {
                const combinedSlabs = '[' + slabJsons.join(',') + ']';
                const obj = sdk.assembleObject(dataKey, combinedSlabs);
                const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
                progress.value = progress.max;
                resolve({ obj, elapsed, size: fileSize });
              } catch (err) {
                reject(err);
              }
            }
          }).catch((err) => {
            rejected = true;
            clearInterval(progressInterval);
            workers.forEach(w => w.terminate());
            reject(err);
          });

          // Assign next slab to this worker
          assignWork(w);
        }

        if (e.data.type === 'encode-error') {
          rejected = true;
          clearInterval(progressInterval);
          workers.forEach(w => w.terminate());
          reject(new Error(`Encode slab ${e.data.slabIndex}: ${e.data.message}`));
        }
      };
      assignWork(w);
    }
  });
}

/// Encode-only benchmark: measures erasure coding + encryption throughput
/// without any network I/O. Workers encode slabs and discard the result.
async function encodeOnlyBenchmark(file, numWorkers) {
  numWorkers = numWorkers || getUploadWorkers();
  const fileSize = file.size;
  const SECTOR_SIZE = 4 * 1024 * 1024;
  const dataShards = 10;
  const parityShards = 20;
  const SLAB_DATA_SIZE = dataShards * SECTOR_SIZE;
  const slabCount = fileSize === 0 ? 0 : Math.ceil(fileSize / SLAB_DATA_SIZE);

  const actualWorkers = Math.min(numWorkers, slabCount || 1);
  const workers = [];
  const readyPromises = [];

  for (let i = 0; i < actualWorkers; i++) {
    const w = new Worker('./slab-encode-worker.js', { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', handler); resolve(); }
        if (e.data.type === 'error') { w.removeEventListener('message', handler); reject(new Error(e.data.message)); }
      };
      w.addEventListener('message', handler);
    });
    w.postMessage({ type: 'init', workerIndex: i, logLevel: 'error' });
    workers.push(w);
    readyPromises.push(ready);
  }
  await Promise.all(readyPromises);

  // Generate a dummy data key (32 bytes)
  const dataKeyBuf = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(dataKeyBuf));

  let nextSlab = 0;
  let completedSlabs = 0;

  return new Promise((resolve, reject) => {
    function sendSlabToWorker(worker, idx) {
      const slabOffset = idx * SLAB_DATA_SIZE;
      const slabEnd = Math.min(slabOffset + SLAB_DATA_SIZE, fileSize);
      const blob = file.slice(slabOffset, slabEnd);
      blob.arrayBuffer().then((buf) => {
        worker.postMessage({
          type: 'encode-slab',
          slabIndex: idx,
          data: buf,
          dataKey: dataKeyBuf,
          streamOffset: slabOffset,
          dataShards,
          parityShards,
        }, [buf]);
      });
    }

    function assignWork(worker) {
      if (nextSlab >= slabCount) return;
      sendSlabToWorker(worker, nextSlab++);
    }

    for (const w of workers) {
      w.onmessage = (e) => {
        if (e.data.type === 'slab-encoded') {
          completedSlabs++;
          if (completedSlabs === slabCount) {
            workers.forEach(w => w.terminate());
            resolve({ slabs: slabCount, size: fileSize });
          } else {
            assignWork(w);
          }
        }
        if (e.data.type === 'encode-error') {
          workers.forEach(w => w.terminate());
          reject(new Error(`Encode slab ${e.data.slabIndex}: ${e.data.message}`));
        }
      };
      assignWork(w);
    }
  });
}

export { parallelUpload, parallelEncodeUpload, encodeOnlyBenchmark };
