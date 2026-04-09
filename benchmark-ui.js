import { UploadOptions } from './pkg/sia_storage_wasm.js';
import { connectSdk, getUrl, getKeyHex, getMaxUploads, getMaxDownloads, getLogLevel } from './config.js';
import { parallelUpload, parallelEncodeUpload } from './upload.js';
import { parallelDownload } from './download.js';
import { formatSize } from './utils.js';

export function initBenchmarkUI() {
  // -- Upload Benchmark --
  (() => {
    let benchStopped = false;
    const statusEl = () => document.getElementById('bench-status');
    const progressEl = () => document.getElementById('bench-progress');
    const resultsEl = () => document.getElementById('bench-results');
    const tbodyEl = () => document.getElementById('bench-tbody');

    function generateDummyData(sizeMB) {
      const size = sizeMB * 1024 * 1024;
      const data = new Uint8Array(size);
      // Fill with pseudo-random data (compressible data would skew results)
      for (let i = 0; i < size; i += 4) {
        const v = (i * 2654435761) >>> 0; // simple hash
        data[i] = v & 0xff;
        if (i + 1 < size) data[i + 1] = (v >> 8) & 0xff;
        if (i + 2 < size) data[i + 2] = (v >> 16) & 0xff;
        if (i + 3 < size) data[i + 3] = (v >> 24) & 0xff;
      }
      return new File([data], `bench_${sizeMB}mb.dat`, { type: 'application/octet-stream' });
    }

    function benchResultToRow(r) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #1a1a1a;';
      tr.innerHTML = `
        <td style="padding:0.5rem 0.75rem;">${r.sizeMB} MB</td>
        <td style="padding:0.5rem 0.5rem;">${r.method}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.inflight}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.workers || '\u2014'}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.elapsed.toFixed(1)}s</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${(r.speed / 1e6).toFixed(2)} MB/s</td>
        <td style="padding:0.5rem 0.75rem; text-align:right;">${(r.wireSpeed / 1e6).toFixed(2)} MB/s</td>
      `;
      return tr;
    }

    function saveBenchResults(results) {
      localStorage.setItem('bench-results', JSON.stringify(results));
    }

    function loadBenchResults() {
      try {
        return JSON.parse(localStorage.getItem('bench-results') || '[]');
      } catch { return []; }
    }

    function renderBenchResults(results) {
      tbodyEl().innerHTML = '';
      resultsEl().style.display = results.length ? '' : 'none';
      for (const r of [...results].reverse()) tbodyEl().appendChild(benchResultToRow(r));
    }

    function addResult(sizeMB, method, inflight, workers, elapsed, fileSizeBytes) {
      const speed = fileSizeBytes / elapsed;
      const SECTOR_SIZE = 4 * 1024 * 1024;
      const dataShards = 10;
      const totalShards = 30;
      const slabCount = Math.ceil(fileSizeBytes / (dataShards * SECTOR_SIZE));
      const wireBytes = slabCount * totalShards * SECTOR_SIZE;
      const wireSpeed = wireBytes / elapsed;
      const r = { sizeMB, method, inflight, workers, elapsed, speed, wireSpeed, timestamp: Date.now() };
      const results = loadBenchResults();
      results.push(r);
      saveBenchResults(results);
      tbodyEl().prepend(benchResultToRow(r));
      resultsEl().style.display = '';
    }

    // Restore saved results on page load
    { const saved = loadBenchResults(); if (saved.length) renderBenchResults(saved); }

    document.getElementById('btn-bench-run').addEventListener('click', async () => {
      benchStopped = false;
      document.getElementById('btn-bench-run').disabled = true;
      document.getElementById('btn-bench-stop').style.display = '';

      const sizes = [];
      if (document.getElementById('bench-size-10').checked) sizes.push(10);
      if (document.getElementById('bench-size-50').checked) sizes.push(50);
      if (document.getElementById('bench-size-100').checked) sizes.push(100);
      if (document.getElementById('bench-size-500').checked) sizes.push(500);

      const methods = [];
      if (document.getElementById('bench-method-single').checked) methods.push('single');
      if (document.getElementById('bench-method-workers').checked) methods.push('workers');
      if (document.getElementById('bench-method-encode').checked) methods.push('encode');

      const inflights = [];
      if (document.getElementById('bench-inflight-4').checked) inflights.push(4);
      if (document.getElementById('bench-inflight-8').checked) inflights.push(8);
      if (document.getElementById('bench-inflight-16').checked) inflights.push(16);
      if (document.getElementById('bench-inflight-24').checked) inflights.push(24);

      const workerCounts = [];
      if (document.getElementById('bench-workers-4').checked) workerCounts.push(4);
      if (document.getElementById('bench-workers-8').checked) workerCounts.push(8);
      if (document.getElementById('bench-workers-16').checked) workerCounts.push(16);
      if (document.getElementById('bench-workers-24').checked) workerCounts.push(24);

      if (sizes.length === 0 || methods.length === 0 || inflights.length === 0) {
        statusEl().textContent = 'Select at least one size, method, and inflight setting.';
        document.getElementById('btn-bench-run').disabled = false;
        document.getElementById('btn-bench-stop').style.display = 'none';
        return;
      }

      // Build test matrix
      const tests = [];
      for (const size of sizes) {
        for (const method of methods) {
          for (const inflight of inflights) {
            if (method === 'single') {
              // Single-threaded doesn't use workers
              tests.push({ size, method, inflight, workers: null });
            } else {
              // Web workers and encode workers vary worker count
              const wCounts = workerCounts.length > 0 ? workerCounts : [8];
              for (const workers of wCounts) {
                tests.push({ size, method, inflight, workers });
              }
            }
          }
        }
      }

      resultsEl().style.display = '';
      progressEl().style.display = 'block';
      progressEl().max = tests.length;
      progressEl().value = 0;

      for (let i = 0; i < tests.length; i++) {
        if (benchStopped) break;
        const { size, method, inflight, workers } = tests[i];
        const methodLabel = method === 'single' ? 'Single-threaded' : method === 'workers' ? 'Web Workers' : 'Encode Workers';
        const workerLabel = workers ? ` \u2022 workers=${workers}` : '';
        statusEl().textContent = `[${i + 1}/${tests.length}] ${size} MB \u2022 ${methodLabel} \u2022 inflight=${inflight}${workerLabel}`;
        statusEl().style.color = '#60a5fa';

        try {
          // Generate dummy file
          const file = generateDummyData(size);
          const dummyStatus = document.createElement('div');
          const dummyProgress = document.createElement('div');
          dummyProgress.style = { display: 'none' };

          // Override max uploads for this test
          const origMaxUploads = document.getElementById('cfg-max-uploads').value;
          const origUploadWorkers = document.getElementById('cfg-upload-workers').value;
          document.getElementById('cfg-max-uploads').value = inflight;

          const start = performance.now();
          let result;

          if (method === 'single') {
            // Single-threaded upload via main thread SDK
            const sdk = await connectSdk(statusEl());
            if (!sdk) continue;
            const upload = sdk.upload(new UploadOptions(null, null, inflight));
            const CHUNK_SIZE = 128 * 1024 * 1024;
            const data = new Uint8Array(await file.arrayBuffer());
            for (let off = 0; off < data.length; off += CHUNK_SIZE) {
              await upload.pushChunk(data.subarray(off, off + CHUNK_SIZE));
            }
            const obj = await upload.finish();
            result = { obj, size: file.size };
          } else if (method === 'workers') {
            document.getElementById('cfg-upload-workers').value = workers;
            result = await parallelUpload(file, dummyStatus, dummyProgress);
          } else if (method === 'encode') {
            document.getElementById('cfg-upload-workers').value = workers;
            result = await parallelEncodeUpload(file, dummyStatus, dummyProgress);
          }

          const elapsed = (performance.now() - start) / 1000;

          // Restore settings
          document.getElementById('cfg-max-uploads').value = origMaxUploads;
          document.getElementById('cfg-upload-workers').value = origUploadWorkers;

          if (result) {
            addResult(size, methodLabel, inflight, workers, elapsed, file.size);
          }
        } catch (e) {
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-bottom:1px solid #1a1a1a; color:#f87171;';
          tr.innerHTML = `
            <td style="padding:0.5rem 0.75rem;">${size} MB</td>
            <td style="padding:0.5rem 0.5rem;">${method}</td>
            <td style="padding:0.5rem 0.5rem; text-align:right;">${inflight}</td>
            <td colspan="3" style="padding:0.5rem 0.5rem;">Error: ${e.message || e}</td>
          `;
          tbodyEl().appendChild(tr);
        }

        progressEl().value = i + 1;
      }

      statusEl().textContent = benchStopped ? 'Benchmark stopped.' : 'Benchmark complete.';
      statusEl().style.color = benchStopped ? '#f59e0b' : '#4ade80';
      progressEl().style.display = 'none';
      document.getElementById('btn-bench-run').disabled = false;
      document.getElementById('btn-bench-stop').style.display = 'none';
    });

    document.getElementById('btn-bench-stop').addEventListener('click', () => {
      benchStopped = true;
      statusEl().textContent = 'Stopping after current test...';
      statusEl().style.color = '#f59e0b';
    });

    document.getElementById('btn-bench-clear').addEventListener('click', () => {
      localStorage.removeItem('bench-results');
      tbodyEl().innerHTML = '';
      resultsEl().style.display = 'none';
      statusEl().textContent = 'Results cleared.';
      statusEl().style.color = '#888';
    });
  })();

  // -- Download Benchmark --
  (() => {
    const statusEl = () => document.getElementById('dl-bench-status');
    const tbodyEl = () => document.getElementById('dl-bench-tbody');
    const resultsEl = () => document.getElementById('dl-bench-results');
    const progressEl = () => document.getElementById('dl-bench-progress');
    let dlBenchStopped = false;

    function dlBenchResultToRow(r) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid #1a1a1a;';
      tr.innerHTML = `
        <td style="padding:0.5rem 0.5rem;">${r.method}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.inflight}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.workers || '\u2014'}</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${(r.sizeBytes / 1e6).toFixed(1)} MB</td>
        <td style="padding:0.5rem 0.5rem; text-align:right;">${r.elapsed.toFixed(1)}s</td>
        <td style="padding:0.5rem 0.75rem; text-align:right;">${(r.speed / 1e6).toFixed(2)} MB/s</td>
      `;
      return tr;
    }

    function saveDlBenchResults(results) {
      localStorage.setItem('dl-bench-results', JSON.stringify(results));
    }

    function loadDlBenchResults() {
      try { return JSON.parse(localStorage.getItem('dl-bench-results') || '[]'); }
      catch { return []; }
    }

    function renderDlBenchResults(results) {
      tbodyEl().innerHTML = '';
      resultsEl().style.display = results.length ? '' : 'none';
      for (const r of [...results].reverse()) tbodyEl().appendChild(dlBenchResultToRow(r));
    }

    function addDlResult(method, inflight, workers, sizeBytes, elapsed) {
      const speed = sizeBytes / elapsed;
      const r = { method, inflight, workers, sizeBytes, elapsed, speed, timestamp: Date.now() };
      const results = loadDlBenchResults();
      results.push(r);
      saveDlBenchResults(results);
      tbodyEl().prepend(dlBenchResultToRow(r));
      resultsEl().style.display = '';
    }

    // Restore saved results on load
    { const saved = loadDlBenchResults(); if (saved.length) renderDlBenchResults(saved); }

    document.getElementById('btn-dl-bench-run').addEventListener('click', async () => {
      dlBenchStopped = false;
      document.getElementById('btn-dl-bench-run').disabled = true;
      document.getElementById('btn-dl-bench-stop').style.display = '';

      const urlInput = document.getElementById('dl-bench-url').value.trim();
      if (!urlInput) {
        statusEl().textContent = 'Enter an object ID or share URL.';
        statusEl().style.color = '#f87171';
        document.getElementById('btn-dl-bench-run').disabled = false;
        document.getElementById('btn-dl-bench-stop').style.display = 'none';
        return;
      }

      const methods = [];
      if (document.getElementById('dl-bench-method-workers').checked) methods.push('workers');
      if (document.getElementById('dl-bench-method-single').checked) methods.push('single');

      const inflights = [];
      if (document.getElementById('dl-bench-inflight-4').checked) inflights.push(4);
      if (document.getElementById('dl-bench-inflight-8').checked) inflights.push(8);
      if (document.getElementById('dl-bench-inflight-16').checked) inflights.push(16);
      if (document.getElementById('dl-bench-inflight-24').checked) inflights.push(24);

      const workerCounts = [];
      if (document.getElementById('dl-bench-workers-4').checked) workerCounts.push(4);
      if (document.getElementById('dl-bench-workers-8').checked) workerCounts.push(8);
      if (document.getElementById('dl-bench-workers-16').checked) workerCounts.push(16);
      if (document.getElementById('dl-bench-workers-24').checked) workerCounts.push(24);

      if (methods.length === 0 || inflights.length === 0) {
        statusEl().textContent = 'Select at least one method and inflight setting.';
        statusEl().style.color = '#f87171';
        document.getElementById('btn-dl-bench-run').disabled = false;
        document.getElementById('btn-dl-bench-stop').style.display = 'none';
        return;
      }

      // Determine if input is a share URL or object ID
      const isShareUrl = urlInput.startsWith('sia://') || urlInput.startsWith('https://');

      // Build test matrix
      const tests = [];
      for (const method of methods) {
        for (const inflight of inflights) {
          if (method === 'single') {
            tests.push({ method, inflight, workers: null });
          } else {
            const wCounts = workerCounts.length > 0 ? workerCounts : [8];
            for (const workers of wCounts) {
              tests.push({ method, inflight, workers });
            }
          }
        }
      }

      progressEl().style.display = 'block';
      progressEl().max = tests.length;
      progressEl().value = 0;

      for (let i = 0; i < tests.length; i++) {
        if (dlBenchStopped) break;
        const { method, inflight, workers } = tests[i];
        const methodLabel = method === 'workers' ? 'Web Workers' : 'Single Worker';
        const workerLabel = workers ? ` \u2022 workers=${workers}` : '';
        statusEl().textContent = `[${i + 1}/${tests.length}] ${methodLabel} \u2022 inflight=${inflight}${workerLabel}`;
        statusEl().style.color = '#60a5fa';

        try {
          const origMaxDownloads = document.getElementById('cfg-max-downloads').value;
          const origDownloadWorkers = document.getElementById('cfg-download-workers').value;
          document.getElementById('cfg-max-downloads').value = inflight;

          const start = performance.now();
          let totalBytes = 0;

          if (method === 'single') {
            // Single worker download via dedicated worker
            document.getElementById('cfg-max-downloads').value = inflight;
            const url = getUrl();
            const keyHex = getKeyHex();
            if (!url || !keyHex) { statusEl().textContent = 'Set Indexer URL and App Key first'; continue; }

            totalBytes = await new Promise((resolve, reject) => {
              const worker = new Worker('./single-download-worker.js', { type: 'module' });
              let bytes = 0;
              const readyP = new Promise((res, rej) => {
                const h = (e) => {
                  if (e.data.type === 'ready') { worker.removeEventListener('message', h); res(); }
                  if (e.data.type === 'error') { worker.removeEventListener('message', h); rej(new Error(e.data.message)); }
                };
                worker.addEventListener('message', h);
              });
              worker.postMessage({ type: 'init', indexerUrl: url, keyHex, maxDownloads: inflight, logLevel: getLogLevel() });
              readyP.then(() => {
                worker.postMessage({ type: 'download', input: urlInput, maxDownloads: inflight });
                worker.onmessage = (e) => {
                  if (e.data.type === 'chunk') bytes += e.data.length;
                  if (e.data.type === 'done') { worker.terminate(); resolve(bytes); }
                  if (e.data.type === 'error') { worker.terminate(); reject(new Error(e.data.message)); }
                };
              }).catch(reject);
            });
          } else if (method === 'workers') {
            document.getElementById('cfg-download-workers').value = workers;
            const dummyStatus = { set textContent(_) { }, set innerHTML(_) { } };
            const dummyProgress = document.createElement('progress');
            dummyProgress.style.display = 'none';
            const result = await parallelDownload(urlInput, dummyStatus, dummyProgress, null, workers);
            if (result && result.blob) totalBytes = result.blob.size;
            else if (result && result.size) totalBytes = result.size;
          }

          const elapsed = (performance.now() - start) / 1000;

          document.getElementById('cfg-max-downloads').value = origMaxDownloads;
          document.getElementById('cfg-download-workers').value = origDownloadWorkers;

          addDlResult(methodLabel, inflight, workers, totalBytes, elapsed);
        } catch (e) {
          console.error('Download benchmark error:', e);
          addDlResult(methodLabel + ' (ERROR)', inflight, workers, 0, 0);
        }

        progressEl().value = i + 1;
      }

      statusEl().textContent = dlBenchStopped ? 'Benchmark stopped.' : 'Download benchmark complete.';
      statusEl().style.color = dlBenchStopped ? '#f59e0b' : '#4ade80';
      progressEl().style.display = 'none';
      document.getElementById('btn-dl-bench-run').disabled = false;
      document.getElementById('btn-dl-bench-stop').style.display = 'none';
    });

    document.getElementById('btn-dl-bench-stop').addEventListener('click', () => {
      dlBenchStopped = true;
      statusEl().textContent = 'Stopping after current test...';
      statusEl().style.color = '#f59e0b';
    });

    document.getElementById('btn-dl-bench-clear').addEventListener('click', () => {
      localStorage.removeItem('dl-bench-results');
      tbodyEl().innerHTML = '';
      resultsEl().style.display = 'none';
      statusEl().textContent = 'Results cleared.';
      statusEl().style.color = '#888';
    });
  })();
}
