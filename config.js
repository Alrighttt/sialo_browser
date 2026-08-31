// Config helpers — shared configuration accessors and SDK connection management.

import { _dbg, _dbgWarn, fromHex, formatSize } from './utils.js';
import { updateConnectionStatus } from './tabs.js';
import { AppKey, Builder, setLogger } from './pkg/sia_storage_wasm.js';

// Install the SDK logger once — writes WASM-side `log::debug!` /
// `log::warn!` messages to the browser console when debug logging is on.
// Helps diagnose per-host WebTransport connect failures (e.g. "[WT]
// connect to <host> failed: ...") that would otherwise be invisible.
let _loggerInstalled = false;
function ensureLoggerInstalled() {
  if (_loggerInstalled) return;
  const level = (() => { try { return getLogLevel(); } catch { return null; } })();
  if (!level) return;
  try {
    setLogger((msg) => console.log(msg), level);
    _loggerInstalled = true;
  } catch (e) {
    console.warn('[sialo] setLogger failed:', e);
  }
}

const APP_ID = 'c0000000000000000000000000000000000000000000000000000000000000de';
const APP_NAME = 'Sialo';
const APP_DESCRIPTION = 'Decentralized storage browser for the Sia network';
const APP_SERVICE_URL = 'https://sialo.io';

const PROFILES_KEY = 'indexer-profiles';
import { createFile as createMP4Box } from './vendor/mp4box.bundle.js';
import { webcodecStream as _webcodecStream, transmuxAndStream as _transmuxAndStream } from './video-streaming.js';

// --- Config accessors (read from DOM inputs) ---

export function getUrl() { return document.getElementById('cfg-url').value.trim(); }
export function getKeyHex() { return document.getElementById('cfg-key').value.trim(); }
export function getMaxDownloads() { return parseInt(document.getElementById('cfg-max-downloads').value, 10) || 8; }
export function getMaxUploads() { return parseInt(document.getElementById('cfg-max-uploads').value, 10) || 8; }
export function getDownloadWorkers() { return parseInt(localStorage.getItem('download-workers'), 10) || 8; }
export function getUploadWorkers() { return parseInt(localStorage.getItem('upload-workers'), 10) || 8; }
export function getLogLevel() { return document.getElementById('cfg-debug-logging').checked ? 'debug' : null; }

// --- Stream helpers (passed to video-streaming.js) ---

const streamHelpers = { formatSize, getUrl, getKeyHex, getMaxDownloads, getLogLevel, createMP4Box, _dbg, _dbgWarn };

export function webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl, overrideConfig) {
  return _webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl, { ...streamHelpers, overrideConfig });
}
export function transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl) {
  return _transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl, streamHelpers);
}

// --- SDK connection cache ---

let cachedSdk = null;
let cachedConfig = null;

/**
 * Drop the cached SDK so the next `connectSdk()` rebuilds it. Call this
 * after a download/upload fails in a way that suggests the WebTransport
 * pool is dead (e.g. `"not enough shards: 0/N"` after a QUIC idle-timeout
 * on every host). The old handle is left alive — other in-flight ops
 * still hold references to it — so we just clear the cache pointer.
 */
export function invalidateSdk() {
  cachedSdk = null;
  cachedConfig = null;
}

// Last user-facing reason `connectSdk` returned null. Callers that
// passed a no-op status proxy (e.g. resolve paths inside sia-site.js
// that have no UI of their own) can read this to surface the actual
// failure instead of the generic "SDK not connected" placeholder.
let lastConnectError = null;
export function getLastConnectError() { return lastConnectError; }

export async function connectSdk(statusEl) {
  const url = getUrl();
  const keyHex = getKeyHex();
  if (!url || !keyHex) {
    lastConnectError = 'Set Indexer URL and App Key in Configuration first';
    statusEl.innerHTML = `<span class="fail">${lastConnectError}</span>`;
    return null;
  }

  // Return cached SDK if config hasn't changed
  const currentConfig = `${url}|${keyHex}`;
  if (cachedSdk && cachedConfig === currentConfig) {
    return cachedSdk;
  }

  ensureLoggerInstalled();
  statusEl.textContent = 'Creating app key...';
  const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
  statusEl.textContent = `App key created. Public key: ${appKey.publicKey()}\nConnecting to indexer...`;
  const builder = new Builder(url, { appId: APP_ID, name: APP_NAME, description: APP_DESCRIPTION, serviceUrl: APP_SERVICE_URL });
  // Cap the handshake. builder.connected() makes an HTTP call to the
  // indexer to verify the key; if the indexer is unreachable or its
  // CORS preflight hangs (seen on sia.storage's Next.js middleware
  // returning 404 on OPTIONS), reqwest on WASM waits indefinitely.
  // Without a timeout every subsequent SDK call stalls behind this
  // one, which surfaces to the user as "Not connected" forever.
  let sdk;
  try {
    sdk = await Promise.race([
      builder.connected(appKey),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Indexer unreachable at ${url} (timed out after 15s)`)),
        15000,
      )),
    ]);
  } catch (e) {
    lastConnectError = (e && e.message) || 'Could not reach indexer';
    statusEl.innerHTML = `<span class="fail">${lastConnectError}</span>`;
    return null;
  }
  if (!sdk) {
    lastConnectError = 'App key not recognized by this indexer. Register first.';
    statusEl.innerHTML = `<span class="fail">${lastConnectError}</span>`;
    return null;
  }

  lastConnectError = null;
  // Cache the SDK
  cachedSdk = sdk;
  cachedConfig = currentConfig;
  statusEl.innerHTML = '<span class="pass">Connected!</span>';
  updateConnectionStatus(true, 'Connected to ' + url);
  return sdk;
}

/**
 * Resolves an object by ID or share URL. Share URLs are indexer-specific
 * and only tried against the primary SDK. Object IDs try the primary SDK
 * first, then fall back through all other configured indexer profiles.
 * Returns { sdk, obj } for the first profile that succeeds.
 */
export async function resolveObject(input, primarySdk) {
  const isShareUrl = input.startsWith('sia://') || input.startsWith('https://');

  // Try the primary SDK first
  try {
    const obj = isShareUrl
      ? await primarySdk.objectFromShareUrl(input)
      : await primarySdk.object(input);
    return { sdk: primarySdk, obj, fallback: null };
  } catch (primaryErr) {
    // Share URLs are indexer-specific — don't fall back to other indexers.
    if (isShareUrl) throw primaryErr;
    _dbg(`Primary indexer failed for object: ${primaryErr.message || primaryErr}`);
  }

  // Object ID fallback: try all other configured profiles
  let profiles;
  try {
    profiles = JSON.parse(localStorage.getItem(PROFILES_KEY));
  } catch { /* no profiles */ }
  if (!profiles?.profiles) throw new Error('Object not found on any indexer');

  const activeUrl = getUrl();
  const errors = [];

  for (const [name, profile] of Object.entries(profiles.profiles)) {
    if (!profile.url || !profile.key || profile.url === activeUrl) continue;
    try {
      _dbg(`Trying profile "${name}" (${profile.url})...`);
      const key = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(profile.key)));
      const builder = new Builder(profile.url, { appId: APP_ID, name: APP_NAME, description: APP_DESCRIPTION, serviceUrl: APP_SERVICE_URL });
      const sdk = await builder.connected(key);
      if (!sdk) continue;
      const obj = await sdk.object(input);
      _dbg(`Resolved object via profile "${name}"`);
      return { sdk, obj, fallback: name, indexerUrl: profile.url, keyHex: profile.key };
    } catch (e) {
      errors.push(`${name}: ${e.message || e}`);
    }
  }

  throw new Error(
    'Object not found on any configured indexer.\n' +
    errors.map(e => '  ' + e).join('\n')
  );
}
