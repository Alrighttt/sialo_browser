// The recipient half of sharing keys: read-only access to the objects a key
// grants, paid for by whoever owns the key.
//
// A recipient holds only the key's seed. `SharedSdk` authenticates with it
// instead of an app key, so this panel works without an account on the
// indexer and cannot upload, pin, or delete.
//
// The indexer URL comes from this app's own configuration, never from the
// link. A link is an untrusted string; letting it name the server would let a
// hostile one point the SDK wherever it liked.

import { _esc, _dbg, formatSize } from './utils.js';
import { createObjectTable } from './object-table.js';
import { getUrl, getKeyHex, connectSharedSdk, listSharedSummaries, fullObject, releaseObject } from './config.js';
import { streamingDownload } from './download.js';
import {
  filenameForSave, filenameForDisplay, stripUploadUuid, extractUploadUuid,
} from './object-metadata.js';
import { parseShareFragment } from './sharing-keys.js';
import { siteUrl, parsePublishedSiteFragment, canRenderInTab } from './sia-site.js';
import { tabStatusProxy, getActiveTab, openOrActivateInternalTab } from './tabs.js';
import { pinHandle, describePinResult } from './pin.js';
import { isAccountError, showAccountPrompt } from './page-gate.js';

function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : (v || 0));

/**
 * Navigates the active browser tab to a `sialo://` address, the same way
 * typing one into the chrome bar would. Goes through the address bar rather
 * than calling the loader directly so the tab's URL, label and history all
 * end up consistent.
 */
function openSiteTab(url) {
  const bar = document.getElementById('chrome-address-bar');
  if (bar) bar.value = url;
  if (typeof window.handleChromeBarNavigation === 'function') {
    window.handleChromeBarNavigation();
  } else if (typeof window.viewObjectById === 'function') {
    window.viewObjectById(url);
  }
}

export function initSharedUI() {
  const seedEl = () => document.getElementById('sh-seed');
  const listEl = () => document.getElementById('sh-list');
  const statsEl = () => document.getElementById('sh-stats');
  const progressEl = () => document.getElementById('sh-progress');

  // Held so downloads reuse one connection rather than reconnecting per file.
  // Keyed by indexer as well as seed: changing the indexer in Settings has to
  // reconnect, or the panel keeps serving results from the previous one.
  let connected = null; // { sdk, seed, indexer }

  async function connect(seed) {
    // A sharing link never carries an indexer, and its holder is not required
    // to have an account here — so every indexer this browser knows is asked
    // in turn rather than demanding setup, or guessing one, before they can
    // open what they were sent.
    if (connected && connected.seed === seed
        && connected.indexer === (getUrl() || connected.indexer)) {
      return connected.sdk;
    }
    const { sdk, indexer } = await connectSharedSdk(seed);
    connected = { sdk, seed, indexer };
    return sdk;
  }

  // The listing is the My Objects table, driven with a recipient's actions.
  // A key holder has no account, so anything that writes to one — publish,
  // rename, migrate, delete, attaching to a key of their own — is absent
  // rather than disabled. What is left is everything a key does grant: open,
  // download, pin to an account if they have one, and read the details.
  let currentSeed = null;

  const table = createObjectTable({
    els: {
      list: 'sh-list',
      pager: 'sh-pager',
      pageInfo: 'sh-page-info',
      pageSize: 'sh-page-size',
      pageNum: 'sh-page-num',
      pageFirst: 'sh-page-first',
      pagePrev: 'sh-page-prev',
      pageNext: 'sh-page-next',
      pageLast: 'sh-page-last',
      selectionBar: 'sh-selection-bar',
      selectionCount: 'sh-selected-count',
      summary: 'sh-summary',
      search: 'sh-search',
    },
    selectionButtons: ['sh-btn-download', 'sh-btn-pin', 'sh-btn-copy-ids'],
    // Nothing here is ever deleted — a recipient sees only what the key still
    // grants — so every row can be selected.
    isEligible: () => true,
    onRowActivate: (row) => { if (row.openable) openSiteTab(siteUrl(currentSeed, row.displayName)); },
    menuItems: (row) => sharedRowMenu(row),
    emptyHtml: '<div style="padding:1rem; color:#888;">This key has no objects attached.</div>',
    // The stats line above already gives the key's object count, total size
    // and expiry, so repeating them here said the same thing twice. This says
    // only what that line cannot: what the filter is currently hiding.
    summaryText: ({ shown, totalBytes, total, searchQuery }) => (
      searchQuery.trim()
        ? {
          text: `${shown} of ${total} shown \u00b7 ${formatSize(totalBytes)}`,
          title: `${total - shown} hidden by the filter`,
        }
        : { text: '', title: '' }
    ),
  });

  /**
   * The sign-up banner is for a reader with no account of their own, which is
   * who a sharing link usually reaches. To someone who already has one it is
   * an advert for something they have, sitting under every share they open.
   */
  function refreshSignup() {
    const el = document.getElementById('sh-signup');
    if (!el) return;
    let hasAccount = false;
    try { hasAccount = !!(getUrl() && getKeyHex()); } catch (_) { /* no config to read */ }
    el.style.display = hasAccount ? 'none' : '';
  }
  refreshSignup();
  // Registering, or pasting a key into Settings, both announce themselves this
  // way, so the banner goes as soon as the account exists.
  window.addEventListener('profile-updated', refreshSignup);
  for (const id of ['cfg-url', 'cfg-key']) {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', refreshSignup);
  }

  /** The filter row only means anything once a key has listed something. */
  function showListHead(on) {
    const head = document.getElementById('sh-list-head');
    if (head) head.style.display = on ? '' : 'none';
    if (!on) {
      const search = document.getElementById('sh-search');
      if (search) search.value = '';
      table.setSearch('');
    }
  }

  /**
   * One row's actions.
   *
   * Openability is asked of `canRenderInTab`, which reads the same table that
   * decides the Content-Type the file would be served with. A private
   * extension list here is what previously left ordinary videos with no Open
   * button at all — and an absent action reads as a fault rather than a
   * statement about the format, so an unrenderable file keeps the item and
   * says why instead.
   */
  function sharedRowMenu(row) {
    const items = [];
    if (row.openable) {
      items.push(['Open', () => openSiteTab(siteUrl(currentSeed, row.displayName)), '&#128065;']);
    }
    if (row.isManifest && currentSeed) {
      items.push(['Open as a site', () => openSiteTab(siteUrl(currentSeed, '')), '&#8599;']);
    }
    items.push(
      ['Download', () => downloadRow(row), '&#8595;'],
      // Pinning is the one action that needs an account, and it is also the
      // only reason a recipient would want one: it is what survives the key
      // being revoked or its owner stopping paying.
      ['Pin to my account', () => pinRow(row), '&#128204;'],
      null,
      ['Details', () => showDetails(row), '&#8505;'],
      ['Copy object ID', () => copyText(row.id), '&#9112;'],
    );
    return items;
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
      panelStatus().innerHTML = '<span class="pass">\u2713 Copied</span>';
    }).catch(() => {
      panelStatus().innerHTML = '<span class="fail">Could not copy</span>';
    });
  }

  function showDetails(row) {
    const lines = [
      `Name: ${row.filename || '(none)'}`,
      `Object ID: ${row.id}`,
      `Size: ${formatSize(row.size)} (${row.size.toLocaleString()} bytes)`,
      row.updatedAt ? `Updated: ${new Date(row.updatedAt).toLocaleString()}` : null,
      row.createdAt ? `Created: ${new Date(row.createdAt).toLocaleString()}` : null,
    ].filter(Boolean);
    alert(lines.join('\n'));
  }

  async function downloadRow(row) {
    const status = panelStatus();
    const sdk = connected && connected.sdk;
    if (!sdk) return;
    try {
      // The listing holds a summary, which has no slabs. Fetch the real object
      // for the one file being asked for.
      const full = await fullObject(row.entry);
      try {
        const { blob } = await streamingDownload(sdk, full, status, progressEl(), `Downloading ${row.displayName}`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = row.saveName || row.displayName || row.id.slice(0, 16);
        a.click();
        URL.revokeObjectURL(a.href);
        status.innerHTML = `<span class="pass">\u2713 Saved ${_esc(row.displayName)}</span>`;
      } finally {
        if (full !== row.entry) releaseObject(full);
      }
    } catch (err) {
      status.innerHTML = `<span class="fail">Download failed: ${_esc(err.message || err)}</span>`;
    } finally {
      progressEl().style.display = 'none';
    }
  }

  async function pinRow(row) {
    const status = panelStatus();
    if (!confirm(`Pin "${row.displayName}" (${formatSize(row.size)}) to your account?\n\n`
      + 'It stays available even if this sharing key is revoked, and the storage '
      + 'is billed to your account from now on. Nothing is re-uploaded.')) return;
    try {
      const result = await pinHandle(row.entry, { statusEl: status });
      const summary = _esc(describePinResult(result));
      status.innerHTML = result.failed.length === 0
        ? `<span class="pass">${summary}</span>`
        : `<span style="color:#f59e0b">${summary}</span>`;
    } catch (err) {
      if (isAccountError(err)) {
        showAccountPrompt('Pinning keeps the file on your own account, which needs one.');
        status.innerHTML = '';
      } else {
        status.innerHTML = `<span class="fail">Could not pin: ${_esc(err.message || err)}</span>`;
      }
    }
  }

  /** Turn a listing entry into a table row. */
  function toRow(entry) {
    const metadata = entry.metadata();
    const full = filenameForDisplay(metadata) || '';
    // The per-upload grouping prefix is the owner's filing system, noise to a
    // recipient, and not part of the path the site loader resolves — but it is
    // what groups the rows, so it is kept as the group key.
    const name = stripUploadUuid(full) || full;
    const updated = entry.updatedAt ? entry.updatedAt() : null;
    const created = entry.createdAt ? entry.createdAt() : null;
    return {
      id: entry.id(),
      filename: full,
      displayName: name || entry.id().slice(0, 16),
      saveName: filenameForSave(metadata) || '',
      size: Number(entry.size()) || 0,
      ms: updated ? +updated : 0,
      updatedAt: updated,
      createdAt: created,
      createdMs: created ? +created : 0,
      uploadUuid: extractUploadUuid(full) || null,
      isManifest: /^index\.x?html?$/i.test(name),
      openable: canRenderInTab(name),
      entry,
    };
  }

  async function open(seed, highlightId) {
    const status = panelStatus();
    const list = listEl();
    currentSeed = seed;
    showListHead(false);
    list.innerHTML = '<div style="padding:1rem; color:#888;">Connecting\u2026</div>';
    statsEl().textContent = '';
    let sdk;
    try {
      sdk = await connect(seed);
    } catch (e) {
      list.innerHTML = `<div style="padding:1rem; color:#f87171;">${_esc(e.message || e)}</div>`;
      status.innerHTML = `<span class="fail">${_esc(e.message || e)}</span>`;
      return;
    }

    try {
      const stats = await sdk.stats();
      const expires = stats.expiresAt ? stats.expiresAt.toLocaleString() : 'never';
      statsEl().textContent =
        `${num(stats.objectCount)} object(s) \u00b7 ${formatSize(num(stats.objectSize))} \u00b7 expires ${expires}`;
    } catch (e) {
      // Stats are decoration; a failure here should not stop the listing.
      _dbg('[shared] stats failed:', e);
    }

    list.innerHTML = '<div style="padding:1rem; color:#888;">Loading objects\u2026</div>';
    let objects;
    try {
      // Summaries: the rows show a name, a size and a date, none of which need
      // the object's slabs. Download and Pin fetch the one object asked for.
      objects = await listSharedSummaries(sdk);
    } catch (e) {
      list.innerHTML = `<div style="padding:1rem; color:#f87171;">Could not list shared objects: ${_esc(e.message || e)}</div>`;
      return;
    }

    const rows = objects.map(toRow);
    table.setRows(rows);
    table.setPageIndex(0);
    table.render();
    showListHead(rows.length > 0);

    // A key holding a root index.html is a website, not a pile of files. The
    // listing can still be useful, so this offers the site view rather than
    // forcing it — but without the offer there is no way to discover that the
    // share renders at all.
    const banner = document.getElementById('sh-site-banner');
    if (banner) {
      const hasIndex = rows.some((r) => /^index\.x?html?$/i.test(r.displayName));
      if (hasIndex && seed) {
        banner.style.display = '';
        banner.innerHTML =
          '<div><strong>This share is a website.</strong> You are looking at its files.</div>'
          + '<button type="button" class="sh-site-open btn-share">Open as a site</button>';
        banner.querySelector('.sh-site-open')
          .addEventListener('click', () => openSiteTab(siteUrl(seed, '')));
      } else {
        banner.style.display = 'none';
        banner.innerHTML = '';
      }
    }

    if (!rows.length) {
      status.innerHTML = '<span style="color:#888;">Nothing shared</span>';
      return;
    }
    status.innerHTML = `<span class="pass">\u2713 ${rows.length} shared object${rows.length !== 1 ? 's' : ''}</span>`;

    // Arriving on a link that names one object should land on it, not on
    // whatever happens to sort first.
    if (highlightId) {
      const hit = rows.find((r) => r.id === highlightId);
      if (hit) table.selectedIds.add(hit.id);
      table.render();
    }
  }

  // Bulk actions. Each resolves the real objects it needs, one at a time as it
  // goes, rather than every object in the key up front.
  function bulkWire(id, fn) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => fn());
  }

  bulkWire('sh-btn-copy-ids', () => {
    const rows = table.selectedRows();
    if (!rows.length) return;
    copyText(rows.map((r) => r.id).join('\n'));
  });

  bulkWire('sh-btn-pin', async () => {
    const rows = table.selectedRows();
    if (!rows.length) return;
    const bytes = rows.reduce((n, r) => n + r.size, 0);
    if (!confirm(`Pin ${rows.length} object${rows.length === 1 ? '' : 's'} (${formatSize(bytes)}) to your account?\n\n`
      + 'They stay available even if this sharing key is revoked, and the storage '
      + 'is billed to your account from now on. Nothing is re-uploaded.')) return;
    const status = panelStatus();
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      status.textContent = `Pinning ${done + failed + 1} of ${rows.length}\u2026`;
      try {
        await pinHandle(row.entry, { statusEl: { set textContent(_) {}, set innerHTML(_) {} } });
        done++;
      } catch (err) {
        if (isAccountError(err)) {
          showAccountPrompt('Pinning keeps the file on your own account, which needs one.');
          status.innerHTML = '';
          return;
        }
        failed++;
      }
    }
    status.innerHTML = failed === 0
      ? `<span class="pass">\u2713 Pinned ${done}</span>`
      : `<span style="color:#f59e0b">Pinned ${done}, ${failed} failed</span>`;
  });

  bulkWire('sh-btn-download', async () => {
    const rows = table.selectedRows();
    if (!rows.length) return;
    const status = panelStatus();
    const sdk = connected && connected.sdk;
    if (!sdk) return;
    // One at a time: a sharing key's objects are the owner's bandwidth, and a
    // recipient selecting hundreds should not open hundreds of transfers.
    let done = 0;
    for (const row of rows) {
      status.textContent = `Downloading ${done + 1} of ${rows.length}\u2026`;
      try {
        const full = await fullObject(row.entry);
        try {
          const { blob } = await streamingDownload(sdk, full, { set textContent(_) {}, set innerHTML(_) {} },
            progressEl(), `Downloading ${row.displayName}`);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = row.saveName || row.displayName || row.id.slice(0, 16);
          a.click();
          URL.revokeObjectURL(a.href);
          done++;
        } finally {
          if (full !== row.entry) releaseObject(full);
        }
      } catch (err) {
        status.innerHTML = `<span class="fail">Stopped after ${done}: ${_esc(err.message || err)}</span>`;
        progressEl().style.display = 'none';
        return;
      }
    }
    progressEl().style.display = 'none';
    status.innerHTML = `<span class="pass">\u2713 Saved ${done}</span>`;
  });

  document.getElementById('sh-open').addEventListener('click', () => {
    const seed = seedEl().value.trim().replace(/^.*[#&]sharing_key=/, '').replace(/&.*$/, '');
    if (!/^[0-9a-f]{64}$/i.test(seed)) {
      alert('Paste a sharing link, or the key seed as 64 hex characters.');
      return;
    }
    seedEl().value = seed;
    open(seed, null);
  });

  // A link opened in this app arrives as a fragment, and it is left in the
  // address bar.
  //
  // It used to be stripped, on the reasoning that a credential should not
  // linger in the URL. That cost more than it bought: the tab stopped
  // behaving like a tab. Reload lost the site, the link could not be copied
  // back out of the browser's own address bar, and there was no history entry
  // to return to — for a link whose entire purpose is to be held and passed
  // on. A fragment is never sent to a server, and the holder was handed it
  // deliberately, so keeping it visible reveals nothing they do not have.
  //
  // Two shapes reach here: a published site, addressed by a signed URL, and a
  // key-backed one. They are mutually exclusive, and the published form needs
  // no account at all, so it is checked first.
  // Entered from share.html's listing? Offer a way back to it. Recorded before
  // anything else consumes the fragment.
  try {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const seed = (params.get('sharing_key') || '').trim();
    const link = document.getElementById('chrome-back-to-list');
    if (link && params.get('from') === 'list' && /^[0-9a-f]{64}$/i.test(seed)) {
      const page = new URL('share.html', location.href).href;
      link.href = `${page}#sharing_key=${encodeURIComponent(seed)}`;
      link.style.display = '';
    }
  } catch (_) { /* nothing to offer */ }

  // Registered as the module-level entry point so registering can repeat it;
  // the body needs this scope's `open` and `seedEl`, so it stays a closure.
  openFromLocationImpl = (hash) => {
    const frag = hash || location.hash;
    const publishedSite = parsePublishedSiteFragment(frag);
    if (publishedSite) {
      openSiteTab(publishedSite.url);
      return true;
    }

    const fromFragment = parseShareFragment(frag);
    if (fromFragment) {
      if (fromFragment.site) {
        // A site link renders in a browser tab through the sandboxed iframe,
        // not in this panel. Everything the tab needs is in the address, so
        // hand it over and let the normal site path take it from here.
        openSiteTab(siteUrl(fromFragment.seed, fromFragment.path));
      } else {
        openOrActivateInternalTab('shared');
        seedEl().value = fromFragment.seed;
        open(fromFragment.seed, fromFragment.objectId);
      }
      return true;
    }
    return false;
  };
  openFromLocationImpl();
}

/** Set by `initSharedUI`; a no-op before the panel has been wired up. */
let openFromLocationImpl = (_hash) => false;

/**
 * Opens whatever the address fragment points at, if anything.
 *
 * Exported because registering has to be able to repeat it. A visitor following
 * a published-site or sharing link with no account is sent to the registration
 * wizard first, and finishing there used to drop them on the homepage — losing
 * the link that brought them, which is the only thing they were trying to open.
 * The fragment is still in the address at that point, so the destination can
 * simply be resolved again.
 *
 * Returns whether it found somewhere to go, so a caller can fall back.
 */
export function openFromLocation(hash) {
  return openFromLocationImpl(hash);
}

/**
 * Opens a sharing link that arrived from somewhere other than the address bar
 * — a click inside a hosted site, in particular.
 *
 * Takes a whole URL or a bare fragment, since a link in someone's markup is a
 * URL and `location.hash` is not. Only the fragment is read: the origin is
 * never fetched, because everything needed is the seed, and a link written for
 * sialo.io has to work the same when the app is served from localhost.
 *
 * Routing is `openFromLocation`'s, so a `site=1` link renders in a browser tab
 * and a bare key opens the Shared With Me panel, exactly as the same link does
 * when it is pasted into the bar.
 */
export function openSharingLink(input) {
  const raw = String(input || '');
  const hash = raw.startsWith('#') ? raw : raw.slice(raw.indexOf('#'));
  if (!hash) return false;
  return openFromLocationImpl(hash);
}
