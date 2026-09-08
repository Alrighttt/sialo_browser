// Classifies what the user pasted into a "download this" field.
//
// The download path used to decide with `input.startsWith('sia://') ||
// input.startsWith('https://')` and treat everything else as a bare object ID.
// That quietly misroutes anything else: a `sialo://` address matches neither
// prefix, so the whole URL was handed to `sdk.object()`, which tried to parse
// it as a 32-byte hash and failed with the SDK's "Unexpected length" — an
// error about hex decoding, for what is really "that is a site, not a file".
//
// Kept separate from config.js so the download worker can import it too
// without pulling in anything that touches the DOM.

/**
 * The body of a `sialo://` site address, after the scheme. Either a 64 hex
 * character seed or manifest id with an optional path inside the site, or a
 * host serving a published object. Mirrors what browser.js will actually
 * resolve, so this module rejects exactly what that one cannot load.
 */
const SITE_BODY = /^(?:[0-9a-f]{64}(?:\/.*)?|[^/?#]+\/objects\/[0-9a-f]{64}(?:\/.*)?)$/i;

/** An object ID is a 32-byte hash: exactly 64 hex characters. */
export const OBJECT_ID_LENGTH = 64;

/**
 * Whether `value` is a content site address, as opposed to an app page.
 *
 * `sialo://` addresses both, so the scheme alone proves nothing: `sialo://wallet`
 * is an internal panel and must never be treated as loadable content. Anything
 * that acts on an address supplied by untrusted input — a link inside a
 * sandboxed site, a URL fragment — has to gate on the shape, not the scheme.
 */
export function isSiteAddress(value) {
  const v = String(value || '').trim();
  return /^sialo:\/\//i.test(v) && SITE_BODY.test(v.slice('sialo://'.length));
}

/**
 * Returns what `raw` is:
 *
 *   { kind: 'id',        value }   a bare 64-hex object ID
 *   { kind: 'publishUrl', value }  a signed sia:// or https:// published URL
 *   { kind: 'site',      value }   a sialo:// address: a whole site
 *   { kind: 'invalid',   reason }  with a message worth showing the user
 */
export function classifyObjectInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'invalid', reason: 'Enter an object ID or published URL.' };

  if (/^sialo:\/\//i.test(value)) {
    // `sialo://` addresses both app pages (sialo://download) and content
    // sites, so the scheme alone does not make something a site. Check the
    // shape: a site is a 64-hex seed or manifest id, optionally with a path
    // inside it, or a host carrying a published `/objects/<id>/` path.
    // Without this, typing an app page into a download field would be sent
    // to the site loader and fail with an error about sharing keys rather
    // than saying the address is not a file.
    if (SITE_BODY.test(value.slice('sialo://'.length))) {
      return { kind: 'site', value };
    }
    return {
      kind: 'invalid',
      reason: 'That is not a site address. A site is sialo:// followed by 64 hex characters.',
    };
  }
  if (/^(sia|https):\/\//i.test(value)) {
    return { kind: 'publishUrl', value };
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return { kind: 'id', value: value.toLowerCase() };
  }

  // Hex but the wrong length is worth saying out loud: a truncated or
  // over-copied ID is by far the most common paste error, and the SDK's own
  // message for it ("Unexpected length") does not say what the length should
  // have been or what it got.
  if (/^[0-9a-f]+$/i.test(value)) {
    return {
      kind: 'invalid',
      reason: `An object ID is ${OBJECT_ID_LENGTH} hex characters; this one has ${value.length}.`,
    };
  }
  return {
    kind: 'invalid',
    reason: 'Not an object ID or a sia:// published URL.',
  };
}

/**
 * The object ID embedded in a published or site URL, or null. Used to explain
 * a malformed URL rather than to resolve one: the signature and encryption key
 * in the URL are what actually fetch the object.
 */
export function objectIdInUrl(value) {
  const m = String(value || '').match(/\/objects\/([0-9a-f]+)/i);
  return m ? m[1] : null;
}
