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

export function formatSize(bytes) {
  if (bytes < 1e3) return bytes + ' B';
  if (bytes < 1e6) return (bytes / 1e3).toFixed(1) + ' KB';
  if (bytes < 1e9) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes < 1e12) return (bytes / 1e9).toFixed(2) + ' GB';
  return (bytes / 1e12).toFixed(2) + ' TB';
}

/**
 * Modal prompt for share-URL expiry. Returns `{ validUntil: Date, durationText: string }`
 * if the user confirmed, or `null` if they cancelled. `subject` is a
 * short label shown in the dialog ("Object abcd…ef12", "Site xyz…", etc.).
 */
export function promptShareDuration(subject) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000;';
    modal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:500px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Generate Share URL</h3>
        <p style="color:#888; margin-bottom:1.5rem;">${_esc(subject || '')}</p>
        <div style="margin-bottom:1.5rem;">
          <div style="color:#e0e0e0; margin-bottom:0.5rem; font-size:0.9rem;">Expires in</div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input id="_share-dur" type="number" value="24" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
            <select id="_share-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
              <option value="3600000">hours</option>
              <option value="86400000" selected>days</option>
              <option value="604800000">weeks</option>
              <option value="2592000000">months (30d)</option>
              <option value="31536000000">years</option>
            </select>
          </div>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button id="_share-ok" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">Generate Link</button>
          <button id="_share-cancel" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cleanup = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) { cleanup(); resolve(null); } });
    modal.querySelector('#_share-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
    modal.querySelector('#_share-ok').addEventListener('click', () => {
      const dur = parseFloat(modal.querySelector('#_share-dur').value);
      const unitSel = modal.querySelector('#_share-unit');
      const unit = parseInt(unitSel.value, 10);
      if (!dur || dur <= 0 || !unit) { cleanup(); resolve(null); return; }
      const validUntil = new Date(Date.now() + dur * unit);
      const durationText = `${dur} ${unitSel.selectedOptions[0].text}`;
      cleanup();
      resolve({ validUntil, durationText });
    });
    // Focus the duration input for quick keyboard entry.
    setTimeout(() => modal.querySelector('#_share-dur').focus(), 0);
  });
}
