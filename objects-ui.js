import { _esc, formatSize } from './utils.js';
import { connectSdk } from './config.js';
import { ZipWriter } from './vendor/zip-stream.js';
import { parallelDownloadToDisk } from './download.js';
import { withKeepAlive } from './keep-alive.js';
import { loadContentWithAutoDetect } from './browser.js';
import {
  openOrActivateInternalTab, getOrCreateActiveBrowserTab,
  setLastBrowserUrl, renderTabBar, getActiveTab, trackAbort,
  tabStatusProxy,
} from './tabs.js';
import {
  filenameForDisplay, sanitizeFilename, sanitizeDisplayFilename, encodeMetadata,
  stripUploadUuid, extractUploadUuid,
} from './object-metadata.js';
import { addToDraft, removeFromDraft, isInDraft, onDraftChange } from './site-builder.js';

// Status proxy for the currently-active tab. Writes land in the
// bottom-right status bar while the tab is selected and stay scoped
// to that tab otherwise — no leaking between My Objects and other tabs.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

// Filename-based heuristic for "this object is a sia-site manifest".
// All uploaders in this repo name the manifest either `manifest.json`
// (bare) or `<uuid>/manifest.json` (UUID-prefixed). Third-party sites
// that publish under a different filename won't be detected, which is
// fine — View just falls back to the default object viewer.
function isManifestFilename(filename) {
  if (typeof filename !== 'string' || !filename) return false;
  const s = filename.toLowerCase();
  return s === 'manifest.json' || s.endsWith('/manifest.json');
}

// Deterministic hue from an upload UUID. The first 12 hex chars
// already give plenty of entropy for a nice spread around the wheel,
// and using the same bytes every render means the same upload
// session always shows the same color.
function uuidToColor(uuid) {
  let h = 0;
  for (let i = 0; i < 12 && i < uuid.length; i++) {
    h = ((h << 5) - h + uuid.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

export function initObjectsUI() {
  // Cached full listing + pager state. `allObjects` is the deduplicated
  // latest event per object ID (objectEvents returns one event per change;
  // we keep the newest for each id). `sortState` and `pageIndex` drive
  // what slice is rendered into the DOM.
  const allObjects = []; // [{ id, updatedAt, deleted, size, uploadUuid, ... }]
  const selectedIds = new Set(); // checkbox state survives page switches
  const sortState = { column: 'updated', asc: false };
  // Upload-UUID groups collapsed in the UI. A collapsed group still
  // contributes its header row to the display list but skips all of
  // its member object rows. State is kept across renders/pagination.
  const collapsedUuids = new Set();
  let pageSize = 50;
  let pageIndex = 0;
  let loadInFlight = false;

  const pageSizeEl = document.getElementById('list-page-size');
  const pagerEl = document.getElementById('objects-pager');
  const pageInfoEl = document.getElementById('objects-page-info');

  function renderLoadingState(loadedSoFar) {
    const prefix = loadedSoFar == null
      ? 'Loading your objects…'
      : `Loaded ${loadedSoFar.toLocaleString()} so far…`;
    document.getElementById('objects-list').innerHTML = `
      <div id="objects-loading" style="padding:3rem 1rem; display:flex; flex-direction:column; align-items:center; gap:0.75rem; color:#888;">
        <div style="width:36px; height:36px; border:3px solid #1a1a1a; border-top-color:#3b82f6; border-radius:50%; animation:objLoadingSpin 0.8s linear infinite;"></div>
        <div style="font-size:0.9rem;">${prefix}</div>
      </div>
      <style>@keyframes objLoadingSpin { to { transform: rotate(360deg); } }</style>
    `;
  }

  /** Paginate through objectEvents until the SDK runs dry. */
  async function loadAllObjects() {
    if (loadInFlight) return;
    loadInFlight = true;
    const status = panelStatus();
    status.textContent = 'Loading objects…';
    const refreshBtn = document.getElementById('btn-list-objects');
    if (refreshBtn) refreshBtn.disabled = true;
    pagerEl.style.display = 'none';
    renderLoadingState(null);
    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;

      const PAGE = 500; // indexer hard-caps each call at 500
      const latest = new Map(); // id → newest event
      let cursor = null;
      for (;;) {
        const page = await sdk.objectEvents(cursor, PAGE);
        for (const ev of page) {
          const prev = latest.get(ev.id);
          const ms = new Date(ev.updatedAt).getTime() || 0;
          if (!prev || ms >= prev.ms) {
            // `filenameForDisplay` parses our envelope format, falls
            // back to raw UTF-8 for legacy bytes, and strips invisibles
            // (control / zero-width / BiDi). Keeps slashes so full
            // manifest paths like "assets/app.js" display intact.
            // Disk-save call sites re-sanitize with `sanitizeFilename`
            // to flatten into a leaf name. HTML escaping happens at
            // render time via `_esc`.
            const filename = ev.object ? filenameForDisplay(ev.object.metadata()) : '';
            const uploadUuid = extractUploadUuid(filename);
            const displayName = uploadUuid ? stripUploadUuid(filename) : filename;
            // Sia-site manifests uploaded by this app land as objects
            // whose filename is `<uuid>/manifest.json` (folder upload,
            // site builder, update site) or bare `manifest.json`. That's
            // a strong-enough signal to mark them so the View action can
            // open them as a site rather than dumping raw JSON.
            const isManifest = isManifestFilename(filename);
            latest.set(ev.id, {
              id: ev.id,
              updatedAt: ev.updatedAt,
              deleted: ev.deleted,
              size: ev.object ? Number(ev.object.size()) : 0,
              filename,
              displayName,
              uploadUuid,
              isManifest,
              ms,
            });
          }
        }
        status.textContent = `Loading objects… ${latest.size} so far`;
        renderLoadingState(latest.size);
        if (page.length < PAGE) break;
        const last = page[page.length - 1];
        cursor = { id: last.id, after: last.updatedAt };
      }

      allObjects.length = 0;
      for (const o of latest.values()) allObjects.push(o);

      if (allObjects.length === 0) {
        pagerEl.style.display = 'none';
        document.getElementById('objects-list').innerHTML =
          '<div style="padding:1rem; color:#888; text-align:center;">No objects found. Upload something first!</div>';
        status.innerHTML = '<span style="color:#888;">No objects found</span>';
        return;
      }
      pageIndex = 0;
      render();
      status.innerHTML = `<span class="pass">✓ Found ${allObjects.length} object${allObjects.length !== 1 ? 's' : ''}</span>`;
    } catch (e) {
      document.getElementById('objects-list').innerHTML =
        `<div style="padding:1rem; color:#f87171; text-align:center;">Failed to load objects: ${_esc(e.message || String(e))}</div>`;
      status.innerHTML = `<span class="fail">Failed to load objects: ${_esc(e.message || String(e))}</span>`;
    } finally {
      loadInFlight = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function sortValue(obj) {
    switch (sortState.column) {
      case 'id':       return obj.id;
      case 'filename': return obj.filename || '';
      case 'size':     return obj.size;
      case 'status':   return obj.deleted ? 'deleted' : 'active';
      case 'updated':
      default:         return obj.ms;
    }
  }

  // Group-aware sort: keeps rows sharing an upload UUID contiguous no
  // matter which column is sorted. Each group's position is decided by
  // its best sort value (min for ascending, max for descending), then
  // rows within a group sort by the same column.
  //
  // Rows without a UUID use their own sortValue for the group key, so
  // they interleave with groups based on the same column criteria.
  function sortedObjects() {
    const groupKey = new Map(); // uuid → best sort value across its members
    for (const o of allObjects) {
      if (!o.uploadUuid) continue;
      const v = sortValue(o);
      if (!groupKey.has(o.uploadUuid)) {
        groupKey.set(o.uploadUuid, v);
        continue;
      }
      const prev = groupKey.get(o.uploadUuid);
      if (sortState.asc ? v < prev : v > prev) groupKey.set(o.uploadUuid, v);
    }

    const sorted = allObjects.slice();
    sorted.sort((a, b) => {
      const agv = a.uploadUuid ? groupKey.get(a.uploadUuid) : sortValue(a);
      const bgv = b.uploadUuid ? groupKey.get(b.uploadUuid) : sortValue(b);
      if (agv < bgv) return sortState.asc ? -1 : 1;
      if (agv > bgv) return sortState.asc ? 1 : -1;
      // Same group sort-value — separate distinct groups by their UUID
      // (or, for ungrouped rows, by id) so different groups never
      // interleave.
      const au = a.uploadUuid || ('z' + a.id);
      const bu = b.uploadUuid || ('z' + b.id);
      if (au !== bu) return au < bu ? -1 : 1;
      // Within a single group, fall back to the column's raw value.
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av < bv) return sortState.asc ? -1 : 1;
      if (av > bv) return sortState.asc ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  // Build a flat display list from the sorted objects:
  //   [{ kind: 'header', uuid, count, totalSize, collapsed }, ...]
  //   [{ kind: 'row', obj }, ...]
  // Rows inside a collapsed group are omitted; only the header remains.
  // Aggregates (count, totalSize) reflect the full group regardless of
  // which rows land on the current page, so the header is self-contained.
  function buildDisplayList(sorted) {
    // Per-uuid aggregates: file count, total bytes, and the manifest
    // object id (if any) so the group header can carry "Open Site /
    // Share / Delete" actions for sia-site uploads. A non-deleted
    // manifest takes priority over a deleted one if there are stale
    // entries lying around.
    const aggregates = new Map();
    for (const o of allObjects) {
      if (!o.uploadUuid) continue;
      const agg = aggregates.get(o.uploadUuid) || { count: 0, totalSize: 0, manifestId: null };
      agg.count++;
      agg.totalSize += (Number(o.size) || 0);
      if (o.isManifest && !o.deleted && !agg.manifestId) {
        agg.manifestId = o.id;
      }
      aggregates.set(o.uploadUuid, agg);
    }
    const out = [];
    let emittedHeaderFor = null;
    for (const o of sorted) {
      if (o.uploadUuid) {
        if (emittedHeaderFor !== o.uploadUuid) {
          const agg = aggregates.get(o.uploadUuid) || { count: 0, totalSize: 0, manifestId: null };
          out.push({
            kind: 'header',
            uuid: o.uploadUuid,
            count: agg.count,
            totalSize: agg.totalSize,
            manifestId: agg.manifestId,
            collapsed: collapsedUuids.has(o.uploadUuid),
          });
          emittedHeaderFor = o.uploadUuid;
        }
        if (collapsedUuids.has(o.uploadUuid)) continue;
      } else {
        emittedHeaderFor = null;
      }
      out.push({ kind: 'row', obj: o });
    }
    return out;
  }

  function render() {
    const sorted = sortedObjects();
    const displayList = buildDisplayList(sorted);
    const pageCount = Math.max(1, Math.ceil(displayList.length / pageSize));
    if (pageIndex >= pageCount) pageIndex = pageCount - 1;
    if (pageIndex < 0) pageIndex = 0;
    const start = pageIndex * pageSize;
    const pageItems = displayList.slice(start, start + pageSize);

    // If the page starts mid-group, walk back to find that group's
    // header so the continuation is labelled. Without this, page 2 of a
    // long site would show bare indented rows with no context.
    if (pageItems.length > 0 && pageItems[0].kind === 'row' && pageItems[0].obj.uploadUuid) {
      const firstUuid = pageItems[0].obj.uploadUuid;
      for (let i = start - 1; i >= 0; i--) {
        const item = displayList[i];
        if (item.kind === 'header' && item.uuid === firstUuid) {
          pageItems.unshift({ ...item, continuation: true });
          break;
        }
      }
    }

    const objectsList = document.getElementById('objects-list');
    let html = `
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
          <thead>
            <tr style="border-bottom:2px solid #333; text-align:left;">
              <th style="padding:0.5rem; width:2rem;"><input type="checkbox" id="obj-select-all" title="Select all" /></th>
              <th data-sort="filename" style="padding:0.5rem; cursor:pointer; user-select:none;">Name<span class="sort-arrow"></span></th>
              <th data-sort="id"      style="padding:0.5rem; cursor:pointer; user-select:none;">Object ID<span class="sort-arrow"></span></th>
              <th data-sort="size"    style="padding:0.5rem; cursor:pointer; user-select:none;">Size<span class="sort-arrow"></span></th>
              <th data-sort="updated" style="padding:0.5rem; cursor:pointer; user-select:none;">Updated<span class="sort-arrow"></span></th>
              <th data-sort="status"  style="padding:0.5rem; cursor:pointer; user-select:none;">Status<span class="sort-arrow"></span></th>
              <th style="padding:0.5rem;">Actions</th>
            </tr>
          </thead>
          <tbody>
      `;

    for (const item of pageItems) {
      if (item.kind === 'header') {
        const color = uuidToColor(item.uuid);
        const caret = item.collapsed ? '▶' : '▼';
        const shortUuid = item.uuid.substring(0, 8);
        const suffix = item.continuation ? ' (continued)' : '';
        const sizeLabel = item.totalSize ? formatSize(item.totalSize) : '';
        // Site-level action buttons. Only render when the group has a
        // manifest (i.e. it was uploaded as a sia-site). The data-action
        // attribute pairs with a delegated handler that stops propagation
        // so clicking a button doesn't toggle collapse on the row.
        const siteActions = item.manifestId ? `
          <span style="float:right;">
            <button data-action="open-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open as sia-site">Open Site</button>
            <button data-action="share-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#10b981; color:white; margin-left:0.25rem;" title="Generate share URL for this site">Share</button>
            <button data-action="delete-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#dc2626; color:white; margin-left:0.25rem;" title="Delete this site (or site + all referenced files)">Delete</button>
          </span>` : '';
        html += `
          <tr class="obj-group-header" data-uuid="${item.uuid}" style="cursor:pointer; background:#0f0f0f; border-bottom:1px solid #222; border-left:4px solid ${color};">
            <td colspan="7" style="padding:0.45rem 0.75rem;">
              <span style="display:inline-block; width:1rem; color:#9ca3af; font-size:0.75rem;">${caret}</span>
              <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${color}; margin-right:0.5rem; vertical-align:middle;"></span>
              <span style="font-family:var(--font-mono); color:#cbd5e1; font-size:0.8rem;">${shortUuid}</span>
              <span style="color:#6b7280; font-size:0.8rem; margin-left:0.75rem;">${item.count} file${item.count === 1 ? '' : 's'}${sizeLabel ? ' · ' + sizeLabel : ''}${suffix}</span>
              ${siteActions}
            </td>
          </tr>
        `;
        continue;
      }
      const obj = item.obj;
      const shortId = obj.id.substring(0, 4) + '…' + obj.id.substring(obj.id.length - 4);
      const sizeBytes = obj.size;
      const size = sizeBytes ? formatSize(sizeBytes) : 'N/A';
      const date = new Date(obj.updatedAt).toLocaleString();
      const objStatus = obj.deleted ? '<span class="fail">Deleted</span>' : '<span class="pass">Active</span>';
      const checked = selectedIds.has(obj.id) ? 'checked' : '';
      // Filename cell. Objects with no metadata show an em-dash;
      // upload-UUID-prefixed filenames have their prefix stripped for
      // display (full value stays in the hover title). Members of a
      // group get an extra left-pad so the visible path indents under
      // the group header.
      const fnameFull = obj.filename || '';
      const fnameDisplay = obj.displayName || fnameFull;
      const fnameShort = fnameDisplay.length > 40 ? fnameDisplay.slice(0, 40) + '…' : fnameDisplay;
      const indent = obj.uploadUuid ? 'padding-left:2rem;' : '';
      const filenameCell = fnameFull
        ? `<td style="padding:0.5rem; ${indent} font-size:0.85rem; color:#d4d4d4;" title="${_esc(fnameFull)}">${_esc(fnameShort)}</td>`
        : `<td style="padding:0.5rem; ${indent} color:#555;">—</td>`;
      // Ungrouped rows keep a transparent left-border so horizontal
      // alignment stays stable. Grouped rows reuse the group's color
      // as a thinner accent, echoing the header bar.
      const rowAccent = obj.uploadUuid
        ? `border-left:4px solid ${uuidToColor(obj.uploadUuid)};`
        : 'border-left:4px solid transparent;';
      html += `
          <tr data-upload-uuid="${obj.uploadUuid || ''}" style="border-bottom:1px solid #222; ${rowAccent}">
            <td style="padding:0.5rem;">${!obj.deleted ? `<input type="checkbox" class="obj-select" data-id="${obj.id}" data-size="${sizeBytes}" ${checked}/>` : ''}</td>
            ${filenameCell}
            <td onclick="copyToClipboard('${obj.id}')" style="padding:0.5rem; font-family:monospace; font-size:0.85rem; cursor:pointer;" title="Click to copy: ${obj.id}">${shortId}</td>
            <td style="padding:0.5rem;">${size}</td>
            <td style="padding:0.5rem;">${date}</td>
            <td style="padding:0.5rem;">${objStatus}</td>
            <td style="padding:0.5rem;">
              ${!obj.deleted ? `
                <button onclick="viewObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open in browser viewer">View</button>
                <button onclick="shareObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#10b981; color:white; margin-left:0.25rem;" title="Generate share URL">Share</button>
                <button onclick="renameObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;" title="Rename or set the object's filename">Rename</button>
                ${isInDraft(obj.id)
                  ? `<button onclick="removeFromSiteBuilder('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#0d9488; color:white; margin-left:0.25rem;" title="Remove from the site being built on the Upload Site page">✓ In site</button>`
                  : `<button onclick="addToSiteBuilder('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;" title="Add to the site being built on the Upload Site page">Add to site</button>`}
                <button onclick="showObjectInfo('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#8b5cf6; color:white; margin-left:0.25rem;" title="Show details">Info</button>
                <button onclick="downloadObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;">Download</button>
                <button onclick="deleteObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem; background:#dc2626; color:white;">Delete</button>
              ` : ''}
            </td>
          </tr>
        `;
    }

    html += `
          </tbody>
        </table>
      `;

    objectsList.innerHTML = html;

    // Refresh sort-arrow indicators on the headers.
    for (const th of objectsList.querySelectorAll('th[data-sort]')) {
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) {
        arrow.textContent = th.dataset.sort === sortState.column
          ? (sortState.asc ? ' ▲' : ' ▼')
          : '';
      }
      th.addEventListener('click', () => {
        if (sortState.column === th.dataset.sort) sortState.asc = !sortState.asc;
        else { sortState.column = th.dataset.sort; sortState.asc = true; }
        pageIndex = 0;
        render();
      });
    }

    // Pager controls + info text. Totals reflect the display list
    // (groups + visible rows) so the user sees the same numbers whether
    // or not any groups are collapsed.
    pagerEl.style.display = 'flex';
    pageInfoEl.textContent = `${start + 1}–${Math.min(start + pageSize, displayList.length)} of ${displayList.length}`;
    document.getElementById('objects-page-first').disabled = pageIndex === 0;
    document.getElementById('objects-page-prev').disabled  = pageIndex === 0;
    document.getElementById('objects-page-next').disabled  = pageIndex >= pageCount - 1;
    document.getElementById('objects-page-last').disabled  = pageIndex >= pageCount - 1;

    // Toggle collapse on group-header clicks. Delegated per-render
    // since the tbody HTML is rebuilt. Buttons inside the header
    // (Open Site / Share / Delete) intercept the click first and
    // dispatch through to the existing per-row handlers — they pass
    // the manifest id so all the site-aware logic in
    // viewObjectById / shareObjectById / deleteObjectById applies.
    objectsList.querySelectorAll('tr.obj-group-header').forEach(tr => {
      tr.addEventListener('click', (ev) => {
        const t = ev.target;
        if (t instanceof HTMLElement && t.dataset && t.dataset.action) {
          ev.stopPropagation();
          const id = t.dataset.id;
          if (!id) return;
          switch (t.dataset.action) {
            case 'open-site':   window.viewObjectById(id);   return;
            case 'share-site':  window.shareObjectById(id);  return;
            case 'delete-site': window.deleteObjectById(id); return;
          }
          return;
        }
        const uuid = tr.dataset.uuid;
        if (!uuid) return;
        if (collapsedUuids.has(uuid)) collapsedUuids.delete(uuid);
        else collapsedUuids.add(uuid);
        render();
      });
    });

    // Selection survives paging and applies to every non-deleted object
    // across the whole dataset — not just the current page.
    function eligibleIds() {
      return allObjects.filter(o => !o.deleted).map(o => o.id);
    }

    function updateSelectionCount() {
      document.getElementById('zip-selected-count').textContent = `${selectedIds.size} selected`;
      document.getElementById('btn-download-zip').disabled = selectedIds.size === 0;
      const addSelBtn = document.getElementById('btn-add-selected-to-site');
      if (addSelBtn) addSelBtn.disabled = selectedIds.size === 0;
      const selectAll = document.getElementById('obj-select-all');
      if (selectAll) {
        const eligible = eligibleIds();
        // Reflect whole-dataset state, not just visible rows.
        selectAll.checked = eligible.length > 0 && eligible.every(id => selectedIds.has(id));
        selectAll.indeterminate = !selectAll.checked && eligible.some(id => selectedIds.has(id));
      }
    }

    document.getElementById('obj-select-all').addEventListener('change', (e) => {
      const check = e.target.checked;
      if (check) {
        for (const id of eligibleIds()) selectedIds.add(id);
      } else {
        selectedIds.clear();
      }
      // Also update visible row checkboxes so the user sees the change
      // immediately on the current page.
      objectsList.querySelectorAll('.obj-select').forEach(cb => { cb.checked = check; });
      updateSelectionCount();
    });
    objectsList.querySelectorAll('.obj-select').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(cb.dataset.id);
        else selectedIds.delete(cb.dataset.id);
        updateSelectionCount();
      });
    });
    updateSelectionCount();
  } // end render()

  // Pager navigation.
  document.getElementById('objects-page-first').addEventListener('click', () => { pageIndex = 0; render(); });
  document.getElementById('objects-page-prev').addEventListener('click',  () => { pageIndex--; render(); });
  document.getElementById('objects-page-next').addEventListener('click',  () => { pageIndex++; render(); });
  document.getElementById('objects-page-last').addEventListener('click',  () => {
    pageIndex = Math.max(0, Math.ceil(buildDisplayList(sortedObjects()).length / pageSize) - 1);
    render();
  });
  pageSizeEl.addEventListener('change', () => {
    pageSize = parseInt(pageSizeEl.value, 10) || 50;
    pageIndex = 0;
    render();
  });

  // Bulk: add every selected object to the Site Builder draft. Objects
  // that already have filename metadata are added directly; those
  // without are skipped with a warning so the user can set a filename
  // via the per-row "Add to site" prompt instead.
  document.addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'btn-add-selected-to-site') return;
    if (selectedIds.size === 0) return;
    const byId = new Map(allObjects.map(o => [o.id, o]));
    let added = 0;
    let skippedNoName = 0;
    let skippedMissing = 0;
    for (const id of selectedIds) {
      const obj = byId.get(id);
      if (!obj) { skippedMissing++; continue; }
      // Preserve the full path but drop the source site's UUID prefix
      // before it lands in a new manifest.
      const clean = obj.filename
        ? sanitizeDisplayFilename(stripUploadUuid(obj.filename)).trim()
        : '';
      if (!clean) { skippedNoName++; continue; }
      addToDraft({ id, filename: clean, size: obj.size || 0 });
      added++;
    }
    const parts = [`✓ Added ${added} to site builder`];
    if (skippedNoName) {
      parts.push(
        `${skippedNoName} skipped (no filename metadata — use the row's "Add to site" button to name them)`,
      );
    }
    if (skippedMissing) parts.push(`${skippedMissing} not found`);
    const cls = added > 0 ? 'pass' : 'fail';
    panelStatus().innerHTML = `<span class="${cls}">${parts.join(' · ')}</span>`;
  });

  // Open ZIP builder with the currently-selected objects (across all pages).
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'btn-download-zip') {
      if (selectedIds.size === 0) return;
      const section = document.getElementById('zip-builder-section');
      const tbody = document.getElementById('zip-builder-tbody');
      document.getElementById('zip-builder-status').textContent = '';
      tbody.innerHTML = '';
      const byId = new Map(allObjects.map(o => [o.id, o]));
      for (const id of selectedIds) {
        const obj = byId.get(id);
        if (!obj) continue;
        const sizeBytes = obj.size || 0;
        const sizeCell = sizeBytes ? formatSize(sizeBytes) : 'N/A';
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #222';
        tr.dataset.objectId = id;
        tr.dataset.size = sizeBytes;
        // Default the editable filename to a disk-safe form of the
        // object's metadata filename (slashes flattened to `_`) — the
        // ZIP writes each entry as a flat leaf. Fall back to an id
        // stub when there's no metadata or it sanitizes to empty.
        const defaultName =
          (obj.filename && sanitizeFilename(obj.filename)) || `${id.substring(0, 16)}.sia`;
        tr.innerHTML = `
          <td style="padding:0.5rem;">
            <input type="text" class="zip-filename" value="${_esc(defaultName)}"
              style="width:100%; font-size:0.85rem; background:#1a1a1a; color:#e0e0e0; border:1px solid #333; border-radius:4px; padding:0.3rem 0.5rem;" />
            <div style="font-size:0.7rem; color:#555; margin-top:0.2rem; font-family:monospace;">${id}</div>
            <div class="zip-row-progress" style="margin-top:0.3rem; display:none;">
              <progress class="zip-row-bar" max="100" value="0" style="width:100%; height:4px;"></progress>
              <span class="zip-row-status" style="font-size:0.7rem; color:#888;"></span>
            </div>
          </td>
          <td style="padding:0.5rem; color:#888; font-size:0.85rem; white-space:nowrap;">${sizeCell}</td>
          <td style="padding:0.5rem;">
            <button onclick="this.closest('tr').remove()" style="padding:0.15rem 0.4rem; font-size:0.8rem; background:#dc2626; color:white; border:none; border-radius:3px; cursor:pointer;" title="Remove from ZIP">✕</button>
          </td>
        `;
        tbody.appendChild(tr);
      }
      if (tbody.children.length === 0) return;
      section.style.display = '';
      section.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Manual refresh button.
  document.getElementById('btn-list-objects').addEventListener('click', () => {
    selectedIds.clear();
    loadAllObjects();
  });

  // Auto-load when the panel becomes visible (first open or tab switch back).
  const panel = document.getElementById('panel-objects');
  const isVisible = () => panel && panel.style.display !== 'none';
  let loadedOnce = false;
  function autoLoadIfVisible() {
    if (!isVisible()) return;
    if (loadedOnce) return;
    loadedOnce = true;
    loadAllObjects();
  }
  autoLoadIfVisible();
  new MutationObserver(autoLoadIfVisible).observe(panel, { attributes: true, attributeFilter: ['style'] });

  // Cancel ZIP builder
  let zipCancelled = false;
  document.getElementById('zip-builder-cancel').addEventListener('click', () => {
    zipCancelled = true;
    document.getElementById('zip-builder-section').style.display = 'none';
    document.getElementById('zip-builder-status').textContent = '';
  });

  // Download ZIP — streams each selected object into a single archive.
  document.getElementById('zip-builder-download').addEventListener('click', async () => {
    const tbody = document.getElementById('zip-builder-tbody');
    const rows = [...tbody.querySelectorAll('tr')];
    if (rows.length === 0) return;

    // Close-tab cancel: flips the existing zipCancelled flag so the
    // inter-file loop breaks out the next time it checks.
    const zipAbort = new AbortController();
    const zipUntrack = trackAbort(getActiveTab(), zipAbort);
    zipAbort.signal.addEventListener('abort', () => { zipCancelled = true; });

    await withKeepAlive(async () => {
      const entries = rows.map(tr => ({
        id: tr.dataset.objectId,
        filename: tr.querySelector('.zip-filename').value.trim() || `${tr.dataset.objectId.substring(0, 16)}.sia`,
      }));

      const zipStatus = document.getElementById('zip-builder-status');
      const btn = document.getElementById('zip-builder-download');
      zipCancelled = false;
      btn.disabled = true;

      const totalSize = rows.reduce((sum, tr) => sum + (parseInt(tr.dataset.size, 10) || 0), 0);

      let writable = null;
      let memBuf = null;
      try {
        if (window.showSaveFilePicker) {
          const handle = await window.showSaveFilePicker({
            suggestedName: `sia-objects-${new Date().toISOString().slice(0, 10)}.zip`,
            types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
          });
          writable = await handle.createWritable();
        } else {
          if (totalSize > 500 * 1024 * 1024) {
            const proceed = confirm(
              `Your browser doesn't support streaming to disk.\n\n` +
              `Total size: ${formatSize(totalSize)}\n\n` +
              `The ZIP will be built in memory. Files over ~500 MB total may cause instability.\n\n` +
              `For large ZIPs, use Chrome or Edge.\n\nContinue?`
            );
            if (!proceed) { btn.disabled = false; return; }
          }
          memBuf = [];
        }

        // ZIP writer — writes headers/descriptors to the stream
        const zip = new ZipWriter(async (chunk) => {
          if (writable) {
            await writable.write(chunk);
          } else {
            memBuf.push(new Uint8Array(chunk));
          }
        });

        // Dummy elements for parallelDownloadToDisk
        const dummyProgress = { set max(_) {}, set value(_) {}, style: { display: '' } };

        for (let i = 0; i < entries.length; i++) {
          const { id, filename } = entries[i];
          const row = rows[i];
          const progressDiv = row.querySelector('.zip-row-progress');
          const progressBar = row.querySelector('.zip-row-bar');
          const progressStatus = row.querySelector('.zip-row-status');
          progressDiv.style.display = '';
          progressStatus.textContent = 'Downloading...';
          progressBar.value = 0;

          if (zipCancelled) break;
          if (!zipCancelled) zipStatus.textContent = `${i + 1}/${entries.length}: ${filename}`;

          // Write ZIP local file header
          await zip.startEntry(filename);

          // Create a CRC-tracking writable proxy. Data flows:
          // SDK → proxy.write() → CRC update → real writable/memBuf
          const crcProxy = {
            write: async (data) => {
              const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
              zip.updateCrc(bytes);
              zip.advanceOffset(bytes.length);
              if (writable) {
                await writable.write(bytes);
              } else {
                memBuf.push(new Uint8Array(bytes));
              }
            },
            close: async () => {},
            abort: async () => {},
          };

          // Stream the object through the CRC proxy
          await parallelDownloadToDisk(
            id, crcProxy, zipStatus, dummyProgress,
            (bytes) => {
              const pct = zip._current.size > 0 ? Math.min(100, Math.round((zip._current.size / (parseInt(row.dataset.size, 10) || 1)) * 100)) : 0;
              progressBar.value = pct;
              progressStatus.textContent = `${formatSize(zip._current.size)}`;
            },
          );

          // Write ZIP data descriptor
          await zip.endEntry();
          progressBar.value = 100;
          progressStatus.innerHTML = '<span class="pass">✓ Done</span>';
        }

        // Write central directory and end record
        if (zipCancelled) {
          if (writable) try { await writable.abort(); } catch (_) {}
          zipStatus.textContent = 'Cancelled.';
          btn.disabled = false;
          return;
        }

        await zip.finish();

        if (writable) {
          await writable.close();
        } else {
          const blob = new Blob(memBuf, { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `sia-objects-${new Date().toISOString().slice(0, 10)}.zip`;
          a.click();
          URL.revokeObjectURL(url);
        }

        zipStatus.innerHTML = `<span class="pass">✓ Downloaded ${entries.length} files as ZIP</span>`;
      } catch (e) {
        if (e.name === 'AbortError') {
          zipStatus.textContent = '';
        } else {
          zipStatus.innerHTML = `<span class="fail">ZIP failed: ${_esc(e.message || String(e))}</span>`;
        }
        if (writable) try { await writable.abort(); } catch (_) {}
      }
    }); // withKeepAlive
    zipUntrack();
    document.getElementById('zip-builder-download').disabled = false;
  });

  // Site Builder — "Add to site" / "Remove from site" buttons route
  // through these. The draft lives in `site-builder.js` and persists
  // across reloads via localStorage. Re-rendering is driven by the
  // `onDraftChange` subscription below so the button label flips
  // immediately after a mutation from any source.
  window.addToSiteBuilder = (objectId) => {
    const match = allObjects.find((o) => o.id === objectId);
    if (!match) return;
    // Manifest paths preserve slashes (`assets/app.js`), so sanitize
    // with the display-level helper which only strips invisibles.
    // `stripUploadUuid` drops the per-upload UUID prefix our folder-
    // upload flow embeds — the new site shouldn't inherit the source
    // site's UUID. Only prompt when there's no metadata to default from.
    let clean = match.filename
      ? sanitizeDisplayFilename(stripUploadUuid(match.filename)).trim()
      : '';
    if (!clean) {
      const raw = prompt('This object has no filename. Enter one for the site:', `${objectId.substring(0, 8)}.bin`);
      if (raw === null) return;
      clean = sanitizeDisplayFilename(raw).trim();
      if (!clean) {
        panelStatus().innerHTML = '<span class="fail">Name is empty or invalid.</span>';
        return;
      }
    }
    addToDraft({ id: objectId, filename: clean, size: match.size || 0 });
    panelStatus().innerHTML = `<span class="pass">✓ Added ${_esc(clean)} to site builder</span>`;
  };

  window.removeFromSiteBuilder = (objectId) => {
    removeFromDraft(objectId);
    panelStatus().innerHTML = '<span style="color:#888;">Removed from site builder</span>';
  };

  // Flip row button labels when the draft changes from anywhere
  // (e.g. the Upload Site page's remove/clear actions).
  onDraftChange(() => {
    if (allObjects.length > 0) render();
  });

  // Rename (or initially set) an object's filename metadata. The SDK
  // doesn't expose a rename primitive — we overwrite the metadata
  // envelope and push it via `updateObjectMetadata`. Input is
  // sanitized the same way read-path filenames are, so rename can't
  // introduce values the rest of the UI won't accept.
  window.renameObjectById = async (objectId) => {
    const status = panelStatus();
    const match = allObjects.find(o => o.id === objectId);
    const current = match && match.filename ? match.filename : '';
    const raw = prompt('Enter a name for this object:', current);
    if (raw === null) return; // user cancelled
    const clean = sanitizeFilename(raw);
    if (!clean) {
      status.innerHTML = '<span class="fail">Name is empty or invalid after sanitizing.</span>';
      return;
    }
    if (clean === current) return; // no-op

    try {
      status.textContent = 'Renaming…';
      const sdk = await connectSdk(status);
      if (!sdk) return;
      const obj = await sdk.object(objectId);
      obj.updateMetadata(encodeMetadata({ filename: clean }));
      await sdk.updateObjectMetadata(obj);
      if (match) match.filename = clean;
      render();
      status.innerHTML = `<span class="pass">✓ Renamed to ${_esc(clean)}</span>`;
    } catch (e) {
      status.innerHTML = `<span class="fail">Failed to rename: ${_esc(e.message || String(e))}</span>`;
    }
  };

  // Helper function to download an object by ID
  window.downloadObjectById = async (objectId) => {
    const dlUrl = document.getElementById('dl-url');
    const dlFilename = document.getElementById('dl-filename');

    // Fall back to an object-id stub when there's no metadata. When
    // metadata is present we flatten any slashes into `_` since the
    // save-as dialog accepts a single filename, not a path.
    const match = allObjects.find(o => o.id === objectId);
    const suggested =
      (match && match.filename && sanitizeFilename(match.filename)) ||
      `download_${objectId.substring(0, 8)}`;
    dlUrl.value = objectId;
    dlFilename.value = suggested;

    // Switch to download tab and trigger download
    openOrActivateInternalTab('download');
    setTimeout(() => {
      document.getElementById('btn-download').click();
    }, 100);
  };

  // Helper function to copy to clipboard. Shows a brief confirmation
  // in the bottom-right status bar instead of an alert().
  window.copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(textarea);
    }
    const status = panelStatus();
    const shown = text.length > 20 ? text.slice(0, 8) + '…' + text.slice(-8) : text;
    status.innerHTML = `<span class="pass">✓ Copied ${_esc(shown)}</span>`;
  };

  // Helper function to delete an object. Manifest objects prompt the
  // user to choose between deleting just the manifest (leaves all
  // referenced file objects pinned) or the manifest plus every object
  // the manifest's share URLs point at.
  window.deleteObjectById = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);
    const match = allObjects.find(o => o.id === objectId);
    if (match && match.isManifest) {
      promptDeleteManifest(objectId, shortId);
      return;
    }

    if (!confirm(`⚠️ Are you sure you want to delete object ${shortId}?\n\nThis action cannot be undone!`)) {
      return;
    }

    const status = panelStatus();
    const originalStatus = status.innerHTML;

    try {
      status.innerHTML = '<span style="color:#f59e0b;">⏳ Deleting...</span>';

      const sdk = await connectSdk(status);
      if (!sdk) return;

      await sdk.deleteObject(objectId);

      status.innerHTML = '<span class="pass">✓ Object deleted successfully!</span>';

      // Refresh the list after a short delay
      setTimeout(() => {
        document.getElementById('btn-list-objects').click();
      }, 500);
    } catch (e) {
      status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message || String(e))}</span>`;

      // Restore original status after showing error for 3 seconds
      setTimeout(() => {
        status.innerHTML = originalStatus;
      }, 3000);
    }
  };

  // Pick up the 64-hex object ID embedded in a manifest entry's sia://
  // share URL (`sia://<host>/objects/<hex>/shared?...`). Returns null if
  // the URL doesn't look like a share URL we can resolve locally.
  function objectIdFromShareUrl(shareUrl) {
    if (typeof shareUrl !== 'string') return null;
    const m = shareUrl.match(/\/objects\/([0-9a-fA-F]{64})(?:\/|$)/);
    return m ? m[1].toLowerCase() : null;
  }

  // Modal-based confirmation for manifest delete: either drop just the
  // manifest JSON (leaving referenced objects pinned and individually
  // reachable) or drop the manifest plus every object its share URLs
  // name. Files that belong to other indexers (cross-indexer manifests)
  // are reported but skipped — deleteObject on the primary indexer
  // can't touch them.
  function promptDeleteManifest(objectId, shortId) {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8); display: flex; align-items: center;
      justify-content: center; z-index: 1000;
    `;
    modal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:520px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#f87171;">⚠️ Delete Sia site</h3>
        <p style="color:#888; margin-bottom:1rem;">Manifest: ${shortId}</p>
        <p style="color:#ccc; font-size:0.9rem; margin-bottom:1.25rem;">
          This object is a sia-site manifest. Choose how much to delete — both
          options are permanent.
        </p>
        <div style="display:flex; flex-direction:column; gap:0.5rem; margin-bottom:1rem;">
          <button id="del-manifest-only" style="padding:0.75rem; background:#f59e0b; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.95rem; text-align:left;">
            <div style="font-weight:600;">Delete manifest only</div>
            <div style="font-size:0.8rem; opacity:0.85; margin-top:0.15rem;">Removes the site entry. Referenced files stay pinned and reachable via their individual share URLs.</div>
          </button>
          <button id="del-manifest-all" style="padding:0.75rem; background:#dc2626; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.95rem; text-align:left;">
            <div style="font-weight:600;">Delete manifest + all referenced files</div>
            <div style="font-size:0.8rem; opacity:0.85; margin-top:0.15rem;">Removes the site and every file object it names. Any existing share URLs for those files will break.</div>
          </button>
        </div>
        <button id="del-manifest-cancel" style="width:100%; padding:0.6rem; background:#333; color:#ccc; border:none; border-radius:4px; cursor:pointer; font-size:0.9rem;">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#del-manifest-cancel').addEventListener('click', close);
    modal.querySelector('#del-manifest-only').addEventListener('click', async () => {
      close();
      await deleteObjects([objectId], 'manifest');
    });
    modal.querySelector('#del-manifest-all').addEventListener('click', async () => {
      close();
      const status = panelStatus();
      try {
        status.innerHTML = '<span style="color:#f59e0b;">⏳ Reading manifest…</span>';
        const sdk = await connectSdk(status);
        if (!sdk) return;
        const manifestObj = await sdk.object(objectId);
        const bytes = await readStreamFully(sdk.download(manifestObj));
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        const files = (parsed && parsed.files && typeof parsed.files === 'object') ? parsed.files : null;
        if (!files) {
          status.innerHTML = '<span class="fail">Manifest has no files map — deleting manifest only.</span>';
          await sdk.deleteObject(objectId);
          setTimeout(() => document.getElementById('btn-list-objects').click(), 500);
          return;
        }
        const ids = [];
        const skipped = [];
        for (const [path, shareUrl] of Object.entries(files)) {
          const id = objectIdFromShareUrl(shareUrl);
          if (id) ids.push(id);
          else skipped.push(path);
        }
        if (ids.length === 0) {
          status.innerHTML = '<span class="fail">No resolvable file object IDs in manifest — deleting manifest only.</span>';
          await sdk.deleteObject(objectId);
          setTimeout(() => document.getElementById('btn-list-objects').click(), 500);
          return;
        }
        if (!confirm(
          `Delete the manifest plus ${ids.length} referenced file${ids.length === 1 ? '' : 's'}?` +
          (skipped.length ? `\n\n${skipped.length} entr${skipped.length === 1 ? 'y was' : 'ies were'} skipped (unrecognized share URL).` : '')
        )) return;
        ids.push(objectId);
        await deleteObjects(ids, 'manifest + files');
      } catch (e) {
        status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message || String(e))}</span>`;
      }
    });
  }

  // Sequential delete with a status-bar progress counter. Sequential
  // (rather than parallel) so the indexer doesn't get hit with 50
  // concurrent DELETEs from one tab, and so a single failing object
  // doesn't mask the rest of the run behind a rejected Promise.all.
  async function deleteObjects(ids, label) {
    const status = panelStatus();
    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;
      let done = 0;
      let failed = 0;
      for (const id of ids) {
        done++;
        status.innerHTML = `<span style="color:#f59e0b;">⏳ Deleting ${done} / ${ids.length}…</span>`;
        try {
          await sdk.deleteObject(id);
        } catch (e) {
          failed++;
          console.warn('deleteObject failed for', id, e);
        }
      }
      if (failed === 0) {
        status.innerHTML = `<span class="pass">✓ Deleted ${ids.length} object${ids.length === 1 ? '' : 's'} (${label}).</span>`;
      } else {
        status.innerHTML = `<span class="fail">Deleted ${ids.length - failed} / ${ids.length}; ${failed} failed.</span>`;
      }
      setTimeout(() => document.getElementById('btn-list-objects').click(), 500);
    } catch (e) {
      status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message || String(e))}</span>`;
    }
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


  // Helper function to view an object in the browser. Loads the
  // bare object id so the browser auto-detects type and renders
  // accordingly (JSON for a manifest, video for a video, etc.).
  // Site-level rendering (`sia-site://`) is now handled by the
  // group-header "Open Site" button instead of routing manifest
  // rows through here.
  window.viewObjectById = async (objectId) => {
    const tab = getOrCreateActiveBrowserTab();
    tab.url = objectId;
    tab.label = objectId.length > 30 ? objectId.substring(0, 30) + '...' : objectId;
    setLastBrowserUrl(objectId);
    renderTabBar();

    const addressBar = document.getElementById('chrome-address-bar');
    addressBar.value = objectId;
    loadContentWithAutoDetect();
  };

  // Helper function to share an object (generate share URL). For
  // sia-site manifests the resulting `sia://` URL is rewritten to
  // `sia-site://` so pasting it into the browser opens the site rather
  // than downloading the raw manifest bytes.
  window.shareObjectById = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);
    const match = allObjects.find(o => o.id === objectId);
    const isManifest = !!(match && match.isManifest);

    // Show configuration modal first
    const configModal = document.createElement('div');
    configModal.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8); display: flex; align-items: center;
      justify-content: center; z-index: 1000;
    `;

    const titleLabel = isManifest ? '🌐 Share Sia site' : '🔗 Generate Share URL';
    // Sites typically want longer validity than a casual file share —
    // default to 1 year so the link doesn't expire mid-tour.
    const defaultNum = isManifest ? '1' : '24';
    const hoursSel = isManifest ? '' : '';
    const daysSel = isManifest ? '' : ' selected';
    const yearsSel = isManifest ? ' selected' : '';

    configModal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:500px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#10b981;">${titleLabel}</h3>
        <p style="color:#888; margin-bottom:1.5rem;">Object: ${shortId}</p>

        <div style="margin-bottom:1.5rem;">
          <div style="color:#e0e0e0; margin-bottom:0.5rem; font-size:0.9rem;">Expires in</div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input id="share-modal-duration" type="number" value="${defaultNum}" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
            <select id="share-modal-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
              <option value="3600000"${hoursSel}>hours</option>
              <option value="86400000"${daysSel}>days</option>
              <option value="604800000">weeks</option>
              <option value="31536000000"${yearsSel}>years</option>
            </select>
          </div>
        </div>

        <div style="display:flex; gap:0.5rem;">
          <button id="btn-generate-share" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">
            Generate Link
          </button>
          <button id="btn-cancel-share" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(configModal);

    // Close on background click
    configModal.addEventListener('click', (e) => {
      if (e.target === configModal) configModal.remove();
    });

    // Cancel button
    configModal.querySelector('#btn-cancel-share').addEventListener('click', () => {
      configModal.remove();
    });

    // Generate button
    configModal.querySelector('#btn-generate-share').addEventListener('click', async () => {
      const generateBtn = configModal.querySelector('#btn-generate-share');
      const originalText = generateBtn.textContent;
      generateBtn.textContent = '⏳ Generating...';
      generateBtn.disabled = true;

      try {
        const duration = parseFloat(configModal.querySelector('#share-modal-duration').value);
        const unit = parseInt(configModal.querySelector('#share-modal-unit', 10).value);

        const status = panelStatus();
        const sdk = await connectSdk(status);
        if (!sdk) {
          configModal.remove();
          return;
        }

        // Fetch the object
        const obj = await sdk.object(objectId);

        // Generate share URL with configured duration. Manifests get
        // rewritten to the `sia-site://` scheme so the link opens the
        // site loader directly.
        const validUntilMs = Date.now() + (duration * unit);
        const rawShareUrl = sdk.shareObject(obj, new Date(validUntilMs));
        const shareUrl = isManifest
          ? 'sia-site://' + rawShareUrl.replace(/^sia:\/\//, '')
          : rawShareUrl;

        // Calculate human-readable duration
        let durationText = `${duration} ${configModal.querySelector('#share-modal-unit').selectedOptions[0].text}`;

        // Remove config modal
        configModal.remove();

        // Show result modal
        const resultModal = document.createElement('div');
        resultModal.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.8); display: flex; align-items: center;
          justify-content: center; z-index: 1000;
        `;

        resultModal.innerHTML = `
          <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
            <h3 style="margin:0 0 1rem 0; color:#10b981;">${isManifest ? '🌐 Sia Site URL' : '🔗 Share URL Generated'}</h3>
            <p style="color:#888; margin-bottom:1rem;">${isManifest ? 'Site' : 'Object'}: ${shortId}</p>
            <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem; word-break:break-all; font-family:monospace; font-size:0.9rem;">
              ${shareUrl}
            </div>
            <p style="color:#888; font-size:0.9rem; margin-bottom:1rem;">
              ⏰ Valid for ${durationText}<br>
              🔒 Includes encryption key in URL
            </p>
            <div style="display:flex; gap:0.5rem;">
              <button onclick="navigator.clipboard.writeText('${shareUrl.replace(/'/g, "\\'")}').then(() => alert('Share URL copied!')); this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                📋 Copy URL
              </button>
              <button onclick="this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                Close
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(resultModal);

        // Close on background click
        resultModal.addEventListener('click', (e) => {
          if (e.target === resultModal) resultModal.remove();
        });
      } catch (e) {
        configModal.remove();
        alert(`Share failed: ${e.message}`);
      }
    });
  };

  // Helper function to show object info/details
  window.showObjectInfo = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

    try {
      // Show loading state
      const button = event.target;
      const originalText = button.textContent;
      button.textContent = '⏳';
      button.disabled = true;

      const status = panelStatus();
      const sdk = await connectSdk(status);
      if (!sdk) {
        button.textContent = originalText;
        button.disabled = false;
        return;
      }

      // Fetch the object
      const obj = await sdk.object(objectId);
      const size = obj.size();

      // Calculate number of slabs (each slab holds 10 shards * 4MB = ~40MB of data)
      const SLAB_DATA_SIZE = 10 * 4 * 1024 * 1024; // 40 MB
      const numSlabs = size === 0 ? 0 : Math.ceil(size / SLAB_DATA_SIZE);

      // Show info in a modal
      const modal = document.createElement('div');
      modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
      `;

      modal.innerHTML = `
        <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
          <h3 style="margin:0 0 1rem 0; color:#8b5cf6;">ℹ️ Object Details</h3>
          <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem;">
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Object ID:</div>
              <div style="font-family:monospace; font-size:0.9rem; word-break:break-all;">${_esc(objectId)}</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Size:</div>
              <div>${formatSize(size)} (${size.toLocaleString()} bytes)</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Slabs:</div>
              <div>${numSlabs} slab${numSlabs !== 1 ? 's' : ''} (~${(numSlabs * 40).toFixed(0)} MB encoded)</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
              <div>10 data shards + 20 parity shards (need any 10 of 30)</div>
            </div>
            <div>
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
              <div>10 data + 20 parity (${formatSize(size)} pinned)</div>
            </div>
          </div>
          <button onclick="this.parentElement.parentElement.remove();" style="width:100%; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
            Close
          </button>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on background click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });

      // Restore button
      button.textContent = originalText;
      button.disabled = false;
    } catch (e) {
      alert(`Failed to load info: ${e.message}`);
      event.target.textContent = 'Info';
      event.target.disabled = false;
    }
  };

}
