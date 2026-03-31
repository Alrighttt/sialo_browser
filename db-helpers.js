// Shared IndexedDB and OPFS helpers.
// Used by chain.js (main thread) and network-sync-worker.js (Web Worker).

// --- IndexedDB: sia_filters store ---

export function filterDbLoad(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_filters', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const tx = req.result.transaction('files', 'readonly');
      const get = tx.objectStore('files').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result || null); };
      get.onerror = () => { req.result.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

export function filterDbDelete(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_filters', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const tx = req.result.transaction('files', 'readwrite');
      const del = tx.objectStore('files').delete(key);
      del.onsuccess = () => { req.result.close(); resolve(); };
      del.onerror = () => { req.result.close(); reject(del.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

// --- IndexedDB: sia_syncer store ---

export function syncerDbLoad(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readonly');
      const get = tx.objectStore('cache').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result || null); };
      get.onerror = () => { req.result.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

export function syncerDbSave(key, data) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readwrite');
      tx.objectStore('cache').put(data, key);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => { req.result.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

export function syncerDbDelete(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => {
      const tx = req.result.transaction('cache', 'readwrite');
      const del = tx.objectStore('cache').delete(key);
      del.onsuccess = () => { req.result.close(); resolve(); };
      del.onerror = () => { req.result.close(); reject(del.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Chunked IndexedDB storage for large blobs ---
// Splits data into 2MB pieces to avoid Chrome's "Failed to read large IndexedDB value" error.

const CHUNK_MAX = 2 * 1024 * 1024; // 2MB per chunk

export async function syncerDbSaveChunked(key, data, logFn) {
  const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (arr.byteLength <= CHUNK_MAX && !logFn) {
    // Small enough — save directly (fast path for chain.js)
    await syncerDbSave(key, arr);
    return;
  }
  const numChunks = Math.ceil(arr.byteLength / CHUNK_MAX);
  if (numChunks === 1 && !logFn) {
    await syncerDbSave(key, arr);
    return;
  }
  const sizeMB = (arr.byteLength / 1024 / 1024).toFixed(1);
  if (logFn) logFn(`Saving ${sizeMB} MB in ${numChunks} chunks...`, 'data');

  // Use a single DB connection for metadata + chunks
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    // Save metadata
    await new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put({ chunked: true, totalSize: arr.byteLength, numChunks }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Save all chunks in a single transaction
    await new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_MAX;
        const end = Math.min(start + CHUNK_MAX, arr.byteLength);
        store.put(arr.slice(start, end), key + ':chunk:' + i);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (logFn) logFn(`Saved ${numChunks} chunks (${sizeMB} MB)`, 'data');
  } finally {
    db.close();
  }
}

export async function syncerDbLoadChunked(key) {
  const meta = await syncerDbLoad(key);
  if (!meta) return null;
  // Handle non-chunked legacy data
  if (!(meta.chunked)) return meta;
  const { numChunks } = meta;
  // Read all chunks in a single transaction, assemble via Blob
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('sia_syncer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const chunkParts = await new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      const parts = new Array(numChunks);
      let loaded = 0;
      for (let i = 0; i < numChunks; i++) {
        const get = store.get(key + ':chunk:' + i);
        get.onsuccess = () => {
          parts[i] = get.result ? (get.result instanceof Uint8Array ? get.result : new Uint8Array(get.result)) : null;
          loaded++;
          if (loaded === numChunks) resolve(parts);
        };
        get.onerror = () => reject(get.error);
      }
      if (numChunks === 0) resolve([]);
    });
    for (let i = 0; i < numChunks; i++) {
      if (!chunkParts[i]) throw new Error(`Missing chunk ${i} for key ${key}`);
    }
    const blob = new Blob(chunkParts, { type: 'application/octet-stream' });
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    db.close();
  }
}

export async function syncerDbDeleteChunked(key) {
  const meta = await syncerDbLoad(key);
  if (meta && meta.chunked) {
    for (let i = 0; i < meta.numChunks; i++) {
      await syncerDbDelete(key + ':chunk:' + i);
    }
  }
  await syncerDbDelete(key);
}

// --- OPFS (Origin Private File System) for large binary data ---

export async function opfsSave(key, data) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(key, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function opfsLoad(key) {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(key);
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (e) {
    // NotFoundError means no cached file
    return null;
  }
}

export async function opfsDelete(key) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(key);
  } catch (e) {
    // Ignore if not found
  }
}
