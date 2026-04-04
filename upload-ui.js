import { UploadOptions } from './pkg/indexd_wasm.js';
import { _esc, formatSize } from './utils.js';
import { connectSdk, getMaxUploads } from './config.js';
import { parallelUpload, parallelEncodeUpload } from './upload.js';

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

  // -- Upload Text (web workers) --
  document.getElementById('btn-upload-text-workers').addEventListener('click', async () => {
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
      const data = new TextEncoder().encode(text);
      const file = new File([data], 'text');

      status.innerHTML = `Uploading text (${formatSize(data.length)})...\n`;

      const result = await parallelUpload(file, status, progress);
      if (!result) return;

      const { obj, elapsed, size } = result;
      const objectId = obj.id();

      progress.value = progress.max;
      status.innerHTML = `Upload complete (${formatSize(size)}) in ${elapsed}s. Pinning to indexer...`;

      const sdk = await connectSdk(status);
      await sdk.pinObject(obj);

      status.innerHTML = `Upload + pin completed (${formatSize(size)}) in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
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

  document.getElementById('btn-upload-file').addEventListener('click', async () => {
    const status = document.getElementById('uf-status');
    const progress = document.getElementById('uf-progress');

    if (!selectedFile) {
      status.innerHTML = '<span class="fail">Select a file first</span>';
      return;
    }

    progress.style.display = 'none';
    progress.value = 0;

    try {
      status.innerHTML = `Uploading ${_esc(selectedFile.name)} (${formatSize(selectedFile.size)})...\n`;

      const result = await parallelUpload(selectedFile, status, progress);
      if (!result) return;

      const { obj, elapsed, size } = result;
      const objectId = obj.id();

      progress.value = progress.max;
      status.innerHTML = `Upload complete (${formatSize(size)}) in ${elapsed}s. Pinning to indexer...`;

      const sdk = await connectSdk(status);
      await sdk.pinObject(obj);

      status.innerHTML = `File: ${_esc(selectedFile.name)}\nSize: ${formatSize(size)}\nUpload + pin completed in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
    }
  });

  // -- Encode-worker File Upload (compute in workers, upload from main thread) --
  document.getElementById('btn-upload-file-encode').addEventListener('click', async () => {
    const status = document.getElementById('uf-status');
    const progress = document.getElementById('uf-progress');

    if (!selectedFile) {
      status.innerHTML = '<span class="fail">Select a file first</span>';
      return;
    }

    progress.style.display = 'none';
    progress.value = 0;

    try {
      status.innerHTML = `Uploading ${_esc(selectedFile.name)} (${formatSize(selectedFile.size)}) via encode workers...\n`;

      const result = await parallelEncodeUpload(selectedFile, status, progress);
      if (!result) return;

      const { obj, elapsed, size } = result;
      const objectId = obj.id();

      progress.value = progress.max;
      status.innerHTML = `Upload complete (${formatSize(size)}) in ${elapsed}s. Pinning to indexer...`;

      const sdk = await connectSdk(status);
      await sdk.pinObject(obj);

      status.innerHTML = `File: ${_esc(selectedFile.name)}\nSize: ${formatSize(size)}\nUpload + pin completed in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message || e)}</span>`;
    }
  });

  // -- Simple File Upload (no workers, single-threaded streaming upload) --
  document.getElementById('btn-upload-file-simple').addEventListener('click', async () => {
    const status = document.getElementById('uf-status');
    const progress = document.getElementById('uf-progress');

    if (!selectedFile) {
      status.innerHTML = '<span class="fail">Select a file first</span>';
      return;
    }

    progress.style.display = 'none';
    progress.value = 0;

    try {
      status.innerHTML = `Uploading ${_esc(selectedFile.name)} (${formatSize(selectedFile.size)})...`;
      const sdk = await connectSdk(status);
      if (!sdk) return;

      progress.style.display = 'block';

      const uploadStart = performance.now();
      const CHUNK_SIZE = 128 * 1024 * 1024;
      const fileSize = selectedFile.size;
      const ulOpts2 = new UploadOptions();
      ulOpts2.maxInflight = getMaxUploads();
      const upload = sdk.streamingUpload(fileSize, ulOpts2, (current, total) => {
        progress.max = total;
        progress.value = current;
        status.innerHTML = `Uploading ${_esc(selectedFile.name)} (${formatSize(fileSize)})... ${current}/${total} shards`;
      });
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
      status.innerHTML = `Upload complete (${formatSize(size)}) in ${elapsed}s. Pinning to indexer...`;

      await sdk.pinObject(obj);

      status.innerHTML = `File: ${_esc(selectedFile.name)}\nSize: ${formatSize(size)}\nUpload + pin completed in ${elapsed}s\n<span class="pass">Pinned!</span>\n\nObject ID: ${_esc(objectId)}`;
    } catch (e) {
      status.innerHTML += `\n<span class="fail">Error: ${_esc(e.message)}</span>`;
    }
  });
}
