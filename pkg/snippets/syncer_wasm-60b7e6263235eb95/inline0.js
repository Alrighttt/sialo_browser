
const CHUNK_MAX = 2 * 1024 * 1024;

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
        // Treat any read failure as cache miss. Chrome's blob-backed
        // record bug ("Failed to read large IndexedDB value") would
        // otherwise propagate up and break callers like the explorer's
        // block-by-height lookup. Returning null lets the WASM re-sync
        // from a peer instead of crashing.
        let db;
        try { db = await openSyncerDb(); } catch (_) { resolve(null); return; }
        try {
            const meta = await new Promise((res) => {
                const tx = db.transaction('cache', 'readonly');
                const get = tx.objectStore('cache').get(key);
                get.onsuccess = () => res(get.result);
                get.onerror = () => res(undefined);
            });

            if (meta == null) { resolve(null); return; }

            // Plain bytes path — what older saves and small saves use.
            if (meta instanceof Uint8Array) { resolve(meta); return; }
            if (meta instanceof ArrayBuffer) { resolve(new Uint8Array(meta)); return; }

            // Chunked layout — assemble. If any chunk is missing we
            // fall back to null so the caller can re-fetch cleanly.
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
                    console.warn('idb_load: missing chunk for', key, '— treating as miss');
                    resolve(null); return;
                }
                const total = parts.reduce((s, p) => s + p.byteLength, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { out.set(p, off); off += p.byteLength; }
                resolve(out); return;
            }

            console.warn('idb_load: unexpected value shape at', key, meta);
            resolve(null);
        } catch (e) {
            console.warn('idb_load: failed for', key, e);
            resolve(null);
        } finally {
            db.close();
        }
    });
}
