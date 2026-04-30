
const CHUNK_MAX = 2 * 1024 * 1024;
const servedFromOpfs = new Set();

async function opfsLoadFallback(key) {
    try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(key);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
    } catch (_) {
        return null;
    }
}

function openSyncerDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('sia_syncer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cache');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function clearChunked(db, key) {
    // Sweep any prior chunked layout at this key. We don't know the
    // previous numChunks, so iterate until a chunk is missing. Bounded
    // to guard against pathological store states.
    for (let i = 0; i < 4096; i++) {
        const chunkKey = key + ':chunk:' + i;
        const exists = await new Promise((resolve) => {
            const tx = db.transaction('cache', 'readonly');
            const get = tx.objectStore('cache').getKey(chunkKey);
            get.onsuccess = () => resolve(get.result !== undefined);
            get.onerror = () => resolve(false);
        });
        if (!exists) break;
        await new Promise((resolve) => {
            const tx = db.transaction('cache', 'readwrite');
            const del = tx.objectStore('cache').delete(chunkKey);
            del.onsuccess = () => resolve();
            del.onerror = () => resolve();
        });
    }
}

export function idb_save(key, data) {
    return new Promise(async (resolve, reject) => {
        const db = await openSyncerDb().catch(reject);
        if (!db) return;
        try {
            const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
            await clearChunked(db, key);

            if (arr.byteLength <= CHUNK_MAX) {
                await new Promise((res, rej) => {
                    const tx = db.transaction('cache', 'readwrite');
                    tx.objectStore('cache').put(arr, key);
                    tx.oncomplete = () => res();
                    tx.onerror = () => rej(tx.error);
                });
            } else {
                const numChunks = Math.ceil(arr.byteLength / CHUNK_MAX);
                await new Promise((res, rej) => {
                    const tx = db.transaction('cache', 'readwrite');
                    tx.objectStore('cache').put(
                        { chunked: true, totalSize: arr.byteLength, numChunks }, key);
                    tx.oncomplete = () => res();
                    tx.onerror = () => rej(tx.error);
                });
                await new Promise((res, rej) => {
                    const tx = db.transaction('cache', 'readwrite');
                    const store = tx.objectStore('cache');
                    for (let i = 0; i < numChunks; i++) {
                        const start = i * CHUNK_MAX;
                        const end = Math.min(start + CHUNK_MAX, arr.byteLength);
                        store.put(arr.slice(start, end), key + ':chunk:' + i);
                    }
                    tx.oncomplete = () => res();
                    tx.onerror = () => rej(tx.error);
                });
            }
            resolve();
        } catch (e) {
            reject(e);
        } finally {
            db.close();
        }
    });
}

export function idb_load(key) {
    return new Promise(async (resolve) => {
        // Try IDB first; fall back to OPFS for any miss / failure.
        // Chrome's blob-backed record bug ("Failed to read large
        // IndexedDB value") and torn chunked layouts (parent meta
        // without all chunks) both manifest as IDB unable to return
        // the data. OPFS holds the same blob under the same key
        // (the JS host writes there as the source of truth) so the
        // WASM can read it without forcing a full peer re-sync.
        const fallback = async () => {
            const opfs = await opfsLoadFallback(key);
            // First-hit log only — subsequent reads of the same key
            // are quiet so the console isn't flooded during sync.
            if (opfs && !servedFromOpfs.has(key)) {
                servedFromOpfs.add(key);
                console.info('idb_load: serving', key, 'from OPFS (', opfs.byteLength, 'bytes)');
            }
            resolve(opfs);
        };

        let db;
        try { db = await openSyncerDb(); } catch (_) { return fallback(); }
        try {
            const meta = await new Promise((res) => {
                const tx = db.transaction('cache', 'readonly');
                const get = tx.objectStore('cache').get(key);
                get.onsuccess = () => res(get.result);
                get.onerror = () => res(undefined);
            });

            if (meta == null) { db.close(); return fallback(); }

            // Plain bytes path — what older saves and small saves use.
            if (meta instanceof Uint8Array) { db.close(); resolve(meta); return; }
            if (meta instanceof ArrayBuffer) { db.close(); resolve(new Uint8Array(meta)); return; }

            // Chunked layout — assemble. If any chunk is missing we
            // fall back to OPFS rather than null so the caller still
            // gets the cached data instead of doing a peer re-sync.
            if (meta && meta.chunked && Number.isFinite(meta.numChunks)) {
                const parts = new Array(meta.numChunks);
                let ok = true;
                for (let i = 0; i < meta.numChunks; i++) {
                    const part = await new Promise((res) => {
                        const tx = db.transaction('cache', 'readonly');
                        const get = tx.objectStore('cache').get(key + ':chunk:' + i);
                        get.onsuccess = () => res(get.result);
                        get.onerror = () => res(undefined);
                    });
                    if (!part) { ok = false; break; }
                    parts[i] = part instanceof Uint8Array ? part : new Uint8Array(part);
                }
                if (!ok) {
                    // Orphaned parent meta with missing chunks — usually
                    // a half-written save from a prior interrupted run.
                    // Delete the meta so the next read goes straight to
                    // OPFS without re-warning, and so the next idb_save
                    // gets a clean slate.
                    console.warn('idb_load: missing chunk for', key, '— purging orphan meta, trying OPFS');
                    try {
                        await new Promise((res) => {
                            const tx = db.transaction('cache', 'readwrite');
                            const del = tx.objectStore('cache').delete(key);
                            del.onsuccess = () => res();
                            del.onerror = () => res();
                        });
                    } catch (_) {}
                    db.close();
                    return fallback();
                }
                db.close();
                const total = parts.reduce((s, p) => s + p.byteLength, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { out.set(p, off); off += p.byteLength; }
                resolve(out); return;
            }

            console.warn('idb_load: unexpected value shape at', key, meta, '— trying OPFS');
            db.close();
            return fallback();
        } catch (e) {
            console.warn('idb_load: failed for', key, e, '— trying OPFS');
            try { db.close(); } catch (_) {}
            return fallback();
        }
    });
}
