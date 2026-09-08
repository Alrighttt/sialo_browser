// Object-level metadata — stored on the indexer as arbitrary bytes per
// object. We use it to carry a filename so downloads and UIs can show
// something human-readable instead of a content hash.
//
// Wire format: UTF-8 JSON envelope.
//   { "type": "sialo-object-meta", "version": 1, "filename": "foo.mp4" }
//
// Writers always emit this shape. Readers accept it, and also treat
// non-envelope UTF-8 bytes as a legacy plain-text filename so we don't
// reject bytes written by earlier or third-party code.
//
// All filename values come from untrusted sources (the indexer, any
// uploader). Callers that route these into disk saves or UI paths must
// run them through `sanitizeFilename` or `sanitizeDisplayFilename`
// before use.

const METADATA_TYPE = 'sialo-object-meta';
const METADATA_VERSION = 1;

// 255 chars is safe across the filesystems we care about (NTFS/APFS
// use UTF-16 code units, ext4 uses bytes; 255 UTF-16 units is always
// ≤ 255 UTF-8 bytes for BMP content, and multi-byte filenames this
// long are pathological anyway).
const MAX_FILENAME_CHARS = 255;

// Display cap — generous, but keep pathological inputs out of the DOM.
const MAX_DISPLAY_CHARS = 300;

// Characters to strip unconditionally:
//   C0 controls + DEL: shell / FS hazards
//   Zero-width + BiDi overrides: filename-spoofing
const INVISIBLE_OR_CONTROL = /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

// Windows-reserved device names (case-insensitive, optionally with extension).
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const textEncoder = new TextEncoder();

/**
 * Encode a metadata object to bytes suitable for `PinnedObject.updateMetadata`.
 * The shape is fixed: envelope + a single optional `filename` field for now.
 */
export function encodeMetadata({ filename } = {}) {
  const envelope = { type: METADATA_TYPE, version: METADATA_VERSION };
  if (typeof filename === 'string' && filename.length > 0) {
    envelope.filename = filename;
  }
  return textEncoder.encode(JSON.stringify(envelope));
}

/**
 * Decode bytes returned by `PinnedObject.metadata()`. Returns `null` for
 * empty/null input, otherwise an object with at least `{ version, filename? }`.
 *
 * Non-envelope bytes are treated as a legacy plain-text filename so that
 * metadata written by earlier builds or third-party tools still renders.
 * Version 0 indicates this legacy-fallback path.
 */
export function decodeMetadata(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const text = textDecoder.decode(bytes);
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.type === METADATA_TYPE &&
        Number.isInteger(parsed.version)
      ) {
        return {
          version: parsed.version,
          filename: typeof parsed.filename === 'string' ? parsed.filename : undefined,
        };
      }
    } catch { /* fall through to legacy treatment */ }
  }
  // Legacy fallback: entire payload is a plain-text filename.
  return { version: 0, filename: text };
}

/**
 * Sanitize an untrusted filename for use in a save-to-disk dialog or as
 * a manifest path segment. Returns `null` when the input becomes empty
 * after sanitization — callers should fall back to a default (e.g. the
 * object ID) in that case.
 */
export function sanitizeFilename(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw.normalize('NFC');
  name = name.replace(INVISIBLE_OR_CONTROL, '');
  // Flatten path separators so the result is a leaf name, never a path.
  // Callers that want a path (e.g. site manifest keys) should use
  // sanitizeDisplayFilename or split and sanitize segments individually.
  name = name.replace(/[\\/]/g, '_');
  // Trim leading/trailing whitespace and dots. Trailing dots are stripped
  // by Windows silently; leading dots hide files on Unix.
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');
  if (name.length > MAX_FILENAME_CHARS) {
    // Preserve a short extension when truncating so downloads keep their
    // type. Longer "extensions" aren't really extensions.
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0 && name.length - dotIdx <= 10) {
      const ext = name.slice(dotIdx);
      name = name.slice(0, MAX_FILENAME_CHARS - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_FILENAME_CHARS);
    }
  }
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;
  return name.length > 0 ? name : null;
}

/**
 * Sanitize an untrusted filename for rendering in the UI. More permissive
 * than `sanitizeFilename` — keeps path separators (so multi-segment paths
 * like `assets/app.js` render) and returns a string (possibly empty) rather
 * than null. HTML escaping must happen at the render site via `_esc`.
 */
export function sanitizeDisplayFilename(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(INVISIBLE_OR_CONTROL, '')
    .slice(0, MAX_DISPLAY_CHARS);
}

/**
 * Strip a leading per-upload UUID path segment if present.
 *
 * The folder-upload flows prefix each object's filename metadata with
 * a `crypto.randomUUID()` so related files group together when sorted
 * in My Objects (`550e8400-…/index.html`, `550e8400-…/assets/app.js`).
 * When the object is added to a new site via the Site Builder
 * this prefix would leak into the new manifest path; callers use this
 * helper to drop it.
 *
 * Non-UUID inputs are returned unchanged.
 */
const UPLOAD_UUID_PREFIX_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
const UPLOAD_UUID_CAPTURE_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export function stripUploadUuid(filename) {
  if (typeof filename !== 'string') return '';
  return filename.replace(UPLOAD_UUID_PREFIX_RE, '');
}

/**
 * Extract the leading per-upload UUID from a filename, or `null` if none.
 * Returned value is lowercase so callers can use it as a group key.
 */
export function extractUploadUuid(filename) {
  if (typeof filename !== 'string') return null;
  const m = filename.match(UPLOAD_UUID_CAPTURE_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Convenience: pull the filename out of an object's raw metadata bytes,
 * sanitized for save-to-disk use. Returns `null` if the object has no
 * filename metadata or it sanitizes to empty.
 */
export function filenameForSave(bytes) {
  const meta = decodeMetadata(bytes);
  if (!meta || !meta.filename) return null;
  return sanitizeFilename(meta.filename);
}

/**
 * Convenience: pull the filename out of an object's raw metadata bytes,
 * sanitized for display. Returns an empty string if none.
 */
export function filenameForDisplay(bytes) {
  const meta = decodeMetadata(bytes);
  if (!meta || !meta.filename) return '';
  return sanitizeDisplayFilename(meta.filename);
}
