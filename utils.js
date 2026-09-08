// Shared utility functions for the Sialo Browser.
//
// Pure helpers with no external dependencies — safe to import from any module.

// Debug logging helpers — gated by the Debug Logging checkbox in settings.
export function _dbg(...args) { if (localStorage.getItem('log-level') === 'debug') console.log(...args); }
export function _dbgWarn(...args) { if (localStorage.getItem('log-level') === 'debug') console.warn(...args); }

// HTML escaping for dynamic content inserted via innerHTML
export function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

export function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return hex(arr);
}

export function fromHex(h) {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Turn an SDK error into something a reader can act on.
 *
 * A network failure inside the WASM SDK arrives as a reqwest error wrapping a
 * raw JsValue, which prints as twenty lines of wasm-function frames and never
 * names the host it could not reach. "TypeError: Failed to fetch" in
 * particular means the request never completed at the network layer at all —
 * so there is no status code to report, and the useful information is which
 * host was being asked and why a browser would refuse to ask it.
 *
 * The https note is the non-obvious one. A `sia://` published URL is always
 * re-fetched over https, unconditionally: the SDK rewrites the scheme
 * (SHARE_URL_FETCH_SCHEME is "https" in every non-test build). An indexer
 * served over plain http therefore mints URLs that cannot be resolved again,
 * and the TLS handshake against a plaintext port fails exactly like an
 * offline host.
 *
 * `url` is optional; pass the address being resolved so the host can be named.
 */
export function explainSdkError(err, url) {
  const raw = (err && err.message) || String(err || '');
  if (!/Failed to fetch|kind: Request|NetworkError|ERR_/i.test(raw)) {
    // Not a transport failure — the SDK's own message is the better one.
    return raw;
  }
  let host = '';
  try {
    const m = String(url || '').match(/^[a-z][\w+.-]*:\/\/([^/?#]+)/i);
    if (m) host = m[1];
  } catch (_) { /* best effort */ }

  // The object id survives in the address even when the host does not, and a
  // bare id resolves through whatever indexer is configured now, using the
  // app key rather than the link's signature. That is the way back to content
  // whose published URL has died — provided the object is still on the
  // account, which is why this is phrased as something to try.
  let objectId = '';
  try {
    const m = String(url || '').match(/\/objects\/([0-9a-f]{64})/i);
    if (m) objectId = m[1].toLowerCase();
  } catch (_) { /* best effort */ }

  return (host
    // Say where the host came from. It is fixed into a published URL when the
    // URL is minted, from whatever indexer was configured at the time, so it
    // is frequently not the indexer the reader is connected to now — and
    // being told about an unfamiliar host with no explanation is confusing.
    ? `Could not reach ${host}, which is the host named inside this link`
      + ' rather than the indexer you are connected to. A published URL keeps'
      + ' the host it was created with.'
    : 'The request never reached the network.')
    + ' The browser refused or failed the request before any reply came back,'
    + ' so there is no error from the indexer to report. Usually one of:'
    + ' the host is offline, renamed or gone;'
    + ' it serves plain http, and a published URL is always re-fetched'
    + ' over https, so it cannot be resolved again;'
    + ' or it does not allow requests from this page (CORS).'
    + (objectId
      ? ` The link cannot be pointed at another host, because its signature`
        + ` covers the host name. The object ID survives though — try`
        + ` ${objectId} in the address bar, which resolves through your`
        + ` current indexer if the object is still on your account.`
      : '');
}

export function formatSize(bytes) {
  if (bytes < 1e3) return bytes + ' B';
  if (bytes < 1e6) return (bytes / 1e3).toFixed(1) + ' KB';
  if (bytes < 1e9) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes < 1e12) return (bytes / 1e9).toFixed(2) + ' GB';
  return (bytes / 1e12).toFixed(2) + ' TB';
}

/**
 * Modal prompt for publish-URL expiry. Returns `{ validUntil: Date, durationText: string }`
 * if the user confirmed, or `null` if they cancelled. `subject` is a
 * short label shown in the dialog ("Object abcd…ef12", "Site xyz…", etc.).
 */
export function promptPublishDuration(subject) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000;';
    modal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:500px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Publish object</h3>
        <p style="color:#888; margin-bottom:1.5rem;">${_esc(subject || '')}</p>
        <div style="margin-bottom:1.5rem;">
          <div style="color:#e0e0e0; margin-bottom:0.5rem; font-size:0.9rem;">Expires in</div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input id="_publish-dur" type="number" value="24" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
            <select id="_publish-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
              <option value="3600000">hours</option>
              <option value="86400000" selected>days</option>
              <option value="604800000">weeks</option>
              <option value="2592000000">months (30d)</option>
              <option value="31536000000">years</option>
            </select>
          </div>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button id="_publish-ok" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">Generate Link</button>
          <button id="_publish-cancel" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cleanup = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) { cleanup(); resolve(null); } });
    modal.querySelector('#_publish-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
    modal.querySelector('#_publish-ok').addEventListener('click', () => {
      const dur = parseFloat(modal.querySelector('#_publish-dur').value);
      const unitSel = modal.querySelector('#_publish-unit');
      const unit = parseInt(unitSel.value, 10);
      if (!dur || dur <= 0 || !unit) { cleanup(); resolve(null); return; }
      const validUntil = new Date(Date.now() + dur * unit);
      const durationText = `${dur} ${unitSel.selectedOptions[0].text}`;
      cleanup();
      resolve({ validUntil, durationText });
    });
    // Focus the duration input for quick keyboard entry.
    setTimeout(() => modal.querySelector('#_publish-dur').focus(), 0);
  });
}
