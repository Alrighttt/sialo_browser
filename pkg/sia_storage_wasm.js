/* @ts-self-types="./sia_storage_wasm.d.ts" */

/**
 * An application key used for authentication with the indexer.
 *
 * AppKeys are derived from a BIP-39 recovery phrase during registration.
 * They can be exported as a 32-byte seed and re-imported for future
 * connections. The key must be stored securely — anyone with access
 * can authenticate as the user.
 */
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
     * Exports the AppKey as a 32-byte seed (Uint8Array).
     * @returns {Uint8Array}
     */
    export() {
        const ret = wasm.appkey_export(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Imports an AppKey from a 32-byte seed (Uint8Array).
     * @param {Uint8Array} seed
     */
    constructor(seed) {
        const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
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
     * Returns the ed25519 public key as a string (e.g. "ed25519:abc123...").
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
     * Signs a message and returns the 64-byte ed25519 signature (Uint8Array).
     * @param {Uint8Array} message
     * @returns {Uint8Array}
     */
    sign(message) {
        const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.appkey_sign(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Verifies a signature for a given message.
     * Returns true if the signature is valid.
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

/**
 * SDK Builder — handles the connection and registration flow with an indexer.
 */
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
     * Attempts to connect using an existing AppKey.
     * Returns a Sdk if the key is valid, or undefined if not registered.
     * @param {AppKey} app_key
     * @returns {Promise<Sdk | undefined>}
     */
    connected(app_key) {
        _assertClass(app_key, AppKey);
        const ret = wasm.builder_connected(this.__wbg_ptr, app_key.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} indexer_url
     * @param {AppMetadata} app
     */
    constructor(indexer_url, app) {
        const ptr0 = passStringToWasm0(indexer_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_new(ptr0, len0, app);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        BuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Completes registration and returns a Sdk instance.
     * @param {string} mnemonic
     * @returns {Promise<Sdk>}
     */
    register(mnemonic) {
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_register(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Requests connection approval from the indexer.
     * @returns {Promise<void>}
     */
    requestConnection() {
        const ret = wasm.builder_requestConnection(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the approval URL the user must visit.
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
     * Waits for the user to approve the connection request.
     * @returns {Promise<void>}
     */
    waitForApproval() {
        const ret = wasm.builder_waitForApproval(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Builder.prototype[Symbol.dispose] = Builder.prototype.free;

export class IntoUnderlyingByteSource {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(IntoUnderlyingByteSource.prototype);
        obj.__wbg_ptr = ptr;
        IntoUnderlyingByteSourceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * An object event from the indexer.
 */
export class ObjectEvent {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ObjectEvent.prototype);
        obj.__wbg_ptr = ptr;
        ObjectEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ObjectEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_objectevent_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get deleted() {
        const ret = wasm.objectevent_deleted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.objectevent_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the object associated with this event, if it exists.
     * @returns {PinnedObject | undefined}
     */
    get object() {
        const ret = wasm.objectevent_object(this.__wbg_ptr);
        return ret === 0 ? undefined : PinnedObject.__wrap(ret);
    }
    /**
     * Returns the time the event occurred.
     * @returns {Date}
     */
    get updatedAt() {
        const ret = wasm.objectevent_updatedAt(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) ObjectEvent.prototype[Symbol.dispose] = ObjectEvent.prototype.free;

/**
 * A packed upload handle for efficiently uploading multiple objects
 * together. Objects are packed into shared slabs to avoid wasting storage.
 *
 * ```js
 * const packed = sdk.uploadPacked();
 * await packed.add(file1.stream());
 * await packed.add(file2.stream());
 * const objects = await packed.finalize();
 * for (const obj of objects) await sdk.pinObject(obj);
 * ```
 */
export class PackedUpload {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PackedUpload.prototype);
        obj.__wbg_ptr = ptr;
        PackedUploadFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PackedUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packedupload_free(ptr, 0);
    }
    /**
     * Adds an object to the packed upload. Returns the number of bytes written.
     *
     * ```js
     * const packed = sdk.uploadPacked();
     * await packed.add(file.stream());
     * await packed.add(blob.stream());
     * ```
     * @param {ReadableStream} stream
     * @returns {Promise<number>}
     */
    add(stream) {
        const ret = wasm.packedupload_add(this.__wbg_ptr, stream);
        return ret;
    }
    /**
     * Cancels the packed upload. Immediately interrupts any in-flight `add`
     * and aborts all pending slab uploads.
     */
    cancel() {
        wasm.packedupload_cancel(this.__wbg_ptr);
    }
    /**
     * Finalizes the packed upload and returns the resulting objects.
     * Each object must be pinned separately with `sdk.pinObject()`.
     * @returns {Promise<PinnedObject[]>}
     */
    finalize() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.packedupload_finalize(ptr);
        return ret;
    }
    /**
     * Total bytes added so far across all objects.
     * @returns {number}
     */
    length() {
        const ret = wasm.packedupload_length(this.__wbg_ptr);
        return ret;
    }
    /**
     * Bytes remaining until the current slab is full. Adding objects that
     * fit within this size avoids starting a new slab and minimizes padding.
     * @returns {number}
     */
    remaining() {
        const ret = wasm.packedupload_remaining(this.__wbg_ptr);
        return ret;
    }
    /**
     * Optimal size of each slab in bytes.
     * @returns {number}
     */
    slabSize() {
        const ret = wasm.packedupload_slabSize(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of slabs in the upload.
     * @returns {number}
     */
    slabs() {
        const ret = wasm.packedupload_slabs(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) PackedUpload.prototype[Symbol.dispose] = PackedUpload.prototype.free;

/**
 * An object stored on the Sia network. JS holds this as an opaque handle
 * and passes it back to Rust for operations like pin, download, share, and
 * metadata updates. The internal state (encryption keys, slab data) cannot
 * be serialized to JS.
 */
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
     * Returns the creation time.
     * @returns {Date}
     */
    createdAt() {
        const ret = wasm.pinnedobject_createdAt(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the encoded (on-network) size after erasure coding.
     * @returns {number}
     */
    encodedSize() {
        const ret = wasm.pinnedobject_encodedSize(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the object's ID as a hex string.
     * @returns {string}
     */
    id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.pinnedobject_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the object's metadata as raw bytes.
     * @returns {Uint8Array}
     */
    metadata() {
        const ret = wasm.pinnedobject_metadata(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Creates a new empty object.
     */
    constructor() {
        const ret = wasm.pinnedobject_new();
        this.__wbg_ptr = ret >>> 0;
        PinnedObjectFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Opens a previously sealed object.
     * @param {AppKey} app_key
     * @param {SealedObject} sealed_obj
     * @returns {PinnedObject}
     */
    static open(app_key, sealed_obj) {
        _assertClass(app_key, AppKey);
        const ret = wasm.pinnedobject_open(app_key.__wbg_ptr, sealed_obj);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PinnedObject.__wrap(ret[0]);
    }
    /**
     * Seals the object for offline storage.
     * @param {AppKey} app_key
     * @returns {SealedObject}
     */
    seal(app_key) {
        _assertClass(app_key, AppKey);
        const ret = wasm.pinnedobject_seal(this.__wbg_ptr, app_key.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the total size of the object in bytes.
     * @returns {number}
     */
    size() {
        const ret = wasm.pinnedobject_size(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the slabs that make up the object.
     * @returns {Slab[]}
     */
    slabs() {
        const ret = wasm.pinnedobject_slabs(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Updates the object's metadata.
     * @param {Uint8Array} metadata
     */
    updateMetadata(metadata) {
        const ptr0 = passArray8ToWasm0(metadata, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.pinnedobject_updateMetadata(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Returns the last updated time.
     * @returns {Date}
     */
    updatedAt() {
        const ret = wasm.pinnedobject_updatedAt(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) PinnedObject.prototype[Symbol.dispose] = PinnedObject.prototype.free;

/**
 * The main Sia storage SDK. Provides methods for uploading, downloading,
 * and managing objects on the Sia storage network via an indexer.
 */
export class Sdk {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Sdk.prototype);
        obj.__wbg_ptr = ptr;
        SdkFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SdkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sdk_free(ptr, 0);
    }
    /**
     * Returns account information from the indexer.
     * @returns {Account}
     */
    account() {
        const ret = wasm.sdk_account(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the AppKey used by this SDK instance.
     * @returns {AppKey}
     */
    appKey() {
        const ret = wasm.sdk_appKey(this.__wbg_ptr);
        return AppKey.__wrap(ret);
    }
    /**
     * Deletes an object from the indexer by its hex ID.
     * @param {string} key_hex
     * @returns {Promise<void>}
     */
    deleteObject(key_hex) {
        const ptr0 = passStringToWasm0(key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_deleteObject(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Downloads an object and returns a `ReadableStream` of `Uint8Array` chunks.
     *
     * ```js
     * // as a blob
     * const stream = sdk.download(obj);
     * const blob = await new Response(stream).blob();
     *
     * // as a stream
     * for await (const chunk of sdk.download(obj)) {
     *   console.log('got', chunk.length, 'bytes');
     * }
     * ```
     * @param {PinnedObject} object
     * @param {any | null} [options]
     * @returns {ReadableStream}
     */
    download(object, options) {
        _assertClass(object, PinnedObject);
        const ret = wasm.sdk_download(this.__wbg_ptr, object.__wbg_ptr, isLikeNone(options) ? 0 : addToExternrefTable0(options));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a list of usable hosts, optionally filtered by a HostQuery.
     * @param {HostQuery | null} [query]
     * @returns {Host[]}
     */
    hosts(query) {
        const ret = wasm.sdk_hosts(this.__wbg_ptr, isLikeNone(query) ? 0 : addToExternrefTable0(query));
        return ret;
    }
    /**
     * Retrieves an object from the indexer by its hex ID.
     * Returns a `PinnedObject` handle for use with download, share, seal, etc.
     * @param {string} key_hex
     * @returns {Promise<PinnedObject>}
     */
    object(key_hex) {
        const ptr0 = passStringToWasm0(key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_object(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Returns object events for syncing local state with the indexer.
     * @param {ObjectsCursor | null | undefined} cursor
     * @param {number} limit
     * @returns {Promise<ObjectEvent[]>}
     */
    objectEvents(cursor, limit) {
        const ret = wasm.sdk_objectEvents(this.__wbg_ptr, cursor, limit);
        return ret;
    }
    /**
     * Pins an object to the indexer so it persists beyond temporary storage.
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
     * Generates a signed share URL for an object. Anyone with the URL can
     * download and decrypt the object until `validUntil`.
     * @param {PinnedObject} object
     * @param {Date} valid_until
     * @returns {string}
     */
    shareObject(object, valid_until) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(object, PinnedObject);
            const ret = wasm.sdk_shareObject(this.__wbg_ptr, object.__wbg_ptr, valid_until);
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
     * Resolves a share URL (sia://...) and returns the shared object.
     * The encryption key is extracted from the URL fragment (never sent
     * to the indexer).
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
     * Retrieves a pinned slab from the indexer by its hex ID.
     * @param {string} slab_id
     * @returns {PinnedSlab}
     */
    slab(slab_id) {
        const ptr0 = passStringToWasm0(slab_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sdk_slab(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Updates an object's metadata on the indexer.
     * @param {PinnedObject} object
     * @returns {Promise<void>}
     */
    updateObjectMetadata(object) {
        _assertClass(object, PinnedObject);
        const ret = wasm.sdk_updateObjectMetadata(this.__wbg_ptr, object.__wbg_ptr);
        return ret;
    }
    /**
     * Uploads data from a `ReadableStream` to the Sia network.
     *
     * Pass an existing `PinnedObject` to append new slabs to it, or `null`
     * for a new upload. Appending changes the object's ID — the caller must
     * re-pin and update any references to the old ID.
     *
     * ```js
     * const obj = await sdk.upload(new PinnedObject(), file.stream());
     * await sdk.pinObject(obj);
     * ```
     * @param {PinnedObject} object
     * @param {ReadableStream} source
     * @param {any | null} [options]
     * @returns {Promise<PinnedObject>}
     */
    upload(object, source, options) {
        _assertClass(object, PinnedObject);
        var ptr0 = object.__destroy_into_raw();
        const ret = wasm.sdk_upload(this.__wbg_ptr, ptr0, source, isLikeNone(options) ? 0 : addToExternrefTable0(options));
        return ret;
    }
    /**
     * Starts a packed upload for efficiently uploading multiple small objects.
     * Objects smaller than the slab size (~40 MiB) are packed into shared slabs
     * to avoid wasting storage. Call `add(data)` for each object, then
     * `finalize()` to get the resulting `PinnedObject` handles.
     * @param {any | null} [options]
     * @returns {PackedUpload}
     */
    uploadPacked(options) {
        const ret = wasm.sdk_uploadPacked(this.__wbg_ptr, isLikeNone(options) ? 0 : addToExternrefTable0(options));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PackedUpload.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Sdk.prototype[Symbol.dispose] = Sdk.prototype.free;

/**
 * Calculates the encoded size of data after erasure coding.
 * @param {number} data_size
 * @param {number} data_shards
 * @param {number} parity_shards
 * @returns {number}
 */
export function encodedSize(data_size, data_shards, parity_shards) {
    const ret = wasm.encodedSize(data_size, data_shards, parity_shards);
    return ret;
}

/**
 * Generates a new BIP-39 12-word recovery phrase.
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
 * Set up panic hook and tokio runtime for browser use.
 *
 * Call `setLogger` to receive log messages.
 */
export function init() {
    wasm.init();
}

/**
 * Sets a logging callback to receive log messages from the SDK.
 *
 * The callback receives formatted log messages as strings.
 * `level` should be one of: "off", "error", "warn", "info", "debug", "trace".
 * @param {(message: string) => void} callback
 * @param {"off" | "error" | "warn" | "info" | "debug" | "trace"} level
 */
export function setLogger(callback, level) {
    wasm.setLogger(callback, level);
}

/**
 * Validates a BIP-39 recovery phrase.
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
        __wbg_Error_960c155d3d49e4c2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_32bf70a599af1d4b: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_String_b51de6b05a10845b: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_3d3aba5d616c6a51: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_6ea149f0a8dcc5ff: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_ab4b34d23d6778bd: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_a5d8b22e52b24dd1: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_ec25c7f91b4d9e93: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_3baa9db1a987f47d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_52ff4ec04186736f: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_63322ec0cd6ea4ef: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_6df3bf7ef1164ed3: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_29a43b4d42920abd: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_d3465d8a07697228: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_cac3565e89b4134c: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_c7f42aed0525c451: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_7ed5322991caaec5: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_b46c9b5a9f08ec37: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_4ce5b484434ef6fd: function(arg0) {
            arg0.abort();
        },
        __wbg_abort_d53712380a54cc81: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_append_e8fc56ce7c00e874: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_848c392b70c67d3d: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_buffer_d0f5ea0926a691fd: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byobRequest_dc6aed9db01b12c6: function(arg0) {
            const ret = arg0.byobRequest;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_byteLength_3e660e5661f3327e: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteOffset_ecd62abe44dd28d4: function(arg0) {
            const ret = arg0.byteOffset;
            return ret;
        },
        __wbg_call_14b169f759b26747: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a24592a6f349a97e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_bb28efe6b2f55b86: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_cancel_0fefd9f8b9d572b7: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_cancel_ceb1bda02e29f0a9: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_catch_e9362815fd0b24cf: function(arg0, arg1) {
            const ret = arg0.catch(arg1);
            return ret;
        },
        __wbg_clearTimeout_6b8d9a38b9263d65: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_close_d67fbcab21f3394e: function(arg0) {
            arg0.close();
        },
        __wbg_close_e6c8977a002e9e13: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_fb954dfaf67b5732: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_closed_07518cb4fba01f29: function(arg0) {
            const ret = arg0.closed;
            return ret;
        },
        __wbg_createBidirectionalStream_ca9f0bbcf625e093: function(arg0) {
            const ret = arg0.createBidirectionalStream();
            return ret;
        },
        __wbg_crypto_48300657fced39f9: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_done_58115a35ffd6a698: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_done_9158f7cc8751ba32: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_enqueue_4767ce322820c94d: function() { return handleError(function (arg0, arg1) {
            arg0.enqueue(arg1);
        }, arguments); },
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
        __wbg_fetch_0d322c0aed196b8b: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_9dad4fe911207b37: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_263d0aa5464054ee: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getReader_811d24fccad83740: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getReader(arg1);
            return ret;
        }, arguments); },
        __wbg_getReader_9094ac3b37a7d171: function(arg0) {
            const ret = arg0.getReader();
            return ret;
        },
        __wbg_getReader_9facd4f899beac89: function() { return handleError(function (arg0) {
            const ret = arg0.getReader();
            return ret;
        }, arguments); },
        __wbg_getTime_da7c55f52b71e8c6: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_getWriter_288dd368894e012f: function() { return handleError(function (arg0) {
            const ret = arg0.getWriter();
            return ret;
        }, arguments); },
        __wbg_get_1affdbdd5573b16a: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6011fa3a58f61074: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_done_282bca5d3f90e0a8: function(arg0) {
            const ret = arg0.done;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg_get_unchecked_17f53dad852b9588: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_value_65a7a2c60b42fd75: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_get_with_ref_key_f64427178466f623: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_has_880f1d472f7cecba: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_6022deb4e576fb8e: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_7c8433c6ed14ffe3: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Date_81b75f5ed36b30ea: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Date;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Error_6872d63ba7922898: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Error;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_9b2d111407865ff2: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_152ba1f289edcf3f: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_c3109d14ffc06469: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_4fc213d1989d6d2a: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_013bc09ec998c2a7: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_3d4ecd04bd8d22f1: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_9f1775224cf1d815: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_cb4f84ee66e5e341: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_msCrypto_8c6d45a75ef1d3da: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_036bd6cd9cea9e73: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h6bd91625313626ea(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_0_4d657201ced14de3: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_0c7403db6e782f19: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_15a4889b4b90734d: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_5e360d2ff7b9e1c3: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_682678e2f47e32bc: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_7913666fe5070684: function(arg0) {
            const ret = new Date(arg0);
            return ret;
        },
        __wbg_new_98c22165a42231aa: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_aa8d0fa9762c29bd: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_b5ea43e23f6008c0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_323f37fd55ab048d: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h6bd91625313626ea(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_byte_offset_and_length_01848e8d6a3d49ad: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_into_underlying_byte_source_3d91ced279a72a85: function() { return handleError(function (arg0) {
            const ret = new ReadableStream(IntoUnderlyingByteSource.__wrap(arg0));
            return ret;
        }, arguments); },
        __wbg_new_with_length_8c854e41ea4dae9b: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_options_50d51c89a750cdc0: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new WebTransport(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_and_init_897be1708e42f39d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_0340c4ae324393c3: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_next_7646edaa39458ef7: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_node_95beb7570492fd97: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_36a3148ac47c4ad7: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_objectevent_new: function(arg0) {
            const ret = ObjectEvent.__wrap(arg0);
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_pinnedobject_new: function(arg0) {
            const ret = PinnedObject.__wrap(arg0);
            return ret;
        },
        __wbg_process_b2fea42461d03994: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_a6b02eb00b0f4ce2: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_queueMicrotask_5d15a957e6aa920e: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_queueMicrotask_f8819e5ffc402f36: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_randomFillSync_ca9f178fb14c88cb: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_read_59292bbb2477ba34: function(arg0, arg1) {
            const ret = arg0.read(arg1);
            return ret;
        },
        __wbg_read_ddc2d178d2e57272: function(arg0) {
            const ret = arg0.read();
            return ret;
        },
        __wbg_readable_98f8ed088fcd6057: function(arg0) {
            const ret = arg0.readable;
            return ret;
        },
        __wbg_ready_487eb6c03d6e0cb3: function(arg0) {
            const ret = arg0.ready;
            return ret;
        },
        __wbg_releaseLock_38a8537ebe7067e2: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_releaseLock_9baaf3ccc5cfad69: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_require_7a9419e39d796c95: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_e6c466bc1052f16c: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_respond_008ca9525ae22847: function() { return handleError(function (arg0, arg1) {
            arg0.respond(arg1 >>> 0);
        }, arguments); },
        __wbg_sdk_new: function(arg0) {
            const ret = Sdk.__wrap(arg0);
            return ret;
        },
        __wbg_setTimeout_f757f00851f76c42: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_3bf1de9fab0cd644: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_3d484eb794afec82: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_body_be11680f34217f75: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_968edea422613d1b: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_6577be90e0e85eb6: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_f071dbb3bd088e0e: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_headers_50fc01786240a440: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_c9f1f985f6b6c427: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_5e08d503428c06b9: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_mode_8727fb062fc15677: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_ReadableStreamReaderMode[arg1];
        },
        __wbg_set_signal_1d4e73c2305a0e7c: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_fdc54643b47bf85b: function(arg0) {
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
        __wbg_static_accessor_GLOBAL_8cfadc87a297ca02: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_602256ae5c8f42cf: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_e445c1c7484aecc3: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f20e8576ef1e0f17: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_43e0d2f15b22d69f: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_stringify_91082ed7a5a5769e: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_subarray_f8ca46a25b1f5e0d: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_text_595ef75535aa25c1: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_792e0c862b060889: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_8e16ee11f05e4827: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_toString_306ed0b9f320c1ca: function(arg0) {
            const ret = arg0.toString();
            return ret;
        },
        __wbg_url_2bf741820e6563a0: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_b6a01ce6fe7cf2d7: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_value_ee3a06f4579184fa: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_215a3ab1c9d5745a: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbg_view_701664ffb3b1ce67: function(arg0) {
            const ret = arg0.view;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_writable_d91c90e654ba5e7a: function(arg0) {
            const ret = arg0.writable;
            return ret;
        },
        __wbg_write_5cde8c29c0e594f9: function(arg0, arg1) {
            const ret = arg0.write(arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1120, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h6e16a16a730f244e);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 451, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h3ed55e440439b2de);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 873, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("WebTransportBidirectionalStream")], shim_idx: 873, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_3);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("undefined")], shim_idx: 873, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_4);
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 908, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hb6419d1b46f84434);
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000a: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_cast_000000000000000b: function(arg0, arg1) {
            var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 4, 4);
            // Cast intrinsic for `Vector(NamedExternref("ObjectEvent")) -> Externref`.
            const ret = v0;
            return ret;
        },
        __wbindgen_cast_000000000000000c: function(arg0, arg1) {
            var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 4, 4);
            // Cast intrinsic for `Vector(NamedExternref("PinnedObject")) -> Externref`.
            const ret = v0;
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
        "./sia_storage_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__hb6419d1b46f84434(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hb6419d1b46f84434(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h3ed55e440439b2de(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h3ed55e440439b2de(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h6e16a16a730f244e(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h6e16a16a730f244e(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_3(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_3(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_4(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h310b3e79f86d2c14_4(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h6bd91625313626ea(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h6bd91625313626ea(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_ReadableStreamReaderMode = ["byob"];


const __wbindgen_enum_ReadableStreamType = ["bytes"];


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const AppKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_appkey_free(ptr >>> 0, 1));
const BuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_builder_free(ptr >>> 0, 1));
const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr >>> 0, 1));
const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr >>> 0, 1));
const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr >>> 0, 1));
const ObjectEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_objectevent_free(ptr >>> 0, 1));
const PackedUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packedupload_free(ptr >>> 0, 1));
const PinnedObjectFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pinnedobject_free(ptr >>> 0, 1));
const SdkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sdk_free(ptr >>> 0, 1));

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
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

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

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
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

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
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
            wasm.__wbindgen_destroy_closure(state.a, state.b);
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
        module_or_path = new URL('sia_storage_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
