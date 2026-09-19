import { _esc, formatSize, _dbgWarn } from './utils.js';
import { connectSdk } from './config.js';
import { ZipWriter } from './vendor/zip-stream.js';
import { parallelDownloadToDisk } from './download.js';
import { withKeepAlive } from './keep-alive.js';
import { loadContentWithAutoDetect } from './browser.js';
import {
  openOrActivateInternalTab, getOrCreateActiveBrowserTab, makeOpenable,
  setLastBrowserUrl, renderTabBar, getActiveTab, trackAbort,
  tabStatusProxy,
} from './tabs.js';
import {
  filenameForDisplay, sanitizeFilename, sanitizeDisplayFilename, encodeMetadata,
  stripUploadUuid, extractUploadUuid, siteNameForDisplay,
} from './object-metadata.js';
import { addToDraft, removeFromDraft, isInDraft, onDraftChange } from './site-builder.js';
import { shareObjectToKey, pickSharingKey, showShareLinkModal } from './sharing-keys.js';
import { migrateObjectPrompt } from './object-migrate.js';
import { objectHealth, healthSummary, usableHostKeys } from './object-health.js';

// Status proxy for the currently-active tab. Writes land in the
// bottom-right status bar while the tab is selected and stay scoped
// to that tab otherwise — no leaking between My Objects and other tabs.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

// Filename-based heuristic for "this object is a site manifest".
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
/**
 * The kind of thing a row is, for its type tile.
 *
 * Keyed off the filename because that is all the list has — the indexer stores
 * no content type. A wrong guess costs a misleading icon and nothing else, so
 * the extension list is deliberately short rather than exhaustive.
 */
function objectKind(obj) {
  if (obj.isManifest) return { kind: 'site', glyph: '&#9635;' };
  const name = (obj.filename || '').toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'].includes(ext)) return { kind: 'video', glyph: '&#9654;' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext)) return { kind: 'image', glyph: '&#9707;' };
  return { kind: 'text', glyph: '&#9647;' };
}

/**
 * Every per-object action, as one menu.
 *
 * The row used to carry nine buttons. They pushed Size and Updated off the
 * side, and no two rows could be compared without reading a wall of coloured
 * labels first. The set is unchanged — only where it lives.
 *
 * `[label, handler, icon, danger?]`, with null for a separator. Handlers are
 * the same `window.*` functions the buttons called, so behaviour is identical.
 */
function rowMenuItems(obj) {
  const id = obj.id;
  const items = [
    ['View', () => window.viewObjectById(id), '&#128065;'],
  ];
  if (obj.isManifest) {
    items.push(['Open Site', () => window.viewObjectById(id), '&#8599;']);
  }
  items.push(
    ['Publish', () => window.publishObjectById(id), '&#127760;'],
    null,
    // Named for what it does: it attaches this object to a key, which is why
    // it reads like the "Add to Site" beneath it. Managing the keys themselves
    // is the Sharing Keys page.
    ['Add to Sharing Key', () => window.shareObjectToSharingKey(id), '&#128273;'],
    ['Rename', () => window.renameObjectById(id), '&#9998;'],
    // Only for an object still carrying an upload batch's prefix. For anything
    // else there is no group to leave, and an item that does nothing is worse
    // than an absent one.
    ...(extractUploadUuid(obj.filename || '')
      ? [['Remove from Group', () => window.ungroupObjectById(id), '&#9986;']]
      : []),
    isInDraft(id)
      ? ['Remove from Site', () => window.removeFromSiteBuilder(id), '&#10003;']
      : ['Add to Site', () => window.addToSiteBuilder(id), '&#128193;'],
    ['Migrate', () => window.migrateObjectById(id), '&#9729;'],
    ['Download', () => window.downloadObjectById(id), '&#8595;'],
    null,
    ['Details', () => window.showObjectInfo(id), '&#8505;'],
    ['Copy object ID', () => window.copyToClipboard(id), '&#9112;'],
    null,
    ['Delete', () => window.deleteObjectById(id), '&#128465;', true],
  );
  return items;
}

/**
 * The one menu element every row shares, created on first use.
 *
 * Anchored to the button that opened it and closed by anything that would make
 * its position wrong: a click elsewhere, Escape, a scroll, a resize. It lives
 * on `body` and is `position: fixed`, so the table's own overflow cannot clip
 * it — which is what happens to a menu rendered inside a scrolling cell.
 */
let rowMenuEl = null;
let rowMenuOwner = null;

function closeRowMenu() {
  if (rowMenuEl) rowMenuEl.hidden = true;
  if (rowMenuOwner) rowMenuOwner.setAttribute('aria-expanded', 'false');
  rowMenuOwner = null;
}

function ensureRowMenu() {
  if (rowMenuEl) return rowMenuEl;
  rowMenuEl = document.createElement('div');
  rowMenuEl.id = 'obj-menu';
  rowMenuEl.className = 'obj-menu';
  rowMenuEl.setAttribute('role', 'menu');
  rowMenuEl.hidden = true;
  document.body.appendChild(rowMenuEl);
  document.addEventListener('click', (e) => {
    if (rowMenuEl.hidden) return;
    if (rowMenuEl.contains(e.target) || (rowMenuOwner && rowMenuOwner.contains(e.target))) return;
    closeRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !rowMenuEl.hidden) closeRowMenu();
  });
  // Capture, so a scroll inside the table is caught as well as one on the page.
  window.addEventListener('scroll', closeRowMenu, true);
  window.addEventListener('resize', closeRowMenu);
  return rowMenuEl;
}

function openRowMenu(button, obj) {
  const menu = ensureRowMenu();
  if (rowMenuOwner === button && !menu.hidden) {
    closeRowMenu();
    return;
  }
  closeRowMenu();
  menu.textContent = '';
  for (const item of rowMenuItems(obj)) {
    if (!item) {
      const sep = document.createElement('div');
      sep.className = 'obj-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const [label, run, icon, danger] = item;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'obj-menu-item' + (danger ? ' obj-menu-item--danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<span class="obj-menu-icon" aria-hidden="true">${icon}</span>`;
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', () => {
      closeRowMenu();
      run();
    });
    menu.appendChild(btn);
  }

  menu.hidden = false;
  rowMenuOwner = button;
  button.setAttribute('aria-expanded', 'true');

  // Right-aligned under the button, nudged back inside the viewport when it
  // would otherwise hang off the bottom or the right edge.
  const r = button.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
  const below = r.bottom + 4;
  const top = below + m.height > window.innerHeight - 8
    ? Math.max(8, r.top - m.height - 4)
    : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const first = menu.querySelector('.obj-menu-item');
  if (first) first.focus();
}

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

  /**
 * Sharing-key descriptions, indexed by the object they are attached to:
 * objectId -> [sanitised description, …]. Populated lazily after the object
 * list renders, because building it costs a request per key.
 */
const sharedViaByObject = new Map();

/**
 * Prepare an untrusted string for display in a row.
 *
 * A sharing-key description is free text this app did not write and does not
 * control, so it is treated as hostile in three separate ways:
 *
 *   1. Control, zero-width and BiDi-override characters are stripped.
 *      `sanitizeDisplayFilename` exists for exactly this; without it a
 *      right-to-left override can reorder the visible text so a description
 *      impersonates a filename or another object's label.
 *   2. It is escaped with `_esc` before reaching innerHTML. Every row here is
 *      assembled by string concatenation, so an unescaped `<img onerror=…>`
 *      would execute.
 *   3. It is truncated for display, with the full value only in a `title`, so
 *      a long description cannot push the rest of the row out of view.
 *
 * Returns pre-escaped strings, safe as element text or inside a
 * double-quoted attribute — never in a JS or URL context.
 */
function untrustedLabel(raw, max = 40) {
  const clean = sanitizeDisplayFilename(String(raw == null ? '' : raw)).trim();
  if (!clean) return null;
  const short = clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  return { text: _esc(short), title: _esc(clean) };
}

/**
 * Index which sharing keys each object is attached to.
 *
 * Best effort: it costs a `sharedObjects` walk per key, so failures are
 * swallowed rather than breaking the object list, and it runs after the first
 * render so the list is never held up waiting for it.
 */
async function indexSharingKeyLabels(sdk) {
  sharedViaByObject.clear();
  const PAGE = 100;
  const keys = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await sdk.sharingKeys(offset, PAGE);
      keys.push(...page);
      if (page.length < PAGE) break;
    }
  } catch (_) {
    return; // no keys, or this indexer does not support them
  }

  for (const record of keys) {
    const label = untrustedLabel(record.description);
    if (!label) continue;
    try {
      for (let offset = 0; ; offset += PAGE) {
        const page = await sdk.sharedObjects(record.key, offset, PAGE);
        for (const obj of page) {
          const id = obj.id();
          const list = sharedViaByObject.get(id) || [];
          // Two keys can carry the same description; showing it twice on one
          // row is noise, not information.
          if (!list.some((l) => l.title === label.title)) list.push(label);
          sharedViaByObject.set(id, list);
        }
        if (page.length < PAGE) break;
      }
    } catch (_) { /* skip this key */ }
  }
}

/** Paginate through objectEvents until the SDK runs dry. */
  /**
   * Whether this panel is the one on screen.
   *
   * An unset `display` counts as hidden: panels start with no inline style and
   * are only ever revealed by having one set, so treating "" as visible made
   * this fire during module initialisation, before there was an active tab.
   */
  function objectsPanelVisible() {
    const el = document.getElementById('panel-objects');
    return !!(el && el.style.display && el.style.display !== 'none');
  }

  // Switching indexer profile changes whose objects these are, so the list has
  // to be rebuilt rather than left showing the previous account's.
  window.addEventListener('profile-updated', () => {
    // The selection holds object IDs belonging to the account being left.
    // Carrying it across would let a bulk action target IDs the new indexer
    // has never heard of.
    selectedIds.clear();
    // Only fetch now if the panel is on screen; otherwise the activation
    // listener picks it up on the way back in, rather than paging the whole
    // object list for a panel nobody is looking at.
    if (objectsPanelVisible()) loadAllObjects();
  });

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
            // A site's manifest is the object its `sialo://` address points
            // at, so this row is the site as far as anyone handing the link
            // out is concerned. "manifest.json" says nothing about which site
            // that is, so the name recorded at publish time is shown instead
            // when there is one. Older sites have none and keep the filename.
            const siteName = (isManifest && ev.object)
              ? siteNameForDisplay(ev.object.metadata())
              : '';
            latest.set(ev.id, {
              id: ev.id,
              updatedAt: ev.updatedAt,
              deleted: ev.deleted,
              size: ev.object ? Number(ev.object.size()) : 0,
              filename,
              // The row keeps the file's own name. A site's name belongs to the
              // upload group, and the group header carries it — printing it on
              // the manifest row as well says the same thing twice and hides
              // what the file is actually called.
              //
              // Ungrouped is the exception: with no header there is nothing
              // else showing the name, so the row is the only place it can go.
              displayName: uploadUuid ? displayName : (siteName || displayName),
              siteName,
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
      // Not awaited: the list is already usable, and indexing costs a request
      // per sharing key. Redraw once it lands.
      indexSharingKeyLabels(sdk).then(() => {
        if (sharedViaByObject.size) render();
      }).catch(() => {});
    } catch (e) {
      document.getElementById('objects-list').innerHTML =
        `<div style="padding:1rem; color:#f87171; text-align:center;">Failed to load objects: ${_esc(e.message || String(e))}</div>`;
      status.innerHTML = `<span class="fail">Failed to load objects: ${_esc(e.message || String(e))}</span>`;
    } finally {
      loadInFlight = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  /**
   * Upload UUID → the site name recorded on that group's manifest.
   *
   * A group is an upload session, and its UUID is meaningless to anyone. When
   * the session published a site, the manifest carries the name the user gave
   * it, which is what the group should be called — in the header and in the
   * sort, so the list orders by what is actually on screen.
   *
   * A live manifest wins over a deleted one, matching how the group's Open
   * Site / Publish actions pick theirs.
   */
  function groupNames() {
    const names = new Map();
    for (const o of allObjects) {
      if (!o.uploadUuid || !o.isManifest || !o.siteName) continue;
      if (!o.deleted) {
        names.set(o.uploadUuid, o.siteName);
      } else if (!names.has(o.uploadUuid)) {
        names.set(o.uploadUuid, o.siteName);
      }
    }
    return names;
  }

  function sortValue(obj) {
    switch (sortState.column) {
      case 'id':       return obj.id;
      // `displayName` is the UUID prefix stripped, and the site name for a
      // manifest. Sorting on the raw filename sorted on the UUID prefix
      // instead, which is invisible and arbitrary. Case-folded so `apple`
      // and `Apple` land together rather than in separate blocks.
      case 'filename': return (obj.displayName || obj.filename || '').toLowerCase();
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
  /**
   * Whether deleted objects appear in the list.
   *
   * Hidden by default: the indexer keeps an event per change, so a deleted
   * object stays in the log forever and an account that has churned through
   * uploads ends up with a list mostly made of things that no longer exist.
   * They remain reachable behind the toggle rather than being dropped, because
   * "did that actually delete?" is a real question to be able to answer.
   */
  const SHOW_DELETED_KEY = 'objects-show-deleted';
  let showDeleted = (() => {
    try {
      return localStorage.getItem(SHOW_DELETED_KEY) === '1';
    } catch (_) {
      return false;
    }
  })();

  /** The objects the list should show, before sorting or grouping. */
  function listedObjects() {
    return showDeleted ? allObjects : allObjects.filter((o) => !o.deleted);
  }

  function sortedObjects() {
    // The display set, which excludes deleted objects unless the toggle is on.
    const visible = listedObjects();
    const groupKey = new Map(); // uuid → best sort value across its members
    for (const o of visible) {
      if (!o.uploadUuid) continue;
      const v = sortValue(o);
      if (!groupKey.has(o.uploadUuid)) {
        groupKey.set(o.uploadUuid, v);
        continue;
      }
      const prev = groupKey.get(o.uploadUuid);
      if (sortState.asc ? v < prev : v > prev) groupKey.set(o.uploadUuid, v);
    }

    if (sortState.column === 'filename') {
      // Otherwise a group would take its position from whichever member
      // happened to sort first, which is not what its header says.
      for (const [uuid, name] of groupNames()) {
        if (groupKey.has(uuid)) groupKey.set(uuid, name.toLowerCase());
      }
    }

    const sorted = visible.slice();
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
    // Publish / Delete" actions for site uploads. A non-deleted
    // manifest takes priority over a deleted one if there are stale
    // entries lying around.
    const names = groupNames();
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
            name: names.get(o.uploadUuid) || '',
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
    // The object ID no longer has a column: it was a truncated hash in the
    // widest position on the row and the name is what identifies an object to
    // a person. It stays one click away, as "Copy object ID" in the row menu.
    let html = `
        <table class="obj-table">
          <thead>
            <tr>
              <th class="obj-col-check"><input type="checkbox" id="obj-select-all" title="Select all" /></th>
              <th data-sort="filename">Name<span class="sort-arrow"></span></th>
              <th class="obj-col-size" data-sort="size">Size<span class="sort-arrow"></span></th>
              <th class="obj-col-updated" data-sort="updated">Updated<span class="sort-arrow"></span></th>
              <th class="obj-col-keys">Sharing Keys</th>
              <th class="obj-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
      `;

    for (const item of pageItems) {
      if (item.kind === 'header') {
        const color = uuidToColor(item.uuid);
        const caret = item.collapsed ? '▶' : '▼';
        const shortUuid = item.uuid.substring(0, 8);
        // The site's name when it has one; the UUID is the fallback for an
        // upload that was never published as a site. Either way the UUID stays
        // reachable in the tooltip, since it is what groups these rows.
        const groupLabel = item.name || shortUuid;
        const labelIsName = Boolean(item.name);
        const suffix = item.continuation ? ' (continued)' : '';
        const sizeLabel = item.totalSize ? formatSize(item.totalSize) : '';
        // Site-level action buttons. Only render when the group has a
        // manifest (i.e. it was uploaded as a site). The data-action
        // attribute pairs with a delegated handler that stops propagation
        // so clicking a button doesn't toggle collapse on the row.
        const siteActions = item.manifestId ? `
          <span style="float:right;">
            <button data-action="open-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open as a site">Open Site</button>
            <button data-action="publish-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#10b981; color:white; margin-left:0.25rem;" title="Publish this site as an expiring URL">Publish</button>
            <button data-action="delete-site" data-id="${item.manifestId}" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#dc2626; color:white; margin-left:0.25rem;" title="Delete this site (or site + all referenced files)">Delete</button>
          </span>` : '';
        html += `
          <tr class="obj-group-header" data-uuid="${item.uuid}" style="cursor:pointer; background:#0f0f0f; border-bottom:1px solid #222; border-left:4px solid ${color};">
            <td colspan="6" style="padding:0.45rem 0.75rem;">
              <span style="display:inline-block; width:1rem; color:#9ca3af; font-size:0.75rem;">${caret}</span>
              <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${color}; margin-right:0.5rem; vertical-align:middle;"></span>
              <span title="Upload ${_esc(item.uuid)}" style="${labelIsName
                ? 'color:#e5e7eb; font-size:0.85rem; font-weight:500;'
                : 'font-family:var(--font-mono); color:#cbd5e1; font-size:0.8rem;'}">${_esc(groupLabel)}</span>
              <span style="color:#6b7280; font-size:0.8rem; margin-left:0.75rem;">${item.count} file${item.count === 1 ? '' : 's'}${sizeLabel ? ' · ' + sizeLabel : ''}${suffix}</span>
              ${siteActions}
            </td>
          </tr>
        `;
        continue;
      }
      const obj = item.obj;
      const sizeBytes = obj.size;
      const size = sizeBytes ? formatSize(sizeBytes) : 'N/A';
      const date = new Date(obj.updatedAt).toLocaleString();
      // Marked on the row rather than in a column of its own: all but one
      // value would have read "Active", and deleted rows are hidden unless
      // asked for.
      const deletedChip = obj.deleted ? '<span class="obj-deleted-chip">Deleted</span>' : '';
      const checked = selectedIds.has(obj.id) ? 'checked' : '';
      // Filename cell. Objects with no metadata show an em-dash;
      // upload-UUID-prefixed filenames have their prefix stripped for
      // display (full value stays in the hover title). Members of a
      // group get an extra left-pad so the visible path indents under
      // the group header.
      const fnameFull = obj.filename || '';
      const fnameDisplay = obj.displayName || fnameFull;
      const indent = obj.uploadUuid ? 'padding-left:2rem;' : '';
      // Sharing-key descriptions this object is reachable through. Untrusted
    // text — untrustedLabel pre-escapes both the visible text and the
    // tooltip, and neither is used anywhere but as element text and a
    // double-quoted attribute.
    const shared = sharedViaByObject.get(obj.id) || [];
    const sharedChips = shared.slice(0, 2).map((l) =>
      `<span class="obj-key-chip" title="Shared via a key described: ${l.title}">${l.text}</span>`).join('')
      + (shared.length > 2
        ? `<span class="obj-key-chip obj-key-chip--more" title="${shared.length - 2} more">+${shared.length - 2}</span>`
        : '');
    const kind = objectKind(obj);
    const nameCell = `
        <td style="${indent}">
          <div class="obj-name">
            <span class="obj-icon obj-icon--${kind.kind}" aria-hidden="true">${kind.glyph}</span>
            <span class="obj-name-text${fnameFull ? '' : ' is-dim'}" title="${_esc(fnameFull || obj.id)}">${
              fnameFull ? _esc(fnameDisplay) : '—'}</span>
            ${deletedChip}
          </div>
        </td>`;
      // Ungrouped rows keep a transparent left-border so horizontal
      // alignment stays stable. Grouped rows reuse the group's color
      // as a thinner accent, echoing the header bar.
      const rowAccent = obj.uploadUuid
        ? `border-left:4px solid ${uuidToColor(obj.uploadUuid)};`
        : 'border-left:4px solid transparent;';
      html += `
          <tr data-upload-uuid="${obj.uploadUuid || ''}" style="${rowAccent}">
            <td>${!obj.deleted ? `<input type="checkbox" class="obj-select" data-id="${obj.id}" data-size="${sizeBytes}" ${checked}/>` : ''}</td>
            ${nameCell}
            <td class="obj-num">${size}</td>
            <td class="obj-num obj-dim">${date}</td>
            <td>${sharedChips || '<span class="obj-dim">—</span>'}</td>
            <td class="obj-col-actions">
              ${!obj.deleted ? `
                <button class="obj-kebab" data-menu-for="${obj.id}" aria-haspopup="menu"
                  aria-expanded="false" title="Actions">&#8942;</button>
              ` : ''}
            </td>
          </tr>
        `;
    }

    html += `
          </tbody>
        </table>
      `;

    // A menu anchored to a button that is about to be replaced has to go.
    closeRowMenu();
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
    // Name what the filter is hiding. A count that silently drops rows is
    // indistinguishable from data going missing — which is exactly how it
    // read the first time it happened.
    const hiddenDeleted = showDeleted ? 0 : allObjects.filter((o) => o.deleted).length;
    pageInfoEl.textContent = `${start + 1}–${Math.min(start + pageSize, displayList.length)} of ${displayList.length}`;
    // The totals belong in the header, beside the title they describe; the
    // footer says which slice of them is on screen. Naming what the filter
    // hides stays important: a count that silently drops rows is
    // indistinguishable from data going missing.
    const summaryEl = document.getElementById('objects-summary');
    if (summaryEl) {
      const visible = allObjects.filter((o) => showDeleted || !o.deleted);
      const shown = visible.length;
      // Summed over exactly the rows the count describes, so turning "Show
      // deleted" on moves both numbers together rather than leaving a total
      // that quietly disagrees with the count beside it.
      //
      // This is the objects' own size, not what they cost to store: an object
      // occupies whole 4 MiB sectors across a slab however small it is, so the
      // billed figure is larger and stating this one as storage would misread
      // a bill.
      const totalBytes = visible.reduce((n, o) => n + (Number(o.size) || 0), 0);
      summaryEl.textContent = `${shown} object${shown === 1 ? '' : 's'}`
        + (totalBytes > 0 ? ` · ${formatSize(totalBytes)}` : '')
        + (hiddenDeleted > 0 ? ` · ${hiddenDeleted} deleted hidden` : '');
      summaryEl.title = totalBytes > 0
        ? `${Math.round(totalBytes).toLocaleString()} bytes across ${shown} object${shown === 1 ? '' : 's'}`
        : '';
    }
    const pageNumEl = document.getElementById('objects-page-num');
    if (pageNumEl) pageNumEl.textContent = String(pageIndex + 1);
    document.getElementById('objects-page-first').disabled = pageIndex === 0;
    document.getElementById('objects-page-prev').disabled  = pageIndex === 0;
    document.getElementById('objects-page-next').disabled  = pageIndex >= pageCount - 1;
    document.getElementById('objects-page-last').disabled  = pageIndex >= pageCount - 1;

    // Toggle collapse on group-header clicks. Delegated per-render
    // since the tbody HTML is rebuilt. Buttons inside the header
    // (Open Site / Publish / Delete) intercept the click first and
    // dispatch through to the existing per-row handlers — they pass
    // the manifest id so all the site-aware logic in
    // viewObjectById / publishObjectById / deleteObjectById applies.
    objectsList.querySelectorAll('tr.obj-group-header').forEach(tr => {
      tr.addEventListener('click', (ev) => {
        const t = ev.target;
        if (t instanceof HTMLElement && t.dataset && t.dataset.action) {
          ev.stopPropagation();
          const id = t.dataset.id;
          if (!id) return;
          switch (t.dataset.action) {
            case 'open-site':   window.viewObjectById('sialo://' + id);   return;
            case 'publish-site':  window.publishObjectById(id);  return;
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
      // Hidden when nothing is selected: these act on a selection, and a
      // permanent row of disabled buttons is just noise.
      const bar = document.getElementById('obj-selection-bar');
      if (bar) bar.style.display = selectedIds.size > 0 ? 'flex' : 'none';
      for (const id of ['btn-share-selected', 'btn-copy-selected-ids', 'btn-delete-selected',
        'btn-ungroup-selected']) {
        const b = document.getElementById(id);
        if (b) b.disabled = selectedIds.size === 0;
      }
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
  const showDeletedBox = document.getElementById('objects-show-deleted');
  if (showDeletedBox) {
    showDeletedBox.checked = showDeleted;
    showDeletedBox.addEventListener('change', () => {
      showDeleted = showDeletedBox.checked;
      try { localStorage.setItem(SHOW_DELETED_KEY, showDeleted ? '1' : '0'); } catch (_) {}
      // Back to page one: the row count changes underneath, so the current
      // index can point past the end of the new, shorter list.
      pageIndex = 0;
      render();
    });
  }

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

  /**
   * The selection as objects, in the list's current order.
   *
   * `selectedIds` is a Set and survives paging, so it has no order of its own;
   * taking the order from `allObjects` means a bulk action processes things in
   * the order they are shown, which is what a progress counter has to agree
   * with to make sense.
   */
  function selectedObjects() {
    return allObjects.filter((o) => selectedIds.has(o.id));
  }

  // Take the selected objects out of their upload batch.
  //
  // The heading a batch sits under is not a site and holds nothing: the
  // folder-upload flows prefix each filename with one `crypto.randomUUID()`
  // so a batch stays together when the list is sorted, and My Objects groups
  // rows by that prefix. Dropping it from the name is all it takes to make
  // them ordinary objects, which is the whole of what the grouping was.
  //
  // The usual reason to want this is an upload that stopped part way — out of
  // space, closed tab — leaving a batch with no manifest, because the
  // manifest is written last, once every file is up. Those objects are
  // perfectly good on their own; only the shared prefix suggests otherwise.
  document.getElementById('btn-ungroup-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const status = panelStatus();
    const targets = ungroupTargets(selectedObjects());
    if (!targets.length) {
      status.innerHTML = '<span style="color:#888;">Nothing selected is in an upload batch.</span>';
      return;
    }
    if (!confirm(
      `Remove ${targets.length} object${targets.length !== 1 ? 's' : ''} from their upload batch?\n\n`
      + 'The batch prefix comes off their names and they list as ordinary objects. '
      + 'Nothing is re-uploaded, deleted, or moved, and the files themselves do not '
      + 'change. Names no longer carry the batch, so two files that shared a name '
      + 'inside it will now show the same name.',
    )) return;
    await ungroupObjects(targets);
  });

  /**
   * The selected objects that are actually in an upload batch, paired with the
   * name they would end up with. Anything already ungrouped is dropped rather
   * than written back unchanged.
   */
  function ungroupTargets(objs) {
    return objs
      .map((o) => ({ o, stripped: stripUploadUuid(o.filename || '') }))
      .filter(({ o, stripped }) => stripped && stripped !== o.filename);
  }

  /**
   * Rewrite each object's filename metadata without its batch prefix.
   *
   * Sequential, and a failure is counted rather than thrown, so one object the
   * indexer refuses does not hide the fact that the rest were rewritten.
   */
  async function ungroupObjects(targets) {
    const status = panelStatus();
    const sdk = await connectSdk(status);
    if (!sdk) return;
    let done = 0;
    const failed = [];
    for (const { o, stripped } of targets) {
      if (targets.length > 1) status.textContent = `Removing from batch ${done + 1} of ${targets.length}…`;
      try {
        const obj = await sdk.object(o.id);
        obj.updateMetadata(encodeMetadata({ filename: stripped, siteName: o.siteName }));
        await sdk.updateObjectMetadata(obj);
        o.filename = stripped;
        done += 1;
      } catch (e) {
        failed.push(`${stripped}: ${e.message || e}`);
      }
    }
    render();
    if (failed.length) {
      status.innerHTML = `<span style="color:#f59e0b">Removed ${done}, ${failed.length} failed: ${_esc(failed[0])}</span>`;
    } else if (done === 1) {
      status.innerHTML = `<span class="pass">\u2713 Removed from its upload batch</span>`;
    } else {
      status.innerHTML = `<span class="pass">\u2713 Removed ${done} from their upload batch</span>`;
    }
  }

  // Attach every selected object to one sharing key. The key is chosen once
  // rather than per object: picking it fifty times is the thing that makes
  // doing this one row at a time unusable.
  document.getElementById('btn-share-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const status = panelStatus();
    const sdk = await connectSdk(status);
    if (!sdk) return;
    const chosen = selectedObjects();
    const row = await pickSharingKey(sdk, `${chosen.length} selected object${chosen.length === 1 ? '' : 's'}`);
    if (!row) return;
    let done = 0;
    let failed = 0;
    for (const o of chosen) {
      done++;
      status.innerHTML = `<span style="color:#f59e0b;">⏳ Attaching ${done} / ${chosen.length}…</span>`;
      try {
        await sdk.shareObject(row.key, await sdk.object(o.id));
      } catch (e) {
        failed++;
        console.warn('shareObject failed for', o.id, e);
      }
    }
    // Sequentially, and reporting failures rather than throwing on the first:
    // one object that cannot be attached must not hide that the other forty
    // nine were.
    status.innerHTML = failed === 0
      ? `<span class="pass">✓ Attached ${chosen.length} object${chosen.length === 1 ? '' : 's'} to ${_esc(row.description || 'the key')}.</span>`
      : `<span class="fail">Attached ${chosen.length - failed} / ${chosen.length}; ${failed} failed.</span>`;
    // The link is worth offering even after a partial run: what did attach is
    // reachable through it.
    if (failed < chosen.length) showShareLinkModal(row, chosen[0].id, 'Objects attached');
    indexSharingKeyLabels(sdk).catch(() => {});
  });

  document.getElementById('btn-copy-selected-ids').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const ids = selectedObjects().map((o) => o.id).join('\n');
    const status = panelStatus();
    try {
      await navigator.clipboard.writeText(ids);
      status.innerHTML = `<span class="pass">✓ Copied ${selectedIds.size} object ID${selectedIds.size === 1 ? '' : 's'}.</span>`;
    } catch (e) {
      status.innerHTML = `<span class="fail">Could not copy: ${_esc(e.message || String(e))}</span>`;
    }
  });

  document.getElementById('btn-delete-selected').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const chosen = selectedObjects();
    const sites = chosen.filter((o) => o.isManifest).length;
    // Named counts rather than "are you sure": the number is the thing worth
    // checking, and a site manifest among them deletes the site's entry point
    // while leaving its files behind, which is worth knowing before agreeing.
    let warn = `Delete ${chosen.length} object${chosen.length === 1 ? '' : 's'}? This cannot be undone.`;
    if (sites > 0) {
      warn += `\n\n${sites} of them ${sites === 1 ? 'is a site manifest' : 'are site manifests'}.`
        + ' Deleting a manifest breaks the site but leaves its files in your objects.';
    }
    if (!confirm(warn)) return;
    const ids = chosen.map((o) => o.id);
    selectedIds.clear();
    await deleteObjects(ids, `${ids.length} selected`);
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

  // Reload every time the panel comes into view, not just the first time.
  //
  // This used to latch on a `loadedOnce` flag behind a MutationObserver on the
  // panel's style attribute, so the list was fetched once and then never again
  // for the life of the page. The list describes state on another machine: an
  // upload, a delete or a publish from another tab, the CLI or another device
  // leaves no trace here, so coming back to the tab is precisely when it is
  // most likely to be wrong.
  //
  // Driven by the activation event rather than by watching the style
  // attribute, because the event says what happened while a style change only
  // implies it — and the event is dispatched once the tab is genuinely active,
  // so status messages from the load land on the right tab.
  window.addEventListener('panel-activated', (e) => {
    if (e && e.detail && e.detail.panel === 'objects') loadAllObjects();
  });

  // A tab restored from a previous session is already the visible panel before
  // this module initialises, so its activation event has come and gone.
  if (objectsPanelVisible()) loadAllObjects();

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
      // Carry the site name through. `encodeMetadata` writes exactly the
      // fields it is handed, so renaming with filename alone dropped it and
      // quietly detached the object from its site.
      obj.updateMetadata(encodeMetadata({ filename: clean, siteName: match && match.siteName }));
      await sdk.updateObjectMetadata(obj);
      if (match) match.filename = clean;
      render();
      status.innerHTML = `<span class="pass">✓ Renamed to ${_esc(clean)}</span>`;
    } catch (e) {
      status.innerHTML = `<span class="fail">Failed to rename: ${_esc(e.message || String(e))}</span>`;
    }
  };

  /**
   * Take one object out of its upload batch.
   *
   * Offered on a row only when that object still carries a batch prefix, so
   * reaching this with nothing to do means the list is stale rather than the
   * menu being wrong — say so instead of silently doing nothing.
   */
  window.ungroupObjectById = async (objectId) => {
    const match = allObjects.find((o) => o.id === objectId);
    const [target] = ungroupTargets(match ? [match] : []);
    if (!target) {
      panelStatus().innerHTML =
        '<span style="color:#888;">This object is not in an upload batch. Refresh to update the list.</span>';
      return;
    }
    const batch = extractUploadUuid(target.o.filename).slice(0, 8);
    if (!confirm(
      `Remove this object from upload batch ${batch}?\n\n`
      + `Its name becomes:\n${target.stripped}\n\n`
      + 'Nothing is re-uploaded, deleted, or moved. Only the name changes.',
    )) return;
    await ungroupObjects([target]);
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
  // the manifest's published URLs point at.
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
  // published URL (`sia://<host>/objects/<hex>/shared?...`). Returns null if
  // the URL doesn't look like a published URL we can resolve locally.
  function objectIdFromPublishUrl(publishUrl) {
    if (typeof publishUrl !== 'string') return null;
    const m = publishUrl.match(/\/objects\/([0-9a-fA-F]{64})(?:\/|$)/);
    return m ? m[1].toLowerCase() : null;
  }

  // Modal-based confirmation for manifest delete: either drop just the
  // manifest JSON (leaving referenced objects pinned and individually
  // reachable) or drop the manifest plus every object its published URLs
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
          This object is a site manifest. Choose how much to delete — both
          options are permanent.
        </p>
        <div style="display:flex; flex-direction:column; gap:0.5rem; margin-bottom:1rem;">
          <button id="del-manifest-only" style="padding:0.75rem; background:#f59e0b; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.95rem; text-align:left;">
            <div style="font-weight:600;">Delete manifest only</div>
            <div style="font-size:0.8rem; opacity:0.85; margin-top:0.15rem;">Removes the site entry. Referenced files stay pinned and reachable via their individual published URLs.</div>
          </button>
          <button id="del-manifest-all" style="padding:0.75rem; background:#dc2626; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.95rem; text-align:left;">
            <div style="font-weight:600;">Delete manifest + all referenced files</div>
            <div style="font-size:0.8rem; opacity:0.85; margin-top:0.15rem;">Removes the site and every file object it names. Any existing published URLs for those files will break.</div>
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
        for (const [path, publishUrl] of Object.entries(files)) {
          const id = objectIdFromPublishUrl(publishUrl);
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
          (skipped.length ? `\n\n${skipped.length} entr${skipped.length === 1 ? 'y was' : 'ies were'} skipped (unrecognized published URL).` : '')
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
  // Site-level rendering (`sialo://`) is now handled by the
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

  // Helper function to publish an object as an expiring URL. For
  // site manifests the resulting `sia://` URL is rewritten to
  // `sialo://` so pasting it into the browser opens the site rather
  // than downloading the raw manifest bytes.
  window.publishObjectById = async (objectId) => {
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

    const titleLabel = isManifest ? '🌐 Publish Sia site' : '🔗 Publish object';
    // Sites typically want longer validity than a casual one-off publish —
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
            <input id="publish-modal-duration" type="number" value="${defaultNum}" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
            <select id="publish-modal-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
              <option value="3600000"${hoursSel}>hours</option>
              <option value="86400000"${daysSel}>days</option>
              <option value="604800000">weeks</option>
              <option value="31536000000"${yearsSel}>years</option>
            </select>
          </div>
        </div>

        <div style="display:flex; gap:0.5rem;">
          <button id="btn-generate-publish" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">
            Generate Link
          </button>
          <button id="btn-cancel-publish" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
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
    configModal.querySelector('#btn-cancel-publish').addEventListener('click', () => {
      configModal.remove();
    });

    // Generate button
    configModal.querySelector('#btn-generate-publish').addEventListener('click', async () => {
      const generateBtn = configModal.querySelector('#btn-generate-publish');
      const originalText = generateBtn.textContent;
      generateBtn.textContent = '⏳ Generating...';
      generateBtn.disabled = true;

      try {
        const duration = parseFloat(configModal.querySelector('#publish-modal-duration').value);
        const unit = parseInt(configModal.querySelector('#publish-modal-unit', 10).value);

        const status = panelStatus();
        const sdk = await connectSdk(status);
        if (!sdk) {
          configModal.remove();
          return;
        }

        // Fetch the object
        const obj = await sdk.object(objectId);

        // Generate published URL with configured duration. Manifests get
        // rewritten to the `sialo://` scheme so the link opens the
        // site loader directly.
        const validUntilMs = Date.now() + (duration * unit);
        const rawPublishUrl = sdk.objectShareUrl(obj, new Date(validUntilMs));
        const publishUrl = isManifest
          ? 'sialo://' + rawPublishUrl.replace(/^sia:\/\//, '')
          : rawPublishUrl;

        // Calculate human-readable duration
        let durationText = `${duration} ${configModal.querySelector('#publish-modal-unit').selectedOptions[0].text}`;

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
            <h3 style="margin:0 0 1rem 0; color:#10b981;">${isManifest ? '🌐 Sia Site URL' : '🔗 Object published'}</h3>
            <p style="color:#888; margin-bottom:1rem;">${isManifest ? 'Site' : 'Object'}: ${shortId}</p>
            <div id="publish-result-url" style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem; word-break:break-all; font-family:monospace; font-size:0.9rem;">${publishUrl}</div>
            <p style="color:#888; font-size:0.9rem; margin-bottom:1rem;">
              ⏰ Valid for ${durationText}<br>
              🔒 Includes encryption key in URL
            </p>
            <div style="display:flex; gap:0.5rem;">
              <button onclick="navigator.clipboard.writeText('${publishUrl.replace(/'/g, "\\'")}').then(() => alert('Published URL copied!')); this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                📋 Copy URL
              </button>
              <button onclick="this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                Close
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(resultModal);
        // The address is the whole point of this dialog, so it opens on click.
        // `sia://` is normalised to the app's own scheme by the opener; both
        // name the same object.
        makeOpenable(resultModal.querySelector('#publish-result-url'));

        // Close on background click
        resultModal.addEventListener('click', (e) => {
          if (e.target === resultModal) resultModal.remove();
        });
      } catch (e) {
        configModal.remove();
        alert(`Publish failed: ${e.message}`);
      }
    });
  };

  // Attaches this object to a sharing key, in contrast to `publishObjectById`
  // above, which mints a published URL. The picker and link modal live in
  // sharing-keys.js so the Sharing Keys panel and this button agree.
  window.shareObjectToSharingKey = async (objectId) => {
    const status = panelStatus();
    const sdk = await connectSdk(status);
    if (!sdk) return;
    try {
      const obj = await sdk.object(objectId);
      const name = filenameForDisplay(obj.metadata()) || objectId.slice(0, 16);
      await shareObjectToKey(sdk, obj, name);
    } catch (e) {
      alert(`Could not attach to a sharing key: ${e.message || e}`);
    }
  };

  // Row menus. Bound once, on the container, which survives every render:
  // binding inside render() added one listener per render, and because a
  // second call for the same button toggles, an even number of listeners
  // opened the menu and closed it again inside the same click. The button
  // looked dead.
  document.getElementById('objects-list').addEventListener('click', (e) => {
    const button = e.target.closest('.obj-kebab');
    if (!button) return;
    e.stopPropagation();
    const obj = allObjects.find((o) => o.id === button.dataset.menuFor);
    if (obj) openRowMenu(button, obj);
  });

  // Clicking the name opens the object, which is what a row's title should do.
  document.getElementById('objects-list').addEventListener('click', (e) => {
    const name = e.target.closest('.obj-name-text');
    if (!name) return;
    const row = name.closest('tr');
    const id = row && row.querySelector('.obj-kebab')?.dataset.menuFor;
    // No kebab means a deleted row: nothing to open.
    if (id) window.viewObjectById(id);
  });

  window.migrateObjectById = async (objectId) => {
    const status = panelStatus();
    const sdk = await connectSdk(status);
    if (!sdk) return;
    try {
      const obj = await sdk.object(objectId);
      const name = filenameForDisplay(obj.metadata()) || objectId.slice(0, 16);
      const destination = await migrateObjectPrompt(sdk, obj, name);
      // The object is unchanged on this indexer either way — migration copies —
      // so there is nothing to reload here. The confirmation matters most when
      // the user sent the migration to the background and the dialog reporting
      // it is already gone.
      if (destination) {
        status.innerHTML = `<span class="pass">✓ Copied ${_esc(name)} to ${_esc(destination.name)}</span>`;
      }
    } catch (e) {
      alert(`Could not migrate: ${e.message || e}`);
    }
  };

  // Helper function to show object info/details
  /**
   * The set of host public keys this indexer currently considers usable.
   *
   * Cached because every Info click needs it and it does not change between
   * them, and dropped when the profile changes since it is per-indexer. A
   * failure here is not fatal: the modal falls back to reporting no health
   * rather than refusing to open.
   */
  let usableHostsCache = null;
  window.addEventListener('profile-updated', () => { usableHostsCache = null; });

  /** Cached per profile; the paging itself lives in object-health.js so the
   *  download pre-flight and this dialog cannot disagree about what "usable"
   *  means. */
  async function cachedUsableHostKeys(sdk) {
    if (usableHostsCache) return usableHostsCache;
    const keys = await usableHostKeys(sdk);
    if (!keys) { _dbgWarn('[objects] could not list usable hosts'); return null; }
    usableHostsCache = keys;
    return usableHostsCache;
  }


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

      // Read the real slab layout rather than dividing the size by an assumed
      // 40 MB per slab: erasure-coding parameters are per slab and can differ
      // between objects, and the last slab of any object is short.
      let slabs = [];
      try { slabs = obj.slabs() || []; } catch (e) { _dbgWarn('[objects] no slab detail:', e); }
      const usable = await cachedUsableHostKeys(sdk);
      const health = usable ? objectHealth(slabs, usable) : null;
      const summary = health ? healthSummary(health) : null;

      // Erasure-coding parameters, taken from the slabs themselves. They are
      // uniform in practice, so say so plainly and only hedge if they are not.
      const ecs = [...new Set(slabs.map((sl) => `${sl.minShards}/${(sl.sectors || []).length}`))];
      const ecLabel = ecs.length === 0 ? 'unknown'
        : ecs.length === 1
          ? (() => { const [n, t] = ecs[0].split('/'); return `${n} data + ${t - n} parity (any ${n} of ${t})`; })()
          : `varies across slabs (${ecs.join(', ')})`;

      const shardTotal = slabs.reduce((n, sl) => n + ((sl.sectors || []).length), 0);
      const shardUsable = health ? health.per.reduce((n, h) => n + h.usable, 0) : null;

      const TONE = { ok: '#4ade80', warn: '#f59e0b', bad: '#f87171', muted: '#888' };
      const encoded = (() => { try { return obj.encodedSize(); } catch (_) { return null; } })();

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
              <div>${slabs.length} slab${slabs.length !== 1 ? 's' : ''}${
                encoded ? ` · ${formatSize(encoded)} stored after erasure coding` : ''}</div>
            </div>
            <div${summary ? ' style="margin-bottom:0.75rem;"' : ''}>
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
              <div>${_esc(ecLabel)}${health ? ` · spread over ${health.hostCount} host${health.hostCount === 1 ? '' : 's'}` : ''}</div>
            </div>
            ${summary ? `
            <div style="border-top:1px solid #222; margin-top:0.25rem; padding-top:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.35rem;">Health:</div>
              <div style="color:${TONE[summary.tone]}; font-weight:600; margin-bottom:0.35rem;">
                ${_esc(summary.text)}
              </div>
              <div style="color:#bbb; font-size:0.85rem; line-height:1.5; margin-bottom:0.6rem;">
                ${_esc(summary.detail)}
              </div>
              <div style="font-size:0.8rem; color:#9aa3ad; line-height:1.6;">
                ${shardUsable} of ${shardTotal} shards are on hosts this indexer can use.
                ${health.verdict === 'healthy' ? ''
                  : `${health.unreadable ? `${health.unreadable} slab${health.unreadable === 1 ? '' : 's'} unreadable. ` : ''}`
                    + `${health.bare ? `${health.bare} at the minimum. ` : ''}`
                    + `${health.unportable ? `${health.unportable} not portable. ` : ''}`}
                ${health.worstHeadroom !== null && health.worstHeadroom >= 0
                  ? `Thinnest slab has ${health.worstHeadroom} spare shard${health.worstHeadroom === 1 ? '' : 's'}.` : ''}
              </div>
              <div style="font-size:0.78rem; color:#6b7280; margin-top:0.6rem; line-height:1.5;">
                A shard on a host this indexer cannot use is not necessarily lost — the
                host may simply have no live contract here. "Portable" means another
                indexer would accept the slab, which is what migrating requires.
                A shard on a host this indexer cannot use cannot be repointed from
                here: indexd keys a sector to one host and its pin route only fills an
                empty binding, so only the indexer's own migrator moves one, on a
                backoff measured in hours. Migrate is the exception — another indexer
                has no binding to preserve, so shards can be placed on hosts it accepts
                and pinned there. A shard counts as unusable here on exactly the terms
                that stop another indexer accepting it: this list comes from the
                indexer's own usable-hosts query, whose contract test is the same one
                the pin rule applies.
              </div>
            </div>` : `
            <div style="border-top:1px solid #222; margin-top:0.25rem; padding-top:0.75rem; color:#888; font-size:0.85rem;">
              Health could not be assessed: the indexer's host list was unavailable.
            </div>`}
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
