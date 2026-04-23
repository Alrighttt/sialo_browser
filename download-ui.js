import { _esc, formatSize } from './utils.js';
import { getUrl, getKeyHex, getMaxDownloads, getLogLevel } from './config.js';
import { getActiveTab, trackAbort } from './tabs.js';

// -- Download File --
//
// All file downloads run off the main thread via `single-download-worker.js`.
// The worker hosts its own SDK instance, streams bytes from `sdk.download(obj)`,
// and postMessages chunks back with Transferables so no copies are made. The
// main thread only routes each chunk to the chosen destination (a
// FileSystemWritableStream from `showSaveFilePicker` when available, or an
// in-memory blob as a fallback) and updates the progress display.
export function initDownloadUI() {
  let _downloadInProgress = false;

  const HOST_STALE_MS = 15000;

  const countryFlag = (cc) => {
    if (!cc || cc.length !== 2) return '';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
  };
  const fmtHostAddr = (host) => {
    if (!host) return '';
    const addr = host.addresses && host.addresses.length > 0
      ? host.addresses[0].address : host.publicKey.slice(0, 16) + '…';
    let h = addr.replace(/^https?:\/\//, '').replace(/\/sia\/rhp\/v4$/, '');
    if (h.includes('.sia.host')) {
      const colIdx = h.lastIndexOf(':');
      const name = colIdx > 0 ? h.slice(0, colIdx) : h;
      const port = colIdx > 0 ? h.slice(colIdx) : '';
      const prefix = name.slice(0, name.indexOf('.sia.host'));
      h = prefix.slice(0, 8) + '…sia.host' + port;
    }
    return h;
  };
  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  document.getElementById('btn-download').addEventListener('click', async () => {
    if (_downloadInProgress) return;
    _downloadInProgress = true;
    const btn = document.getElementById('btn-download');
    btn.disabled = true;
    const status = document.getElementById('dl-status');
    const progress = document.getElementById('dl-progress');
    const input = document.getElementById('dl-url').value.trim();
    const filename = document.getElementById('dl-filename').value.trim() || 'download';

    progress.style.display = 'none';
    progress.value = 0;

    if (!input) {
      status.innerHTML = '<span class="fail">Enter an Object ID or Share URL</span>';
      _downloadInProgress = false;
      btn.disabled = false;
      return;
    }

    const url = getUrl();
    const keyHex = getKeyHex();
    if (!url || !keyHex) {
      status.innerHTML = '<span class="fail">Set Indexer URL and App Key in Settings first</span>';
      _downloadInProgress = false;
      btn.disabled = false;
      return;
    }

    // Show the file picker BEFORE spawning the worker — FSA requires the
    // active user-gesture to be unconsumed. A blob-URL memory fallback
    // runs for browsers without FSA.
    let writable = null;
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: filename });
        writable = await handle.createWritable();
      } catch (e) {
        if (e.name === 'AbortError') {
          _downloadInProgress = false;
          btn.disabled = false;
          return;
        }
        status.innerHTML = `<span class="fail">Couldn't open file: ${_esc(e.message || String(e))}</span>`;
        _downloadInProgress = false;
        btn.disabled = false;
        return;
      }
    }

    // Cancellation hooks: close-tab aborts via the tab's abort controller,
    // and we use the same signal to tear the worker down on demand.
    const abortCtrl = new AbortController();
    const untrack = trackAbort(getActiveTab(), abortCtrl);

    const hostStats = new Map();
    const memBuf = writable ? null : [];
    let bytesDownloaded = 0;
    let size = 0;
    let downloadStart = performance.now();
    const speedSamples = [];
    let progressInterval = null;
    let worker = null;
    let writeQueue = Promise.resolve();

    try {
      status.textContent = 'Starting download worker...';
      worker = new Worker('./single-download-worker.js', { type: 'module' });
      abortCtrl.signal.addEventListener('abort', () => {
        try { worker.terminate(); } catch (_) {}
      }, { once: true });

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

      // Periodic UI updates while the worker does the heavy lifting.
      progressInterval = setInterval(() => {
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
        const line2 = `${(speed / 1e6).toFixed(2)} MB/s • ${formatTime(elapsed)} elapsed` + (eta > 0 ? ` • ~${formatTime(eta)} remaining` : '');

        const active = Array.from(hostStats.entries())
          .map(([, s]) => ({ host: s.host, stale: (now - s.lastSeen) > HOST_STALE_MS, sectors: s.sectors }))
          .filter(h => !h.stale)
          .sort((a, b) => b.sectors - a.sectors);
        const hostLines = active.slice(0, 10).map(h => {
          const cc = h.host.countryCode;
          const flag = cc && cc.length === 2 ? countryFlag(cc) + ' ' : '';
          return `  ${flag}${fmtHostAddr(h.host)} — ${h.sectors} sectors`;
        }).join('\n');
        status.textContent = hostLines ? `${line1}\n${line2}\n${hostLines}` : `${line1}\n${line2}`;
        progress.value = bytesDownloaded;
        progress.max = size;
      }, 200);

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
            bytesDownloaded += e.data.length;
            if (writable) {
              const bytes = new Uint8Array(e.data.data);
              // Serialize writes so we don't corrupt the file on disk.
              writeQueue = writeQueue.then(() => writable.write(bytes))
                .catch((err) => { reject(err); throw err; });
            } else {
              memBuf.push(new Uint8Array(e.data.data));
            }
          }
          if (e.data.type === 'host-active') {
            const host = e.data.host;
            const key = host.publicKey;
            const t = performance.now();
            if (!hostStats.has(key)) hostStats.set(key, { host, firstSeen: t, lastSeen: t, sectors: 1 });
            else { const hs = hostStats.get(key); hs.sectors++; hs.lastSeen = t; }
          }
          if (e.data.type === 'done') {
            worker.terminate();
            worker = null;
            writeQueue.then(resolve, reject);
          }
          if (e.data.type === 'error') {
            worker.terminate();
            worker = null;
            reject(new Error(e.data.message));
          }
        };
        worker.postMessage({ type: 'download', input, maxDownloads: getMaxDownloads() });
      });

      clearInterval(progressInterval);
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
      progress.value = progress.max;

      if (writable) {
        await writable.close();
      } else {
        const blob = new Blob(memBuf);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      status.innerHTML = `File: ${_esc(filename)}\nSize: ${formatSize(bytesDownloaded)}\nDownloaded in ${elapsed}s\n<span class="pass">Saved to disk!</span>`;
    } catch (e) {
      if (progressInterval) clearInterval(progressInterval);
      if (writable) { try { await writable.abort(); } catch (_) {} }
      if (worker) { try { worker.terminate(); } catch (_) {} }
      if (abortCtrl.signal.aborted) {
        status.innerHTML = '<span class="fail">Download cancelled</span>';
      } else {
        status.innerHTML = `<span class="fail">Error: ${_esc(e.message || String(e))}</span>`;
      }
    } finally {
      untrack();
      _downloadInProgress = false;
      btn.disabled = false;
    }
  });
}
