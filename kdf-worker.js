// Web Worker for PBKDF2 key derivation (encrypt/decrypt entropy).
// Runs the expensive KDF off the main thread so the UI stays responsive.

import init, { encrypt_entropy, decrypt_entropy } from './pkg/syncer_wasm.js';

let wasmReady = false;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await init({ module_or_path: e.data.wasmUrl });
      wasmReady = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: 'WASM init failed: ' + err });
    }
    return;
  }

  if (!wasmReady) {
    self.postMessage({ type: 'error', id: e.data.id, error: 'WASM not initialized' });
    return;
  }

  if (type === 'encrypt') {
    try {
      const result = encrypt_entropy(e.data.entropyHex, e.data.password);
      self.postMessage({ type: 'result', id: e.data.id, result });
    } catch (err) {
      self.postMessage({ type: 'error', id: e.data.id, error: '' + err });
    }
    return;
  }

  if (type === 'decrypt') {
    try {
      const result = decrypt_entropy(e.data.encryptedHex, e.data.password);
      self.postMessage({ type: 'result', id: e.data.id, result });
    } catch (err) {
      self.postMessage({ type: 'error', id: e.data.id, error: '' + err });
    }
    return;
  }
};
