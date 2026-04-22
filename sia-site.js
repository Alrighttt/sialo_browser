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
// Manifest format:
//   { "index.html": "sia://...?sv=...#encryption_key=...", "app.js": "sia://...", ... }
//
// Values are full `sia://` share URLs (not bare object IDs) so the site
// is portable: any account can resolve and decrypt each entry using the
// signature + encryption key embedded in the URL. Bare hex IDs are still
// accepted on read for backwards compatibility with older manifests.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { _dbg, _dbgWarn } from './utils.js';
import { connectSdk, resolveObject, invalidateSdk } from './config.js';

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

const manifestCache = new Map(); // manifestId → { "path": shareUrl|objectId, ... }
const objectCache = new Map();   // shareUrl|objectId → Uint8Array

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
    case 'sia-bridge-page':
      // Informational — we don't track in-site history depth from the
      // parent. The iframe's own history.back() is the source of truth;
      // the parent's Back button just postMessages 'sia-nav-back' and
      // the iframe does the right thing (or a silent no-op if nothing
      // to go back to).
      return;

    case 'sia-navigate': {
      // A link inside the hosted page pointed at an external scheme
      // (sia://, sia-site://) that the iframe can't handle itself.
      // Surface it in the parent tab's address bar and kick off the
      // normal navigation flow.
      const target = d.url;
      if (typeof target !== 'string') return;
      if (!/^(sia|sia-site):\/\//i.test(target)) return;
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
        const { body, contentType } = await resolveManifestPath(manifestId, d.path);
        e.source.postMessage(
          { type: 'sia-response', id: d.id, body, contentType },
          HOSTED_ORIGIN,
          body ? [body] : [],
        );
      } catch (err) {
        _dbgWarn('[sia-site] resolve failed:', d.path, err);
        e.source.postMessage(
          { type: 'sia-response', id: d.id, error: err.message || String(err) },
          HOSTED_ORIGIN,
        );
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
    throw new Error('not in manifest: ' + path);
  }
  const data = await fetchObject(lookup.objectId);

  const contentType = guessMime(lookup.key);
  let body;
  if (contentType === 'text/html') {
    // Inject the bridge script and rewrite any sia:// / sia-site://
    // subresource references to /_sia-ext/<encoded url>. The iframe's
    // SW then intercepts those paths, streams bytes from the Sia
    // network (with Range support), and synthesises a same-origin
    // Response — so <video src="sia://..."> etc. can seek like normal.
    const html = new TextDecoder().decode(data);
    const rewritten = rewriteSiaUrlsInHtml(html);
    const injected = injectBridge(rewritten);
    body = new TextEncoder().encode(injected).buffer;
  } else if (contentType === 'text/css') {
    // CSS also needs url(sia://...) → url(/_sia-ext/...) rewriting.
    const css = new TextDecoder().decode(data);
    body = new TextEncoder().encode(rewriteSiaUrlsInCss(css)).buffer;
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
  const setup = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) throw new Error('SDK not connected');
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
  });

  const { reader, totalSize, firstChunk, done } = setup;
  let contentType = guessMimeFromSiaUrl(siaUrl);
  if (firstChunk) {
    const sniffed = sniffContentType(firstChunk);
    if (sniffed) contentType = sniffed;
  }

  const entry = { cancelled: false, reader };
  activeExtStreams.set(id, entry);

  try {
    source.postMessage({ type: 'sia-ext-meta', id, size: totalSize, contentType }, HOSTED_ORIGIN);
    if (done) {
      source.postMessage({ type: 'sia-ext-end', id }, HOSTED_ORIGIN);
      return;
    }
    if (firstChunk) {
      const buf = firstChunk.buffer.slice(firstChunk.byteOffset, firstChunk.byteOffset + firstChunk.byteLength);
      source.postMessage({ type: 'sia-ext-chunk', id, chunk: buf }, HOSTED_ORIGIN, [buf]);
    }

    while (!entry.cancelled) {
      const { done: d, value } = await reader.read();
      if (d) break;
      if (entry.cancelled) break;
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      source.postMessage({ type: 'sia-ext-chunk', id, chunk: buf }, HOSTED_ORIGIN, [buf]);
    }
    if (!entry.cancelled) {
      source.postMessage({ type: 'sia-ext-end', id }, HOSTED_ORIGIN);
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

async function fetchObject(objectId) {
  const cached = objectCache.get(objectId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) throw new Error('SDK not connected');
    const { obj } = await resolveObject(objectId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  objectCache.set(objectId, data);
  return data;
}

async function getManifest(manifestId) {
  const cached = manifestCache.get(manifestId);
  if (cached) return cached;
  const data = await withSdkRetry(async () => {
    const sdk = await connectSdk({ set textContent(_) {}, set innerHTML(_) {} });
    if (!sdk) throw new Error('SDK not connected');
    const { obj } = await resolveObject(manifestId, sdk);
    return await readStreamFully(sdk.download(obj));
  });
  let m;
  try {
    m = JSON.parse(new TextDecoder().decode(data));
  } catch (e) {
    throw new Error('manifest is not valid JSON: ' + e.message);
  }
  if (!m || typeof m !== 'object') throw new Error('manifest is not a JSON object');
  manifestCache.set(manifestId, m);
  _dbg('[sia-site] loaded manifest', manifestId.slice(0, 16), 'entries:', Object.keys(m).length);
  return m;
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
export function loadSite(iframeEl, manifestId) {
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
  iframeEl.src = HOSTED_ORIGIN + '/_sia-bootstrap.html?t=' + Date.now();
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
  for (const { path, data } of files) {
    const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
    const obj = await sdk.upload(new PinnedObject(), new Blob([raw]).stream());
    await sdk.pinObject(obj);
    manifest[path] = sdk.shareObject(obj, validUntil);
    _dbg('[sia-site] uploaded', path, '→', obj.id());
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
  const manifestObj = await sdk.upload(new PinnedObject(), manifestBlob.stream());
  await sdk.pinObject(manifestObj);
  const manifestId = manifestObj.id();
  _dbg('[sia-site] manifest', manifestId);
  return { manifestId, manifest };
}
