// rts-sim-wasm init — singleton loader.
//
// This module is the ONLY place either the server tick or the
// client prediction stepper should obtain the WASM handle from.
// Both await `initSimWasm()`; concurrent awaiters share one fetch
// + compile via the module-scope Promise cache below.
//
// The WASM artifacts under `./pkg/` are produced by
// `npm run build:wasm` (which calls `wasm-pack build --release
// --target web --out-dir ../src/game/sim-wasm/pkg` from the
// `rts-sim-wasm/` crate at the repo root). They are gitignored —
// `npm run build` runs the wasm build first; `npm run dev`
// reuses whatever pkg/ already contains, so run `build:wasm`
// once after a fresh clone and re-run after any Rust edit.

import __wbg_init, {
  version,
  step_unit_motion,
  step_unit_motions_batch,
} from './pkg/rts_sim_wasm';

/** Layout stride for `stepUnitMotionsBatch`. Each body occupies
 *  STEP_UNIT_MOTIONS_BATCH_STRIDE consecutive f64 slots in the
 *  buffer; see the docstring on `SimWasm.stepUnitMotionsBatch` for
 *  the field map. Mirrors `STEP_UNIT_MOTIONS_BATCH_STRIDE` in
 *  rts-sim-wasm/src/lib.rs. */
export const STEP_UNIT_MOTIONS_BATCH_STRIDE = 19;

/** Public handle to the loaded WASM module. Re-exported kernels
 *  go here as later phases land — e.g. `physicsTick`,
 *  `quatDampedSpringStep`, etc. */
export interface SimWasm {
  /** Build-stamp from the Rust crate (CARGO_PKG_VERSION).
   *  Useful in dev / startup logs to confirm a fresh wasm-pack
   *  build is being served. */
  readonly version: string;
  /** Shared unit-body integrator (Phase 2). Used by both
   *  PhysicsEngine3D.integrate (server authoritative tick) AND
   *  ClientUnitPrediction.advanceSharedUnitMotionPrediction
   *  (client visual prediction). Same kernel → bit-identical
   *  motion → client prediction stops drifting from the server.
   *
   *  `motion` is a Float64Array of length 6: [x, y, z, vx, vy, vz]
   *  read AND written in place. Caller pre-samples ground state
   *  (groundZ, normal[X/Y/Z]) so the kernel never re-enters JS
   *  during a step. The normal is only consulted when penetration
   *  is in contact, so passing zero/up for the normal is safe
   *  when the caller knows the body is airborne. */
  readonly stepUnitMotion: (
    motion: Float64Array,
    dtSec: number,
    groundOffset: number,
    ax: number,
    ay: number,
    az: number,
    airDamp: number,
    groundDamp: number,
    launchAx: number,
    launchAy: number,
    launchAz: number,
    groundZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
  ) => void;
  /** Batched PhysicsEngine3D.integrate() — Phase 3a. Runs the
   *  whole per-tick integrate loop over every awake dynamic
   *  sphere body in one WASM call (no per-body marshalling).
   *
   *  `buf` is a Float64Array packed at stride
   *  STEP_UNIT_MOTIONS_BATCH_STRIDE per body. Field map:
   *    0..6  motion (x, y, z, vx, vy, vz)        in/out
   *    6..9  authored ax, ay, az                  in  (gravity added inside)
   *    9..12 launch_ax, launch_ay, launch_az      in  (rebound cap only)
   *    12    ground_offset                        in
   *    13..17 ground_z, normal_x, normal_y, normal_z  in (pre-sampled JS-side)
   *    17    sleeping_flag (out: 1.0 if just slept this step)
   *    18    sleep_ticks                          in/out
   *
   *  Caller responsibility: pack only awake dynamic spheres in
   *  index order; on return, scan slot+17 for 1.0 to detect
   *  bodies that just transitioned to sleep, then clear their
   *  force accumulators in the JS Body3D mirror and decrement
   *  awakeDynamicBodyCount. */
  readonly stepUnitMotionsBatch: (
    buf: Float64Array,
    count: number,
    dtSec: number,
    airDamp: number,
    groundDamp: number,
  ) => void;
}

let cached: Promise<SimWasm> | undefined;
let resolvedHandle: SimWasm | undefined;

/** Idempotent. Concurrent callers share one fetch + compile of
 *  the wasm module. Resolves once the WASM is instantiated and
 *  the auto-init (#[wasm_bindgen(start)]) panic hook has run. */
export function initSimWasm(): Promise<SimWasm> {
  if (cached === undefined) {
    cached = (async () => {
      await __wbg_init();
      const handle: SimWasm = {
        version: version(),
        stepUnitMotion: step_unit_motion,
        stepUnitMotionsBatch: step_unit_motions_batch,
      };
      resolvedHandle = handle;
      return handle;
    })();
  }
  return cached;
}

/** Synchronous accessor for the loaded WASM handle. Returns
 *  undefined if `initSimWasm()` hasn't resolved yet. Hot paths
 *  call this once at construction (or use the awaited handle)
 *  and cache it locally to avoid per-tick lookup overhead. */
export function getSimWasm(): SimWasm | undefined {
  return resolvedHandle;
}
