import { _esc, formatSize } from './utils.js';
import { connectSdk, resolveObject, getUrl, getKeyHex, getMaxDownloads, getLogLevel } from './config.js';
import { withKeepAlive } from './keep-alive.js';
import {
  parallelDownload, parallelDownloadToDisk, getActiveServiceWorker, parallelDownloadViaSW,
} from './download.js';

export function initDownloadUI() {
  let _downloadInProgress = false;

  // -- Download File --
  document.getElementById('btn-download').addEventListener('click', async () => {
    if (_downloadInProgress) return;
    _downloadInProgress = true;
    document.getElementById('btn-download').disabled = true;
    document.getElementById('btn-download-simple').disabled = true;
    const status = document.getElementById('dl-status');
    const progress = document.getElementById('dl-progress');
    const input = document.getElementById('dl-url').value.trim();
    const filename = document.getElementById('dl-filename').value.trim() || 'download';

    progress.style.display = 'none';
    progress.value = 0;

    if (!input) {
      status.innerHTML = '<span class="fail">Enter an Object ID or Share URL</span>';
      return;
    }

    // Decide download path immediately (before any async work).
    // File System Access API: show file picker now (requires user gesture).
    // Service Worker: trigger download now, connect SDK in background.
    // Memory fallback: connect SDK first (need size for large file warning).
    const hasFileSystemAPI = !!window.showSaveFilePicker;
    console.log(`Download path: File System Access API ${hasFileSystemAPI ? 'available' : 'NOT available (secure context: ' + window.isSecureContext + ')'}`);
    let writable = null;
    if (hasFileSystemAPI) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
        });
        writable = await handle.createWritable();
      } catch (e) {
        if (e.name === 'AbortError') return;
        throw e;
      }
    }

    let progressInterval = null;
    let size = 0;
    let downloadStart;
    let bytesDownloaded = 0;
    let workerStatus = [];
    const hostStats = new Map(); // publicKey -> { host, sectors, firstSeen, lastSeen }
    const SECTOR_SIZE = 4 * 1024 * 1024; // 4 MiB
    const HOST_STALE_MS = 15000; // hide hosts inactive for 15s
    const speedSamples = []; // [{time, bytes}] for rolling speed
    const SPEED_WINDOW_MS = 5000;

    const formatTime = (seconds) => {
      if (seconds < 60) return `${seconds.toFixed(0)}s`;
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    };

    const updateProgress = () => {
      const currentSlab = progress.value || 0;
      const totalSlabs = progress.max || 0;
      if (totalSlabs === 0) return;

      const now = performance.now();
      const elapsed = (now - downloadStart) / 1000;

      // Format a host for display: country flag + truncated address
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

      const countryFlag = (cc) => {
        if (!cc || cc.length !== 2) return '';
        return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
      };

      // Per-host speeds (only show recently-active hosts)
      const allEntries = Array.from(hostStats.entries())
        .map(([key, s]) => {
          const hostElapsed = (now - s.firstSeen) / 1000;
          const hostSpeed = hostElapsed > 0.5 ? (s.sectors * SECTOR_SIZE) / hostElapsed : 0;
          const stale = (now - s.lastSeen) > HOST_STALE_MS;
          return { host: s.host, sectors: s.sectors, speed: hostSpeed, stale };
        });
      const active = allEntries.filter(h => !h.stale).sort((a, b) => b.sectors - a.sectors);
      const hostLines = active
        .map(h => `  ${fmtHost(h.host)} — ${h.sectors} sectors • ${(h.speed / 1e6).toFixed(1)} MB/s`)
        .join('\n');

      // No slabs completed yet — downloading sectors but first slab hasn't finished
      if (currentSlab === 0) {
        const sizeInfo = size > 0 ? `Downloading ${formatSize(size)} (${totalSlabs} slabs)` : 'Downloading';
        const phase = hostStats.size > 0 ? 'Downloading from Sia hosts' : 'Connecting to Sia hosts';
        const header = `${sizeInfo}\n${phase}... (${formatTime(elapsed)} elapsed)`;
        status.textContent = hostLines ? `${header}\n${hostLines}` : header;
        return;
      }

      const percentage = ((currentSlab / totalSlabs) * 100).toFixed(1);

      // Rolling-window speed (last 5s)
      speedSamples.push({ time: now, bytes: bytesDownloaded });
      const cutoff = now - SPEED_WINDOW_MS;
      while (speedSamples.length > 1 && speedSamples[0].time < cutoff) speedSamples.shift();
      const oldest = speedSamples[0];
      const dt = (now - oldest.time) / 1000;
      const speed = dt > 0.5 ? (bytesDownloaded - oldest.bytes) / dt : 0;
      const remaining = size - bytesDownloaded;
      const eta = speed > 0 ? remaining / speed : 0;

      const speedMBps = (speed / 1e6).toFixed(2);
      const line1 = `Downloading... ${currentSlab}/${totalSlabs} slabs (${percentage}%) • ${formatSize(bytesDownloaded)} / ${formatSize(size)}`;
      const line2 = `${speedMBps} MB/s • ${formatTime(elapsed)} elapsed • ~${formatTime(eta)} remaining`;

      status.textContent = hostLines ? `${line1}\n${line2}\n${hostLines}` : `${line1}\n${line2}`;
    };

    try { await withKeepAlive(async () => {
      // Path 1: File System Access API (Chrome/Edge — file picker already shown above)
      if (writable) {
        console.log('Using download path: File System Access API');
        const primarySdk = await connectSdk(status);
        if (!primarySdk) { try { await writable.abort(); } catch (_) { } return; }

        status.innerHTML += '\nFetching object metadata...';
        const { sdk, obj } = await resolveObject(input, primarySdk);
        size = obj.size();
        status.innerHTML = `Object found: ${formatSize(size)}`;

        progress.style.display = 'block';
        downloadStart = performance.now();
        progressInterval = setInterval(updateProgress, 100);
        try {
          await parallelDownloadToDisk(input, writable, status, progress,
            (bytes) => { bytesDownloaded = bytes; }, undefined, workerStatus, hostStats);
          await writable.close();
        } catch (e) {
          try { await writable.abort(); } catch (_) { }
          throw e;
        }
      } else if (await getActiveServiceWorker()) {
        // Path 2: Service Worker streaming (Brave, Firefox, Safari)
        // parallelDownloadViaSW triggers the browser download immediately,
        // then connects SDK and spawns workers internally.
        console.log('Using download path: Service Worker streaming');
        progress.style.display = 'block';
        downloadStart = performance.now();
        progressInterval = setInterval(updateProgress, 100);
        const result = await parallelDownloadViaSW(input, filename, 0, status, progress,
          (bytes) => { bytesDownloaded = bytes; }, undefined, workerStatus,
          (meta) => { size = meta.size; }, hostStats);
        if (!result) {
          clearInterval(progressInterval);
          status.innerHTML = '<span class="fail">Download failed — could not connect</span>';
          return;
        }
        size = result.size;
        bytesDownloaded = result.size;
      } else {
        // Path 3: Memory fallback (no File System Access API, no SW)
        console.log('Using download path: Memory fallback');
        const primarySdk = await connectSdk(status);
        if (!primarySdk) return;

        status.innerHTML += '\nFetching object metadata...';
        const { obj } = await resolveObject(input, primarySdk);
        size = obj.size();
        const sizeMB = size / (1024 * 1024);
        if (sizeMB > 500) {
          const proceed = confirm(
            `Your browser doesn't support streaming to disk.\n\n` +
            `File size: ${formatSize(size)}\n\n` +
            `The file will be downloaded into memory first. Files over ~500MB may cause browser instability.\n\n` +
            `For large files, use Chrome or Edge.\n\n` +
            `Download anyway?`
          );
          if (!proceed) return;
        }

        progress.style.display = 'block';
        downloadStart = performance.now();
        progressInterval = setInterval(updateProgress, 100);
        const result = await parallelDownload(input, status, progress, 'Downloading', undefined, workerStatus, hostStats);
        bytesDownloaded = result.size;
        size = result.size;
        const blob = result.blob;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      clearInterval(progressInterval);
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
      progress.value = progress.max;
      status.innerHTML = `File: ${_esc(filename)}\nSize: ${formatSize(size)}\nDownloaded in ${elapsed}s\n<span class="pass">Saved to disk!</span>`;
    }); } catch (e) {
      if (progressInterval) clearInterval(progressInterval);
      console.error('Download error:', e);
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message || e.toString?.() || String(e))}</span>`;
    } finally {
      _downloadInProgress = false;
      document.getElementById('btn-download').disabled = false;
      document.getElementById('btn-download-simple').disabled = false;
    }
  });

  // -- Single-worker Download (one SDK instance in a dedicated worker) --
  document.getElementById('btn-download-simple').addEventListener('click', async () => {
    if (_downloadInProgress) return;
    _downloadInProgress = true;
    document.getElementById('btn-download').disabled = true;
    document.getElementById('btn-download-simple').disabled = true;
    const status = document.getElementById('dl-status');
    const progress = document.getElementById('dl-progress');
    const input = document.getElementById('dl-url').value.trim();
    const filename = document.getElementById('dl-filename').value.trim() || 'download';

    progress.style.display = 'none';
    progress.value = 0;

    if (!input) {
      status.innerHTML = '<span class="fail">Enter an Object ID or Share URL</span>';
      return;
    }

    const url = getUrl();
    const keyHex = getKeyHex();
    if (!url || !keyHex) {
      status.innerHTML = '<span class="fail">Set Indexer URL and App Key in Settings first</span>';
      return;
    }

    const HOST_STALE_MS = 15000;
    const hostStats = new Map();
    const blobParts = [];
    let bytesDownloaded = 0;
    let size = 0;
    let downloadStart = performance.now();
    const speedSamples = [];

    const countryFlag = (cc) => {
      if (!cc || cc.length !== 2) return '';
      return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
    };
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
    const formatTime = (seconds) => {
      if (seconds < 60) return `${seconds.toFixed(0)}s`;
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    };

    try {
      // Spawn single download worker
      status.textContent = 'Starting download worker...';
      const worker = new Worker('./single-download-worker.js', { type: 'module' });

      const workerReady = new Promise((resolve, reject) => {
        const handler = (e) => {
          if (e.data.type === 'ready') { worker.removeEventListener('message', handler); resolve(); }
          if (e.data.type === 'error') { worker.removeEventListener('message', handler); reject(new Error(e.data.message)); }
        };
        worker.addEventListener('message', handler);
      });
      worker.postMessage({
        type: 'init',
        indexerUrl: url,
        keyHex,
        maxDownloads: getMaxDownloads(),
        logLevel: getLogLevel(),
      });
      await workerReady;

      // Update display periodically (main thread is free!)
      const progressInterval = setInterval(() => {
        if (size === 0) return;
        const now = performance.now();
        const elapsed = (now - downloadStart) / 1000;
        speedSamples.push({ time: now, bytes: bytesDownloaded });
        const cutoff = now - 5000;
        while (speedSamples.length > 1 && speedSamples[0].time < cutoff) speedSamples.shift();
        const oldest = speedSamples[0];
        const dt = (now - oldest.time) / 1000;
        const speed = dt > 0.5 ? (bytesDownloaded - oldest.bytes) / dt : 0;
        const eta = speed > 0 ? (size - bytesDownloaded) / speed : 0;

        const pct = size > 0 ? ((bytesDownloaded / size) * 100).toFixed(1) : '0';
        const line1 = `Downloading... ${formatSize(bytesDownloaded)} / ${formatSize(size)} (${pct}%)`;
        const line2 = `${(speed / 1e6).toFixed(2)} MB/s \u2022 ${formatTime(elapsed)} elapsed` + (eta > 0 ? ` \u2022 ~${formatTime(eta)} remaining` : '');

        const active = Array.from(hostStats.entries())
          .map(([key, s]) => {
            const stale = (now - s.lastSeen) > HOST_STALE_MS;
            return { host: s.host, stale, sectors: s.sectors };
          })
          .filter(h => !h.stale)
          .sort((a, b) => b.sectors - a.sectors);
        const hostLines = active.slice(0, 10)
          .map(h => {
            const cc = h.host.countryCode;
            const flag = cc && cc.length === 2 ? countryFlag(cc) + ' ' : '';
            return `  ${flag}${fmtHostAddr(h.host)} \u2014 ${h.sectors} sectors`;
          })
          .join('\n');
        status.textContent = hostLines ? `${line1}\n${line2}\n${hostLines}` : `${line1}\n${line2}`;
        progress.value = bytesDownloaded;
        progress.max = size;
      }, 200);

      // Start download
      await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.type === 'metadata') {
            size = e.data.size;
            progress.style.display = 'block';
            progress.max = size;
            downloadStart = performance.now();
            status.textContent = `Object found: ${formatSize(size)}. Downloading...`;
          }
          if (e.data.type === 'chunk') {
            blobParts.push(new Uint8Array(e.data.data));
            bytesDownloaded += e.data.length;
          }
          if (e.data.type === 'host-active') {
            const host = e.data.host;
            const key = host.publicKey;
            const t = performance.now();
            if (!hostStats.has(key)) {
              hostStats.set(key, { host, firstSeen: t, lastSeen: t, sectors: 1 });
            } else {
              const hs = hostStats.get(key);
              hs.sectors++;
              hs.lastSeen = t;
            }
          }
          if (e.data.type === 'done') {
            worker.terminate();
            resolve();
          }
          if (e.data.type === 'error') {
            worker.terminate();
            reject(new Error(e.data.message));
          }
        };
        worker.postMessage({ type: 'download', input, maxDownloads: getMaxDownloads() });
      });

      clearInterval(progressInterval);
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
      progress.value = progress.max;

      // Save to disk
      const blob = new Blob(blobParts);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);

      status.innerHTML = `File: ${_esc(filename)}\nSize: ${formatSize(bytesDownloaded)}\nDownloaded in ${elapsed}s (single worker, 1 SDK)\n<span class="pass">Saved to disk!</span>`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message || e)}</span>`;
    } finally {
      _downloadInProgress = false;
      document.getElementById('btn-download').disabled = false;
      document.getElementById('btn-download-simple').disabled = false;
    }
  });
}
