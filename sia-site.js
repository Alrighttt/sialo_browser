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
// Manifest format (version 1):
//   { "type": "sia-site", "version": 1, "files": {
//       "index.html": "sia://...?sv=...#encryption_key=...",
//       "app.js":     "sia://...", ...
//   }}
//
// Values are full `sia://` share URLs so the site is portable: any
// account can resolve and decrypt each entry using the signature +
// encryption key embedded in the URL.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { _dbg, _dbgWarn, _esc, formatSize } from './utils.js';
import { connectSdk, resolveObject, invalidateSdk, getLastConnectError } from './config.js';
import { findTabByIframeWindow, tabStatusProxy } from './tabs.js';
import { encodeMetadata } from './object-metadata.js';

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

const manifestCache = new Map(); // manifestId → { "path": shareUrl, ... }
const objectCache = new Map();   // shareUrl → Uint8Array

// Share URLs baked into site manifests should outlive the lifetime of
// the site. 100 years from upload time is effectively "forever" from
// a user perspective and stays well inside JavaScript's Date range.
const SITE_SHARE_VALIDITY_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// In-flight external-object streams, keyed by request id. Looked up by
// the onMessage handler when the SW cancels a fetch (e.g. the browser
// aborted a progressive download to issue a Range request on seek).
const activeExtStreams = new Map(); // id → { cancelled: boolean, reader }

// iframe element → manifestId. Each tab's iframe is independently bound
// to whichever Sia site it was told to load, so a single main app can
// host multiple Sia sites at once in different tabs.
const iframeManifests = new WeakMap();

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
  const manifestId = iframeManifests.get(iframe) || null;

  switch (d.type) {
    case 'sia-bridge-ready':
      if (!manifestId) {
        // The viewer iframe also uses the bridge but has no manifest;
        // acknowledge it so its bootstrap can proceed without blocking.
        e.source.postMessage({ type: 'sia-bridge-ok' }, HOSTED_ORIGIN);
        return;
      }
      handshaken.add(iframe);
      e.source.postMessage({ type: 'sia-bridge-ok' }, HOSTED_ORIGIN);
      return;

    case 'sia-bridge-alive':
      return;

    case 'sia-bridge-page': {
      // Record the iframe's current in-site path on the owning tab's
      // current navHistory entry. When the user later navigates away
      // (e.g. clicks a sia-site:// link to another site) and presses
      // Back, the saved path lets us restore the sub-page they were
      // last viewing instead of dumping them at the site's root.
      // The path itself is never source-of-truth for the iframe's own
      // history — that's still managed inside the iframe via the SW.
      const tab = findTabByIframeWindow(e.source);
      if (!tab) return;
      const entry = tab.navHistory && tab.navHistory[tab.navIndex];
      if (!entry) return;
      // Only stash for sia-site entries; other URL types don't need it.
      if (typeof entry.url !== 'string' || !entry.url.startsWith('sia-site://')) return;
      const path = (typeof d.path === 'string' && d.path) ? d.path : '/';
      const search = typeof d.search === 'string' ? d.search : '';
      const hash = typeof d.hash === 'string' ? d.hash : '';
      entry.subpath = path + search + hash;
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
      // (sia://, sia-site://) that the iframe can't handle itself.
      // Surface it in the parent tab's address bar and kick off the
      // normal navigation flow.
      const target = d.url;
      if (typeof target !== 'string') return;
      if (!/^(sia|sia-site):\/\//i.test(target)) return;
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
      // sia:// or sia-site:// URL that was rewritten to /_sia-ext/<url>
      // in an HTML/CSS response. Stream the bytes back with ranged
      // download support.
      streamExternalObject(e.source, d.id, d.url, d.offset, d.length)
        .catch((err) => {
          try {
            e.source.postMessage(
              { type: 'sia-ext-error', id: d.id, error: err.message || String(err) },
              HOSTED_ORIGIN,
            );
          } catch (_) {}
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
      // Serve the resource from the site's manifest. If this iframe has
      // no manifest binding (e.g. the direct-video viewer), we can't
      // answer these, so just return an error response so the SW can
      // stop waiting.
      if (!manifestId) {
        try {
          e.source.postMessage(
            { type: 'sia-response', id: d.id, error: 'no manifest bound to this iframe' },
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
          resolveManifestPath(manifestId, d.path),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Sia network unreachable (can't fetch shards)")),
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
        const tab = findTabByIframeWindow(e.source);
        if (tab) {
          const statusBar = tabStatusProxy(tab).status;
          statusBar.innerHTML = `<span class="fail">Error: ${_esc(err.message || String(err))}</span>`;
        }
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

function findIframeForSource(source) {
  if (!source) return null;
  const all = document.querySelectorAll('iframe');
  for (const el of all) {
    try { if (el.contentWindow === source) return el; } catch (_) {}
  }
  return null;
}

async function resolveManifestPath(manifestId, path) {
  const manifest = await getManifest(manifestId);
  const lookup = resolveManifestKey(manifest, path);
  if (!lookup) {
    // No file matched AND the request is for a directory-like path
    // (root or trailing slash) — synthesise an index listing from the
    // manifest so the user can browse a site that has no index.html.
    const normalized = (path || '').replace(/^\/+/, '');
    if (normalized === '' || normalized.endsWith('/')) {
      const html = await renderAutoIndex(manifest, normalized);
      const injected = injectBridge(html);
      const body = new TextEncoder().encode(injected).buffer;
      return { body, contentType: 'text/html' };
    }
    throw new Error('not in manifest: ' + path);
  }
  const data = await fetchObject(lookup.objectId);

  const contentType = guessMime(lookup.key);
  let body;
  if (contentType === 'text/html') {
    // Inject the bridge script and rewrite subresource references.
    // Two passes:
    //   1. Explicit sia:// / sia-site:// URLs → /_sia-ext/<encoded>
    //      (the iframe SW streams bytes through a same-origin Response
    //      with Range support, so <video src="sia://..."> seeks).
    //   2. Absolute paths (/foo.js, /_next/...) that resolve against
    //      the manifest → same /_sia-ext/ route. Without this, framework
    //      builds with absolute asset paths blank-screen because the
    //      sandbox origin doesn't have those files.
    const html = new TextDecoder().decode(data);
    let rewritten = rewriteSiaUrlsInHtml(html);
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

// Rewrite raw sia:// / sia-site:// URLs in HTML attributes to the
// same-origin /_sia-ext/<encoded-url> path that the SW intercepts.
// We deliberately skip <a href> so full-page link clicks still fall
// through to the parent's sia-navigate intercept (user-visible tab
// navigation, not inline rendering).
function rewriteSiaUrlsInHtml(html) {
  // src / poster / data / formaction on any element.
  html = html.replace(
    /\b(src|poster|data|formaction)\s*=\s*(["'])(sia(?:-site)?:\/\/[^"'<>\s]+)\2/gi,
    (_, attr, q, url) => attr + '=' + q + '/_sia-ext/' + encodeURIComponent(url) + q,
  );
  // <link ... href="sia://..."> — stylesheets, preloads, icons, etc.
  html = html.replace(
    /<link\b([^>]*?)\bhref\s*=\s*(["'])(sia(?:-site)?:\/\/[^"'<>\s]+)\2/gi,
    (_, rest, q, url) => '<link' + rest + 'href=' + q + '/_sia-ext/' + encodeURIComponent(url) + q,
  );
  // Inline style="...: url(sia://...)".
  html = html.replace(
    /style\s*=\s*(["'])([^"']*)\1/gi,
    (_m, q, css) => 'style=' + q + rewriteSiaUrlsInCss(css) + q,
  );
  // <source srcset> / <img srcset> — comma-separated list.
  html = html.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_m, q, set) => {
      const rewritten = set.replace(
        /(sia(?:-site)?:\/\/[^\s,]+)/gi,
        (u) => '/_sia-ext/' + encodeURIComponent(u),
      );
      return 'srcset=' + q + rewritten + q;
    },
  );
  return html;
}

function rewriteSiaUrlsInCss(css) {
  return css.replace(
    /url\(\s*(["']?)(sia(?:-site)?:\/\/[^"'\s)]+)\1\s*\)/gi,
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
async function streamExternalObject(source, id, siaUrl, offset, length) {
  if (typeof siaUrl !== 'string') throw new Error('sia-ext-request missing url');

  const opts = { maxInflight: 8 };
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
      const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
      if (!sdk) throw new Error(getLastConnectError() || 'SDK not connected');
      const { obj } = await resolveObject(siaUrl, sdk);
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
      () => reject(new Error("Sia network unreachable (can't fetch first shard)")),
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

  try {
    source.postMessage({ type: 'sia-ext-meta', id, size: totalSize, contentType }, HOSTED_ORIGIN);
    if (done) {
      source.postMessage({ type: 'sia-ext-end', id }, HOSTED_ORIGIN);
      return;
    }
    if (firstChunk) {
      bytesSent += firstChunk.byteLength;
      const buf = firstChunk.buffer.slice(firstChunk.byteOffset, firstChunk.byteOffset + firstChunk.byteLength);
      source.postMessage({ type: 'sia-ext-chunk', id, chunk: buf }, HOSTED_ORIGIN, [buf]);
      updateProgress();
    }

    while (!entry.cancelled) {
      const { done: d, value } = await reader.read();
      if (d) break;
      if (entry.cancelled) break;
      bytesSent += value.byteLength;
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      source.postMessage({ type: 'sia-ext-chunk', id, chunk: buf }, HOSTED_ORIGIN, [buf]);
      updateProgress();
    }
    if (!entry.cancelled) {
      source.postMessage({ type: 'sia-ext-end', id }, HOSTED_ORIGIN);
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
// most likely to encounter embedded in a sia-site.
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
  // Share URL path is typically /objects/<id>/shared — no filename hint.
  // Fall back to octet-stream; sniffContentType() will usually override.
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (last.includes('.')) return guessMime(last);
  } catch (_) {}
  return 'application/octet-stream';
}

function resolveManifestKey(manifest, path) {
  // Normalise: drop any leading slashes; empty path means the root.
  const p = (path || '').replace(/^\/+/, '');
  const candidates = [
    p,
    p + '/index.html',
    p.replace(/\/$/, '') + '/index.html',
    p + '.html',
    'index.html',
  ];
  for (const key of candidates) {
    if (manifest[key]) return { key, objectId: manifest[key] };
  }
  return null;
}

// Cache of resolved object sizes keyed by the manifest's share URL.
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

async function resolveSizeOrNull(shareUrl) {
  try {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) return null;
    const { obj } = await resolveObject(shareUrl, sdk);
    const size = Number(obj.size());
    sizeCache.set(shareUrl, size);
    return size;
  } catch {
    return null;
  }
}

async function resolveShareUrlSize(shareUrl) {
  if (sizeCache.has(shareUrl)) return sizeCache.get(shareUrl);
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), SIZE_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([resolveSizeOrNull(shareUrl), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Pull the validity timestamp out of a sia:// share URL. The `sv`
// query param is the Unix-seconds expiry baked into the signature.
// Returns a Date, or null if the URL doesn't carry one.
function shareUrlExpiry(shareUrl) {
  if (typeof shareUrl !== 'string') return null;
  const m = shareUrl.match(/[?&]sv=(\d+)/);
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

// Render a minimal directory-listing page for a sia-site that has no
// index.html at `dirPath`. Files directly in the directory appear as
// links with their size; anything further nested collapses into a
// subdirectory link the user can click to drill into (the service
// worker will land back here with the new path and list that subtree).
async function renderAutoIndex(manifest, dirPath) {
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

  // Fetch sizes for this directory's files in parallel. Each resolve
  // is try/caught inside `resolveShareUrlSize`, so a single failure
  // just shows a blank size cell — the index still renders.
  const sizePairs = await Promise.all(files.map(async (f) => {
    const shareUrl = manifest[dirPath + f];
    return [f, shareUrl ? await resolveShareUrlSize(shareUrl) : null];
  }));
  const sizeByFile = new Map(sizePairs);

  const rows = [];
  // Column header so non-textual columns (Size, Expires) read as
  // labels rather than mystery numbers next to a filename.
  rows.push(
    `<li class="header"><span class="name">Name</span><span class="size">Size</span><span class="expires">Expires</span></li>`,
  );
  if (dirPath) {
    rows.push(`<li class="up"><a href="../">..</a></li>`);
  }
  for (const d of Array.from(subdirs).sort()) {
    rows.push(`<li class="dir"><a href="${_esc(d)}">${_esc(d)}</a></li>`);
  }
  for (const f of files) {
    // File link points at the manifest's share URL (not a relative
    // path). The injected bridge script catches `sia://` hrefs and
    // posts SIA_NAVIGATE to the parent, which navigates the Sialo tab
    // — so the outer URL bar, back/forward, and tab state all update
    // instead of the iframe navigating internally.
    const shareUrl = manifest[dirPath + f];
    const href = shareUrl || f;
    const size = sizeByFile.get(f);
    const sizeLabel = typeof size === 'number' ? _esc(formatSize(size)) : '';
    const expiry = shareUrlExpiry(shareUrl);
    const expiryLabel = expiry ? _esc(formatExpiry(expiry)) : '';
    const expiryTitle = expiry ? _esc(`Share URL expires ${expiry.toUTCString()}`) : '';
    const expiryClass = expiry && expiry.getTime() <= Date.now() ? 'expires expired' : 'expires';
    rows.push(
      `<li class="file"><a href="${_esc(href)}"><span class="name">${_esc(f)}</span><span class="size">${sizeLabel}</span><span class="${expiryClass}" title="${expiryTitle}">${expiryLabel}</span></a></li>`,
    );
  }

  const title = `Index of /${_esc(dirPath)}`;
  const count = files.length + subdirs.size;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.5rem; background: #0a0a0a; color: #d0d0d0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 1px solid #1e1e1e; padding-bottom: 1rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1.4rem; font-weight: 600; color: #e5e5e5; margin: 0 0 0.35rem; font-family: var(--font-mono, ui-monospace, monospace); }
  .sub { color: #6b7280; font-size: 0.85rem; }
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
  li.header { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.5rem 0.4rem 1.65rem; color: #6b7280; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #1e1e1e; }
  li.header .name, li.header .size, li.header .expires { color: #6b7280; font-size: 0.7rem; }
  footer { margin-top: 2rem; color: #4b5563; font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${title}</h1>
      <div class="sub">${count} entr${count === 1 ? 'y' : 'ies'}</div>
    </header>
    <ul>
      ${rows.join('\n      ')}
    </ul>
    <footer>Auto-generated by Sialo Browser</footer>
  </div>
</body>
</html>`;
}

async function fetchObject(objectId) {
  const cached = objectCache.get(objectId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) throw new Error(getLastConnectError() || 'SDK not connected');
    const { obj } = await resolveObject(objectId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  objectCache.set(objectId, data);
  return data;
}

// Only version 1 is supported. Older legacy formats (unversioned flat
// maps, bare-object-ID entries) were dropped — any site published
// before the envelope existed needs to be re-uploaded.
const MANIFEST_TYPE = 'sia-site';
const MANIFEST_VERSION = 1;

/**
 * Wrap a `{ path -> shareUrl }` map in the versioned manifest envelope
 * produced by this client. Exposed so the CLI / other callers use the
 * same shape.
 */
export function buildSiaSiteManifest(files) {
  return { type: MANIFEST_TYPE, version: MANIFEST_VERSION, files };
}

/**
 * Parse and validate a v1 sia-site manifest. Returns the flat
 * `{ path -> shareUrl }` map the rest of the code works with.
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
      throw new Error(`manifest entry \`${k}\` is not a sia:// share URL`);
    }
  }
  return m.files;
}

async function getManifest(manifestId) {
  const cached = manifestCache.get(manifestId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) throw new Error(getLastConnectError() || 'SDK not connected');
    const { obj } = await resolveObject(manifestId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  const files = parseManifest(data);
  manifestCache.set(manifestId, files);
  _dbg('[sia-site] loaded manifest', manifestId.slice(0, 16), 'entries:', Object.keys(files).length);
  return files;
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

function injectBridge(html) {
  const tag = '<script src="/_sia-bridge.js"></' + 'script>';
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
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    wasm: 'application/wasm',
    txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return m[ext] || 'application/octet-stream';
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

export function loadSite(iframeEl, manifestId, subpath) {
  if (!iframeEl) throw new Error('iframe required');
  if (!manifestId) throw new Error('manifestId required');
  if (!handlerInstalled) initSiaSiteHandler();

  iframeManifests.set(iframeEl, manifestId);
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
  return !!(iframeEl && iframeManifests.has(iframeEl));
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
  iframeManifests.delete(iframeEl);
  handshaken.delete(iframeEl);
}

/**
 * Upload a set of files as a Sia site. Each file is uploaded
 * individually, then a JSON manifest mapping paths to object IDs is
 * uploaded and returned.
 *
 *   await uploadSite(sdk, [
 *     { path: 'index.html', data: htmlBytes },
 *     { path: 'app.js', data: jsBytes },
 *     { path: 'assets/logo.png', data: pngBytes },
 *   ]);
 */
export async function uploadSite(sdk, files) {
  const manifest = {};
  const validUntil = new Date(Date.now() + SITE_SHARE_VALIDITY_MS);
  // UUID-prefix every object's filename metadata so all artifacts
  // from a single publish session group together alphabetically in
  // My Objects. Site Builder strips the prefix when re-using them.
  const uploadId = crypto.randomUUID();
  for (const { path, data } of files) {
    const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
    const pinned = new PinnedObject();
    pinned.updateMetadata(encodeMetadata({ filename: `${uploadId}/${path}` }));
    const obj = await sdk.upload(pinned, new Blob([raw]).stream());
    await sdk.pinObject(obj);
    manifest[path] = sdk.shareObject(obj, validUntil);
    _dbg('[sia-site] uploaded', path, '→', obj.id());
  }
  const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest), null, 2);
  const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
  const manifestPinned = new PinnedObject();
  manifestPinned.updateMetadata(
    encodeMetadata({ filename: `${uploadId}/manifest.json` }),
  );
  const manifestObj = await sdk.upload(manifestPinned, manifestBlob.stream());
  await sdk.pinObject(manifestObj);
  const manifestId = manifestObj.id();
  _dbg('[sia-site] manifest', manifestId);
  return { manifestId, manifest };
}
