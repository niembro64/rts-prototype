/* tslint:disable */
/* eslint-disable */

export class PhysicsEngine {
    free(): void;
    [Symbol.dispose](): void;
    add_dynamic_body(x: number, y: number, radius: number, mass: number, friction_air: number, restitution: number): number;
    add_static_body(x: number, y: number, half_w: number, half_h: number, restitution: number): number;
    apply_force(slot: number, fx: number, fy: number): void;
    dynamic_count(): number;
    dynamic_vx_ptr(): number;
    dynamic_vy_ptr(): number;
    dynamic_x_ptr(): number;
    dynamic_y_ptr(): number;
    get_mass(slot: number): number;
    get_vx(slot: number): number;
    get_vy(slot: number): number;
    get_x(slot: number): number;
    get_y(slot: number): number;
    constructor(map_width: number, map_height: number);
    remove_dynamic_body(slot: number): void;
    remove_static_body(slot: number): void;
    step(dt_sec: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_physicsengine_free: (a: number, b: number) => void;
    readonly physicsengine_add_dynamic_body: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly physicsengine_add_static_body: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly physicsengine_apply_force: (a: number, b: number, c: number, d: number) => void;
    readonly physicsengine_dynamic_count: (a: number) => number;
    readonly physicsengine_dynamic_vx_ptr: (a: number) => number;
    readonly physicsengine_dynamic_vy_ptr: (a: number) => number;
    readonly physicsengine_dynamic_x_ptr: (a: number) => number;
    readonly physicsengine_dynamic_y_ptr: (a: number) => number;
    readonly physicsengine_get_mass: (a: number, b: number) => number;
    readonly physicsengine_get_vx: (a: number, b: number) => number;
    readonly physicsengine_get_vy: (a: number, b: number) => number;
    readonly physicsengine_get_x: (a: number, b: number) => number;
    readonly physicsengine_get_y: (a: number, b: number) => number;
    readonly physicsengine_new: (a: number, b: number) => number;
    readonly physicsengine_remove_dynamic_body: (a: number, b: number) => void;
    readonly physicsengine_remove_static_body: (a: number, b: number) => void;
    readonly physicsengine_step: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
