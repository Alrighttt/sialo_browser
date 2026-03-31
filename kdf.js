// KDF Worker — manages a Web Worker that performs encrypt/decrypt off the main thread.
//
// Uses syncer_wasm's PBKDF2 key derivation via a dedicated worker so the UI
// stays responsive during the (intentionally slow) key stretching.

let _kdfWorker = null;
let _kdfReady = false;
const _kdfCallbacks = new Map();
let _kdfIdCounter = 0;

export function initKdfWorker() {
  _kdfWorker = new Worker('./kdf-worker.js', { type: 'module' });
  _kdfWorker.onmessage = (e) => {
    if (e.data.type === 'ready') { _kdfReady = true; return; }
    const cb = _kdfCallbacks.get(e.data.id);
    if (!cb) return;
    _kdfCallbacks.delete(e.data.id);
    if (e.data.type === 'error') cb.reject(new Error(e.data.error));
    else cb.resolve(e.data.result);
  };
  _kdfWorker.postMessage({ type: 'init', wasmUrl: './pkg/syncer_wasm_bg.wasm' });
}

export function kdfEncrypt(entropyHex, password) {
  return new Promise((resolve, reject) => {
    const id = ++_kdfIdCounter;
    _kdfCallbacks.set(id, { resolve, reject });
    _kdfWorker.postMessage({ type: 'encrypt', id, entropyHex, password });
  });
}

export function kdfDecrypt(encryptedHex, password) {
  return new Promise((resolve, reject) => {
    const id = ++_kdfIdCounter;
    _kdfCallbacks.set(id, { resolve, reject });
    _kdfWorker.postMessage({ type: 'decrypt', id, encryptedHex, password });
  });
}
