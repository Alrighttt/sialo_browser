// Config helpers — shared configuration accessors and SDK connection management.

import { _dbg, _dbgWarn, fromHex, formatSize } from './utils.js';
import { downloadOptions } from './transfer-options.js';
import { updateConnectionStatus } from './tabs.js';
import { AppKey, Builder, SharedSdk, setLogger } from './pkg/sia_storage_wasm.js';

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
// An empty field means "automatic": the SDK's own bound (roughly 10% of
// system memory) rather than a small hardcoded cap. Returns null in that
// case so the option can be omitted entirely.
function positiveIntOrNull(id) {
  const v = parseInt(document.getElementById(id).value, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}
export function getMaxDownloads() { return positiveIntOrNull('cfg-max-downloads'); }
export function getMaxUploads() { return positiveIntOrNull('cfg-max-uploads'); }
export function getDownloadWorkers() { return parseInt(localStorage.getItem('download-workers'), 10) || 8; }
export function getUploadWorkers() { return parseInt(localStorage.getItem('upload-workers'), 10) || 8; }
export function getLogLevel() { return document.getElementById('cfg-debug-logging').checked ? 'debug' : null; }

// --- Stream helpers (passed to video-streaming.js) ---

const streamHelpers = { formatSize, getUrl, getKeyHex, getMaxDownloads, getLogLevel, createMP4Box, downloadOptions, _dbg, _dbgWarn };

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
    lastConnectError = 'App key not recognized by this indexer. Register or log in first.';
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
 * Resolves an object by ID or published URL. Published URLs are indexer-specific
 * and only tried against the primary SDK. Object IDs try the primary SDK
 * first, then fall back through all other configured indexer profiles.
 * Returns { sdk, obj } for the first profile that succeeds.
 */
/**
 * The configured indexer profiles, minus the one currently active.
 *
 * Exclusion is by profile identity, not by indexer URL. Two profiles can point
 * at the same indexer with different app keys — one account on a paid plan and
 * one on a free tier is the ordinary reason — and the second is a perfectly
 * good destination. An earlier version filtered on URL, which hid exactly that
 * case behind an argument that only holds for the same *account*: it is
 * pinning onto the account that already owns the object that provably does
 * nothing, since that is the only thing an object row is keyed by.
 *
 * `sameIndexer` is carried through because it makes the transfer trivial. The
 * slab and sector rows are indexer-wide, keyed by digest and root with no
 * account column, and the good-host set comes from the indexer's contracts
 * with no account filter — so a second account on the same indexer sees
 * identical health and needs no byte moved. All that is missing is its own
 * `account_slabs` rows and an object row, which is what a pin writes.
 */
export function otherProfiles() {
  let store;
  try { store = JSON.parse(localStorage.getItem(PROFILES_KEY)); } catch { /* none */ }
  if (!store?.profiles) return [];
  const activeUrl = getUrl();
  const activeKey = getKeyHex();
  return Object.entries(store.profiles)
    .filter(([name, p]) => {
      if (!p.url || !p.key) return false;
      if (name === store.active) return false;
      // The same account under a second name is still the same account.
      return !(p.url === activeUrl && p.key === activeKey);
    })
    .map(([name, p]) => ({ name, url: p.url, key: p.key, sameIndexer: p.url === activeUrl }));
}

/**
 * Connects to one named profile, independently of the active one.
 *
 * Separate from `connectSdk` because that caches a single handle keyed on the
 * active configuration; a migration needs two live handles at once, and the
 * destination must not displace the source.
 *
 * Returns null when the indexer answers but does not recognise the key, which
 * is a different failure from being unreachable and worth reporting as such.
 */
export async function connectProfile(profile) {
  const key = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(profile.key)));
  const builder = new Builder(profile.url, { appId: APP_ID, name: APP_NAME, description: APP_DESCRIPTION, serviceUrl: APP_SERVICE_URL });
  return await Promise.race([
    builder.connected(key),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Indexer unreachable at ${profile.url} (timed out after 15s)`)),
      15000,
    )),
  ]);
}

/**
 * Indexers a sharing link may be resolved against when this browser has none
 * configured, which is the ordinary case for someone opening a link they were
 * sent.
 *
 * The list lives here rather than coming from the link on purpose. A link is
 * an untrusted string; letting it name the server would let a hostile one
 * point the SDK wherever it liked. So candidates are always this app's own.
 */
export const KNOWN_INDEXERS = [
  'https://sia.storage',
  'https://storage.sia.dev',
];

/** Every profile's indexer URL, whether or not it has an app key. */
function profileUrls() {
  let store;
  try { store = JSON.parse(localStorage.getItem(PROFILES_KEY)); } catch { /* none */ }
  if (!store?.profiles) return [];
  return Object.values(store.profiles).map((p) => p && p.url).filter(Boolean);
}

/**
 * Where to look for a sharing key, in order.
 *
 * The configured indexer first, so a reader who has chosen one is asked
 * nothing extra and the common case still costs a single request. Then their
 * other profiles, then the built-in list — which is what makes a link work in
 * a browser that has never been set up.
 */
export function sharingIndexerCandidates() {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    const u = (url || '').trim().replace(/\/+$/, '');
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  add(getUrl());
  profileUrls().forEach(add);
  KNOWN_INDEXERS.forEach(add);
  return out;
}

/**
 * Connect as the holder of `seed`, against whichever known indexer has it.
 *
 * A sharing key exists on one indexer and a link cannot say which, so the
 * candidates are asked in turn. That is what lets one link work for a reader
 * whose settings point at staging and a reader with no settings at all,
 * without either of them having to know where the key was created.
 *
 * `stats()` is the probe, not `connect()` alone: connecting does not prove the
 * indexer holds the key, and a handle that 401s on first use would turn a
 * wrong guess into a failure the caller has no way to retry.
 *
 * Worth being explicit that probing discloses the seed to every indexer asked.
 * That is the reason the candidate list is this app's own configuration and
 * built-ins, and never a host the link supplied.
 *
 * Returns the handle and the indexer it belongs to, so a caller that caches
 * per indexer can key on the one that actually answered.
 */
/**
 * How long one indexer gets to answer before the search moves on.
 *
 * Without this an indexer that accepts the connection and then goes quiet
 * holds the whole search open, and the panel sits on "Connecting…" with no
 * indication that anything is wrong — the symptom that made a missing key look
 * like a hang rather than an answer.
 */
const PROBE_TIMEOUT_MS = 12000;

/**
 * Whether an indexer answered "I do not hold this key", rather than failing to
 * answer at all.
 *
 * The distinction is the whole difference between a negative result and no
 * result: a key absent from every indexer that replied is a key that does not
 * exist, while one that could not be checked everywhere may simply be
 * somewhere we could not reach.
 */
function saysKeyNotFound(err) {
  return /sharing key not found|\b401\b/i.test(String((err && err.message) || err));
}

export async function connectSharedSdk(seed) {
  const candidates = sharingIndexerCandidates();
  const tried = [];
  for (const indexer of candidates) {
    let sdk = null;
    try {
      sdk = await Promise.race([
        SharedSdk.connect(indexer, seed),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)),
          PROBE_TIMEOUT_MS,
        )),
      ]);
      // Connecting fetches the key's hosts, so reaching this point is already
      // the indexer confirming it holds the key. `stats()` is kept as the
      // explicit check rather than relying on that: the search is only correct
      // if a wrong guess is rejected, and one request per link opened is not a
      // price worth trading that for.
      await sdk.stats();
      _dbg(`Sharing key resolved on ${indexer}`);
      return { sdk, indexer };
    } catch (e) {
      tried.push({ indexer, message: (e && e.message) || String(e), notFound: saysKeyNotFound(e) });
      // A handle that failed its check is of no use to anyone.
      try { if (sdk && sdk.free) sdk.free(); } catch (_) { /* already gone */ }
    }
  }

  const detail = tried.map((t) => `  ${t.indexer}: ${t.message}`).join('\n');
  const unreachable = tried.filter((t) => !t.notFound);
  if (!unreachable.length) {
    throw new Error(
      'This sharing key does not exist on any indexer this browser knows about. '
      + 'It may have been revoked, or created on an indexer that is not in the list.\n'
      + detail,
    );
  }
  const answered = tried.filter((t) => t.notFound).map((t) => t.indexer);
  throw new Error(
    (answered.length
      ? `This sharing key is not on ${answered.join(' or ')}, and `
      : 'This sharing key could not be looked up: ')
    + `${unreachable.map((t) => t.indexer).join(' and ')} could not be reached, `
    + 'so it may be there. Retrying may resolve it.\n'
    + detail,
  );
}

/**
 * Page through a listing, backing off when the indexer refuses a page.
 *
 * The page size counts objects, but the indexer's cost is dominated by what
 * sits behind them: listing hydrates every slab and every sector of every
 * object on the page. A hundred three-gigabyte objects is roughly a quarter of
 * a million sector rows in one request, which the indexer answers with a 500 —
 * and the reader is shown nothing at all, for a key that is perfectly healthy.
 *
 * So start large, because a key of small files should still list in one or two
 * round trips, and back off when a page is refused instead of giving up. A
 * refused page is retried at the same offset, so nothing is skipped on the way
 * down. The floor is what stops an unusable key looping forever: without it the
 * size clamps at the minimum and the retry never gives up.
 *
 * Note this only softens the symptom. The cost belongs to the indexer, which
 * hydrates every slab and sector of every object on the page — for objects of a
 * few gigabytes that is thousands of sector rows each — and a listing has no
 * use for any of it.
 */
const LIST_PAGE_MAX = 100;
const LIST_PAGE_MIN = 5;

export async function listAllPages(fetchPage) {
  const out = [];
  let page = LIST_PAGE_MAX;
  for (let offset = 0; ;) {
    let batch;
    try {
      batch = await fetchPage(offset, page);
    } catch (e) {
      if (page <= LIST_PAGE_MIN) throw e;
      page = Math.max(LIST_PAGE_MIN, Math.floor(page / 4));
      _dbgWarn(`[listing] page at ${offset} refused; retrying with limit=${page}`);
      continue;
    }
    out.push(...batch);
    if (batch.length < page) break;
    offset += batch.length;
  }
  return out;
}

/** Every object a sharing key grants, as its holder. */
export function listSharedObjects(sdk) {
  return listAllPages((offset, limit) => sdk.objects(offset, limit));
}

/** Every object attached to one of your own keys, as its owner. */
export function listOwnedSharedObjects(sdk, key) {
  return listAllPages((offset, limit) => sdk.sharedObjects(key, offset, limit));
}

export async function resolveObject(input, primarySdk) {
  const isPublishUrl = input.startsWith('sia://') || input.startsWith('https://');

  // Try the primary SDK first
  try {
    const obj = isPublishUrl
      ? await primarySdk.objectFromShareUrl(input)
      : await primarySdk.object(input);
    return { sdk: primarySdk, obj, fallback: null };
  } catch (primaryErr) {
    // Published URLs are indexer-specific — don't fall back to other indexers.
    if (isPublishUrl) throw primaryErr;
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
      const sdk = await connectProfile({ url: profile.url, key: profile.key });
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
