// Pinning content that someone else stored, onto your own account.
//
// A shared or published file lives on Sia because its owner is paying to keep
// it there. If they stop, or revoke the sharing key, or let the published URL
// expire, it is gone for you too. Pinning takes over that responsibility: the
// object is registered under your account and stays as long as you keep it.
//
// It does NOT re-upload anything. An object is a list of slab references —
// sector roots and the hosts holding them — plus the keys to decrypt them. The
// SDK re-signs that list with your app key and asks the indexer to pin the same
// slabs for you, so the cost is a few hundred bytes of bookkeeping rather than
// the size of the file. That is why pinning a 5 GB video is close to instant.
//
// What it does cost is storage: the data now counts against your account, and
// an account with a `max_pinned_data` ceiling can refuse. That is why every
// caller here reports what it pinned rather than silently succeeding.
//
// Deliberately parent-side only. Sites render inside the sandbox on another
// origin, so a pin action reachable from in there would be a message any site
// could send for any object it named. Pinning spends the user's money, so it
// stays in the app's own chrome where site content cannot reach it.

import { connectSdk } from './config.js';
import { siteEntries, parseSiteUrl } from './sia-site.js';
import { isSiteAddress, objectIdInUrl } from './object-input.js';
import { filenameForDisplay, stripUploadUuid } from './object-metadata.js';
import { explainSdkError } from './utils.js';

/** A short label for a published URL, which carries no filename of its own. */
function labelForPublishUrl(url) {
  const id = objectIdInUrl(url);
  return id ? `${id.slice(0, 8)}…${id.slice(-8)}` : url;
}

/**
 * Whether an address is the kind of thing pinning could act on, judged without
 * touching the network. Used to enable or disable the button; the real answer
 * needs `resolvePinTargets`, which has to resolve the site.
 */
export function looksPinnable(address) {
  const value = String(address || '').trim();
  if (!value) return false;
  return /^sia:\/\//i.test(value) || isSiteAddress(value);
}

/**
 * What pinning this address would act on: one entry per object.
 *
 * A site address with no path resolves to every file in the site, which is
 * what makes "pin this whole site" a single action. Returns null when the
 * address is not pinnable, and throws when it is but could not be resolved —
 * the two are different and callers report them differently.
 */
export async function resolvePinTargets(address) {
  const value = String(address || '').trim();
  if (!value) return null;

  // A published URL is self-contained: its fragment carries the decryption
  // key, so it resolves without knowing which site it came from.
  if (/^sia:\/\//i.test(value)) {
    return [{ path: labelForPublishUrl(value), ref: value }];
  }

  if (!isSiteAddress(value)) return null;
  const parsed = parseSiteUrl(value);
  if (!parsed) return null;

  const { entries } = await siteEntries(parsed.siteId);
  const path = String(parsed.path || '').replace(/^\/+/, '');
  if (!path) return entries;
  const one = entries.find((e) => e.path === path);
  // A path that matches nothing is not an error worth throwing over: the
  // address bar may simply be showing a directory inside the site.
  if (one) return [one];
  const under = entries.filter((e) => e.path.startsWith(path.replace(/\/*$/, '/')));
  return under.length ? under : null;
}

/**
 * Pin one resolved target and return the object that was pinned.
 *
 * `ref` is either a published URL, which has to be resolved first, or an
 * object handle a sharing key already decrypted for us.
 */
async function pinOne(sdk, target) {
  const obj = typeof target.ref === 'string'
    ? await sdk.objectFromShareUrl(target.ref)
    : target.ref;
  await sdk.pinObject(obj);
  return obj;
}

/**
 * A display name for something that was pinned, preferring the name stored in
 * the object's own metadata over the path it happened to be reached by.
 */
export function pinnedName(obj, fallback) {
  try {
    const name = filenameForDisplay(obj.metadata());
    if (name) return stripUploadUuid(name) || name;
  } catch (_) { /* metadata is optional */ }
  return fallback || '';
}

/**
 * Pin every target, continuing past individual failures.
 *
 * One file failing — blocked by the indexer, over the account's pinned-data
 * ceiling — must not abandon the rest, so failures are collected and returned
 * rather than thrown. `onProgress({done, total, name})` is called before each.
 */
export async function pinTargets(targets, { statusEl, onProgress } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return { pinned: 0, bytes: 0, failed: [], total: 0 };

  const sdk = await connectSdk(statusEl || { set textContent(_) {}, set innerHTML(_) {} });
  if (!sdk) {
    const err = new Error('Set Indexer URL and App Key to pin to your account.');
    err.needsAccount = true;
    throw err;
  }

  let pinned = 0;
  let bytes = 0;
  const failed = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (onProgress) onProgress({ done: i, total: list.length, name: t.path });
    try {
      const obj = await pinOne(sdk, t);
      pinned += 1;
      try { bytes += Number(obj.size()) || 0; } catch (_) { /* size is a nicety */ }
    } catch (e) {
      // A transport failure names the host it could not reach; anything
      // else keeps the SDK's own wording, which is usually more specific.
      const addr = typeof t.ref === 'string' ? t.ref : '';
      failed.push({ path: t.path, error: explainSdkError(e, addr) });
    }
  }
  if (onProgress) onProgress({ done: list.length, total: list.length, name: '' });
  return { pinned, bytes, failed, total: list.length };
}

/**
 * Pin an object handle we already hold, which is the case anywhere the app has
 * listed a sharing key's objects. Skips resolution entirely.
 */
export async function pinHandle(obj, { statusEl } = {}) {
  return pinTargets([{ path: pinnedName(obj, ''), ref: obj }], { statusEl });
}

/** Resolve an address and pin everything it refers to. */
export async function pinAddress(address, opts = {}) {
  const targets = await resolvePinTargets(address);
  if (!targets || targets.length === 0) {
    throw new Error('Nothing on this page can be pinned.');
  }
  return pinTargets(targets, opts);
}

/**
 * One line describing what a pin run did, for a status bar. Failures are named
 * rather than counted when there are few, because "1 failed" with no reason is
 * not something a reader can act on.
 */
export function describePinResult(result) {
  const { pinned, bytes, failed, total } = result;
  const parts = [];
  if (pinned > 0) {
    parts.push(`Pinned ${pinned} of ${total} file${total === 1 ? '' : 's'}`
      + (bytes > 0 ? ` (${formatBytes(bytes)})` : '')
      + ' to your account.');
  }
  if (failed.length > 0) {
    const shown = failed.slice(0, 3)
      .map((f) => `${f.path || 'object'}: ${f.error}`)
      .join('; ');
    parts.push(`${failed.length} failed — ${shown}`
      + (failed.length > 3 ? `, and ${failed.length - 3} more.` : '.'));
  }
  return parts.join(' ') || 'Nothing was pinned.';
}

/** Local byte formatter so this module does not depend on the UI helpers. */
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
