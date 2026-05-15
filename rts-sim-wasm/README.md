# rts-sim-wasm

Bespoke RTS simulation core. Compiled to WebAssembly and loaded by
**both** the authoritative server tick and the client prediction
stepper, so client prediction is bit-identical to server motion.

The phase-by-phase migration log lives in `issues.txt` at the repo
root. The "what to move and why" principle is in
`docs/wasm-migration-principle.md`.

## Building

You need:

- A recent Rust toolchain (rustup, edition 2021).
- The `wasm32-unknown-unknown` target. Rustup adds this on demand:
  `rustup target add wasm32-unknown-unknown`.
- `wasm-pack` on PATH: `cargo install wasm-pack`.
- (Optional) `binaryen` for the `wasm-opt -Oz` post-pass. Without it
  the build still works; the script just prints a note and skips
  optimization. `brew install binaryen` on macOS.

Build the WASM module from the repo root:

```sh
npm run build:wasm
```

This invokes `wasm-pack build --release --target web --out-dir
../src/game/sim-wasm/pkg` and then runs `wasm-opt -Oz` if available.
The output `pkg/` directory is gitignored — every dev rebuilds
locally.

For an unoptimized dev build that includes debug symbols:

```sh
npm run build:wasm:dev
```

## Dev workflow

The full build runs `build:wasm` before `vue-tsc` + `vite build`, so
`npm run build` always picks up Rust changes. `npm run dev` does
NOT rebuild Rust automatically — run `npm run build:wasm` after any
edit under `rts-sim-wasm/src/`.

Pair `cargo watch` with `npm run dev` for hot-reload:

```sh
# In one terminal:
cargo watch -s 'cd .. && npm run build:wasm'
# In another:
npm run dev
```

## TS fallback path

Every WASM-exported kernel has a paired TS fallback in the
caller's TypeScript file (e.g. `MathHelpers.ts`,
`HomingSteering.ts`, `terrainSurface.ts`). The dispatcher checks
`getSimWasm() !== undefined` before calling into Rust; the TS path
runs during the brief boot window before `initSimWasm()` resolves,
and as a structural identity-check reference implementation when
swapping a system out for debugging.

## Browser requirement: WebAssembly SIMD

The release build enables `+simd128` (see `.cargo/config.toml`).
LLVM's auto-vectorizer uses v128 intrinsics for the physics inner
loops (Vec3 / Quat math, sphere-sphere broadphase, closest-point
on AABB) without manual SIMD annotations in the source.

Required browser versions:
- Chrome 91+ (May 2021)
- Firefox 89+ (June 2021)
- Safari 16.4+ / iOS Safari 16.4+ (March 2023)

Older browsers fail at WASM compile time with a clear opcode error.
If iOS Safari < 16.4 needs to be a target, see the deferred Tier E
follow-up in `issues.txt` for a dual-build (simd + non-simd) plan
with runtime feature detection.

## Architecture invariants

- The Body3D and projectile pools live in WASM linear memory.
  JS-side typed-array views must be refreshed (`pool.refreshViews()`
  / `projectilePool.refreshViews()`) at the start of each per-tick
  consumer in case WASM `memory.grow()` detached views since the
  last call.
- Linear memory is pre-grown to 32 MiB (512 pages) at init so
  steady-state allocations don't trigger grows. Bump
  `PRE_GROW_TARGET_PAGES` in `init.ts` if Phase 7/9/10 ports push
  past that.
- Numerical constants in the integrator kernels (GRAVITY,
  UNIT_GROUND_SPRING_*, SLEEP_*, WATER_LEVEL_*) are duplicated
  Rust-side from `config.ts` / `terrainConfig.ts`. If you change a
  tuning value in TS, mirror it in `lib.rs` or the two integrators
  will drift.

## CI

CI must run `npm run build:wasm` before any test or build step that
loads the module. `cargo` + `wasm-pack` need to be on PATH;
`binaryen` is optional but cuts the .wasm size.
