
export function idb_save(key, data) {
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

export function idb_load(key) {
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
