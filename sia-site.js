// Sia site hosting — loads multi-file websites served from the Sia
// network. Runs on the main sialo browser origin and acts as the
// SDK-side of a postMessage bridge to an iframe that lives on the
// sandbox origin (sandbox.sialo.io in prod, localhost:8081 in dev),
// where a service worker (sia-sw.js) intercepts every fetch.
//
// The origin split is the security boundary: the iframe cannot see the
// main app's localStorage (app keys, wallet entropy), SDK handles, or
// DOM because the sandbox is on a different origin. In dev the origin
// differs by port; in prod it differs by hostname.
//
// The bridge supports dynamic fetches, module imports, streaming video,
// etc. — anything a normal HTTP server can serve — because the SW
// returns a real same-origin Response for every request.
//
// A site comes from one of two sources, both of which reduce to the same
// flat `{ path -> ref }` map that the resolver, the auto-index and the
// URL rewriters all work against.
//
// Sharing key (current). The key *is* the manifest: its attached objects
// are the files, and each object's metadata filename is its path. Nothing
// separate is published, the owner can revoke the whole site at once, and
// downloads are billed to them rather than the visitor. Addressed as
// `sialo://<64 hex seed>/<path>`.
//
// Manifest object (legacy, read only). A JSON object mapping paths to
// signed `sia://` published URLs:
//   { "type": "sia-site", "version": 1, "files": {
//       "index.html": "sia://...?sv=...#encryption_key=...",
//       "app.js":     "sia://...", ...
//   }}
// Still loadable so sites published before sharing keys keep working, but
// nothing writes this format any more.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { _dbg, _dbgWarn, _esc, formatSize } from './utils.js';
import {
  connectSdk, resolveObject, invalidateSdk, getLastConnectError, getUrl, getKeyHex,
  connectSharedSdk,
  listSharedObjects,
} from './config.js';
import {
  findTabByIframeWindow, tabStatusProxy, getActiveTab, setChromeCollapsed,
} from './tabs.js';
import { encodeMetadata, filenameForDisplay, stripUploadUuid } from './object-metadata.js';
import { downloadOptions } from './transfer-options.js';
import { isSiteAddress } from './object-input.js';
import { openSharingLink } from './shared-ui.js';
import { isAccountError, showAccountPrompt } from './page-gate.js';

// "not enough shards: 0/N" after a period of idle usually means every
// cached WebTransport connection got killed by the QUIC idle timeout.
// Retrying with a freshly-built SDK re-dials hosts.
const STALE_CONNECTION_RX = /not enough shards|failed to establish|idle[_ ]timeout|quic/i;

async function withSdkRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err && (err.message || String(err));
      if (i === attempts - 1 || !msg || !STALE_CONNECTION_RX.test(msg)) throw err;
      _dbgWarn('[sia-site] retrying after stale-connection error:', msg);
      invalidateSdk();
    }
  }
  throw lastErr;
}

// The sandbox lives on a separate origin so its JS can't read the main
// app's localStorage / keys. In prod that's `sandbox.sialo.io`; in dev
// it's `localhost:<sandbox-port>` (a second static server beside the
// main app's 8080 — port difference alone makes it cross-origin).
// Override via <meta name="sia-sandbox-origin"> to point at a staging
// origin.
function resolveHostedOrigin() {
  const meta = document.querySelector('meta[name="sia-sandbox-origin"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');
  const host = location.hostname;
  if (host === 'sialo.io' || host === 'www.sialo.io') return 'https://sandbox.sialo.io';
  // Local dev: assume sandbox runs on port 8081 on the same loopback.
  return location.protocol + '//' + host + ':8081';
}

export const HOSTED_ORIGIN = resolveHostedOrigin();
export const HOSTED_HOSTNAME = (() => {
  try { return new URL(HOSTED_ORIGIN).hostname; } catch (_) { return location.hostname; }
})();

const manifestCache = new Map(); // manifestId → { "path": publishUrl, ... }
const objectCache = new Map();   // publishUrl → Uint8Array
const siteCache = new Map();     // siteId → site source (see getSite)

// Published URLs baked into site manifests should outlive the lifetime of
// the site. 100 years from upload time is effectively "forever" from a user
// perspective and stays well inside JavaScript's Date range.
const SITE_PUBLISH_VALIDITY_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// In-flight external-object streams, keyed by request id. Looked up by
// the onMessage handler when the SW cancels a fetch (e.g. the browser
// aborted a progressive download to issue a Range request on seek).
const activeExtStreams = new Map(); // id → { cancelled: boolean, reader }

// iframe element → siteId (a sharing-key seed, or a legacy manifest
// reference). Each tab's iframe is independently bound to whichever Sia
// site it was told to load, so a single main app can host multiple Sia
// sites at once in different tabs.
const iframeSites = new WeakMap();

// The handshake state keeps track of which iframes have sent their
// sia-bridge-ready message. The parent refuses to serve requests until
// the handshake has been acknowledged to avoid data races on first load.
const handshaken = new WeakSet();

let handlerInstalled = false;

/**
 * Mark every active ext-stream whose source is the given window as
 * cancelled. Callers should invoke this when an iframe is about to
 * navigate to a new URL, otherwise any in-flight `sia-ext-chunk`
 * posts target the previous origin and Chrome floods the console
 * with "target origin does not match recipient" warnings while the
 * messages are silently dropped.
 */
export function cancelStreamsForSource(sourceWin) {
  if (!sourceWin) return;
  for (const entry of activeExtStreams.values()) {
    if (entry.source === sourceWin) entry.cancelled = true;
  }
}

/**
 * Installs the window-level postMessage listener. Call once at app
 * startup.
 */
export function initSiaSiteHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  window.addEventListener('message', onMessage);
  _dbg('[sia-site] handler installed, hosted origin:', HOSTED_ORIGIN);
}

/**
 * Show a failure in the owning tab's status bar, offering registration when
 * that is what would fix it.
 *
 * The buttons carry data attributes rather than inline handlers, and are
 * wired by a delegated listener in page-gate.js — status text is replaced
 * wholesale on every update, so per-element listeners would be lost.
 */
/**
 * Whether the content in this frame is backed by a sharing key.
 *
 * A key holder has no account and needs none — that is the entire point of
 * being handed a key — so nothing that fails inside such a frame is fixed by
 * registering. Asked of the loaded site rather than of the error text, because
 * that is the only way to get this right for a message nobody thought to
 * special-case: the reader's situation is what decides it, not the wording of
 * whatever went wrong.
 */
function isKeyBackedSource(source) {
  const iframe = findIframeForSource(source);
  const siteId = iframe && iframeSites.get(iframe);
  if (!siteId) return false;
  const site = siteCache.get(siteId) || siteCache.get(String(siteId).toLowerCase());
  return !!(site && site.kind === 'sharing-key');
}

function showTabFailure(source, err) {
  const tab = findTabByIframeWindow(source);
  if (!tab) return;
  const msg = (err && err.message) || String(err);
  // An account cannot help a key holder, so the offer is withheld even when
  // the error would otherwise be classified as one. This has now misfired
  // three times — a missing file, an unreachable indexer, and hosts that
  // would not answer — each time sending someone with a perfectly good
  // sharing link off to register for something they do not need.
  const keyBacked = isKeyBackedSource(source);
  const offerAccount = !keyBacked && isAccountError(err);
  const action = !keyBacked && err && err.needsAccount
    ? ' <button type="button" data-sialo-action="register" class="status-action">Register / Log In</button>'
      + ' <button type="button" data-sialo-action="settings" class="status-action">Settings</button>'
    : '';
  tabStatusProxy(tab).status.innerHTML =
    `<span class="fail">${_esc(msg)}</span>${action}`;
  // Status text alone is not enough for a failed content load: the iframe
  // renders its own error and the reader never looks down here. Cover the
  // viewport with the prompt instead, which is where they are looking.
  if (offerAccount) showAccountPrompt(msg);
}

async function onMessage(e) {
  // Only accept messages from the hosted-site origin. Everything else is
  // either unrelated (e.g. iframe embeds) or actively hostile.
  if (e.origin !== HOSTED_ORIGIN) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;

  // Find which iframe this message is from. Some message types need a
  // manifest binding (manifest-path fetches); others work standalone
  // (direct sia-ext streaming for the video viewer, navigation hand-off
  // for a sia:// link click from an unbound iframe).
  const iframe = findIframeForSource(e.source);
  if (!iframe) return;
  const siteId = iframeSites.get(iframe) || null;

  switch (d.type) {
    case 'sia-bridge-ready':
      // Nothing may run ahead of the reply below. The sandbox bootstrap
      // blocks on `sia-bridge-ok` before it issues any request, so a throw
      // here strands the whole load and surfaces 20s later as "sandbox
      // unreachable". Per-page work belongs in `sia-bridge-page`, which is
      // announced on every document load and blocks nothing.
      if (!siteId) {
        // The viewer iframe also uses the bridge but is not bound to a
        // site; acknowledge it so its bootstrap can proceed without
        // blocking.
        e.source.postMessage({ type: 'sia-bridge-ok' }, HOSTED_ORIGIN);
        return;
      }
      handshaken.add(iframe);
      e.source.postMessage({ type: 'sia-bridge-ok' }, HOSTED_ORIGIN);
      return;

    // A site reporting that the reader scrolled. Only the visible tab may
    // move the app's chrome: a background tab finishing a lazy scroll must
    // not yank the address bar out from under whatever is on screen.
    case 'sia-scroll-chrome': {
      const srcTab = findTabByIframeWindow(e.source);
      const active = getActiveTab();
      if (srcTab && active && srcTab.id === active.id) {
        setChromeCollapsed(!!d.hidden);
      }
      return;
    }

    // The sandbox bootstrap could not install its service worker. Surface it
    // immediately: the alternative is the parent's 20s watchdog reporting
    // "sandbox unreachable", which blames the network for what is usually a
    // browsing mode with service workers switched off.
    case 'sia-bridge-failed': {
      const tab = findTabByIframeWindow(e.source);
      if (tab) {
        tabStatusProxy(tab).status.innerHTML =
          `<span class="fail">${_esc(d.error || 'The sandbox could not start.')}</span>`;
      }
      _dbgWarn('[sia-site] sandbox bootstrap failed:', d.error);
      return;
    }

    case 'sia-bridge-alive':
      return;

    case 'sia-bridge-page': {
      // A document just loaded, scrolled to the top. The scroll reporter only
      // messages on a state change, so it would never ask us to restore a bar
      // that the previous page had collapsed.
      setChromeCollapsed(false);
      // Record the iframe's current in-site path on the owning tab's
      // current navHistory entry. When the user later navigates away
      // (e.g. clicks a sialo:// link to another site) and presses
      // Back, the saved path lets us restore the sub-page they were
      // last viewing instead of dumping them at the site's root.
      // The path itself is never source-of-truth for the iframe's own
      // history — that's still managed inside the iframe via the SW.
      const tab = findTabByIframeWindow(e.source);
      if (!tab) return;
      const entry = tab.navHistory && tab.navHistory[tab.navIndex];
      if (!entry) return;
      // Only stash for sia-site entries; other URL types don't need it.
      if (typeof entry.url !== 'string' || !entry.url.startsWith('sialo://')) return;
      const path = (typeof d.path === 'string' && d.path) ? d.path : '/';
      const search = typeof d.search === 'string' ? d.search : '';
      const hash = typeof d.hash === 'string' ? d.hash : '';
      const subpath = path + search + hash;
      entry.subpath = subpath;
      // Track intra-site nav depth so the in-app back button knows
      // whether it's safe to delegate to iframe.history.back() — the
      // iframe shares joint session history with the parent, so calling
      // back() at the bottom of the iframe's stack escapes to the
      // parent's previous URL and exits sialo.io. We push on new
      // forward navigations and pop when we recognise a back-style
      // announce (current path equals the one beneath top of stack).
      if (!Array.isArray(tab.iframePathStack)) tab.iframePathStack = [];
      const stack = tab.iframePathStack;
      const top = stack[stack.length - 1];
      const prev = stack[stack.length - 2];
      if (subpath === prev) stack.pop();           // backward nav
      else if (subpath !== top) stack.push(subpath); // new forward nav
      // Freeze the depth the reader arrived at, once the landing burst goes
      // quiet. Landing announces come in a rapid group — a redirect, a
      // bootstrap rewriting the path — and none of them are navigations the
      // reader made. A click arrives long after the group has settled, so a
      // debounce separates the two without having to ask the page.
      if (!tab.iframeBaseSettled) {
        tab.iframeBaseDepth = stack.length;
        clearTimeout(tab.iframeBaseTimer);
        tab.iframeBaseTimer = setTimeout(() => { tab.iframeBaseSettled = true; }, 1200);
      }
      return;
    }

    case 'sia-video-error': {
      // The video viewer iframe couldn't decode the stream (unsupported
      // codec like VC-1/HEVC, malformed file, etc.). The iframe shows
      // its own in-frame error; mirror it in the owning tab's status
      // bar so the chrome reflects the failure too.
      const tab = findTabByIframeWindow(e.source);
      if (tab) {
        const statusBar = tabStatusProxy(tab).status;
        statusBar.innerHTML = `<span class="fail">${_esc(d.detail || 'Video playback failed')}</span>`;
      }
      return;
    }

    case 'sia-navigate': {
      // A link inside the hosted page pointed at an external scheme
      // (sia://, sialo://) that the iframe can't handle itself.
      // Surface it in the parent tab's address bar and kick off the
      // normal navigation flow.
      const target = d.url;
      if (typeof target !== 'string') return;
      // A sharing link is an ordinary https URL, so it arrives here rather than
      // as a scheme the iframe cannot handle. Answered locally from its
      // fragment: a `site=1` link renders in a browser tab, a bare key opens
      // Shared With Me. Neither fetches the link's origin, which is what keeps
      // a page written for sialo.io working when the app is served elsewhere.
      if (isAppSharingLink(target)) {
        cancelStreamsForSource(e.source);
        openSharingLink(target);
        return;
      }
      if (!/^(sia|sialo):\/\//i.test(target)) return;
      // `sialo://` addresses app pages as well as content, so a scheme test
      // alone would let a hosted page post `sialo://wallet` and drive the
      // parent into an internal panel. Content sent from inside the sandbox
      // must be shaped like a site.
      if (/^sialo:\/\//i.test(target) && !isSiteAddress(target)) {
        _dbgWarn('[sia-site] refusing sia-navigate to a non-site address:', target);
        return;
      }
      // Cancel any in-flight ext-streams owned by the navigating
      // iframe. Without this, their postMessage chunks keep targeting
      // the old document and Chrome floods the console with
      // "target origin does not match recipient" warnings — which
      // can also stall the new page's bootstrap.
      cancelStreamsForSource(e.source);
      const bar = document.getElementById('chrome-address-bar');
      if (bar) bar.value = target;
      if (typeof window.handleChromeBarNavigation === 'function') {
        window.handleChromeBarNavigation();
      }
      return;
    }

    case 'sia-ext-request': {
      // The iframe (its SW, relayed by the bridge) needs bytes for a
      // sia:// or sialo:// URL that was rewritten to /_sia-ext/<url>
      // in an HTML/CSS response. Stream the bytes back with ranged
      // download support.
      streamExternalObject(e.source, d.id, d.url, d.offset, d.length, siteId)
        .catch((err) => {
          const msg = err.message || String(err);
          try {
            e.source.postMessage(
              { type: 'sia-ext-error', id: d.id, error: msg },
              HOSTED_ORIGIN,
            );
          } catch (_) {}
          // Also surface it in the chrome. The message above travels back to
          // the service worker and becomes a 502 response body, which nothing
          // ever displays: a <video> or <img> discards it and the console
          // shows only "502 (Bad Gateway)". Without this the reader gets a
          // dead player and no way to learn why.
          try {
            showTabFailure(e.source, err);
          } catch (_) {}
          _dbgWarn('[sia-site] ext request failed:', d.url, msg);
        });
      return;
    }

    case 'sia-ext-cancel': {
      // The iframe's SW cancelled a fetch — likely because the browser
      // aborted it to issue a Range request on a seek. Stop pulling
      // bytes for this id so the new Range request isn't starved by
      // the main thread still ferrying the old stream's chunks.
      const entry = activeExtStreams.get(d.id);
      if (entry) {
        entry.cancelled = true;
        try { entry.reader.cancel('client aborted').catch(() => {}); } catch (_) {}
        activeExtStreams.delete(d.id);
      }
      return;
    }

    case 'sia-request':
      // Serve the resource from the site. If this iframe is not bound to
      // one (e.g. the direct-video viewer), we can't answer these, so
      // return an error response so the SW stops waiting.
      if (!siteId) {
        try {
          e.source.postMessage(
            { type: 'sia-response', id: d.id, error: 'no site bound to this iframe' },
            HOSTED_ORIGIN,
          );
        } catch (_) {}
        return;
      }
      try {
        // Cap the per-path resolve. Without a timeout the iframe's SW
        // sits on a pending fetch forever when the SDK can't reach
        // hosts (e.g. all WebTransport sessions refused with
        // ERR_METHOD_NOT_SUPPORTED on some browser/network combos) —
        // users see a blank iframe with "Loading site…" for the
        // session's lifetime. 30s leaves room for a cold WebTransport
        // warm-up while still surfacing a visible error when the
        // network is actually broken.
        const result = await Promise.race([
          resolveSitePath(siteId, d.path, d.mode),
          new Promise((_, reject) => setTimeout(
            // Deliberately not "network unreachable": the common cause is a
            // large file, not a broken network. resolveSitePath buffers the
            // whole object before replying, so anything that cannot be
            // fetched and held within this window fails here regardless of
            // how healthy the hosts are. Naming the real constraint stops
            // this being debugged as a connectivity problem.
            () => reject(new Error(
              `Timed out after 30s fetching ${d.path || '/'} — the whole file has `
              + 'to be retrieved before it can be served, so large files fail here '
              + 'even when the network is fine.',
            )),
            30000,
          )),
        ]);
        // The requesting iframe may have navigated away or been
        // destroyed (tab closed, sandbox 502 retry, site switch) while
        // the resolve was in flight. Chrome returns null on e.source in
        // that case; posting to null throws and kills this handler.
        if (!e.source) return;
        try {
          e.source.postMessage(
            { type: 'sia-response', id: d.id, body: result.body, contentType: result.contentType },
            HOSTED_ORIGIN,
            result.body ? [result.body] : [],
          );
        } catch (_) { /* recipient gone */ }
      } catch (err) {
        _dbgWarn('[sia-site] resolve failed:', d.path, err);
        // Surface the failure in the parent tab's status bar too. The
        // iframe's SW will render the error in the iframe body, but the
        // parent's status was set to "Site loaded" synchronously when
        // we pointed the iframe at the bootstrap URL — that's a lie if
        // the SDK can't construct (bad app key) or the manifest can't
        // be fetched. Find the tab via the iframe's contentWindow and
        // overwrite it with the real error.
        showTabFailure(e.source, err);
        if (!e.source) return;
        try {
          e.source.postMessage(
            { type: 'sia-response', id: d.id, error: err.message || String(err) },
            HOSTED_ORIGIN,
          );
        } catch (_) { /* recipient gone */ }
      }
      return;
  }
}

/**
 * The site was reached and answered: it simply does not hold this path.
 *
 * Flagged `needsAccount: false` so the account gate cannot blame it on
 * registration. That matters most for a sharing key, whose content is
 * readable *because* it needs no account — offering to register there sends
 * the reader off to fix something that was never wrong.
 *
 * The flag alone is not enough: this error crosses a postMessage boundary as
 * a bare string and is rebuilt on the far side, losing it. `isAccountError`
 * therefore also recognises the wording.
 */
/**
 * Whether `url` is one of this app's own sharing links.
 *
 * Restricted to the app's own origin and the canonical sialo.io, rather than
 * any URL carrying a `sharing_key` fragment. A hosted page can put whatever it
 * likes in an href, and silently swallowing a link to someone else's site
 * because its fragment happened to match would be a surprise; a link to sialo
 * is the only one we are entitled to answer ourselves.
 */
function isAppSharingLink(url) {
  let u;
  try { u = new URL(String(url || ''), location.href); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const mine = u.origin === location.origin
    || /^(www\.)?sialo\.io$/i.test(u.hostname);
  if (!mine) return false;
  return /[#&]sharing_key=[0-9a-f]{64}(?:&|$)/i.test(u.hash);
}

function notInThisSite(path) {
  const err = new Error('not in this site: ' + path);
  err.needsAccount = false;
  return err;
}

function findIframeForSource(source) {
  if (!source) return null;
  const all = document.querySelectorAll('iframe');
  for (const el of all) {
    try { if (el.contentWindow === source) return el; } catch (_) {}
  }
  return null;
}

async function resolveSitePath(siteId, path, mode) {
  const site = await getSite(siteId);
  const manifest = site.files;
  const lookup = resolveManifestKey(manifest, path);
  if (!lookup) {
    // No file matched AND the request is for a directory-like path
    // (root or trailing slash) — synthesise an index listing from the
    // site's files so a site with no index.html is still browsable.
    const normalized = (path || '').replace(/^\/+/, '');
    if (normalized === '' || normalized.endsWith('/')) {
      const html = await renderAutoIndex(site, normalized);
      const injected = injectBridge(html);
      const body = new TextEncoder().encode(injected).buffer;
      return { body, contentType: 'text/html' };
    }
    throw notInThisSite(path);
  }
  // A large file cannot be served by value: site.read() buffers the whole
  // object and this resolve is capped, so the request times out however
  // healthy the network is. Serve a tiny page that embeds the file through
  // the streaming route, which supports Range so a video seeks. The embed is
  // a subresource, which is the only form that route works in.
  // Only for a document navigation. A <video src="big.mp4"> or <img> inside a
  // site is a subresource fetch and must receive the bytes, not a page about
  // them — handing HTML to a media element would break the embed outright.
  // Older sandbox builds send no mode; treat that as a navigation, which is
  // what every request was before the player page existed.
  const isNavigation = !mode || mode === 'navigate';
  const type = guessMime(lookup.key);
  // Text is never big enough for this to matter, and on a manifest-backed site
  // `sizeOf` resolves the published URL over the network — so skipping it here
  // keeps the common case (HTML, CSS, JS) at zero extra cost.
  const textish = /^(?:text\/|application\/(?:javascript|json|xml))/.test(type);
  if (isNavigation && !textish && typeof site.streamHrefFor === 'function') {
    // `sizeOf` is sync for a key-backed site and async for a manifest-backed
    // one; awaiting covers both. Unawaited this was NaN on a manifest site and
    // the branch silently never fired.
    let size = 0;
    try {
      size = Number(await site.sizeOf(lookup.objectId)) || 0;
    } catch (_) { /* size unknown: fall through and serve by value */ }
    const streamHref = size >= STREAM_MIN_BYTES ? site.streamHrefFor(lookup.key) : null;
    if (streamHref) {
      const html = renderStreamPage(lookup.key, streamHref, size, type);
      const injected = injectBridge(html);
      return { body: new TextEncoder().encode(injected).buffer, contentType: 'text/html' };
    }
  }

  const data = await site.read(lookup.objectId);

  const contentType = type;
  let body;
  if (contentType === 'text/html') {
    // Inject the bridge script and rewrite subresource references.
    // Two passes:
    //   1. Explicit sia:// / sialo:// URLs → /_sia-ext/<encoded>
    //      (the iframe SW streams bytes through a same-origin Response
    //      with Range support, so <video src="sia://..."> seeks).
    //   2. Absolute paths (/foo.js, /_next/...) that resolve against
    //      the manifest → same /_sia-ext/ route. Without this, framework
    //      builds with absolute asset paths blank-screen because the
    //      sandbox origin doesn't have those files.
    const html = new TextDecoder().decode(data);
    // Media first: a relative <video src> must reach the streaming route or a
    // large file 502s on the capped by-value resolve.
    let rewritten = rewriteMediaToStream(html, site, lookup.key);
    rewritten = rewriteSiaUrlsInHtml(rewritten);
    rewritten = rewriteAbsolutePathsInHtml(rewritten, manifest);
    const injected = injectBridge(rewritten);
    body = new TextEncoder().encode(injected).buffer;
  } else if (contentType === 'text/css') {
    const css = new TextDecoder().decode(data);
    let rewritten = rewriteSiaUrlsInCss(css);
    rewritten = rewriteAbsolutePathsInCss(rewritten, manifest);
    body = new TextEncoder().encode(rewritten).buffer;
  } else {
    // Return a fresh ArrayBuffer so we can transfer ownership.
    body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return { body, contentType };
}

// Rewrite raw sia:// / sialo:// URLs in HTML attributes to the
// same-origin /_sia-ext/<encoded-url> path that the SW intercepts.
// We deliberately skip <a href> so full-page link clicks still fall
// through to the parent's sia-navigate intercept (user-visible tab
// navigation, not inline rendering).
function rewriteSiaUrlsInHtml(html) {
  // src / poster / data / formaction on any element.
  html = html.replace(
    /\b(src|poster|data|formaction)\s*=\s*(["'])((?:sia|sialo):\/\/[^"'<>\s]+)\2/gi,
    (_, attr, q, url) => attr + '=' + q + '/_sia-ext/' + encodeURIComponent(url) + q,
  );
  // <link ... href="sia://..."> — stylesheets, preloads, icons, etc.
  html = html.replace(
    /<link\b([^>]*?)\bhref\s*=\s*(["'])((?:sia|sialo):\/\/[^"'<>\s]+)\2/gi,
    (_, rest, q, url) => '<link' + rest + 'href=' + q + '/_sia-ext/' + encodeURIComponent(url) + q,
  );
  // Inline style="...: url(sia://...)".
  html = html.replace(
    /style\s*=\s*(["'])([^"']*)\1/gi,
    (_m, q, css) => 'style=' + q + rewriteSiaUrlsInCss(css) + q,
  );
  // A bare object ID used as a file name. An object ID is the one address that
  // needs neither a manifest entry nor a signed URL, so authors reach for it
  // when embedding something that is not part of the site's own file list —
  // `<video src="6ae7…4af8">`. Left alone it looks like a relative path, and
  // the site's manifest has no such file, so the embed fails with "not in this
  // site" and nothing explains why. Routed through the streaming route it
  // behaves like any other media source, Range seeking included.
  html = html.replace(
    /\b(src|poster|data|formaction)\s*=\s*(["'])([0-9a-f]{64})\2/gi,
    (_, attr, q, id) => attr + '=' + q + '/_sia-ext/'
      + encodeURIComponent('sialo://' + id.toLowerCase()) + q,
  );
  // <source srcset> / <img srcset> — comma-separated list.
  html = html.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_m, q, set) => {
      const rewritten = set.replace(
        /((?:sia|sialo):\/\/[^\s,]+)/gi,
        (u) => '/_sia-ext/' + encodeURIComponent(u),
      ).replace(
        // A bare object id in a srcset entry, same as above. Anchored on the
        // entry boundary so a descriptor like `2x` is left alone.
        /(^|,\s*)([0-9a-f]{64})(?=\s|,|$)/gi,
        (_m, lead, id) => lead + '/_sia-ext/'
          + encodeURIComponent('sialo://' + id.toLowerCase()),
      );
      return 'srcset=' + q + rewritten + q;
    },
  );
  return html;
}

function rewriteSiaUrlsInCss(css) {
  return css.replace(
    /url\(\s*(["']?)((?:sia|sialo):\/\/[^"'\s)]+)\1\s*\)/gi,
    (_, q, url) => 'url(' + q + '/_sia-ext/' + encodeURIComponent(url) + q + ')',
  );
}

// Rewrite absolute path references (`src="/foo"`, `href="/foo"`,
// `url(/foo)`, srcset, inline styles) to `/_sia-ext/<sia-url>` lookups
// against the current site's manifest. Without this, frameworks that
// emit absolute paths (Next.js's `/_next/...`, most static-site
// generators) try to fetch from sandbox.sialo.io and 504 because that
// origin is itself a Vercel-hosted Next.js app — those paths collide.
//
// This handles the common static-build case (everything preloaded in
// the initial HTML/CSS). Webpack runtime-loaded chunks and dynamic
// `import()` paths are still strings inside the JS bundles and won't
// be rewritten — apps that rely on those need a real
// `assetPrefix: './'` rebuild.
/**
 * Media extensions that must be streamed rather than served by value.
 */
const STREAMABLE_MEDIA = /\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:[?#]|$)/i;

/** Resolve a relative reference against the directory of the page holding it. */
function resolveSiteRelative(ref, fromPath) {
  const dir = String(fromPath || '').replace(/[^/]*$/, '');
  try {
    return new URL(ref, 'site:/' + dir).pathname.replace(/^\/+/, '');
  } catch (_) {
    return ref.replace(/^\/+/, '');
  }
}

/**
 * Point *relative* media references at the streaming route.
 *
 * A `<video src="movie.mp4">` inside a site is a subresource fetch, so it is
 * served by value — and `read()` buffers the whole object before replying,
 * against a capped resolve. A large video therefore fails with a 502 no matter
 * how healthy the network is. The player page does not help: that is only for
 * navigations, and this is not one.
 *
 * /_sia-ext/ streams chunk by chunk and supports Range, which media needs
 * anyway for seeking, so media is routed there regardless of size rather
 * than paying for a size lookup per reference. Everything else keeps the
 * cheap by-value path.
 */
export function rewriteMediaToStream(html, site, fromPath) {
  if (!site || typeof site.streamHrefFor !== 'function') return html;
  const target = (ref) => {
    if (!STREAMABLE_MEDIA.test(ref)) return null;
    // Absolute paths, protocol-relative and full URLs are handled by the
    // other passes; only same-site relative references belong here.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref)) return null;
    const path = resolveSiteRelative(ref, fromPath);
    if (!Object.prototype.hasOwnProperty.call(site.files, path)) return null;
    return site.streamHrefFor(path);
  };

  html = html.replace(
    /\b(src|poster)\s*=\s*(["'])([^"'<>\s]+)\2/gi,
    (full, attr, q, ref) => {
      const to = target(ref);
      return to ? attr + '=' + q + to + q : full;
    },
  );

  html = html.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (full, q, set) => {
      let touched = false;
      const out = set.split(',').map((part) => {
        const m = part.trim().match(/^(\S+)(\s.*)?$/);
        if (!m) return part;
        const to = target(m[1]);
        if (!to) return part;
        touched = true;
        return ' ' + to + (m[2] || '');
      }).join(',');
      return touched ? 'srcset=' + q + out.trim() + q : full;
    },
  );

  return html;
}

function rewriteAbsolutePathsInHtml(html, manifest) {
  const lookup = (rawPath) => {
    const path = rawPath.replace(/^\/+/, '').replace(/[?#].*$/, '');
    const url = manifest[path];
    return url ? '/_sia-ext/' + encodeURIComponent(url) : null;
  };

  // src / poster / data / formaction with absolute paths.
  // Skip already-rewritten /_sia-ext paths and protocol-relative //host.
  html = html.replace(
    /\b(src|poster|data|formaction)\s*=\s*(["'])(\/[^/"'<>\s][^"'<>\s]*)\2/gi,
    (full, attr, q, path) => {
      if (path.startsWith('/_sia-ext/')) return full;
      const rewritten = lookup(path);
      return rewritten ? attr + '=' + q + rewritten + q : full;
    },
  );

  // <link ... href="/foo"> — stylesheets, preloads, icons. Restricted
  // to <link> so <a href> stays untouched (parent's nav intercept
  // handles full-page link clicks).
  html = html.replace(
    /<link\b([^>]*?)\bhref\s*=\s*(["'])(\/[^/"'<>\s][^"'<>\s]*)\2/gi,
    (full, rest, q, path) => {
      if (path.startsWith('/_sia-ext/')) return full;
      const rewritten = lookup(path);
      return rewritten ? '<link' + rest + 'href=' + q + rewritten + q : full;
    },
  );

  // <source>/<img> srcset — comma-separated list of (url descriptor) pairs.
  html = html.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_full, q, set) => {
      const rewritten = set.replace(
        /(\/[^/\s,?#][^\s,]*)/g,
        (path) => {
          if (path.startsWith('/_sia-ext/')) return path;
          return lookup(path) || path;
        },
      );
      return 'srcset=' + q + rewritten + q;
    },
  );

  // Inline style="...: url(/foo)" — defer to the CSS rewriter.
  html = html.replace(
    /style\s*=\s*(["'])([^"']*)\1/gi,
    (_full, q, css) => 'style=' + q + rewriteAbsolutePathsInCss(css, manifest) + q,
  );

  return html;
}

function rewriteAbsolutePathsInCss(css, manifest) {
  return css.replace(
    /url\(\s*(["']?)(\/[^/"'\s)][^"'\s)]*)\1\s*\)/gi,
    (full, q, path) => {
      if (path.startsWith('/_sia-ext/')) return full;
      const clean = path.replace(/^\/+/, '').replace(/[?#].*$/, '');
      const url = manifest[clean];
      if (!url) return full;
      return 'url(' + q + '/_sia-ext/' + encodeURIComponent(url) + q + ')';
    },
  );
}

/**
 * Stream bytes for a rewritten /_sia-ext/<url> request back to the
 * iframe. Sends a meta message first (so the SW can build the Response
 * headers), then a sequence of chunk messages, then either end or
 * error. Handles ranged requests by forwarding offset/length straight
 * to sdk.download().
 */
/**
 * The SDK and object behind a /_sia-ext/ request.
 *
 * A key-backed site addresses its own files as `sialo://<seed>/<path>`. Those
 * resolve through the site's SharedSdk, built from the seed, because the
 * holder of a sharing key has no account here — going through connectSdk
 * would demand an indexer URL and app key they were never given. Everything
 * else is an ordinary published object and resolves as before.
 */
/**
 * The object id in a bare `sialo://<id>` address, or null.
 *
 * Only the bare form. A published address carries a signature in its query and
 * its decryption key in its fragment, so reducing one to an id would throw
 * away both and the bytes would not decrypt.
 *
 * A bare 64-hex address is ambiguous by design — the same shape names a site,
 * a sharing key and an object — but not here: a site cannot be the source of a
 * `<video>`, so inside a subresource fetch this can only mean the object.
 */
function bareObjectAddress(siaUrl) {
  const m = /^sialo:\/\/([0-9a-f]{64})\/?$/i.exec(String(siaUrl || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The object a key-backed site holds under `id`, or null.
 *
 * A sharing key's files are keyed by path, but an embed often names the object
 * itself: an id survives renames and belongs to no site in particular, which is
 * what makes it the portable way to reference media from several pages. Freed
 * handles are skipped rather than thrown from, so one dead entry cannot hide a
 * live one later in the list.
 *
 * Searches the key's whole listing rather than its path map, so an object with
 * no filename metadata is still reachable. Those never enter `files` — there is
 * no path to key them by — and would otherwise be attached to the key yet
 * addressable by nothing.
 */
function keyObjectById(site, id) {
  for (const candidate of (site.objects || Object.values(site.files))) {
    try {
      if (candidate && candidate.id && candidate.id().toLowerCase() === id) {
        return candidate;
      }
    } catch (_) { /* freed handle; skip */ }
  }
  return null;
}

async function resolveStreamSource(siaUrl, siteId) {
  /** Object ID that a key-backed site referenced but does not actually hold. */
  let unattached = null;
  const asSite = parseSiteUrl(siaUrl);
  const bare = bareObjectAddress(siaUrl);
  if (!bare && asSite && /^[0-9a-f]{64}$/i.test(asSite.siteId)) {
    const site = await getSite(asSite.siteId.toLowerCase());
    if (site && site.kind === 'sharing-key' && site.sdk) {
      const path = (asSite.path || '/').replace(/^\/+/, '');
      for (const p of pathForms(path)) {
        if (site.files[p]) return { sdk: site.sdk, obj: site.files[p] };
      }
      // `sialo://<seed>/<objectId>`: the key says who may read, the id says
      // what. Tried after the path forms so a file genuinely named in 64 hex
      // characters still wins, and only for something shaped like an id.
      if (/^[0-9a-f]{64}$/i.test(path)) {
        const byId = keyObjectById(site, path.toLowerCase());
        if (byId) return { sdk: site.sdk, obj: byId };
      }
      throw notInThisSite(path);
    }
  }

  // A published `sia://…/objects/<id>/shared?…` URL embedded in the HTML of a
  // key-backed site. Resolving it as a published URL needs the account SDK —
  // `SharedSdk` has no `objectFromShareUrl` — which a sharing-key recipient
  // does not have, and the request would 502 for them.
  //
  // But the object is almost always attached to the same key as the page that
  // references it, so match it by **object ID** against the key's own objects
  // and serve it through the site's SharedSdk instead. That keeps a shared
  // site readable by someone with no account, which is the entire point of
  // handing out a key.
  if (siteId && /^[0-9a-f]{64}$/i.test(siteId)) {
    // Either spelling of "this object": the id on its own, or the id inside a
    // published URL's path. Both are served from the key's own objects when it
    // holds them, which is what lets an embed work with no account at all.
    const published = siaUrl.match(/\/objects\/([0-9a-f]{64})/i);
    const embedded = bare || (published && published[1].toLowerCase());
    if (embedded) {
      let site = null;
      try {
        site = await getSite(String(siteId).toLowerCase());
      } catch (_) { /* fall through to the account path */ }
      if (site && site.kind === 'sharing-key' && site.sdk) {
        const want = embedded;
        const held = keyObjectById(site, want);
        if (held) return { sdk: site.sdk, obj: held };
        _dbgWarn(
          '[sia-site] embedded published URL is not attached to this sharing key;'
          + ' falling back to the account SDK:', want,
        );
        unattached = want;
      }
    }
  }

  // Falling back to the account is right for a viewer who has one — a
  // published URL resolves fine that way. It cannot work for someone holding
  // only a sharing key, so when that is the situation, say what would fix it
  // rather than reporting a bare connection failure.
  const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
  if (!sdk) {
    if (unattached) {
      const unattachedErr = new Error(
        'This page embeds an object that is not attached to the sharing key '
        + `(${unattached.slice(0, 12)}…), and viewing it that way needs an indexer `
        + 'account. Attach the object to the same key — My Objects → Sharing Key, '
        + 'or Attach… on the Sharing Keys page — and it will load for everyone '
        + 'holding the link.',
      );
      unattachedErr.needsAccount = true;
      throw unattachedErr;
    }
    {
      const e2 = new Error(getLastConnectError() || 'SDK not connected');
      e2.needsAccount = true;
      throw e2;
    }
  }
  // `resolveObject` understands published URLs and bare object ids, but not a
  // `sialo://` address — so hand it the id when that is all the address was.
  const { obj } = await resolveObject(bare || siaUrl, sdk);
  return { sdk, obj };
}

async function streamExternalObject(source, id, siaUrl, offset, length, siteId) {
  if (typeof siaUrl !== 'string') throw new Error('sia-ext-request missing url');

  const opts = downloadOptions(8);
  if (typeof offset === 'number' && offset > 0) opts.offset = offset;
  if (typeof length === 'number' && length > 0) opts.length = length;

  // Setup + first read are retryable: if the WebTransport pool is stale
  // (QUIC idle-timeout), every shard fetch errors out on the first
  // reader.read(). We invalidate the SDK and redial. Once we've sent
  // `sia-ext-meta` we're committed, so the retry window closes there.
  // Cap setup at 30s so a broken WebTransport pool (no hosts reachable)
  // surfaces the error to the SW quickly instead of letting the video
  // element wait minutes for shards that will never arrive.
  const setup = await Promise.race([
    withSdkRetry(async () => {
      const { sdk, obj } = await resolveStreamSource(siaUrl, siteId);
      const totalSize = Number(obj.size());
      const stream = sdk.download(obj, opts);
      const reader = stream.getReader();
      let firstChunk = null;
      let done = false;
      if (!opts.offset) {
        const first = await reader.read();
        if (!first.done && first.value) {
          firstChunk = first.value;
        } else if (first.done) {
          done = true;
        }
      }
      return { reader, totalSize, firstChunk, done };
    }),
    new Promise((_, reject) => setTimeout(
      // Names what to look for rather than only what failed. The usual cause
      // is the browser's own cap on concurrent WebTransport sessions being
      // exhausted — Chrome allows 64 — which the console reports plainly while
      // this layer sees only silence. A firewall dropping UDP looks identical
      // from here, and so does a genuinely unreachable set of hosts.
      () => reject(new Error(
        'No data from any storage host within 30s. Files are fetched over '
        + 'WebTransport; if the console shows "Too many pending WebTransport '
        + 'sessions", the browser ran out of connection slots — reload the tab. '
        + 'A network that blocks UDP produces the same result.',
      )),
      30000,
    )),
  ]);

  const { reader, totalSize, firstChunk, done } = setup;
  let contentType = guessMimeFromSiaUrl(siaUrl);
  if (firstChunk) {
    const sniffed = sniffContentType(firstChunk);
    if (sniffed) contentType = sniffed;
  }

  const entry = { cancelled: false, reader, source };
  activeExtStreams.set(id, entry);

  // Report throughput to the tab's status bar for large streams (video,
  // big PDFs, etc). Small assets don't need a readout, and a percent
  // counter is meaningless here because seeking fires a fresh Range
  // request each time — we'd just reset 0→100 repeatedly. MB/s over a
  // rolling 5 s window stays informative through seeks.
  const PROGRESS_THRESHOLD_BYTES = 4 * 1024 * 1024;
  const showProgress = totalSize >= PROGRESS_THRESHOLD_BYTES;
  const tab = showProgress ? findTabByIframeWindow(source) : null;
  const statusBar = tab ? tabStatusProxy(tab).status : null;
  const kind = contentType.startsWith('video/') ? 'video'
    : contentType.startsWith('audio/') ? 'audio'
    : contentType.startsWith('image/') ? 'image'
    : 'file';
  let bytesSent = 0;
  let lastProgressUpdate = 0;
  const SPEED_WINDOW_MS = 5000;
  const speedSamples = [{ t: performance.now(), bytes: 0 }];
  // Messages that streaming is allowed to overwrite. Anything else
  // (e.g. a "Downloading…" line from an External download) wins and
  // holds the bar until it's cleared. The pre-stream placeholder the
  // browser code writes ("Loading video…") counts as overwritable,
  // otherwise the first streaming update gets stuck and never shows.
  const OVERWRITABLE_RX = /Streaming |Loading video|Loading Sia site|Fetching object|Connecting/;
  function updateProgress() {
    if (!statusBar) return;
    const now = performance.now();
    if (now - lastProgressUpdate < 200) return;
    const current = statusBar.innerHTML || '';
    if (current && !OVERWRITABLE_RX.test(current)) return;
    lastProgressUpdate = now;
    speedSamples.push({ t: now, bytes: bytesSent });
    while (speedSamples.length > 2 && now - speedSamples[0].t > SPEED_WINDOW_MS) {
      speedSamples.shift();
    }
    const oldest = speedSamples[0];
    const windowSec = (now - oldest.t) / 1000;
    const mbs = windowSec > 0 ? ((bytesSent - oldest.bytes) / windowSec / 1e6) : 0;
    statusBar.innerHTML = `<span class="pass">Streaming ${kind}: ${mbs.toFixed(1)} MB/s</span>`;
  }

  // Wrapper so stream-in-flight postMessages don't throw and spam the
  // console when the iframe navigates mid-stream. When the iframe.src
  // changes (e.g. sub-page navigation, the placeholder srcdoc kicks
  // in, or a tab is closed), the source window's current origin no
  // longer matches HOSTED_ORIGIN. Browser raises:
  //
  //   Failed to execute 'postMessage' on 'DOMWindow': The target
  //   origin provided ('https://sandbox.sialo.io') does not match the
  //   recipient window's origin ('https://www.sialo.io').
  //
  // That's not a real failure — the consumer is gone. Cancel the
  // stream so we stop reading more bytes for nothing.
  const post = (msg, transfer) => {
    if (entry.cancelled) return false;
    try {
      if (transfer) source.postMessage(msg, HOSTED_ORIGIN, transfer);
      else source.postMessage(msg, HOSTED_ORIGIN);
      return true;
    } catch (_e) {
      entry.cancelled = true;
      return false;
    }
  };

  try {
    if (!post({ type: 'sia-ext-meta', id, size: totalSize, contentType })) return;
    if (done) {
      post({ type: 'sia-ext-end', id });
      return;
    }
    if (firstChunk) {
      bytesSent += firstChunk.byteLength;
      const buf = firstChunk.buffer.slice(firstChunk.byteOffset, firstChunk.byteOffset + firstChunk.byteLength);
      if (!post({ type: 'sia-ext-chunk', id, chunk: buf }, [buf])) return;
      updateProgress();
    }

    while (!entry.cancelled) {
      const { done: d, value } = await reader.read();
      if (d) break;
      if (entry.cancelled) break;
      bytesSent += value.byteLength;
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      if (!post({ type: 'sia-ext-chunk', id, chunk: buf }, [buf])) return;
      updateProgress();
    }
    if (!entry.cancelled) {
      post({ type: 'sia-ext-end', id });
      if (statusBar) {
        const current = statusBar.innerHTML || '';
        if (!current || OVERWRITABLE_RX.test(current)) {
          statusBar.innerHTML = `<span class="pass">✓ Streamed ${formatSize(bytesSent)} ${kind}</span>`;
        }
      }
    }
  } finally {
    activeExtStreams.delete(id);
  }
}

// Look for magic bytes in the first chunk of a Sia object to decide a
// plausible Content-Type. Covers the common video/image formats we're
// most likely to encounter embedded in a site.
function sniffContentType(bytes) {
  const b = bytes;
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // 'ftyp' at offset 4 → MP4 family. Inspect major brand for a hint.
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith('hei') || brand === 'heix' || brand === 'mif1') return 'image/heic';
    return 'video/mp4';
  }
  if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'video/webm';
  if (b.length >= 4 && b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'application/ogg';
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg'; // ID3
  if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio/mpeg';        // MPEG sync
  // Text sniff — look for <!DOCTYPE or <html near the start.
  if (b.length >= 14) {
    try {
      const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, Math.min(b.length, 512))).toLowerCase();
      if (head.includes('<!doctype html') || head.match(/^\s*<html[\s>]/)) return 'text/html';
    } catch (_) {}
  }
  return null;
}

function guessMimeFromSiaUrl(url) {
  // Published URL path is typically /objects/<id>/shared — no filename hint.
  // Fall back to octet-stream; sniffContentType() will usually override.
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (last.includes('.')) return guessMime(last);
  } catch (_) {}
  return 'application/octet-stream';
}

/**
 * The spellings of a path to try against a site's file map, in order.
 *
 * Paths reach us from the sandbox service worker, which derives them from a
 * real HTTP request URL, so a space is already `%20` and an apostrophe may be
 * `%27` by the time we see one. The file maps are keyed by the name the owner
 * uploaded, punctuation and all, so a raw comparison misses every file whose
 * name is not already URL-safe.
 *
 * The raw form is tried first, so a name that genuinely contains `%20`
 * resolves to itself rather than to its decoded neighbour. Decoding is allowed
 * to fail: `decodeURIComponent` throws on a lone `%`, which is a legal
 * character in a filename.
 */
function pathForms(path) {
  const raw = (path || '').replace(/^\/+/, '');
  const forms = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) forms.push(decoded);
  } catch (_) { /* not valid encoding — the raw form is all we have */ }
  return forms;
}

function resolveManifestKey(manifest, path) {
  const forms = pathForms(path);
  // Exact matches across every spelling first. The root-index fallback below
  // matches any path at all, so running it per-spelling would let the raw
  // form's fallback swallow a decoded name that really is in the site.
  for (const p of forms) {
    if (manifest[p]) return { key: p, objectId: manifest[p] };
  }
  for (const p of forms) {
    for (const key of [p + '/index.html', p.replace(/\/$/, '') + '/index.html', p + '.html']) {
      if (manifest[key]) return { key, objectId: manifest[key] };
    }
  }
  if (manifest['index.html']) return { key: 'index.html', objectId: manifest['index.html'] };
  return null;
}

// Cache of resolved object sizes keyed by the manifest's published URL.
// Populated as auto-index rendering fetches file metadata; lives for
// the page session so navigating between directories of the same site
// doesn't re-request sizes we've already seen.
const sizeCache = new Map();

// Per-file budget for size lookups during auto-index rendering. If
// the indexer is slow, we'd rather render the index with missing
// sizes than hold the whole page response while the sandbox SW's own
// timeout fires. The real resolve still completes in the background
// and populates the cache for the next directory visit.
const SIZE_FETCH_TIMEOUT_MS = 800;

async function resolveSizeOrNull(publishUrl) {
  try {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) return null;
    const { obj } = await resolveObject(publishUrl, sdk);
    const size = Number(obj.size());
    sizeCache.set(publishUrl, size);
    return size;
  } catch {
    return null;
  }
}

async function resolvePublishUrlSize(publishUrl) {
  if (sizeCache.has(publishUrl)) return sizeCache.get(publishUrl);
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), SIZE_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([resolveSizeOrNull(publishUrl), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Pull the validity timestamp out of a sia:// published URL. The `sv`
// query param is the Unix-seconds expiry baked into the signature.
// Returns a Date, or null if the URL doesn't carry one.
function publishUrlExpiry(publishUrl) {
  if (typeof publishUrl !== 'string') return null;
  const m = publishUrl.match(/[?&]sv=(\d+)/);
  if (!m) return null;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return new Date(secs * 1000);
}

// Concise relative text for an auto-index listing: "in 5h", "in 12d",
// "in 8mo", "in 3.4y", "in 100y", or "expired". Always carries units
// so the value is self-describing in the column.
function formatExpiry(date) {
  if (!date) return '';
  const now = Date.now();
  const diffMs = date.getTime() - now;
  if (diffMs <= 0) return 'expired';
  const days = diffMs / 86400000;
  if (days < 1) {
    const hours = Math.max(1, Math.round(diffMs / 3600000));
    return `in ${hours}h`;
  }
  if (days < 30) return `in ${Math.round(days)}d`;
  if (days < 365) return `in ${Math.round(days / 30)}mo`;
  const years = days / 365;
  if (years < 10) return `in ${years.toFixed(1)}y`;
  return `in ${Math.round(years)}y`;
}

// Render a minimal directory-listing page for a site that has no
// index.html at `dirPath`. Files directly in the directory appear as
// links with their size; anything further nested collapses into a
// subdirectory link the user can click to drill into (the service
// worker will land back here with the new path and list that subtree).
async function renderAutoIndex(site, dirPath) {
  const manifest = site.files;
  const keys = Object.keys(manifest).sort();
  const files = [];
  const subdirs = new Set();
  for (const key of keys) {
    if (!key.startsWith(dirPath)) continue;
    const rest = key.slice(dirPath.length);
    if (!rest) continue;
    const slashIdx = rest.indexOf('/');
    if (slashIdx >= 0) subdirs.add(rest.slice(0, slashIdx + 1));
    else files.push(rest);
  }

  // Sizes in parallel. A sharing key already knows them from the listing;
  // the manifest path has to ask the indexer, and swallows failures so a
  // slow lookup shows a blank size cell rather than holding the page.
  const sizePairs = await Promise.all(files.map(async (f) => {
    const ref = manifest[dirPath + f];
    if (ref === undefined) return [f, null];
    try {
      return [f, await site.sizeOf(ref)];
    } catch (_) {
      return [f, null];
    }
  }));
  const sizeByFile = new Map(sizePairs);

  // Two different things are called "expiry" here, and they do not belong in
  // the same place.
  //
  // A manifest site links each file by its own signed `sia://` URL, and those
  // expire independently, so the date is per row.
  //
  // A key-backed site has no per-file expiry at all: access ends when the
  // sharing key ends, one date for the whole link. Rendering that as a column
  // produced a header over two blank cells, which reads as missing data rather
  // than as "not applicable". So the column goes, and the key's own expiry is
  // stated once in the header instead.
  const perFileExpiry = site.kind !== 'sharing-key';
  let linkExpiry;   // Date = expires then, null = never, undefined = unknown
  if (!perFileExpiry && typeof site.keyExpiry === 'function') {
    linkExpiry = await site.keyExpiry();
  }

  const rows = [];
  // Column header so non-textual columns (Size, Expires) read as
  // labels rather than mystery numbers next to a filename.
  rows.push(
    `<li class="header"><span class="name">Name</span><span class="size">Size</span>${
      perFileExpiry ? '<span class="expires">Expires</span>' : ''}</li>`,
  );
  if (dirPath) {
    rows.push(`<li class="up"><a href="../">..</a></li>`);
  }
  for (const d of Array.from(subdirs).sort()) {
    rows.push(`<li class="dir"><a href="${_esc(d)}">${_esc(d)}</a></li>`);
  }
  for (const f of files) {
    // Where a file links to depends on the source. A key-backed site links
    // relatively, so the click is served from inside the site. A manifest
    // links to the published URL, which the injected bridge turns into a
    // SIA_NAVIGATE to the parent, so the outer URL bar and tab history
    // follow along instead of the iframe navigating on its own.
    const ref = manifest[dirPath + f];
    const href = site.hrefFor(f, ref);
    const size = sizeByFile.get(f);
    const sizeLabel = typeof size === 'number' ? _esc(formatSize(size)) : '';
    let expiryCell = '';
    if (perFileExpiry) {
      const expiry = site.expiryOf(ref);
      const expiryLabel = expiry ? _esc(formatExpiry(expiry)) : '';
      const expiryTitle = expiry ? _esc(`Published URL expires ${expiry.toUTCString()}`) : '';
      const expiryClass = expiry && expiry.getTime() <= Date.now() ? 'expires expired' : 'expires';
      expiryCell = `<span class="${expiryClass}" title="${expiryTitle}">${expiryLabel}</span>`;
    }
    rows.push(
      `<li class="file"><a href="${_esc(href)}"><span class="name">${_esc(f)}</span><span class="size">${sizeLabel}</span>${expiryCell}</a></li>`,
    );
  }

  // A named site leads with its name and demotes the path to the subtitle: the
  // name is what a visitor recognises, and for the root directory "Index of /"
  // tells them nothing they did not already know. Unnamed sites are unchanged.
  const siteName = typeof site.name === 'string' ? site.name : '';
  const path = `/${_esc(dirPath)}`;
  const title = siteName ? _esc(siteName) : `Index of ${path}`;
  const docTitle = siteName
    ? `${_esc(siteName)} — ${path}`
    : `Index of ${path}`;
  const count = files.length + subdirs.size;

  // The subtitle carries the link's own expiry for a shared site. Saying
  // nothing when the lookup failed is deliberate: a wrong date here is worse
  // than no date, because the reader would plan around it.
  let sub = siteName
    ? `<span class="path">${path}</span> &middot; ${count} entr${count === 1 ? 'y' : 'ies'}`
    : `${count} entr${count === 1 ? 'y' : 'ies'}`;
  if (!perFileExpiry) {
    if (linkExpiry === null) {
      sub += ' &middot; this link does not expire';
    } else if (linkExpiry instanceof Date) {
      const stamp = _esc(linkExpiry.toUTCString());
      sub += linkExpiry.getTime() <= Date.now()
        ? ` &middot; <span class="expired" title="${stamp}">this link has expired</span>`
        : ` &middot; <span title="${stamp}">this link expires ${_esc(formatExpiry(linkExpiry))}</span>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${docTitle}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.5rem; background: #0a0a0a; color: #d0d0d0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 1px solid #1e1e1e; padding-bottom: 1rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1.4rem; font-weight: 600; color: #e5e5e5; margin: 0 0 0.35rem; font-family: var(--font-mono, ui-monospace, monospace); }
  .sub { color: #6b7280; font-size: 0.85rem; }
  .sub .path { font-family: var(--font-mono, ui-monospace, monospace); }
  h1.named { font-family: system-ui, -apple-system, sans-serif; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-bottom: 1px solid #141414; }
  li:last-child { border-bottom: 0; }
  a { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.5rem; color: #cbd5e1; text-decoration: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.9rem; border-radius: 4px; }
  a:hover { background: #11151a; color: #fff; }
  li.up a { color: #60a5fa; }
  li.dir a::before { content: '📁'; }
  li.file a::before { content: '📄'; }
  li.up a::before { content: '↩'; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .size { color: #6b7280; font-size: 0.8rem; font-variant-numeric: tabular-nums; min-width: 5rem; text-align: right; }
  .expires { color: #6b7280; font-size: 0.75rem; font-variant-numeric: tabular-nums; min-width: 5rem; text-align: right; }
  .expires.expired { color: #f87171; }
  .sub .expired { color: #f87171; }
  li.header { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.5rem 0.4rem 1.65rem; color: #6b7280; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #1e1e1e; }
  li.header .name, li.header .size, li.header .expires { color: #6b7280; font-size: 0.7rem; }
  footer { margin-top: 2rem; color: #4b5563; font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1${siteName ? ' class="named"' : ''}>${title}</h1>
      <div class="sub">${sub}</div>
    </header>
    <ul>
      ${rows.join('\n      ')}
    </ul>
    <footer>Auto-generated by Sialo Browser</footer>
  </div>
</body>
</html>`;
}

/**
 * Loads a site and returns the source the rest of the module works
 * against, whichever kind it is:
 *
 *   files    { path -> ref }   every file in the site
 *   read     (ref) -> bytes    the file's contents
 *   sizeOf   (ref) -> number   bytes, or null when not known yet
 *   hrefFor  (path, ref)       what the auto-index links a file to
 *   expiryOf (ref) -> Date     when the entry stops resolving, or null
 *
 * `siteId` is either a 64 hex character sharing-key seed or a legacy
 * manifest reference (object ID or `sia://` published URL). A seed and a
 * manifest object ID are both 64 hex characters and cannot be told apart
 * by inspection, so a bare hex id is tried as a key first and falls back
 * to a manifest when the indexer does not recognise it.
 */
async function getSite(siteId) {
  const cached = siteCache.get(siteId);
  if (cached) return cached;

  let site = null;
  let keyErr = null;
  if (/^[0-9a-f]{64}$/i.test(siteId)) {
    try {
      site = await keySite(siteId.toLowerCase());
    } catch (e) {
      keyErr = e;
      _dbgWarn('[sia-site] not a sharing key, trying as a manifest:', e.message || e);
    }
  }
  if (!site) {
    try {
      site = await manifestSite(siteId);
    } catch (e) {
      // Both readings failed. The manifest path needs this account's own
      // indexer credentials and says so, which is actively misleading when
      // the user was following a sharing link — that needs no account at
      // all. Report the sharing-key failure instead when there was one.
      if (keyErr) {
        throw new Error(
          `Could not open this site as a sharing key: ${keyErr.message || keyErr}`,
        );
      }
      // A published site resolves its files through the *viewer's* own
      // indexer account — that is what publishing means. Someone who arrived
      // via a sharing key has no account, and connectSdk's "set your Indexer
      // URL and App Key" reads like a misconfiguration rather than the
      // inherent difference between the two ways a site is handed out.
      if (!getUrl() || !getKeyHex()) {
        const err = new Error(
          'This is a published site link, and opening one needs your own '
          + 'indexer account: the viewer resolves the files, so it cannot be '
          + 'read with a sharing key alone.',
        );
        // Flagged so whatever displays this can offer the fix as a button
        // rather than only describing it. Registering is the answer far more
        // often than editing settings, and telling someone to go find a page
        // is worse than handing them a way there.
        err.needsAccount = true;
        throw err;
      }
      throw e;
    }
  }

  siteCache.set(siteId, site);
  _dbg('[sia-site] loaded', site.kind, 'site', String(siteId).slice(0, 16),
       'files:', Object.keys(site.files).length);
  return site;
}

/**
 * A site backed by a sharing key. Connects as the key's recipient, so it
 * works without an account on the indexer and streams through the owner's
 * quota. Sizes come back with the listing, so the auto-index does not have
 * to go looking for them the way the manifest path does.
 */
/**
 * Above this, a site file is streamed through /_sia-ext/ rather than served by
 * value. The by-value path buffers the whole object before replying and its
 * resolve is capped at 30s, so anything that cannot be fetched and held in
 * that window has to stream. Well below the point where buffering gets slow,
 * so the cheap path stays the common one.
 */
const STREAM_MIN_BYTES = 8 * 1024 * 1024;

async function keySite(seed) {
  // Asked of every indexer this browser knows, not just the configured one. A
  // key exists on one indexer and the link cannot say which, so a link created
  // on production has to open for a reader whose settings point at staging —
  // and for a reader with no settings at all, which is the common case for
  // someone following a link they were sent.
  const { sdk } = await connectSharedSdk(seed);

  const objects = await listSharedObjects(sdk);

  const files = {};
  for (const obj of objects) {
    // The object's filename is its path within the site. Uploads made
    // outside the site flow carry a `<uuid>/` grouping prefix; the key
    // already scopes these files, so drop it rather than making every
    // path start with a UUID.
    const name = filenameForDisplay(obj.metadata()) || '';
    const path = stripUploadUuid(name).replace(/^\/+/, '');
    if (!path) continue;
    files[path] = obj;
  }

  return {
    kind: 'sharing-key',
    files,
    // Every object the key grants, including those `files` dropped for having
    // no filename metadata. A path map cannot represent those at all, but an
    // address that names an object by id can, and that is exactly the case the
    // id form exists for: media attached to a key without ever being given a
    // path within it.
    objects,
    // Exposed so the streaming route can reuse this connection. It is a
    // SharedSdk built from the seed alone, which is the whole point: the
    // holder of a sharing key has no account here, so anything serving their
    // files must go through this rather than connectSdk.
    sdk,
    read: (obj) => withSdkRetry(() => readStreamFully(sdk.download(obj))),
    sizeOf: (obj) => Number(obj.size()),
    // Relative, so a click is handled inside the site and an index.html can
    // link its neighbours with ordinary relative URLs. Large files are NOT
    // linked at /_sia-ext/ directly: that would make it a top-level
    // navigation, and the sandbox service worker keys that route off
    // `e.clientId`, which is empty for a navigation request. It only works as
    // a subresource. resolveSitePath serves a small page that embeds it
    // instead — see renderStreamPage.
    hrefFor: (path) => path,
    /** The streaming URL for a path, for embedding as a subresource. */
    streamHrefFor: (path) => '/_sia-ext/' + encodeURIComponent(siteUrl(seed, path)),
    // A shared file has no expiry of its own: access ends when the key ends.
    // The per-row column is therefore always blank here, which is why the
    // auto-index drops it for this kind of site and shows `keyExpiry` once.
    expiryOf: () => null,
    /**
     * When the sharing key itself stops granting access, or null when it never
     * does. `undefined` means the lookup failed and nothing should be claimed.
     *
     * Swallows its own errors: this is one extra request made while rendering a
     * listing, and a site that has already loaded must not fail to list because
     * a stats call did.
     */
    keyExpiry: async () => {
      try {
        const stats = await sdk.stats();
        return stats.expiresAt || null;
      } catch (_) {
        return undefined;
      }
    },
  };
}

/**
 * The object behind one path in a site, with the SDK that can read it.
 *
 * Exists so a caller can act on the page a reader is actually looking at —
 * saving it, in particular — without knowing how the site is put together.
 * Both kinds resolve here: a key-backed site hands back a handle its own
 * SharedSdk already decrypted, and a manifest site hands back the object its
 * recorded published URL names, resolved through the viewer's account.
 *
 * That difference is the whole point. A key holder has no account, so routing
 * their save through `connectSdk` asks them to register for content the link
 * they followed already grants.
 *
 * Path resolution is the same one the loader uses, so `/` lands on the site's
 * index and a directory lands on its `index.html`, rather than failing on an
 * address the reader plainly arrived at.
 */
export async function siteObjectAt(siteId, path) {
  const site = await getSite(String(siteId).toLowerCase());
  const wanted = String(path || '/').replace(/^\/+/, '');
  const hit = resolveManifestKey(site.files, wanted);
  if (!hit) throw notInThisSite(wanted || '/');

  if (site.kind === 'sharing-key' && site.sdk) {
    return { sdk: site.sdk, obj: hit.objectId, path: hit.key };
  }

  const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
  if (!sdk) {
    const err = new Error(
      'Saving a file from a published site resolves it through your own indexer '
      + 'account, the same way viewing it does.',
    );
    err.needsAccount = true;
    throw err;
  }
  const { obj } = await resolveObject(hit.objectId, sdk);
  return { sdk, obj, path: hit.key };
}

/**
 * The files a site holds, flattened for callers that act on objects rather
 * than render pages — pinning, in particular.
 *
 * `kind` says what each `ref` is: a `sharing-key` site hands back object
 * handles the key already decrypted, while a `manifest` site hands back the
 * published URL recorded for that path. Both are enough to pin from, but they
 * need different treatment, so the kind travels with them.
 *
 * Shares `getSite`'s cache, so asking right after viewing a site costs nothing.
 */
export async function siteEntries(siteId) {
  const site = await getSite(siteId);
  return {
    kind: site.kind,
    entries: Object.keys(site.files).sort().map((path) => ({ path, ref: site.files[path] })),
  };
}

/** A site backed by a legacy manifest object of `{ path -> publishUrl }`. */
async function manifestSite(manifestId) {
  const { files, name } = await getManifest(manifestId);
  return {
    kind: 'manifest',
    files,
    // What the site calls itself, for the generated index heading. Empty for
    // every manifest written before names existed.
    name,
    read: (publishUrl) => fetchObject(publishUrl),
    sizeOf: (publishUrl) => resolvePublishUrlSize(publishUrl),
    // Published URLs are absolute; the injected bridge turns a `sia://`
    // href into a parent navigation so the outer tab tracks it.
    hrefFor: (path, publishUrl) => publishUrl || path,
    /**
     * The streaming URL for a path, for embedding as a subresource. The
     * manifest already holds a signed URL per file, and /_sia-ext/ has always
     * carried exactly that, so this needs no new resolution machinery.
     */
    streamHrefFor: (path) => {
      const url = files[path];
      return url ? '/_sia-ext/' + encodeURIComponent(url) : null;
    },
    expiryOf: (publishUrl) => publishUrlExpiry(publishUrl),
  };
}

async function fetchObject(objectId) {
  const cached = objectCache.get(objectId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) {
      const e2 = new Error(getLastConnectError() || 'SDK not connected');
      e2.needsAccount = true;
      throw e2;
    }
    const { obj } = await resolveObject(objectId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  objectCache.set(objectId, data);
  return data;
}

// Only version 1 is supported. Older legacy formats (unversioned flat
// maps, bare-object-ID entries) were dropped — any site published
// before the envelope existed needs to be re-uploaded.
// The `type` field inside a published site's manifest JSON. This is a wire
// format, not a URL scheme: manifests already stored on Sia carry the literal
// string "sia-site", and those bytes cannot be rewritten. Renaming the URL
// scheme deliberately does NOT rename this, or every site published before
// the rename would fail validation and become unloadable.
const MANIFEST_TYPE = 'sia-site';
const MANIFEST_VERSION = 1;

/**
 * Wrap a `{ path -> publishUrl }` map in the versioned manifest envelope
 * produced by this client. Exposed so the CLI / other callers use the
 * same shape.
 */
export function buildSiaSiteManifest(files, name) {
  const manifest = { type: MANIFEST_TYPE, version: MANIFEST_VERSION };
  // Omitted when absent rather than written as an empty string, so a site with
  // no name serialises exactly as it did before this field existed.
  if (typeof name === 'string' && name.trim().length > 0) {
    manifest.name = name.trim().slice(0, MANIFEST_NAME_MAX);
  }
  manifest.files = files;
  return manifest;
}

/**
 * Cap on a site name, applied when writing and again when reading.
 *
 * A manifest is fetched from the network and its name is rendered into a
 * generated page's heading, so its length is not something to take on trust.
 */
export const MANIFEST_NAME_MAX = 120;

/**
 * Parse and validate a v1 sia-site manifest. Returns the flat
 * `{ path -> publishUrl }` map the rest of the code works with.
 */
function parseManifest(data) {
  let m;
  try {
    m = JSON.parse(new TextDecoder().decode(data));
  } catch (e) {
    throw new Error('manifest is not valid JSON: ' + e.message);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('manifest is not a JSON object');
  }
  if (m.type !== MANIFEST_TYPE) {
    throw new Error(`not a sia-site manifest (type=${JSON.stringify(m.type)})`);
  }
  if (typeof m.version !== 'number') throw new Error('sia-site manifest missing `version`');
  if (m.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported sia-site manifest version ${m.version} (expected ${MANIFEST_VERSION})`);
  }
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) {
    throw new Error('sia-site manifest missing `files` map');
  }
  for (const [k, v] of Object.entries(m.files)) {
    if (typeof v !== 'string' || !v.startsWith('sia://')) {
      throw new Error(`manifest entry \`${k}\` is not a sia:// published URL`);
    }
  }
  // Read back defensively: `name` comes off the network, so a non-string or an
  // over-long value is ignored rather than propagated into a page heading.
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, MANIFEST_NAME_MAX) : '';
  return { files: m.files, name };
}

async function getManifest(manifestId) {
  const cached = manifestCache.get(manifestId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) {
      const e2 = new Error(getLastConnectError() || 'SDK not connected');
      e2.needsAccount = true;
      throw e2;
    }
    const { obj } = await resolveObject(manifestId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  const parsed = parseManifest(data);
  manifestCache.set(manifestId, parsed);
  _dbg('[sia-site] loaded manifest', manifestId.slice(0, 16),
    'entries:', Object.keys(parsed.files).length, parsed.name ? `name: ${parsed.name}` : '');
  return parsed;
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

// Reports scroll direction from inside a site back to the app, so the app
// can slide its address bar out of the way while the reader scrolls down.
//
// This is inlined into the page rather than added to the bridge file because
// the bridge is served by the sandbox origin, which is deployed separately
// from this app; inlining keeps the behaviour shipping with the code that
// consumes it. Direction and hysteresis are decided here so a scroll only
// costs a postMessage when the desired state actually flips, rather than on
// every frame of a long scroll.
const SCROLL_REPORTER = [
  '(function(){',
  'var last=0,hidden=false,ticking=false;',
  'function pos(){var e=document.scrollingElement||document.documentElement;return e?e.scrollTop:0;}',
  'function update(){',
  'ticking=false;',
  'var cur=pos(),want=hidden;',
  // Near the top always show, so a short page can never strand the bar
  // offscreen. The 6px deadzone keeps trackpad jitter from flapping it.
  'if(cur<=8){want=false;}',
  'else if(cur>last+6){want=true;}',
  'else if(cur<last-6){want=false;}',
  'else{return;}',
  'last=cur;',
  'if(want!==hidden){hidden=want;',
  "try{parent.postMessage({type:'sia-scroll-chrome',hidden:hidden},'*');}catch(e){}}",
  '}',
  "addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(update);}},{passive:true});",
  '})();',
].join('');

/**
 * A standalone page for a file too large to serve by value.
 *
 * Media gets a player, everything else a download link. Either way the actual
 * bytes come from `href` (a /_sia-ext/ URL) as a **subresource**, which is the
 * only form the sandbox service worker can serve: it resolves that route via
 * `e.clientId`, and a navigation request has no client. That is why the file
 * is not linked there directly.
 */
/**
 * Detects a file whose audio decodes but whose video does not.
 *
 * The give-away is metadata loading successfully with `videoWidth === 0`: the
 * container and audio track were understood, the video track was not. That is
 * what an Ogg/Theora file does in any current browser — Chrome dropped Theora
 * in 123 — and it presents as a player that emits sound over a blank frame,
 * which reads as a broken app rather than an unsupported codec.
 *
 * Checked by observation rather than a codec table, so it catches anything
 * undecodable, not just the cases anyone thought to list.
 */
const NO_VIDEO_TRACK_PROBE = [
  '(function(){',
  "var v=document.getElementById('p'),n=document.getElementById('novid');",
  'if(!v||!n)return;',
  'function check(){',
  'if(v.readyState<1)return;',
  'if(v.videoWidth>0){n.hidden=true;return;}',
  'n.hidden=false;',
  "n.textContent='This file\\u2019s audio plays but its video cannot be decoded by this "
    + "browser \\u2014 an .ogv is almost always Theora, which Chrome removed in version 123. "
    + "Re-encode to MP4 (H.264 + AAC) or WebM (VP9 + Opus) to make it playable.';",
  '}',
  "v.addEventListener('loadedmetadata',check);",
  "v.addEventListener('loadeddata',check);",
  "v.addEventListener('playing',check);",
  '})();',
].join('');

function renderStreamPage(name, href, size, type) {
  const kind = type.startsWith('video/') ? 'video'
    : type.startsWith('audio/') ? 'audio'
    : type.startsWith('image/') ? 'image'
    : 'file';
  const player = kind === 'video'
    ? `<video id="p" controls playsinline preload="metadata" src="${_esc(href)}"></video>`
      + '<div id="novid" class="novid" hidden></div>'
      + '<scr' + 'ipt>' + NO_VIDEO_TRACK_PROBE + '</scr' + 'ipt>'
    : kind === 'audio'
      ? `<audio controls preload="metadata" src="${_esc(href)}"></audio>`
      : kind === 'image'
        ? `<img src="${_esc(href)}" alt="${_esc(name)}">`
        : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${_esc(name)}</title>
<style>
  html,body{margin:0;background:#0a0a0a;color:#e2e8f0;
    font-family:system-ui,-apple-system,sans-serif;height:100%}
  body{display:flex;flex-direction:column}
  header{padding:.7rem 1rem;border-bottom:1px solid #222;display:flex;
    align-items:baseline;gap:.6rem;flex-wrap:wrap}
  h1{margin:0;font-size:.95rem;font-weight:600;word-break:break-all}
  .size{color:#7a8390;font-size:.8rem}
  main{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:0;padding:1rem}
  video,audio,img{max-width:100%;max-height:100%}
  audio{width:min(560px,100%)}
  a.dl{color:#4ade80;font-size:.9rem}
  .novid{margin-top:1rem;max-width:52ch;padding:.8rem 1rem;border-radius:8px;
    border:1px solid rgba(234,179,8,.4);background:rgba(234,179,8,.08);
    color:#d9c07a;font-size:.85rem;line-height:1.5;text-align:left}
  p.note{color:#7a8390;font-size:.8rem;max-width:52ch;line-height:1.5;
    text-align:center}
</style></head><body>
<header>
  <h1>${_esc(name)}</h1><span class="size">${_esc(formatSize(size))}</span>
  <a class="dl" href="${_esc(href)}" download="${_esc(name)}"
     style="margin-left:auto">Download</a>
</header>
<main>${player || `<p class="note">This file is ${_esc(formatSize(size))}, too large to
  render inline. Use Download above — it streams rather than loading the whole
  file into memory.</p>`}</main>
</body></html>`;
}

function injectBridge(html) {
  const tag = '<script src="/_sia-bridge.js"></' + 'script>'
    + '<script>' + SCROLL_REPORTER + '</' + 'script>';
  // Prefer to inject right after <head> so the bridge initialises before
  // any page scripts make their own fetches.
  const m = html.match(/<head[^>]*>/i);
  if (m) {
    const idx = m.index + m[0].length;
    return html.slice(0, idx) + tag + html.slice(idx);
  }
  // Pages without a <head> (simple HTML fragments): prepend.
  return tag + html;
}

function guessMime(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const m = {
    html: 'text/html', htm: 'text/html',
    js: 'application/javascript', mjs: 'application/javascript',
    css: 'text/css', json: 'application/json', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mov: 'video/quicktime',
    ogv: 'video/ogg',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', m2v: 'video/mpeg',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus', weba: 'audio/webm',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
    wasm: 'application/wasm',
    txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
    csv: 'text/csv', log: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
    vtt: 'text/vtt', srt: 'text/plain',
    zip: 'application/zip',
  };
  return m[ext] || 'application/octet-stream';
}

/**
 * Formats a browser is handed happily but cannot actually decode, so a tab
 * shows a black video frame or a broken-image icon rather than the file.
 * Knowing the Content-Type is not the same as being able to play it, which is
 * why this is a separate list from `guessMime` rather than a filter over it.
 */
const UNDECODABLE = new Set([
  'video/mpeg', 'video/x-matroska', 'video/x-msvideo', 'video/x-ms-wmv',
  'image/tiff', 'image/heic',
]);

/**
 * Whether the app can show this filename in a tab rather than only save it.
 *
 * Callers use this to decide whether to offer opening. It is derived from the
 * same table that decides the Content-Type the file would be served with, so
 * the two cannot drift — a divergent second list is what previously left
 * ordinary videos with no way to open them.
 */
export function canRenderInTab(path) {
  const mime = guessMime(path || '');
  if (mime === 'application/octet-stream') return false;
  if (mime === 'application/zip' || mime === 'application/wasm') return false;
  if (mime.startsWith('font/')) return false;
  return !UNDECODABLE.has(mime);
}

/**
 * Point an iframe at a Sia-hosted site. The iframe is rebound to the
 * sandbox origin and the bootstrap page installs the service worker.
 * Subsequent fetches are served via the bridge.
 *
 * The iframe's sandbox attribute must allow same-origin so a service
 * worker can be registered from within it; isolation comes from the
 * origin difference between the main app and the sandbox origin, not
 * from the sandbox attribute.
 */
// Inline placeholder shown while the bootstrap fetch is in flight.
// Replaces whatever the iframe was previously displaying so a stalled
// or 502-ing bootstrap doesn't leave the user staring at the previous
// site's content (which made navigation look like it had silently
// rolled back to the homepage).
const SITE_LOADING_HTML =
  '<!doctype html><meta charset="utf-8">' +
  '<style>html,body{margin:0;background:#0a0a0a;color:#888;' +
  'font-family:system-ui,-apple-system,sans-serif;display:flex;' +
  'align-items:center;justify-content:center;height:100%;font-size:0.9rem;}' +
  '</style><body>Loading site…';

export function loadSite(iframeEl, siteId, subpath) {
  if (!iframeEl) throw new Error('iframe required');
  if (!siteId) throw new Error('siteId required');
  if (!handlerInstalled) initSiaSiteHandler();

  iframeSites.set(iframeEl, siteId);
  handshaken.delete(iframeEl);

  // SWs require same-origin context; isolation comes from the separate
  // sandbox origin, not from an opaque iframe sandbox.
  iframeEl.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
  );
  // Optional: an in-site path to land on instead of the default `/`.
  // Used when the user navigates back to a site they had drilled into,
  // so they return to the sub-page rather than the root. Encoded in
  // the bootstrap URL hash; the bootstrap reads and location.replace's
  // into it.
  const hashFragment = (subpath && subpath !== '/' && subpath.startsWith('/'))
    ? '#' + encodeURIComponent(subpath)
    : '';
  // Render the placeholder synchronously, then swap to the real
  // bootstrap on the next frame. srcdoc takes precedence over src per
  // spec, so we have to remove it before the bootstrap navigation
  // commits. The animation-frame gap is short enough to be invisible
  // when the bootstrap fetch is healthy, and meaningful when it
  // stalls — the user keeps seeing the loader instead of the previous
  // site's HTML.
  iframeEl.srcdoc = SITE_LOADING_HTML;
  requestAnimationFrame(() => {
    iframeEl.removeAttribute('srcdoc');
    iframeEl.src = HOSTED_ORIGIN + '/_sia-bootstrap.html?t=' + Date.now() + hashFragment;
  });
}

/**
 * True when the given iframe is currently bound to a Sia-hosted site —
 * i.e. the tab-level Back button should delegate to the iframe's own
 * history via postMessage rather than reloading a new URL.
 */
export function isSiaSiteIframe(iframeEl) {
  return !!(iframeEl && iframeSites.has(iframeEl));
}

/**
 * Ask the iframe to step back in its own same-origin history. Silent
 * no-op if the iframe has no prior entry.
 */
export function siaBack(iframeEl) {
  if (!iframeEl || !iframeEl.contentWindow) return;
  try {
    iframeEl.contentWindow.postMessage({ type: 'sia-nav-back' }, HOSTED_ORIGIN);
  } catch (_) {}
}

/**
 * Ask the iframe to step forward in its own same-origin history.
 */
export function siaForward(iframeEl) {
  if (!iframeEl || !iframeEl.contentWindow) return;
  try {
    iframeEl.contentWindow.postMessage({ type: 'sia-nav-forward' }, HOSTED_ORIGIN);
  } catch (_) {}
}

/**
 * Release the mapping and cached depth when a tab is reused for
 * non-Sia-site content or closed.
 */
export function unloadSite(iframeEl) {
  if (!iframeEl) return;
  iframeSites.delete(iframeEl);
  handshaken.delete(iframeEl);
}

/**
 * Uploads a set of files as a Sia site and returns its manifest.
 *
 * This is the publishing path: each file is uploaded and pinned, then a
 * JSON manifest mapping paths to signed `sia://` published URLs is uploaded
 * and its id returned. The manifest is portable — any account can resolve
 * it — and the URLs stop working when their signatures expire.
 *
 * To hand the same files out as a revocable credential instead, attach them
 * to a sharing key; `keySite` in this module loads a site that way.
 *
 *   await uploadSite(sdk, [
 *     { path: 'index.html', data: htmlBytes },
 *     { path: 'app.js', data: jsBytes },
 *     { path: 'assets/logo.png', data: pngBytes },
 *   ]);
 */
export async function uploadSite(sdk, files, name) {
  const manifest = {};
  const validUntil = new Date(Date.now() + SITE_PUBLISH_VALIDITY_MS);
  // UUID-prefix every object's filename metadata so all artifacts from a
  // single publish session group together alphabetically in My Objects.
  // Site Builder strips the prefix when re-using them, and so does the
  // key-backed site loader.
  const uploadId = crypto.randomUUID();
  for (const { path, data } of files) {
    const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
    const pinned = new PinnedObject();
    pinned.updateMetadata(encodeMetadata({ filename: `${uploadId}/${path}` }));
    const obj = await sdk.upload(pinned, new Blob([raw]).stream());
    await sdk.pinObject(obj);
    manifest[path] = sdk.objectShareUrl(obj, validUntil);
    _dbg('[sia-site] uploaded', path, '→', obj.id());
  }
  const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest, name), null, 2);
  const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
  const manifestPinned = new PinnedObject();
  manifestPinned.updateMetadata(
    encodeMetadata({ filename: `${uploadId}/manifest.json`, siteName: name }),
  );
  const manifestObj = await sdk.upload(manifestPinned, manifestBlob.stream());
  await sdk.pinObject(manifestObj);
  const manifestId = manifestObj.id();
  _dbg('[sia-site] manifest', manifestId);
  return { manifestId, manifest };
}

/** The `sialo://` address for a key-backed site, optionally at a path. */
export function siteUrl(seed, path) {
  const rest = (path || '').replace(/^\/+/, '');
  return `sialo://${seed}/${rest}`;
}

/**
 * Fragment parameter carrying a whole published `sialo://` address, so a
 * published site can be handed out as an ordinary app link that loads on open
 * — the counterpart to a sharing key's `#sharing_key=…&site=1` link.
 *
 * The address is percent-encoded because a published URL carries its own
 * `#encryption_key=` fragment and has to nest inside this one. As with a
 * sharing-key link, everything sensitive stays in the fragment, which
 * browsers never send to a server.
 */
export const SITE_URL_PARAM = 'site_url';

/** The fragment for a published-site link, without the leading `#`. */
export function publishedSiteFragment(siaSiteUrl) {
  return `${SITE_URL_PARAM}=${encodeURIComponent(siaSiteUrl)}`;
}

/**
 * A link that loads a published site directly. Points at the app rather than
 * share.html, because rendering a site needs the sandboxed iframe that only
 * the app has.
 */
export function publishedSiteLink(siaSiteUrl, base) {
  const page = (base || new URL('.', location.href).href).replace(/#.*$/, '');
  return `${page}#${publishedSiteFragment(siaSiteUrl)}`;
}

/**
 * Reads a published-site link's fragment. Accepts it with or without the
 * leading `#`, so `location.hash` can be passed straight in. Returns null
 * when the fragment does not carry one, which is the common case.
 *
 * The address is checked to be `sialo://` before it is returned: this
 * value drives a navigation, so anything else — a `javascript:` or `http:`
 * URL smuggled into the fragment — must not be handed onward.
 */
export function parsePublishedSiteFragment(fragment) {
  if (!fragment) return null;
  const params = new URLSearchParams(String(fragment).replace(/^#/, ''));
  const url = (params.get(SITE_URL_PARAM) || '').trim();
  // Shape, not just scheme: `sialo://settings` passes a scheme test and would
  // open an internal panel from a crafted link.
  if (!isSiteAddress(url)) return null;
  return { url };
}

/**
 * Splits a `sialo://` address into the site and the path inside it.
 * Returns null when the input is not one.
 */
export function parseSiteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^sialo:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (!m) return null;
  return { siteId: m[1], path: m[2] || '/' };
}
