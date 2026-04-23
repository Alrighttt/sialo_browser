// Site Builder draft — a persistent list of object references the user
// is assembling into a sia-site. Stored in localStorage so the draft
// survives page reloads and works across tabs/panels.
//
// Entries hold only the data needed to publish: the object ID, the
// user-chosen filename, and the size for display. Share URLs are
// NOT stored — they're generated at publish time so the caller can
// pick the validity window once for all entries at once.
//
// `site-builder-change` CustomEvents fire on `window` whenever the
// draft mutates, so any open UI can observe and redraw.

const STORAGE_KEY = 'site-builder-draft';

let cached = null;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    // Defensive filter: drop entries that don't look right
    return parsed.filter(
      (e) => e && typeof e.id === 'string' && typeof e.filename === 'string',
    );
  } catch {
    return [];
  }
}

function persist(entries) {
  cached = entries;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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
 * Add or update a draft entry. If an entry with the same ID already
 * exists it is replaced (useful for rename / re-add flows).
 */
export function addToDraft({ id, filename, size }) {
  const entries = getDraft();
  const idx = entries.findIndex((e) => e.id === id);
  const entry = { id, filename, size: size || 0, addedAt: Date.now() };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  persist(entries);
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
