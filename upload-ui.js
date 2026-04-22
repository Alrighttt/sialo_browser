import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { _esc, formatSize } from './utils.js';
import { connectSdk, getMaxUploads } from './config.js';
import { withKeepAlive } from './keep-alive.js';
import { getActiveTab, trackAbort } from './tabs.js';

// Produces a promise that rejects when the signal fires. Used via
// Promise.race so the UI can unblock even though the SDK's upload has no
// way to actually interrupt mid-flight — the bytes continue uploading in
// the background until the SDK finishes, but we move on logically.
function abortSignalAsReject(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  });
}

export function initUploadUI() {
  // -- Upload Text --
  document.getElementById('btn-upload').addEventListener('click', async () => {
    const status = document.getElementById('ul-status');
    const progress = document.getElementById('ul-progress');
    const text = document.getElementById('ul-text').value;

    if (!text) {
      status.innerHTML = '<span class="fail">Enter some text to upload</span>';
      return;
    }

    progress.style.display = 'none';
    progress.value = 0;

    const abortCtrl = new AbortController();
    const untrack = trackAbort(getActiveTab(), abortCtrl);

    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;

      const data = new TextEncoder().encode(text);
      progress.style.display = 'block';
      status.textContent = 'Uploading...';

      const uploadStart = performance.now();
      const src = new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(data);
          controller.close();
        }
      });
      const obj = await Promise.race([
        sdk.upload(new PinnedObject(), src, { maxInflight: getMaxUploads() }),
        abortSignalAsReject(abortCtrl.signal),
      ]);
      const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
      const objectId = obj.id();
      const size = obj.size();

      status.innerHTML = `Upload complete (${size} bytes) in ${elapsed}s. Pinning to indexer...`;

      await sdk.pinObject(obj);

      status.innerHTML += `\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      if (abortCtrl.signal.aborted) status.innerHTML = '<span class="fail">Upload cancelled</span>';
      else status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message || String(e))}</span>`;
    } finally {
      untrack();
    }
  });

  // -- Upload File --
  let selectedFile = null;
  const dropzone = document.getElementById('uf-dropzone');
  const fileInput = document.getElementById('uf-file');
  const fileInfo = document.getElementById('uf-file-info');

  function setFile(file) {
    selectedFile = file;
    fileInfo.textContent = `${file.name} (${formatSize(file.size)})`;
    const card = document.getElementById('uf-info-card');
    card.style.display = '';
    document.getElementById('uf-card-filename').textContent = file.name;
    document.getElementById('uf-card-size').textContent = `(${formatSize(file.size)})`;
    document.getElementById('uf-card-speed').textContent = 'Ready';
    document.getElementById('uf-card-detail').textContent = '';
    document.getElementById('uf-card-elapsed').textContent = '0s';
    document.getElementById('uf-card-eta').textContent = '--';
    document.getElementById('uf-card-shards-done').textContent = '';
    document.getElementById('uf-card-hosts-active').textContent = '';
    document.getElementById('uf-progress').value = 0;
    startUpload();
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) setFile(fileInput.files[0]);
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });

  // -- File Upload (triggered by setFile as soon as a file is chosen/dropped) --
  const cancelBtn = document.getElementById('uf-cancel');
  let currentUploadAbort = null;
  cancelBtn.addEventListener('click', () => {
    if (currentUploadAbort) currentUploadAbort.abort();
  });

  async function startUpload() {
    const status = document.getElementById('uf-status');
    const progress = document.getElementById('uf-progress');
    const cardSpeed = document.getElementById('uf-card-speed');
    const cardDetail = document.getElementById('uf-card-detail');
    const cardElapsed = document.getElementById('uf-card-elapsed');
    const cardEta = document.getElementById('uf-card-eta');
    const cardShardsDone = document.getElementById('uf-card-shards-done');

    if (!selectedFile) {
      status.innerHTML = '<span class="fail">Select a file first</span>';
      return;
    }

    progress.value = 0;
    status.innerHTML = '';

    // Abort wiring: the Cancel button aborts via currentUploadAbort, and
    // closeTab() in tabs.js triggers every registered abort controller.
    // Cancelling pipes through an AbortSignal on pipeTo → TransformStream,
    // which errors the readable the SDK is consuming, so sdk.upload rejects.
    const abortCtrl = new AbortController();
    currentUploadAbort = abortCtrl;
    const tab = getActiveTab();
    const untrack = trackAbort(tab, abortCtrl);
    cancelBtn.style.display = '';

    await withKeepAlive(async () => {

    function formatTime(s) {
      if (s < 60) return `${Math.round(s)}s`;
      const m = Math.floor(s / 60);
      return `${m}m ${Math.round(s % 60)}s`;
    }

    try {
      status.textContent = 'Connecting...';
      const sdk = await connectSdk(status);
      if (!sdk) return;

      const uploadStart = performance.now();

      // Estimate total shards for progress bar: default 10 data + 20 parity
      // shards per slab, 4 MiB per shard. Matches sia_storage defaults.
      const SECTOR_SIZE = 4 * 1024 * 1024;
      const DATA_SHARDS = 10;
      const TOTAL_SHARDS = 30;
      const slabCount = Math.max(1, Math.ceil(selectedFile.size / (DATA_SHARDS * SECTOR_SIZE)));
      const expectedShards = slabCount * TOTAL_SHARDS;
      progress.max = expectedShards;
      progress.value = 0;

      let shardsDone = 0;
      let bytesUploaded = 0;

      function refreshDisplay() {
        const elapsedSec = (performance.now() - uploadStart) / 1000;
        cardElapsed.textContent = formatTime(elapsedSec);
        const speedMBs = elapsedSec > 0 ? (bytesUploaded / elapsedSec / 1e6) : 0;
        cardSpeed.textContent = `${speedMBs.toFixed(1)} MB/s`;
        cardShardsDone.textContent = `${shardsDone} / ${expectedShards} shards`;
        if (shardsDone > 0 && shardsDone < expectedShards) {
          const remainingShards = expectedShards - shardsDone;
          const etaSec = remainingShards * (elapsedSec / shardsDone);
          cardEta.textContent = formatTime(etaSec);
        } else if (shardsDone >= expectedShards) {
          cardEta.textContent = '0s';
        }
        cardDetail.textContent = `${formatSize(bytesUploaded)} uploaded`;
      }

      const refreshTimer = setInterval(refreshDisplay, 500);

      status.textContent = 'Uploading...';
      try {
        const obj = await Promise.race([
          sdk.upload(new PinnedObject(), selectedFile.stream(), {
            maxInflight: getMaxUploads(),
            onShardUploaded: (p) => {
              shardsDone++;
              bytesUploaded += p.shardSize || 0;
              progress.value = shardsDone;
            },
          }),
          abortSignalAsReject(abortCtrl.signal),
        ]);

        clearInterval(refreshTimer);
        refreshDisplay();

        const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
        const objectId = obj.id();
        const size = obj.size();

        cardSpeed.textContent = `${(size / parseFloat(elapsed) / 1e6).toFixed(1)} MB/s avg`;
        cardEta.textContent = '0s';
        status.innerHTML = `Pinning to indexer...`;

        await sdk.pinObject(obj);

        status.innerHTML = `File: ${_esc(selectedFile.name)}\nSize: ${formatSize(size)}\nUpload + pin completed in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
      } finally {
        clearInterval(refreshTimer);
      }
    } catch (e) {
      if (abortCtrl.signal.aborted) {
        status.innerHTML = '<span class="fail">Upload cancelled</span>';
      } else {
        status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message || String(e))}</span>`;
      }
    } finally {
      cancelBtn.style.display = 'none';
      untrack();
      if (currentUploadAbort === abortCtrl) currentUploadAbort = null;
    }
    }); // withKeepAlive
  }
}
