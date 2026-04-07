// Keep-alive utilities to prevent the browser from killing/throttling
// the tab during long-running upload and download operations.
//
// Uses Web Locks API (prevents tab discard) and Screen Wake Lock
// (prevents screen sleep). Both are best-effort — operations should
// still handle interruption gracefully.

let _lockHeld = 0;
let _lockRelease = null;
let _wakeLock = null;

/**
 * Acquire a keep-alive lock. Multiple callers can acquire — the lock
 * is held as long as at least one caller hasn't released.
 * Returns a release function.
 */
export async function acquireKeepAlive() {
  _lockHeld++;

  // Web Locks API — prevents tab from being discarded
  if (_lockHeld === 1 && navigator.locks) {
    const lockPromise = new Promise(resolve => {
      _lockRelease = resolve;
    });
    navigator.locks.request('sialo-active-transfer', () => lockPromise).catch(() => {});
  }

  // Screen Wake Lock — prevents screen sleep (requires secure context)
  if (_lockHeld === 1 && navigator.wakeLock) {
    try {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    } catch (_) {
      // Wake lock denied — user gesture required or not supported
    }
  }

  return function release() {
    _lockHeld = Math.max(0, _lockHeld - 1);
    if (_lockHeld === 0) {
      if (_lockRelease) { _lockRelease(); _lockRelease = null; }
      if (_wakeLock) { _wakeLock.release().catch(() => {}); _wakeLock = null; }
    }
  };
}

/**
 * Wrap an async operation with keep-alive. The lock is held for the
 * duration of the promise.
 *
 * Usage:
 *   const result = await withKeepAlive(() => longRunningOperation());
 */
export async function withKeepAlive(fn) {
  const release = await acquireKeepAlive();
  try {
    return await fn();
  } finally {
    release();
  }
}
