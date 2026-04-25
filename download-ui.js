import { _esc, formatSize } from './utils.js';
import { getUrl, getKeyHex, getMaxDownloads, getLogLevel } from './config.js';
import { getActiveTab, trackAbort, tabStatusProxy } from './tabs.js';
import { getActiveServiceWorker } from './download.js';

// -- Download File --
//
// All file downloads run off the main thread via `single-download-worker.js`.
// The worker hosts its own SDK instance, streams bytes from `sdk.download(obj)`,
// and postMessages chunks back with Transferables so no copies are made. The
// main thread only routes each chunk to the chosen destination (a
// FileSystemWritableStream from `showSaveFilePicker` when available, or an
// in-memory blob as a fallback) and updates the progress display.
//
// Transient status goes to the bottom-right status bar via `panelStatus()`;
// the successful-download card (`#dl-result`) is populated at the end. The
// in-panel `#dl-status` text block is gone — everything lives in the status
// bar until the result card replaces it.

// Bottom-right status bar proxy for the currently-active tab.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

export function initDownloadUI() {
  let _downloadInProgress = false;
  let _currentAbort = null;

  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  document.getElementById('dl-cancel').addEventListener('click', () => {
    if (_currentAbort) _currentAbort.abort();
  });

  document.getElementById('btn-download').addEventListener('click', async () => {
    if (_downloadInProgress) return;
    _downloadInProgress = true;
    const btn = document.getElementById('btn-download');
    const cancelBtn = document.getElementById('dl-cancel');
    btn.disabled = true;
    const progress = document.getElementById('dl-progress');
    const resultCard = document.getElementById('dl-result');
    const input = document.getElementById('dl-url').value.trim();
    const filename = document.getElementById('dl-filename').value.trim() || 'download';

    progress.style.display = 'none';
    progress.value = 0;
    resultCard.style.display = 'none';

    if (!input) {
      panelStatus().innerHTML = '<span class="fail">Enter an Object ID or Share URL</span>';
      _downloadInProgress = false;
      btn.disabled = false;
      return;
    }

    const url = getUrl();
    const keyHex = getKeyHex();
    if (!url || !keyHex) {
      panelStatus().innerHTML = '<span class="fail">Set Indexer URL and App Key in Settings first</span>';
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
        panelStatus().innerHTML = `<span class="fail">Couldn't open file: ${_esc(e.message || String(e))}</span>`;
        _downloadInProgress = false;
        btn.disabled = false;
        return;
      }
    }

    // Cancellation hooks: close-tab aborts via the tab's abort controller,
    // the Cancel button aborts via _currentAbort, and we use the same
    // signal to tear the worker down on demand.
    const abortCtrl = new AbortController();
    _currentAbort = abortCtrl;
    const untrack = trackAbort(getActiveTab(), abortCtrl);
    cancelBtn.style.display = '';

    // Three sinks for downloaded bytes, in priority order:
    //   1. `writable`     — FSA writable stream (Chrome/Edge with showSaveFilePicker)
    //   2. `swMode`       — service-worker-streamed download (Firefox / no FSA)
    //   3. `memBuf`       — last-ditch in-memory blob (very old browsers)
    // The SW path is what keeps Firefox from OOMing on multi-GB files: chunks
    // go straight from the worker to the SW with transferable buffers, and
    // the browser's download manager streams to disk.
    let swMode = null;
    if (!writable) {
      const sw = await getActiveServiceWorker();
      if (sw) {
        const uuid = crypto.randomUUID();
        const onSWMsg = (e) => {
          if (e.data?.type === 'download-cancelled' && e.data.uuid === uuid) {
            abortCtrl.abort();
          }
        };
        navigator.serviceWorker.addEventListener('message', onSWMsg);
        swMode = {
          uuid,
          sw,
          iframe: null,
          started: false,
          cleanup: () => {
            navigator.serviceWorker.removeEventListener('message', onSWMsg);
            if (swMode.iframe) { try { swMode.iframe.remove(); } catch (_) {} }
          },
        };
      }
    }
    const memBuf = (writable || swMode) ? null : [];
    let bytesDownloaded = 0;
    let size = 0;
    let downloadStart = performance.now();
    const speedSamples = [];
    let progressInterval = null;
    let worker = null;
    let writeQueue = Promise.resolve();

    try {
      panelStatus().textContent = 'Starting download worker…';
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
      // Condensed to a single status-bar line — the earlier multi-line
      // block lived in `#dl-status` which no longer exists.
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
        const etaFrag = eta > 0 ? ` · ~${formatTime(eta)} remaining` : '';
        panelStatus().textContent =
          `Downloading ${pct}% (${formatSize(bytesDownloaded)} / ${formatSize(size)}) · ` +
          `${(speed / 1e6).toFixed(2)} MB/s${etaFrag}`;
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
            panelStatus().textContent = `Object found: ${formatSize(size)}. Downloading…`;
            if (swMode && !swMode.started) {
              // Hand off to the service worker now that we know the file
              // size — the iframe-triggered fetch turns into the user's
              // actual browser download.
              swMode.sw.postMessage({ type: 'start-download', uuid: swMode.uuid, filename, size });
              swMode.started = true;
              setTimeout(() => {
                if (abortCtrl.signal.aborted) return;
                const iframe = document.createElement('iframe');
                iframe.hidden = true;
                iframe.src = `/_download/${swMode.uuid}`;
                document.body.appendChild(iframe);
                swMode.iframe = iframe;
              }, 50);
            }
          }
          if (e.data.type === 'chunk') {
            bytesDownloaded += e.data.length;
            if (writable) {
              const bytes = new Uint8Array(e.data.data);
              // Serialize writes so we don't corrupt the file on disk.
              writeQueue = writeQueue.then(() => writable.write(bytes))
                .catch((err) => { reject(err); throw err; });
            } else if (swMode) {
              // Forward the ArrayBuffer to the SW with a zero-copy transfer.
              const buf = e.data.data;
              swMode.sw.postMessage({ type: 'download-chunk', uuid: swMode.uuid, data: buf }, [buf]);
            } else {
              memBuf.push(new Uint8Array(e.data.data));
            }
          }
          if (e.data.type === 'done') {
            worker.terminate();
            worker = null;
            if (swMode) {
              swMode.sw.postMessage({ type: 'download-end', uuid: swMode.uuid });
            }
            writeQueue.then(resolve, reject);
          }
          if (e.data.type === 'error') {
            worker.terminate();
            worker = null;
            if (swMode) {
              swMode.sw.postMessage({ type: 'download-error', uuid: swMode.uuid, error: e.data.message });
            }
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
      } else if (swMode) {
        // The SW already streamed the file to the browser's download
        // manager — nothing left to assemble here.
      } else {
        const blob = new Blob(memBuf);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      // Populate the success card; status bar gets a short confirmation.
      document.getElementById('dl-result-name').textContent = filename;
      document.getElementById('dl-result-size').textContent = formatSize(bytesDownloaded);
      document.getElementById('dl-result-elapsed').textContent = `${elapsed}s`;
      resultCard.style.display = '';
      panelStatus().innerHTML =
        `<span class="pass">✓ Saved ${_esc(filename)} (${formatSize(bytesDownloaded)}) in ${elapsed}s</span>`;
    } catch (e) {
      if (progressInterval) clearInterval(progressInterval);
      if (writable) { try { await writable.abort(); } catch (_) {} }
      if (worker) { try { worker.terminate(); } catch (_) {} }
      if (swMode && swMode.started) {
        try {
          swMode.sw.postMessage({
            type: 'download-error',
            uuid: swMode.uuid,
            error: abortCtrl.signal.aborted ? 'cancelled' : (e.message || String(e)),
          });
        } catch (_) {}
      }
      if (abortCtrl.signal.aborted) {
        panelStatus().innerHTML = '<span class="fail">Download cancelled</span>';
      } else {
        panelStatus().innerHTML = `<span class="fail">Error: ${_esc(e.message || String(e))}</span>`;
      }
    } finally {
      if (swMode) swMode.cleanup();
      untrack();
      _currentAbort = null;
      _downloadInProgress = false;
      btn.disabled = false;
      cancelBtn.style.display = 'none';
    }
  });
}
