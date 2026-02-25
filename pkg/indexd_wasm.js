const __wbg_star0 = { now: () => Date.now() };

let wasm;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
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

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
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

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

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

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

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

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}
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
 * Install a panic hook and logging bridge so that Rust panics show a proper
 * stack trace and `log::debug!()` / `log::info!()` etc. appear in the browser
 * console.
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}

function wasm_bindgen__convert__closures_____invoke__hc18176fb1b5492d3(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__hc18176fb1b5492d3(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hdb2db1d6e822a6e9(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hdb2db1d6e822a6e9(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h0015dda4019b602e(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h0015dda4019b602e(arg0, arg1, arg2, arg3);
}

const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];

const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];

const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];

const AppKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_appkey_free(ptr >>> 0, 1));

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
     * Exports the full 64-byte ed25519 keypair.
     * @returns {Uint8Array}
     */
    export() {
        const ret = wasm.appkey_export(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) AppKey.prototype[Symbol.dispose] = AppKey.prototype.free;

const BuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_builder_free(ptr >>> 0, 1));

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
     * Polls for approval. Resolves when the user approves.
     * @returns {Promise<void>}
     */
    waitForApproval() {
        const ret = wasm.builder_waitForApproval(this.__wbg_ptr);
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
}
if (Symbol.dispose) Builder.prototype[Symbol.dispose] = Builder.prototype.free;

const DownloadOptionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_downloadoptions_free(ptr >>> 0, 1));
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
    constructor() {
        const ret = wasm.downloadoptions_new();
        this.__wbg_ptr = ret >>> 0;
        DownloadOptionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {DownloadOptions}
     */
    clone() {
        const ret = wasm.downloadoptions_clone(this.__wbg_ptr);
        return DownloadOptions.__wrap(ret);
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

const PinnedObjectFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pinnedobject_free(ptr >>> 0, 1));

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
}
if (Symbol.dispose) PinnedObject.prototype[Symbol.dispose] = PinnedObject.prototype.free;

const SDKFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sdk_free(ptr >>> 0, 1));

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
     * Retrieves a shared object from a signed share URL.
     * Accepts both `https://` and `sia://` schemes.
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
     * Generates a random 32-byte encryption key for object-level encryption.
     * Used by parallel upload workers that share a single data key.
     * @returns {Uint8Array}
     */
    generateDataKey() {
        const ret = wasm.sdk_generateDataKey(this.__wbg_ptr);
        return ret;
    }
    /**
     * Downloads an object with streaming chunks.
     * Fires `on_chunk(bytes)` after each slab is decoded and `on_progress(current, total)` for progress.
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
     * Downloads a single slab by index, returning its decrypted data as a Uint8Array.
     *
     * Used by slab download workers to enable parallel slab downloads across
     * multiple Web Workers, each with their own SDK instance and thread.
     * @param {PinnedObject} object
     * @param {number} slab_index
     * @param {DownloadOptions} options
     * @returns {Promise<Uint8Array>}
     */
    downloadSlabByIndex(object, slab_index, options) {
        _assertClass(object, PinnedObject);
        _assertClass(options, DownloadOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.sdk_downloadSlabByIndex(this.__wbg_ptr, object.__wbg_ptr, slab_index, ptr0);
        return ret;
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
     * Returns hosts as a JSON array.
     * @returns {Promise<any>}
     */
    hosts() {
        const ret = wasm.sdk_hosts(this.__wbg_ptr);
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
}
if (Symbol.dispose) SDK.prototype[Symbol.dispose] = SDK.prototype.free;

const StreamingUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_streamingupload_free(ptr >>> 0, 1));
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
    /**
     * Returns the promise that resolves when the upload completes
     * @returns {Promise<any>}
     */
    get promise() {
        const ret = wasm.streamingupload_promise(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) StreamingUpload.prototype[Symbol.dispose] = StreamingUpload.prototype.free;

const UploadOptionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_uploadoptions_free(ptr >>> 0, 1));
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
    constructor() {
        const ret = wasm.uploadoptions_new();
        this.__wbg_ptr = ret >>> 0;
        UploadOptionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {UploadOptions}
     */
    clone() {
        const ret = wasm.uploadoptions_clone(this.__wbg_ptr);
        return UploadOptions.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get dataShards() {
        const ret = wasm.__wbg_get_uploadoptions_dataShards(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set dataShards(arg0) {
        wasm.__wbg_set_uploadoptions_dataShards(this.__wbg_ptr, arg0);
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
    set parityShards(arg0) {
        wasm.__wbg_set_uploadoptions_parityShards(this.__wbg_ptr, arg0);
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
if (Symbol.dispose) UploadOptions.prototype[Symbol.dispose] = UploadOptions.prototype.free;

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
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
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_e83987f665cf5504 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
        const ret = String(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_boolean_get_6d5a1ee65bab5f68 = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? v : undefined;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg___wbindgen_debug_string_df47ffb5e35e6763 = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_is_function_ee8a6c5833c90377 = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_object_c818261d21f283a4 = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_string_fbb76cb2940daafd = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_2d472862bd29a478 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_string_get_e4f06c90489ad01b = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_b855445ff6a94295 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg__wbg_cb_unref_2454a539ea5790d9 = function(arg0) {
        arg0._wbg_cb_unref();
    };
    imports.wbg.__wbg_abort_28ad55c5825b004d = function(arg0, arg1) {
        arg0.abort(arg1);
    };
    imports.wbg.__wbg_abort_e7eb059f72f9ed0c = function(arg0) {
        arg0.abort();
    };
    imports.wbg.__wbg_append_b577eb3a177bc0fa = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments) };
    imports.wbg.__wbg_arrayBuffer_b375eccb84b4ddf3 = function() { return handleError(function (arg0) {
        const ret = arg0.arrayBuffer();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_525440f72fbfc0ea = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_e45d2cf9fc925fcf = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        const ret = arg0.call(arg1, arg2, arg3);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_e762c39fa8ea36bf = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_clearTimeout_42d9ccd50822fd3a = function(arg0) {
        const ret = clearTimeout(arg0);
        return ret;
    };
    imports.wbg.__wbg_close_802fb4e36c4945ce = function(arg0) {
        arg0.close();
    };
    imports.wbg.__wbg_createBidirectionalStream_b78a5e42d918e4d2 = function(arg0) {
        const ret = arg0.createBidirectionalStream();
        return ret;
    };
    imports.wbg.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
        const ret = arg0.crypto;
        return ret;
    };
    imports.wbg.__wbg_debug_f4b0c59db649db48 = function(arg0) {
        console.debug(arg0);
    };
    imports.wbg.__wbg_done_2042aa2670fb1db1 = function(arg0) {
        const ret = arg0.done;
        return ret;
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_error_a7f8fbb0523dae15 = function(arg0) {
        console.error(arg0);
    };
    imports.wbg.__wbg_fetch_6bbc32f991730587 = function(arg0) {
        const ret = fetch(arg0);
        return ret;
    };
    imports.wbg.__wbg_fetch_f8ba0e29a9d6de0d = function(arg0, arg1) {
        const ret = arg0.fetch(arg1);
        return ret;
    };
    imports.wbg.__wbg_getRandomValues_2a91986308c74a93 = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
    }, arguments) };
    imports.wbg.__wbg_getReader_15e2d3098e32c359 = function(arg0) {
        const ret = arg0.getReader();
        return ret;
    };
    imports.wbg.__wbg_getTime_14776bfb48a1bff9 = function(arg0) {
        const ret = arg0.getTime();
        return ret;
    };
    imports.wbg.__wbg_getWriter_c891ce50cc187493 = function() { return handleError(function (arg0) {
        const ret = arg0.getWriter();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_get_efcb449f58ec27c2 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_has_787fafc980c3ccdb = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.has(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_headers_b87d7eaba61c3278 = function(arg0) {
        const ret = arg0.headers;
        return ret;
    };
    imports.wbg.__wbg_info_e674a11f4f50cc0c = function(arg0) {
        console.info(arg0);
    };
    imports.wbg.__wbg_instanceof_ReadableStreamDefaultReader_33a4601dd218c69d = function(arg0) {
        let result;
        try {
            result = arg0 instanceof ReadableStreamDefaultReader;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Response_f4f3e87e07f3135c = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Response;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_iterator_e5822695327a3c39 = function() {
        const ret = Symbol.iterator;
        return ret;
    };
    imports.wbg.__wbg_length_69bca3cb64fc8748 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_log_8cec76766b8c0e33 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
        const ret = arg0.msCrypto;
        return ret;
    };
    imports.wbg.__wbg_new_0_f9740686d739025c = function() {
        const ret = new Date();
        return ret;
    };
    imports.wbg.__wbg_new_1acc0b6eea89d040 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_2531773dac38ebb3 = function() { return handleError(function () {
        const ret = new AbortController();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_3c3d849046688a66 = function(arg0, arg1) {
        try {
            var state0 = {a: arg0, b: arg1};
            var cb0 = (arg0, arg1) => {
                const a = state0.a;
                state0.a = 0;
                try {
                    return wasm_bindgen__convert__closures_____invoke__h0015dda4019b602e(a, state0.b, arg0, arg1);
                } finally {
                    state0.a = a;
                }
            };
            const ret = new Promise(cb0);
            return ret;
        } finally {
            state0.a = state0.b = 0;
        }
    };
    imports.wbg.__wbg_new_5a79be3ab53b8aa5 = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_68651c719dcda04e = function() {
        const ret = new Map();
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_9edf9838a2def39c = function() { return handleError(function () {
        const ret = new Headers();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_e17d9f43105b08be = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_from_slice_92f4d78ca282a2d2 = function(arg0, arg1) {
        const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_no_args_ee98eee5275000a4 = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_with_length_01aa0dc35aa13543 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_new_with_options_9965f8e85fa9c22f = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new WebTransport(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_with_str_and_init_0ae7728b6ec367b1 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_next_020810e0ae8ebcb0 = function() { return handleError(function (arg0) {
        const ret = arg0.next();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_next_2c826fe5dfec6b6a = function(arg0) {
        const ret = arg0.next;
        return ret;
    };
    imports.wbg.__wbg_node_905d3e251edff8a2 = function(arg0) {
        const ret = arg0.node;
        return ret;
    };
    imports.wbg.__wbg_now_793306c526e2e3b6 = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_pinnedobject_new = function(arg0) {
        const ret = PinnedObject.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
        const ret = arg0.process;
        return ret;
    };
    imports.wbg.__wbg_prototypesetcall_2a6620b6922694b2 = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_push_df81a39d04db858c = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_34d692c25c47d05b = function(arg0) {
        const ret = arg0.queueMicrotask;
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_9d76cacb20c84d58 = function(arg0) {
        queueMicrotask(arg0);
    };
    imports.wbg.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
    }, arguments) };
    imports.wbg.__wbg_read_48f1593df542f968 = function(arg0) {
        const ret = arg0.read();
        return ret;
    };
    imports.wbg.__wbg_readable_2e1f7c2e233ad58e = function(arg0) {
        const ret = arg0.readable;
        return ret;
    };
    imports.wbg.__wbg_ready_310519d62d77aaae = function(arg0) {
        const ret = arg0.ready;
        return ret;
    };
    imports.wbg.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
        const ret = module.require;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_resolve_caf97c30b83f7053 = function(arg0) {
        const ret = Promise.resolve(arg0);
        return ret;
    };
    imports.wbg.__wbg_sdk_new = function(arg0) {
        const ret = SDK.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_setTimeout_4ec014681668a581 = function(arg0, arg1) {
        const ret = setTimeout(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        arg0[arg1] = arg2;
    };
    imports.wbg.__wbg_set_907fb406c34a251d = function(arg0, arg1, arg2) {
        const ret = arg0.set(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_set_body_3c365989753d61f4 = function(arg0, arg1) {
        arg0.body = arg1;
    };
    imports.wbg.__wbg_set_c213c871859d6500 = function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_cache_2f9deb19b92b81e3 = function(arg0, arg1) {
        arg0.cache = __wbindgen_enum_RequestCache[arg1];
    };
    imports.wbg.__wbg_set_credentials_f621cd2d85c0c228 = function(arg0, arg1) {
        arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
    };
    imports.wbg.__wbg_set_headers_6926da238cd32ee4 = function(arg0, arg1) {
        arg0.headers = arg1;
    };
    imports.wbg.__wbg_set_method_c02d8cbbe204ac2d = function(arg0, arg1, arg2) {
        arg0.method = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_set_mode_52ef73cfa79639cb = function(arg0, arg1) {
        arg0.mode = __wbindgen_enum_RequestMode[arg1];
    };
    imports.wbg.__wbg_set_signal_dda2cf7ccb6bee0f = function(arg0, arg1) {
        arg0.signal = arg1;
    };
    imports.wbg.__wbg_signal_4db5aa055bf9eb9a = function(arg0) {
        const ret = arg0.signal;
        return ret;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_89e1d9ac6a1b250e = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_8b530f326a9e48ac = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_6fdf4b64710cc91b = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_b45bfc5a37f6cfa2 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_status_de7eed5a7a5bfd5d = function(arg0) {
        const ret = arg0.status;
        return ret;
    };
    imports.wbg.__wbg_stringify_b5fb28f6465d9c3e = function() { return handleError(function (arg0) {
        const ret = JSON.stringify(arg0);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_subarray_480600f3d6a9f26c = function(arg0, arg1, arg2) {
        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_text_dc33c15c17bdfb52 = function() { return handleError(function (arg0) {
        const ret = arg0.text();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_then_4f46f6544e6b4a28 = function(arg0, arg1) {
        const ret = arg0.then(arg1);
        return ret;
    };
    imports.wbg.__wbg_then_70d05cf780a18d77 = function(arg0, arg1, arg2) {
        const ret = arg0.then(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_url_b36d2a5008eb056f = function(arg0, arg1) {
        const ret = arg1.url;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_value_692627309814bb8c = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_versions_c01dfd4722a88165 = function(arg0) {
        const ret = arg0.versions;
        return ret;
    };
    imports.wbg.__wbg_warn_1d74dddbe2fd1dbb = function(arg0) {
        console.warn(arg0);
    };
    imports.wbg.__wbg_writable_668b29eaca211d21 = function(arg0) {
        const ret = arg0.writable;
        return ret;
    };
    imports.wbg.__wbg_write_5f693b62e780062e = function(arg0, arg1) {
        const ret = arg0.write(arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
        // Cast intrinsic for `U64 -> Externref`.
        const ret = BigInt.asUintN(64, arg0);
        return ret;
    };
    imports.wbg.__wbindgen_cast_4fe050ba73f625b3 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 650, function: Function { arguments: [Externref], shim_idx: 651, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__hfe1550f2fd145211, wasm_bindgen__convert__closures_____invoke__hc18176fb1b5492d3);
        return ret;
    };
    imports.wbg.__wbindgen_cast_6d800d785f61bfcb = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 623, function: Function { arguments: [], shim_idx: 624, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h0378c0ade826c8cf, wasm_bindgen__convert__closures_____invoke__hdb2db1d6e822a6e9);
        return ret;
    };
    imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
        // Cast intrinsic for `I64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
        const ret = getArrayU8FromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports['env'] = __wbg_star0;

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
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


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('indexd_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
