
const IDB_CHUNK_MAX = 2 * 1024 * 1024; // 2MB per chunk

// In-memory cache — avoids IndexedDB reads which are unreliable in Chrome
// for large values. Data is cached on save and served from memory on load.
const _memCache = new Map();

// Allow external code to pre-populate the cache
export function _injectCache(key, value) {
    _memCache.set(key, value);
}

function _idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('sia_syncer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cache');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function idb_save(key, data) {
    // Always cache in memory for fast reads within the session
    _memCache.set(key, data);

    try {
        const db = await _idbOpen();
        try {
            if (!data || !data.byteLength || data.byteLength <= IDB_CHUNK_MAX) {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('cache', 'readwrite');
                    tx.objectStore('cache').put(data, key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                });
            } else {
                const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
                const numChunks = Math.ceil(arr.byteLength / IDB_CHUNK_MAX);
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('cache', 'readwrite');
                    const store = tx.objectStore('cache');
                    store.put({ chunked: true, totalSize: arr.byteLength, numChunks }, key);
                    for (let i = 0; i < numChunks; i++) {
                        const start = i * IDB_CHUNK_MAX;
                        const end = Math.min(start + IDB_CHUNK_MAX, arr.byteLength);
                        store.put(arr.slice(start, end), key + ':chunk:' + i);
                    }
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                });
            }
        } finally {
            db.close();
        }
    } catch (e) {
        // IndexedDB write failed — data is still in memory cache
    }
}

export async function idb_load(key) {
    // Serve from memory cache if available
    if (_memCache.has(key)) {
        return _memCache.get(key);
    }

    // Fall back to IndexedDB
    try {
        const db = await _idbOpen();
        try {
            const meta = await new Promise((resolve, reject) => {
                const tx = db.transaction('cache', 'readonly');
                const get = tx.objectStore('cache').get(key);
                get.onsuccess = () => resolve(get.result || null);
                get.onerror = () => reject(get.error);
            });
            if (!meta) return null;
            if (!meta.chunked) {
                _memCache.set(key, meta);
                return meta;
            }
            // Chunked — reassemble
            const { numChunks } = meta;
            const parts = [];
            for (let i = 0; i < numChunks; i++) {
                const chunk = await new Promise((resolve, reject) => {
                    const tx = db.transaction('cache', 'readonly');
                    const get = tx.objectStore('cache').get(key + ':chunk:' + i);
                    get.onsuccess = () => resolve(get.result || null);
                    get.onerror = () => reject(get.error);
                });
                if (!chunk) return null;
                parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
            const blob = new Blob(parts);
            const buffer = await blob.arrayBuffer();
            const result = new Uint8Array(buffer);
            _memCache.set(key, result);
            return result;
        } finally {
            db.close();
        }
    } catch (e) {
        return null;
    }
}
