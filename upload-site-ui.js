// Upload Site page — turn a local folder into a Sia-hosted site.
//
// Uses the SDK's PackedUpload handle so every site file goes through a
// shared slab pipeline. For typical sites (lots of small HTML/CSS/JS +
// a few larger images) this is dramatically cheaper than one full
// 10/20-shard slab per file: ~40 MiB of site content packs into a
// single slab instead of 30+ per-file slabs.
//
// Flow:
//   1. User picks / drops a directory. File entries are collected with
//      webkitRelativePath preserved.
//   2. Clicking Upload:
//      - `sdk.uploadPacked()` returns a PackedUpload handle.
//      - We call `packed.add(file.stream())` once per file. Files are
//        bin-packed into shared slabs internally; finalize() returns
//        one PinnedObject per add() call, in insertion order.
//      - Each object is pinned and recorded in the manifest as
//        manifest[relPath] = object.id().
//      - The manifest JSON is uploaded (via a regular sdk.upload()
//        since its bytes depend on the preceding object IDs).
//   3. The result card exposes the manifest ID, an Open button that
//      navigates the active tab to sia-site://<id>, and a copy button.

import { _esc, formatSize } from './utils.js';
import { connectSdk } from './config.js';
import { withKeepAlive } from './keep-alive.js';
import { getActiveTab, trackAbort, tabStatusProxy } from './tabs.js';

// Bottom-right status bar proxy for the currently-active tab.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}
import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { buildSiaSiteManifest } from './sia-site.js';

const FILE_ROW_LIMIT = 500; // cap on rendered preview rows (avoid huge DOM)

export function initUploadSiteUI() {
  const dropzone  = document.getElementById('us-dropzone');
  const dirInput  = document.getElementById('us-dir');
  const card      = document.getElementById('us-info-card');
  const cardRoot  = document.getElementById('us-card-root');
  const cardSum   = document.getElementById('us-card-summary');
  const cardCur   = document.getElementById('us-card-current');
  const cardDone  = document.getElementById('us-card-files-done');
  const cardElap  = document.getElementById('us-card-elapsed');
  const progress  = document.getElementById('us-progress');
  const filesPane = document.getElementById('us-files-details');
  const filesList = document.getElementById('us-files-list');
  const cancelBtn = document.getElementById('us-cancel');
  const result    = document.getElementById('us-result');
  const resultId  = document.getElementById('us-result-id');
  const resultUrl = document.getElementById('us-result-url');
  const openBtn   = document.getElementById('us-open-btn');
  const copyBtn   = document.getElementById('us-copy-btn');
  const validityNum  = document.getElementById('us-validity-num');
  const validityUnit = document.getElementById('us-validity-unit');

  /** Currently-selected file list with relative paths. */
  let selected = null; // [{ relPath, file }]
  let rootLabel = '';
  let currentAbort = null;

  function summarise(files) {
    const total = files.reduce((s, f) => s + f.file.size, 0);
    return `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(total)}`;
  }

  function renderFileList(files) {
    filesList.innerHTML = '';
    const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const shown = sorted.slice(0, FILE_ROW_LIMIT);
    for (const f of shown) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; gap:1rem; padding:0.15rem 0;';
      row.innerHTML = `<span style="color:#ccc;">${_esc(f.relPath)}</span><span style="color:#555;">${formatSize(f.file.size)}</span>`;
      filesList.appendChild(row);
    }
    if (sorted.length > FILE_ROW_LIMIT) {
      const more = document.createElement('div');
      more.style.cssText = 'color:#555; padding:0.25rem 0; font-style:italic;';
      more.textContent = `… and ${sorted.length - FILE_ROW_LIMIT} more`;
      filesList.appendChild(more);
    }
  }

  /**
   * Turn a FileList into [{ relPath, file }], skipping dotfiles and
   * macOS metadata junk. Webkit-style directory uploads populate
   * file.webkitRelativePath like "root/sub/file.txt" — we strip the
   * leading root segment so the manifest keys are repo-relative.
   */
  function collectFiles(fileList) {
    const collected = [];
    let rootPrefix = null;
    for (const file of fileList) {
      const rel = file.webkitRelativePath || file.name;
      // Skip hidden files/folders anywhere in the path.
      if (rel.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX')) continue;
      // Identify the common root (first segment of the first file).
      if (rootPrefix == null) rootPrefix = rel.split('/')[0];
      const relPath = rel.startsWith(rootPrefix + '/') ? rel.slice(rootPrefix.length + 1) : rel;
      if (!relPath) continue;
      collected.push({ relPath, file });
    }
    return { files: collected, rootPrefix: rootPrefix || '' };
  }

  function setFiles(fileList) {
    // If a previous upload is still running, cancel it — the user has
    // picked a new directory and expects a clean slate.
    if (currentAbort) {
      try { currentAbort.abort(); } catch (_) {}
      currentAbort = null;
    }
    hideResult();
    panelStatus().innerHTML = '';
    // finalize() switches the bar to indeterminate via removeAttribute;
    // restore the value attribute so it's determinate again.
    progress.value = 0;
    cancelBtn.style.display = 'none';
    const { files, rootPrefix } = collectFiles(fileList);
    if (files.length === 0) {
      selected = null;
      card.style.display = 'none';
      filesPane.style.display = 'none';
      panelStatus().innerHTML = '<span class="fail">No uploadable files in that folder.</span>';
      return;
    }
    selected = files;
    rootLabel = rootPrefix || 'site';
    cardRoot.textContent = rootLabel;
    cardSum.textContent = summarise(files);
    cardCur.textContent = 'Starting…';
    cardDone.textContent = '0 / ' + files.length;
    cardElap.textContent = '0s';
    progress.max = files.length + 1; // +1 for the final manifest upload
    progress.value = 0;
    card.style.display = '';
    filesPane.style.display = '';
    renderFileList(files);
    // Upload begins immediately — matches the Upload File page's behavior
    // where selecting a file kicks off the upload without a confirm step.
    startUpload();
  }

  function hideResult() {
    result.style.display = 'none';
    resultId.textContent = '';
    resultUrl.textContent = '';
  }

  function formatElapsed(sec) {
    if (sec < 60) return Math.round(sec) + 's';
    const m = Math.floor(sec / 60);
    return m + 'm ' + Math.round(sec % 60) + 's';
  }

  // --- Event wiring ---

  dropzone.addEventListener('click', () => {
    // Reset so picking the same directory twice still fires `change`.
    dirInput.value = '';
    dirInput.click();
  });
  dirInput.addEventListener('change', () => {
    if (dirInput.files && dirInput.files.length) setFiles(dirInput.files);
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;
    // Recursively walk each dropped entry to collect File objects.
    const collected = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        await new Promise((resolve) => {
          entry.file((f) => {
            // Synthesise webkitRelativePath so the rest of the code is
            // consistent between drag-drop and file-picker inputs.
            Object.defineProperty(f, 'webkitRelativePath', { value: prefix + entry.name });
            collected.push(f);
            resolve();
          });
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const kids = await new Promise((resolve) => reader.readEntries(resolve));
        for (const k of kids) await walk(k, prefix + entry.name + '/');
      }
    }
    for (const it of items) {
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry) await walk(entry, '');
    }
    if (collected.length === 0) {
      panelStatus().innerHTML = '<span class="fail">Drop a folder, not individual files.</span>';
      return;
    }
    setFiles(collected);
  });

  cancelBtn.addEventListener('click', () => {
    if (currentAbort) currentAbort.abort();
  });

  openBtn.addEventListener('click', () => {
    const url = resultUrl.textContent.trim();
    if (!url) return;
    const bar = document.getElementById('chrome-address-bar');
    if (bar) bar.value = url;
    if (typeof window.handleChromeBarNavigation === 'function') {
      window.handleChromeBarNavigation();
    }
  });

  copyBtn.addEventListener('click', async () => {
    const url = resultUrl.textContent.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1200);
    } catch (_) {}
  });

  async function startUpload() {
    if (!selected || selected.length === 0) return;

    hideResult();
    panelStatus().innerHTML = '';
    cancelBtn.style.display = '';

    const abortCtrl = new AbortController();
    currentAbort = abortCtrl;
    const untrack = trackAbort(getActiveTab(), abortCtrl);

    const uploadStart = performance.now();
    const elapsedTimer = setInterval(() => {
      cardElap.textContent = formatElapsed((performance.now() - uploadStart) / 1000);
    }, 500);

    let packed = null;
    await withKeepAlive(async () => {
      try {
        panelStatus().textContent = 'Connecting…';
        const sdk = await connectSdk(panelStatus());
        if (!sdk) throw new Error('SDK not connected');

        panelStatus().textContent = 'Packing files into shared slabs…';
        packed = sdk.uploadPacked();

        // Hand every file to the packed upload. packed.add() just
        // buffers bytes into slabs — the real network upload happens
        // during finalize(), so we DON'T advance the files-done counter
        // here. File#stream() works as the ReadableStream argument.
        // finalize() returns PinnedObjects in add() order, so we keep
        // paths in a parallel array indexed the same way.
        const paths = [];
        for (let i = 0; i < selected.length; i++) {
          if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const { relPath, file } = selected[i];
          paths.push(relPath);
          cardCur.textContent = `Packing ${relPath} (${formatSize(file.size)}) — ${i + 1} / ${selected.length}`;
          await Promise.race([
            packed.add(file.stream()),
            abortPromise(abortCtrl.signal),
          ]);
        }

        if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');

        // Finalize actually uploads the slabs to hosts — this is the
        // slow part. We don't get per-byte callbacks, so switch the
        // progress bar to indeterminate until it returns.
        const slabCount = typeof packed.slabs === 'function' ? packed.slabs() : packed.slabs;
        cardCur.textContent = `Uploading ${slabCount} slab${slabCount === 1 ? '' : 's'} to hosts…`;
        progress.removeAttribute('value');
        const objects = await Promise.race([
          packed.finalize(),
          abortPromise(abortCtrl.signal),
        ]);
        packed = null;
        progress.value = 0;

        if (objects.length !== paths.length) {
          throw new Error(`packed upload returned ${objects.length} objects, expected ${paths.length}`);
        }

        // Slabs are now durably stored — every file is effectively
        // uploaded. Bump the counter so the user sees the work landed.
        let filesDone = objects.length;
        cardDone.textContent = filesDone + ' / ' + selected.length;
        progress.value = filesDone;

        // Pin each packed object so it survives the indexer's GC, then
        // build the manifest. Values are `sia://` share URLs rather than
        // bare object IDs so the manifest resolves from any account, not
        // just the one that uploaded it. The validity window is taken
        // from the user-controlled input at the top of the panel — it's
        // baked into the manifest and can't be changed after upload.
        const manifest = {};
        const durMs = parseFloat(validityNum.value) * parseInt(validityUnit.value, 10);
        if (!isFinite(durMs) || durMs <= 0) {
          throw new Error('Invalid inner share URL validity');
        }
        const validUntil = new Date(Date.now() + durMs);
        for (let i = 0; i < objects.length; i++) {
          if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
          cardCur.textContent = `Pinning ${paths[i]}`;
          await sdk.pinObject(objects[i]);
          manifest[paths[i]] = sdk.shareObject(objects[i], validUntil);
        }

        // Upload the manifest itself. It can't go through the packed
        // handle above because its bytes depend on the object IDs we
        // just learned. It's tiny, so a one-off upload is fine.
        cardCur.textContent = 'Uploading manifest';
        const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest), null, 2);
        const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
        const manifestObj = await Promise.race([
          sdk.upload(new PinnedObject(), manifestBlob.stream()),
          abortPromise(abortCtrl.signal),
        ]);
        await sdk.pinObject(manifestObj);
        const manifestId = manifestObj.id();
        progress.value = progress.max;
        cardCur.textContent = 'Done';

        // Result URL is a portable sia-site:// share URL signed with
        // the same validity window as the inner file URLs — anyone with
        // it can resolve the site regardless of their indexer account.
        const siaShareUrl = sdk.shareObject(manifestObj, validUntil);
        const url = 'sia-site://' + siaShareUrl.replace(/^sia:\/\//, '');
        resultId.textContent = manifestId;
        resultUrl.textContent = url;
        result.style.display = '';
        panelStatus().innerHTML = `<span class="pass">Site uploaded in ${formatElapsed((performance.now() - uploadStart) / 1000)}</span>`;
      } catch (e) {
        if (abortCtrl.signal.aborted) {
          panelStatus().innerHTML = '<span class="fail">Upload cancelled</span>';
          cardCur.textContent = 'Cancelled';
        } else {
          panelStatus().innerHTML = `<span class="fail">${_esc(e.message || String(e))}</span>`;
          cardCur.textContent = 'Failed';
        }
        if (packed) {
          try { packed.cancel(); } catch (_) {}
        }
      } finally {
        clearInterval(elapsedTimer);
        cancelBtn.style.display = 'none';
        untrack();
        if (currentAbort === abortCtrl) currentAbort = null;
      }
    });
  }
}

// Rejects when the signal aborts — lets us Promise.race against
// sdk.upload() / packed.add() / packed.finalize() to break out of a
// hanging call immediately.
function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new DOMException('cancelled', 'AbortError')); return; }
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  });
}
