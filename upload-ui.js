import { UploadOptions } from './pkg/indexd_wasm.js';
import { _esc, formatSize } from './utils.js';
import { connectSdk, getMaxUploads } from './config.js';
import { withKeepAlive } from './keep-alive.js';

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

    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;

      const data = new TextEncoder().encode(text);
      progress.style.display = 'block';
      status.textContent = 'Uploading...';

      const uploadStart = performance.now();
      const CHUNK_SIZE = 128 * 1024 * 1024;
      const ulOpts = new UploadOptions();
      ulOpts.maxInflight = getMaxUploads();
      const upload = sdk.streamingUpload(data.length, ulOpts, (current, total) => {
        progress.max = total;
        progress.value = current;
        status.textContent = `Uploading... ${current}/${total} shards`;
      });
      (async () => {
        for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
          upload.pushChunk(data.subarray(offset, offset + CHUNK_SIZE));
        }
        upload.pushChunk(null);
      })();
      const obj = await upload.promise;
      const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
      const objectId = obj.id();
      const size = obj.size();

      progress.value = progress.max;
      status.innerHTML = `Upload complete (${size} bytes) in ${elapsed}s. Pinning to indexer...`;

      await sdk.pinObject(obj);

      status.innerHTML += `\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
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
    // Show info card with file details
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
    document.getElementById('uf-host-table').style.display = 'none';
    document.getElementById('uf-host-tbody').innerHTML = '';
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

  // -- File Upload (single-threaded streaming) --
  document.getElementById('btn-upload-file-simple').addEventListener('click', async () => {
    const status = document.getElementById('uf-status');
    const progress = document.getElementById('uf-progress');
    const cardSpeed = document.getElementById('uf-card-speed');
    const cardDetail = document.getElementById('uf-card-detail');
    const cardElapsed = document.getElementById('uf-card-elapsed');
    const cardEta = document.getElementById('uf-card-eta');
    const cardShardsDone = document.getElementById('uf-card-shards-done');
    const hostTable = document.getElementById('uf-host-table');
    const hostTbody = document.getElementById('uf-host-tbody');

    if (!selectedFile) {
      status.innerHTML = '<span class="fail">Select a file first</span>';
      return;
    }

    progress.value = 0;
    status.innerHTML = '';
    hostTable.style.display = 'none';

    await withKeepAlive(async () => {
    hostTbody.innerHTML = '';

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
      const CHUNK_SIZE = 128 * 1024 * 1024;
      const fileSize = selectedFile.size;
      const ulOpts = new UploadOptions();
      ulOpts.maxInflight = getMaxUploads();

      let shardsUploaded = 0;
      let totalShards = 0;

      const upload = sdk.streamingUpload(fileSize, ulOpts, (current, total) => {
        shardsUploaded = current;
        totalShards = total;
        progress.max = total;
        progress.value = current;

        const elapsed = (performance.now() - uploadStart) / 1000;
        const bytesPerShard = fileSize / total;
        const bytesUploaded = current * bytesPerShard;
        const speed = bytesUploaded / elapsed;
        const remaining = total - current;
        const eta = remaining > 0 && speed > 0 ? (remaining * bytesPerShard) / speed : 0;

        cardSpeed.textContent = `${(speed / 1e6).toFixed(1)} MB/s`;
        cardDetail.textContent = `${current}/${total} shards`;
        cardElapsed.textContent = formatTime(elapsed);
        cardEta.textContent = eta > 0 ? formatTime(eta) : '--';
        cardShardsDone.textContent = `${current} shards done`;
      });

      // Push file chunks in the background
      (async () => {
        for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
          const chunk = selectedFile.slice(offset, offset + CHUNK_SIZE);
          const data = new Uint8Array(await chunk.arrayBuffer());
          upload.pushChunk(data);
        }
        upload.pushChunk(null);
      })();

      const obj = await upload.promise;
      const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
      const objectId = obj.id();
      const size = obj.size();

      progress.value = progress.max;
      cardSpeed.textContent = `${(size / parseFloat(elapsed) / 1e6).toFixed(1)} MB/s avg`;
      cardEta.textContent = '0s';
      status.innerHTML = `Pinning to indexer...`;

      await sdk.pinObject(obj);

      status.innerHTML = `File: ${_esc(selectedFile.name)}\nSize: ${formatSize(size)}\nUpload + pin completed in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
    }
    }); // withKeepAlive
  });
}
