// The object listing, as one component both pages drive.
//
// My Objects and Shared With Me show the same thing — a list of objects with a
// name, a size, a date and a per-row menu — and differ only in what may be
// done to a row. They were two implementations of that, and the shared page's
// was the poorer one: no sorting, no grouping, no selection, no paging, and a
// flat list of 496 rows for a key that holds 496 objects.
//
// So the table lives here and the pages supply what is actually theirs: the
// menu items, the bulk actions, and any extra column. Nothing in this file
// knows about app keys, sharing keys, or which SDK fetched the rows.
//
// A row is a plain object, never a wasm handle:
//
//   { id, filename, displayName, size, ms, updatedAt,
//     uploadUuid, siteName, isManifest, deleted }
//
// Only `id` is required. `ms` is the sort key for the updated column; the
// caller supplies it because only the caller knows where the timestamp came
// from.

import { _esc, formatSize } from './utils.js';

/**
 * Deterministic hue from an upload UUID. The first 12 hex chars already give
 * plenty of entropy for a nice spread around the wheel, and using the same
 * bytes every render means the same upload session always shows the same
 * colour on both pages.
 */
export function uuidToColor(uuid) {
  let h = 0;
  for (let i = 0; i < 12 && i < uuid.length; i++) {
    h = ((h << 5) - h + uuid.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

/**
 * The kind of thing a row is, for its type tile.
 *
 * Keyed off the filename because that is all the list has — the indexer stores
 * no content type. A wrong guess costs a misleading icon and nothing else, so
 * the extension list is deliberately short rather than exhaustive.
 */
export function objectKind(obj) {
  if (obj.isManifest) return { kind: 'site', glyph: '&#9635;' };
  const name = (obj.filename || '').toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'].includes(ext)) return { kind: 'video', glyph: '&#9654;' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext)) return { kind: 'image', glyph: '&#9707;' };
  return { kind: 'text', glyph: '&#9647;' };
}

/**
 * The one menu element every row on every page shares, created on first use.
 *
 * Anchored to the button that opened it and closed by anything that would make
 * its position wrong: a click elsewhere, Escape, a scroll, a resize. It lives
 * on `body` and is `position: fixed`, so the table's own overflow cannot clip
 * it — which is what happens to a menu rendered inside a scrolling cell.
 */
let rowMenuEl = null;
let rowMenuOwner = null;

export function closeRowMenu() {
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

/**
 * Open the row menu under `button`, built from `items`.
 *
 * `[label, handler, icon, danger?]`, with null for a separator — the same
 * shape both pages build, so neither has to know how the menu is rendered or
 * positioned.
 */
export function openRowMenu(button, items) {
  const menu = ensureRowMenu();
  if (rowMenuOwner === button && !menu.hidden) {
    closeRowMenu();
    return;
  }
  closeRowMenu();
  menu.textContent = '';
  for (const item of items) {
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

/**
 * What a row's name is, for matching purposes.
 *
 * `displayName` is what the row shows, which for a grouped object is the path
 * with its batch prefix stripped and for a site manifest is the site's name.
 * Both are searched, along with the raw filename, so a query matches whatever
 * the reader can see as well as what is actually stored — a batch prefix is
 * invisible in the list, and someone who pastes a full path should still find
 * the file.
 */
function searchableName(o) {
  return `${o.displayName || ''}\n${o.filename || ''}\n${o.siteName || ''}`.toLowerCase();
}

/** Resolve an element from an id, a node, or a getter. Missing is allowed. */
function el(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return document.getElementById(ref);
  if (typeof ref === 'function') return ref();
  return ref;
}

/**
 * Build a listing bound to a set of elements.
 *
 * Everything page-specific arrives through `cfg`; everything about laying a
 * list out on screen stays in here. The caller owns the rows and hands them
 * over with `setRows`, which is also what makes this testable — the sorting,
 * grouping and paging below are pure functions of the rows and the view state.
 *
 * cfg:
 *   els            element ids/nodes/getters; only `list` is required
 *   menuItems(row) the row's kebab menu, in openRowMenu's shape
 *   extraColumn    { header, cell(row) } for a page-specific column
 *   groupActions(group)  buttons on a group header row
 *   onGroupAction(action, id)
 *   filter(row)    an extra predicate, applied before search
 *   isEligible(row)  whether a row may be selected (default: not deleted)
 *   onSelectionChange(ids)
 *   summaryText(ctx) -> { text, title } for the header line
 *   emptyHtml      what to show when there is nothing to list
 */
export function createObjectTable(cfg) {
  const els = cfg.els || {};
  const rows = [];
  const selectedIds = new Set();   // survives paging and re-sorting
  const collapsedUuids = new Set();
  const sortState = { column: cfg.defaultSort || 'updated', asc: cfg.defaultAsc === true };
  let pageSize = cfg.pageSize || 50;
  let pageIndex = 0;
  let searchQuery = '';

  const isEligible = cfg.isEligible || ((o) => !o.deleted);

  function groupNames() {
    const names = new Map();
    for (const o of rows) {
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
      case 'created':  return obj.createdMs || 0;
      case 'status':   return obj.deleted ? 'deleted' : 'active';
      case 'updated':
      default:         return obj.ms;
    }
  }

  /**
   * The rows the list is currently showing.
   *
   * One chokepoint for every filter, because everything downstream derives
   * from it: sorting, grouping, paging, the header totals and what Select all
   * selects. Filtering anywhere later would leave those disagreeing with each
   * other, which is how a count ends up describing rows nobody can see.
   *
   * The search runs over the whole dataset rather than the page on screen. A
   * list long enough to want searching is one where the thing being looked for
   * is, by definition, usually not on the current page.
   */
  function listed() {
    const base = cfg.filter ? rows.filter(cfg.filter) : rows;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((o) => searchableName(o).includes(q));
  }

  // Group-aware sort: keeps rows sharing an upload UUID contiguous no matter
  // which column is sorted. Each group's position is decided by its best sort
  // value (min for ascending, max for descending), then rows within a group
  // sort by the same column. Rows without a UUID use their own sortValue for
  // the group key, so they interleave with groups on the same criteria.
  function sorted() {
    const visible = listed();
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

    const out = visible.slice();
    out.sort((a, b) => {
      const agv = a.uploadUuid ? groupKey.get(a.uploadUuid) : sortValue(a);
      const bgv = b.uploadUuid ? groupKey.get(b.uploadUuid) : sortValue(b);
      if (agv < bgv) return sortState.asc ? -1 : 1;
      if (agv > bgv) return sortState.asc ? 1 : -1;
      // Same group sort-value — separate distinct groups by their UUID (or,
      // for ungrouped rows, by id) so different groups never interleave.
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
    return out;
  }

  // Flatten to [{kind:'header',…}, {kind:'row', obj}]. Rows inside a collapsed
  // group are omitted; only the header remains. Aggregates reflect the full
  // group regardless of which rows land on the current page, so the header is
  // self-contained.
  function displayList(sortedRows) {
    const names = groupNames();
    const aggregates = new Map();
    for (const o of rows) {
      if (!o.uploadUuid) continue;
      const agg = aggregates.get(o.uploadUuid) || { count: 0, totalSize: 0, manifestId: null };
      agg.count++;
      agg.totalSize += (Number(o.size) || 0);
      if (o.isManifest && !o.deleted && !agg.manifestId) agg.manifestId = o.id;
      aggregates.set(o.uploadUuid, agg);
    }
    const out = [];
    let emittedHeaderFor = null;
    for (const o of sortedRows) {
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

  function eligibleIds() {
    return listed().filter(isEligible).map((o) => o.id);
  }

  function updateSelectionCount() {
    const n = selectedIds.size;
    const countEl = el(els.selectionCount);
    if (countEl) countEl.textContent = `${n} selected`;
    const bar = el(els.selectionBar);
    // Hidden when nothing is selected: these act on a selection, and a
    // permanent row of disabled buttons is just noise.
    if (bar) bar.style.display = n > 0 ? 'flex' : 'none';
    for (const id of (cfg.selectionButtons || [])) {
      const b = el(id);
      if (b) b.disabled = n === 0;
    }
    const selectAll = el(els.selectAll);
    if (selectAll) {
      const eligible = eligibleIds();
      // Reflect whole-dataset state, not just visible rows.
      selectAll.checked = eligible.length > 0 && eligible.every((id) => selectedIds.has(id));
      selectAll.indeterminate = !selectAll.checked && eligible.some((id) => selectedIds.has(id));
    }
    if (cfg.onSelectionChange) cfg.onSelectionChange([...selectedIds]);
  }

  // Bound once on the container, which survives every render. Binding inside
  // render() adds a listener per render, and because a second call for the
  // same button toggles the menu, an even number of them opens it and closes
  // it again inside the same click — the button looks dead.
  let delegated = false;
  function delegate(listEl) {
    if (delegated) return;
    delegated = true;
    listEl.addEventListener('click', (e) => {
      const button = e.target.closest('.obj-kebab');
      if (!button) return;
      e.stopPropagation();
      const row = rows.find((o) => o.id === button.dataset.menuFor);
      if (row) openRowMenu(button, cfg.menuItems(row));
    });
    // Clicking the name opens the row, which is what a row's title should do.
    listEl.addEventListener('click', (e) => {
      const name = e.target.closest('.obj-name-text');
      if (!name || !cfg.onRowActivate) return;
      const tr = name.closest('tr');
      const id = tr && tr.querySelector('.obj-kebab')?.dataset.menuFor;
      // No kebab means an ineligible row: nothing to open.
      if (!id) return;
      const row = rows.find((o) => o.id === id);
      if (row) cfg.onRowActivate(row);
    });
  }

  function render() {
    const listEl = el(els.list);
    if (!listEl) return;
    delegate(listEl);

    const all = displayList(sorted());
    const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
    if (pageIndex >= pageCount) pageIndex = pageCount - 1;
    if (pageIndex < 0) pageIndex = 0;
    const start = pageIndex * pageSize;
    const pageItems = all.slice(start, start + pageSize);

    // If the page starts mid-group, walk back to find that group's header so
    // the continuation is labelled. Without this, page 2 of a long site would
    // show bare indented rows with no context.
    if (pageItems.length > 0 && pageItems[0].kind === 'row' && pageItems[0].obj.uploadUuid) {
      const firstUuid = pageItems[0].obj.uploadUuid;
      for (let i = start - 1; i >= 0; i--) {
        const item = all[i];
        if (item.kind === 'header' && item.uuid === firstUuid) {
          pageItems.unshift({ ...item, continuation: true });
          break;
        }
      }
    }

    if (all.length === 0 && cfg.emptyHtml) {
      closeRowMenu();
      listEl.innerHTML = cfg.emptyHtml;
      const pager = el(els.pager);
      if (pager) pager.style.display = 'none';
      updateSummary(0, 0);
      return;
    }

    const extra = cfg.extraColumn;
    // check, name, size, created, updated, [extra], actions
    const colCount = 6 + (extra ? 1 : 0);

    // The object ID has no column: it was a truncated hash in the widest
    // position on the row and the name is what identifies an object to a
    // person. It stays one click away, in the row menu.
    let html = `
        <table class="obj-table${extra ? ' has-extra' : ''}">
          <thead>
            <tr>
              <th class="obj-col-check"><input type="checkbox" class="obj-select-all-box" title="Select all" /></th>
              <th data-sort="filename">Name<span class="sort-arrow"></span></th>
              <th class="obj-col-size" data-sort="size">Size<span class="sort-arrow"></span></th>
              <th class="obj-col-created" data-sort="created">Created<span class="sort-arrow"></span></th>
              <th class="obj-col-updated" data-sort="updated">Updated<span class="sort-arrow"></span></th>
              ${extra ? `<th class="obj-col-keys">${extra.header}</th>` : ''}
              <th class="obj-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
      `;

    for (const item of pageItems) {
      if (item.kind === 'header') {
        const color = uuidToColor(item.uuid);
        const caret = item.collapsed ? '▶' : '▼';
        // The site's name when it has one; the full UUID is the fallback for
        // an upload that was never published as a site. Truncating it only
        // made the group look like an opaque hex blob, so show all of it.
        const groupLabel = item.name || item.uuid;
        const labelIsName = Boolean(item.name);
        const suffix = item.continuation ? ' (continued)' : '';
        const sizeLabel = item.totalSize ? formatSize(item.totalSize) : '';
        // Group-level buttons. The data-action attribute pairs with a
        // delegated handler that stops propagation so clicking a button does
        // not toggle collapse on the row.
        const actions = (cfg.groupActions ? cfg.groupActions(item) : []) || [];
        const actionsHtml = actions.length ? `
          <span style="float:right;">
            ${actions.map((a, i) => `<button data-action="${a.action}" data-id="${a.id}"`
              + ` style="padding:0.25rem 0.5rem; font-size:0.85rem; background:${a.color}; color:white;`
              + `${i ? ' margin-left:0.25rem;' : ''}" title="${_esc(a.title || '')}">${_esc(a.label)}</button>`).join('')}
          </span>` : '';
        html += `
          <tr class="obj-group-header" data-uuid="${item.uuid}" style="cursor:pointer; background:#0f0f0f; border-bottom:1px solid #222; border-left:4px solid ${color};">
            <td colspan="${colCount}" style="padding:0.45rem 0.75rem;">
              <span style="display:inline-block; width:1rem; color:#9ca3af; font-size:0.75rem;">${caret}</span>
              <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${color}; margin-right:0.5rem; vertical-align:middle;"></span>
              <span title="Upload ${_esc(item.uuid)}" style="${labelIsName
                ? 'color:#e5e7eb; font-size:0.85rem; font-weight:500;'
                : 'font-family:var(--font-mono); color:#cbd5e1; font-size:0.8rem;'}">${_esc(groupLabel)}</span>
              <span style="color:#6b7280; font-size:0.8rem; margin-left:0.75rem;">${item.count} file${item.count === 1 ? '' : 's'}${sizeLabel ? ' · ' + sizeLabel : ''}${suffix}</span>
              ${actionsHtml}
            </td>
          </tr>
        `;
        continue;
      }
      const obj = item.obj;
      const sizeBytes = obj.size;
      const size = sizeBytes ? formatSize(sizeBytes) : 'N/A';
      const date = obj.updatedAt ? new Date(obj.updatedAt).toLocaleString() : '—';
      // A deleted row has no object left to read a creation time from, and a
      // listing made before the field existed has none either, so this stays
      // blank rather than borrowing the updated time and calling it something
      // it is not.
      const created = obj.createdAt ? new Date(obj.createdAt).toLocaleString() : '—';
      // Marked on the row rather than in a column of its own: all but one
      // value would have read "Active", and deleted rows are hidden unless
      // asked for.
      const deletedChip = obj.deleted ? '<span class="obj-deleted-chip">Deleted</span>' : '';
      const checked = selectedIds.has(obj.id) ? 'checked' : '';
      const fnameFull = obj.filename || '';
      const fnameDisplay = obj.displayName || fnameFull;
      const indent = obj.uploadUuid ? 'padding-left:2rem;' : '';
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
      // Ungrouped rows keep a transparent left-border so horizontal alignment
      // stays stable. Grouped rows reuse the group's colour as a thinner
      // accent, echoing the header bar.
      const rowAccent = obj.uploadUuid
        ? `border-left:4px solid ${uuidToColor(obj.uploadUuid)};`
        : 'border-left:4px solid transparent;';
      html += `
          <tr data-upload-uuid="${obj.uploadUuid || ''}" style="${rowAccent}">
            <td>${isEligible(obj) ? `<input type="checkbox" class="obj-select" data-id="${obj.id}" data-size="${sizeBytes}" ${checked}/>` : ''}</td>
            ${nameCell}
            <td class="obj-num">${size}</td>
            <td class="obj-num obj-dim">${created}</td>
            <td class="obj-num obj-dim">${date}</td>
            ${extra ? `<td>${extra.cell(obj)}</td>` : ''}
            <td class="obj-col-actions">
              ${isEligible(obj) ? `
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
    listEl.innerHTML = html;

    for (const th of listEl.querySelectorAll('th[data-sort]')) {
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

    // Toggle collapse on group-header clicks. Delegated per render since the
    // tbody HTML is rebuilt.
    listEl.querySelectorAll('tr.obj-group-header').forEach((tr) => {
      tr.addEventListener('click', (ev) => {
        const t = ev.target;
        if (t instanceof HTMLElement && t.dataset && t.dataset.action) {
          ev.stopPropagation();
          if (t.dataset.id && cfg.onGroupAction) cfg.onGroupAction(t.dataset.action, t.dataset.id);
          return;
        }
        const uuid = tr.dataset.uuid;
        if (!uuid) return;
        if (collapsedUuids.has(uuid)) collapsedUuids.delete(uuid);
        else collapsedUuids.add(uuid);
        render();
      });
    });

    // Selection survives paging and applies to every eligible row across the
    // whole dataset — but scoped to what the filter is showing. Select all
    // reaching rows the reader cannot see, and a bulk action then acting on
    // them, is the kind of surprise that costs data.
    const selectAll = listEl.querySelector('.obj-select-all-box');
    if (selectAll) {
      els.selectAll = selectAll;
      selectAll.addEventListener('change', (e) => {
        const check = e.target.checked;
        if (check) for (const id of eligibleIds()) selectedIds.add(id);
        else selectedIds.clear();
        listEl.querySelectorAll('.obj-select').forEach((cb) => { cb.checked = check; });
        updateSelectionCount();
      });
    }
    listEl.querySelectorAll('.obj-select').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(cb.dataset.id);
        else selectedIds.delete(cb.dataset.id);
        updateSelectionCount();
      });
    });

    renderPager(all.length, pageCount, start);
    updateSummary(listed().length, listed().reduce((n, o) => n + (Number(o.size) || 0), 0));
    updateSelectionCount();
  }

  function renderPager(total, pageCount, start) {
    const pager = el(els.pager);
    if (pager) pager.style.display = 'flex';
    const info = el(els.pageInfo);
    if (info) info.textContent = `${start + 1}–${Math.min(start + pageSize, total)} of ${total}`;
    const num = el(els.pageNum);
    if (num) num.textContent = String(pageIndex + 1);
    const first = el(els.pageFirst); if (first) first.disabled = pageIndex === 0;
    const prev = el(els.pagePrev);   if (prev)  prev.disabled  = pageIndex === 0;
    const next = el(els.pageNext);   if (next)  next.disabled  = pageIndex >= pageCount - 1;
    const last = el(els.pageLast);   if (last)  last.disabled  = pageIndex >= pageCount - 1;
  }

  function updateSummary(shown, totalBytes) {
    const summary = el(els.summary);
    if (!summary) return;
    const ctx = { shown, totalBytes, total: rows.length, searchQuery, rows };
    const out = cfg.summaryText
      ? cfg.summaryText(ctx)
      : {
        text: `${shown} object${shown === 1 ? '' : 's'}`
          + (totalBytes > 0 ? ` · ${formatSize(totalBytes)}` : ''),
        title: '',
      };
    summary.textContent = out.text;
    summary.title = out.title || '';
  }

  // Pager and filter controls live outside the rendered table, so they are
  // wired once rather than on every render.
  function wire() {
    const bind = (ref, fn) => { const n = el(ref); if (n) n.addEventListener('click', fn); };
    bind(els.pageFirst, () => { pageIndex = 0; render(); });
    bind(els.pagePrev,  () => { pageIndex--; render(); });
    bind(els.pageNext,  () => { pageIndex++; render(); });
    bind(els.pageLast,  () => {
      pageIndex = Math.max(0, Math.ceil(displayList(sorted()).length / pageSize) - 1);
      render();
    });
    const sizeEl = el(els.pageSize);
    if (sizeEl) {
      // Take the control's own value rather than assuming it agrees with the
      // default: whatever the markup selects, or a value the browser restored
      // on reload, is what the reader can see.
      const initial = parseInt(sizeEl.value, 10);
      if (initial > 0) pageSize = initial;
      sizeEl.addEventListener('change', () => {
        pageSize = parseInt(sizeEl.value, 10) || 50;
        pageIndex = 0;
        render();
      });
    }
    const searchEl = el(els.search);
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        searchQuery = searchEl.value || '';
        // Back to page one: the row count changes underneath, so the current
        // index can point past the end of the new, shorter list.
        pageIndex = 0;
        render();
      });
    }
  }
  wire();

  return {
    /** Replace the rows. Selection is kept only for ids that still exist. */
    setRows(next) {
      rows.length = 0;
      rows.push(...next);
      const live = new Set(rows.map((o) => o.id));
      for (const id of [...selectedIds]) if (!live.has(id)) selectedIds.delete(id);
    },
    render,
    /** Set the name filter without going through the input element. */
    setSearch(q) { searchQuery = q || ''; pageIndex = 0; },
    rows,
    selectedIds,
    /** The selection as rows, in the list's own order, for bulk actions. */
    selectedRows() { return rows.filter((o) => selectedIds.has(o.id)); },
    clearSelection() { selectedIds.clear(); updateSelectionCount(); },
    setPageIndex(i) { pageIndex = i; },
    collapsedUuids,
    sortState,
    // Exposed for tests and for callers that need the same view the table has.
    _listed: listed,
    _sorted: sorted,
    _displayList: displayList,
  };
}
