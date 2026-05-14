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
//
// Phase 1 (this commit): the WASM exports just `version()` plus
// the auto-init panic hook. Subsequent phases add the actual sim
// kernels per issues.txt; this file picks them up automatically
// as additional re-exports from the SimWasm interface.

import __wbg_init, { version } from './pkg/rts_sim_wasm';

/** Public handle to the loaded WASM module. Re-exported kernels
 *  go here as later phases land — e.g. `stepUnitMotion`,
 *  `physicsTick`, `quatDampedSpringStep`, etc. */
export interface SimWasm {
  /** Build-stamp from the Rust crate (CARGO_PKG_VERSION).
   *  Useful in dev / startup logs to confirm a fresh wasm-pack
   *  build is being served. */
  readonly version: string;
}

let cached: Promise<SimWasm> | undefined;

/** Idempotent. Concurrent callers share one fetch + compile of
 *  the wasm module. Resolves once the WASM is instantiated and
 *  the auto-init (#[wasm_bindgen(start)]) panic hook has run. */
export function initSimWasm(): Promise<SimWasm> {
  if (cached === undefined) {
    cached = (async () => {
      await __wbg_init();
      // Read the version once on init so callers that only need
      // the build stamp don't have to invoke a WASM call later.
      const v = version();
      return { version: v };
    })();
  }
  return cached;
}
