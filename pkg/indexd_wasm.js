/* @ts-self-types="./indexd_wasm.d.ts" */

export class AppKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AppKey.prototype);
        obj.__wbg_ptr = ptr;
        AppKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AppKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_appkey_free(ptr, 0);
    }
    /**
     * Exports the full 64-byte ed25519 keypair.
     * @returns {Uint8Array}
     */
    export() {
        const ret = wasm.appkey_export(this.__wbg_ptr);
        return ret;
    }
    /**
     * Imports an AppKey from a 64-byte ed25519 keypair or a 32-byte seed.
     * @param {Uint8Array} key
     */
    constructor(key) {
        const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.appkey_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        AppKeyFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns the hex-encoded public key.
     * @returns {string}
     */
    publicKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.appkey_publicKey(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Signs a message, returning the 64-byte signature.
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    sign(message) {
        const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.appkey_sign(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Verifies a signature against a message.
     * @param {Uint8Array} message
     * @param {Uint8Array} signature
     * @returns {boolean}
     */
    verifySignature(message, signature) {
        const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.appkey_verifySignature(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) AppKey.prototype[Symbol.dispose] = AppKey.prototype.free;

export class Builder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_builder_free(ptr, 0);
    }
    /**
     * Attempts to connect using an existing app key.
     *
     * Returns the SDK if authenticated, or null if the key is not recognized.
     * Call `requestConnection` if null is returned.
     * @param {AppKey} app_key
     * @returns {Promise<SDK>}
     */
    connected(app_key) {
        _assertClass(app_key, AppKey);
        const ret = wasm.builder_connected(this.__wbg_ptr, app_key.__wbg_ptr);
        return ret;
    }
    /**
     * Creates a new SDK builder for the given indexer URL.
     * @param {string} indexer_url
     */
    constructor(indexer_url) {
        const ptr0 = passStringToWasm0(indexer_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        BuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Registers the app using the user's recovery phrase and returns the SDK.
     * @param {string} mnemonic
     * @returns {Promise<SDK>}
     */
    register(mnemonic) {
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_register(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Requests a new app connection. Pass app metadata as a JSON object:
     * ```json
     * {
     *   "app_id": [32 bytes as hex],
     *   "name": "My App",
     *   "description": "...",
     *   "service_url": "https://...",
     *   "logo_url": "https://..." (optional),
     *   "callback_url": "https://..." (optional)
     * }
     * ```
     * @param {string} app_meta_json
     * @returns {Promise<void>}
     */
    requestConnection(app_meta_json) {
        const ptr0 = passStringToWasm0(app_meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_requestConnection(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Returns the response URL the user must visit to authorize the connection.
     * @returns {string}
     */
    responseUrl() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.builder_responseUrl(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Transitions the builder using a pre-fetched connection response.
     * Use this when the `POST /auth/connect` call was made out-of-band
     * (e.g. via curl) to work around CORS restrictions.
     *
     * `app_id_hex` is the hex-encoded app ID used in the request.
     * `response_json` is the JSON response from `POST /auth/connect`.
     * @param {string} app_id_hex
     * @param {string} response_json
     */
    setConnectionResponse(app_id_hex, response_json) {
        const ptr0 = passStringToWasm0(app_id_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(response_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.builder_setConnectionResponse(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Polls for approval. Resolves when the user approves.
     * @returns {Promise<void>}
     */
    waitForApproval() {
        const ret = wasm.builder_waitForApproval(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Builder.prototype[Symbol.dispose] = Builder.prototype.free;

/**
 * Download configuration exposed to JavaScript.
 */
export class DownloadOptions {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DownloadOptions.prototype);
        obj.__wbg_ptr = ptr;
        DownloadOptionsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DownloadOptionsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_downloadoptions_free(ptr, 0);
    }
    /**
     * @returns {DownloadOptions}
     */
    clone() {
        const ret = wasm.downloadoptions_clone(this.__wbg_ptr);
        return DownloadOptions.__wrap(ret);
    }
    constructor() {
        const ret = wasm.downloadoptions_new();
        this.__wbg_ptr = ret >>> 0;
        DownloadOptionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get maxInflight() {
        const ret = wasm.__wbg_get_downloadoptions_maxInflight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set maxInflight(arg0) {
        wasm.__wbg_set_downloadoptions_maxInflight(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) DownloadOptions.prototype[Symbol.dispose] = DownloadOptions.prototype.free;

export class PinnedObject {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PinnedObject.prototype);
        obj.__wbg_ptr = ptr;
        PinnedObjectFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PinnedObjectFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pinnedobject_free(ptr, 0);
    }
    /**
     * Returns the object's ID as a hex string.
     * @returns {string}
     */
    id() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.pinnedobject_id(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns the metadata as a Uint8Array.
     * @returns {Uint8Array}
     */
    metadata() {
        const ret = wasm.pinnedobject_metadata(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Opens a sealed object (JSON) using the provided app key.
     * @param {AppKey} app_key
     * @param {string} sealed_json
     * @returns {PinnedObject}
     */
    static open(app_key, sealed_json) {
        _assertClass(app_key, AppKey);
        const ptr0 = passStringToWasm0(sealed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pinnedobject_open(app_key.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PinnedObject.__wrap(ret[0]);
    }
    /**
     * Seals the object for offline storage, returning JSON.
     * @param {AppKey} app_key
     * @returns {string}
     */
    seal(app_key) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(app_key, AppKey);
            const ret = wasm.pinnedobject_seal(this.__wbg_ptr, app_key.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns the total size of the object in bytes.
     * @returns {number}
     */
    size() {
        const ret = wasm.pinnedobject_size(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Returns the number of slabs in the object.
     *
     * Useful for sizing a Web Worker pool (cap workers at slab count) and
     * for tracking completion when downloading or uploading slabs in parallel.
     * @returns {number}
     */
    slabCount() {
        const ret = wasm.pinnedobject_slabCount(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Returns the actual data length of each slab as a JS array of numbers.
     *
     * Useful for computing per-slab byte offsets and for accurate download
     * progress reporting.
     * @returns {Array<any>}
     */
    slabLengths() {
        const ret = wasm.pinnedobject_slabLengths(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Updates the metadata.
     * @param {Uint8Array} metadata
     */
    updateMetadata(metadata) {
        const ptr0 = passArray8ToWasm0(metadata, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pinnedobject_updateMetadata(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) PinnedObject.prototype[Symbol.dispose] = PinnedObject.prototype.free;

export class SDK {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SDK.prototype);
        obj.__wbg_ptr = ptr;
        SDKFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SDKFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sdk_free(ptr, 0);
    }
    /**
     * Returns account information as a JS object.
     * @returns {Promise<any>}
     */
    account() {
        const ret = wasm.sdk_account(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the app key used by this SDK instance.
     * @returns {AppKey}
     */
    appKey() {
        const ret = wasm.sdk_appKey(this.__wbg_ptr);
        return AppKey.__wrap(ret);
    }
    /**
     * Assembles a PinnedObject from a data key and an array of slab metadata JSONs.
     *
     * Used after parallel upload workers have uploaded all slabs independently.
     * The main thread collects the slab JSONs and calls this to create the
     * final object that can be pinned to the indexer.
     * @param {Uint8Array} data_key
     * @param {string} slabs_json
     * @returns {PinnedObject}
     */
    assembleObject(data_key, slabs_json) {
        const ptr0 = passArray8ToWasm0(data_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(slabs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_assembleObject(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PinnedObject.__wrap(ret[0]);
    }
    /**
     * Deletes an object from the indexer by its hex-encoded key.
     * @param {string} key
     * @returns {Promise<void>}
     */
    deleteObject(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_deleteObject(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Downloads an object's data with per-slab progress reporting.
     *
     * The `on_progress` callback receives `(current_slabs, total_slabs)`.
     * @param {PinnedObject} object
     * @param {DownloadOptions} options
     * @param {Function} on_progress
     * @returns {Promise<Uint8Array>}
     */
    download(object, options, on_progress) {
        _assertClass(object, PinnedObject);
        _assertClass(options, DownloadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_download(this.__wbg_ptr, object.__wbg_ptr, ptr0, on_progress);
        return ret;
    }
    /**
     * Downloads a single slab by index, returning its decrypted data as a Uint8Array.
     *
     * Used by slab download workers to enable parallel slab downloads across
     * multiple Web Workers, each with their own SDK instance and thread.
     *
     * The optional `on_host_active` callback is called with a Host object
     * each time a sector download is initiated, enabling the caller to display
     * which host is currently being downloaded from.
     *
     * The callback receives a JS object with fields:
     * `{ publicKey, addresses: [{protocol, address}], countryCode, latitude, longitude, goodForUpload }`
     * @param {PinnedObject} object
     * @param {number} slab_index
     * @param {DownloadOptions} options
     * @param {Function | null} [on_host_active]
     * @returns {Promise<Uint8Array>}
     */
    downloadSlabByIndex(object, slab_index, options, on_host_active) {
        _assertClass(object, PinnedObject);
        _assertClass(options, DownloadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_downloadSlabByIndex(this.__wbg_ptr, object.__wbg_ptr, slab_index, ptr0, isLikeNone(on_host_active) ? 0 : addToExternrefTable0(on_host_active));
        return ret;
    }
    /**
     * Downloads an object with streaming chunks.
     * Fires `on_chunk(bytes)` after each slab is decoded and `on_progress(bytesDownloaded, totalBytes)` for progress.
     * @param {PinnedObject} object
     * @param {DownloadOptions} options
     * @param {Function} on_chunk
     * @param {Function} on_progress
     * @returns {Promise<void>}
     */
    downloadStreaming(object, options, on_chunk, on_progress) {
        _assertClass(object, PinnedObject);
        _assertClass(options, DownloadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_downloadStreaming(this.__wbg_ptr, object.__wbg_ptr, ptr0, on_chunk, on_progress);
        return ret;
    }
    /**
     * Finalizes a chunked upload and returns the PinnedObject.
     * on_progress callback receives (current_shards, total_shards).
     * @param {number} session_id
     * @param {UploadOptions} options
     * @param {Function} on_progress
     * @returns {Promise<PinnedObject>}
     */
    finalizeChunkedUpload(session_id, options, on_progress) {
        _assertClass(options, UploadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_finalizeChunkedUpload(this.__wbg_ptr, session_id, ptr0, on_progress);
        return ret;
    }
    /**
     * Generates a random 32-byte encryption key for object-level encryption.
     * Used by parallel upload workers that share a single data key.
     * @returns {Uint8Array}
     */
    generateDataKey() {
        const ret = wasm.sdk_generateDataKey(this.__wbg_ptr);
        return ret;
    }
    /**
     * Queries a single host for account balance and prices.
     * Returns `{hostKey, balance, egressPrice, ingressPrice, storagePrice}`
     * or error fields `balanceError` / `pricesError`.
     * @param {string} host_key
     * @returns {Promise<any>}
     */
    hostAccountInfo(host_key) {
        const ptr0 = passStringToWasm0(host_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_hostAccountInfo(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Returns hosts as a JSON array.
     * @returns {Promise<any>}
     */
    hosts() {
        const ret = wasm.sdk_hosts(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the public keys of all known hosts as a JS string array.
     * @returns {any}
     */
    knownHosts() {
        const ret = wasm.sdk_knownHosts(this.__wbg_ptr);
        return ret;
    }
    /**
     * Lists objects from the indexer. Returns a JSON array of object events.
     * Each event has { id, deleted, updatedAt, size }.
     * Pass limit=0 or null to use the server default.
     * @param {number | null} [limit]
     * @returns {Promise<string>}
     */
    listObjects(limit) {
        const ret = wasm.sdk_listObjects(this.__wbg_ptr, isLikeNone(limit) ? 0x100000001 : (limit) >>> 0);
        return ret;
    }
    /**
     * Retrieves a pinned object by its hex-encoded key.
     * @param {string} key
     * @returns {Promise<PinnedObject>}
     */
    object(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_object(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Pins an object to the indexer.
     * @param {PinnedObject} object
     * @returns {Promise<void>}
     */
    pinObject(object) {
        _assertClass(object, PinnedObject);
        const ret = wasm.sdk_pinObject(this.__wbg_ptr, object.__wbg_ptr);
        return ret;
    }
    /**
     * Prunes unused slabs from the indexer.
     * @returns {Promise<void>}
     */
    pruneSlabs() {
        const ret = wasm.sdk_pruneSlabs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Creates a share URL for an object, valid until the given timestamp (ms since epoch).
     * @param {PinnedObject} object
     * @param {number} valid_until_ms
     * @returns {string}
     */
    shareObject(object, valid_until_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(object, PinnedObject);
            const ret = wasm.sdk_shareObject(this.__wbg_ptr, object.__wbg_ptr, valid_until_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Retrieves a shared object from a signed share URL.
     * Accepts `sia://` scheme URLs.
     * @param {string} share_url
     * @returns {Promise<PinnedObject>}
     */
    sharedObject(share_url) {
        const ptr0 = passStringToWasm0(share_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_sharedObject(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Returns the slab data size for default options (data_shards * SECTOR_SIZE).
     * Prefer `UploadOptions.slabDataSize()` for custom shard counts.
     * @returns {number}
     */
    slabDataSize() {
        const ret = wasm.sdk_slabDataSize(this.__wbg_ptr);
        return ret;
    }
    /**
     * Starts a new chunked upload session with the total file size.
     * Returns a session ID (as a number) to track this upload.
     *
     * Note: Due to WASM 32-bit limitations, maximum file size is approximately 1.5 GB.
     * @param {number} total_size
     * @returns {number}
     */
    startChunkedUpload(total_size) {
        const ret = wasm.sdk_startChunkedUpload(this.__wbg_ptr, total_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Starts a streaming upload that reads chunks on-demand from JavaScript.
     * This bypasses WASM memory limitations by never accumulating the entire file.
     *
     * Returns a StreamingUpload object with a `pushChunk` method and a `promise` property.
     * JavaScript should:
     * 1. Start pushing chunks immediately using `pushChunk(chunk)`
     * 2. Call `pushChunk(null)` to signal EOF when all chunks are sent
     * 3. `await upload.promise` to get the uploaded object
     *
     * # Example JavaScript Usage
     * ```javascript
     * const totalSize = file.size;
     * const upload = sdk.streamingUpload(totalSize, (current, total) => {
     *   console.log(`Progress: ${current}/${total} shards`);
     * });
     *
     * // Read and push chunks asynchronously
     * (async () => {
     *   const CHUNK_SIZE = 128 * 1024 * 1024; // 128 MB
     *   for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
     *     const chunk = file.slice(offset, offset + CHUNK_SIZE);
     *     const data = new Uint8Array(await chunk.arrayBuffer());
     *     upload.pushChunk(data);
     *   }
     *   upload.pushChunk(null); // Signal EOF
     * })();
     *
     * // Wait for upload to complete
     * const obj = await upload.promise;
     * ```
     * @param {number} total_size
     * @param {UploadOptions} options
     * @param {Function} on_progress
     * @returns {StreamingUpload}
     */
    streamingUpload(total_size, options, on_progress) {
        _assertClass(options, UploadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_streamingUpload(this.__wbg_ptr, total_size, ptr0, on_progress);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return StreamingUpload.__wrap(ret[0]);
    }
    /**
     * Updates the metadata of an object already stored in the indexer.
     * @param {PinnedObject} object
     * @returns {Promise<void>}
     */
    updateObjectMetadata(object) {
        _assertClass(object, PinnedObject);
        const ret = wasm.sdk_updateObjectMetadata(this.__wbg_ptr, object.__wbg_ptr);
        return ret;
    }
    /**
     * Uploads a Uint8Array with per-shard progress reporting.
     *
     * The `on_progress` callback receives `(current_shards, total_shards)`.
     * @param {Uint8Array} data
     * @param {UploadOptions} options
     * @param {Function} on_progress
     * @returns {Promise<PinnedObject>}
     */
    upload(data, options, on_progress) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(options, UploadOptions);
        var ptr1 = options.__destroy_into_raw();
        const ret = wasm.sdk_upload(this.__wbg_ptr, ptr0, len0, ptr1, on_progress);
        return ret;
    }
    /**
     * Adds a chunk to an existing upload session.
     * Returns the current offset after adding this chunk.
     * @param {number} session_id
     * @param {Uint8Array} chunk
     * @returns {number}
     */
    uploadChunk(session_id, chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_uploadChunk(this.__wbg_ptr, session_id, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Uploads a single slab's worth of raw data with object-level encryption
     * at the given stream offset. Returns the slab metadata as JSON.
     *
     * Used by parallel upload workers. Each worker calls this with a different
     * chunk of the file and the correct stream offset. The shared data_key
     * ensures all slabs can be decrypted together.
     *
     * The `on_progress` callback receives `(current_shards, total_shards)`.
     * @param {Uint8Array} data
     * @param {Uint8Array} data_key
     * @param {number} stream_offset
     * @param {UploadOptions} options
     * @param {Function} on_progress
     * @returns {Promise<string>}
     */
    uploadSlab(data, data_key, stream_offset, options, on_progress) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(data_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(options, UploadOptions);
        var ptr2 = options.__destroy_into_raw();
        const ret = wasm.sdk_uploadSlab(this.__wbg_ptr, ptr0, len0, ptr1, len1, stream_offset, ptr2, on_progress);
        return ret;
    }
}
if (Symbol.dispose) SDK.prototype[Symbol.dispose] = SDK.prototype.free;

/**
 * Handle for a streaming upload operation.
 * JavaScript should call `pushChunk(data)` for each chunk, then `pushChunk(null)` to signal EOF.
 * The `promise` resolves to a PinnedObject when the upload completes.
 */
export class StreamingUpload {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(StreamingUpload.prototype);
        obj.__wbg_ptr = ptr;
        StreamingUploadFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StreamingUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_streamingupload_free(ptr, 0);
    }
    /**
     * Returns the promise that resolves when the upload completes
     * @returns {Promise<any>}
     */
    get promise() {
        const ret = wasm.streamingupload_promise(this.__wbg_ptr);
        return ret;
    }
    /**
     * Pushes a chunk of data to the upload.
     * Pass data as Uint8Array. Call with `null` or `undefined` to signal EOF.
     *
     * **Backpressure**: This method applies backpressure to prevent memory exhaustion.
     * It returns a Promise that resolves when the chunk has been queued.
     * If the queue is full, it waits until space becomes available.
     *
     * **IMPORTANT**: JavaScript MUST await this Promise before pushing the next chunk:
     * ```javascript
     * await upload.pushChunk(data);  // ← await here!
     * ```
     * @param {Uint8Array | null} [chunk]
     * @returns {Promise<any>}
     */
    pushChunk(chunk) {
        var ptr0 = isLikeNone(chunk) ? 0 : passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.streamingupload_pushChunk(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) StreamingUpload.prototype[Symbol.dispose] = StreamingUpload.prototype.free;

/**
 * Upload configuration exposed to JavaScript.
 */
export class UploadOptions {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UploadOptions.prototype);
        obj.__wbg_ptr = ptr;
        UploadOptionsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UploadOptionsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_uploadoptions_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get dataShards() {
        const ret = wasm.__wbg_get_uploadoptions_dataShards(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get maxInflight() {
        const ret = wasm.__wbg_get_uploadoptions_maxInflight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get parityShards() {
        const ret = wasm.__wbg_get_uploadoptions_parityShards(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set dataShards(arg0) {
        wasm.__wbg_set_uploadoptions_dataShards(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set maxInflight(arg0) {
        wasm.__wbg_set_uploadoptions_maxInflight(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set parityShards(arg0) {
        wasm.__wbg_set_uploadoptions_parityShards(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {UploadOptions}
     */
    clone() {
        const ret = wasm.uploadoptions_clone(this.__wbg_ptr);
        return UploadOptions.__wrap(ret);
    }
    constructor() {
        const ret = wasm.uploadoptions_new();
        this.__wbg_ptr = ret >>> 0;
        UploadOptionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Size in bytes of data per slab (data_shards * SECTOR_SIZE).
     * @returns {number}
     */
    slabDataSize() {
        const ret = wasm.uploadoptions_slabDataSize(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get totalShardsPerSlab() {
        const ret = wasm.uploadoptions_totalShardsPerSlab(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) UploadOptions.prototype[Symbol.dispose] = UploadOptions.prototype.free;

/**
 * Connects to a host via WebTransport and fetches its settings/prices.
 *
 * `address` should be a host address like `host.example.com:9883`.
 * Returns the host settings as a JS object.
 * @param {string} address
 * @returns {Promise<any>}
 */
export function fetchHostSettings(address) {
    const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fetchHostSettings(ptr0, len0);
    return ret;
}

/**
 * Generates a new 12-word BIP-32 recovery phrase.
 * @returns {string}
 */
export function generateRecoveryPhrase() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generateRecoveryPhrase();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Install a panic hook and logging bridge so that Rust panics show a proper
 * stack trace and `log::debug!()` / `log::info!()` etc. appear in the browser
 * console.
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}

/**
 * Sets the log level filter. Accepts "debug", "info", "warn", or "error".
 * Allows JavaScript to control the verbosity of Rust logs at runtime.
 * @param {string} level
 */
export function setLogLevel(level) {
    const ptr0 = passStringToWasm0(level, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.setLogLevel(ptr0, len0);
}

/**
 * Validates a BIP-32 recovery phrase.
 * @param {string} phrase
 */
export function validateRecoveryPhrase(phrase) {
    const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validateRecoveryPhrase(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_83742b46f01ce22d: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_boolean_get_c0f3f60bac5a78d1: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_5398f5bb970e0daa: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_3c846841762788c1: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_781bc9f159099513: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_7ef6b97b02428fae: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_52709e72fb9f179c: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_395e606bd0ee4427: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_6b5b6b8576d35cb1: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_5ef96933660780b7: function(arg0) {
            arg0.abort();
        },
        __wbg_abort_6479c2d794ebf2ee: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_append_608dfb635ee8998f: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_eb8e9ca620af2a19: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_call_2d781c1f4d5c0ef8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_dcc2662fa17a72cf: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_e133b57c9155d22c: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_clearTimeout_6b8d9a38b9263d65: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_close_c832870bd73a39a1: function(arg0) {
            arg0.close();
        },
        __wbg_createBidirectionalStream_e83b56780f09f455: function(arg0) {
            const ret = arg0.createBidirectionalStream();
            return ret;
        },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_debug_4b9b1a2d5972be57: function(arg0) {
            console.debug(arg0);
        },
        __wbg_done_08ce71ee07e3bd17: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_error_8d9a8e04cd1d3588: function(arg0) {
            console.error(arg0);
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_fetch_5550a88cf343aaa9: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_9dad4fe911207b37: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getReader_b8b3f10b91ca5ca8: function(arg0) {
            const ret = arg0.getReader();
            return ret;
        },
        __wbg_getTime_1dad7b5386ddd2d9: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_getWriter_aa227dc9da7cfa39: function() { return handleError(function (arg0) {
            const ret = arg0.getWriter();
            return ret;
        }, arguments); },
        __wbg_get_326e41e095fb2575: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_3ef1eba1850ade27: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_has_926ef2ff40b308cf: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_eb2234545f9ff993: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_info_7d4e223bb1a7e671: function(arg0) {
            console.info(arg0);
        },
        __wbg_instanceof_ReadableStreamDefaultReader_ea05ae94796fb8b2: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ReadableStreamDefaultReader;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_9b4d9fd451e051b1: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_iterator_d8f549ec8fb061b1: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_ea16607d7b61445b: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_524eedafa26daa59: function(arg0) {
            console.log(arg0);
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_0837727332ac86ba: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_0_1dcafdf5e786e876: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_49d5571bd3f0c4d4: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_5f486cdf45a04d78: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_a70fbab9066b301f: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_ab79df5bd7c26067: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_c518c60af666645b: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_d098e265629cd10f: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h1c496811f36254ad(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = state0.b = 0;
            }
        },
        __wbg_new_from_slice_22da9388ac046e50: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_aaaeaf29cf802876: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h1c496811f36254ad(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = state0.b = 0;
            }
        },
        __wbg_new_with_length_825018a1616e9e55: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_options_03398c9521346351: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new WebTransport(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_and_init_b4b54d1a819bc724: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_11b99ee6237339e3: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_next_e01a967809d1aa68: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_16f0c993d5dd6c27: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_c6d7a7d35f74f6f1: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_pinnedobject_new: function(arg0) {
            const ret = PinnedObject.__wrap(arg0);
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_d62e5099504357e6: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_e87b0e732085a946: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_0c399741342fb10f: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_a082d78ce798393e: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_read_7f593a961a7f80ed: function(arg0) {
            const ret = arg0.read();
            return ret;
        },
        __wbg_readable_e1b8f6425c886a4b: function(arg0) {
            const ret = arg0.readable;
            return ret;
        },
        __wbg_ready_85d1551e2938e341: function(arg0) {
            const ret = arg0.ready;
            return ret;
        },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_ae8d83246e5bcc12: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_sdk_new: function(arg0) {
            const ret = SDK.__wrap(arg0);
            return ret;
        },
        __wbg_setTimeout_f757f00851f76c42: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_282384002438957f: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_7eaa4f96924fd6b3: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_bf7251625df30a02: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_body_a3d856b097dfda04: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_ec7e430c6056ebda: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_ed63183445882c65: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_headers_3c8fecc693b75327: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_8c015e8bcafd7be1: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_5a87f2c809cf37c2: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_signal_0cebecb698f25d21: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_166e1da31adcac18: function(arg0) {
            const ret = arg0.signal;
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8adb955bd33fac2f: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_f207c857566db248: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_bb9f1ba69d61b386: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_318629ab93a22955: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_stringify_5ae93966a84901ac: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_subarray_a068d24e39478a8a: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_text_372f5b91442c50f9: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_098abe61755d12f6: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_then_9e335f6dd892bc11: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_url_7fefc1820fba4e0c: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_21fc78aab0322612: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbg_warn_69424c2d92a2fa73: function(arg0) {
            console.warn(arg0);
        },
        __wbg_writable_f7c24eed46e6cadd: function(arg0) {
            const ret = arg0.writable;
            return ret;
        },
        __wbg_write_6c1ce79b0d7a43ff: function(arg0, arg1) {
            const ret = arg0.write(arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { dtor_idx: 653, function: Function { arguments: [NamedExternref("WebTransportBidirectionalStream")], shim_idx: 654, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h5df41059abe562b3, wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { dtor_idx: 653, function: Function { arguments: [NamedExternref("undefined")], shim_idx: 654, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h5df41059abe562b3, wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46_1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { dtor_idx: 678, function: Function { arguments: [], shim_idx: 679, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__ha994e4b6d1719794, wasm_bindgen__convert__closures_____invoke__h022a894ae72b9104);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { dtor_idx: 708, function: Function { arguments: [Externref], shim_idx: 709, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h22885050db612fd4, wasm_bindgen__convert__closures_____invoke__ha7b459d57f5990ae);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./indexd_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h022a894ae72b9104(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h022a894ae72b9104(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46_1(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h06225f5640e02f46_1(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__ha7b459d57f5990ae(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__ha7b459d57f5990ae(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h1c496811f36254ad(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h1c496811f36254ad(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const AppKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_appkey_free(ptr >>> 0, 1));
const BuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_builder_free(ptr >>> 0, 1));
const DownloadOptionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_downloadoptions_free(ptr >>> 0, 1));
const PinnedObjectFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pinnedobject_free(ptr >>> 0, 1));
const SDKFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sdk_free(ptr >>> 0, 1));
const StreamingUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_streamingupload_free(ptr >>> 0, 1));
const UploadOptionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_uploadoptions_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('indexd_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
