// Shared utility functions for the Sialo Browser.
//
// Pure helpers with no external dependencies — safe to import from any module.

// Debug logging helpers — gated by the Debug Logging checkbox in settings.
export function _dbg(...args) { if (localStorage.getItem('log-level') === 'debug') console.log(...args); }
export function _dbgWarn(...args) { if (localStorage.getItem('log-level') === 'debug') console.warn(...args); }

// HTML escaping for dynamic content inserted via innerHTML
export function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

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
