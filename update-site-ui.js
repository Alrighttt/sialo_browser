// Update Site — load an existing sia-site://, edit its file list, and
// republish. Complements the folder-upload and Site Builder flows in
// upload-site-ui.js: those build a site from scratch, this one forks
// an existing one.
//
// Publish semantics:
//   • Unchanged files:  resolve the object via its original share URL,
//                       stamp a new `${uploadId}/${path}` into its
//                       metadata (so My Objects groups the republish
//                       together with any new files), and re-sign the
//                       share URL at the panel's validity.
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
import { encodeMetadata, sanitizeDisplayFilename } from './object-metadata.js';
import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { buildSiaSiteManifest } from './sia-site.js';

function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

// Bare 64-char hex → treat as a manifest object ID. Share-URL form keeps
// the query string + `#encryption_key=` fragment that the indexer needs
// to resolve the object without our account's app key.
function parseUpdateInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('sia-site://')) {
    const rest = s.slice('sia-site://'.length).replace(/\/+$/, '');
    if (/^[0-9a-fA-F]{64}$/.test(rest)) return rest;
    return 'sia://' + rest;
  }
  if (s.startsWith('sia://') || s.startsWith('https://')) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s;
  return null;
}

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
      throw new Error(`manifest entry \`${k}\` is not a sia:// share URL`);
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
  const validityNum  = document.getElementById('us-validity-num');
  const validityUnit = document.getElementById('us-validity-unit');
  const result    = document.getElementById('us-result');
  const resultId  = document.getElementById('us-result-id');
  const resultUrl = document.getElementById('us-result-url');

  // Per-row state: the draft table the UI renders and the publish flow
  // consumes. Each entry captures the path as it appeared in the loaded
  // manifest (`origPath`) alongside the editable current path (`path`),
  // plus either a reference to the original share URL (unchanged /
  // renamed) or a File blob (added / modified).
  //
  //   { id, origPath, path, origShareUrl, file?, removed, state }
  //
  // `state` is one of: unchanged | renamed | modified | added | removed.
  // Recomputed by computeState() whenever the table is re-rendered.
  let draft = [];

  function computeState(row) {
    if (row.removed) return 'removed';
    if (!row.origShareUrl) return 'added';
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
      countEl.textContent = '';
      return;
    }
    emptyEl.style.display = 'none';
    listWrap.style.display = '';
    actions.style.display = 'flex';
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
        <td style="padding:0.4rem 0.6rem; ${pathStyle} font-family:var(--font-mono); font-size:0.8rem; word-break:break-all;">${_esc(r.path)}</td>
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

  function resetDraft() {
    draft = [];
    render();
    result.style.display = 'none';
  }

  loadBtn.addEventListener('click', loadSite);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSite(); });

  async function loadSite() {
    const input = parseUpdateInput(urlInput.value);
    if (!input) {
      panelStatus().innerHTML = '<span class="fail">Enter a sia-site:// URL or manifest ID.</span>';
      return;
    }
    loadBtn.disabled = true;
    try {
      panelStatus().textContent = 'Connecting…';
      const sdk = await connectSdk(panelStatus());
      if (!sdk) return;
      panelStatus().textContent = 'Fetching manifest…';
      const { obj } = await resolveObject(input, sdk);
      const bytes = await readStreamFully(sdk.download(obj));
      const files = parseManifestBytes(bytes);
      const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
      draft = entries.map(([path, shareUrl]) => ({
        id: rowId(),
        origPath: sanitizeDisplayFilename(path),
        path: sanitizeDisplayFilename(path),
        origShareUrl: shareUrl,
        file: null,
        removed: false,
        state: 'unchanged',
      }));
      render();
      panelStatus().innerHTML = `<span class="pass">Loaded ${entries.length} file${entries.length === 1 ? '' : 's'} from manifest.</span>`;
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
          render();
        }
      });
      picker.click();
    } else if (act === 'remove') {
      if (!row.origShareUrl) {
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
      } else {
        draft.push({
          id: rowId(),
          origPath: null,
          path,
          origShareUrl: null,
          file: f,
          removed: false,
          state: 'added',
        });
      }
    }
    render();
  });

  discardBtn.addEventListener('click', () => {
    if (draft.length > 0 && !confirm('Discard all changes and unload this site?')) return;
    urlInput.value = '';
    resetDraft();
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
      panelStatus().innerHTML = '<span class="fail">Invalid share validity.</span>';
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
          const taggedPath = `${uploadId}/${row.path}`;

          if (state === 'unchanged' || state === 'renamed') {
            panelStatus().textContent = `Re-signing ${row.path} (${i}/${sorted.length})…`;
            // Share URLs are indexer-specific — resolveObject forbids
            // fallback to other profiles for them, which is exactly
            // what we want: if the user's primary indexer doesn't have
            // the object, the republish of that file fails loudly
            // rather than silently dropping it.
            const { obj } = await resolveObject(row.origShareUrl, sdk);
            obj.updateMetadata(encodeMetadata({ filename: taggedPath }));
            await sdk.updateObjectMetadata(obj);
            manifest[row.path] = sdk.objectShareUrl(obj, validUntil);
          } else if (state === 'modified' || state === 'added') {
            panelStatus().textContent = `Uploading ${row.path} (${i}/${sorted.length})…`;
            const pinned = new PinnedObject();
            pinned.updateMetadata(encodeMetadata({ filename: taggedPath }));
            const obj = await sdk.upload(pinned, row.file.stream());
            await sdk.pinObject(obj);
            manifest[row.path] = sdk.objectShareUrl(obj, validUntil);
          }
        }

        panelStatus().textContent = 'Uploading manifest…';
        const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest), null, 2);
        const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
        const manifestPinned = new PinnedObject();
        manifestPinned.updateMetadata(encodeMetadata({ filename: `${uploadId}/manifest.json` }));
        const manifestObj = await sdk.upload(manifestPinned, manifestBlob.stream());
        await sdk.pinObject(manifestObj);

        const siaShareUrl = sdk.objectShareUrl(manifestObj, validUntil);
        const url = 'sia-site://' + siaShareUrl.replace(/^sia:\/\//, '');
        resultId.textContent = manifestObj.id();
        resultUrl.textContent = url;
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
