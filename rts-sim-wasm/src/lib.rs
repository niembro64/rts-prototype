// rts-sim-wasm — bespoke RTS simulation core.
//
// Compiled to WebAssembly via wasm-pack, loaded by BOTH the
// authoritative server tick AND the client prediction stepper.
// Same numerical kernels run on both sides so client prediction
// is bit-identical to server authoritative motion.
//
// Phase 1 (this commit): scaffolding only. Exports a `version()`
// function so the JS side can confirm the module loaded and
// installs a panic hook so any future panic reaches the browser
// devtools as a readable trace instead of `RuntimeError: unreachable`.
//
// Subsequent phases (per issues.txt):
//   2  step_unit_motion        — shared unit-body integrator
//   3  PhysicsEngine3D core    — Body3D SoA + resolvers + sleep
//   4  quaternion math kernel  — used by hover orientation spring
//   5  projectile motion       — ballistic + homing + beam paths
//   6  turret + targeting      — damped-spring + top-K LOS scan
//   7  spatial grid            — 3D voxel hash
//   8  terrain sampling        — heightmap in linear memory
//   9  pathfinder              — A* over the walk grid
//  10  snapshot serializer     — per-entity quantize + delta path

use wasm_bindgen::prelude::*;

/// Build-stamp string. JS calls this once on load to confirm the
/// WASM module matches the expected crate revision; mismatch
/// implies a stale wasm-pack build in src/game/sim-wasm/pkg/.
#[wasm_bindgen]
pub fn version() -> String {
    // Pull from Cargo's CARGO_PKG_VERSION at build time. Bump the
    // package version in Cargo.toml when the wire/API shape changes.
    format!("rts-sim-wasm {}", env!("CARGO_PKG_VERSION"))
}

/// Module init. wasm-bindgen calls this automatically when the
/// JS side imports the module (because of the #[wasm_bindgen(start)]
/// attribute). Installs the panic hook before any other code runs.
#[wasm_bindgen(start)]
pub fn __init() {
    // Route Rust panics through console.error with a full stack
    // trace, instead of the default `RuntimeError: unreachable`
    // that wasm produces on panic.
    console_error_panic_hook::set_once();
}
