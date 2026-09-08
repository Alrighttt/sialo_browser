// Download and upload option builders.
//
// These exist so the SDK's option names are written down exactly once. They
// used to be spelled out at every call site as `maxInflight`, which was the
// name the older indexd_wasm SDK used; sia_storage renamed them and the call
// sites never followed, so the Max Downloads / Max Uploads settings were
// silently ignored for as long as the app has been on the new SDK. Unknown
// keys are dropped without complaint, so nothing ever surfaced.
//
// Both are pure and take the limit explicitly, because Web Workers get theirs
// over postMessage and cannot read the settings DOM.

/**
 * Options for `sdk.download()`.
 *
 * `maxBufferedChunks` caps how many ~1 MiB chunks are fetched concurrently:
 * more parallelism for more memory. Left unset, the SDK picks its own bound
 * (about 10% of system memory), which is far higher than any number a person
 * would type, so an unset limit is passed through as "let the SDK decide"
 * rather than being replaced with a small default.
 */
export function downloadOptions(maxBufferedChunks, extra) {
  const opts = { ...(extra || {}) };
  const n = limit(maxBufferedChunks);
  if (n !== null) opts.maxBufferedChunks = n;
  return opts;
}

/**
 * Options for `sdk.upload()` and `sdk.uploadPacked()`.
 *
 * `maxBufferedSlabs` caps how many slabs are held in memory at once. A slab
 * is 10 data + 20 parity shards, so each one is considerably more memory than
 * a download chunk. Unset means the SDK's own bound, as above.
 */
export function uploadOptions(maxBufferedSlabs, extra) {
  const opts = { ...(extra || {}) };
  const n = limit(maxBufferedSlabs);
  if (n !== null) opts.maxBufferedSlabs = n;
  return opts;
}

/**
 * A usable positive limit, or null for "unset". Coerces numeric strings,
 * because a value that has been through a DOM input or postMessage can
 * arrive as one and silently dropping it is the bug this module exists to
 * prevent.
 */
function limit(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}
