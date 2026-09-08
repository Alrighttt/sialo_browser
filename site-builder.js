// Site Builder draft — the list of files a sialo site is being assembled
// from. It is the staging area for both ways of handing a site out:
// Publish (a signed sialo:// URL) and Share (a sharing key).
//
// Entries come from two places and differ in one important way:
//
//   kind: 'object'  an object that already exists on Sia. Holds just the
//                   object ID, the user-chosen path, and a size for
//                   display. Persisted to localStorage, so it survives
//                   reloads and is visible to other tabs.
//
//   kind: 'file'    a local File the user dropped, not yet uploaded. The
//                   File handle CANNOT be serialised, so these live in
//                   memory only and are lost on reload. Publishing or
//                   sharing uploads them and turns them into 'object'
//                   entries in place, at which point they persist.
//
// Both kinds carry an `id`, so remove / rename work the same on either.
// Local ids are synthetic (`local:<n>:<path>`) and never reach the SDK.
//
// `site-builder-change` CustomEvents fire on `window` whenever the draft
// mutates, so any open UI can observe and redraw.

/** An object that already exists on Sia. Persisted across reloads. */
export const KIND_OBJECT = 'object';

/** A local File the user dropped, not yet uploaded. Memory-only. */
export const KIND_FILE = 'file';

const STORAGE_KEY = 'site-builder-draft';

let cached = null;

/** Monotonic counter behind synthetic local ids, unique per session. */
let localSeq = 0;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    // Defensive filter: drop entries that don't look right. Drafts written
    // before entries had a `kind` are all real objects, so default to that.
    return parsed
      .filter((e) => e && typeof e.id === 'string' && typeof e.filename === 'string')
      .map((e) => ({ ...e, kind: e.kind === KIND_FILE ? KIND_OBJECT : (e.kind || KIND_OBJECT) }));
  } catch {
    return [];
  }
}

/** Only real objects can be written to storage; local Files cannot. */
function persistable(entry) {
  return entry.kind !== KIND_FILE;
}

function persist(entries) {
  cached = entries;
  try {
    // Local file entries are dropped from storage but kept in `cached`, so
    // an unrelated mutation (My Objects adding an object, say) does not
    // discard the files the user just dropped.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.filter(persistable)));
  } catch (_) {
    // Quota errors or disabled storage — swallow; the draft lives in
    // memory for the rest of the session.
  }
  window.dispatchEvent(new CustomEvent('site-builder-change'));
}

export function getDraft() {
  if (cached === null) cached = loadFromStorage();
  return cached.slice();
}

export function isInDraft(id) {
  if (cached === null) cached = loadFromStorage();
  return cached.some((e) => e.id === id);
}

/**
 * Add or update a draft entry for an object that already exists on Sia.
 * If an entry with the same ID is present it is replaced (useful for
 * rename / re-add flows).
 */
export function addToDraft({ id, filename, size }) {
  const entries = getDraft();
  const idx = entries.findIndex((e) => e.id === id);
  const entry = { kind: KIND_OBJECT, id, filename, size: size || 0, addedAt: Date.now() };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  persist(entries);
}

/**
 * Append local files chosen from the dropzone. `files` is the
 * `[{ relPath, file }]` shape the folder collector produces; `relPath` is
 * the path the file will have inside the site.
 *
 * Adding does not upload. The returned entries are pending until
 * `materializeEntry` replaces them with real object IDs.
 */
export function addFilesToDraft(files) {
  const entries = getDraft();
  for (const { relPath, file } of files) {
    localSeq += 1;
    entries.push({
      kind: KIND_FILE,
      id: `local:${localSeq}:${relPath}`,
      filename: relPath,
      size: file.size || 0,
      addedAt: Date.now(),
      file,
    });
  }
  persist(entries);
}

/**
 * Replace a pending local entry with the real object it uploaded to,
 * keeping its position and its (possibly renamed) path. Called once per
 * file after a publish or share uploads the draft, so a second action on
 * the same draft costs no re-upload.
 */
export function materializeEntry(localId, { id, size }) {
  const entries = getDraft();
  const idx = entries.findIndex((e) => e.id === localId);
  if (idx < 0) return;
  entries[idx] = {
    kind: KIND_OBJECT,
    id,
    filename: entries[idx].filename,
    size: size || entries[idx].size || 0,
    addedAt: entries[idx].addedAt,
  };
  persist(entries);
}

/** The pending local files, in draft order. Empty once everything is uploaded. */
export function pendingFiles() {
  return getDraft().filter((e) => e.kind === KIND_FILE);
}

export function removeFromDraft(id) {
  const entries = getDraft().filter((e) => e.id !== id);
  persist(entries);
}

export function clearDraft() {
  persist([]);
}

export function updateFilename(id, filename) {
  const entries = getDraft();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  entry.filename = filename;
  persist(entries);
}

/**
 * Subscribe to draft mutations. Returns an unsubscribe function.
 * Observers get the current draft each time it changes.
 */
export function onDraftChange(cb) {
  const handler = () => cb(getDraft());
  window.addEventListener('site-builder-change', handler);
  return () => window.removeEventListener('site-builder-change', handler);
}
