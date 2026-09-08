// Update Site — load an existing sialo://, edit its file list, and
// republish. Complements the folder-upload and Site Builder flows in
// upload-site-ui.js: those build a site from scratch, this one forks
// an existing one.
//
// Publish semantics:
//   • Unchanged files:  resolve the object via its original published URL,
//                       stamp a new `${uploadId}/${path}` into its
//                       metadata (so My Objects groups the republish
//                       together with any new files), and re-sign the
//                       published URL at the panel's validity.
//   • Renamed files:    same as unchanged but with `${uploadId}/${newPath}`.
//   • Modified files:   upload the replacement bytes as a fresh object,
//                       metadata-tagged with the new uploadId + path.
//                       The stale object is left pinned — the user can
//                       clean it up from My Objects.
//   • Added files:      same as modified.
//   • Removed files:    dropped from the manifest. The original object
//                       remains pinned; only the site no longer points
//                       at it.
//
// All file paths are routed through `sanitizeDisplayFilename` so they
// stay multi-segment (`assets/app.js`) when displayed but can't contain
// invisible / BiDi-override codepoints.

import { _esc, formatSize } from './utils.js';
import { connectSdk, resolveObject } from './config.js';
import { withKeepAlive } from './keep-alive.js';
import { getActiveTab, tabStatusProxy } from './tabs.js';
import {
  encodeMetadata, sanitizeDisplayFilename, filenameForDisplay, stripUploadUuid,
} from './object-metadata.js';
import { PinnedObject, SharingKey } from './pkg/sia_storage_wasm.js';
import { buildSiaSiteManifest, publishedSiteLink } from './sia-site.js';
import { siteLink } from './sharing-keys.js';
import {
  isVideoFile, checkVideoCompat, suggestFfmpegFix, describeFfmpegFix,
} from './video-compat.js';

function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

// Bare 64-char hex → treat as a manifest object ID. Publish-URL form keeps
// the query string + `#encryption_key=` fragment that the indexer needs
// to resolve the object without our account's app key.
function parseUpdateInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('sialo://')) {
    const rest = s.slice('sialo://'.length).replace(/\/+$/, '');
    // A key-backed address may carry an in-site path (sialo://<seed>/index.html).
    // The site is the part before the first separator; the rest addresses a page
    // within it and is not part of the site's identity.
    const head = rest.split(/[/?#]/)[0];
    if (/^[0-9a-fA-F]{64}$/.test(head)) return head;
    return 'sia://' + rest;
  }
  if (s.startsWith('sia://') || s.startsWith('https://')) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s;
  return null;
}


/**
 * Lists a key-backed site's files, or returns null when the input is not
 * a sharing-key seed. Owner-side, so it reads through the account's own
 * SDK rather than connecting as a recipient.
 */
async function loadKeySiteFiles(sdk, input) {
  if (!/^[0-9a-fA-F]{64}$/.test(input)) return null;
  let key;
  try {
    key = SharingKey.fromSeed(input.toLowerCase());
  } catch (_) {
    return null;
  }
  const PAGE = 100;
  const out = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await sdk.sharedObjects(key, offset, PAGE);
      for (const obj of page) {
        const name = stripUploadUuid(filenameForDisplay(obj.metadata()) || '');
        if (name) out.push({ path: name, obj });
      }
      if (page.length < PAGE) break;
    }
  } catch (_) {
    // Not one of this account's sharing keys; fall back to the manifest.
    return null;
  }
  return out.length ? out : null;
}

// The `type` field inside a published site's manifest JSON. This is a wire
// format, not a URL scheme: manifests already stored on Sia carry the literal
// string "sia-site", and those bytes cannot be rewritten. Renaming the URL
// scheme deliberately does NOT rename this, or every site published before
// the rename would fail validation and become unloadable.
const MANIFEST_TYPE = 'sia-site';
const MANIFEST_VERSION = 1;

function parseManifestBytes(bytes) {
  const text = new TextDecoder().decode(bytes);
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Error('manifest is not valid JSON: ' + e.message); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest is not a JSON object');
  if (m.type !== MANIFEST_TYPE) throw new Error(`not a sia-site manifest (type=${JSON.stringify(m.type)})`);
  if (m.version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version ${m.version}`);
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('manifest missing files map');
  for (const [k, v] of Object.entries(m.files)) {
    if (typeof v !== 'string' || !v.startsWith('sia://')) {
      throw new Error(`manifest entry \`${k}\` is not a sia:// published URL`);
    }
  }
  return m.files;
}

async function readStreamFully(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * Browser-playability results for files staged in the update, keyed by row id.
 * A `null` value means the file was checked and there is nothing to say. The
 * entry is dropped whenever a row's file is swapped, so a replacement is always
 * re-checked rather than inheriting the old file's verdict.
 */
const videoCompatById = new Map();

export function initUpdateSiteUI() {
  const urlInput   = document.getElementById('upd-url');
  const loadBtn    = document.getElementById('upd-load');
  const emptyEl    = document.getElementById('upd-empty');
  const listWrap   = document.getElementById('upd-list-wrap');
  const listEl     = document.getElementById('upd-list');
  const actions    = document.getElementById('upd-actions');
  const addBtn     = document.getElementById('upd-add-btn');
  const addInput   = document.getElementById('upd-add-input');
  const publishBtn = document.getElementById('upd-publish');
  const discardBtn = document.getElementById('upd-discard');
  const countEl    = document.getElementById('upd-count');
  const videoWarn  = document.getElementById('upd-video-warn');
  const validityNum  = document.getElementById('upd-validity-num');
  const validityUnit = document.getElementById('upd-validity-unit');
  const outputs      = document.getElementById('upd-outputs');
  const shareBtn     = document.getElementById('upd-share');
  const shareDesc    = document.getElementById('upd-share-desc');
  const shareValNum  = document.getElementById('upd-share-validity-num');
  const shareValUnit = document.getElementById('upd-share-validity-unit');
  const shareProg    = document.getElementById('upd-share-progress');
  const publishProg  = document.getElementById('upd-publish-progress');
  const shareRes     = document.getElementById('upd-share-result');
  const shareKeyEl   = document.getElementById('upd-share-key');
  const shareUrlEl   = document.getElementById('upd-share-url');
  const shareCopyBtn = document.getElementById('upd-share-copy');
  const shareOpenBtn = document.getElementById('upd-share-open');
  const shareReuse   = document.getElementById('upd-share-reuse');
  const shareDescFld = document.getElementById('upd-share-desc-field');
  const shareValFld  = document.getElementById('upd-share-validity-field');
  // Update Site shares the Publish section's result block on the Upload
  // Site panel. The wrapper was `us-result` before that panel split publish
  // and share into separate sections, each with its own result.
  const result    = document.getElementById('us-publish-result');
  const resultId  = document.getElementById('us-result-id');
  const resultUrl = document.getElementById('us-result-url');
  const resultLink = document.getElementById('us-result-link');

  // Per-row state: the draft table the UI renders and the publish flow
  // consumes. Each entry captures the path as it appeared in the loaded
  // manifest (`origPath`) alongside the editable current path (`path`),
  // plus either a reference to the original published URL (unchanged /
  // renamed) or a File blob (added / modified).
  //
  //   { id, origPath, path, origPublishUrl, origObject, file?, removed, state }
  //
  // `state` is one of: unchanged | renamed | modified | added | removed.
  // Recomputed by computeState() whenever the table is re-rendered.
  let draft = [];

  /**
   * The sharing-key seed this site was loaded from, when it was loaded from
   * one. Sharing an update then reuses that key instead of minting a new
   * one, so every link already handed out keeps resolving to the updated
   * site — which is the point of a revocable key, and the one way updating
   * differs from publishing here.
   */
  let loadedSeed = null;

  function computeState(row) {
    if (row.removed) return 'removed';
    if (!row.origPublishUrl && !row.origObject) return 'added';
    if (row.file) return 'modified';
    if (row.path !== row.origPath) return 'renamed';
    return 'unchanged';
  }

  const STATE_STYLES = {
    unchanged: { color: '#64748b', label: 'unchanged' },
    renamed:   { color: '#eab308', label: 'renamed' },
    modified:  { color: '#3b82f6', label: 'modified' },
    added:     { color: '#10b981', label: 'added' },
    removed:   { color: '#dc2626', label: 'removed' },
  };

  function rowId() { return 'r' + Math.random().toString(36).slice(2, 10); }

  function refreshCount() {
    const active = draft.filter(r => !r.removed).length;
    const removed = draft.length - active;
    countEl.textContent =
      `${active} file${active === 1 ? '' : 's'}` +
      (removed ? ` · ${removed} removed` : '');
  }

  function render() {
    if (draft.length === 0) {
      emptyEl.style.display = '';
      listWrap.style.display = 'none';
      actions.style.display = 'none';
    outputs.style.display = 'none';
      countEl.textContent = '';
      videoWarn.style.display = 'none';
      return;
    }

    // Videos staged in this update that the browser will not play properly.
    // A replacement that does not play is the same mistake as uploading one
    // that does not, and here it also breaks a site that was working.
    const badVideos = [];
    for (const r of draft) {
      if (r.removed) continue;
      const v = videoCompatById.get(r.id);
      if (v && !v.ok) badVideos.push({ row: r, result: v });
    }
    if (badVideos.length > 0) {
      const n = badVideos.length;
      const items = badVideos.map(({ row, result }) => {
        const problems = result.problems.map((x) => `<li>${_esc(x)}</li>`).join('');
        const name = (row.file && row.file.name) || row.path;
        return `<div style="margin-top:0.6rem;">`
          + `<div><strong>${_esc(row.path)}</strong></div>`
          + `<ul style="margin:0.2rem 0 0.35rem 1.1rem; padding:0;">${problems}</ul>`
          + `<code class="us-ffmpeg">${_esc(suggestFfmpegFix(name, result))}</code>`
          + `<div class="us-ffmpeg-note">${_esc(describeFfmpegFix(result))}</div>`
          + `</div>`;
      }).join('');
      videoWarn.innerHTML =
        `<div>&#9888; <strong>${n} staged video${n === 1 ? '' : 's'} may not play in a browser.</strong> `
        + `Publishing or sharing this update would put ${n === 1 ? 'it' : 'them'} live as ${n === 1 ? 'it is' : 'they are'}. `
        + `Re-encode, then use <em>Replace</em> on the row to swap in the new file:</div>${items}`;
      videoWarn.style.display = '';
    } else {
      videoWarn.style.display = 'none';
    }
    emptyEl.style.display = 'none';
    listWrap.style.display = '';
    actions.style.display = 'flex';
    outputs.style.display = 'grid';
    if (loadedSeed) {
      shareReuse.innerHTML =
        'This site was loaded from a sharing key. Sharing updates <strong>reuses that key</strong>, '
        + 'so links already handed out will serve the updated site, and files you remove stop resolving '
        + 'for people holding them.';
      shareReuse.style.display = '';
      // The key already exists; its description and expiry are set on the
      // Sharing Keys page, not here.
      shareDescFld.style.display = 'none';
      shareValFld.style.display = 'none';
      shareBtn.textContent = 'Update sharing key';
    } else {
      shareReuse.style.display = 'none';
      shareDescFld.style.display = '';
      shareValFld.style.display = '';
      shareBtn.textContent = 'Share updates';
    }
    refreshCount();
    const rows = [...draft].sort((a, b) => a.path.localeCompare(b.path));
    let html = '<tbody>';
    for (const r of rows) {
      r.state = computeState(r);
      const style = STATE_STYLES[r.state];
      const size = r.file ? r.file.size : null;
      const sizeLabel = size != null ? formatSize(size) : '';
      const pathStyle = r.removed
        ? 'color:#555; text-decoration:line-through;'
        : 'color:#ccc;';
      html += `<tr data-row-id="${r.id}" style="border-bottom:1px solid #1a1a1a;">
        <td style="padding:0.4rem 0.6rem; ${pathStyle} font-family:var(--font-mono); font-size:0.8rem; word-break:break-all;">${_esc(r.path)}${
          (() => {
            const v = videoCompatById.get(r.id);
            return v && !v.ok
              ? ' <span class="sb-vwarn" title="May not play back in a browser">&#9888;</span>'
              : '';
          })()
        }</td>
        <td style="padding:0.4rem 0.6rem; color:#888; font-size:0.75rem; white-space:nowrap;">${sizeLabel}</td>
        <td style="padding:0.4rem 0.6rem; white-space:nowrap;">
          <span style="color:${style.color}; font-size:0.75rem;">${style.label}</span>
        </td>
        <td style="padding:0.4rem 0.6rem; white-space:nowrap; text-align:right;">`;
      if (r.removed) {
        html += `<button data-act="restore" data-id="${r.id}" style="padding:0.15rem 0.5rem; font-size:0.75rem;">Undo</button>`;
      } else {
        html += `<button data-act="rename"  data-id="${r.id}" style="padding:0.15rem 0.5rem; font-size:0.75rem;">Rename</button>
                 <button data-act="replace" data-id="${r.id}" style="padding:0.15rem 0.5rem; font-size:0.75rem; margin-left:0.25rem;">Replace</button>
                 <button data-act="remove"  data-id="${r.id}" style="padding:0.15rem 0.5rem; font-size:0.75rem; background:#dc2626; color:white; margin-left:0.25rem;">Remove</button>`;
      }
      html += `</td></tr>`;
    }
    html += '</tbody>';
    listEl.innerHTML = html;
  }

  // Bumped whenever the staged set changes, so a scan still walking the old
  // set stops instead of writing verdicts for files no longer in the draft.
  let videoScanSeq = 0;

  /**
   * Check staged videos for browser playability, one at a time. Same reasoning
   * as the Upload Site page: each check decodes a moment of the file, so these
   * must not all run at once, and a file that cannot be checked produces no
   * warning rather than a guess.
   */
  async function scanVideosForCompat() {
    const seq = ++videoScanSeq;
    for (const row of draft) {
      if (seq !== videoScanSeq) return;
      if (!row.file || row.removed) continue;
      if (videoCompatById.has(row.id)) continue;
      if (!isVideoFile(row.file)) continue;
      let result = null;
      try {
        result = await checkVideoCompat(row.file);
      } catch (_) {
        result = null;
      }
      if (seq !== videoScanSeq) return;
      videoCompatById.set(row.id, result);
      if (result && !result.ok) render();
    }
  }

  function resetDraft() {
    videoCompatById.clear();
    draft = [];
    loadedSeed = null;
    shareRes.style.display = 'none';
    shareProg.style.display = 'none';
    publishProg.style.display = 'none';
    render();
    result.style.display = 'none';
  }

  loadBtn.addEventListener('click', loadSite);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSite(); });

  async function loadSite() {
    const input = parseUpdateInput(urlInput.value);
    if (!input) {
      panelStatus().innerHTML = '<span class="fail">Enter a sialo:// URL or manifest ID.</span>';
      return;
    }
    loadBtn.disabled = true;
    try {
      panelStatus().textContent = 'Connecting…';
      const sdk = await connectSdk(panelStatus());
      if (!sdk) return;
      panelStatus().textContent = 'Loading site…';
      // A key-backed site hands back its objects directly; a legacy
      // manifest site hands back published URLs that have to be resolved
      // one at a time when the update is published.
      let entries;
      let sourceLabel;
      const asKey = await loadKeySiteFiles(sdk, input);
      if (asKey) {
        entries = asKey.map(({ path, obj }) => [path, { obj, publishUrl: null }]);
        sourceLabel = 'sharing key';
        loadedSeed = input.toLowerCase();
      } else {
        const { obj } = await resolveObject(input, sdk);
        const bytes = await readStreamFully(sdk.download(obj));
        const files = parseManifestBytes(bytes);
        entries = Object.entries(files).map(([path, url]) => [path, { obj: null, publishUrl: url }]);
        sourceLabel = 'manifest';
        loadedSeed = null;
      }
      entries.sort(([a], [b]) => a.localeCompare(b));
      draft = entries.map(([path, ref]) => ({
        id: rowId(),
        origPath: sanitizeDisplayFilename(path),
        path: sanitizeDisplayFilename(path),
        origPublishUrl: ref.publishUrl,
        origObject: ref.obj,
        file: null,
        removed: false,
        state: 'unchanged',
      }));
      render();
      panelStatus().innerHTML = `<span class="pass">Loaded ${entries.length} file${entries.length === 1 ? '' : 's'} from ${sourceLabel}.</span>`;
    } catch (e) {
      panelStatus().innerHTML = `<span class="fail">Failed to load: ${_esc(e.message || String(e))}</span>`;
    } finally {
      loadBtn.disabled = false;
    }
  }

  listEl.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.dataset.act;
    const id = t.dataset.id;
    if (!act || !id) return;
    const row = draft.find(r => r.id === id);
    if (!row) return;

    if (act === 'rename') {
      const raw = prompt('New path in this site:', row.path);
      if (raw === null) return;
      const clean = sanitizeDisplayFilename(raw).replace(/^\/+/, '');
      if (!clean) {
        panelStatus().innerHTML = '<span class="fail">Path is empty after sanitizing.</span>';
        return;
      }
      if (draft.some(r => r !== row && !r.removed && r.path === clean)) {
        panelStatus().innerHTML = '<span class="fail">Another file already uses that path.</span>';
        return;
      }
      row.path = clean;
      render();
    } else if (act === 'replace') {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.addEventListener('change', () => {
        if (picker.files && picker.files[0]) {
          row.file = picker.files[0];
          videoCompatById.delete(row.id);
          render();
          scanVideosForCompat();
        }
      });
      picker.click();
    } else if (act === 'remove') {
      if (!row.origPublishUrl && !row.origObject) {
        // Never persisted — just drop the row entirely.
        draft = draft.filter(r => r.id !== id);
      } else {
        row.removed = true;
      }
      render();
    } else if (act === 'restore') {
      row.removed = false;
      render();
    }
  });

  addBtn.addEventListener('click', () => {
    addInput.value = '';
    addInput.click();
  });

  addInput.addEventListener('change', () => {
    if (!addInput.files || addInput.files.length === 0) return;
    for (const f of addInput.files) {
      const rel = (f.webkitRelativePath || f.name).replace(/^\/+/, '');
      const path = sanitizeDisplayFilename(rel);
      if (!path) continue;
      // Collision with an existing non-removed row → mark it as modified
      // (replace its content) instead of creating a duplicate path.
      const existing = draft.find(r => !r.removed && r.path === path);
      if (existing) {
        existing.file = f;
        videoCompatById.delete(existing.id);
      } else {
        draft.push({
          id: rowId(),
          origPath: null,
          path,
          origPublishUrl: null,
          origObject: null,
          file: f,
          removed: false,
          state: 'added',
        });
      }
    }
    render();
    scanVideosForCompat();
  });

  discardBtn.addEventListener('click', () => {
    if (draft.length > 0 && !confirm('Discard all changes and unload this site?')) return;
    urlInput.value = '';
    resetDraft();
  });

  /**
   * Resolve one draft row to a pinned object carrying the path it should have
   * in the site. Publish and share both need every file to exist on Sia under
   * its current path and differ only in what they do with the result, so the
   * upload/re-tag work lives here rather than in either of them.
   */
  async function materializeRow(sdk, row, uploadId) {
    const taggedPath = `${uploadId}/${row.path}`;
    const state = computeState(row);
    if (state === 'modified' || state === 'added') {
      const pinned = new PinnedObject();
      pinned.updateMetadata(encodeMetadata({ filename: taggedPath }));
      const obj = await sdk.upload(pinned, row.file.stream());
      await sdk.pinObject(obj);
      return obj;
    }
    // Carried over from the previous version. A key-backed source hands us
    // the object directly; a legacy manifest entry resolves through its
    // published URL, and resolveObject deliberately refuses to fall back to
    // another indexer for those, so a miss fails loudly.
    const obj = row.origObject || (await resolveObject(row.origPublishUrl, sdk)).obj;
    obj.updateMetadata(encodeMetadata({ filename: taggedPath }));
    await sdk.updateObjectMetadata(obj);
    return obj;
  }

  /** The sharing key's expiry, or null for a key that never expires. */
  function shareExpiresAt() {
    const unitMs = parseInt(shareValUnit.value, 10);
    if (!unitMs) return null;
    const durMs = parseFloat(shareValNum.value) * unitMs;
    if (!isFinite(durMs) || durMs <= 0) throw new Error('Invalid share expiry.');
    return new Date(Date.now() + durMs);
  }

  shareBtn.addEventListener('click', share);

  async function share() {
    const active = draft.filter((r) => !r.removed);
    if (active.length === 0) {
      shareProg.style.display = '';
      shareProg.innerHTML = '<span class="fail">Site would have no files — add something or discard.</span>';
      return;
    }
    let expiresAt;
    try {
      expiresAt = shareExpiresAt();
    } catch (e) {
      shareProg.style.display = '';
      shareProg.innerHTML = `<span class="fail">${_esc(e.message)}</span>`;
      return;
    }

    shareBtn.disabled = true;
    publishBtn.disabled = true;
    const label = shareBtn.textContent;
    shareBtn.textContent = 'Sharing…';
    shareProg.style.display = '';
    const started = performance.now();
    const step = (t) => {
      panelStatus().textContent = t;
      shareProg.textContent = `${t} · ${Math.round((performance.now() - started) / 1000)}s`;
    };
    step('Connecting…');

    await withKeepAlive(async () => {
      try {
        const sdk = await connectSdk(panelStatus());
        if (!sdk) throw new Error('Could not connect to the indexer.');

        // Reusing the key keeps every link already handed out working. A site
        // that came from a manifest has no key to reuse, so it gets a new one.
        const reusing = !!loadedSeed;
        const key = reusing
          ? SharingKey.fromSeed(loadedSeed)
          : await sdk.createSharingKey(
              sanitizeDisplayFilename(shareDesc.value || '').trim()
                || `sialo site (${active.length} file${active.length === 1 ? '' : 's'})`,
              expiresAt,
            );

        const uploadId = crypto.randomUUID();
        const sorted = [...active].sort((a, b) => a.path.localeCompare(b.path));
        for (let i = 0; i < sorted.length; i++) {
          const row = sorted[i];
          step(`${computeState(row) === 'unchanged' ? 'Attaching' : 'Uploading'} ${row.path} (${i + 1}/${sorted.length})…`);
          const obj = await materializeRow(sdk, row, uploadId);
          await sdk.shareObject(key, obj);
        }

        // Detaching matters only when reusing a key: a file removed from the
        // draft has to stop resolving for people holding the existing link,
        // otherwise "remove" would be silently cosmetic.
        if (reusing) {
          const gone = draft.filter((r) => r.removed && r.origObject);
          for (let i = 0; i < gone.length; i++) {
            step(`Removing ${gone[i].path} (${i + 1}/${gone.length})…`);
            try {
              await sdk.unshareObject(key, gone[i].origObject.id());
            } catch (err) {
              // Already detached, or never attached to this key. Not fatal.
              panelStatus().textContent = `Could not detach ${gone[i].path}: ${err.message || err}`;
            }
          }
        }

        shareKeyEl.textContent = key.publicKey;
        shareUrlEl.textContent = siteLink(reusing ? loadedSeed : key.seed());
        shareRes.style.display = '';
        const secs = Math.round((performance.now() - started) / 1000);
        const what = reusing
          ? 'Existing sharing key updated — links already handed out now serve this version'
          : 'Site shared with a new sharing key';
        shareProg.innerHTML = `<span class="pass">✓ ${what} (${secs}s)</span>`;
        panelStatus().innerHTML = `<span class="pass">${_esc(what)}.</span>`;
      } catch (e) {
        const msg = e.message || String(e);
        shareProg.innerHTML = `<span class="fail">✗ ${_esc(msg)}</span>`;
        panelStatus().innerHTML = `<span class="fail">Share failed: ${_esc(msg)}</span>`;
      } finally {
        shareBtn.disabled = false;
        publishBtn.disabled = false;
        shareBtn.textContent = label;
      }
    });
  }

  shareCopyBtn.addEventListener('click', async () => {
    const url = shareUrlEl.textContent.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      shareCopyBtn.textContent = 'Copied!';
      setTimeout(() => { shareCopyBtn.textContent = 'Copy share link'; }, 1200);
    } catch (_) {}
  });

  shareOpenBtn.addEventListener('click', () => {
    const url = shareUrlEl.textContent.trim();
    if (url) location.href = url;
  });

  publishBtn.addEventListener('click', publish);

  async function publish() {
    const active = draft.filter(r => !r.removed);
    if (active.length === 0) {
      panelStatus().innerHTML = '<span class="fail">Site would have no files — add something or discard.</span>';
      return;
    }

    const durMs = parseFloat(validityNum.value) * parseInt(validityUnit.value, 10);
    if (!isFinite(durMs) || durMs <= 0) {
      panelStatus().innerHTML = '<span class="fail">Invalid publish validity.</span>';
      return;
    }
    const validUntil = new Date(Date.now() + durMs);

    publishBtn.disabled = true;
    await withKeepAlive(async () => {
      try {
        panelStatus().textContent = 'Connecting…';
        const sdk = await connectSdk(panelStatus());
        if (!sdk) return;

        const uploadId = crypto.randomUUID();
        const manifest = {};
        let i = 0;

        // Pre-sort so the status line progresses alphabetically and
        // multiple identical failures are grouped together.
        const sorted = [...active].sort((a, b) => a.path.localeCompare(b.path));
        for (const row of sorted) {
          i++;
          const state = computeState(row);

          const carried = state === 'unchanged' || state === 'renamed';
          panelStatus().textContent =
            `${carried ? 'Re-signing' : 'Uploading'} ${row.path} (${i}/${sorted.length})…`;
          const obj = await materializeRow(sdk, row, uploadId);
          manifest[row.path] = sdk.objectShareUrl(obj, validUntil);
        }

        panelStatus().textContent = 'Uploading manifest…';
        const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest), null, 2);
        const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
        const manifestPinned = new PinnedObject();
        manifestPinned.updateMetadata(encodeMetadata({ filename: `${uploadId}/manifest.json` }));
        const manifestObj = await sdk.upload(manifestPinned, manifestBlob.stream());
        await sdk.pinObject(manifestObj);

        const siaPublishUrl = sdk.objectShareUrl(manifestObj, validUntil);
        const url = 'sialo://' + siaPublishUrl.replace(/^sia:\/\//, '');
        resultId.textContent = manifestObj.id();
        resultUrl.textContent = url;
        // Set alongside the URL, not left as it was: this block is shared with
        // the Publish section, so a stale link from an earlier publish would
        // otherwise sit next to the address just republished here.
        if (resultLink) resultLink.textContent = publishedSiteLink(url);
        result.style.display = '';
        panelStatus().innerHTML = `<span class="pass">Site updated — new manifest published.</span>`;
        // Reset the draft so the success card isn't paired with a
        // now-stale editing state the user might re-publish by
        // accident. The URL input is left populated so they can
        // re-load if they want.
        draft = [];
        render();
      } catch (e) {
        panelStatus().innerHTML = `<span class="fail">Publish failed: ${_esc(sanitizeErrorMessage(e))}</span>`;
      } finally {
        publishBtn.disabled = false;
      }
    });
  }

  function sanitizeErrorMessage(e) {
    const msg = e && (e.message || String(e));
    return msg ? String(msg).slice(0, 400) : 'unknown error';
  }

  render();
}
