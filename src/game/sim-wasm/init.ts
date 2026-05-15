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
  resolve_sphere_sphere_contacts,
  pool_init,
  pool_capacity,
  pool_alloc_slot,
  pool_free_slot,
  pool_step_integrate,
  pool_resolve_sphere_sphere,
  pool_resolve_sphere_cuboid_pairs,
  pool_pos_x_ptr,
  pool_pos_y_ptr,
  pool_pos_z_ptr,
  pool_vel_x_ptr,
  pool_vel_y_ptr,
  pool_vel_z_ptr,
  pool_accel_x_ptr,
  pool_accel_y_ptr,
  pool_accel_z_ptr,
  pool_launch_x_ptr,
  pool_launch_y_ptr,
  pool_launch_z_ptr,
  pool_radius_ptr,
  pool_half_x_ptr,
  pool_half_y_ptr,
  pool_half_z_ptr,
  pool_inv_mass_ptr,
  pool_restitution_ptr,
  pool_ground_offset_ptr,
  pool_sleep_ticks_ptr,
  pool_flags_ptr,
} from './pkg/rts_sim_wasm';

/** Layout stride for `stepUnitMotionsBatch`. Each body occupies
 *  STEP_UNIT_MOTIONS_BATCH_STRIDE consecutive f64 slots in the
 *  buffer; see the docstring on `SimWasm.stepUnitMotionsBatch` for
 *  the field map. Mirrors `STEP_UNIT_MOTIONS_BATCH_STRIDE` in
 *  rts-sim-wasm/src/lib.rs. */
export const STEP_UNIT_MOTIONS_BATCH_STRIDE = 19;

/** Layout stride for `resolveSphereSphereContacts`. Mirrors the
 *  RESOLVE_SPHERE_SPHERE_STRIDE constant in rts-sim-wasm/src/lib.rs.
 *  Field map per body: 0..6 motion, 6 radius, 7 inv_mass, 8
 *  restitution, 9 entity_id_or_zero, 10 sleeping_flag (in),
 *  11 wake_flag (out), 12 upward_contact_flag (out). */
export const RESOLVE_SPHERE_SPHERE_STRIDE = 13;

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
  /** Iterated sphere-vs-sphere contact resolver — Phase 3c. Runs
   *  PhysicsEngine3D's full `rebuildContactCells` + N-pass
   *  `resolveSphereSphereContacts` loop in one WASM call. JS packs
   *  every dynamic sphere body into the buffer (sleeping ones still
   *  participate — see PhysicsEngine3D.ts line ~806 for why
   *  sleeping-body iteration is required for correctness), then
   *  reads back positions, velocities, wake_flag and upward
   *  contact_flag. Caller handles `wakeBody` + per-body
   *  `recordUpwardSurfaceContact` based on the output flags. */
  readonly resolveSphereSphereContacts: (
    buf: Float64Array,
    count: number,
    iterations: number,
    cellSize: number,
  ) => void;
  /** Body3D SoA pool — Phase 3d. Linear-memory-backed storage
   *  for every numeric body field. Slots are stable for a body's
   *  lifetime; `allocSlot()` returns the next free slot, `freeSlot`
   *  returns it. The view properties expose Float64Array /
   *  Uint8Array views over the pool's underlying storage so JS
   *  can read/write any body's field in O(1) without crossing
   *  the WASM boundary per access. Pool is initialized
   *  automatically at WASM load (one-time call to pool_init). */
  readonly pool: BodyPoolViews;
  /** Pool-backed integrate kernel — Phase 3d-2. Runs the per-tick
   *  integrate loop over every awake dynamic sphere by SLOT INDEX,
   *  reading body state directly from the pool. The Float64Array
   *  for body state is no longer marshalled per call; only the
   *  slot index list, pre-sampled ground state (terrain sampler
   *  is still JS-side until Phase 8), and a sleep-transitions
   *  output buffer cross the boundary. Returns the count of
   *  bodies that just slept this call (slot ids are written into
   *  sleep_transitions_out[0..return_value]). */
  readonly poolStepIntegrate: (
    awakeSlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
    sleepTransitionsOut: Uint32Array,
    dtSec: number,
    airDamp: number,
    groundDamp: number,
  ) => number;
  /** Pool-backed sphere-sphere resolver — Phase 3d-2. Iterates
   *  the broadphase + N sub-passes over body slots. State read /
   *  written via the pool; only the slot list, scalar params,
   *  and a wake-transitions output buffer cross the boundary.
   *  Upward-contact flag is set on the pool flags byte directly.
   *  Returns the count of bodies that need wake bookkeeping
   *  (slot ids are written into wake_transitions_out[0..return_value]). */
  readonly poolResolveSphereSphere: (
    sphereSlots: Uint32Array,
    iterations: number,
    cellSize: number,
    wakeTransitionsOut: Uint32Array,
  ) => number;
  /** Pool-backed sphere-vs-cuboid pair resolver — Phase 3b. JS
   *  iterates the existing static-cell broadphase to build a flat
   *  pair list (dyn_slot, static_slot interleaved); one WASM call
   *  resolves every pair in place. Both bodies' state lives in
   *  the BodyPool; only the pair list and a wake-transition output
   *  cross the boundary.
   *
   *  Wake bookkeeping: the kernel emits a wake transition for every
   *  pair that pushes — sleeping bodies and already-awake bodies
   *  alike. JS calls wakeBody() on each (idempotent on already-awake)
   *  to handle the awake-count + sleepTicks reset. Duplicates from
   *  a single dyn body hitting multiple cuboids in one tick are
   *  safe under wakeBody's idempotence.
   *
   *  Returns count of wake transitions written into the buffer. */
  readonly poolResolveSphereCuboidPairs: (
    pairs: Uint32Array,
    wakeTransitionsOut: Uint32Array,
  ) => number;
}

/** Bit flags packed into BodyPoolViews.flags[slot]. Mirrors the
 *  BODY_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const BODY_FLAG_SLEEPING = 1 << 0;
export const BODY_FLAG_IS_STATIC = 1 << 1;
export const BODY_FLAG_UPWARD_CONTACT = 1 << 2;
export const BODY_FLAG_SHAPE_CUBOID = 1 << 3;
export const BODY_FLAG_OCCUPIED = 1 << 4;

/** Typed-array views over the WASM-side BodyPool. All views are
 *  indexed by slot id (returned by allocSlot()). Capacity is
 *  fixed at pool_init() so views never need to be refreshed
 *  unless the WASM linear memory itself grows underneath us;
 *  call `refreshViews()` after any operation that might trigger
 *  memory growth (rare under our usage pattern). */
export interface BodyPoolViews {
  readonly capacity: number;
  /** Allocate the next free slot; throws if pool is exhausted. */
  allocSlot: () => number;
  /** Return a slot to the free list. Caller must clear any
   *  pool-managed fields the slot held to sensible defaults if
   *  it's reused later (alloc_slot zeros all fields, so explicit
   *  cleanup isn't required for correctness — just for clarity). */
  freeSlot: (slot: number) => void;
  /** Re-construct all views over the WASM linear memory. Call after
   *  any operation that may have grown WASM memory and detached
   *  existing views. In practice the fixed-capacity pool means
   *  growth is very rare — call defensively at the start of each
   *  tick if you're paranoid, or rely on the views' detachment
   *  check (`view.byteLength === 0`) to detect stale views. */
  refreshViews: () => void;

  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  accelX: Float64Array;
  accelY: Float64Array;
  accelZ: Float64Array;
  launchX: Float64Array;
  launchY: Float64Array;
  launchZ: Float64Array;
  radius: Float64Array;
  halfX: Float64Array;
  halfY: Float64Array;
  halfZ: Float64Array;
  invMass: Float64Array;
  restitution: Float64Array;
  groundOffset: Float64Array;
  sleepTicks: Float64Array;
  flags: Uint8Array;
}

let cached: Promise<SimWasm> | undefined;
let resolvedHandle: SimWasm | undefined;

/** Idempotent. Concurrent callers share one fetch + compile of
 *  the wasm module. Resolves once the WASM is instantiated and
 *  the auto-init (#[wasm_bindgen(start)]) panic hook has run. */
export function initSimWasm(): Promise<SimWasm> {
  if (cached === undefined) {
    cached = (async () => {
      const initOutput = await __wbg_init();
      pool_init();
      const memory = initOutput.memory;
      const capacity = pool_capacity();

      const f64View = (ptr: number): Float64Array =>
        new Float64Array(memory.buffer, ptr, capacity);
      const u8View = (ptr: number): Uint8Array =>
        new Uint8Array(memory.buffer, ptr, capacity);

      // Hold field pointers so refreshViews() can rebuild the
      // typed-array views over potentially-detached WASM memory
      // (linear memory grow detaches all existing views).
      const ptrs = {
        posX: pool_pos_x_ptr(),
        posY: pool_pos_y_ptr(),
        posZ: pool_pos_z_ptr(),
        velX: pool_vel_x_ptr(),
        velY: pool_vel_y_ptr(),
        velZ: pool_vel_z_ptr(),
        accelX: pool_accel_x_ptr(),
        accelY: pool_accel_y_ptr(),
        accelZ: pool_accel_z_ptr(),
        launchX: pool_launch_x_ptr(),
        launchY: pool_launch_y_ptr(),
        launchZ: pool_launch_z_ptr(),
        radius: pool_radius_ptr(),
        halfX: pool_half_x_ptr(),
        halfY: pool_half_y_ptr(),
        halfZ: pool_half_z_ptr(),
        invMass: pool_inv_mass_ptr(),
        restitution: pool_restitution_ptr(),
        groundOffset: pool_ground_offset_ptr(),
        sleepTicks: pool_sleep_ticks_ptr(),
        flags: pool_flags_ptr(),
      };

      const pool: BodyPoolViews = {
        capacity,
        allocSlot: pool_alloc_slot,
        freeSlot: pool_free_slot,
        refreshViews: () => {
          pool.posX = f64View(ptrs.posX);
          pool.posY = f64View(ptrs.posY);
          pool.posZ = f64View(ptrs.posZ);
          pool.velX = f64View(ptrs.velX);
          pool.velY = f64View(ptrs.velY);
          pool.velZ = f64View(ptrs.velZ);
          pool.accelX = f64View(ptrs.accelX);
          pool.accelY = f64View(ptrs.accelY);
          pool.accelZ = f64View(ptrs.accelZ);
          pool.launchX = f64View(ptrs.launchX);
          pool.launchY = f64View(ptrs.launchY);
          pool.launchZ = f64View(ptrs.launchZ);
          pool.radius = f64View(ptrs.radius);
          pool.halfX = f64View(ptrs.halfX);
          pool.halfY = f64View(ptrs.halfY);
          pool.halfZ = f64View(ptrs.halfZ);
          pool.invMass = f64View(ptrs.invMass);
          pool.restitution = f64View(ptrs.restitution);
          pool.groundOffset = f64View(ptrs.groundOffset);
          pool.sleepTicks = f64View(ptrs.sleepTicks);
          pool.flags = u8View(ptrs.flags);
        },
        // Initialised below; the explicit assignments make the
        // type narrowing happy.
        posX: f64View(ptrs.posX),
        posY: f64View(ptrs.posY),
        posZ: f64View(ptrs.posZ),
        velX: f64View(ptrs.velX),
        velY: f64View(ptrs.velY),
        velZ: f64View(ptrs.velZ),
        accelX: f64View(ptrs.accelX),
        accelY: f64View(ptrs.accelY),
        accelZ: f64View(ptrs.accelZ),
        launchX: f64View(ptrs.launchX),
        launchY: f64View(ptrs.launchY),
        launchZ: f64View(ptrs.launchZ),
        radius: f64View(ptrs.radius),
        halfX: f64View(ptrs.halfX),
        halfY: f64View(ptrs.halfY),
        halfZ: f64View(ptrs.halfZ),
        invMass: f64View(ptrs.invMass),
        restitution: f64View(ptrs.restitution),
        groundOffset: f64View(ptrs.groundOffset),
        sleepTicks: f64View(ptrs.sleepTicks),
        flags: u8View(ptrs.flags),
      };

      const handle: SimWasm = {
        version: version(),
        stepUnitMotion: step_unit_motion,
        stepUnitMotionsBatch: step_unit_motions_batch,
        resolveSphereSphereContacts: resolve_sphere_sphere_contacts,
        pool,
        poolStepIntegrate: pool_step_integrate,
        poolResolveSphereSphere: pool_resolve_sphere_sphere,
        poolResolveSphereCuboidPairs: pool_resolve_sphere_cuboid_pairs,
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
