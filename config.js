// Config helpers — shared configuration accessors and SDK connection management.

import { _dbg, _dbgWarn, fromHex, formatSize } from './utils.js';
import { updateConnectionStatus } from './tabs.js';
import { AppKey, Builder, DownloadOptions } from './pkg/indexd_wasm.js';

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

const streamHelpers = { formatSize, getUrl, getKeyHex, getMaxDownloads, getLogLevel, DownloadOptions, createMP4Box, _dbg, _dbgWarn };

export function webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl) {
  return _webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl, streamHelpers);
}
export function transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl) {
  return _transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl, streamHelpers);
}

// --- SDK connection cache ---

let cachedSdk = null;
let cachedConfig = null;

export async function connectSdk(statusEl) {
  const url = getUrl();
  const keyHex = getKeyHex();
  if (!url || !keyHex) {
    statusEl.innerHTML = '<span class="fail">Set Indexer URL and App Key in Configuration first</span>';
    return null;
  }

  // Return cached SDK if config hasn't changed
  const currentConfig = `${url}|${keyHex}`;
  if (cachedSdk && cachedConfig === currentConfig) {
    return cachedSdk;
  }

  statusEl.textContent = 'Creating app key...';
  const seed = fromHex(keyHex);
  const appKey = new AppKey(seed);
  statusEl.textContent = `App key created. Public key: ${appKey.publicKey()}\nConnecting to indexer...`;
  const builder = new Builder(url);
  const sdk = await builder.connected(appKey);
  if (!sdk) {
    statusEl.innerHTML = '<span class="fail">App key not recognized by this indexer. Register first.</span>';
    return null;
  }

  // Cache the SDK
  cachedSdk = sdk;
  cachedConfig = currentConfig;
  statusEl.innerHTML = '<span class="pass">Connected!</span>';
  updateConnectionStatus(true, 'Connected to ' + url);
  return sdk;
}

/**
 * Resolve a shared object URL, trying the primary SDK first, then falling
 * back through all other configured indexer profiles. Returns { sdk, obj }
 * on success, or throws if all profiles fail.
 */
export async function resolveSharedObject(shareUrl, primarySdk) {
  // Try the primary SDK first
  try {
    const obj = await primarySdk.sharedObject(shareUrl);
    return { sdk: primarySdk, obj };
  } catch (primaryErr) {
    _dbg(`Primary indexer failed for shared URL: ${primaryErr.message}`);
  }

  // Load all profiles and try each one (skip the active profile, already tried)
  let profiles;
  try {
    profiles = JSON.parse(localStorage.getItem(PROFILES_KEY));
  } catch { /* no profiles */ }
  if (!profiles?.profiles) throw new Error('Shared object not found on any indexer');

  const activeUrl = getUrl();
  const errors = [];

  for (const [name, profile] of Object.entries(profiles.profiles)) {
    if (!profile.url || !profile.key || profile.url === activeUrl) continue;
    try {
      _dbg(`Trying profile "${name}" (${profile.url})...`);
      const key = new AppKey(fromHex(profile.key));
      const builder = new Builder(profile.url);
      const sdk = await builder.connected(key);
      if (!sdk) continue;
      const obj = await sdk.sharedObject(shareUrl);
      _dbg(`Resolved shared object via profile "${name}"`);
      return { sdk, obj };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  throw new Error(
    'Shared object not found on any configured indexer.\n' +
    errors.map(e => '  ' + e).join('\n')
  );
}
