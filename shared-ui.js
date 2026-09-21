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
import { getUrl, connectSharedSdk, listSharedObjects } from './config.js';
import { streamingDownload } from './download.js';
import {
  filenameForSave, filenameForDisplay, stripUploadUuid,
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

  async function open(seed, highlightId) {
    const status = panelStatus();
    const list = listEl();
    list.innerHTML = '<div style="padding:1rem; color:#888;">Connecting…</div>';
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
        `${num(stats.objectCount)} object(s) · ${formatSize(num(stats.objectSize))} · expires ${expires}`;
    } catch (e) {
      // Stats are decoration; a failure here should not stop the listing.
      _dbg('[shared] stats failed:', e);
    }

    list.innerHTML = '<div style="padding:1rem; color:#888;">Loading objects…</div>';
    let objects;
    try {
      objects = await listSharedObjects(sdk);
    } catch (e) {
      list.innerHTML = `<div style="padding:1rem; color:#f87171;">Could not list shared objects: ${_esc(e.message || e)}</div>`;
      return;
    }

    if (!objects.length) {
      list.innerHTML = '<div style="padding:1rem; color:#888;">This key has no objects attached.</div>';
      status.innerHTML = '<span style="color:#888;">Nothing shared</span>';
      return;
    }

    list.innerHTML = '';

    // A key holding a root index.html is a website, not a pile of files. The
    // listing can still be useful, so this offers the site view rather than
    // forcing it — but without the offer there is no way to discover that the
    // share renders at all.
    const hasIndex = objects.some((obj) => {
      const p = stripUploadUuid(filenameForDisplay(obj.metadata()) || '');
      return /^index\.x?html?$/i.test(p);
    });
    if (hasIndex && seed) {
      const banner = document.createElement('div');
      banner.className = 'sh-site-banner';
      banner.innerHTML =
        '<div><strong>This share is a website.</strong> You are looking at its files.</div>'
        + '<button type="button" class="sh-site-open btn-share">Open as a site</button>';
      banner.querySelector('.sh-site-open')
        .addEventListener('click', () => openSiteTab(siteUrl(seed, '')));
      list.appendChild(banner);
    }

    for (const obj of objects) {
      list.appendChild(renderObject(sdk, obj, obj.id() === highlightId, seed));
    }
    status.innerHTML = `<span class="pass">✓ ${objects.length} shared object${objects.length !== 1 ? 's' : ''}</span>`;
  }

function renderObject(sdk, obj, highlight, seed) {
    const id = obj.id();
    const metadata = obj.metadata();
    const full = filenameForDisplay(metadata) || id.slice(0, 16);
    // The per-upload grouping prefix is the owner's filing system, noise to a
    // recipient, and not part of the path the site loader resolves.
    const name = stripUploadUuid(full) || full;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; gap:1rem; align-items:center; padding:0.6rem 1rem; border-bottom:1px solid #222;'
      + (highlight ? ' background:#0d1f17;' : '');
    // Anything the app can render opens in a tab rather than only downloading.
    // The address is the object's path inside this key's namespace, which the
    // site machinery already resolves through the SharedSdk — so a video
    // streams with seeking and an HTML file renders in the sandboxed iframe,
    // with no account needed.
    // Openability is asked of `canRenderInTab`, which reads the same table
    // that decides the Content-Type the file would be served with. A private
    // extension list here is what previously left ordinary videos with no
    // Open button at all — and an absent button reads as a layout fault
    // rather than a statement about the format, which is why an unrenderable
    // file now gets a disabled button that says why instead of no button.
    const renderable = canRenderInTab(name);
    const canOpen = !!seed && renderable;
    const openTitle = !seed
      ? 'Opening needs the key itself, not just this listing'
      : (renderable
        ? 'Open in a tab'
        : 'This format cannot be shown in a browser. Download it to view it locally.');
    row.innerHTML = `
      <div style="min-width:0; flex:1;">
        <div class="sh-name${canOpen ? ' sh-name--open' : ''}"
          title="${_esc(full)}${canOpen ? ' — click to open' : ''}">${_esc(name)}</div>
        <div style="font-size:0.8rem; color:#666; font-family:monospace;">${_esc(id.slice(0, 8))}…${_esc(id.slice(-8))} · ${_esc(formatSize(obj.size()))}</div>
      </div>
      <button data-act="open" class="sh-act sh-act--open" title="${_esc(openTitle)}"${canOpen ? '' : ' disabled'}>Open</button>
      <button data-act="download" class="sh-act sh-act--download">Download</button>
      <button data-act="pin" class="sh-act sh-act--pin" title="Keep this on your own account, so it stays after the key is revoked or its owner stops paying">Pin</button>
    `;
    if (canOpen) {
      const open = () => openSiteTab(siteUrl(seed, name));
      row.querySelector('[data-act="open"]').addEventListener('click', open);
      row.querySelector('.sh-name').addEventListener('click', open);
    }
    // Downloading gives you a copy on this device; pinning keeps it on Sia
    // under your account, which is what survives the key being revoked. The
    // object handle came from the sharing key and already carries its
    // decryption keys, so nothing needs resolving or re-uploading.
    row.querySelector('[data-act="pin"]').addEventListener('click', async (e) => {
      const button = e.target;
      const original = button.textContent;
      const status = panelStatus();
      if (!confirm(`Pin "${name}" (${formatSize(obj.size())}) to your account?\n\n`
        + 'It stays available even if this sharing key is revoked, and the storage '
        + 'is billed to your account from now on. Nothing is re-uploaded.')) return;
      button.disabled = true;
      button.textContent = 'Pinning…';
      try {
        const result = await pinHandle(obj, { statusEl: status });
        const summary = _esc(describePinResult(result));
        status.innerHTML = result.failed.length === 0
          ? `<span class="pass">${summary}</span>`
          : `<span style="color:#f59e0b">${summary}</span>`;
        if (result.pinned > 0) button.textContent = '\u2713 Pinned';
      } catch (err) {
        if (isAccountError(err)) {
          showAccountPrompt('Pinning keeps the file on your own account, which needs one.');
          status.innerHTML = '';
        } else {
          status.innerHTML = `<span class="fail">Could not pin: ${_esc(err.message || err)}</span>`;
        }
        button.textContent = original;
      } finally {
        // Left disabled after a success: the object is pinned, and a second
        // press would only re-pin what is already there.
        if (button.textContent === original) button.disabled = false;
      }
    });

    row.querySelector('[data-act="download"]').addEventListener('click', async (e) => {
      const button = e.target;
      const original = button.textContent;
      button.disabled = true;
      try {
        const status = panelStatus();
        const { blob } = await streamingDownload(sdk, obj, status, progressEl(), `Downloading ${name}`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filenameForSave(metadata) || id.slice(0, 16);
        a.click();
        URL.revokeObjectURL(a.href);
        status.innerHTML = `<span class="pass">✓ Saved ${_esc(name)}</span>`;
      } catch (err) {
        alert(`Download failed: ${err.message || err}`);
      } finally {
        button.disabled = false;
        button.textContent = original;
        progressEl().style.display = 'none';
      }
    });
    return row;
  }

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
