/* @ts-self-types="./rts_physics_wasm.d.ts" */

export class PhysicsEngine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PhysicsEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_physicsengine_free(ptr, 0);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} radius
     * @param {number} mass
     * @param {number} friction_air
     * @param {number} restitution
     * @returns {number}
     */
    add_dynamic_body(x, y, radius, mass, friction_air, restitution) {
        const ret = wasm.physicsengine_add_dynamic_body(this.__wbg_ptr, x, y, radius, mass, friction_air, restitution);
        return ret >>> 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} half_w
     * @param {number} half_h
     * @param {number} restitution
     * @returns {number}
     */
    add_static_body(x, y, half_w, half_h, restitution) {
        const ret = wasm.physicsengine_add_static_body(this.__wbg_ptr, x, y, half_w, half_h, restitution);
        return ret >>> 0;
    }
    /**
     * @param {number} slot
     * @param {number} fx
     * @param {number} fy
     */
    apply_force(slot, fx, fy) {
        wasm.physicsengine_apply_force(this.__wbg_ptr, slot, fx, fy);
    }
    /**
     * @returns {number}
     */
    dynamic_count() {
        const ret = wasm.physicsengine_dynamic_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    dynamic_vx_ptr() {
        const ret = wasm.physicsengine_dynamic_vx_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    dynamic_vy_ptr() {
        const ret = wasm.physicsengine_dynamic_vy_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    dynamic_x_ptr() {
        const ret = wasm.physicsengine_dynamic_x_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    dynamic_y_ptr() {
        const ret = wasm.physicsengine_dynamic_y_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} slot
     * @returns {number}
     */
    get_mass(slot) {
        const ret = wasm.physicsengine_get_mass(this.__wbg_ptr, slot);
        return ret;
    }
    /**
     * @param {number} slot
     * @returns {number}
     */
    get_vx(slot) {
        const ret = wasm.physicsengine_get_vx(this.__wbg_ptr, slot);
        return ret;
    }
    /**
     * @param {number} slot
     * @returns {number}
     */
    get_vy(slot) {
        const ret = wasm.physicsengine_get_vy(this.__wbg_ptr, slot);
        return ret;
    }
    /**
     * @param {number} slot
     * @returns {number}
     */
    get_x(slot) {
        const ret = wasm.physicsengine_get_x(this.__wbg_ptr, slot);
        return ret;
    }
    /**
     * @param {number} slot
     * @returns {number}
     */
    get_y(slot) {
        const ret = wasm.physicsengine_get_y(this.__wbg_ptr, slot);
        return ret;
    }
    /**
     * @param {number} map_width
     * @param {number} map_height
     */
    constructor(map_width, map_height) {
        const ret = wasm.physicsengine_new(map_width, map_height);
        this.__wbg_ptr = ret >>> 0;
        PhysicsEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} slot
     */
    remove_dynamic_body(slot) {
        wasm.physicsengine_remove_dynamic_body(this.__wbg_ptr, slot);
    }
    /**
     * @param {number} slot
     */
    remove_static_body(slot) {
        wasm.physicsengine_remove_static_body(this.__wbg_ptr, slot);
    }
    /**
     * @param {number} dt_sec
     */
    step(dt_sec) {
        wasm.physicsengine_step(this.__wbg_ptr, dt_sec);
    }
}
if (Symbol.dispose) PhysicsEngine.prototype[Symbol.dispose] = PhysicsEngine.prototype.free;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
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
        "./rts_physics_wasm_bg.js": import0,
    };
}

const PhysicsEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_physicsengine_free(ptr >>> 0, 1));

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

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
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
        module_or_path = new URL('rts_physics_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
