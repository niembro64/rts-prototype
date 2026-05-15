// rts-sim-wasm — bespoke RTS simulation core.
//
// Compiled to WebAssembly via wasm-pack, loaded by BOTH the
// authoritative server tick AND the client prediction stepper.
// Same numerical kernels run on both sides so client prediction
// is bit-identical to server authoritative motion.
//
// Phase 1 landed the scaffolding. Phase 2 (this commit) ports
// the shared unit-motion integrator. Subsequent phases per
// issues.txt:
//   3  PhysicsEngine3D core    — Body3D SoA + resolvers + sleep
//   4  quaternion math kernel  — used by hover orientation spring
//   5  projectile motion       — ballistic + homing + beam paths
//   6  turret + targeting      — damped-spring + top-K LOS scan
//   7  spatial grid            — 3D voxel hash
//   8  terrain sampling        — heightmap in linear memory
//   9  pathfinder              — A* over the walk grid
//  10  snapshot serializer     — per-entity quantize + delta path

use std::cell::UnsafeCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Module init + build stamp
// ─────────────────────────────────────────────────────────────────

/// Build-stamp string. JS calls this once on load to confirm the
/// WASM module matches the expected crate revision; mismatch
/// implies a stale wasm-pack build in src/game/sim-wasm/pkg/.
#[wasm_bindgen]
pub fn version() -> String {
    format!("rts-sim-wasm {}", env!("CARGO_PKG_VERSION"))
}

/// Module init. wasm-bindgen calls this automatically when the
/// JS side imports the module (because of the #[wasm_bindgen(start)]
/// attribute). Installs the panic hook before any other code runs.
#[wasm_bindgen(start)]
pub fn __init() {
    console_error_panic_hook::set_once();
}

// ─────────────────────────────────────────────────────────────────
//  Unit-motion integrator constants
//
//  These mirror src/config.ts and src/game/sim/unitGroundPhysics.ts.
//  Authoritative source-of-truth is the TS config; Rust hardcodes
//  the same values so the two integrators produce identical motion.
//  If a tuning value changes in config.ts, update the matching
//  const below.
// ─────────────────────────────────────────────────────────────────

const UNIT_GROUND_CONTACT_EPSILON: f64 = 1e-3;
const UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT: f64 = 900.0;
const UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED: f64 = 5.0;
// = ratio (1.0) * 2 * sqrt(UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT)
//   = 1 * 2 * sqrt(900) = 60.0 exactly.
const GROUND_SPRING_DAMPING_ACCEL_PER_SPEED: f64 = 60.0;

// Mirrors src/config.ts `export const GRAVITY = 500;`
const GRAVITY: f64 = 500.0;

// Mirrors PhysicsEngine3D.ts sleep heuristic constants.
const SLEEP_SPEED_SQ: f64 = 0.25;
const SLEEP_ACCEL_SQ: f64 = 1e-6;
const SLEEP_TICKS: f64 = 12.0;
const SLEEP_GROUND_PENETRATION_EPS: f64 = 0.1;

#[inline]
fn is_in_contact(penetration: f64) -> bool {
    penetration >= -UNIT_GROUND_CONTACT_EPSILON
}

#[inline]
fn ground_spring_accel(penetration: f64, normal_velocity: f64) -> f64 {
    if !is_in_contact(penetration) {
        return 0.0;
    }
    let compression = penetration.max(0.0);
    if compression <= 0.0 {
        return 0.0;
    }
    let spring = UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT * compression;
    let damped = spring - GROUND_SPRING_DAMPING_ACCEL_PER_SPEED * normal_velocity;
    if damped.is_finite() {
        damped.max(0.0)
    } else {
        0.0
    }
}

// ─────────────────────────────────────────────────────────────────
//  Contact-cell broadphase encoding (shared helper)
//
//  Mirrors the JS-side packContactCellKey in PhysicsEngine3D.ts —
//  16-bit cx + 16-bit cy + 16-bit cz packed into a u64. Used by
//  the sphere-sphere broadphase in pool_resolve_sphere_sphere
//  (Phase 3d-2).
// ─────────────────────────────────────────────────────────────────
const CONTACT_CELL_BIAS: i64 = 32768;
const CONTACT_CELL_MASK: i64 = 0xFFFF;

#[inline]
fn pack_contact_cell_key(cx: i32, cy: i32, cz: i32) -> u64 {
    let cxb = ((cx as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    let cyb = ((cy as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    let czb = ((cz as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    (cxb << 32) | (cyb << 16) | czb
}

// ─────────────────────────────────────────────────────────────────
//  Shared unit-motion integrator. Used by both:
//   - PhysicsEngine3D.integrate (server authoritative tick)
//   - ClientUnitPrediction.advanceSharedUnitMotionPrediction
//     (client visual prediction)
//  Same kernel → identical numerical behavior → client prediction
//  is bit-identical to server motion.
//
//  Convention: ground sampling is the CALLER'S job (they know the
//  body's x,y already). Pass the pre-sampled groundZ + normal in.
//  The kernel only consults the normal if penetration is in contact;
//  the JS wrapper should still gate getGroundNormal() on the
//  pre-computed penetration to preserve the existing "skip the
//  expensive normal sample when in the air" optimization.
//
//  The motion slice is [x, y, z, vx, vy, vz] in/out (6 f64s).
//  wasm-bindgen marshals it as a Float64Array — a per-call copy
//  in + copy out of 48 bytes, negligible at 60 Hz. Phase 3's SoA
//  pool will move this state into linear memory so the kernel
//  works on the canonical buffer directly with zero marshalling.
// ─────────────────────────────────────────────────────────────────

/// Internal math kernel: applies the explicit-Euler step to a
/// single body's motion state. Reused by both the per-body
/// `step_unit_motion` boundary call (used by the TS bootstrap
/// fallback path) and the batched `step_unit_motions_batch`
/// (used by the live tick). Operates on a fixed-size [6] slice
/// so it can be called from either context without heap traffic.
///
/// All math here mirrors src/game/sim/unitMotionIntegration.ts
/// EXACTLY (same f64, same op order, same constants) — the two
/// branches must be numerically bit-identical so swapping mid-
/// session doesn't shift motion.
#[inline]
fn integrate_unit_motion_inline(
    motion: &mut [f64; 6],
    dt_sec: f64,
    ground_offset: f64,
    ax_in: f64,
    ay_in: f64,
    az_in: f64,
    air_damp: f64,
    ground_damp: f64,
    launch_ax: f64,
    launch_ay: f64,
    launch_az: f64,
    ground_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
) {
    let mut x = motion[0];
    let mut y = motion[1];
    let mut z = motion[2];
    let mut vx = motion[3];
    let mut vy = motion[4];
    let mut vz = motion[5];

    let penetration = ground_z - (z - ground_offset);
    let in_contact = is_in_contact(penetration);

    let mut ax_total = ax_in;
    let mut ay_total = ay_in;
    let mut az_total = az_in;
    if in_contact {
        let normal_velocity = vx * normal_x + vy * normal_y + vz * normal_z;
        let spring = ground_spring_accel(penetration, normal_velocity);
        ax_total += normal_x * spring;
        ay_total += normal_y * spring;
        az_total += normal_z * spring;
    }

    vx += ax_total * dt_sec;
    vy += ay_total * dt_sec;
    vz += az_total * dt_sec;
    vx *= air_damp;
    vy *= air_damp;
    vz *= air_damp;

    if in_contact {
        let v_normal = vx * normal_x + vy * normal_y + vz * normal_z;
        let tangent_x = vx - v_normal * normal_x;
        let tangent_y = vy - v_normal * normal_y;
        let tangent_z = vz - v_normal * normal_z;
        vx = v_normal * normal_x + tangent_x * ground_damp;
        vy = v_normal * normal_y + tangent_y * ground_damp;
        vz = v_normal * normal_z + tangent_z * ground_damp;

        let launch_normal_accel =
            launch_ax * normal_x + launch_ay * normal_y + launch_az * normal_z;
        let launch_outward_speed =
            if launch_normal_accel.is_finite() && dt_sec.is_finite() && dt_sec > 0.0 {
                (launch_normal_accel * dt_sec).max(0.0)
            } else {
                0.0
            };
        let max_allowed_outward_speed =
            UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED + launch_outward_speed;

        let v_normal_after = vx * normal_x + vy * normal_y + vz * normal_z;
        if v_normal_after > max_allowed_outward_speed {
            let remove = v_normal_after - max_allowed_outward_speed;
            vx -= remove * normal_x;
            vy -= remove * normal_y;
            vz -= remove * normal_z;
        }
    }

    x += vx * dt_sec;
    y += vy * dt_sec;
    z += vz * dt_sec;

    motion[0] = x;
    motion[1] = y;
    motion[2] = z;
    motion[3] = vx;
    motion[4] = vy;
    motion[5] = vz;
}

#[wasm_bindgen]
pub fn step_unit_motion(
    motion: &mut [f64],
    dt_sec: f64,
    ground_offset: f64,
    ax: f64,
    ay: f64,
    az: f64,
    air_damp: f64,
    ground_damp: f64,
    launch_ax: f64,
    launch_ay: f64,
    launch_az: f64,
    ground_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
) {
    debug_assert_eq!(
        motion.len(),
        6,
        "step_unit_motion expects motion = [x, y, z, vx, vy, vz]"
    );
    // try_into here is infallible given the assert above; we use a
    // hand-cast to keep the helper signature crisp.
    let m: &mut [f64; 6] = (&mut motion[0..6]).try_into().unwrap();
    integrate_unit_motion_inline(
        m,
        dt_sec,
        ground_offset,
        ax, ay, az,
        air_damp, ground_damp,
        launch_ax, launch_ay, launch_az,
        ground_z,
        normal_x, normal_y, normal_z,
    );
}

// ─────────────────────────────────────────────────────────────────
//  Buffer-based step_unit_motions_batch (Phase 3a) and
//  resolve_sphere_sphere_contacts (Phase 3c) were superseded by
//  the pool-backed pool_step_integrate / pool_resolve_sphere_sphere
//  in Phase 3d-2 — both bodies' state lives in the BodyPool now,
//  so the per-tick pack/unpack scratch buffer is gone. The old
//  functions are deleted; the inline integrate-math helper above
//  is shared with the per-body `step_unit_motion` (still used by
//  the TS bootstrap fallback in unitMotionIntegration.ts) and the
//  pool-backed kernels below.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
//  Phase 3d — Body3D SoA pool in WASM linear memory
//
//  Foundational data structure for the bespoke physics engine. All
//  per-body state lives here as parallel SoA arrays; JS gets
//  Float64Array / Uint8Array views over linear memory and reads/
//  writes body fields by slot index. Future phases route every
//  Rust kernel directly through these arrays — eliminating per-
//  tick marshalling between JS Body3D structs and Rust scratch
//  buffers (Phase 3a's _integrateBatchBuf, Phase 3c's
//  _sphereSphereBatchBuf). Slot indices are STABLE for the body's
//  lifetime — they're handed back to JS at create time and used
//  for every subsequent operation.
//
//  Capacity is fixed at POOL_CAPACITY at init time. Vecs never
//  reallocate, so the typed-array views JS holds remain valid
//  forever (no per-tick view refresh). Sized for an upper bound
//  on simultaneous bodies (units + buildings); 4096 is plenty for
//  the unit counts the game runs (typically a few hundred).
//
//  Free-slot management: a free-list Vec drains last-allocated
//  first. `next_unused_slot` tracks the high-water mark for the
//  initial allocation walk before any body is removed.
//
//  Field set chosen to cover Body3D in PhysicsEngine3D.ts. Cold
//  fields (label string, EntityId, shape category) stay JS-side —
//  Rust doesn't need them and crossing them across the boundary
//  every step would waste cycles.
// ─────────────────────────────────────────────────────────────────

pub const POOL_CAPACITY: u32 = 4096;
const POOL_CAPACITY_USIZE: usize = POOL_CAPACITY as usize;

// Bit positions inside the per-body `flags: Vec<u8>`. Mirrors the
// JS-side BODY_FLAG_* constants in src/game/server/Body3DPool.ts.
pub const BODY_FLAG_SLEEPING: u8 = 1 << 0;
pub const BODY_FLAG_IS_STATIC: u8 = 1 << 1;
pub const BODY_FLAG_UPWARD_CONTACT: u8 = 1 << 2;
pub const BODY_FLAG_SHAPE_CUBOID: u8 = 1 << 3;
pub const BODY_FLAG_OCCUPIED: u8 = 1 << 4;

struct BodyPool {
    // Position + velocity + per-step accumulator. The hot integrator
    // path mutates these every tick.
    pos_x: Vec<f64>,
    pos_y: Vec<f64>,
    pos_z: Vec<f64>,
    vel_x: Vec<f64>,
    vel_y: Vec<f64>,
    vel_z: Vec<f64>,
    accel_x: Vec<f64>,
    accel_y: Vec<f64>,
    accel_z: Vec<f64>,
    launch_x: Vec<f64>,
    launch_y: Vec<f64>,
    launch_z: Vec<f64>,

    // Geometry / mass — set at body creation, rarely changed after.
    radius: Vec<f64>,
    half_x: Vec<f64>,
    half_y: Vec<f64>,
    half_z: Vec<f64>,
    inv_mass: Vec<f64>,
    restitution: Vec<f64>,
    ground_offset: Vec<f64>,

    // Sleep state. `sleep_ticks` is f64 to match the JS side's
    // numeric counter and sit on a single ptr export.
    sleep_ticks: Vec<f64>,

    // Bitfield: see BODY_FLAG_* constants.
    flags: Vec<u8>,

    // Free-list + high-water mark for slot allocation.
    free_slots: Vec<u32>,
    next_unused_slot: u32,
}

impl BodyPool {
    fn new() -> Self {
        let cap = POOL_CAPACITY_USIZE;
        Self {
            pos_x: vec![0.0; cap],
            pos_y: vec![0.0; cap],
            pos_z: vec![0.0; cap],
            vel_x: vec![0.0; cap],
            vel_y: vec![0.0; cap],
            vel_z: vec![0.0; cap],
            accel_x: vec![0.0; cap],
            accel_y: vec![0.0; cap],
            accel_z: vec![0.0; cap],
            launch_x: vec![0.0; cap],
            launch_y: vec![0.0; cap],
            launch_z: vec![0.0; cap],
            radius: vec![0.0; cap],
            half_x: vec![0.0; cap],
            half_y: vec![0.0; cap],
            half_z: vec![0.0; cap],
            inv_mass: vec![0.0; cap],
            restitution: vec![0.0; cap],
            ground_offset: vec![0.0; cap],
            sleep_ticks: vec![0.0; cap],
            flags: vec![0u8; cap],
            free_slots: Vec::with_capacity(64),
            next_unused_slot: 0,
        }
    }

    fn alloc_slot(&mut self) -> u32 {
        let slot = if let Some(s) = self.free_slots.pop() {
            s
        } else {
            let s = self.next_unused_slot;
            self.next_unused_slot += 1;
            s
        };
        debug_assert!(
            (slot as usize) < POOL_CAPACITY_USIZE,
            "BodyPool exhausted (capacity {})",
            POOL_CAPACITY_USIZE
        );
        // Zero the slot in case it's being reused.
        let i = slot as usize;
        self.pos_x[i] = 0.0;
        self.pos_y[i] = 0.0;
        self.pos_z[i] = 0.0;
        self.vel_x[i] = 0.0;
        self.vel_y[i] = 0.0;
        self.vel_z[i] = 0.0;
        self.accel_x[i] = 0.0;
        self.accel_y[i] = 0.0;
        self.accel_z[i] = 0.0;
        self.launch_x[i] = 0.0;
        self.launch_y[i] = 0.0;
        self.launch_z[i] = 0.0;
        self.radius[i] = 0.0;
        self.half_x[i] = 0.0;
        self.half_y[i] = 0.0;
        self.half_z[i] = 0.0;
        self.inv_mass[i] = 0.0;
        self.restitution[i] = 0.0;
        self.ground_offset[i] = 0.0;
        self.sleep_ticks[i] = 0.0;
        self.flags[i] = BODY_FLAG_OCCUPIED;
        slot
    }

    fn free_slot(&mut self, slot: u32) {
        let i = slot as usize;
        debug_assert!(i < POOL_CAPACITY_USIZE);
        debug_assert_ne!(self.flags[i] & BODY_FLAG_OCCUPIED, 0, "freeing already-free slot");
        self.flags[i] = 0;
        self.free_slots.push(slot);
    }
}

// Single-threaded WASM, so an UnsafeCell-wrapped static is safe.
// Rust doesn't have a true single-threaded global without unsafe;
// the OnceCell + UnsafeCell pattern keeps the unsafety contained.
struct PoolHolder(UnsafeCell<Option<BodyPool>>);

unsafe impl Sync for PoolHolder {}

static POOL: PoolHolder = PoolHolder(UnsafeCell::new(None));

#[inline]
fn pool() -> &'static mut BodyPool {
    // SAFETY: WASM is single-threaded; there's no concurrent access.
    // pool_init must have been called before any pool_* function.
    unsafe {
        (*POOL.0.get())
            .as_mut()
            .expect("pool_init() not called before pool access")
    }
}

#[wasm_bindgen]
pub fn pool_init() {
    // SAFETY: see `pool()`.
    unsafe {
        let cell = POOL.0.get();
        if (*cell).is_none() {
            *cell = Some(BodyPool::new());
        }
    }
}

#[wasm_bindgen]
pub fn pool_capacity() -> u32 {
    POOL_CAPACITY
}

#[wasm_bindgen]
pub fn pool_alloc_slot() -> u32 {
    pool().alloc_slot()
}

#[wasm_bindgen]
pub fn pool_free_slot(slot: u32) {
    pool().free_slot(slot);
}

// Per-field raw pointer exports. JS constructs Float64Array /
// Uint8Array views once after pool_init(); pointers stay stable
// because the underlying Vecs were sized to POOL_CAPACITY at init
// and never reallocate.
//
// One ptr per field rather than a single struct-of-arrays handle
// — wasm-bindgen doesn't have first-class ptr-to-struct support
// and per-field access keeps the JS view code straightforward.

macro_rules! pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            pool().$field.as_ptr()
        }
    };
}

pool_ptr_export!(pool_pos_x_ptr, pos_x, f64);
pool_ptr_export!(pool_pos_y_ptr, pos_y, f64);
pool_ptr_export!(pool_pos_z_ptr, pos_z, f64);
pool_ptr_export!(pool_vel_x_ptr, vel_x, f64);
pool_ptr_export!(pool_vel_y_ptr, vel_y, f64);
pool_ptr_export!(pool_vel_z_ptr, vel_z, f64);
pool_ptr_export!(pool_accel_x_ptr, accel_x, f64);
pool_ptr_export!(pool_accel_y_ptr, accel_y, f64);
pool_ptr_export!(pool_accel_z_ptr, accel_z, f64);
pool_ptr_export!(pool_launch_x_ptr, launch_x, f64);
pool_ptr_export!(pool_launch_y_ptr, launch_y, f64);
pool_ptr_export!(pool_launch_z_ptr, launch_z, f64);
pool_ptr_export!(pool_radius_ptr, radius, f64);
pool_ptr_export!(pool_half_x_ptr, half_x, f64);
pool_ptr_export!(pool_half_y_ptr, half_y, f64);
pool_ptr_export!(pool_half_z_ptr, half_z, f64);
pool_ptr_export!(pool_inv_mass_ptr, inv_mass, f64);
pool_ptr_export!(pool_restitution_ptr, restitution, f64);
pool_ptr_export!(pool_ground_offset_ptr, ground_offset, f64);
pool_ptr_export!(pool_sleep_ticks_ptr, sleep_ticks, f64);
pool_ptr_export!(pool_flags_ptr, flags, u8);

// ─────────────────────────────────────────────────────────────────
//  Phase 3d-2 — Pool-backed integrate + sphere-sphere kernels
//
//  The per-tick "scratch buffer + pack + call + unpack" pattern of
//  Phase 3a's `step_unit_motions_batch` and Phase 3c's
//  `resolve_sphere_sphere_contacts` is replaced by direct pool
//  reads/writes via slot indices. JS only marshals:
//    - the slot-index list (4 bytes per active body)
//    - per-body pre-sampled ground state (groundZ + normal —
//      terrain sampler is still JS-side until Phase 8)
//    - sleep / wake transition output buffers (slot ids of bodies
//      whose sleep state flipped this call; JS handles the awake-
//      count bookkeeping)
//  All body fields (motion, velocity, accumulators, geometry,
//  flags) live in linear memory and are read directly. Per-tick
//  marshal drops from O(N · 19 + N · 13) f64s to O(N · 4 + 4N)
//  f64s — about a 6x reduction at typical unit counts.
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn pool_step_integrate(
    awake_slots: &[u32],
    ground_z: &[f64],
    ground_normals: &[f64],
    sleep_transitions_out: &mut [u32],
    dt_sec: f64,
    air_damp: f64,
    ground_damp: f64,
) -> u32 {
    let count = awake_slots.len();
    debug_assert!(ground_z.len() >= count);
    debug_assert!(ground_normals.len() >= 3 * count);
    debug_assert!(sleep_transitions_out.len() >= count);

    let p = pool();
    let mut transitions = 0_u32;
    for i in 0..count {
        let slot_u32 = awake_slots[i];
        let slot = slot_u32 as usize;
        let g_z = ground_z[i];
        let n_x = ground_normals[i * 3];
        let n_y = ground_normals[i * 3 + 1];
        let n_z = ground_normals[i * 3 + 2];

        let ground_offset = p.ground_offset[slot];

        // authored_accel is the input force BEFORE gravity is added.
        // Mirrors PhysicsEngine3D.integrate's authoredAccelSq
        // computation (used for the sleep gate).
        let authored_ax = p.accel_x[slot];
        let authored_ay = p.accel_y[slot];
        let authored_az = p.accel_z[slot];
        let authored_accel_sq =
            authored_ax * authored_ax + authored_ay * authored_ay + authored_az * authored_az;

        let launch_ax = p.launch_x[slot];
        let launch_ay = p.launch_y[slot];
        let launch_az = p.launch_z[slot];

        // Run the integrator on a 6-element scratch — the inline
        // helper is shared with the per-body / batched buffer paths
        // so all branches stay numerically identical.
        let mut motion = [
            p.pos_x[slot],
            p.pos_y[slot],
            p.pos_z[slot],
            p.vel_x[slot],
            p.vel_y[slot],
            p.vel_z[slot],
        ];
        integrate_unit_motion_inline(
            &mut motion,
            dt_sec,
            ground_offset,
            authored_ax,
            authored_ay,
            authored_az - GRAVITY,
            air_damp,
            ground_damp,
            launch_ax,
            launch_ay,
            launch_az,
            g_z,
            n_x,
            n_y,
            n_z,
        );
        p.pos_x[slot] = motion[0];
        p.pos_y[slot] = motion[1];
        p.pos_z[slot] = motion[2];
        p.vel_x[slot] = motion[3];
        p.vel_y[slot] = motion[4];
        p.vel_z[slot] = motion[5];

        // Sleep heuristic — same constants + check order as Phase 3a.
        let speed_sq = motion[3] * motion[3] + motion[4] * motion[4] + motion[5] * motion[5];
        let mut sleep_ticks = p.sleep_ticks[slot];
        let mut just_slept = false;
        if authored_accel_sq <= SLEEP_ACCEL_SQ && speed_sq <= SLEEP_SPEED_SQ {
            let next_penetration = g_z - (motion[2] - ground_offset);
            if is_in_contact(next_penetration)
                && next_penetration <= SLEEP_GROUND_PENETRATION_EPS
            {
                sleep_ticks += 1.0;
                if sleep_ticks >= SLEEP_TICKS {
                    p.pos_z[slot] = g_z + ground_offset;
                    p.vel_x[slot] = 0.0;
                    p.vel_y[slot] = 0.0;
                    p.vel_z[slot] = 0.0;
                    sleep_ticks = SLEEP_TICKS;
                    p.flags[slot] |= BODY_FLAG_SLEEPING;
                    just_slept = true;
                }
            } else {
                sleep_ticks = 0.0;
            }
        } else {
            sleep_ticks = 0.0;
        }
        p.sleep_ticks[slot] = sleep_ticks;
        if just_slept {
            sleep_transitions_out[transitions as usize] = slot_u32;
            transitions += 1;
        }
    }
    transitions
}

#[wasm_bindgen]
pub fn pool_resolve_sphere_sphere(
    sphere_slots: &[u32],
    iterations: u32,
    cell_size: f64,
    wake_transitions_out: &mut [u32],
) -> u32 {
    let count = sphere_slots.len();
    debug_assert!(wake_transitions_out.len() >= count);
    if count == 0 || iterations == 0 || cell_size <= 0.0 {
        return 0;
    }

    let p = pool();
    let half_cs = cell_size * 0.5;

    // Bucket bodies by center cell; reused across all sub-iterations
    // — same as PhysicsEngine3D.rebuildContactCells / Phase 3c.
    let mut cells: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut max_radius = 0.0_f64;
    for i in 0..count {
        let slot = sphere_slots[i] as usize;
        let x = p.pos_x[slot];
        let y = p.pos_y[slot];
        let z = p.pos_z[slot];
        let r = p.radius[slot];
        if r > max_radius {
            max_radius = r;
        }
        let cx = (x / cell_size).floor() as i32;
        let cy = (y / cell_size).floor() as i32;
        let cz = ((z + half_cs) / cell_size).floor() as i32;
        let key = pack_contact_cell_key(cx, cy, cz);
        cells.entry(key).or_default().push(i as u32);
    }
    let range = (((max_radius * 2.0) / cell_size).ceil() as i32).max(1);

    // Track "got pushed" per local index so JS can fire wakeBody on
    // exactly the bodies whose state flipped.
    let mut woke = vec![false; count];

    for _iter in 0..iterations {
        for i in 0..count {
            let slot_a = sphere_slots[i] as usize;
            let ar = p.radius[slot_a];
            let a_inv_mass = p.inv_mass[slot_a];
            let a_restitution = p.restitution[slot_a];

            let acx = (p.pos_x[slot_a] / cell_size).floor() as i32;
            let acy = (p.pos_y[slot_a] / cell_size).floor() as i32;
            let acz = ((p.pos_z[slot_a] + half_cs) / cell_size).floor() as i32;

            for dz in -range..=range {
                for dy in -range..=range {
                    for dx in -range..=range {
                        let key = pack_contact_cell_key(acx + dx, acy + dy, acz + dz);
                        let bucket = match cells.get(&key) {
                            Some(b) => b,
                            None => continue,
                        };
                        for &j_u32 in bucket.iter() {
                            let j = j_u32 as usize;
                            if j <= i {
                                continue;
                            }
                            let slot_b = sphere_slots[j] as usize;
                            let br = p.radius[slot_b];

                            let ax = p.pos_x[slot_a];
                            let ay = p.pos_y[slot_a];
                            let az = p.pos_z[slot_a];
                            let bx = p.pos_x[slot_b];
                            let by = p.pos_y[slot_b];
                            let bz = p.pos_z[slot_b];

                            let ddx = bx - ax;
                            let ddy = by - ay;
                            let ddz = bz - az;
                            let r_sum = ar + br;
                            let dist_sq = ddx * ddx + ddy * ddy + ddz * ddz;
                            if dist_sq >= r_sum * r_sum {
                                continue;
                            }

                            woke[i] = true;
                            woke[j] = true;

                            let dist: f64;
                            let nx: f64;
                            let ny: f64;
                            let nz: f64;
                            if dist_sq < 1e-12 {
                                // Degenerate: deterministic random direction.
                                // Using slot ids (stable for body lifetime) as
                                // the seed source — slightly different from the
                                // Phase 3c buffer-based version (which used the
                                // entityId), but functionally equivalent for the
                                // tie-break case (centers exactly coincident).
                                let a_id = slot_a as u64;
                                let b_id = slot_b as u64;
                                let seed = (a_id
                                    .wrapping_mul(73856093)
                                    ^ b_id.wrapping_mul(19349663))
                                    as u32;
                                let angle =
                                    (seed as f64 / 4294967296.0) * core::f64::consts::PI * 2.0;
                                dist = 1e-6;
                                nx = angle.cos();
                                ny = angle.sin();
                                nz = 0.0;
                            } else {
                                dist = dist_sq.sqrt();
                                let inv_dist = 1.0 / dist;
                                nx = ddx * inv_dist;
                                ny = ddy * inv_dist;
                                nz = ddz * inv_dist;
                            }
                            let penetration = r_sum - dist;
                            let b_inv_mass = p.inv_mass[slot_b];
                            let inv_mass_sum_inv = 1.0 / (a_inv_mass + b_inv_mass);
                            let w_a = a_inv_mass * inv_mass_sum_inv;
                            let w_b = b_inv_mass * inv_mass_sum_inv;
                            p.pos_x[slot_a] = ax - nx * penetration * w_a;
                            p.pos_y[slot_a] = ay - ny * penetration * w_a;
                            p.pos_z[slot_a] = az - nz * penetration * w_a;
                            p.pos_x[slot_b] = bx + nx * penetration * w_b;
                            p.pos_y[slot_b] = by + ny * penetration * w_b;
                            p.pos_z[slot_b] = bz + nz * penetration * w_b;

                            // Upward contact flag — set directly in pool;
                            // JS reads via the body.upwardSurfaceContact getter.
                            if nz > 0.35 {
                                p.flags[slot_b] |= BODY_FLAG_UPWARD_CONTACT;
                            } else if nz < -0.35 {
                                p.flags[slot_a] |= BODY_FLAG_UPWARD_CONTACT;
                            }

                            let a_vx = p.vel_x[slot_a];
                            let a_vy = p.vel_y[slot_a];
                            let a_vz = p.vel_z[slot_a];
                            let b_vx = p.vel_x[slot_b];
                            let b_vy = p.vel_y[slot_b];
                            let b_vz = p.vel_z[slot_b];
                            let rvx = b_vx - a_vx;
                            let rvy = b_vy - a_vy;
                            let rvz = b_vz - a_vz;
                            let v_dot_n = rvx * nx + rvy * ny + rvz * nz;
                            if v_dot_n >= 0.0 {
                                continue;
                            }
                            let b_restitution = p.restitution[slot_b];
                            let e = a_restitution.min(b_restitution);
                            let j_mag = -(1.0 + e) * v_dot_n * inv_mass_sum_inv;
                            let ix = j_mag * nx;
                            let iy = j_mag * ny;
                            let iz = j_mag * nz;
                            p.vel_x[slot_a] = a_vx - ix * a_inv_mass;
                            p.vel_y[slot_a] = a_vy - iy * a_inv_mass;
                            p.vel_z[slot_a] = a_vz - iz * a_inv_mass;
                            p.vel_x[slot_b] = b_vx + ix * b_inv_mass;
                            p.vel_y[slot_b] = b_vy + iy * b_inv_mass;
                            p.vel_z[slot_b] = b_vz + iz * b_inv_mass;
                        }
                    }
                }
            }
        }
    }

    let mut transitions = 0_u32;
    for i in 0..count {
        if woke[i] {
            wake_transitions_out[transitions as usize] = sphere_slots[i];
            transitions += 1;
        }
    }
    transitions
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3b — Pool-backed sphere-vs-cuboid pair resolver
//
//  Ports PhysicsEngine3D.ts `resolveSphereCuboidPair` into a single
//  batched WASM call. JS's existing broadphase (the `staticCells`
//  Map keyed by AABB cell) iterates per dynamic sphere, does the
//  ignoreStatic + staticQueryStamp dedup, and accumulates a flat
//  pair list (dyn_slot, static_slot interleaved). One WASM call
//  resolves every pair; both bodies' state lives in the BodyPool
//  so nothing else crosses the boundary.
//
//  Sleep-wake rule mirrors the TS path: every pair that pushes a
//  dynamic body emits a wake transition. JS calls wakeBody() on
//  each — idempotent on already-awake bodies, so the wake-count
//  bookkeeping is correct regardless of duplicates from a single
//  dyn body that hits multiple cuboids in one tick.
//
//  Upward contact: BODY_FLAG_UPWARD_CONTACT set directly on the
//  dyn body's pool flags byte when contact normal nz > 0.35.
// ─────────────────────────────────────────────────────────────────

/// Internal sphere-vs-cuboid pair resolver (single pair). Reads
/// dyn body geometry + cuboid extents from the pool, mutates dyn
/// pos/vel/flags in place. Returns true iff the pair overlapped
/// (so the caller can mark a wake transition / set upward-contact).
#[inline]
fn resolve_sphere_cuboid_pair_in_pool(p: &mut BodyPool, dyn_slot: usize, st_slot: usize) -> bool {
    let dyn_x = p.pos_x[dyn_slot];
    let dyn_y = p.pos_y[dyn_slot];
    let dyn_z = p.pos_z[dyn_slot];
    let dyn_r = p.radius[dyn_slot];
    let st_x = p.pos_x[st_slot];
    let st_y = p.pos_y[st_slot];
    let st_z = p.pos_z[st_slot];
    let st_hx = p.half_x[st_slot];
    let st_hy = p.half_y[st_slot];
    let st_hz = p.half_z[st_slot];

    let dx = dyn_x - st_x;
    let dy = dyn_y - st_y;
    let dz = dyn_z - st_z;
    let cx = dx.max(-st_hx).min(st_hx);
    let cy = dy.max(-st_hy).min(st_hy);
    let cz = dz.max(-st_hz).min(st_hz);
    let sep_x = dx - cx;
    let sep_y = dy - cy;
    let sep_z = dz - cz;
    let dist_sq = sep_x * sep_x + sep_y * sep_y + sep_z * sep_z;
    if dist_sq >= dyn_r * dyn_r {
        return false;
    }
    let dist = dist_sq.sqrt();

    let nx: f64;
    let ny: f64;
    let nz: f64;
    let penetration: f64;
    if dist < 1e-6 {
        let over_x = st_hx - dx.abs();
        let over_y = st_hy - dy.abs();
        let over_z = st_hz - dz.abs();
        if over_x <= over_y && over_x <= over_z {
            nx = if dx >= 0.0 { 1.0 } else { -1.0 };
            ny = 0.0;
            nz = 0.0;
            penetration = over_x + dyn_r;
        } else if over_y <= over_z {
            nx = 0.0;
            ny = if dy >= 0.0 { 1.0 } else { -1.0 };
            nz = 0.0;
            penetration = over_y + dyn_r;
        } else {
            nx = 0.0;
            ny = 0.0;
            nz = if dz >= 0.0 { 1.0 } else { -1.0 };
            penetration = over_z + dyn_r;
        }
    } else {
        let inv_dist = 1.0 / dist;
        nx = sep_x * inv_dist;
        ny = sep_y * inv_dist;
        nz = sep_z * inv_dist;
        penetration = dyn_r - dist;
    }

    p.pos_x[dyn_slot] = dyn_x + nx * penetration;
    p.pos_y[dyn_slot] = dyn_y + ny * penetration;
    p.pos_z[dyn_slot] = dyn_z + nz * penetration;

    if nz > 0.35 {
        p.flags[dyn_slot] |= BODY_FLAG_UPWARD_CONTACT;
    }

    let dyn_vx = p.vel_x[dyn_slot];
    let dyn_vy = p.vel_y[dyn_slot];
    let dyn_vz = p.vel_z[dyn_slot];
    let v_dot_n = dyn_vx * nx + dyn_vy * ny + dyn_vz * nz;
    if v_dot_n < 0.0 {
        let restitution = p.restitution[dyn_slot];
        let j = (1.0 + restitution) * v_dot_n;
        p.vel_x[dyn_slot] = dyn_vx - j * nx;
        p.vel_y[dyn_slot] = dyn_vy - j * ny;
        p.vel_z[dyn_slot] = dyn_vz - j * nz;
    }
    true
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3f — Static cuboid broadphase in WASM linear memory
//
//  Per-engine state. The foreground game and the LobbyManager
//  background battle each construct their own PhysicsEngine3D in
//  the same JS context, so a shared global static-cell map would
//  conflate cuboids from both engines. Instead each engine creates
//  its own EngineStatics handle at construction time and uses it
//  for every static_add / static_remove / resolve call.
//
//  EngineStatics holds:
//    - cells: HashMap<packed_cell_key, Vec<slot_id>>
//    - visit_stamps: per-slot u32 marker for per-query dedup (a
//      static body that spans multiple cells gets visited from
//      every overlapping cell in a sphere's query window — without
//      dedup we'd run the resolver math against the same pair
//      multiple times in one tick).
// ─────────────────────────────────────────────────────────────────

struct EngineStatics {
    cells: HashMap<u64, Vec<u32>>,
    visit_stamps: Vec<u32>,
    next_stamp: u32,
}

impl EngineStatics {
    fn new() -> Self {
        Self {
            cells: HashMap::new(),
            visit_stamps: vec![0u32; POOL_CAPACITY_USIZE],
            next_stamp: 0,
        }
    }
}

struct EngineStaticsTable {
    handles: Vec<Option<EngineStatics>>,
    free_list: Vec<u32>,
}

struct EngineStaticsHolder(UnsafeCell<EngineStaticsTable>);
unsafe impl Sync for EngineStaticsHolder {}
static ENGINE_STATICS: EngineStaticsHolder = EngineStaticsHolder(UnsafeCell::new(EngineStaticsTable {
    handles: Vec::new(),
    free_list: Vec::new(),
}));

#[inline]
fn engine_statics(handle: u32) -> &'static mut EngineStatics {
    // SAFETY: WASM is single-threaded; only one Rust call active at a
    // time, so no aliasing &mut refs ever co-exist. The `handles` Vec
    // never shrinks (destroy nulls the slot but keeps the index live),
    // so the address backing a `Some(_)` stays stable for the slot's
    // lifetime.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        v.handles[handle as usize]
            .as_mut()
            .expect("engine_statics: handle was destroyed")
    }
}

#[inline]
fn cell_xy(v: f64, cs: f64) -> i32 {
    (v / cs).floor() as i32
}

#[inline]
fn cell_z_with_bias(v: f64, cs: f64) -> i32 {
    ((v + cs * 0.5) / cs).floor() as i32
}

#[wasm_bindgen]
pub fn engine_statics_create() -> u32 {
    // SAFETY: see `engine_statics`.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        if let Some(handle) = v.free_list.pop() {
            v.handles[handle as usize] = Some(EngineStatics::new());
            handle
        } else {
            let handle = v.handles.len() as u32;
            v.handles.push(Some(EngineStatics::new()));
            handle
        }
    }
}

/// Release a handle previously returned by `engine_statics_create`.
/// Drops the underlying HashMap + visit_stamps Vec and returns the
/// slot to a free list so the next create() can recycle it. Calling
/// destroy twice on the same handle, or using a destroyed handle
/// afterwards, will panic (caught by the .expect() in
/// `engine_statics`).
#[wasm_bindgen]
pub fn engine_statics_destroy(handle: u32) {
    // SAFETY: see `engine_statics`.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        let idx = handle as usize;
        debug_assert!(idx < v.handles.len(), "engine_statics_destroy: handle out of range");
        debug_assert!(v.handles[idx].is_some(), "engine_statics_destroy: handle already destroyed");
        v.handles[idx] = None;
        v.free_list.push(handle);
    }
}

#[wasm_bindgen]
pub fn engine_statics_add(handle: u32, slot: u32, cell_size: f64) {
    let p = pool();
    let s = engine_statics(handle);
    let slot_usize = slot as usize;
    let x = p.pos_x[slot_usize];
    let y = p.pos_y[slot_usize];
    let z = p.pos_z[slot_usize];
    let hx = p.half_x[slot_usize];
    let hy = p.half_y[slot_usize];
    let hz = p.half_z[slot_usize];
    let min_cx = cell_xy(x - hx, cell_size);
    let max_cx = cell_xy(x + hx, cell_size);
    let min_cy = cell_xy(y - hy, cell_size);
    let max_cy = cell_xy(y + hy, cell_size);
    let min_cz = cell_z_with_bias(z - hz, cell_size);
    let max_cz = cell_z_with_bias(z + hz, cell_size);
    for cz in min_cz..=max_cz {
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = pack_contact_cell_key(cx, cy, cz);
                s.cells.entry(key).or_default().push(slot);
            }
        }
    }
}

#[wasm_bindgen]
pub fn engine_statics_remove(handle: u32, slot: u32, cell_size: f64) {
    let p = pool();
    let s = engine_statics(handle);
    let slot_usize = slot as usize;
    let x = p.pos_x[slot_usize];
    let y = p.pos_y[slot_usize];
    let z = p.pos_z[slot_usize];
    let hx = p.half_x[slot_usize];
    let hy = p.half_y[slot_usize];
    let hz = p.half_z[slot_usize];
    let min_cx = cell_xy(x - hx, cell_size);
    let max_cx = cell_xy(x + hx, cell_size);
    let min_cy = cell_xy(y - hy, cell_size);
    let max_cy = cell_xy(y + hy, cell_size);
    let min_cz = cell_z_with_bias(z - hz, cell_size);
    let max_cz = cell_z_with_bias(z + hz, cell_size);
    for cz in min_cz..=max_cz {
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = s.cells.get_mut(&key) {
                    if let Some(pos) = bucket.iter().position(|&v| v == slot) {
                        bucket.swap_remove(pos);
                    }
                    if bucket.is_empty() {
                        s.cells.remove(&key);
                    }
                }
            }
        }
    }
}

/// Phase 3f unified broadphase + sphere-cuboid resolver. JS hands
/// over a flat list of dynamic sphere slots to test, plus a parallel
/// `ignored_static_slots` array (u32::MAX = no ignore for this dyn).
/// Rust walks each dyn body's overlapping cells, dedups via the
/// per-static visit-stamp counter, runs the per-pair resolver in
/// place. wake_transitions_out is filled with slot ids of dyn
/// bodies that got pushed (one entry per dyn that hit any cuboid).
#[wasm_bindgen]
pub fn pool_resolve_sphere_cuboid_full(
    handle: u32,
    dyn_slots: &[u32],
    ignored_static_slots: &[u32],
    cell_size: f64,
    wake_transitions_out: &mut [u32],
) -> u32 {
    debug_assert_eq!(dyn_slots.len(), ignored_static_slots.len());
    debug_assert!(wake_transitions_out.len() >= dyn_slots.len());
    if dyn_slots.is_empty() || cell_size <= 0.0 {
        return 0;
    }

    let p = pool();
    let s = engine_statics(handle);
    let mut wake_count = 0_u32;

    for i in 0..dyn_slots.len() {
        let dyn_slot_u32 = dyn_slots[i];
        let dyn_slot = dyn_slot_u32 as usize;
        let ignored = ignored_static_slots[i];

        let dyn_x = p.pos_x[dyn_slot];
        let dyn_y = p.pos_y[dyn_slot];
        let dyn_z = p.pos_z[dyn_slot];
        let dyn_r = p.radius[dyn_slot];

        let min_cx = cell_xy(dyn_x - dyn_r, cell_size);
        let max_cx = cell_xy(dyn_x + dyn_r, cell_size);
        let min_cy = cell_xy(dyn_y - dyn_r, cell_size);
        let max_cy = cell_xy(dyn_y + dyn_r, cell_size);
        let min_cz = cell_z_with_bias(dyn_z - dyn_r, cell_size);
        let max_cz = cell_z_with_bias(dyn_z + dyn_r, cell_size);

        // Bump the per-static visit stamp for this dyn body's query;
        // wrapping_add handles the (vanishingly unlikely) u32 overflow
        // — old visit_stamps will just look stale across the rollover.
        s.next_stamp = s.next_stamp.wrapping_add(1);
        let stamp = s.next_stamp;
        let mut hit = false;

        for cz in min_cz..=max_cz {
            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    let key = pack_contact_cell_key(cx, cy, cz);
                    let bucket = match s.cells.get(&key) {
                        Some(b) => b,
                        None => continue,
                    };
                    for &st_slot_u32 in bucket.iter() {
                        let st_slot = st_slot_u32 as usize;
                        if s.visit_stamps[st_slot] == stamp {
                            continue;
                        }
                        s.visit_stamps[st_slot] = stamp;
                        if st_slot_u32 == ignored {
                            continue;
                        }
                        if resolve_sphere_cuboid_pair_in_pool(p, dyn_slot, st_slot) {
                            hit = true;
                        }
                    }
                }
            }
        }

        if hit {
            wake_transitions_out[wake_count as usize] = dyn_slot_u32;
            wake_count += 1;
        }
    }

    wake_count
}

// ─────────────────────────────────────────────────────────────────
//  Phase 4 — Quaternion math primitives
//
//  Mirrors src/game/math/Quaternion.ts. Convention: unit quats
//  stored as (x, y, z, w) where w is the scalar part. Identity is
//  (0, 0, 0, 1). Yaw is rotation about world +Z, ZYX intrinsic
//  Euler order — same as the TS module.
//
//  These are private fn helpers (no #[wasm_bindgen]) consumed by
//  the batched kernel below. Bit-identical to the TS path on
//  finite inputs.
// ─────────────────────────────────────────────────────────────────

#[inline]
fn quat_normalize_inplace(q: &mut [f64; 4]) {
    let m2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if m2 <= 1e-20 {
        q[0] = 0.0;
        q[1] = 0.0;
        q[2] = 0.0;
        q[3] = 1.0;
        return;
    }
    let inv = 1.0 / m2.sqrt();
    q[0] *= inv;
    q[1] *= inv;
    q[2] *= inv;
    q[3] *= inv;
}

#[inline]
fn quat_from_yaw_pitch_roll(yaw: f64, pitch: f64, roll: f64) -> [f64; 4] {
    let cy = (yaw * 0.5).cos();
    let sy = (yaw * 0.5).sin();
    let cp = (pitch * 0.5).cos();
    let sp = (pitch * 0.5).sin();
    let cr = (roll * 0.5).cos();
    let sr = (roll * 0.5).sin();
    [
        cy * cp * sr - sy * sp * cr,
        sy * cp * sr + cy * sp * cr,
        sy * cp * cr - cy * sp * sr,
        cy * cp * cr + sy * sp * sr,
    ]
}

/// Returns (axis · angle) of the shortest-path rotation from
/// `current` to `target`. Mirrors quatShortestAxisAngle in TS:
/// computes Δq = target · conjugate(current), flips to shortest
/// hemisphere if w<0, then expands axis · angle via the small-
/// angle-safe scale factor `angle / sin(angle/2)`.
#[inline]
fn quat_shortest_axis_angle(current: [f64; 4], target: [f64; 4]) -> [f64; 3] {
    let cx = -current[0];
    let cy = -current[1];
    let cz = -current[2];
    let cw = current[3];
    let tx = target[0];
    let ty = target[1];
    let tz = target[2];
    let tw = target[3];
    let mut dx = tw * cx + tx * cw + ty * cz - tz * cy;
    let mut dy = tw * cy - tx * cz + ty * cw + tz * cx;
    let mut dz = tw * cz + tx * cy - ty * cx + tz * cw;
    let mut dw = tw * cw - tx * cx - ty * cy - tz * cz;
    if dw < 0.0 {
        dx = -dx;
        dy = -dy;
        dz = -dz;
        dw = -dw;
    }
    let sin2 = dx * dx + dy * dy + dz * dz;
    let sin_half = sin2.sqrt();
    let scale = if sin_half < 1e-7 {
        // Small-angle: angle ≈ 2·sin_half, so angle/sin_half ≈ 2.
        2.0
    } else {
        let angle = 2.0 * sin_half.atan2(dw);
        angle / sin_half
    };
    [dx * scale, dy * scale, dz * scale]
}

/// Integrate `q ← q ⊕ (ω · dt)` via the small-step quaternion
/// derivative `dq = 0.5 · ω·q · dt`, then renormalize. Mirrors
/// quatIntegrate. ω is in the world frame.
#[inline]
fn quat_integrate_inplace(q: &mut [f64; 4], omega: [f64; 3], dt_sec: f64) {
    let half_dt = 0.5 * dt_sec;
    let ox = omega[0] * half_dt;
    let oy = omega[1] * half_dt;
    let oz = omega[2] * half_dt;
    let qx = q[0];
    let qy = q[1];
    let qz = q[2];
    let qw = q[3];
    q[0] = qx + (ox * qw + oy * qz - oz * qy);
    q[1] = qy + (-ox * qz + oy * qw + oz * qx);
    q[2] = qz + (ox * qy - oy * qx + oz * qw);
    q[3] = qw + (-ox * qx - oy * qy - oz * qz);
    quat_normalize_inplace(q);
}

/// Yaw extraction from a unit quaternion (rotation about world +Z).
/// Mirrors quatYaw — kept here so the batched kernel can sync the
/// post-integrate yaw into the output buffer for JS consumers
/// (turret mount, network code, transform.rotation) that still
/// only want the scalar.
#[inline]
fn quat_yaw(q: [f64; 4]) -> f64 {
    let siny_cosp = 2.0 * (q[3] * q[2] + q[0] * q[1]);
    let cosy_cosp = 1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]);
    siny_cosp.atan2(cosy_cosp)
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3e — Batched hover orientation kernel
//
//  Replaces the per-entity quatFromYawPitchRoll + quatDampedSpringStep
//  + quatYaw chain in UnitForceSystem.ts (hover branch). One WASM
//  call processes every hover entity this tick.
//
//  Buffer layout per entity (QUAT_HOVER_BATCH_STRIDE = 14 f64s):
//    0..4   orientation (x, y, z, w)             in/out
//    4..7   omega (x, y, z)                      in/out
//    7..10  target_yaw, target_pitch, target_roll  in
//    10..13 alpha (x, y, z)                      out
//    13     yaw extracted from new orientation   out
//
//  Caller responsibility: build target_yaw/pitch/roll JS-side from
//  thrust direction + body-frame velocity (as the existing TS code
//  does). Read alpha into entity.unit.angularAcceleration3, write
//  yaw into entity.transform.rotation, push snapshot dirty.
// ─────────────────────────────────────────────────────────────────

pub const QUAT_HOVER_BATCH_STRIDE: usize = 14;

#[wasm_bindgen]
pub fn quat_hover_orientation_step_batch(
    buf: &mut [f64],
    count: usize,
    k: f64,
    c: f64,
    dt_sec: f64,
) {
    debug_assert!(buf.len() >= count * QUAT_HOVER_BATCH_STRIDE);
    for i in 0..count {
        let base = i * QUAT_HOVER_BATCH_STRIDE;
        let mut orientation = [
            buf[base],
            buf[base + 1],
            buf[base + 2],
            buf[base + 3],
        ];
        let mut omega = [
            buf[base + 4],
            buf[base + 5],
            buf[base + 6],
        ];
        let target_yaw = buf[base + 7];
        let target_pitch = buf[base + 8];
        let target_roll = buf[base + 9];

        let target = quat_from_yaw_pitch_roll(target_yaw, target_pitch, target_roll);

        // Spring law: α = k · (axis·angle) − c · ω.
        let axis_angle = quat_shortest_axis_angle(orientation, target);
        let alpha_x = axis_angle[0] * k - omega[0] * c;
        let alpha_y = axis_angle[1] * k - omega[1] * c;
        let alpha_z = axis_angle[2] * k - omega[2] * c;
        omega[0] += alpha_x * dt_sec;
        omega[1] += alpha_y * dt_sec;
        omega[2] += alpha_z * dt_sec;
        quat_integrate_inplace(&mut orientation, omega, dt_sec);

        buf[base] = orientation[0];
        buf[base + 1] = orientation[1];
        buf[base + 2] = orientation[2];
        buf[base + 3] = orientation[3];
        buf[base + 4] = omega[0];
        buf[base + 5] = omega[1];
        buf[base + 6] = omega[2];
        buf[base + 10] = alpha_x;
        buf[base + 11] = alpha_y;
        buf[base + 12] = alpha_z;
        buf[base + 13] = quat_yaw(orientation);
    }
}

// ─────────────────────────────────────────────────────────────────
//  Phase 5a — Packed projectile SoA pool in WASM linear memory
//
//  Mirrors the dense parallel arrays projectileSystem.ts already
//  maintains for projectiles eligible for the "packed" fast path
//  (no homing, single-hit, ballistic). Slots are JS-managed via
//  swap-remove on unregister; Rust just owns the storage and runs
//  the per-tick ballistic integrate kernel.
//
//  Single pool (not per-engine). Background battles don't fire
//  projectiles in current scope so multi-engine isolation isn't
//  needed today; if/when that changes the engine-handle pattern
//  from EngineStatics is the migration path.
//
//  Capacity is fixed at PROJECTILE_POOL_CAPACITY so the typed-
//  array views JS holds stay valid (no Vec realloc → no view
//  detachment from memory.grow). 8192 covers steady-state busy
//  combat well; allocator pre-grow at initSimWasm sizes the
//  WASM linear memory comfortably above this.
// ─────────────────────────────────────────────────────────────────

pub const PROJECTILE_POOL_CAPACITY: u32 = 8192;
const PROJECTILE_POOL_CAPACITY_USIZE: usize = PROJECTILE_POOL_CAPACITY as usize;

struct ProjectilePool {
    pos_x: Vec<f64>,
    pos_y: Vec<f64>,
    pos_z: Vec<f64>,
    vel_x: Vec<f64>,
    vel_y: Vec<f64>,
    vel_z: Vec<f64>,
    time_alive: Vec<f64>,
    has_gravity: Vec<u8>,
}

impl ProjectilePool {
    fn new() -> Self {
        let cap = PROJECTILE_POOL_CAPACITY_USIZE;
        Self {
            pos_x: vec![0.0; cap],
            pos_y: vec![0.0; cap],
            pos_z: vec![0.0; cap],
            vel_x: vec![0.0; cap],
            vel_y: vec![0.0; cap],
            vel_z: vec![0.0; cap],
            time_alive: vec![0.0; cap],
            has_gravity: vec![0u8; cap],
        }
    }
}

struct ProjectilePoolHolder(UnsafeCell<Option<ProjectilePool>>);
unsafe impl Sync for ProjectilePoolHolder {}
static PROJECTILE_POOL: ProjectilePoolHolder = ProjectilePoolHolder(UnsafeCell::new(None));

#[inline]
fn projectile_pool() -> &'static mut ProjectilePool {
    // SAFETY: WASM is single-threaded; pool_init() is the unique
    // initialiser. Consumers must call projectile_pool_init() before
    // any pool access.
    unsafe {
        (*PROJECTILE_POOL.0.get())
            .as_mut()
            .expect("projectile_pool_init() not called before access")
    }
}

#[wasm_bindgen]
pub fn projectile_pool_init() {
    unsafe {
        let cell = PROJECTILE_POOL.0.get();
        if (*cell).is_none() {
            *cell = Some(ProjectilePool::new());
        }
    }
}

#[wasm_bindgen]
pub fn projectile_pool_capacity() -> u32 {
    PROJECTILE_POOL_CAPACITY
}

macro_rules! projectile_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            projectile_pool().$field.as_ptr()
        }
    };
}

projectile_pool_ptr_export!(projectile_pool_pos_x_ptr, pos_x, f64);
projectile_pool_ptr_export!(projectile_pool_pos_y_ptr, pos_y, f64);
projectile_pool_ptr_export!(projectile_pool_pos_z_ptr, pos_z, f64);
projectile_pool_ptr_export!(projectile_pool_vel_x_ptr, vel_x, f64);
projectile_pool_ptr_export!(projectile_pool_vel_y_ptr, vel_y, f64);
projectile_pool_ptr_export!(projectile_pool_vel_z_ptr, vel_z, f64);
projectile_pool_ptr_export!(projectile_pool_time_alive_ptr, time_alive, f64);
projectile_pool_ptr_export!(projectile_pool_has_gravity_ptr, has_gravity, u8);

// ─────────────────────────────────────────────────────────────────
//  Phase 5b — Kinematic intercept solver
//
//  Mirrors src/game/math/Ballistics.ts solveKinematicIntercept.
//  Sample-and-bisect search for the time t at which a projectile
//  launched from `origin` at constant speed `projectile_speed`
//  would intercept `target` (both are full kinematic states with
//  position + velocity + acceleration). Bit-identical to the TS
//  path — same constants, same evaluation count, same epsilon.
//
//  Used per-tick by:
//    - server homing projectiles (projectileSystem)
//    - server turret aim (aimSolver)
//    - client homing prediction (ClientProjectilePrediction)
//    - render-time range envelope (ProjectileRangeEnvelope3D)
//
//  Input buffer layout (22 f64s — caller fills a module-scope
//  scratch and passes by reference):
//    0..3   origin.position                  (x, y, z)
//    3..6   origin.velocity
//    6..9   origin.acceleration
//    9..12  target.position
//    12..15 target.velocity
//    15..18 target.acceleration
//    18..21 projectile_acceleration
//    21     projectile_speed
//
//  Output buffer (7 f64s):
//    0      time
//    1..4   aim_point
//    4..7   launch_velocity
//
//  Returns 1 if a solution was found and out_buf was written, 0
//  otherwise (out_buf untouched).
// ─────────────────────────────────────────────────────────────────

const INTERCEPT_SAMPLE_COUNT: usize = 64;
const INTERCEPT_BISECT_STEPS: usize = 14;
const INTERCEPT_MIN_TIME: f64 = 1.0 / 120.0;
const INTERCEPT_MAX_TIME_DEFAULT: f64 = 30.0;
const INTERCEPT_ROOT_EPSILON: f64 = 1e-5;

#[inline]
fn intercept_input_finite(input: &[f64; 22]) -> bool {
    // All 22 fields finite; speed must be > 1e-6.
    for v in input.iter() {
        if !v.is_finite() {
            return false;
        }
    }
    input[21] > 1e-6
}

#[inline]
fn intercept_clamp_time(t: f64) -> f64 {
    t.max(INTERCEPT_MIN_TIME).min(INTERCEPT_MAX_TIME_DEFAULT)
}

#[inline]
fn intercept_default_max_time(input: &[f64; 22]) -> f64 {
    let dx = input[9] - input[0];
    let dy = input[10] - input[1];
    let dz = input[11] - input[2];
    let dist = (dx * dx + dy * dy + dz * dz).sqrt();
    let speed = input[21];
    let base_time = if speed > 1e-6 { dist / speed } else { 0.0 };
    let rel_ax = input[15] - input[18];
    let rel_ay = input[16] - input[19];
    let rel_az = input[17] - input[20];
    let rel_accel = (rel_ax * rel_ax + rel_ay * rel_ay + rel_az * rel_az).sqrt();
    let accel_time = if rel_accel > 1e-6 {
        2.0 * speed / rel_accel
    } else {
        0.0
    };
    intercept_clamp_time((2.0_f64).max(base_time * 8.0 + 4.0).max(accel_time * 2.0 + 1.0))
}

#[inline]
fn intercept_function(input: &[f64; 22], t: f64) -> f64 {
    let rel_x = input[9] - input[0]
        + (input[12] - input[3]) * t
        + 0.5 * (input[15] - input[18]) * t * t;
    let rel_y = input[10] - input[1]
        + (input[13] - input[4]) * t
        + 0.5 * (input[16] - input[19]) * t * t;
    let rel_z = input[11] - input[2]
        + (input[14] - input[5]) * t
        + 0.5 * (input[17] - input[20]) * t * t;
    (rel_x * rel_x + rel_y * rel_y + rel_z * rel_z).sqrt() - input[21] * t
}

#[inline]
fn intercept_bisect_root(input: &[f64; 22], lo_t: f64, hi_t: f64) -> f64 {
    let mut lo = lo_t;
    let mut hi = hi_t;
    let mut lo_f = intercept_function(input, lo);
    for _ in 0..INTERCEPT_BISECT_STEPS {
        let mid = (lo + hi) * 0.5;
        let mid_f = intercept_function(input, mid);
        if mid_f.abs() <= INTERCEPT_ROOT_EPSILON {
            return mid;
        }
        if (lo_f <= 0.0 && mid_f <= 0.0) || (lo_f >= 0.0 && mid_f >= 0.0) {
            lo = mid;
            lo_f = mid_f;
        } else {
            hi = mid;
        }
    }
    (lo + hi) * 0.5
}

#[wasm_bindgen]
pub fn solve_kinematic_intercept(
    input: &[f64],
    out_buf: &mut [f64],
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
) -> u32 {
    debug_assert!(input.len() >= 22, "intercept input buffer too small");
    debug_assert!(out_buf.len() >= 7, "intercept output buffer too small");
    let inp: &[f64; 22] = (&input[0..22]).try_into().unwrap();
    if !intercept_input_finite(inp) {
        return 0;
    }
    let max_time = if max_time_sec_or_zero > 0.0 && max_time_sec_or_zero.is_finite() {
        intercept_clamp_time(max_time_sec_or_zero)
    } else {
        intercept_default_max_time(inp)
    };

    let mut selected_root = 0.0_f64;
    let mut prev_t = 0.0_f64;
    let mut prev_f = intercept_function(inp, prev_t);
    let want_late = prefer_late_solution != 0;

    for i in 1..=INTERCEPT_SAMPLE_COUNT {
        let t = (max_time * (i as f64)) / (INTERCEPT_SAMPLE_COUNT as f64);
        let f = intercept_function(inp, t);
        let mut root = 0.0_f64;
        if f.abs() <= INTERCEPT_ROOT_EPSILON {
            root = t;
        } else if (prev_f > 0.0 && f < 0.0) || (prev_f < 0.0 && f > 0.0) {
            root = intercept_bisect_root(inp, prev_t, t);
        }
        if root > 0.0 {
            selected_root = root;
            if !want_late {
                break;
            }
        }
        prev_t = t;
        prev_f = f;
    }

    if selected_root <= INTERCEPT_MIN_TIME {
        return 0;
    }

    // Write solution. Aim point = target's position at intercept time.
    let t = selected_root;
    let aim_x = inp[9] + inp[12] * t + 0.5 * inp[15] * t * t;
    let aim_y = inp[10] + inp[13] * t + 0.5 * inp[16] * t * t;
    let aim_z = inp[11] + inp[14] * t + 0.5 * inp[17] * t * t;

    // Origin at intercept time + projectile-relative acceleration → launch velocity.
    let origin_at_t_x = inp[0] + inp[3] * t + 0.5 * inp[6] * t * t;
    let origin_at_t_y = inp[1] + inp[4] * t + 0.5 * inp[7] * t * t;
    let origin_at_t_z = inp[2] + inp[5] * t + 0.5 * inp[8] * t * t;
    let proj_rel_ax = inp[18] - inp[6];
    let proj_rel_ay = inp[19] - inp[7];
    let proj_rel_az = inp[20] - inp[8];
    let inv_t = 1.0 / t;
    let lv_x = (aim_x - origin_at_t_x - 0.5 * proj_rel_ax * t * t) * inv_t;
    let lv_y = (aim_y - origin_at_t_y - 0.5 * proj_rel_ay * t * t) * inv_t;
    let lv_z = (aim_z - origin_at_t_z - 0.5 * proj_rel_az * t * t) * inv_t;

    out_buf[0] = t;
    out_buf[1] = aim_x;
    out_buf[2] = aim_y;
    out_buf[3] = aim_z;
    out_buf[4] = lv_x;
    out_buf[5] = lv_y;
    out_buf[6] = lv_z;
    1
}

// ─────────────────────────────────────────────────────────────────
//  Phase 5c — Homing steering (Rodrigues rotation toward target)
//
//  Mirrors src/game/math/HomingSteering.ts applyHomingSteering.
//  Rotates a 3D velocity vector toward the line-to-target by at
//  most homingTurnRate · dt radians this tick, preserving speed.
//  Output buffer (4 f64s): velX, velY, velZ, rotation (yaw).
//
//  Used per-homing-projectile per-tick by both the server
//  projectile system and the client prediction stepper. Per-call
//  WASM dispatch — call sites already loop over projectiles
//  individually, batching would require a substantial caller
//  refactor.
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn apply_homing_steering(
    out_buf: &mut [f64],
    vel_x: f64, vel_y: f64, vel_z: f64,
    target_x: f64, target_y: f64, target_z: f64,
    current_x: f64, current_y: f64, current_z: f64,
    homing_turn_rate: f64,
    dt_sec: f64,
) {
    debug_assert!(out_buf.len() >= 4);
    let speed = (vel_x * vel_x + vel_y * vel_y + vel_z * vel_z).sqrt();
    out_buf[0] = vel_x;
    out_buf[1] = vel_y;
    out_buf[2] = vel_z;
    out_buf[3] = vel_y.atan2(vel_x);

    if speed < 1e-6 {
        return;
    }
    let dx = target_x - current_x;
    let dy = target_y - current_y;
    let dz = target_z - current_z;
    let d_mag = (dx * dx + dy * dy + dz * dz).sqrt();
    if d_mag < 1e-6 {
        return;
    }

    let inv_speed = 1.0 / speed;
    let inv_d_mag = 1.0 / d_mag;
    let vxn = vel_x * inv_speed;
    let vyn = vel_y * inv_speed;
    let vzn = vel_z * inv_speed;
    let dxn = dx * inv_d_mag;
    // `dyn` is reserved in Rust — use `dyn_` for the y-direction unit.
    let dyn_ = dy * inv_d_mag;
    let dzn = dz * inv_d_mag;

    let mut cos_angle = vxn * dxn + vyn * dyn_ + vzn * dzn;
    if cos_angle > 1.0 {
        cos_angle = 1.0;
    } else if cos_angle < -1.0 {
        cos_angle = -1.0;
    }
    let angle = cos_angle.acos();
    let max_turn = homing_turn_rate * dt_sec;

    if angle <= max_turn {
        out_buf[0] = dxn * speed;
        out_buf[1] = dyn_ * speed;
        out_buf[2] = dzn * speed;
        out_buf[3] = (dyn_ * speed).atan2(dxn * speed);
        return;
    }

    // Rodrigues rotation around axis = v̂ × d̂ (or fallback if anti-parallel).
    let mut axis_x = vyn * dzn - vzn * dyn_;
    let mut axis_y = vzn * dxn - vxn * dzn;
    let mut axis_z = vxn * dyn_ - vyn * dxn;
    let axis_mag = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
    if axis_mag < 1e-6 {
        // v̂ and d̂ (anti-)parallel — pick a stable perpendicular.
        if vxn.abs() < 0.99 && vyn.abs() < 0.99 {
            axis_x = -vyn;
            axis_y = vxn;
            axis_z = 0.0;
        } else {
            axis_x = 0.0;
            axis_y = 0.0;
            axis_z = 1.0;
        }
        let mut fallback_mag = (axis_x * axis_x + axis_y * axis_y + axis_z * axis_z).sqrt();
        if fallback_mag == 0.0 {
            fallback_mag = 1.0;
        }
        let inv = 1.0 / fallback_mag;
        axis_x *= inv;
        axis_y *= inv;
        axis_z *= inv;
    } else {
        let inv = 1.0 / axis_mag;
        axis_x *= inv;
        axis_y *= inv;
        axis_z *= inv;
    }

    let cos_t = max_turn.cos();
    let sin_t = max_turn.sin();
    let one_minus_cos = 1.0 - cos_t;
    let k_dot_v = axis_x * vxn + axis_y * vyn + axis_z * vzn;
    let kxv_x = axis_y * vzn - axis_z * vyn;
    let kxv_y = axis_z * vxn - axis_x * vzn;
    let kxv_z = axis_x * vyn - axis_y * vxn;

    let rot_xn = vxn * cos_t + kxv_x * sin_t + axis_x * k_dot_v * one_minus_cos;
    let rot_yn = vyn * cos_t + kxv_y * sin_t + axis_y * k_dot_v * one_minus_cos;
    let rot_zn = vzn * cos_t + kxv_z * sin_t + axis_z * k_dot_v * one_minus_cos;

    out_buf[0] = rot_xn * speed;
    out_buf[1] = rot_yn * speed;
    out_buf[2] = rot_zn * speed;
    out_buf[3] = (rot_yn * speed).atan2(rot_xn * speed);
}

/// Per-tick ballistic integrator. For slots 0..count:
///   if has_gravity[i] != 0: vel_z[i] -= GRAVITY * dt_sec
///   pos_x[i] += vel_x[i] * dt_sec
///   pos_y[i] += vel_y[i] * dt_sec
///   pos_z[i] += vel_z[i] * dt_sec
/// Same math as the inner loop in projectileSystem._updatePackedProjectilesJS.
#[wasm_bindgen]
pub fn pool_step_packed_projectiles_batch(count: u32, dt_sec: f64) {
    let p = projectile_pool();
    let n = count as usize;
    debug_assert!(n <= PROJECTILE_POOL_CAPACITY_USIZE);
    for i in 0..n {
        if p.has_gravity[i] != 0 {
            p.vel_z[i] -= GRAVITY * dt_sec;
        }
        p.pos_x[i] += p.vel_x[i] * dt_sec;
        p.pos_y[i] += p.vel_y[i] * dt_sec;
        p.pos_z[i] += p.vel_z[i] * dt_sec;
    }
}

// ─────────────────────────────────────────────────────────────────
//  Phase 6a — Damped-spring single-axis rotation integrator
//
//  Mirrors src/game/math/MathHelpers.ts integrateDampedRotation.
//  Used by both server (turretSystem per tick) and client
//  prediction (applyClientCombatExpensivePrediction per frame) so
//  authoritative + predicted turret motion stay bit-identical.
//
//  Options on the TS side are an object: { wrap?, minAngle?, maxAngle? }.
//  We encode them into a u32 flags word plus two scalar slots:
//    flags bit 0 = wrap (yaw axes — turn the short way around ±π)
//    flags bit 1 = has_min (cap newAngle to min_angle, zero velocity)
//    flags bit 2 = has_max (cap newAngle to max_angle, zero velocity)
//  Wrap and clamp are mutually exclusive in current callers; the
//  kernel doesn't enforce that — same precedence as the TS impl
//  (wrap normalises first, then min/max checks fire).
//
//  Output buffer (3 f64s): newAngle, newAngularVel, angularAcc.
// ─────────────────────────────────────────────────────────────────

pub const DAMPED_ROTATION_FLAG_WRAP: u32 = 1 << 0;
pub const DAMPED_ROTATION_FLAG_HAS_MIN: u32 = 1 << 1;
pub const DAMPED_ROTATION_FLAG_HAS_MAX: u32 = 1 << 2;

/// Bit-identical to MathHelpers.ts normalizeAngle. Wraps angle into
/// (-π, π]; non-finite input collapses to 0. The two pre-checks
/// match the TS short-circuits exactly so the fast path stays fast.
#[inline]
fn normalize_angle_ts(mut angle: f64) -> f64 {
    let pi = core::f64::consts::PI;
    let two_pi = pi * 2.0;
    if angle <= pi && angle >= -pi {
        return angle;
    }
    if !angle.is_finite() {
        return 0.0;
    }
    if angle > pi && angle <= pi + two_pi {
        return angle - two_pi;
    }
    if angle < -pi && angle >= -pi - two_pi {
        return angle + two_pi;
    }
    // JS `%` on negatives returns a value with the dividend's sign;
    // Rust's `%` does the same, so this transcribes directly.
    angle = (((angle + pi) % two_pi) + two_pi) % two_pi - pi;
    angle
}

#[wasm_bindgen]
pub fn integrate_damped_rotation(
    out_buf: &mut [f64],
    angle: f64,
    angular_vel: f64,
    target_angle: f64,
    k: f64,
    c: f64,
    dt_sec: f64,
    flags: u32,
    min_angle: f64,
    max_angle: f64,
) {
    debug_assert!(out_buf.len() >= 3);
    let wrap = flags & DAMPED_ROTATION_FLAG_WRAP != 0;
    let has_min = flags & DAMPED_ROTATION_FLAG_HAS_MIN != 0;
    let has_max = flags & DAMPED_ROTATION_FLAG_HAS_MAX != 0;

    let diff = if wrap {
        normalize_angle_ts(target_angle - angle)
    } else {
        target_angle - angle
    };
    let accel = diff * k - angular_vel * c;
    let mut new_vel = angular_vel + accel * dt_sec;
    let mut new_angle = angle + new_vel * dt_sec;
    let mut out_acc = accel;
    if wrap {
        new_angle = normalize_angle_ts(new_angle);
    }
    if has_min && new_angle < min_angle {
        new_angle = min_angle;
        new_vel = 0.0;
        out_acc = 0.0;
    } else if has_max && new_angle > max_angle {
        new_angle = max_angle;
        new_vel = 0.0;
        out_acc = 0.0;
    }
    out_buf[0] = new_angle;
    out_buf[1] = new_vel;
    out_buf[2] = out_acc;
}

// ─────────────────────────────────────────────────────────────────
//  Phase 8 — Terrain heightmap in WASM linear memory
//
//  Mirrors the read side of src/game/sim/terrain/terrainTileMap.ts:
//    terrainTriangleSampleFromGlobalMesh  +  terrainBarycentricAt
//    terrainMeshHeightFromSample (triangle branch)
//    terrainMeshNormalFromSample (triangle branch)
//  plus the WATER_LEVEL clamp / below-water-up-vector semantics from
//  terrainSurface.ts.
//
//  The 8 mesh arrays land in WASM linear memory once at world-load
//  via `terrain_install_mesh` (called by the JS-side
//  setAuthoritativeTerrainTileMap install hook). Per-call samplers
//  walk the cell's triangle bucket and barycentric-interpolate
//  directly from those Vecs — no JS callback, no per-call
//  marshalling.
//
//  Fallback path (bilinear quad over the noise generator) is NOT
//  ported here. The triangle walk should always find a containing
//  triangle in a real match; the rare-case fallback in
//  `getTerrainMeshSample` is only hit before the mesh is baked or
//  for points outside the map (already clamped away). Rust signals
//  "no triangle found" by returning NaN from height and 0 from
//  normal; JS falls back to the TS path on either sentinel.
// ─────────────────────────────────────────────────────────────────

// Mirrors src/game/sim/terrain/terrainConfig.ts:
//   TILE_FLOOR_Y       = -1200
//   WATER_LEVEL_FRACTION = 0.71
//   WATER_LEVEL        = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION)
const TERRAIN_TILE_FLOOR_Y: f64 = -1200.0;
const TERRAIN_WATER_LEVEL_FRACTION: f64 = 0.71;
const TERRAIN_WATER_LEVEL: f64 = TERRAIN_TILE_FLOOR_Y * (1.0 - TERRAIN_WATER_LEVEL_FRACTION);

// Matches terrainTileMap.ts TERRAIN_MESH_EPSILON for the degenerate
// barycentric guard.
const TERRAIN_MESH_EPSILON: f64 = 1e-6;

struct TerrainGrid {
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: i32,
    cells_x: i32,
    cells_y: i32,
    installed: bool,
    // mesh storage — names mirror TerrainTileMap field names in
    // src/types/terrain.ts (without the "mesh" prefix since this is
    // already inside a terrain struct).
    vertex_coords: Vec<f64>,        // (x, z) pairs, length = 2 * vertex_count
    vertex_heights: Vec<f64>,
    triangle_indices: Vec<i32>,     // (ia, ib, ic) triples, length = 3 * triangle_count
    triangle_levels: Vec<i32>,
    neighbor_indices: Vec<i32>,
    neighbor_levels: Vec<i32>,
    cell_triangle_offsets: Vec<i32>,
    cell_triangle_indices: Vec<i32>,
}

impl TerrainGrid {
    const fn empty() -> Self {
        Self {
            map_width: 0.0,
            map_height: 0.0,
            cell_size: 0.0,
            subdiv: 0,
            cells_x: 0,
            cells_y: 0,
            installed: false,
            vertex_coords: Vec::new(),
            vertex_heights: Vec::new(),
            triangle_indices: Vec::new(),
            triangle_levels: Vec::new(),
            neighbor_indices: Vec::new(),
            neighbor_levels: Vec::new(),
            cell_triangle_offsets: Vec::new(),
            cell_triangle_indices: Vec::new(),
        }
    }
}

struct TerrainGridHolder(UnsafeCell<TerrainGrid>);
unsafe impl Sync for TerrainGridHolder {}
static TERRAIN_GRID: TerrainGridHolder = TerrainGridHolder(UnsafeCell::new(TerrainGrid::empty()));

#[inline]
fn terrain_grid() -> &'static mut TerrainGrid {
    // SAFETY: WASM is single-threaded; no &mut ever lives across
    // calls. The static Vecs grow on install (one-time per match
    // boundary) and shrink on clear.
    unsafe { &mut *TERRAIN_GRID.0.get() }
}

#[wasm_bindgen]
pub fn terrain_install_mesh(
    vertex_coords: &[f64],
    vertex_heights: &[f64],
    triangle_indices: &[i32],
    triangle_levels: &[i32],
    neighbor_indices: &[i32],
    neighbor_levels: &[i32],
    cell_triangle_offsets: &[i32],
    cell_triangle_indices: &[i32],
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: i32,
    cells_x: i32,
    cells_y: i32,
) {
    let t = terrain_grid();
    t.vertex_coords.clear();
    t.vertex_coords.extend_from_slice(vertex_coords);
    t.vertex_heights.clear();
    t.vertex_heights.extend_from_slice(vertex_heights);
    t.triangle_indices.clear();
    t.triangle_indices.extend_from_slice(triangle_indices);
    t.triangle_levels.clear();
    t.triangle_levels.extend_from_slice(triangle_levels);
    t.neighbor_indices.clear();
    t.neighbor_indices.extend_from_slice(neighbor_indices);
    t.neighbor_levels.clear();
    t.neighbor_levels.extend_from_slice(neighbor_levels);
    t.cell_triangle_offsets.clear();
    t.cell_triangle_offsets.extend_from_slice(cell_triangle_offsets);
    t.cell_triangle_indices.clear();
    t.cell_triangle_indices.extend_from_slice(cell_triangle_indices);
    t.map_width = map_width;
    t.map_height = map_height;
    t.cell_size = cell_size;
    t.subdiv = subdiv;
    t.cells_x = cells_x;
    t.cells_y = cells_y;
    t.installed = true;
}

#[wasm_bindgen]
pub fn terrain_clear() {
    let t = terrain_grid();
    t.installed = false;
    // Drop Vec contents so the memory comes back to Rust's allocator
    // — installs are rare so the next install will reallocate.
    t.vertex_coords.clear();
    t.vertex_heights.clear();
    t.triangle_indices.clear();
    t.triangle_levels.clear();
    t.neighbor_indices.clear();
    t.neighbor_levels.clear();
    t.cell_triangle_offsets.clear();
    t.cell_triangle_indices.clear();
}

#[wasm_bindgen]
pub fn terrain_is_installed() -> u32 {
    if terrain_grid().installed { 1 } else { 0 }
}

#[wasm_bindgen]
pub fn terrain_metadata(out_buf: &mut [f64]) {
    debug_assert!(out_buf.len() >= 6);
    let t = terrain_grid();
    out_buf[0] = t.map_width;
    out_buf[1] = t.map_height;
    out_buf[2] = t.cell_size;
    out_buf[3] = t.subdiv as f64;
    out_buf[4] = t.cells_x as f64;
    out_buf[5] = t.cells_y as f64;
}

#[inline]
fn terrain_barycentric_at(
    px: f64, pz: f64,
    ax: f64, az: f64,
    bx: f64, bz: f64,
    cx: f64, cz: f64,
) -> Option<(f64, f64, f64)> {
    let denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if denom.abs() <= TERRAIN_MESH_EPSILON {
        return None;
    }
    let inv = 1.0 / denom;
    let wa = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) * inv;
    let wb = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) * inv;
    Some((wa, wb, 1.0 - wa - wb))
}

#[inline]
fn normalize_barycentric_weights(wa: f64, wb: f64, wc: f64) -> (f64, f64, f64) {
    let ca = wa.max(0.0);
    let cb = wb.max(0.0);
    let cc = wc.max(0.0);
    let sum = ca + cb + cc;
    if sum <= 0.0 {
        return (1.0, 0.0, 0.0);
    }
    let inv = 1.0 / sum;
    (ca * inv, cb * inv, cc * inv)
}

/// Triangle sample tuple: (wa, wb, wc, ax, az, ah, bx, bz, bh, cx, cz, ch).
/// Same shape as TerrainTriangleSample in terrainTileMap.ts.
type TerrainTriangleSample = (
    f64, f64, f64,  // weights
    f64, f64, f64,  // a (x, z, h)
    f64, f64, f64,  // b
    f64, f64, f64,  // c
);

fn terrain_triangle_sample_at(
    t: &TerrainGrid,
    px: f64, pz: f64,
    cell_x: i32, cell_y: i32,
) -> Option<TerrainTriangleSample> {
    if cell_x < 0 || cell_y < 0 || cell_x >= t.cells_x || cell_y >= t.cells_y {
        return None;
    }
    let cell_idx = (cell_y * t.cells_x + cell_x) as usize;
    if cell_idx + 1 >= t.cell_triangle_offsets.len() {
        return None;
    }
    let start = t.cell_triangle_offsets[cell_idx] as usize;
    let end = t.cell_triangle_offsets[cell_idx + 1] as usize;
    let mut best: Option<TerrainTriangleSample> = None;
    let mut best_score = f64::NEG_INFINITY;

    for ref_idx in start..end {
        let tri = t.cell_triangle_indices[ref_idx] as usize;
        let tri_offset = tri * 3;
        let ia = t.triangle_indices[tri_offset] as usize;
        let ib = t.triangle_indices[tri_offset + 1] as usize;
        let ic = t.triangle_indices[tri_offset + 2] as usize;
        let ax = t.vertex_coords[ia * 2];
        let az = t.vertex_coords[ia * 2 + 1];
        let bx = t.vertex_coords[ib * 2];
        let bz = t.vertex_coords[ib * 2 + 1];
        let cx = t.vertex_coords[ic * 2];
        let cz = t.vertex_coords[ic * 2 + 1];
        let (wa, wb, wc) = match terrain_barycentric_at(px, pz, ax, az, bx, bz, cx, cz) {
            Some(b) => b,
            None => continue,
        };
        let score = wa.min(wb).min(wc);
        if score < -1e-5 && score <= best_score {
            continue;
        }
        let (final_wa, final_wb, final_wc) = if score >= -1e-5 {
            (wa, wb, wc)
        } else {
            normalize_barycentric_weights(wa, wb, wc)
        };
        // TerrainTileMap uses ?? 0 for missing heights; clamp the
        // index get to 0 if out of range.
        let ah = t.vertex_heights.get(ia).copied().unwrap_or(0.0);
        let bh = t.vertex_heights.get(ib).copied().unwrap_or(0.0);
        let ch = t.vertex_heights.get(ic).copied().unwrap_or(0.0);
        let sample = (
            final_wa, final_wb, final_wc,
            ax, az, ah,
            bx, bz, bh,
            cx, cz, ch,
        );
        if score >= -1e-5 {
            return Some(sample);
        }
        best = Some(sample);
        best_score = score;
    }
    best
}

#[inline]
fn terrain_clamp_to_cell(t: &TerrainGrid, x: f64, z: f64) -> (f64, f64, i32, i32) {
    let max_x = t.cells_x as f64 * t.cell_size;
    let max_z = t.cells_y as f64 * t.cell_size;
    let px = if x <= 0.0 { 0.0 } else if x >= max_x { max_x } else { x };
    let pz = if z <= 0.0 { 0.0 } else if z >= max_z { max_z } else { z };
    let cell_x = ((px / t.cell_size).floor() as i32).max(0).min(t.cells_x - 1);
    let cell_y = ((pz / t.cell_size).floor() as i32).max(0).min(t.cells_y - 1);
    (px, pz, cell_x, cell_y)
}

/// Sample terrain surface height at world-space (x, z). Returns
/// NaN if no mesh is installed or the triangle walk degenerates —
/// JS callers should treat NaN as "fall back to TS sampler" since
/// that handles the bilinear-quad-over-noise path.
#[wasm_bindgen]
pub fn terrain_get_surface_height(x: f64, z: f64) -> f64 {
    let t = terrain_grid();
    if !t.installed {
        return f64::NAN;
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some((wa, wb, wc, _, _, ah, _, _, bh, _, _, ch)) => {
            let h = wa * ah + wb * bh + wc * ch;
            h.max(TERRAIN_WATER_LEVEL)
        }
        None => f64::NAN,
    }
}

/// Segment-vs-terrain line-of-sight test. Walks the line from
/// (sx, sy, sz) to (tx, ty, tz) in `step_len`-spaced samples and
/// returns:
///   0 = ground blocks the ray (one sample's height > ray height)
///   1 = segment clears terrain end to end
///   2 = no mesh installed → caller should fall back to TS path
/// Mirrors hasTerrainLineOfSight in lineOfSight.ts. Caller passes
/// the JS-side step_len (LAND_CELL_SIZE * 0.5 today — kept JS-side
/// so we don't duplicate the LAND_CELL_SIZE constant across the
/// boundary).
#[wasm_bindgen]
pub fn terrain_has_line_of_sight(
    sx: f64, sy: f64, sz: f64,
    tx: f64, ty: f64, tz: f64,
    step_len: f64,
) -> u32 {
    let t = terrain_grid();
    if !t.installed {
        return 2;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let horiz_dist = (dx * dx + dy * dy).sqrt();
    if horiz_dist < step_len {
        return 1;
    }
    let step_count = (horiz_dist / step_len).ceil() as i32;
    let inv_steps = 1.0 / step_count as f64;
    for i in 1..step_count {
        let f = i as f64 * inv_steps;
        let x = sx + dx * f;
        let y = sy + dy * f;
        let ray_z = sz + dz * f;
        // Inline the height sampler — same path as
        // terrain_get_surface_height, but skip the NaN sentinel
        // branch since we're inside Rust and an unmapped point
        // produces a degenerate sample (no triangle found) which
        // we treat as "no blocker" (height = -inf → never blocks).
        let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, y);
        if let Some((wa, wb, wc, _, _, ah, _, _, bh, _, _, ch)) =
            terrain_triangle_sample_at(t, px, pz, cell_x, cell_y)
        {
            let h = (wa * ah + wb * bh + wc * ch).max(TERRAIN_WATER_LEVEL);
            if h > ray_z {
                return 0;
            }
        }
    }
    1
}

/// Sample terrain surface normal at world-space (x, z). Writes
/// (nx, ny, nz) into out_buf[0..3] and returns 1 on success, 0 on
/// "no mesh installed / degenerate" so JS can fall back to TS.
/// nz is the up component (vertical); nx / ny are the horizontal
/// slope components. Below-water samples return (0, 0, 1) as the
/// flat water surface normal — matches getSurfaceNormal in
/// terrainSurface.ts.
#[wasm_bindgen]
pub fn terrain_get_surface_normal(x: f64, z: f64, out_buf: &mut [f64]) -> u32 {
    debug_assert!(out_buf.len() >= 3);
    let t = terrain_grid();
    if !t.installed {
        return 0;
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, z);
    let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(s) => s,
        None => return 0,
    };
    let (wa, wb, wc, ax, az, ah, bx, bz, bh, cx, cz, ch) = sample;
    let h0 = wa * ah + wb * bh + wc * ch;
    if h0 < TERRAIN_WATER_LEVEL {
        out_buf[0] = 0.0;
        out_buf[1] = 0.0;
        out_buf[2] = 1.0;
        return 1;
    }
    // Triangle-plane normal — same math as terrainMeshNormalFromSample.
    let ux = bx - ax;
    let uy = bh - ah;
    let uz = bz - az;
    let vx_ = cx - ax;
    let vy = ch - ah;
    let vz = cz - az;
    let mut nx = uy * vz - uz * vy;
    let mut vertical = uz * vx_ - ux * vz;
    let mut nz = ux * vy - uy * vx_;
    if vertical < 0.0 {
        nx = -nx;
        vertical = -vertical;
        nz = -nz;
    }
    let len_sq = nx * nx + vertical * vertical + nz * nz;
    let len = if len_sq > 0.0 { len_sq.sqrt() } else { 1.0 };
    out_buf[0] = nx / len;
    // Match terrainMeshNormalFromSample's return shape: { nx, ny: nz, nz: vertical }.
    out_buf[1] = nz / len;
    out_buf[2] = vertical / len;
    1
}

// ─────────────────────────────────────────────────────────────────
//  Phase 7 — SpatialGrid: 3D voxel hash in WASM linear memory
//
//  Big-bang port of src/game/sim/SpatialGrid.ts (1438 lines, 8 query
//  families, 6 mutation methods, capture-vote subsystem). The JS-side
//  SpatialGrid.ts becomes a thin wrapper that delegates here while
//  preserving the existing public surface so callers are unchanged.
//
//  Slot strategy: the Rust grid uses generic u32 slot ids. JS owns
//  the Map<EntityId, slot> side-table and resolves slot ids back to
//  Entity refs on query return. Units, buildings, and projectiles
//  all share the same slot space; the kind tag in `slot_kind`
//  disambiguates.
//
//  Cell key encoding: same 48-bit packed (cx, cy, cz) scheme as
//  pack_contact_cell_key — JS-side packCell produces an identical
//  bit pattern, so a future debugger can cross-reference cell ids.
//
//  Land-cell capture: spatialCubeKeyToLandCellKey in JS does
//  `Math.floor(cubeKey / 0x10000) | 0` which is `(cubeKey >> 16)` as
//  a 32-bit signed integer. Our cube key is u64; we drop the low
//  16 bits (cz biased) and reinterpret the next 32 bits as i32 to
//  produce the JS-equivalent land cell key.
// ─────────────────────────────────────────────────────────────────

const SPATIAL_KIND_UNSET: u8 = 0;
const SPATIAL_KIND_UNIT: u8 = 1;
const SPATIAL_KIND_BUILDING: u8 = 2;
const SPATIAL_KIND_PROJECTILE: u8 = 3;

// Matches MAX_UNIT_SHOT_RADIUS in SpatialGrid.ts — used to pad the
// cell sweep for enemy-entities queries so units near the radius +
// shot-collider boundary aren't culled by cell-level rejection.
const SPATIAL_MAX_UNIT_SHOT_RADIUS: f64 = 45.0;
const SPATIAL_MAX_LINE_QUERY_CELLS: i64 = 4096;
const SPATIAL_MAX_LINE_QUERY_OCCUPIED_FALLBACK_CELLS: usize = 8192;

// Z-band defaults for ground-plane queries — match TILE_FLOOR_Y and
// TERRAIN_MAX_RENDER_Y in src/game/sim/terrain/terrainConfig.ts.
const SPATIAL_TILE_FLOOR_Y: f64 = -1200.0;
const SPATIAL_TERRAIN_MAX_RENDER_Y: f64 = 1600.0;  // TERRAIN_SHAPE_MAGNITUDE(800) * 2

#[derive(Default)]
struct SpatialCellBucket {
    units: Vec<u32>,
    buildings: Vec<u32>,
    projectiles: Vec<u32>,
}

impl SpatialCellBucket {
    fn is_empty(&self) -> bool {
        self.units.is_empty() && self.buildings.is_empty() && self.projectiles.is_empty()
    }
    fn clear(&mut self) {
        self.units.clear();
        self.buildings.clear();
        self.projectiles.clear();
    }
}

struct SpatialCaptureCell {
    key: i32,
    players: Vec<u8>,
}

#[derive(Clone, Copy)]
struct SpatialCaptureVote {
    key: i32,
    player_id: u8,
}

struct SpatialGridState {
    cell_size: f64,
    half_cell_size: f64,

    cells: HashMap<u64, SpatialCellBucket>,
    cell_pool: Vec<SpatialCellBucket>,

    // Per-slot SoA. slot_kind == SPATIAL_KIND_UNSET means free.
    slot_kind: Vec<u8>,
    slot_owner_player: Vec<u8>,
    slot_x: Vec<f64>,
    slot_y: Vec<f64>,
    slot_z: Vec<f64>,
    slot_radius_push: Vec<f64>,
    slot_radius_shot: Vec<f64>,
    slot_aabb_hx: Vec<f64>,
    slot_aabb_hy: Vec<f64>,
    slot_aabb_hz: Vec<f64>,
    slot_hp_alive: Vec<u8>,
    slot_entity_active: Vec<u8>,
    slot_proj_is_projectile_type: Vec<u8>,
    // Current 3D cube key for units/projectiles. Unused for buildings
    // (their list of cubes is in `building_cells`).
    slot_cube_key: Vec<u64>,

    // Multi-cell building tracking. Empty for non-buildings.
    building_cells: Vec<Vec<u64>>,

    // Capture votes
    capture_by_cell: HashMap<i32, SpatialCaptureCell>,
    unit_capture_votes: HashMap<u32, SpatialCaptureVote>,
    building_capture_votes: HashMap<u32, Vec<SpatialCaptureVote>>,

    // Free list
    free_slots: Vec<u32>,
    next_slot: u32,

    // Per-query scratch
    nearby_cells: Vec<u64>,
    dedup: std::collections::HashSet<u32>,
    scratch_u32: Vec<u32>,
}

impl SpatialGridState {
    fn empty() -> Self {
        Self {
            cell_size: 0.0,
            half_cell_size: 0.0,
            cells: HashMap::new(),
            cell_pool: Vec::new(),
            slot_kind: Vec::new(),
            slot_owner_player: Vec::new(),
            slot_x: Vec::new(),
            slot_y: Vec::new(),
            slot_z: Vec::new(),
            slot_radius_push: Vec::new(),
            slot_radius_shot: Vec::new(),
            slot_aabb_hx: Vec::new(),
            slot_aabb_hy: Vec::new(),
            slot_aabb_hz: Vec::new(),
            slot_hp_alive: Vec::new(),
            slot_entity_active: Vec::new(),
            slot_proj_is_projectile_type: Vec::new(),
            slot_cube_key: Vec::new(),
            building_cells: Vec::new(),
            capture_by_cell: HashMap::new(),
            unit_capture_votes: HashMap::new(),
            building_capture_votes: HashMap::new(),
            free_slots: Vec::new(),
            next_slot: 0,
            nearby_cells: Vec::new(),
            dedup: std::collections::HashSet::new(),
            scratch_u32: Vec::new(),
        }
    }
}

struct SpatialGridHolder(UnsafeCell<Option<SpatialGridState>>);
unsafe impl Sync for SpatialGridHolder {}
static SPATIAL_GRID: SpatialGridHolder = SpatialGridHolder(UnsafeCell::new(None));

#[inline]
fn spatial_grid() -> &'static mut SpatialGridState {
    // SAFETY: WASM single-threaded; one Rust call active at a time.
    // Lazy-initializes on first access so callers don't have to gate
    // on spatial_init having run yet (matches the BodyPool pattern
    // where pool_init is called from initSimWasm's bootstrap chain).
    unsafe {
        let cell = &mut *SPATIAL_GRID.0.get();
        if cell.is_none() {
            *cell = Some(SpatialGridState::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[inline]
fn spatial_cell_xy(v: f64, cs: f64) -> i32 {
    (v / cs).floor() as i32
}

#[inline]
fn spatial_cell_z(v: f64, cs: f64, half: f64) -> i32 {
    ((v + half) / cs).floor() as i32
}

#[inline]
fn spatial_get_cell_key(state: &SpatialGridState, x: f64, y: f64, z: f64) -> u64 {
    let cx = spatial_cell_xy(x, state.cell_size);
    let cy = spatial_cell_xy(y, state.cell_size);
    let cz = spatial_cell_z(z, state.cell_size, state.half_cell_size);
    pack_contact_cell_key(cx, cy, cz)
}

/// JS `spatialCubeKeyToLandCellKey(cubeKey)` ≡
/// `Math.floor(cubeKey / 0x10000) | 0` ≡ `(cubeKey >> 16) as i32`.
/// Our cube key = (cxb << 32) | (cyb << 16) | czb; dropping the low
/// 16 bits gives (cxb << 16) | cyb, which is exactly JS `packLandCellKey`.
#[inline]
fn spatial_cube_to_land_key(cube_key: u64) -> i32 {
    ((cube_key >> 16) as u32) as i32
}

fn spatial_get_or_create_cell<'a>(state: &'a mut SpatialGridState, key: u64) -> &'a mut SpatialCellBucket {
    if !state.cells.contains_key(&key) {
        let bucket = state.cell_pool.pop().unwrap_or_default();
        state.cells.insert(key, bucket);
    }
    state.cells.get_mut(&key).expect("just inserted")
}

fn spatial_prune_cell_if_empty(state: &mut SpatialGridState, key: u64) {
    if let Some(bucket) = state.cells.get(&key) {
        if bucket.is_empty() {
            let mut bucket = state.cells.remove(&key).unwrap();
            bucket.clear();
            state.cell_pool.push(bucket);
        }
    }
}

fn spatial_remove_unit_from_cell(state: &mut SpatialGridState, cell_key: u64, slot: u32) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.units.iter().position(|&s| s == slot) {
            let last = bucket.units.len() - 1;
            if idx != last { bucket.units.swap(idx, last); }
            bucket.units.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

fn spatial_remove_projectile_from_cell(state: &mut SpatialGridState, cell_key: u64, slot: u32) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.projectiles.iter().position(|&s| s == slot) {
            let last = bucket.projectiles.len() - 1;
            if idx != last { bucket.projectiles.swap(idx, last); }
            bucket.projectiles.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

fn spatial_remove_building_from_cell(state: &mut SpatialGridState, cell_key: u64, slot: u32) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.buildings.iter().position(|&s| s == slot) {
            let last = bucket.buildings.len() - 1;
            if idx != last { bucket.buildings.swap(idx, last); }
            bucket.buildings.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

fn spatial_add_capture_vote(state: &mut SpatialGridState, key: i32, player_id: u8) {
    let entry = state.capture_by_cell.entry(key).or_insert_with(|| SpatialCaptureCell {
        key,
        players: Vec::new(),
    });
    entry.players.push(player_id);
}

fn spatial_remove_capture_vote(state: &mut SpatialGridState, key: i32, player_id: u8) {
    if let Some(entry) = state.capture_by_cell.get_mut(&key) {
        if let Some(idx) = entry.players.iter().rposition(|&p| p == player_id) {
            let last = entry.players.len() - 1;
            if idx != last { entry.players.swap(idx, last); }
            entry.players.pop();
        }
        if entry.players.is_empty() {
            state.capture_by_cell.remove(&key);
        }
    }
}

fn spatial_remove_unit_capture_vote(state: &mut SpatialGridState, slot: u32) {
    if let Some(prev) = state.unit_capture_votes.remove(&slot) {
        spatial_remove_capture_vote(state, prev.key, prev.player_id);
    }
}

fn spatial_sync_unit_capture(state: &mut SpatialGridState, slot: u32, cube_key: u64) {
    let kind = state.slot_kind[slot as usize];
    let owner = state.slot_owner_player[slot as usize];
    let alive = state.slot_hp_alive[slot as usize];
    let should_vote = kind == SPATIAL_KIND_UNIT && owner != 0 && alive != 0;
    if !should_vote {
        spatial_remove_unit_capture_vote(state, slot);
        return;
    }
    let land_key = spatial_cube_to_land_key(cube_key);
    if let Some(prev) = state.unit_capture_votes.get(&slot).copied() {
        if prev.key == land_key && prev.player_id == owner {
            return;
        }
        spatial_remove_capture_vote(state, prev.key, prev.player_id);
    }
    spatial_add_capture_vote(state, land_key, owner);
    state.unit_capture_votes.insert(slot, SpatialCaptureVote { key: land_key, player_id: owner });
}

fn spatial_remove_building_capture_votes(state: &mut SpatialGridState, slot: u32) {
    if let Some(votes) = state.building_capture_votes.remove(&slot) {
        for v in &votes {
            spatial_remove_capture_vote(state, v.key, v.player_id);
        }
    }
}

fn spatial_sync_building_capture(state: &mut SpatialGridState, slot: u32) {
    spatial_remove_building_capture_votes(state, slot);
    let kind = state.slot_kind[slot as usize];
    let owner = state.slot_owner_player[slot as usize];
    let alive = state.slot_hp_alive[slot as usize];
    let active = state.slot_entity_active[slot as usize];
    if kind != SPATIAL_KIND_BUILDING || owner == 0 || alive == 0 || active == 0 {
        return;
    }
    let cells = state.building_cells[slot as usize].clone();
    if cells.is_empty() { return; }
    let mut votes = Vec::with_capacity(cells.len());
    for &cube_key in &cells {
        let land_key = spatial_cube_to_land_key(cube_key);
        spatial_add_capture_vote(state, land_key, owner);
        votes.push(SpatialCaptureVote { key: land_key, player_id: owner });
    }
    if !votes.is_empty() {
        state.building_capture_votes.insert(slot, votes);
    }
}

#[inline]
#[allow(dead_code)]
fn spatial_dist_sq3(x1: f64, y1: f64, z1: f64, x2: f64, y2: f64, z2: f64) -> f64 {
    let dx = x1 - x2;
    let dy = y1 - y2;
    let dz = z1 - z2;
    dx * dx + dy * dy + dz * dz
}

#[inline]
#[allow(dead_code)]
fn spatial_dist_sq2(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let dx = x1 - x2;
    let dy = y1 - y2;
    dx * dx + dy * dy
}

#[inline]
fn spatial_dist_sq_to_aabb3(
    bx: f64, by: f64, bz: f64,
    hx: f64, hy: f64, hz: f64,
    px: f64, py: f64, pz: f64,
) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let min_z = bz - hz;
    let max_z = bz + hz;
    let cxp = if px < min_x { min_x } else if px > max_x { max_x } else { px };
    let cyp = if py < min_y { min_y } else if py > max_y { max_y } else { py };
    let czp = if pz < min_z { min_z } else if pz > max_z { max_z } else { pz };
    let dx = cxp - px;
    let dy = cyp - py;
    let dz = czp - pz;
    dx * dx + dy * dy + dz * dz
}

#[inline]
fn spatial_dist_sq_to_aabb2(
    bx: f64, by: f64,
    hx: f64, hy: f64,
    px: f64, py: f64,
) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let cxp = if px < min_x { min_x } else if px > max_x { max_x } else { px };
    let cyp = if py < min_y { min_y } else if py > max_y { max_y } else { py };
    let dx = cxp - px;
    let dy = cyp - py;
    dx * dx + dy * dy
}

// ===================== Lifecycle / slot allocation =====================

#[wasm_bindgen]
pub fn spatial_init(cell_size: f64, initial_slot_capacity: u32) {
    let state = spatial_grid();
    state.cell_size = cell_size;
    state.half_cell_size = cell_size * 0.5;
    state.cells.clear();
    state.cell_pool.clear();
    state.capture_by_cell.clear();
    state.unit_capture_votes.clear();
    state.building_capture_votes.clear();
    state.free_slots.clear();
    state.next_slot = 0;
    state.nearby_cells.clear();
    state.dedup.clear();
    state.scratch_u32.clear();
    // Pre-size per-slot arrays.
    let cap = initial_slot_capacity as usize;
    state.slot_kind.clear();
    state.slot_kind.resize(cap, SPATIAL_KIND_UNSET);
    state.slot_owner_player.clear();
    state.slot_owner_player.resize(cap, 0);
    state.slot_x.clear();
    state.slot_x.resize(cap, 0.0);
    state.slot_y.clear();
    state.slot_y.resize(cap, 0.0);
    state.slot_z.clear();
    state.slot_z.resize(cap, 0.0);
    state.slot_radius_push.clear();
    state.slot_radius_push.resize(cap, 0.0);
    state.slot_radius_shot.clear();
    state.slot_radius_shot.resize(cap, 0.0);
    state.slot_aabb_hx.clear();
    state.slot_aabb_hx.resize(cap, 0.0);
    state.slot_aabb_hy.clear();
    state.slot_aabb_hy.resize(cap, 0.0);
    state.slot_aabb_hz.clear();
    state.slot_aabb_hz.resize(cap, 0.0);
    state.slot_hp_alive.clear();
    state.slot_hp_alive.resize(cap, 0);
    state.slot_entity_active.clear();
    state.slot_entity_active.resize(cap, 0);
    state.slot_proj_is_projectile_type.clear();
    state.slot_proj_is_projectile_type.resize(cap, 0);
    state.slot_cube_key.clear();
    state.slot_cube_key.resize(cap, 0);
    state.building_cells.clear();
    state.building_cells.resize_with(cap, Vec::new);
}

#[wasm_bindgen]
pub fn spatial_clear() {
    let state = spatial_grid();
    state.cells.clear();
    state.cell_pool.clear();
    state.capture_by_cell.clear();
    state.unit_capture_votes.clear();
    state.building_capture_votes.clear();
    // Reset slot ownership but keep allocations.
    for k in state.slot_kind.iter_mut() { *k = SPATIAL_KIND_UNSET; }
    for c in state.building_cells.iter_mut() { c.clear(); }
    for cube in state.slot_cube_key.iter_mut() { *cube = 0; }
    state.free_slots.clear();
    state.next_slot = 0;
}

fn spatial_ensure_slot_capacity(state: &mut SpatialGridState, slot: u32) {
    let needed = (slot as usize) + 1;
    if state.slot_kind.len() >= needed { return; }
    state.slot_kind.resize(needed, SPATIAL_KIND_UNSET);
    state.slot_owner_player.resize(needed, 0);
    state.slot_x.resize(needed, 0.0);
    state.slot_y.resize(needed, 0.0);
    state.slot_z.resize(needed, 0.0);
    state.slot_radius_push.resize(needed, 0.0);
    state.slot_radius_shot.resize(needed, 0.0);
    state.slot_aabb_hx.resize(needed, 0.0);
    state.slot_aabb_hy.resize(needed, 0.0);
    state.slot_aabb_hz.resize(needed, 0.0);
    state.slot_hp_alive.resize(needed, 0);
    state.slot_entity_active.resize(needed, 0);
    state.slot_proj_is_projectile_type.resize(needed, 0);
    state.slot_cube_key.resize(needed, 0);
    state.building_cells.resize_with(needed, Vec::new);
}

#[wasm_bindgen]
pub fn spatial_alloc_slot() -> u32 {
    let state = spatial_grid();
    if let Some(slot) = state.free_slots.pop() {
        spatial_ensure_slot_capacity(state, slot);
        state.slot_kind[slot as usize] = SPATIAL_KIND_UNSET;
        return slot;
    }
    let slot = state.next_slot;
    state.next_slot = state.next_slot.wrapping_add(1);
    spatial_ensure_slot_capacity(state, slot);
    slot
}

#[wasm_bindgen]
pub fn spatial_free_slot(slot: u32) {
    spatial_unset_slot(slot);
    spatial_grid().free_slots.push(slot);
}

// ===================== Mutations =====================

/// Insert or update a unit at slot. owner_player == 0 means "no owner"
/// (matches the JS `entity.ownership?.playerId ?? 0`). hp_alive is the
/// HP > 0 flag — pass 0 to skip the capture vote without bucketing the
/// slot, which mirrors updateUnit's "dead unit → remove" branch.
#[wasm_bindgen]
pub fn spatial_set_unit(
    slot: u32,
    x: f64, y: f64, z: f64,
    radius_push: f64, radius_shot: f64,
    owner_player: u8,
    hp_alive: u8,
) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    if hp_alive == 0 {
        spatial_unset_slot(slot);
        return;
    }
    let prev_kind = state.slot_kind[s];
    let new_key = spatial_get_cell_key(state, x, y, z);
    state.slot_kind[s] = SPATIAL_KIND_UNIT;
    state.slot_owner_player[s] = owner_player;
    state.slot_hp_alive[s] = hp_alive;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_radius_push[s] = radius_push;
    state.slot_radius_shot[s] = radius_shot;
    if prev_kind == SPATIAL_KIND_UNIT {
        let old_key = state.slot_cube_key[s];
        if old_key != new_key {
            spatial_remove_unit_from_cell(state, old_key, slot);
            spatial_get_or_create_cell(state, new_key).units.push(slot);
            state.slot_cube_key[s] = new_key;
        }
    } else {
        spatial_get_or_create_cell(state, new_key).units.push(slot);
        state.slot_cube_key[s] = new_key;
    }
    spatial_sync_unit_capture(state, slot, new_key);
}

#[wasm_bindgen]
pub fn spatial_set_projectile(
    slot: u32,
    x: f64, y: f64, z: f64,
    owner_player: u8,
    is_projectile_type: u8,
) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    let prev_kind = state.slot_kind[s];
    let new_key = spatial_get_cell_key(state, x, y, z);
    state.slot_kind[s] = SPATIAL_KIND_PROJECTILE;
    state.slot_owner_player[s] = owner_player;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_proj_is_projectile_type[s] = is_projectile_type;
    if prev_kind == SPATIAL_KIND_PROJECTILE {
        let old_key = state.slot_cube_key[s];
        if old_key != new_key {
            spatial_remove_projectile_from_cell(state, old_key, slot);
            spatial_get_or_create_cell(state, new_key).projectiles.push(slot);
            state.slot_cube_key[s] = new_key;
        }
    } else {
        spatial_get_or_create_cell(state, new_key).projectiles.push(slot);
        state.slot_cube_key[s] = new_key;
    }
}

/// Insert a building (idempotent — second call with the same slot
/// without an unset between is a no-op). Buildings span every cube
/// their (width × height × depth) AABB touches; the spans are
/// recomputed from (x, y, z, hx, hy, hz) on each call.
#[wasm_bindgen]
pub fn spatial_set_building(
    slot: u32,
    x: f64, y: f64, z: f64,
    hx: f64, hy: f64, hz: f64,
    owner_player: u8,
    hp_alive: u8,
    entity_active: u8,
) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    // Re-add semantics: remove old building cells if any, then bucket fresh.
    if state.slot_kind[s] == SPATIAL_KIND_BUILDING {
        let old_cells = std::mem::take(&mut state.building_cells[s]);
        for k in &old_cells {
            spatial_remove_building_from_cell(state, *k, slot);
        }
    }
    state.slot_kind[s] = SPATIAL_KIND_BUILDING;
    state.slot_owner_player[s] = owner_player;
    state.slot_hp_alive[s] = hp_alive;
    state.slot_entity_active[s] = entity_active;
    state.slot_x[s] = x;
    state.slot_y[s] = y;
    state.slot_z[s] = z;
    state.slot_aabb_hx[s] = hx;
    state.slot_aabb_hy[s] = hy;
    state.slot_aabb_hz[s] = hz;

    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let base_z = z - hz;
    let top_z = z + hz;
    let min_cx = ((x - hx) / cs).floor() as i32;
    let max_cx = ((x + hx) / cs).floor() as i32;
    let min_cy = ((y - hy) / cs).floor() as i32;
    let max_cy = ((y + hy) / cs).floor() as i32;
    let min_cz = ((base_z + hcs) / cs).floor() as i32;
    let max_cz = ((top_z + hcs) / cs).floor() as i32;

    let mut keys: Vec<u64> = Vec::new();
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                spatial_get_or_create_cell(state, key).buildings.push(slot);
                keys.push(key);
            }
        }
    }
    state.building_cells[s] = keys;
    spatial_sync_building_capture(state, slot);
}

/// Re-sync the building capture votes for a slot (e.g. after the
/// building's `isEntityActive` flag flips). Cells aren't re-bucketed.
#[wasm_bindgen]
pub fn spatial_sync_building_capture_for_slot(slot: u32) {
    spatial_sync_building_capture(spatial_grid(), slot);
}

#[wasm_bindgen]
pub fn spatial_unset_slot(slot: u32) {
    let state = spatial_grid();
    let s = slot as usize;
    if s >= state.slot_kind.len() { return; }
    match state.slot_kind[s] {
        SPATIAL_KIND_UNIT => {
            let key = state.slot_cube_key[s];
            spatial_remove_unit_from_cell(state, key, slot);
            spatial_remove_unit_capture_vote(state, slot);
        }
        SPATIAL_KIND_PROJECTILE => {
            let key = state.slot_cube_key[s];
            spatial_remove_projectile_from_cell(state, key, slot);
        }
        SPATIAL_KIND_BUILDING => {
            let old_cells = std::mem::take(&mut state.building_cells[s]);
            for k in &old_cells {
                spatial_remove_building_from_cell(state, *k, slot);
            }
            spatial_remove_building_capture_votes(state, slot);
        }
        _ => {}
    }
    state.slot_kind[s] = SPATIAL_KIND_UNSET;
    state.slot_hp_alive[s] = 0;
    state.slot_entity_active[s] = 0;
    state.slot_cube_key[s] = 0;
}

// ===================== Cell-sweep helpers =====================

fn spatial_collect_cells_in_radius(state: &mut SpatialGridState, x: f64, y: f64, z: f64, radius: f64) {
    state.nearby_cells.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = ((x - radius) / cs).floor() as i32;
    let max_cx = ((x + radius) / cs).floor() as i32;
    let min_cy = ((y - radius) / cs).floor() as i32;
    let max_cy = ((y + radius) / cs).floor() as i32;
    let min_cz = ((z - radius + hcs) / cs).floor() as i32;
    let max_cz = ((z + radius + hcs) / cs).floor() as i32;
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
}

fn spatial_collect_cells_in_circle2d(
    state: &mut SpatialGridState,
    x: f64, y: f64, radius: f64,
    z_min: f64, z_max: f64,
) {
    state.nearby_cells.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = ((x - radius) / cs).floor() as i32;
    let max_cx = ((x + radius) / cs).floor() as i32;
    let min_cy = ((y - radius) / cs).floor() as i32;
    let max_cy = ((y + radius) / cs).floor() as i32;
    let min_cz = ((z_min + hcs) / cs).floor() as i32;
    let max_cz = ((z_max + hcs) / cs).floor() as i32;
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
}

fn spatial_collect_cells_along_line(
    state: &mut SpatialGridState,
    x1: f64, y1: f64, z1: f64,
    x2: f64, y2: f64, z2: f64,
    line_width: f64,
) -> bool {
    state.nearby_cells.clear();
    if !x1.is_finite() || !y1.is_finite() || !z1.is_finite()
        || !x2.is_finite() || !y2.is_finite() || !z2.is_finite()
        || !line_width.is_finite()
    {
        return false;
    }
    let half_w = line_width * 0.5;
    let min_x = x1.min(x2) - half_w;
    let max_x = x1.max(x2) + half_w;
    let min_y = y1.min(y2) - half_w;
    let max_y = y1.max(y2) + half_w;
    let min_z = z1.min(z2) - half_w;
    let max_z = z1.max(z2) + half_w;
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = (min_x / cs).floor() as i32;
    let max_cx = (max_x / cs).floor() as i32;
    let min_cy = (min_y / cs).floor() as i32;
    let max_cy = (max_y / cs).floor() as i32;
    let min_cz = ((min_z + hcs) / cs).floor() as i32;
    let max_cz = ((max_z + hcs) / cs).floor() as i32;
    let cells_x = (max_cx - min_cx + 1) as i64;
    let cells_y = (max_cy - min_cy + 1) as i64;
    let cells_z = (max_cz - min_cz + 1) as i64;
    if cells_x <= 0 || cells_y <= 0 || cells_z <= 0 {
        return false;
    }
    let cell_count = cells_x * cells_y * cells_z;
    if cell_count > SPATIAL_MAX_LINE_QUERY_CELLS {
        return spatial_fill_occupied_cells_for_line(state, min_x, max_x, min_y, max_y, min_z, max_z);
    }
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                state.nearby_cells.push(pack_contact_cell_key(cx, cy, cz));
            }
        }
    }
    true
}

fn spatial_fill_occupied_cells_for_line(
    state: &mut SpatialGridState,
    min_x: f64, max_x: f64,
    min_y: f64, max_y: f64,
    min_z: f64, max_z: f64,
) -> bool {
    state.nearby_cells.clear();
    if state.cells.len() > SPATIAL_MAX_LINE_QUERY_OCCUPIED_FALLBACK_CELLS {
        return false;
    }
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    // Iterate without holding state.cells immutably while we push.
    let keys: Vec<u64> = state.cells.keys().copied().collect();
    for key in keys {
        // Unpack cube key — same layout as pack_contact_cell_key.
        let czb = (key & 0xFFFF) as i64;
        let cyb = ((key >> 16) & 0xFFFF) as i64;
        let cxb = ((key >> 32) & 0xFFFF) as i64;
        let cx = (cxb - CONTACT_CELL_BIAS) as f64;
        let cy = (cyb - CONTACT_CELL_BIAS) as f64;
        let cz = (czb - CONTACT_CELL_BIAS) as f64;
        let cell_min_x = cx * cs;
        let cell_max_x = cell_min_x + cs;
        if cell_max_x < min_x || cell_min_x > max_x { continue; }
        let cell_min_y = cy * cs;
        let cell_max_y = cell_min_y + cs;
        if cell_max_y < min_y || cell_min_y > max_y { continue; }
        let cell_min_z = cz * cs - hcs;
        let cell_max_z = cell_min_z + cs;
        if cell_max_z < min_z || cell_min_z > max_z { continue; }
        state.nearby_cells.push(key);
    }
    true
}

// ===================== Query result helpers =====================

#[inline]
fn spatial_push_unit_if_in_radius(
    state: &SpatialGridState,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64, y: f64, z: f64,
    radius: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    include_shot_radius: bool,
    ground_plane_only: bool,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_UNIT { return; }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player { return; }
    if require_alive && state.slot_hp_alive[s] == 0 { return; }

    let mut check_radius_sq = radius_sq;
    if include_shot_radius {
        let shot = state.slot_radius_shot[s];
        // JS path: `if (shotRadius === undefined) return;` We treat
        // 0.0 as "no shot radius" since units always set it positively.
        if shot <= 0.0 { return; }
        let check_radius = radius + shot;
        check_radius_sq = check_radius * check_radius;
    }
    let dx = state.slot_x[s] - x;
    let dy = state.slot_y[s] - y;
    let dist_sq = if ground_plane_only {
        dx * dx + dy * dy
    } else {
        let dz = state.slot_z[s] - z;
        dx * dx + dy * dy + dz * dz
    };
    if dist_sq <= check_radius_sq {
        out.push(slot);
    }
}

#[inline]
fn spatial_push_enemy_projectile_if_in_radius(
    state: &SpatialGridState,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64, y: f64, z: f64,
    radius_sq: f64,
    exclude_player: u8,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_PROJECTILE { return; }
    if state.slot_proj_is_projectile_type[s] == 0 { return; }
    let owner = state.slot_owner_player[s];
    if owner == exclude_player { return; }
    let dx = state.slot_x[s] - x;
    let dy = state.slot_y[s] - y;
    let dz = state.slot_z[s] - z;
    if dx * dx + dy * dy + dz * dz <= radius_sq {
        out.push(slot);
    }
}

#[inline]
fn spatial_push_building_if_in_radius(
    state: &SpatialGridState,
    dedup: &mut std::collections::HashSet<u32>,
    out: &mut Vec<u32>,
    slot: u32,
    x: f64, y: f64, z: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    ground_plane_only: bool,
) {
    if !dedup.insert(slot) { return; }
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_BUILDING { return; }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player { return; }
    if require_alive && state.slot_hp_alive[s] == 0 { return; }

    let dist_sq = if ground_plane_only {
        spatial_dist_sq_to_aabb2(
            state.slot_x[s], state.slot_y[s],
            state.slot_aabb_hx[s], state.slot_aabb_hy[s],
            x, y,
        )
    } else {
        spatial_dist_sq_to_aabb3(
            state.slot_x[s], state.slot_y[s], state.slot_z[s],
            state.slot_aabb_hx[s], state.slot_aabb_hy[s], state.slot_aabb_hz[s],
            x, y, z,
        )
    };
    if dist_sq <= radius_sq {
        out.push(slot);
    }
}

// ===================== Query exports =====================

/// Returns the count of unit slots inside the query sphere. Slot ids
/// are written to `scratch_u32[0..count]`; JS reads via the buffer ptr.
#[wasm_bindgen]
pub fn spatial_query_units_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
    require_alive: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut out = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut out, slot, x, y, z, radius, radius_sq,
                    exclude_player, require_alive != 0, false, false,
                );
            }
        }
    }
    state.scratch_u32 = out;
    state.nearby_cells = nearby;
    state.scratch_u32.len() as u32
}

#[wasm_bindgen]
pub fn spatial_query_buildings_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
    require_alive: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.dedup.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut out = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state, &mut dedup, &mut out, slot, x, y, z, radius_sq,
                    exclude_player, require_alive != 0, false,
                );
            }
        }
    }
    state.scratch_u32 = out;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    state.scratch_u32.len() as u32
}

/// Combined units + buildings inside a 3D sphere. Output layout:
///   [n_units, n_buildings, unit_slot0..n, building_slot0..m]
/// JS slices the header to get the two counts.
#[wasm_bindgen]
pub fn spatial_query_units_and_buildings_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    // Reserve header slots [n_units, n_buildings].
    state.scratch_u32.push(0);
    state.scratch_u32.push(0);
    state.dedup.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let header_n = 2;
    // Two passes so units come first in the buffer, then buildings.
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius, radius_sq,
                    0, false, false, false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let mut dedup = std::mem::take(&mut state.dedup);
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state, &mut dedup, &mut buf, slot, x, y, z, radius_sq,
                    0, false, false,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (header_n + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_units_and_buildings_in_rect_2d(
    min_x: f64, max_x: f64, min_y: f64, max_y: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);  // header: n_units
    state.scratch_u32.push(0);  // header: n_buildings
    state.dedup.clear();
    let cs = state.cell_size;
    let hcs = state.half_cell_size;
    let min_cx = (min_x / cs).floor() as i32;
    let max_cx = (max_x / cs).floor() as i32;
    let min_cy = (min_y / cs).floor() as i32;
    let max_cy = (max_y / cs).floor() as i32;
    let min_cz = ((SPATIAL_TILE_FLOOR_Y - cs + hcs) / cs).floor() as i32;
    let max_cz = ((SPATIAL_TERRAIN_MAX_RENDER_Y + cs * 2.0 + hcs) / cs).floor() as i32;
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    // Units bucket to one cell — no dedup needed.
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = state.cells.get(&key) {
                    for &slot in &bucket.units {
                        buf.push(slot);
                    }
                }
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    // Buildings span multiple cells — dedup.
    let bldg_start = buf.len();
    for cx in min_cx..=max_cx {
        for cy in min_cy..=max_cy {
            for cz in min_cz..=max_cz {
                let key = pack_contact_cell_key(cx, cy, cz);
                if let Some(bucket) = state.cells.get(&key) {
                    for &slot in &bucket.buildings {
                        if dedup.insert(slot) {
                            buf.push(slot);
                        }
                    }
                }
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_enemy_entities_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);  // n_units
    state.scratch_u32.push(0);  // n_buildings
    state.dedup.clear();
    // Pad cell search by max shot radius — matches JS impl.
    spatial_collect_cells_in_radius(state, x, y, z, radius + SPATIAL_MAX_UNIT_SHOT_RADIUS);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius, radius_sq,
                    exclude_player, true, true, false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state, &mut dedup, &mut buf, slot, x, y, z, radius_sq,
                    exclude_player, true, false,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_enemy_entities_in_circle_2d(
    x: f64, y: f64, radius: f64,
    exclude_player: u8,
    z_min: f64, z_max: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);
    state.scratch_u32.push(0);
    state.dedup.clear();
    spatial_collect_cells_in_circle2d(state, x, y, radius + SPATIAL_MAX_UNIT_SHOT_RADIUS, z_min, z_max);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, 0.0, radius, radius_sq,
                    exclude_player, true, true, true,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                spatial_push_building_if_in_radius(
                    state, &mut dedup, &mut buf, slot, x, y, 0.0, radius_sq,
                    exclude_player, true, true,
                );
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_units_along_line(
    x1: f64, y1: f64, z1: f64,
    x2: f64, y2: f64, z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 0;
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    count
}

#[wasm_bindgen]
pub fn spatial_query_buildings_along_line(
    x1: f64, y1: f64, z1: f64,
    x2: f64, y2: f64, z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 0;
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    count
}

#[wasm_bindgen]
pub fn spatial_query_entities_along_line(
    x1: f64, y1: f64, z1: f64,
    x2: f64, y2: f64, z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);  // n_units
    state.scratch_u32.push(0);  // n_buildings
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 2;  // headers only, both zero
    }
    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    // Two passes — units first, then buildings. Shared dedup so a
    // slot can only appear once across both arrays. Matches the JS
    // path which writes to two separate result arrays.
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let bldg_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                if dedup.insert(slot) {
                    buf.push(slot);
                }
            }
        }
    }
    let n_buildings = (buf.len() - bldg_start) as u32;
    buf[0] = n_units;
    buf[1] = n_buildings;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    state.dedup = dedup;
    (2 + n_units + n_buildings) as u32
}

#[wasm_bindgen]
pub fn spatial_query_enemy_units_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius, radius_sq,
                    exclude_player, false, false, false,
                );
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    count
}

#[wasm_bindgen]
pub fn spatial_query_enemy_projectiles_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.projectiles {
                spatial_push_enemy_projectile_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius_sq, exclude_player,
                );
            }
        }
    }
    let count = buf.len() as u32;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    count
}

#[wasm_bindgen]
pub fn spatial_query_enemy_units_and_projectiles_in_radius(
    x: f64, y: f64, z: f64, radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);  // n_units
    state.scratch_u32.push(0);  // n_projectiles
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius, radius_sq,
                    exclude_player, false, false, false,
                );
            }
        }
    }
    let n_units = (buf.len() - unit_start) as u32;
    let proj_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.projectiles {
                spatial_push_enemy_projectile_if_in_radius(
                    state, &mut buf, slot, x, y, z, radius_sq, exclude_player,
                );
            }
        }
    }
    let n_projectiles = (buf.len() - proj_start) as u32;
    buf[0] = n_units;
    buf[1] = n_projectiles;
    state.scratch_u32 = buf;
    state.nearby_cells = nearby;
    (2 + n_units + n_projectiles) as u32
}

// ===================== Capture / debug queries =====================

/// Emits captureResult into scratch_u32 as a flat header-prefixed
/// stream: [n_cells, (key_i32, n_players, p0, p1, ...) per cell].
/// Caller reads slot 0 = cell count, then walks each cell's prefix.
#[wasm_bindgen]
pub fn spatial_query_occupied_cells_for_capture() -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    // Reserve header slot for n_cells.
    state.scratch_u32.push(0);
    let mut n_cells = 0u32;
    let cells_iter: Vec<&SpatialCaptureCell> = state.capture_by_cell.values().collect();
    let mut buf = std::mem::take(&mut state.scratch_u32);
    for cell in cells_iter {
        if cell.players.is_empty() { continue; }
        buf.push(cell.key as u32);
        buf.push(cell.players.len() as u32);
        for &p in &cell.players {
            buf.push(p as u32);
        }
        n_cells += 1;
    }
    buf[0] = n_cells;
    let len = buf.len() as u32;
    state.scratch_u32 = buf;
    len
}

/// Emits occupied-cells debug info as
/// [n_cells, (cx, cy, cz, n_players, p0, p1, ...) per cell]
/// where (cx, cy, cz) are SIGNED 32-bit cell indices and n_players
/// counts UNIQUE player ids only (matches getOccupiedCells in TS).
#[wasm_bindgen]
pub fn spatial_query_occupied_cells_debug() -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);
    let mut n_cells = 0u32;
    let cells_iter: Vec<(u64, &SpatialCellBucket)> = state.cells.iter().map(|(k, v)| (*k, v)).collect();
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut seen_players: std::collections::HashSet<u8> = std::collections::HashSet::new();
    for (key, bucket) in cells_iter {
        if bucket.units.is_empty() { continue; }
        seen_players.clear();
        for &slot in &bucket.units {
            let owner = state.slot_owner_player[slot as usize];
            if owner != 0 {
                seen_players.insert(owner);
            }
        }
        if seen_players.is_empty() { continue; }
        // Unpack cube key.
        let czb = (key & 0xFFFF) as i64;
        let cyb = ((key >> 16) & 0xFFFF) as i64;
        let cxb = ((key >> 32) & 0xFFFF) as i64;
        let cx = (cxb - CONTACT_CELL_BIAS) as i32;
        let cy = (cyb - CONTACT_CELL_BIAS) as i32;
        let cz = (czb - CONTACT_CELL_BIAS) as i32;
        buf.push(cx as u32);
        buf.push(cy as u32);
        buf.push(cz as u32);
        buf.push(seen_players.len() as u32);
        for p in &seen_players {
            buf.push(*p as u32);
        }
        n_cells += 1;
    }
    buf[0] = n_cells;
    let len = buf.len() as u32;
    state.scratch_u32 = buf;
    len
}

// ===================== Result buffer access =====================

#[wasm_bindgen]
pub fn spatial_scratch_ptr() -> *const u32 {
    spatial_grid().scratch_u32.as_ptr()
}

#[wasm_bindgen]
pub fn spatial_scratch_len() -> u32 {
    spatial_grid().scratch_u32.len() as u32
}

// ===================== Per-slot getters (for the rare in-JS consumer) =====================

#[wasm_bindgen]
pub fn spatial_slot_kind(slot: u32) -> u8 {
    let state = spatial_grid();
    if (slot as usize) >= state.slot_kind.len() { return SPATIAL_KIND_UNSET; }
    state.slot_kind[slot as usize]
}

// ─────────────────────────────────────────────────────────────────
//  Phase 9 — Pathfinder: A* over the build/walk grid in WASM
//
//  Mirrors src/game/sim/Pathfinder.ts. Full pipeline (ensureMaskAndCC,
//  snap-to-component, A*, Bresenham LOS smoothing) runs inside one
//  WASM call. JS-side Pathfinder.ts becomes a thin wrapper that
//  forwards (start, goal, mapWidth, mapHeight, buildingGrid.occupiedCells,
//  terrainFilter) and reads the smoothed waypoint scratch.
//
//  Mask + CC are cached internally; JS passes the terrain + building
//  version pair on each call, the Rust side rebuilds only when the
//  pair changes.
//
//  Terrain sampling reads directly from the in-WASM TerrainGrid
//  (Phase 8) — no boundary crossings during a rebuild. ~9 k cells in
//  a typical map; each one previously required 2 WASM dispatches
//  (height + normal), now it's all-in-Rust.
// ─────────────────────────────────────────────────────────────────

// Constants — kept in sync with Pathfinder.ts.
const PATHFINDER_BUILD_GRID_CELL_SIZE: f64 = 20.0;
const PATHFINDER_TERRAIN_INFLATION_CELLS: i32 = 2;
const PATHFINDER_BUILDING_INFLATION_CELLS: i32 = 1;
const PATHFINDER_SLOPE_BLOCK_NZ: f32 = 0.34;
const PATHFINDER_SNAP_RADIUS_CELLS: i32 = 32;
const PATHFINDER_MAX_A_STAR_NODES: u32 = 50_000;
const PATHFINDER_SQRT2: f32 = 1.4142135623730951;
const PATHFINDER_SQRT2_MINUS_1: f32 = 0.41421356237309515;

struct PathfinderState {
    grid_w: i32,
    grid_h: i32,
    n: usize,
    map_width: f64,
    map_height: f64,

    blocked: Vec<u8>,
    terrain_blocked: Vec<u8>,
    terrain_normal_z: Vec<f32>,
    cc_labels: Vec<i16>,

    // A* scratch (reused per query)
    g_score: Vec<f32>,
    f_score: Vec<f32>,
    parent: Vec<i32>,
    closed: Vec<u8>,
    heap: Vec<u32>,
    // BFS scratch
    bfs_queue: Vec<u32>,

    // Cache keys — invalidated on terrain/building/grid-dim change.
    terrain_only_key: u64,  // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH
    full_mask_key: u128,    // = tVer | bVer | gridW | gridH

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
}

impl PathfinderState {
    fn empty() -> Self {
        Self {
            grid_w: 0, grid_h: 0, n: 0,
            map_width: 0.0, map_height: 0.0,
            blocked: Vec::new(),
            terrain_blocked: Vec::new(),
            terrain_normal_z: Vec::new(),
            cc_labels: Vec::new(),
            g_score: Vec::new(),
            f_score: Vec::new(),
            parent: Vec::new(),
            closed: Vec::new(),
            heap: Vec::new(),
            bfs_queue: Vec::new(),
            terrain_only_key: u64::MAX,
            full_mask_key: u128::MAX,
            snap_offsets: Vec::new(),
            waypoint_scratch: Vec::new(),
        }
    }
}

struct PathfinderHolder(UnsafeCell<Option<PathfinderState>>);
unsafe impl Sync for PathfinderHolder {}
static PATHFINDER: PathfinderHolder = PathfinderHolder(UnsafeCell::new(None));

#[inline]
fn pathfinder_state() -> &'static mut PathfinderState {
    unsafe {
        let cell = &mut *PATHFINDER.0.get();
        if cell.is_none() {
            *cell = Some(PathfinderState::empty());
        }
        cell.as_mut().unwrap()
    }
}

fn pathfinder_build_snap_offsets(state: &mut PathfinderState) {
    let r = PATHFINDER_SNAP_RADIUS_CELLS;
    let mut list: Vec<(i16, i16, i32)> = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if dx == 0 && dy == 0 { continue; }
            let d2 = dx * dx + dy * dy;
            if d2 > r * r { continue; }
            list.push((dx as i16, dy as i16, d2));
        }
    }
    list.sort_by_key(|&(_, _, d2)| d2);
    state.snap_offsets.clear();
    state.snap_offsets.reserve(list.len());
    for (dx, dy, _) in list {
        state.snap_offsets.push((dx, dy));
    }
}

#[wasm_bindgen]
pub fn pathfinder_init(map_width: f64, map_height: f64) {
    let state = pathfinder_state();
    let grid_w = (map_width / PATHFINDER_BUILD_GRID_CELL_SIZE).ceil() as i32;
    let grid_h = (map_height / PATHFINDER_BUILD_GRID_CELL_SIZE).ceil() as i32;
    let n = (grid_w * grid_h) as usize;
    if state.grid_w == grid_w && state.grid_h == grid_h && state.n == n {
        // Same dims — just invalidate caches so the next rebuild fires.
        state.terrain_only_key = u64::MAX;
        state.full_mask_key = u128::MAX;
        state.map_width = map_width;
        state.map_height = map_height;
        return;
    }
    state.grid_w = grid_w;
    state.grid_h = grid_h;
    state.n = n;
    state.map_width = map_width;
    state.map_height = map_height;
    state.blocked.clear(); state.blocked.resize(n, 0);
    state.terrain_blocked.clear(); state.terrain_blocked.resize(n, 0);
    state.terrain_normal_z.clear(); state.terrain_normal_z.resize(n, 1.0);
    state.cc_labels.clear(); state.cc_labels.resize(n, 0);
    state.g_score.clear(); state.g_score.resize(n, f32::INFINITY);
    state.f_score.clear(); state.f_score.resize(n, f32::INFINITY);
    state.parent.clear(); state.parent.resize(n, -1);
    state.closed.clear(); state.closed.resize(n, 0);
    state.heap.clear();
    state.bfs_queue.clear(); state.bfs_queue.resize(n, 0);
    state.terrain_only_key = u64::MAX;
    state.full_mask_key = u128::MAX;
    pathfinder_build_snap_offsets(state);
}

/// Sample raw terrain mesh height + surface normal nz at world (x, y).
/// Mirrors getTerrainMeshHeight + getSurfaceNormal.nz used in
/// Pathfinder.ts ensureTerrainBlocked. Returns (height, nz). If the
/// terrain isn't installed or the sample degenerates, returns
/// (water_level + 1, 1.0) so the cell is treated as flat dry land
/// (best-effort — caller is responsible for terrain bootstrap order).
#[inline]
fn pathfinder_sample_terrain(x: f64, y: f64) -> (f64, f32) {
    let t = terrain_grid();
    if !t.installed {
        return (TERRAIN_WATER_LEVEL + 1.0, 1.0);
    }
    let (px, pz, cell_x, cell_y) = terrain_clamp_to_cell(t, x, y);
    let sample = match terrain_triangle_sample_at(t, px, pz, cell_x, cell_y) {
        Some(s) => s,
        None => return (TERRAIN_WATER_LEVEL + 1.0, 1.0),
    };
    let (wa, wb, wc, ax, az, ah, bx, bz, bh, cx, cz, ch) = sample;
    let h = wa * ah + wb * bh + wc * ch;
    if h < TERRAIN_WATER_LEVEL {
        // Below water — normal.nz unused (water-check blocks first).
        return (h, 0.0);
    }
    // Triangle normal — same math as terrain_get_surface_normal.
    let ux = bx - ax;
    let uy = bh - ah;
    let uz = bz - az;
    let vx_ = cx - ax;
    let vy = ch - ah;
    let vz = cz - az;
    let mut nx = uy * vz - uz * vy;
    let mut vertical = uz * vx_ - ux * vz;
    let mut nz = ux * vy - uy * vx_;
    if vertical < 0.0 {
        nx = -nx;
        vertical = -vertical;
        nz = -nz;
    }
    let _ = nx;
    let _ = nz;
    let len_sq = nx * nx + vertical * vertical + nz * nz;
    let len = if len_sq > 0.0 { len_sq.sqrt() } else { 1.0 };
    let normal_z = (vertical / len) as f32;
    (h, normal_z)
}

fn pathfinder_rebuild_terrain_mask(state: &mut PathfinderState, terrain_version: u32) {
    let key = ((terrain_version as u64) << 32) | ((state.grid_w as u64) << 16) | (state.grid_h as u64);
    if key == state.terrain_only_key { return; }

    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;
    let cs = PATHFINDER_BUILD_GRID_CELL_SIZE;
    let slope_block = PATHFINDER_SLOPE_BLOCK_NZ;

    // Step 1 — water + slope mask at cell centres.
    let mut terrain_mask: Vec<u8> = vec![0u8; n];
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let idx = (gy * grid_w + gx) as usize;
            let cx = (gx as f64 + 0.5) * cs;
            let cy = (gy as f64 + 0.5) * cs;
            let (h, nz) = pathfinder_sample_terrain(cx, cy);
            let blk = if h < TERRAIN_WATER_LEVEL {
                state.terrain_normal_z[idx] = 0.0;
                true
            } else {
                state.terrain_normal_z[idx] = nz;
                nz < slope_block
            };
            terrain_mask[idx] = if blk { 1 } else { 0 };
        }
    }

    // Step 2 — dilate by TERRAIN_INFLATION_CELLS into terrain_blocked.
    // Map-edge cells within `tk` of any border are blocked.
    let tk = PATHFINDER_TERRAIN_INFLATION_CELLS;
    for cell in state.terrain_blocked.iter_mut() { *cell = 0; }
    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let out_idx = (gy * grid_w + gx) as usize;
            if gx < tk || gy < tk || gx >= grid_w - tk || gy >= grid_h - tk {
                state.terrain_blocked[out_idx] = 1;
                continue;
            }
            let mut blk = 0u8;
            'stencil: for dy in -tk..=tk {
                let row = (gy + dy) * grid_w;
                for dx in -tk..=tk {
                    if terrain_mask[(row + gx + dx) as usize] == 1 {
                        blk = 1;
                        break 'stencil;
                    }
                }
            }
            state.terrain_blocked[out_idx] = blk;
        }
    }

    state.terrain_only_key = key;
}

/// Rebuilds the full blocked mask + CC labels from the terrain mask
/// + a flat list of building-occupied cells (gx, gy pairs interleaved).
/// `terrain_version` + `building_version` are passed by JS so the
/// rebuild can short-circuit when nothing has changed.
#[wasm_bindgen]
pub fn pathfinder_rebuild_mask_and_cc(
    building_cells: &[u32],
    terrain_version: u32,
    building_version: u32,
) {
    let state = pathfinder_state();
    pathfinder_rebuild_terrain_mask(state, terrain_version);

    // Cache key over (tVer, bVer, gridW, gridH).
    let key = ((terrain_version as u128) << 96)
        | ((building_version as u128) << 64)
        | ((state.grid_w as u128) << 32)
        | (state.grid_h as u128);
    if key == state.full_mask_key { return; }

    // Start from cached terrain mask.
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    state.blocked.copy_from_slice(&state.terrain_blocked);

    // Building dilation by BUILDING_INFLATION_CELLS.
    let bk = PATHFINDER_BUILDING_INFLATION_CELLS;
    let mut i = 0usize;
    while i + 1 < building_cells.len() {
        let gx = building_cells[i] as i32;
        let gy = building_cells[i + 1] as i32;
        i += 2;
        for dy in -bk..=bk {
            let ny = gy + dy;
            if ny < 0 || ny >= grid_h { continue; }
            let row = ny * grid_w;
            for dx in -bk..=bk {
                let nx = gx + dx;
                if nx < 0 || nx >= grid_w { continue; }
                state.blocked[(row + nx) as usize] = 1;
            }
        }
    }

    // CC labelling via BFS over open cells.
    state.cc_labels.fill(0);
    let mut next_label: i16 = 1;
    for seed in 0..state.n {
        if state.blocked[seed] == 1 || state.cc_labels[seed] != 0 { continue; }
        if next_label > 32_000 { break; }
        state.cc_labels[seed] = next_label;
        let mut q_head = 0usize;
        let mut q_tail = 0usize;
        state.bfs_queue[q_tail] = seed as u32;
        q_tail += 1;
        while q_head < q_tail {
            let idx = state.bfs_queue[q_head] as i32;
            q_head += 1;
            let cgx = idx % grid_w;
            let cgy = (idx - cgx) / grid_w;
            for dy in -1..=1 {
                let ny = cgy + dy;
                if ny < 0 || ny >= grid_h { continue; }
                let row = ny * grid_w;
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = cgx + dx;
                    if nx < 0 || nx >= grid_w { continue; }
                    let nidx = (row + nx) as usize;
                    if state.blocked[nidx] == 1 || state.cc_labels[nidx] != 0 { continue; }
                    state.cc_labels[nidx] = next_label;
                    state.bfs_queue[q_tail] = nidx as u32;
                    q_tail += 1;
                }
            }
        }
        next_label += 1;
    }

    state.full_mask_key = key;
}

#[inline]
fn pathfinder_is_cell_passable(state: &PathfinderState, idx: usize, min_normal_z: f32) -> bool {
    if state.blocked[idx] == 1 { return false; }
    if min_normal_z <= 0.0 { return true; }
    state.terrain_normal_z[idx] >= min_normal_z
}

#[inline]
fn pathfinder_is_grid_cell_passable(state: &PathfinderState, gx: i32, gy: i32, min_normal_z: f32) -> bool {
    if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h { return false; }
    pathfinder_is_cell_passable(state, (gy * state.grid_w + gx) as usize, min_normal_z)
}

fn pathfinder_find_nearest_open(
    state: &PathfinderState,
    gx: i32, gy: i32,
    min_normal_z: f32,
) -> Option<(i32, i32)> {
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h { continue; }
        if pathfinder_is_cell_passable(state, (ny * state.grid_w + nx) as usize, min_normal_z) {
            return Some((nx, ny));
        }
    }
    None
}

fn pathfinder_find_nearest_in_component(
    state: &PathfinderState,
    gx: i32, gy: i32,
    component: i16,
    min_normal_z: f32,
) -> Option<(i32, i32)> {
    if component <= 0 { return None; }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    // Fast snap-radius scan first.
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h { continue; }
        let idx = (ny * grid_w + nx) as usize;
        if state.cc_labels[idx] == component
            && pathfinder_is_cell_passable(state, idx, min_normal_z)
        {
            return Some((nx, ny));
        }
    }
    // Full component scan fallback — for goals beyond snap radius.
    let mut best: Option<(i32, i32, i32)> = None;
    for ny in 0..grid_h {
        let row = ny * grid_w;
        let dy = ny - gy;
        for nx in 0..grid_w {
            let idx = (row + nx) as usize;
            if state.cc_labels[idx] != component { continue; }
            if !pathfinder_is_cell_passable(state, idx, min_normal_z) { continue; }
            let dx = nx - gx;
            let d2 = dx * dx + dy * dy;
            if best.map_or(true, |(_, _, bd)| d2 < bd) {
                best = Some((nx, ny, d2));
            }
        }
    }
    best.map(|(x, y, _)| (x, y))
}

#[inline]
fn pathfinder_octile(ax: i32, ay: i32, bx: i32, by: i32) -> f32 {
    let dx = (ax - bx).abs() as f32;
    let dy = (ay - by).abs() as f32;
    dx.max(dy) + PATHFINDER_SQRT2_MINUS_1 * dx.min(dy)
}

fn pathfinder_heap_push(state: &mut PathfinderState, idx: u32) {
    state.heap.push(idx);
    let mut i = state.heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if state.f_score[state.heap[i] as usize] < state.f_score[state.heap[p] as usize] {
            state.heap.swap(i, p);
            i = p;
        } else {
            break;
        }
    }
}

fn pathfinder_heap_pop(state: &mut PathfinderState) -> u32 {
    let top = state.heap[0];
    let last = state.heap.pop().unwrap();
    let len = state.heap.len();
    if len > 0 {
        state.heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = (i << 1) + 1;
            let r = l + 1;
            let mut s = i;
            if l < len && state.f_score[state.heap[l] as usize] < state.f_score[state.heap[s] as usize] {
                s = l;
            }
            if r < len && state.f_score[state.heap[r] as usize] < state.f_score[state.heap[s] as usize] {
                s = r;
            }
            if s == i { break; }
            state.heap.swap(i, s);
            i = s;
        }
    }
    top
}

const PATHFINDER_NEIGHBOR_DX: [i32; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
const PATHFINDER_NEIGHBOR_DY: [i32; 8] = [0, 0, 1, -1, 1, -1, 1, -1];
// Neighbour costs: 1.0 for cardinal, SQRT2 for diagonal.
const PATHFINDER_NEIGHBOR_COST: [f32; 8] = [
    1.0, 1.0, 1.0, 1.0,
    PATHFINDER_SQRT2, PATHFINDER_SQRT2, PATHFINDER_SQRT2, PATHFINDER_SQRT2,
];

struct AStarResult {
    cells: Vec<u32>,   // sequence of cell indices from start to goal (excluding start)
    goal_gx: i32,
    goal_gy: i32,
    reached_goal: bool,
}

fn pathfinder_a_star(
    state: &mut PathfinderState,
    start_gx: i32, start_gy: i32,
    goal_gx: i32, goal_gy: i32,
    min_normal_z: f32,
) -> Option<AStarResult> {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;
    // Reset scratch.
    for v in state.g_score.iter_mut() { *v = f32::INFINITY; }
    for v in state.f_score.iter_mut() { *v = f32::INFINITY; }
    for v in state.parent.iter_mut() { *v = -1; }
    for v in state.closed.iter_mut() { *v = 0; }
    state.heap.clear();

    let start_idx = (start_gy * grid_w + start_gx) as usize;
    let goal_idx = (goal_gy * grid_w + goal_gx) as u32;
    state.g_score[start_idx] = 0.0;
    state.f_score[start_idx] = pathfinder_octile(start_gx, start_gy, goal_gx, goal_gy);
    pathfinder_heap_push(state, start_idx as u32);

    let mut best_idx = start_idx as u32;
    let mut best_d2 = {
        let dx = start_gx - goal_gx;
        let dy = start_gy - goal_gy;
        dx * dx + dy * dy
    };
    let mut expanded = 0u32;
    let mut found = false;
    while !state.heap.is_empty() && expanded < PATHFINDER_MAX_A_STAR_NODES {
        let cur = pathfinder_heap_pop(state);
        let cur_us = cur as usize;
        if state.closed[cur_us] != 0 { continue; }
        state.closed[cur_us] = 1;
        expanded += 1;
        if cur == goal_idx { found = true; break; }

        let cur_i32 = cur as i32;
        let cgx = cur_i32 % grid_w;
        let cgy = (cur_i32 - cgx) / grid_w;
        for k in 0..8 {
            let nx = cgx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = cgy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h { continue; }
            let nidx = (ny * grid_w + nx) as usize;
            if !pathfinder_is_cell_passable(state, nidx, min_normal_z) { continue; }
            if state.closed[nidx] != 0 { continue; }
            let tentative = state.g_score[cur_us] + PATHFINDER_NEIGHBOR_COST[k];
            if tentative < state.g_score[nidx] {
                state.parent[nidx] = cur as i32;
                state.g_score[nidx] = tentative;
                state.f_score[nidx] = tentative + pathfinder_octile(nx, ny, goal_gx, goal_gy);
                let dx = nx - goal_gx;
                let dy = ny - goal_gy;
                let d2 = dx * dx + dy * dy;
                if d2 < best_d2 {
                    best_d2 = d2;
                    best_idx = nidx as u32;
                }
                pathfinder_heap_push(state, nidx as u32);
            }
        }
    }
    let _ = n;

    let target = if found { goal_idx } else { best_idx };
    let mut path: Vec<u32> = Vec::new();
    let mut walker = target as i32;
    while walker != start_idx as i32 && walker != -1 {
        path.push(walker as u32);
        walker = state.parent[walker as usize];
    }
    // If parent chain didn't reach start, target is unreachable from
    // start in the discovered subgraph — treat as no path.
    if !path.is_empty() && state.parent[*path.last().unwrap() as usize] == -1
        && (*path.last().unwrap() as i32) != start_idx as i32
    {
        // Final node has no parent and isn't start — unreachable.
        // (Matches the JS check `parent[path[last]] === -1`.)
        return None;
    }
    path.reverse();
    let gx = (target as i32) % grid_w;
    let gy = ((target as i32) - gx) / grid_w;
    Some(AStarResult {
        cells: path,
        goal_gx: gx,
        goal_gy: gy,
        reached_goal: found,
    })
}

/// Supercover Bresenham LOS — true iff every cell crossed is unblocked.
fn pathfinder_has_los(
    state: &PathfinderState,
    x0: f64, y0: f64,
    x1: f64, y1: f64,
    min_normal_z: f32,
) -> bool {
    let mut gx = (x0 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let mut gy = (y0 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let tgx = (x1 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let tgy = (y1 / PATHFINDER_BUILD_GRID_CELL_SIZE).floor() as i32;
    let sx = if gx < tgx { 1 } else { -1 };
    let sy = if gy < tgy { 1 } else { -1 };
    let dx = (tgx - gx).abs();
    let dy = (tgy - gy).abs();
    let mut err = dx - dy;
    let max_steps = dx + dy + 2;
    for _ in 0..max_steps {
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h { return false; }
        if !pathfinder_is_grid_cell_passable(state, gx, gy, min_normal_z) { return false; }
        if gx == tgx && gy == tgy { return true; }
        let e2 = 2 * err;
        let a_x = e2 > -dy;
        let a_y = e2 < dx;
        if a_x && a_y {
            if !pathfinder_is_grid_cell_passable(state, gx + sx, gy, min_normal_z) { return false; }
            if !pathfinder_is_grid_cell_passable(state, gx, gy + sy, min_normal_z) { return false; }
        }
        if a_x { err -= dy; gx += sx; }
        if a_y { err += dx; gy += sy; }
    }
    false
}

#[inline]
fn pathfinder_cell_center(gx: i32, gy: i32) -> (f64, f64) {
    (
        (gx as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
        (gy as f64 + 0.5) * PATHFINDER_BUILD_GRID_CELL_SIZE,
    )
}

/// Plan a path from (start_x, start_y) to (goal_x, goal_y).
/// `min_normal_z` is the per-unit slope filter (0 = no filter,
/// matches normalizeMinSurfaceNormalZ returning undefined in JS).
/// Smoothed waypoints land in `waypoint_scratch` as interleaved
/// (x, y) f64 pairs; returns the waypoint count.
///
/// Note: caller must have run pathfinder_init + pathfinder_rebuild_mask_and_cc
/// for the current terrain/building state before calling this.
#[wasm_bindgen]
pub fn pathfinder_find_path(
    start_x: f64, start_y: f64,
    goal_x: f64, goal_y: f64,
    min_normal_z: f32,
) -> u32 {
    let state = pathfinder_state();
    state.waypoint_scratch.clear();
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    if grid_w == 0 || grid_h == 0 {
        // Not initialised — fall back to direct line.
        state.waypoint_scratch.push(start_x);
        state.waypoint_scratch.push(start_y);
        return 1;
    }

    let cs = PATHFINDER_BUILD_GRID_CELL_SIZE;
    let sgx = ((start_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let sgy = ((start_y / cs).floor() as i32).max(0).min(grid_h - 1);
    let ggx = ((goal_x / cs).floor() as i32).max(0).min(grid_w - 1);
    let ggy = ((goal_y / cs).floor() as i32).max(0).min(grid_h - 1);

    // Snap blocked start.
    let mut start_cell_gx = sgx;
    let mut start_cell_gy = sgy;
    let mut start_was_snapped = false;
    if !pathfinder_is_cell_passable(state, (sgy * grid_w + sgx) as usize, min_normal_z) {
        match pathfinder_find_nearest_open(state, sgx, sgy, min_normal_z) {
            Some((nx, ny)) => {
                start_cell_gx = nx;
                start_cell_gy = ny;
                start_was_snapped = true;
            }
            None => {
                // No open cell anywhere near start — return single waypoint at start.
                state.waypoint_scratch.push(start_x);
                state.waypoint_scratch.push(start_y);
                return 1;
            }
        }
    }

    // Snap goal to start's component.
    let start_label = state.cc_labels[(start_cell_gy * grid_w + start_cell_gx) as usize];
    let mut goal_cell_gx = ggx;
    let mut goal_cell_gy = ggy;
    let mut goal_was_snapped = false;
    let ggy_idx = (ggy * grid_w + ggx) as usize;
    if state.cc_labels[ggy_idx] != start_label
        || !pathfinder_is_cell_passable(state, ggy_idx, min_normal_z)
    {
        match pathfinder_find_nearest_in_component(state, ggx, ggy, start_label, min_normal_z) {
            Some((nx, ny)) => {
                goal_cell_gx = nx;
                goal_cell_gy = ny;
                goal_was_snapped = true;
            }
            None => {
                state.waypoint_scratch.push(start_x);
                state.waypoint_scratch.push(start_y);
                return 1;
            }
        }
    }

    // Same cell after snapping — no A* needed.
    if start_cell_gx == goal_cell_gx && start_cell_gy == goal_cell_gy {
        if goal_was_snapped {
            let (cx, cy) = pathfinder_cell_center(goal_cell_gx, goal_cell_gy);
            state.waypoint_scratch.push(cx);
            state.waypoint_scratch.push(cy);
        } else {
            state.waypoint_scratch.push(goal_x);
            state.waypoint_scratch.push(goal_y);
        }
        return 1;
    }

    let a_star_result = match pathfinder_a_star(
        state, start_cell_gx, start_cell_gy, goal_cell_gx, goal_cell_gy, min_normal_z,
    ) {
        Some(r) => r,
        None => {
            state.waypoint_scratch.push(start_x);
            state.waypoint_scratch.push(start_y);
            return 1;
        }
    };

    if !a_star_result.reached_goal {
        goal_cell_gx = a_star_result.goal_gx;
        goal_cell_gy = a_star_result.goal_gy;
        goal_was_snapped = true;
        if start_cell_gx == goal_cell_gx && start_cell_gy == goal_cell_gy {
            if start_was_snapped {
                let (cx, cy) = pathfinder_cell_center(start_cell_gx, start_cell_gy);
                state.waypoint_scratch.push(cx);
                state.waypoint_scratch.push(cy);
            } else {
                state.waypoint_scratch.push(start_x);
                state.waypoint_scratch.push(start_y);
            }
            return 1;
        }
    }
    let cell_path = a_star_result.cells;

    // String-pull LOS smoothing.
    let mut anchor_x: f64;
    let mut anchor_y: f64;
    if start_was_snapped {
        let (cx, cy) = pathfinder_cell_center(start_cell_gx, start_cell_gy);
        state.waypoint_scratch.push(cx);
        state.waypoint_scratch.push(cy);
        anchor_x = cx;
        anchor_y = cy;
    } else {
        anchor_x = start_x;
        anchor_y = start_y;
    }
    let path_len = cell_path.len();
    if path_len > 1 {
        for i in 0..path_len - 1 {
            let cand_idx = cell_path[i] as i32;
            let next_idx = cell_path[i + 1] as i32;
            let cgx = cand_idx % grid_w;
            let cgy = (cand_idx - cgx) / grid_w;
            let ngx = next_idx % grid_w;
            let ngy = (next_idx - ngx) / grid_w;
            let (cand_x, cand_y) = pathfinder_cell_center(cgx, cgy);
            let (next_x, next_y) = pathfinder_cell_center(ngx, ngy);
            if !pathfinder_has_los(state, anchor_x, anchor_y, next_x, next_y, min_normal_z) {
                state.waypoint_scratch.push(cand_x);
                state.waypoint_scratch.push(cand_y);
                anchor_x = cand_x;
                anchor_y = cand_y;
            }
        }
    }
    if goal_was_snapped {
        let (cx, cy) = pathfinder_cell_center(goal_cell_gx, goal_cell_gy);
        state.waypoint_scratch.push(cx);
        state.waypoint_scratch.push(cy);
    } else {
        state.waypoint_scratch.push(goal_x);
        state.waypoint_scratch.push(goal_y);
    }
    (state.waypoint_scratch.len() / 2) as u32
}

#[wasm_bindgen]
pub fn pathfinder_waypoints_ptr() -> *const f64 {
    pathfinder_state().waypoint_scratch.as_ptr()
}

#[wasm_bindgen]
pub fn pathfinder_grid_size_w() -> i32 {
    pathfinder_state().grid_w
}

#[wasm_bindgen]
pub fn pathfinder_grid_size_h() -> i32 {
    pathfinder_state().grid_h
}

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.2 — Hand-rolled MessagePack encoder
//
//  Foundation building block for the future snapshot-serializer
//  port. Encodes the exact subset of MessagePack used by
//  @msgpack/msgpack with `ignoreUndefined: true` (the encoder
//  settings in NetworkSnapshotTransport.ts):
//    - nil (0xC0), false (0xC2), true (0xC3)
//    - positive fixint, negative fixint
//    - uint8/16/32, int8/16/32, int64 (only emitted when value
//      doesn't fit a smaller representation — same as the JS lib)
//    - float32, float64 (we always emit f64 to match JS Number
//      semantics; the JS lib does the same)
//    - fixstr, str8/16/32 (UTF-8 byte length)
//    - fixarray, array16, array32
//    - fixmap, map16, map32
//    - bin8/16/32 (for Uint8Array payloads)
//
//  The encoder writes into a caller-owned Vec<u8>. Subsequent
//  Phase 10 sub-commits will plumb this into a per-recipient
//  snapshot build that produces the final WebRTC bytes in one
//  WASM call.
//
//  Self-test: messagepack_self_test() runs a battery of known-
//  output encodings and returns 0 on pass, a bitmask of failed
//  test ids otherwise. Called once at module load by JS-side
//  initSimWasm so any encoder regression surfaces immediately.
// ─────────────────────────────────────────────────────────────────

struct MessagePackWriter {
    buf: Vec<u8>,
}

impl MessagePackWriter {
    #[allow(dead_code)]
    fn new() -> Self {
        Self { buf: Vec::with_capacity(64) }
    }

    fn with_capacity(cap: usize) -> Self {
        Self { buf: Vec::with_capacity(cap) }
    }

    fn clear(&mut self) {
        self.buf.clear();
    }

    fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    fn len(&self) -> usize {
        self.buf.len()
    }

    fn write_nil(&mut self) {
        self.buf.push(0xC0);
    }

    fn write_bool(&mut self, v: bool) {
        self.buf.push(if v { 0xC3 } else { 0xC2 });
    }

    /// JS Number → MessagePack. Mirrors the integer-detection branch
    /// in @msgpack/msgpack: if the value is a finite integer in
    /// [INT64_MIN, UINT64_MAX], emit the smallest int encoding; else
    /// emit float64. JS doesn't distinguish Int from Float at runtime
    /// so we have to inspect the value.
    fn write_number(&mut self, v: f64) {
        if !v.is_finite() {
            self.write_f64(v);
            return;
        }
        // Integer if v fits exactly in i64/u64 AND has no fractional
        // part. JS msgpack treats `1.0` as an integer.
        if v.fract() == 0.0 && v >= -9_223_372_036_854_775_808.0 && v <= 18_446_744_073_709_551_615.0 {
            // Use u64 path for non-negative >= 2^63 (above i64 range).
            if v >= 0.0 {
                let u = v as u64;
                self.write_uint(u);
                return;
            }
            let i = v as i64;
            self.write_int(i);
            return;
        }
        self.write_f64(v);
    }

    fn write_uint(&mut self, v: u64) {
        if v < 128 {
            // positive fixint
            self.buf.push(v as u8);
        } else if v <= 0xFF {
            self.buf.push(0xCC);
            self.buf.push(v as u8);
        } else if v <= 0xFFFF {
            self.buf.push(0xCD);
            self.buf.extend_from_slice(&(v as u16).to_be_bytes());
        } else if v <= 0xFFFF_FFFF {
            self.buf.push(0xCE);
            self.buf.extend_from_slice(&(v as u32).to_be_bytes());
        } else {
            self.buf.push(0xCF);
            self.buf.extend_from_slice(&v.to_be_bytes());
        }
    }

    fn write_int(&mut self, v: i64) {
        if v >= 0 {
            self.write_uint(v as u64);
            return;
        }
        if v >= -32 {
            // negative fixint
            self.buf.push((v as i8) as u8);
        } else if v >= -128 {
            self.buf.push(0xD0);
            self.buf.push((v as i8) as u8);
        } else if v >= -32_768 {
            self.buf.push(0xD1);
            self.buf.extend_from_slice(&(v as i16).to_be_bytes());
        } else if v >= -2_147_483_648 {
            self.buf.push(0xD2);
            self.buf.extend_from_slice(&(v as i32).to_be_bytes());
        } else {
            self.buf.push(0xD3);
            self.buf.extend_from_slice(&v.to_be_bytes());
        }
    }

    fn write_f64(&mut self, v: f64) {
        self.buf.push(0xCB);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    #[allow(dead_code)]
    fn write_f32(&mut self, v: f32) {
        self.buf.push(0xCA);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    fn write_str(&mut self, s: &str) {
        let bytes = s.as_bytes();
        let len = bytes.len();
        if len < 32 {
            self.buf.push(0xA0 | len as u8);
        } else if len <= 0xFF {
            self.buf.push(0xD9);
            self.buf.push(len as u8);
        } else if len <= 0xFFFF {
            self.buf.push(0xDA);
            self.buf.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            self.buf.push(0xDB);
            self.buf.extend_from_slice(&(len as u32).to_be_bytes());
        }
        self.buf.extend_from_slice(bytes);
    }

    fn write_array_header(&mut self, n: usize) {
        if n < 16 {
            self.buf.push(0x90 | n as u8);
        } else if n <= 0xFFFF {
            self.buf.push(0xDC);
            self.buf.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            self.buf.push(0xDD);
            self.buf.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    fn write_map_header(&mut self, n: usize) {
        if n < 16 {
            self.buf.push(0x80 | n as u8);
        } else if n <= 0xFFFF {
            self.buf.push(0xDE);
            self.buf.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            self.buf.push(0xDF);
            self.buf.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    #[allow(dead_code)]
    fn write_bin(&mut self, bytes: &[u8]) {
        let len = bytes.len();
        if len <= 0xFF {
            self.buf.push(0xC4);
            self.buf.push(len as u8);
        } else if len <= 0xFFFF {
            self.buf.push(0xC5);
            self.buf.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            self.buf.push(0xC6);
            self.buf.extend_from_slice(&(len as u32).to_be_bytes());
        }
        self.buf.extend_from_slice(bytes);
    }
}

// Module-scope writer reused by the self-test + future encoders.
struct MessagePackHolder(UnsafeCell<Option<MessagePackWriter>>);
unsafe impl Sync for MessagePackHolder {}
static MESSAGEPACK_WRITER: MessagePackHolder = MessagePackHolder(UnsafeCell::new(None));

#[inline]
fn messagepack_writer() -> &'static mut MessagePackWriter {
    unsafe {
        let cell = &mut *MESSAGEPACK_WRITER.0.get();
        if cell.is_none() {
            *cell = Some(MessagePackWriter::with_capacity(4096));
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn messagepack_writer_ptr() -> *const u8 {
    messagepack_writer().buf.as_ptr()
}

#[wasm_bindgen]
pub fn messagepack_writer_len() -> u32 {
    messagepack_writer().len() as u32
}

#[wasm_bindgen]
pub fn messagepack_writer_clear() {
    messagepack_writer().clear();
}

/// Run a battery of known-output encodings. Returns 0 if every case
/// passes, otherwise a 32-bit bitmask where bit N is set for case N.
/// Called once by JS at module load so an encoder regression
/// surfaces before Phase 10 ever ships a snapshot.
#[wasm_bindgen]
pub fn messagepack_self_test() -> u32 {
    let mut failures: u32 = 0;

    fn check(w: &mut MessagePackWriter, expected: &[u8], case: u32) -> bool {
        let got = w.as_slice();
        let ok = got == expected;
        w.clear();
        if !ok {
            // (rust) keep a marker for future debug logging.
        }
        let _ = case;
        ok
    }

    let mut w = MessagePackWriter::with_capacity(64);

    // case 0: nil
    w.write_nil();
    if !check(&mut w, &[0xC0], 0) { failures |= 1 << 0; }

    // case 1: true / false
    w.write_bool(true);
    w.write_bool(false);
    if !check(&mut w, &[0xC3, 0xC2], 1) { failures |= 1 << 1; }

    // case 2: positive fixint 0, 127
    w.write_number(0.0);
    w.write_number(127.0);
    if !check(&mut w, &[0x00, 0x7F], 2) { failures |= 1 << 2; }

    // case 3: negative fixint -1, -32
    w.write_number(-1.0);
    w.write_number(-32.0);
    if !check(&mut w, &[0xFF, 0xE0], 3) { failures |= 1 << 3; }

    // case 4: uint8 (128, 255)
    w.write_number(128.0);
    w.write_number(255.0);
    if !check(&mut w, &[0xCC, 0x80, 0xCC, 0xFF], 4) { failures |= 1 << 4; }

    // case 5: uint16 (256, 65535)
    w.write_number(256.0);
    w.write_number(65535.0);
    if !check(&mut w, &[0xCD, 0x01, 0x00, 0xCD, 0xFF, 0xFF], 5) { failures |= 1 << 5; }

    // case 6: uint32 (65536, 4294967295)
    w.write_number(65536.0);
    w.write_number(4_294_967_295.0);
    if !check(&mut w, &[0xCE, 0x00, 0x01, 0x00, 0x00, 0xCE, 0xFF, 0xFF, 0xFF, 0xFF], 6) {
        failures |= 1 << 6;
    }

    // case 7: int8 (-33, -128)
    w.write_number(-33.0);
    w.write_number(-128.0);
    if !check(&mut w, &[0xD0, 0xDF, 0xD0, 0x80], 7) { failures |= 1 << 7; }

    // case 8: int16 (-129, -32768)
    w.write_number(-129.0);
    w.write_number(-32768.0);
    if !check(&mut w, &[0xD1, 0xFF, 0x7F, 0xD1, 0x80, 0x00], 8) { failures |= 1 << 8; }

    // case 9: int32 (-32769, -2147483648)
    w.write_number(-32769.0);
    w.write_number(-2_147_483_648.0);
    if !check(&mut w, &[
        0xD2, 0xFF, 0xFF, 0x7F, 0xFF,
        0xD2, 0x80, 0x00, 0x00, 0x00,
    ], 9) { failures |= 1 << 9; }

    // case 10: float64 0.5 (non-integer)
    w.write_number(0.5);
    if !check(&mut w, &[0xCB, 0x3F, 0xE0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 10) {
        failures |= 1 << 10;
    }

    // case 11: float64 NaN (non-finite)
    w.write_number(f64::NAN);
    let bytes = w.as_slice();
    // NaN: 0xCB + 8 bytes whose first byte has bit7 unset/set varies;
    // we just check the marker + length.
    let nan_ok = bytes.len() == 9 && bytes[0] == 0xCB;
    w.clear();
    if !nan_ok { failures |= 1 << 11; }

    // case 12: fixstr ""
    w.write_str("");
    if !check(&mut w, &[0xA0], 12) { failures |= 1 << 12; }

    // case 13: fixstr "hi"
    w.write_str("hi");
    if !check(&mut w, &[0xA2, b'h', b'i'], 13) { failures |= 1 << 13; }

    // case 14: str8 — 32-byte string
    let s32 = "abcdefghijklmnopqrstuvwxyz012345"; // 32 bytes
    w.write_str(s32);
    let bytes = w.as_slice();
    let str8_ok = bytes.len() == 34 && bytes[0] == 0xD9 && bytes[1] == 32 && &bytes[2..] == s32.as_bytes();
    w.clear();
    if !str8_ok { failures |= 1 << 14; }

    // case 15: fixarray with 3 entries
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_number(3.0);
    if !check(&mut w, &[0x93, 0x01, 0x02, 0x03], 15) { failures |= 1 << 15; }

    // case 16: array16 with 16 entries
    w.write_array_header(16);
    for _ in 0..16 { w.write_number(0.0); }
    let bytes = w.as_slice();
    let arr16_ok = bytes.len() == 19
        && bytes[0] == 0xDC && bytes[1] == 0 && bytes[2] == 16
        && bytes[3..].iter().all(|&b| b == 0x00);
    w.clear();
    if !arr16_ok { failures |= 1 << 16; }

    // case 17: fixmap (k:v) "a" → 1
    w.write_map_header(1);
    w.write_str("a");
    w.write_number(1.0);
    if !check(&mut w, &[0x81, 0xA1, b'a', 0x01], 17) { failures |= 1 << 17; }

    // case 18: empty fixmap, empty fixarray
    w.write_map_header(0);
    w.write_array_header(0);
    if !check(&mut w, &[0x80, 0x90], 18) { failures |= 1 << 18; }

    // case 19: bin8 — 3 bytes
    w.write_bin(&[0x01, 0x02, 0x03]);
    if !check(&mut w, &[0xC4, 0x03, 0x01, 0x02, 0x03], 19) { failures |= 1 << 19; }

    // case 20: nested — map { "arr": [1, 2, "hi"] }
    w.write_map_header(1);
    w.write_str("arr");
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_str("hi");
    if !check(&mut w, &[
        0x81, 0xA3, b'a', b'r', b'r',
        0x93, 0x01, 0x02, 0xA2, b'h', b'i',
    ], 20) { failures |= 1 << 20; }

    failures
}

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1 — Entity-meta SoA pool
//
//  Per-entity scalar fields the snapshot serializer reads. Position,
//  velocity, orientation, etc. already live in BodyPool / projectile
//  pool / quat orientation views. This pool covers the *snapshot-
//  only* state: HP, ownership tag, combat mode, build progress,
//  suspension/jump kinematics, factory/solar booleans, build target
//  reference.
//
//  Slot space is shared with SpatialGrid (Phase 7) — JS resolves the
//  entity's slot via spatial.allocSlot(); both systems read/write the
//  same slot id. No separate EntityId↔slot map needed.
//
//  This commit ships the data layout + setters + lifecycle. JS-side
//  population (the per-tick capture from WorldState into the pool)
//  lands with D.3 alongside the quantize + delta-encode kernel that
//  reads from these fields.
//
//  Variable-length per-entity arrays (turrets, actions) are NOT in
//  this pool — they'll get their own sub-pool in D.1b when D.3
//  needs them. The fixed-scalar fields below cover everything else.
// ─────────────────────────────────────────────────────────────────

const ENTITY_META_TYPE_UNSET: u8 = 0;
const ENTITY_META_TYPE_UNIT: u8 = 1;
const ENTITY_META_TYPE_BUILDING: u8 = 2;

struct EntityMetaPool {
    // Common
    entity_type: Vec<u8>,
    player_id: Vec<u8>,
    hp_curr: Vec<f32>,
    hp_max: Vec<f32>,

    // Unit-specific
    combat_mode: Vec<u8>,
    is_commander: Vec<u8>,
    build_complete: Vec<u8>,
    build_paid_energy: Vec<f32>,
    build_paid_mana: Vec<f32>,
    build_paid_metal: Vec<f32>,
    /// -1 sentinel for "no build target"; otherwise the target EntityId.
    build_target_id: Vec<i32>,
    suspension_spring_offset: Vec<f32>,
    suspension_spring_velocity: Vec<f32>,
    jump_airborne: Vec<u8>,
    jump_timer: Vec<f32>,

    // Building-specific
    factory_is_producing: Vec<u8>,
    factory_build_queue_len: Vec<u8>,
    factory_progress: Vec<f32>,
    solar_open: Vec<u8>,
    build_progress: Vec<f32>,
}

impl EntityMetaPool {
    fn empty() -> Self {
        Self {
            entity_type: Vec::new(),
            player_id: Vec::new(),
            hp_curr: Vec::new(),
            hp_max: Vec::new(),
            combat_mode: Vec::new(),
            is_commander: Vec::new(),
            build_complete: Vec::new(),
            build_paid_energy: Vec::new(),
            build_paid_mana: Vec::new(),
            build_paid_metal: Vec::new(),
            build_target_id: Vec::new(),
            suspension_spring_offset: Vec::new(),
            suspension_spring_velocity: Vec::new(),
            jump_airborne: Vec::new(),
            jump_timer: Vec::new(),
            factory_is_producing: Vec::new(),
            factory_build_queue_len: Vec::new(),
            factory_progress: Vec::new(),
            solar_open: Vec::new(),
            build_progress: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.entity_type.len() >= needed { return; }
        self.entity_type.resize(needed, ENTITY_META_TYPE_UNSET);
        self.player_id.resize(needed, 0);
        self.hp_curr.resize(needed, 0.0);
        self.hp_max.resize(needed, 0.0);
        self.combat_mode.resize(needed, 0);
        self.is_commander.resize(needed, 0);
        self.build_complete.resize(needed, 0);
        self.build_paid_energy.resize(needed, 0.0);
        self.build_paid_mana.resize(needed, 0.0);
        self.build_paid_metal.resize(needed, 0.0);
        self.build_target_id.resize(needed, -1);
        self.suspension_spring_offset.resize(needed, 0.0);
        self.suspension_spring_velocity.resize(needed, 0.0);
        self.jump_airborne.resize(needed, 0);
        self.jump_timer.resize(needed, 0.0);
        self.factory_is_producing.resize(needed, 0);
        self.factory_build_queue_len.resize(needed, 0);
        self.factory_progress.resize(needed, 0.0);
        self.solar_open.resize(needed, 0);
        self.build_progress.resize(needed, 0.0);
    }

    fn unset_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.entity_type.len() { return; }
        self.entity_type[s] = ENTITY_META_TYPE_UNSET;
        self.player_id[s] = 0;
        self.hp_curr[s] = 0.0;
        self.hp_max[s] = 0.0;
        self.combat_mode[s] = 0;
        self.is_commander[s] = 0;
        self.build_complete[s] = 0;
        self.build_paid_energy[s] = 0.0;
        self.build_paid_mana[s] = 0.0;
        self.build_paid_metal[s] = 0.0;
        self.build_target_id[s] = -1;
        self.suspension_spring_offset[s] = 0.0;
        self.suspension_spring_velocity[s] = 0.0;
        self.jump_airborne[s] = 0;
        self.jump_timer[s] = 0.0;
        self.factory_is_producing[s] = 0;
        self.factory_build_queue_len[s] = 0;
        self.factory_progress[s] = 0.0;
        self.solar_open[s] = 0;
        self.build_progress[s] = 0.0;
    }
}

struct EntityMetaHolder(UnsafeCell<Option<EntityMetaPool>>);
unsafe impl Sync for EntityMetaHolder {}
static ENTITY_META: EntityMetaHolder = EntityMetaHolder(UnsafeCell::new(None));

#[inline]
fn entity_meta_pool() -> &'static mut EntityMetaPool {
    unsafe {
        let cell = &mut *ENTITY_META.0.get();
        if cell.is_none() {
            *cell = Some(EntityMetaPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn entity_meta_init(initial_capacity: u32) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(initial_capacity);
    // Reset slot tags so a re-init drops stale state.
    for k in pool.entity_type.iter_mut() { *k = ENTITY_META_TYPE_UNSET; }
}

#[wasm_bindgen]
pub fn entity_meta_clear() {
    let pool = entity_meta_pool();
    for k in pool.entity_type.iter_mut() { *k = ENTITY_META_TYPE_UNSET; }
    // Other fields stay at their resize-defaults; tag check gates
    // any future read.
}

/// Bulk per-unit setter. JS calls this once per dirty unit per
/// snapshot tick (D.3 will wire it). All unit-specific scalar
/// fields land in one call to amortise boundary overhead. Building-
/// only fields are left at their previous value; the entity_type
/// tag gates which fields a reader trusts.
#[wasm_bindgen]
pub fn entity_meta_set_unit(
    slot: u32,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    combat_mode: u8,
    is_commander: u8,
    build_complete: u8,
    build_paid_energy: f32,
    build_paid_mana: f32,
    build_paid_metal: f32,
    build_target_id: i32,
    suspension_spring_offset: f32,
    suspension_spring_velocity: f32,
    jump_airborne: u8,
    jump_timer: f32,
    build_progress: f32,
) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(slot);
    let s = slot as usize;
    pool.entity_type[s] = ENTITY_META_TYPE_UNIT;
    pool.player_id[s] = player_id;
    pool.hp_curr[s] = hp_curr;
    pool.hp_max[s] = hp_max;
    pool.combat_mode[s] = combat_mode;
    pool.is_commander[s] = is_commander;
    pool.build_complete[s] = build_complete;
    pool.build_paid_energy[s] = build_paid_energy;
    pool.build_paid_mana[s] = build_paid_mana;
    pool.build_paid_metal[s] = build_paid_metal;
    pool.build_target_id[s] = build_target_id;
    pool.suspension_spring_offset[s] = suspension_spring_offset;
    pool.suspension_spring_velocity[s] = suspension_spring_velocity;
    pool.jump_airborne[s] = jump_airborne;
    pool.jump_timer[s] = jump_timer;
    pool.build_progress[s] = build_progress;
}

/// Bulk per-building setter. Building-only fields, plus the shared
/// HP and player_id.
#[wasm_bindgen]
pub fn entity_meta_set_building(
    slot: u32,
    player_id: u8,
    hp_curr: f32,
    hp_max: f32,
    factory_is_producing: u8,
    factory_build_queue_len: u8,
    factory_progress: f32,
    solar_open: u8,
    build_progress: f32,
) {
    let pool = entity_meta_pool();
    pool.ensure_capacity(slot);
    let s = slot as usize;
    pool.entity_type[s] = ENTITY_META_TYPE_BUILDING;
    pool.player_id[s] = player_id;
    pool.hp_curr[s] = hp_curr;
    pool.hp_max[s] = hp_max;
    pool.factory_is_producing[s] = factory_is_producing;
    pool.factory_build_queue_len[s] = factory_build_queue_len;
    pool.factory_progress[s] = factory_progress;
    pool.solar_open[s] = solar_open;
    pool.build_progress[s] = build_progress;
}

#[wasm_bindgen]
pub fn entity_meta_unset(slot: u32) {
    entity_meta_pool().unset_slot(slot);
}

#[wasm_bindgen]
pub fn entity_meta_type(slot: u32) -> u8 {
    let pool = entity_meta_pool();
    if (slot as usize) >= pool.entity_type.len() { return ENTITY_META_TYPE_UNSET; }
    pool.entity_type[slot as usize]
}

// Field-pointer exports — JS builds typed-array views once and reads
// per-slot. Same pattern as BodyPool / ProjectilePool. Per-slot
// access is JIT-fast through the views; bulk reads of N slots are
// O(N) without WASM boundary crossings.

macro_rules! entity_meta_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            entity_meta_pool().$field.as_ptr()
        }
    };
}

entity_meta_ptr_export!(entity_meta_type_ptr, entity_type, u8);
entity_meta_ptr_export!(entity_meta_player_id_ptr, player_id, u8);
entity_meta_ptr_export!(entity_meta_hp_curr_ptr, hp_curr, f32);
entity_meta_ptr_export!(entity_meta_hp_max_ptr, hp_max, f32);
entity_meta_ptr_export!(entity_meta_combat_mode_ptr, combat_mode, u8);
entity_meta_ptr_export!(entity_meta_is_commander_ptr, is_commander, u8);
entity_meta_ptr_export!(entity_meta_build_complete_ptr, build_complete, u8);
entity_meta_ptr_export!(entity_meta_build_paid_energy_ptr, build_paid_energy, f32);
entity_meta_ptr_export!(entity_meta_build_paid_mana_ptr, build_paid_mana, f32);
entity_meta_ptr_export!(entity_meta_build_paid_metal_ptr, build_paid_metal, f32);
entity_meta_ptr_export!(entity_meta_build_target_id_ptr, build_target_id, i32);
entity_meta_ptr_export!(entity_meta_suspension_spring_offset_ptr, suspension_spring_offset, f32);
entity_meta_ptr_export!(entity_meta_suspension_spring_velocity_ptr, suspension_spring_velocity, f32);
entity_meta_ptr_export!(entity_meta_jump_airborne_ptr, jump_airborne, u8);
entity_meta_ptr_export!(entity_meta_jump_timer_ptr, jump_timer, f32);
entity_meta_ptr_export!(entity_meta_factory_is_producing_ptr, factory_is_producing, u8);
entity_meta_ptr_export!(entity_meta_factory_build_queue_len_ptr, factory_build_queue_len, u8);
entity_meta_ptr_export!(entity_meta_factory_progress_ptr, factory_progress, f32);
entity_meta_ptr_export!(entity_meta_solar_open_ptr, solar_open, u8);
entity_meta_ptr_export!(entity_meta_build_progress_ptr, build_progress, f32);

#[wasm_bindgen]
pub fn entity_meta_capacity() -> u32 {
    entity_meta_pool().entity_type.len() as u32
}

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1b — Turret sub-pool
//
//  Each entity can have up to MAX_TURRETS_PER_ENTITY = 8 turrets
//  (matches MAX_WEAPONS_PER_ENTITY in stateSerializerEntities.ts).
//  Per-turret state lives at index `entity_slot * MAX + turret_idx`
//  in a flat SoA. Per-entity turret count gates which indices are
//  live. Indexes for inactive slots stay at their defaults; consumers
//  only read the first `count` entries for an entity.
//
//  Fields cover the snapshot turret DTO: rotation, angularVelocity,
//  angularAcceleration, pitch, pitchVelocity, pitchAcceleration,
//  forceFieldRange, plus a target_id reference (-1 = none).
//
//  Variable-length action sub-pool is a follow-up (D.1c) — action
//  ActionType is a JS string enum that needs a stable u8 mapping
//  before it can be ported.
// ─────────────────────────────────────────────────────────────────

pub const TURRET_POOL_MAX_PER_ENTITY: u32 = 8;

struct TurretPool {
    // count_per_entity[i] = number of turrets used by entity slot i.
    count_per_entity: Vec<u8>,
    // Per-turret state, indexed by (entity_slot * MAX + turret_idx).
    rotation: Vec<f32>,
    angular_velocity: Vec<f32>,
    angular_acceleration: Vec<f32>,
    pitch: Vec<f32>,
    pitch_velocity: Vec<f32>,
    pitch_acceleration: Vec<f32>,
    force_field_range: Vec<f32>,
    target_id: Vec<i32>,
}

impl TurretPool {
    fn empty() -> Self {
        Self {
            count_per_entity: Vec::new(),
            rotation: Vec::new(),
            angular_velocity: Vec::new(),
            angular_acceleration: Vec::new(),
            pitch: Vec::new(),
            pitch_velocity: Vec::new(),
            pitch_acceleration: Vec::new(),
            force_field_range: Vec::new(),
            target_id: Vec::new(),
        }
    }

    fn ensure_entity_capacity(&mut self, entity_slot: u32) {
        let entity_needed = (entity_slot as usize) + 1;
        if self.count_per_entity.len() < entity_needed {
            self.count_per_entity.resize(entity_needed, 0);
        }
        let turret_needed = entity_needed * (TURRET_POOL_MAX_PER_ENTITY as usize);
        if self.rotation.len() < turret_needed {
            self.rotation.resize(turret_needed, 0.0);
            self.angular_velocity.resize(turret_needed, 0.0);
            self.angular_acceleration.resize(turret_needed, 0.0);
            self.pitch.resize(turret_needed, 0.0);
            self.pitch_velocity.resize(turret_needed, 0.0);
            self.pitch_acceleration.resize(turret_needed, 0.0);
            self.force_field_range.resize(turret_needed, 0.0);
            self.target_id.resize(turret_needed, -1);
        }
    }

    fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.count_per_entity.len() { return; }
        self.count_per_entity[s] = 0;
        // Per-turret fields stay at last value; consumers gate on count.
    }
}

struct TurretPoolHolder(UnsafeCell<Option<TurretPool>>);
unsafe impl Sync for TurretPoolHolder {}
static TURRET_POOL: TurretPoolHolder = TurretPoolHolder(UnsafeCell::new(None));

#[inline]
fn turret_pool() -> &'static mut TurretPool {
    unsafe {
        let cell = &mut *TURRET_POOL.0.get();
        if cell.is_none() {
            *cell = Some(TurretPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn turret_pool_init(initial_entity_capacity: u32) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(initial_entity_capacity);
    for c in pool.count_per_entity.iter_mut() { *c = 0; }
}

#[wasm_bindgen]
pub fn turret_pool_clear() {
    let pool = turret_pool();
    for c in pool.count_per_entity.iter_mut() { *c = 0; }
}

#[wasm_bindgen]
pub fn turret_pool_max_per_entity() -> u32 {
    TURRET_POOL_MAX_PER_ENTITY
}

/// Set the number of live turrets for an entity. Caller is responsible
/// for calling turret_pool_set_turret for each of the first `count`
/// turret indices. Counts past TURRET_POOL_MAX_PER_ENTITY are clamped.
#[wasm_bindgen]
pub fn turret_pool_set_count(entity_slot: u32, count: u8) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    let max = TURRET_POOL_MAX_PER_ENTITY as u8;
    let clamped = if count > max { max } else { count };
    pool.count_per_entity[entity_slot as usize] = clamped;
}

/// Bulk per-turret setter. `target_id` of -1 means "no target".
#[wasm_bindgen]
pub fn turret_pool_set_turret(
    entity_slot: u32,
    turret_idx: u32,
    rotation: f32,
    angular_velocity: f32,
    angular_acceleration: f32,
    pitch: f32,
    pitch_velocity: f32,
    pitch_acceleration: f32,
    force_field_range: f32,
    target_id: i32,
) {
    let pool = turret_pool();
    pool.ensure_entity_capacity(entity_slot);
    debug_assert!(turret_idx < TURRET_POOL_MAX_PER_ENTITY);
    let global_idx = (entity_slot as usize) * (TURRET_POOL_MAX_PER_ENTITY as usize)
        + (turret_idx as usize);
    pool.rotation[global_idx] = rotation;
    pool.angular_velocity[global_idx] = angular_velocity;
    pool.angular_acceleration[global_idx] = angular_acceleration;
    pool.pitch[global_idx] = pitch;
    pool.pitch_velocity[global_idx] = pitch_velocity;
    pool.pitch_acceleration[global_idx] = pitch_acceleration;
    pool.force_field_range[global_idx] = force_field_range;
    pool.target_id[global_idx] = target_id;
}

#[wasm_bindgen]
pub fn turret_pool_unset_entity(entity_slot: u32) {
    turret_pool().unset_entity(entity_slot);
}

#[wasm_bindgen]
pub fn turret_pool_count(entity_slot: u32) -> u8 {
    let pool = turret_pool();
    if (entity_slot as usize) >= pool.count_per_entity.len() { return 0; }
    pool.count_per_entity[entity_slot as usize]
}

macro_rules! turret_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            turret_pool().$field.as_ptr()
        }
    };
}

turret_pool_ptr_export!(turret_pool_count_per_entity_ptr, count_per_entity, u8);
turret_pool_ptr_export!(turret_pool_rotation_ptr, rotation, f32);
turret_pool_ptr_export!(turret_pool_angular_velocity_ptr, angular_velocity, f32);
turret_pool_ptr_export!(turret_pool_angular_acceleration_ptr, angular_acceleration, f32);
turret_pool_ptr_export!(turret_pool_pitch_ptr, pitch, f32);
turret_pool_ptr_export!(turret_pool_pitch_velocity_ptr, pitch_velocity, f32);
turret_pool_ptr_export!(turret_pool_pitch_acceleration_ptr, pitch_acceleration, f32);
turret_pool_ptr_export!(turret_pool_force_field_range_ptr, force_field_range, f32);
turret_pool_ptr_export!(turret_pool_target_id_ptr, target_id, i32);

#[wasm_bindgen]
pub fn turret_pool_entity_capacity() -> u32 {
    turret_pool().count_per_entity.len() as u32
}

// ─────────────────────────────────────────────────────────────────
// Snapshot baselines (Phase 10 D.3b)
//
// Per-recipient snapshot of the last-shipped entity state. Mirrors
// the JS-side DeltaTrackingState.prevStates map: parallel SoA arrays
// keyed by entity slot (the SpatialGrid slot space). Fields are
// stored as floats — the quantize/diff/encode kernels (D.3c+) read
// from this and the entity-meta / turret / body pools, and emit
// MessagePack bytes via the D.2 writer.
//
// Each listener registers once at session start via
// `snapshot_baseline_create()` and is freed at session end via
// `snapshot_baseline_destroy(handle)`. Handles are u32 indices into
// a registry with free-list reuse.
// ─────────────────────────────────────────────────────────────────

pub const SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY: u32 = TURRET_POOL_MAX_PER_ENTITY;

struct SnapshotBaseline {
    used: Vec<u8>,
    last_tick: Vec<u32>,
    // f64 to match JS PrevEntityState's Number precision exactly.
    // f32 storage triggered a bit-10 (MOVEMENT_ACCEL) divergence
    // when JS f64 values straddled an f32 rounding step that the
    // baseline read flipped on threshold compare.
    x: Vec<f64>, y: Vec<f64>, z: Vec<f64>,
    rotation: Vec<f64>,
    velocity_x: Vec<f64>, velocity_y: Vec<f64>, velocity_z: Vec<f64>,
    movement_accel_x: Vec<f64>, movement_accel_y: Vec<f64>, movement_accel_z: Vec<f64>,
    hp: Vec<f32>,
    action_count: Vec<u16>,
    action_hash: Vec<u32>,
    is_engaged_bits: Vec<u32>,
    target_bits: Vec<u32>,
    weapon_count: Vec<u8>,
    turret_rots: Vec<f32>,
    turret_ang_vels: Vec<f32>,
    turret_pitches: Vec<f32>,
    force_field_ranges: Vec<f32>,
    normal_x: Vec<f64>, normal_y: Vec<f64>, normal_z: Vec<f64>,
    build_progress: Vec<f32>,
    solar_open: Vec<u8>,
    factory_progress: Vec<f32>,
    is_producing: Vec<u8>,
    build_queue_len: Vec<u8>,
}

impl SnapshotBaseline {
    fn new() -> Self {
        Self {
            used: Vec::new(),
            last_tick: Vec::new(),
            x: Vec::new(), y: Vec::new(), z: Vec::new(),
            rotation: Vec::new(),
            velocity_x: Vec::new(), velocity_y: Vec::new(), velocity_z: Vec::new(),
            movement_accel_x: Vec::new(), movement_accel_y: Vec::new(), movement_accel_z: Vec::new(),
            hp: Vec::new(),
            action_count: Vec::new(),
            action_hash: Vec::new(),
            is_engaged_bits: Vec::new(),
            target_bits: Vec::new(),
            weapon_count: Vec::new(),
            turret_rots: Vec::new(),
            turret_ang_vels: Vec::new(),
            turret_pitches: Vec::new(),
            force_field_ranges: Vec::new(),
            normal_x: Vec::new(), normal_y: Vec::new(), normal_z: Vec::new(),
            build_progress: Vec::new(),
            solar_open: Vec::new(),
            factory_progress: Vec::new(),
            is_producing: Vec::new(),
            build_queue_len: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.used.len() >= needed { return; }
        self.used.resize(needed, 0);
        self.last_tick.resize(needed, 0);
        self.x.resize(needed, 0.0);
        self.y.resize(needed, 0.0);
        self.z.resize(needed, 0.0);
        self.rotation.resize(needed, 0.0);
        self.velocity_x.resize(needed, 0.0);
        self.velocity_y.resize(needed, 0.0);
        self.velocity_z.resize(needed, 0.0);
        self.movement_accel_x.resize(needed, 0.0);
        self.movement_accel_y.resize(needed, 0.0);
        self.movement_accel_z.resize(needed, 0.0);
        self.hp.resize(needed, 0.0);
        self.action_count.resize(needed, 0);
        self.action_hash.resize(needed, 0);
        self.is_engaged_bits.resize(needed, 0);
        self.target_bits.resize(needed, 0);
        self.weapon_count.resize(needed, 0);
        let turret_needed = needed * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
        self.turret_rots.resize(turret_needed, 0.0);
        self.turret_ang_vels.resize(turret_needed, 0.0);
        self.turret_pitches.resize(turret_needed, 0.0);
        self.force_field_ranges.resize(turret_needed, 0.0);
        self.normal_x.resize(needed, 0.0);
        self.normal_y.resize(needed, 0.0);
        self.normal_z.resize(needed, 1.0);
        self.build_progress.resize(needed, 0.0);
        self.solar_open.resize(needed, 1);
        self.factory_progress.resize(needed, 0.0);
        self.is_producing.resize(needed, 0);
        self.build_queue_len.resize(needed, 0);
    }

    fn unset_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.used.len() { return; }
        self.used[s] = 0;
    }

    fn clear(&mut self) {
        for u in self.used.iter_mut() { *u = 0; }
    }
}

struct SnapshotBaselineRegistry {
    baselines: Vec<Option<SnapshotBaseline>>,
    free_list: Vec<u32>,
}

impl SnapshotBaselineRegistry {
    fn new() -> Self {
        Self { baselines: Vec::new(), free_list: Vec::new() }
    }

    fn create(&mut self) -> u32 {
        if let Some(handle) = self.free_list.pop() {
            self.baselines[handle as usize] = Some(SnapshotBaseline::new());
            return handle;
        }
        let handle = self.baselines.len() as u32;
        self.baselines.push(Some(SnapshotBaseline::new()));
        handle
    }

    fn destroy(&mut self, handle: u32) {
        let h = handle as usize;
        if h >= self.baselines.len() { return; }
        if self.baselines[h].is_some() {
            self.baselines[h] = None;
            self.free_list.push(handle);
        }
    }

    #[allow(dead_code)]
    fn get_mut(&mut self, handle: u32) -> Option<&mut SnapshotBaseline> {
        self.baselines.get_mut(handle as usize)?.as_mut()
    }

    fn live_count(&self) -> u32 {
        (self.baselines.len() - self.free_list.len()) as u32
    }
}

struct SnapshotBaselineRegistryHolder(UnsafeCell<Option<SnapshotBaselineRegistry>>);
unsafe impl Sync for SnapshotBaselineRegistryHolder {}
static SNAPSHOT_BASELINE_REGISTRY: SnapshotBaselineRegistryHolder =
    SnapshotBaselineRegistryHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_baseline_registry() -> &'static mut SnapshotBaselineRegistry {
    unsafe {
        let cell = &mut *SNAPSHOT_BASELINE_REGISTRY.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotBaselineRegistry::new());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_create() -> u32 {
    snapshot_baseline_registry().create()
}

#[wasm_bindgen]
pub fn snapshot_baseline_destroy(handle: u32) {
    snapshot_baseline_registry().destroy(handle);
}

#[wasm_bindgen]
pub fn snapshot_baseline_clear(handle: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.clear();
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_unset_slot(handle: u32, slot: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.unset_slot(slot);
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_ensure_capacity(handle: u32, slot: u32) {
    if let Some(b) = snapshot_baseline_registry().get_mut(handle) {
        b.ensure_capacity(slot);
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_live_count() -> u32 {
    snapshot_baseline_registry().live_count()
}

// Per-slot capture kernels (Phase 10 D.3c). Mirror
// stateSerializerEntityDelta.ts:captureEntityState + copyPrevState
// into the per-recipient baseline. Transform / velocity / normal /
// action data come in as parameters (the JS-side authoritative
// source is the entity object); HP and the variable-shape fields
// (turrets, build/factory/solar state, suspension, jump) come from
// the already-populated entity-meta + turret pools.

#[wasm_bindgen]
pub fn snapshot_baseline_capture_unit_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    x: f64, y: f64, z: f64,
    rotation: f64,
    velocity_x: f64, velocity_y: f64, velocity_z: f64,
    movement_accel_x: f64, movement_accel_y: f64, movement_accel_z: f64,
    normal_x: f64, normal_y: f64, normal_z: f64,
    action_count: u16,
    action_hash: u32,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else { return; };
    b.ensure_capacity(slot);
    let s = slot as usize;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    b.x[s] = x; b.y[s] = y; b.z[s] = z;
    b.rotation[s] = rotation;
    b.velocity_x[s] = velocity_x; b.velocity_y[s] = velocity_y; b.velocity_z[s] = velocity_z;
    b.movement_accel_x[s] = movement_accel_x;
    b.movement_accel_y[s] = movement_accel_y;
    b.movement_accel_z[s] = movement_accel_z;
    b.normal_x[s] = normal_x; b.normal_y[s] = normal_y; b.normal_z[s] = normal_z;
    b.action_count[s] = action_count;
    b.action_hash[s] = action_hash;
    b.is_engaged_bits[s] = is_engaged_bits;
    b.target_bits[s] = target_bits;

    // HP + build/suspension/jump from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        b.hp[s] = meta.hp_curr[s];
        b.build_progress[s] = if s < meta.build_progress.len() { meta.build_progress[s] } else { 0.0 };
    }

    // Turret state from the turret pool.
    let turret = turret_pool();
    if s < turret.count_per_entity.len() {
        let count = turret.count_per_entity[s];
        b.weapon_count[s] = count;
        let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
        for t in 0..(count as usize) {
            let src = base + t;
            let dst = base + t;
            b.turret_rots[dst] = turret.rotation[src];
            b.turret_ang_vels[dst] = turret.angular_velocity[src];
            b.turret_pitches[dst] = turret.pitch[src];
            b.force_field_ranges[dst] = turret.force_field_range[src];
        }
    } else {
        b.weapon_count[s] = 0;
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_capture_building_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    x: f64, y: f64, z: f64,
    rotation: f64,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else { return; };
    b.ensure_capacity(slot);
    let s = slot as usize;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    b.x[s] = x; b.y[s] = y; b.z[s] = z;
    b.rotation[s] = rotation;
    // Buildings don't move — clear physics-fields so a stray emit can't
    // pick up stale unit data left over from a slot recycle.
    b.velocity_x[s] = 0.0; b.velocity_y[s] = 0.0; b.velocity_z[s] = 0.0;
    b.movement_accel_x[s] = 0.0;
    b.movement_accel_y[s] = 0.0;
    b.movement_accel_z[s] = 0.0;
    b.is_engaged_bits[s] = is_engaged_bits;
    b.target_bits[s] = target_bits;

    // HP + factory/solar/build progress from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        b.hp[s] = meta.hp_curr[s];
        b.build_progress[s] = if s < meta.build_progress.len() { meta.build_progress[s] } else { 1.0 };
        b.factory_progress[s] = if s < meta.factory_progress.len() { meta.factory_progress[s] } else { 0.0 };
        b.is_producing[s] = if s < meta.factory_is_producing.len() { meta.factory_is_producing[s] } else { 0 };
        b.build_queue_len[s] = if s < meta.factory_build_queue_len.len() { meta.factory_build_queue_len[s] } else { 0 };
        b.solar_open[s] = if s < meta.solar_open.len() { meta.solar_open[s] } else { 1 };
    }

    // Turret state — buildings with defense turrets (combat) need
    // weapon_count + per-turret state captured the same as units, or
    // the diff kernel would see ENTITY_CHANGED_TURRETS divergence
    // every tick.
    let turret = turret_pool();
    if s < turret.count_per_entity.len() {
        let count = turret.count_per_entity[s];
        b.weapon_count[s] = count;
        let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
        for t in 0..(count as usize) {
            let src = base + t;
            let dst = base + t;
            b.turret_rots[dst] = turret.rotation[src];
            b.turret_ang_vels[dst] = turret.angular_velocity[src];
            b.turret_pitches[dst] = turret.pitch[src];
            b.force_field_ranges[dst] = turret.force_field_range[src];
        }
    } else {
        b.weapon_count[s] = 0;
    }
}

/// Read-back accessor used by the (future) D.3d diff kernel and by
/// invariant checks. Returns 0 (unset) or 1 (used).
#[wasm_bindgen]
pub fn snapshot_baseline_slot_used(handle: u32, slot: u32) -> u8 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else { return 0; };
    let s = slot as usize;
    if s >= b.used.len() { return 0; }
    b.used[s]
}

/// Read-back accessor for the last tick at which the baseline was
/// captured for `slot`. Returns 0 if the slot is unset.
#[wasm_bindgen]
pub fn snapshot_baseline_slot_last_tick(handle: u32, slot: u32) -> u32 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else { return 0; };
    let s = slot as usize;
    if s >= b.last_tick.len() { return 0; }
    b.last_tick[s]
}

// Changed-fields bit constants (mirror src/types/network.ts).
const ENTITY_CHANGED_POS: u32 = 1 << 0;
const ENTITY_CHANGED_ROT: u32 = 1 << 1;
const ENTITY_CHANGED_VEL: u32 = 1 << 2;
const ENTITY_CHANGED_HP: u32 = 1 << 3;
const ENTITY_CHANGED_ACTIONS: u32 = 1 << 4;
const ENTITY_CHANGED_TURRETS: u32 = 1 << 5;
const ENTITY_CHANGED_BUILDING: u32 = 1 << 6;
const ENTITY_CHANGED_FACTORY: u32 = 1 << 7;
const ENTITY_CHANGED_NORMAL: u32 = 1 << 8;
const ENTITY_CHANGED_MOVEMENT_ACCEL: u32 = 1 << 10;

const SNAPSHOT_NORMAL_THRESHOLD: f64 = 0.001;
const SNAPSHOT_FORCE_FIELD_RANGE_THRESHOLD: f32 = 0.001;

// Kind tags for snapshot_baseline_diff_slot (mirror EntityType strings
// 'unit' / 'building' — kept separate from ENTITY_META_TYPE_* because
// callers may want to diff a unit slot without populating the
// entity-meta pool first).
pub const SNAPSHOT_DIFF_KIND_UNIT: u8 = 1;
pub const SNAPSHOT_DIFF_KIND_BUILDING: u8 = 2;

/// Phase 10 D.3d — diff kernel. Returns the CHANGED-FIELDS mask for
/// one slot by comparing the caller-supplied `current` scalars (and
/// the pool-resident hp / turret / build / factory / solar state)
/// against the per-recipient baseline. Caller is responsible for
/// skipping this call entirely when the baseline is unset
/// (snapshot_baseline_slot_used returns 0 — emit full DTO in that
/// case to match getEntityDeltaChangedFields's isNew path).
///
/// Threshold math is byte-equivalent with
/// stateSerializerEntityDelta.ts:getEntityDeltaChangedFields: each
/// per-axis |next-prev| > th comparison runs independently and the
/// per-field mask bit ORs into the result.
#[wasm_bindgen]
pub fn snapshot_baseline_diff_slot(
    handle: u32,
    slot: u32,
    kind: u8,
    x: f64, y: f64, z: f64,
    rotation: f64,
    velocity_x: f64, velocity_y: f64, velocity_z: f64,
    movement_accel_x: f64, movement_accel_y: f64, movement_accel_z: f64,
    normal_x: f64, normal_y: f64, normal_z: f64,
    action_count: u16,
    action_hash: u32,
    is_engaged_bits: u32,
    target_bits: u32,
    pos_threshold: f64,
    rot_pos_threshold: f64,
    vel_threshold: f64,
    rot_vel_threshold: f64,
    has_buildable: u8,
    has_combat: u8,
    has_factory: u8,
) -> u32 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else { return 0; };
    let s = slot as usize;
    if s >= b.used.len() || b.used[s] == 0 { return 0; }

    let mut mask: u32 = 0;

    if (x - b.x[s]).abs() > pos_threshold
        || (y - b.y[s]).abs() > pos_threshold
        || (z - b.z[s]).abs() > pos_threshold
    {
        mask |= ENTITY_CHANGED_POS;
    }
    if (rotation - b.rotation[s]).abs() > rot_pos_threshold {
        mask |= ENTITY_CHANGED_ROT;
    }

    if kind == SNAPSHOT_DIFF_KIND_UNIT {
        if (velocity_x - b.velocity_x[s]).abs() > vel_threshold
            || (velocity_y - b.velocity_y[s]).abs() > vel_threshold
            || (velocity_z - b.velocity_z[s]).abs() > vel_threshold
        {
            mask |= ENTITY_CHANGED_VEL;
        }
        if (movement_accel_x - b.movement_accel_x[s]).abs() > vel_threshold
            || (movement_accel_y - b.movement_accel_y[s]).abs() > vel_threshold
            || (movement_accel_z - b.movement_accel_z[s]).abs() > vel_threshold
        {
            mask |= ENTITY_CHANGED_MOVEMENT_ACCEL;
        }
        let cur_hp = {
            let meta = entity_meta_pool();
            if s < meta.hp_curr.len() { meta.hp_curr[s] } else { 0.0 }
        };
        if cur_hp != b.hp[s] {
            mask |= ENTITY_CHANGED_HP;
        }
        if action_count != b.action_count[s] || action_hash != b.action_hash[s] {
            mask |= ENTITY_CHANGED_ACTIONS;
        }
        if (normal_x - b.normal_x[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
            || (normal_y - b.normal_y[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
            || (normal_z - b.normal_z[s]).abs() > SNAPSHOT_NORMAL_THRESHOLD
        {
            mask |= ENTITY_CHANGED_NORMAL;
        }
        if has_buildable != 0 {
            let cur_build = {
                let meta = entity_meta_pool();
                if s < meta.build_progress.len() { meta.build_progress[s] } else { 0.0 }
            };
            if cur_build != b.build_progress[s] {
                mask |= ENTITY_CHANGED_BUILDING;
            }
        }
    }

    if has_combat != 0 {
        let turret = turret_pool();
        let cur_weapon_count = if s < turret.count_per_entity.len() {
            turret.count_per_entity[s]
        } else { 0 };
        if cur_weapon_count != b.weapon_count[s] {
            mask |= ENTITY_CHANGED_TURRETS;
        } else if cur_weapon_count > 0 {
            let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
            let mut turrets_changed = false;
            for t in 0..(cur_weapon_count as usize) {
                let idx = base + t;
                if ((turret.rotation[idx] - b.turret_rots[idx]).abs() as f64) > rot_pos_threshold
                    || ((turret.angular_velocity[idx] - b.turret_ang_vels[idx]).abs() as f64) > rot_vel_threshold
                    || ((turret.pitch[idx] - b.turret_pitches[idx]).abs() as f64) > rot_pos_threshold
                    || (turret.force_field_range[idx] - b.force_field_ranges[idx]).abs() > SNAPSHOT_FORCE_FIELD_RANGE_THRESHOLD
                {
                    turrets_changed = true;
                    break;
                }
            }
            if turrets_changed {
                mask |= ENTITY_CHANGED_TURRETS;
            }
        }
        if is_engaged_bits != b.is_engaged_bits[s] || target_bits != b.target_bits[s] {
            mask |= ENTITY_CHANGED_TURRETS;
        }
    }

    if kind == SNAPSHOT_DIFF_KIND_BUILDING {
        let meta = entity_meta_pool();
        let cur_hp = if s < meta.hp_curr.len() { meta.hp_curr[s] } else { 0.0 };
        if cur_hp != b.hp[s] {
            mask |= ENTITY_CHANGED_HP;
        }
        let cur_build = if s < meta.build_progress.len() { meta.build_progress[s] } else { 0.0 };
        let cur_solar = if s < meta.solar_open.len() { meta.solar_open[s] } else { 1 };
        if cur_build != b.build_progress[s] || cur_solar != b.solar_open[s] {
            mask |= ENTITY_CHANGED_BUILDING;
        }
        if has_factory != 0 {
            let cur_fp = if s < meta.factory_progress.len() { meta.factory_progress[s] } else { 0.0 };
            let cur_ip = if s < meta.factory_is_producing.len() { meta.factory_is_producing[s] } else { 0 };
            let cur_bql = if s < meta.factory_build_queue_len.len() { meta.factory_build_queue_len[s] } else { 0 };
            if cur_fp != b.factory_progress[s]
                || cur_ip != b.is_producing[s]
                || cur_bql != b.build_queue_len[s]
            {
                mask |= ENTITY_CHANGED_FACTORY;
            }
        }
    }

    mask
}

// ─────────────────────────────────────────────────────────────────
// Snapshot entity encoder (Phase 10 D.3j)
//
// Byte-equal port of stateSerializerEntities.ts:serializeEntitySnapshot's
// output AS msgpack-encoded via @msgpack/msgpack with ignoreUndefined:
// true. Each `snapshot_encode_entity_*` function emits one entity's
// MessagePack bytes into the D.2 writer's scratch buffer; JS reads
// via messagepack_writer_ptr() / _len().
//
// The port lands incrementally — each successive commit handles one
// more field group (envelope → unit sub-object → turret array →
// building sub-object → factory/solar/build/...). Until the full
// kernel exists, callers that need the OUTGOING wire bytes still go
// through the JS path; the Rust path is verified against the JS
// path on every dev build via the (D.3j) byte-equality test runner.
// ─────────────────────────────────────────────────────────────────

/// Entity-type tag for the encoder kernels. Mirrors EntityType
/// strings used in the JS NetworkServerSnapshotEntity DTO.
pub const SNAPSHOT_ENTITY_TYPE_UNIT: u8 = 1;
pub const SNAPSHOT_ENTITY_TYPE_BUILDING: u8 = 2;

/// Encoder turret scratch — JS pre-fills with already-quantized
/// turret values, then the encoder reads from it when emitting the
/// turrets array. Layout per turret (12 f64 = 96 bytes):
///   [0..6]  qRot(rotation, vel, acc, pitch, pitchVel, pitchAcc)
///   [6]     turret-id code (TurretTypeCode as f64)
///   [7]     state code (TurretStateCode as f64)
///   [8]     has_target_id (0 or 1)
///   [9]     target_id (raw entity id as f64; ignored when has_target_id==0)
///   [10]    has_force_field_range (0 or 1)
///   [11]    force_field_range (raw value; ignored when has_ff_range==0)
///
/// Capacity grown on demand by snapshot_encode_turret_scratch_ensure.
const SNAPSHOT_ENCODE_TURRET_STRIDE: usize = 12;

struct SnapshotEncodeTurretScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeTurretScratchHolder(UnsafeCell<Option<SnapshotEncodeTurretScratch>>);
unsafe impl Sync for SnapshotEncodeTurretScratchHolder {}
static SNAPSHOT_ENCODE_TURRET_SCRATCH: SnapshotEncodeTurretScratchHolder =
    SnapshotEncodeTurretScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_turret_scratch() -> &'static mut SnapshotEncodeTurretScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_TURRET_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeTurretScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_TURRET_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_scratch_ptr() -> *const f64 {
    snapshot_encode_turret_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_scratch_ensure(turret_count: u32) {
    let needed = (turret_count as usize) * SNAPSHOT_ENCODE_TURRET_STRIDE;
    let s = snapshot_encode_turret_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Encoder action scratch — JS pre-fills with action data, then the
/// encoder reads when emitting the actions array. Layout per action
/// (16 f64 = 128 bytes):
///   [0]   action type code (u8 ActionTypeCode as f64)
///   [1]   has_pos (0 or 1)
///   [2..4] pos.x, pos.y (when has_pos)
///   [4]   has_pos_z (0 or 1)
///   [5]   pos_z (when has_pos_z)
///   [6]   path_exp (1 emits `true`, 0 omits the key)
///   [7]   has_target_id (0 or 1)
///   [8]   target_id (when has_target_id)
///   [9]   has_building_type (0 or 1)
///   [10]  building_type_string_slot (when has_building_type)
///   [11]  has_grid (0 or 1)
///   [12..14] grid.x, grid.y (when has_grid)
///   [14]  has_building_id (0 or 1)
///   [15]  building_id (when has_building_id)
const SNAPSHOT_ENCODE_ACTION_STRIDE: usize = 16;

struct SnapshotEncodeActionScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeActionScratchHolder(UnsafeCell<Option<SnapshotEncodeActionScratch>>);
unsafe impl Sync for SnapshotEncodeActionScratchHolder {}
static SNAPSHOT_ENCODE_ACTION_SCRATCH: SnapshotEncodeActionScratchHolder =
    SnapshotEncodeActionScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_action_scratch() -> &'static mut SnapshotEncodeActionScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_ACTION_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeActionScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_ACTION_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_action_scratch_ptr() -> *const f64 {
    snapshot_encode_action_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_action_scratch_ensure(action_count: u32) {
    let needed = (action_count as usize) * SNAPSHOT_ENCODE_ACTION_STRIDE;
    let s = snapshot_encode_action_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// String scratch — UTF-8 byte buffer plus an offset/length table
/// indexed by string slot. JS pre-fills both before any encoder
/// call that emits a string field; the kernel reads via the table.
///
/// `bytes` holds the concatenated UTF-8 of every string; `table[2i]`
/// is the byte offset, `table[2i+1]` is the byte length. A slot
/// with length 0 emits the empty string `""`.
struct SnapshotEncodeStringScratch {
    bytes: Vec<u8>,
    table: Vec<u32>,
}

struct SnapshotEncodeStringScratchHolder(UnsafeCell<Option<SnapshotEncodeStringScratch>>);
unsafe impl Sync for SnapshotEncodeStringScratchHolder {}
static SNAPSHOT_ENCODE_STRING_SCRATCH: SnapshotEncodeStringScratchHolder =
    SnapshotEncodeStringScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_string_scratch() -> &'static mut SnapshotEncodeStringScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_STRING_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeStringScratch {
                bytes: vec![0u8; 256],
                table: vec![0u32; 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_bytes_ptr() -> *const u8 {
    snapshot_encode_string_scratch().bytes.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_table_ptr() -> *const u32 {
    snapshot_encode_string_scratch().table.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_ensure_bytes(byte_count: u32) {
    let s = snapshot_encode_string_scratch();
    let needed = byte_count as usize;
    if s.bytes.len() < needed {
        s.bytes.resize(needed, 0);
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_string_scratch_ensure_table(slot_count: u32) {
    let s = snapshot_encode_string_scratch();
    let needed = (slot_count as usize) * 2; // pairs of (offset, length)
    if s.table.len() < needed {
        s.table.resize(needed, 0);
    }
}

/// Factory queue scratch — flat Uint32Array of unit-type codes that
/// the encoder reads when emitting `factory.queue`. JS pre-fills
/// before calling encode_entity_building with has_factory=1.
struct SnapshotEncodeFactoryQueueScratch {
    buf: Vec<u32>,
}

struct SnapshotEncodeFactoryQueueScratchHolder(UnsafeCell<Option<SnapshotEncodeFactoryQueueScratch>>);
unsafe impl Sync for SnapshotEncodeFactoryQueueScratchHolder {}
static SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH: SnapshotEncodeFactoryQueueScratchHolder =
    SnapshotEncodeFactoryQueueScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_factory_queue_scratch() -> &'static mut SnapshotEncodeFactoryQueueScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeFactoryQueueScratch { buf: vec![0u32; 16] });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_factory_queue_scratch_ptr() -> *const u32 {
    snapshot_encode_factory_queue_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_factory_queue_scratch_ensure(count: u32) {
    let s = snapshot_encode_factory_queue_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

/// Factory waypoint scratch — 5 f64 per waypoint:
///   [0..2]  pos.x, pos.y
///   [2]     has_pos_z (0 or 1)
///   [3]     pos_z (when has_pos_z)
///   [4]     type_string_slot (index into string scratch)
const SNAPSHOT_ENCODE_WAYPOINT_STRIDE: usize = 5;

struct SnapshotEncodeWaypointScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeWaypointScratchHolder(UnsafeCell<Option<SnapshotEncodeWaypointScratch>>);
unsafe impl Sync for SnapshotEncodeWaypointScratchHolder {}
static SNAPSHOT_ENCODE_WAYPOINT_SCRATCH: SnapshotEncodeWaypointScratchHolder =
    SnapshotEncodeWaypointScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_waypoint_scratch() -> &'static mut SnapshotEncodeWaypointScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_WAYPOINT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeWaypointScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_WAYPOINT_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_waypoint_scratch_ptr() -> *const f64 {
    snapshot_encode_waypoint_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_waypoint_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_WAYPOINT_STRIDE;
    let s = snapshot_encode_waypoint_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Write a string slot's bytes to the MessagePack writer. Returns
/// silently for out-of-bounds slots (caller is responsible for
/// having populated the slot via the byte+table buffers).
fn write_string_from_scratch(w: &mut MessagePackWriter, slot: u32) {
    let scratch = snapshot_encode_string_scratch();
    let s = slot as usize;
    let i = s * 2;
    if i + 1 >= scratch.table.len() {
        w.write_str("");
        return;
    }
    let offset = scratch.table[i] as usize;
    let length = scratch.table[i + 1] as usize;
    if offset + length > scratch.bytes.len() {
        w.write_str("");
        return;
    }
    // SAFETY: caller wrote valid UTF-8 into this region. Skip the
    // UTF-8 check (from_utf8 + unwrap) — wasm-bindgen guarantees
    // valid UTF-8 from the JS TextEncoder source.
    let bytes = &scratch.bytes[offset..offset + length];
    let s = unsafe { core::str::from_utf8_unchecked(bytes) };
    w.write_str(s);
}

/// Write the six envelope key-value pairs (id, type, pos, rotation,
/// playerId, changedFields) shared by every encoder kernel. Caller
/// is responsible for writing the parent map header with the right
/// key count (envelope keys + sub-object keys). `changed_fields` is
/// emitted only when `has_changed_fields != 0` so the full-snapshot
/// path can omit the key entirely.
fn write_entity_envelope_keys(
    w: &mut MessagePackWriter,
    id: u32,
    type_tag: u8,
    qpos_x: i32, qpos_y: i32, qpos_z: i32,
    qrot: i32,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) {
    w.write_str("id");
    w.write_uint(id as u64);

    w.write_str("type");
    match type_tag {
        SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
        SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
        _ => w.write_str(""),
    }

    w.write_str("pos");
    w.write_map_header(3);
    w.write_str("x");
    w.write_int(qpos_x as i64);
    w.write_str("y");
    w.write_int(qpos_y as i64);
    w.write_str("z");
    w.write_int(qpos_z as i64);

    w.write_str("rotation");
    w.write_int(qrot as i64);

    w.write_str("playerId");
    w.write_uint(player_id as u64);

    if has_changed_fields != 0 {
        w.write_str("changedFields");
        w.write_uint(changed_fields as u64);
    }
}

/// Encode the always-present entity envelope: `{id, type, pos,
/// rotation, playerId [, changedFields]}` — the five fields every
/// NetworkServerSnapshotEntity carries plus the optional delta mask.
/// Output written to the D.2 writer; returns the number of bytes.
///
/// Field order matches the JS DTO's property insertion order so the
/// MessagePack key sequence is identical: id → type → pos → rotation
/// → playerId → changedFields. Quantized integers are passed in as
/// i32 (caller does qPos / qRot conversion).
#[wasm_bindgen]
pub fn snapshot_encode_entity_basic(
    id: u32,
    type_tag: u8,
    qpos_x: i32,
    qpos_y: i32,
    qpos_z: i32,
    qrot: i32,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count: usize = 5;
    if has_changed_fields != 0 {
        key_count += 1;
    }
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w, id, type_tag,
        qpos_x, qpos_y, qpos_z, qrot,
        player_id, has_changed_fields, changed_fields,
    );
    (w.buf.len() - start) as u32
}

/// Encode an entity with a unit sub-object. Mandatory keys: `hp` +
/// `velocity`. Optional keys gated by `has_*` flags: movementAccel,
/// surfaceNormal, suspension.
///
/// suspension is nested: `{offset, velocity, [legContact]}`. The
/// `legContact` key is either `true` or absent (never `false`) —
/// JS writes `out.legContact = ... ? true : undefined;` and
/// ignoreUndefined drops the undefined case. `leg_contact` here is
/// 0 (omit) or 1 (emit true).
///
/// Field order inside `unit` mirrors NetworkUnitSnapshot's type
/// declaration.
#[wasm_bindgen]
pub fn snapshot_encode_entity_unit(
    id: u32,
    type_tag: u8,
    qpos_x: i32, qpos_y: i32, qpos_z: i32,
    qrot: i32,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    hp_curr: f64,
    hp_max: f64,
    qvel_x: i32, qvel_y: i32, qvel_z: i32,
    has_movement_accel: u8,
    qmov_x: i32, qmov_y: i32, qmov_z: i32,
    has_surface_normal: u8,
    qnormal_x: i32, qnormal_y: i32, qnormal_z: i32,
    has_suspension: u8,
    qsuspension_offset_x: i32, qsuspension_offset_y: i32, qsuspension_offset_z: i32,
    qsuspension_vel_x: i32, qsuspension_vel_y: i32, qsuspension_vel_z: i32,
    suspension_leg_contact: u8,
    has_jump: u8,
    jump_enabled: u8,
    jump_active: u8,
    has_jump_launch_seq: u8,
    jump_launch_seq: u32,
    has_orientation: u8,
    qorient_x: i32, qorient_y: i32, qorient_z: i32, qorient_w: i32,
    has_angular_velocity3: u8,
    qangvel_x: i32, qangvel_y: i32, qangvel_z: i32,
    has_angular_acceleration3: u8,
    qangacc_x: i32, qangacc_y: i32, qangacc_z: i32,
    has_fire_enabled: u8,
    has_is_commander: u8,
    has_build_target_id: u8,
    build_target_id_is_null: u8,
    build_target_id: u32,
    has_actions: u8,
    action_count: u8,
    has_turrets: u8,
    turret_count: u8,
    has_build: u8,
    build_complete: u8,
    build_paid_energy: f64,
    build_paid_mana: f64,
    build_paid_metal: f64,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count: usize = 5 + 1; // envelope + unit
    if has_changed_fields != 0 {
        key_count += 1;
    }
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w, id, type_tag,
        qpos_x, qpos_y, qpos_z, qrot,
        player_id, has_changed_fields, changed_fields,
    );

    let mut unit_field_count: usize = 2; // hp + velocity
    if has_movement_accel != 0 { unit_field_count += 1; }
    if has_surface_normal != 0 { unit_field_count += 1; }
    if has_suspension != 0 { unit_field_count += 1; }
    if has_jump != 0 { unit_field_count += 1; }
    if has_orientation != 0 { unit_field_count += 1; }
    if has_angular_velocity3 != 0 { unit_field_count += 1; }
    if has_angular_acceleration3 != 0 { unit_field_count += 1; }
    if has_fire_enabled != 0 { unit_field_count += 1; }
    if has_is_commander != 0 { unit_field_count += 1; }
    if has_build_target_id != 0 { unit_field_count += 1; }
    if has_actions != 0 { unit_field_count += 1; }
    if has_turrets != 0 { unit_field_count += 1; }
    if has_build != 0 { unit_field_count += 1; }

    w.write_str("unit");
    w.write_map_header(unit_field_count);

    w.write_str("hp");
    w.write_map_header(2);
    w.write_str("curr");
    w.write_number(hp_curr);
    w.write_str("max");
    w.write_number(hp_max);

    w.write_str("velocity");
    w.write_map_header(3);
    w.write_str("x");
    w.write_int(qvel_x as i64);
    w.write_str("y");
    w.write_int(qvel_y as i64);
    w.write_str("z");
    w.write_int(qvel_z as i64);

    if has_movement_accel != 0 {
        w.write_str("movementAccel");
        w.write_map_header(3);
        w.write_str("x");
        w.write_int(qmov_x as i64);
        w.write_str("y");
        w.write_int(qmov_y as i64);
        w.write_str("z");
        w.write_int(qmov_z as i64);
    }

    if has_surface_normal != 0 {
        w.write_str("surfaceNormal");
        w.write_map_header(3);
        w.write_str("nx");
        w.write_int(qnormal_x as i64);
        w.write_str("ny");
        w.write_int(qnormal_y as i64);
        w.write_str("nz");
        w.write_int(qnormal_z as i64);
    }

    if has_suspension != 0 {
        let suspension_field_count = if suspension_leg_contact != 0 { 3 } else { 2 };
        w.write_str("suspension");
        w.write_map_header(suspension_field_count);
        w.write_str("offset");
        w.write_map_header(3);
        w.write_str("x");
        w.write_int(qsuspension_offset_x as i64);
        w.write_str("y");
        w.write_int(qsuspension_offset_y as i64);
        w.write_str("z");
        w.write_int(qsuspension_offset_z as i64);
        w.write_str("velocity");
        w.write_map_header(3);
        w.write_str("x");
        w.write_int(qsuspension_vel_x as i64);
        w.write_str("y");
        w.write_int(qsuspension_vel_y as i64);
        w.write_str("z");
        w.write_int(qsuspension_vel_z as i64);
        if suspension_leg_contact != 0 {
            w.write_str("legContact");
            w.write_bool(true);
        }
    }

    if has_jump != 0 {
        let mut jump_field_count: usize = 1;  // enabled (always present)
        if jump_active != 0 { jump_field_count += 1; }
        if has_jump_launch_seq != 0 { jump_field_count += 1; }
        w.write_str("jump");
        w.write_map_header(jump_field_count);
        w.write_str("enabled");
        w.write_bool(jump_enabled != 0);
        if jump_active != 0 {
            w.write_str("active");
            w.write_bool(true);
        }
        if has_jump_launch_seq != 0 {
            w.write_str("launchSeq");
            w.write_uint(jump_launch_seq as u64);
        }
    }

    if has_orientation != 0 {
        w.write_str("orientation");
        w.write_map_header(4);
        w.write_str("x");
        w.write_int(qorient_x as i64);
        w.write_str("y");
        w.write_int(qorient_y as i64);
        w.write_str("z");
        w.write_int(qorient_z as i64);
        w.write_str("w");
        w.write_int(qorient_w as i64);
    }

    if has_angular_velocity3 != 0 {
        w.write_str("angularVelocity3");
        w.write_map_header(3);
        w.write_str("x");
        w.write_int(qangvel_x as i64);
        w.write_str("y");
        w.write_int(qangvel_y as i64);
        w.write_str("z");
        w.write_int(qangvel_z as i64);
    }

    if has_angular_acceleration3 != 0 {
        w.write_str("angularAcceleration3");
        w.write_map_header(3);
        w.write_str("x");
        w.write_int(qangacc_x as i64);
        w.write_str("y");
        w.write_int(qangacc_y as i64);
        w.write_str("z");
        w.write_int(qangacc_z as i64);
    }

    // Tri-state scalar/boolean optionals — JS emits them as
    // `false`/`true`/`number|null` or undefined (omitted). Each
    // `has_*` flag gates the key-value pair entirely.
    if has_fire_enabled != 0 {
        w.write_str("fireEnabled");
        w.write_bool(false);
    }
    if has_is_commander != 0 {
        w.write_str("isCommander");
        w.write_bool(true);
    }
    if has_build_target_id != 0 {
        w.write_str("buildTargetId");
        if build_target_id_is_null != 0 {
            w.write_nil();
        } else {
            w.write_uint(build_target_id as u64);
        }
    }

    if has_actions != 0 {
        let count = action_count as usize;
        let scratch = snapshot_encode_action_scratch();
        w.write_str("actions");
        w.write_array_header(count);
        for a in 0..count {
            let base = a * SNAPSHOT_ENCODE_ACTION_STRIDE;
            let type_code = scratch.buf[base];
            let has_pos = scratch.buf[base + 1] != 0.0;
            let pos_x = scratch.buf[base + 2];
            let pos_y = scratch.buf[base + 3];
            let has_pos_z = scratch.buf[base + 4] != 0.0;
            let pos_z = scratch.buf[base + 5];
            let path_exp = scratch.buf[base + 6] != 0.0;
            let has_target_id = scratch.buf[base + 7] != 0.0;
            let target_id = scratch.buf[base + 8];
            let has_building_type = scratch.buf[base + 9] != 0.0;
            let building_type_string_slot = scratch.buf[base + 10] as u32;
            let has_grid = scratch.buf[base + 11] != 0.0;
            let grid_x = scratch.buf[base + 12];
            let grid_y = scratch.buf[base + 13];
            let has_building_id = scratch.buf[base + 14] != 0.0;
            let building_id = scratch.buf[base + 15];

            // Insertion order in createActionDto: type, pos, posZ,
            // pathExp, targetId, buildingType, grid, buildingId.
            // ignoreUndefined drops absent keys.
            let mut action_field_count: usize = 1; // type (always present)
            if has_pos { action_field_count += 1; }
            if has_pos_z { action_field_count += 1; }
            if path_exp { action_field_count += 1; }
            if has_target_id { action_field_count += 1; }
            if has_building_type { action_field_count += 1; }
            if has_grid { action_field_count += 1; }
            if has_building_id { action_field_count += 1; }
            w.write_map_header(action_field_count);

            w.write_str("type");
            w.write_number(type_code);

            if has_pos {
                w.write_str("pos");
                w.write_map_header(2);
                w.write_str("x");
                w.write_number(pos_x);
                w.write_str("y");
                w.write_number(pos_y);
            }
            if has_pos_z {
                w.write_str("posZ");
                w.write_number(pos_z);
            }
            if path_exp {
                w.write_str("pathExp");
                w.write_bool(true);
            }
            if has_target_id {
                w.write_str("targetId");
                w.write_number(target_id);
            }
            if has_building_type {
                w.write_str("buildingType");
                write_string_from_scratch(w, building_type_string_slot);
            }
            if has_grid {
                w.write_str("grid");
                w.write_map_header(2);
                w.write_str("x");
                w.write_number(grid_x);
                w.write_str("y");
                w.write_number(grid_y);
            }
            if has_building_id {
                w.write_str("buildingId");
                w.write_number(building_id);
            }
        }
    }

    if has_turrets != 0 {
        let count = turret_count as usize;
        let scratch = snapshot_encode_turret_scratch();
        w.write_str("turrets");
        w.write_array_header(count);
        for t in 0..count {
            let base = t * SNAPSHOT_ENCODE_TURRET_STRIDE;
            let qrot = scratch.buf[base];
            let qvel = scratch.buf[base + 1];
            let qacc = scratch.buf[base + 2];
            let qpitch = scratch.buf[base + 3];
            let qpitch_vel = scratch.buf[base + 4];
            let qpitch_acc = scratch.buf[base + 5];
            let turret_id_code = scratch.buf[base + 6];
            let state_code = scratch.buf[base + 7];
            let has_target = scratch.buf[base + 8] != 0.0;
            let target_id_raw = scratch.buf[base + 9];
            let has_ff_range = scratch.buf[base + 10] != 0.0;
            let ff_range_raw = scratch.buf[base + 11];

            // turret DTO: { turret: { id, angular: {6 fields} }, [targetId,]
            // state, [currentForceFieldRange] }
            let mut turret_field_count: usize = 2; // turret + state
            if has_target { turret_field_count += 1; }
            if has_ff_range { turret_field_count += 1; }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2); // id + angular
            w.write_str("id");
            w.write_number(turret_id_code);
            w.write_str("angular");
            w.write_map_header(6);
            w.write_str("rot");
            w.write_number(qrot);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("acc");
            w.write_number(qacc);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);
            w.write_str("pitchAcc");
            w.write_number(qpitch_acc);

            if has_target {
                w.write_str("targetId");
                w.write_number(target_id_raw);
            }

            w.write_str("state");
            w.write_number(state_code);

            if has_ff_range {
                w.write_str("currentForceFieldRange");
                w.write_number(ff_range_raw);
            }
        }
    }

    if has_build != 0 {
        w.write_str("build");
        w.write_map_header(2);  // complete + paid
        w.write_str("complete");
        w.write_bool(build_complete != 0);
        w.write_str("paid");
        w.write_map_header(3);
        w.write_str("energy");
        w.write_number(build_paid_energy);
        w.write_str("mana");
        w.write_number(build_paid_mana);
        w.write_str("metal");
        w.write_number(build_paid_metal);
    }

    (w.buf.len() - start) as u32
}

/// Encode a building entity DTO: `{...envelope, building: {
///   [type,] [dim,] hp, build, [metalExtractionRate,] [solar,] [turrets]
/// }}` — covers everything except the factory sub-object (next commit).
///
/// hp + build are always present (the JS pool initializer creates them
/// non-undefined). Other building-sub fields are gated by their `has_*`
/// flags. Turrets reuse the same scratch as units (D.3j-9).
#[wasm_bindgen]
pub fn snapshot_encode_entity_building(
    id: u32,
    qpos_x: i32, qpos_y: i32, qpos_z: i32,
    qrot: i32,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    has_type: u8,
    type_string_slot: u32,
    has_dim: u8,
    dim_x: f64, dim_y: f64,
    hp_curr: f64,
    hp_max: f64,
    build_complete: u8,
    build_paid_energy: f64,
    build_paid_mana: f64,
    build_paid_metal: f64,
    has_metal_extraction_rate: u8,
    metal_extraction_rate: f64,
    has_solar: u8,
    solar_open: u8,
    has_turrets: u8,
    turret_count: u8,
    has_factory: u8,
    factory_queue_count: u32,
    factory_progress: f64,
    factory_producing: u8,
    factory_energy_rate: f64,
    factory_mana_rate: f64,
    factory_metal_rate: f64,
    factory_waypoint_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count: usize = 5 + 1; // envelope + building
    if has_changed_fields != 0 {
        key_count += 1;
    }
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w, id, SNAPSHOT_ENTITY_TYPE_BUILDING,
        qpos_x, qpos_y, qpos_z, qrot,
        player_id, has_changed_fields, changed_fields,
    );

    let mut building_field_count: usize = 2; // hp + build
    if has_type != 0 { building_field_count += 1; }
    if has_dim != 0 { building_field_count += 1; }
    if has_metal_extraction_rate != 0 { building_field_count += 1; }
    if has_solar != 0 { building_field_count += 1; }
    if has_turrets != 0 { building_field_count += 1; }
    if has_factory != 0 { building_field_count += 1; }

    w.write_str("building");
    w.write_map_header(building_field_count);

    if has_type != 0 {
        w.write_str("type");
        write_string_from_scratch(w, type_string_slot);
    }
    if has_dim != 0 {
        w.write_str("dim");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(dim_x);
        w.write_str("y");
        w.write_number(dim_y);
    }

    w.write_str("hp");
    w.write_map_header(2);
    w.write_str("curr");
    w.write_number(hp_curr);
    w.write_str("max");
    w.write_number(hp_max);

    w.write_str("build");
    w.write_map_header(2);
    w.write_str("complete");
    w.write_bool(build_complete != 0);
    w.write_str("paid");
    w.write_map_header(3);
    w.write_str("energy");
    w.write_number(build_paid_energy);
    w.write_str("mana");
    w.write_number(build_paid_mana);
    w.write_str("metal");
    w.write_number(build_paid_metal);

    if has_metal_extraction_rate != 0 {
        w.write_str("metalExtractionRate");
        w.write_number(metal_extraction_rate);
    }
    if has_solar != 0 {
        w.write_str("solar");
        w.write_map_header(1);
        w.write_str("open");
        w.write_bool(solar_open != 0);
    }
    if has_turrets != 0 {
        let count = turret_count as usize;
        let scratch = snapshot_encode_turret_scratch();
        w.write_str("turrets");
        w.write_array_header(count);
        for t in 0..count {
            let base = t * SNAPSHOT_ENCODE_TURRET_STRIDE;
            let qrot_t = scratch.buf[base];
            let qvel = scratch.buf[base + 1];
            let qacc = scratch.buf[base + 2];
            let qpitch = scratch.buf[base + 3];
            let qpitch_vel = scratch.buf[base + 4];
            let qpitch_acc = scratch.buf[base + 5];
            let turret_id_code = scratch.buf[base + 6];
            let state_code = scratch.buf[base + 7];
            let has_target = scratch.buf[base + 8] != 0.0;
            let target_id_raw = scratch.buf[base + 9];
            let has_ff_range = scratch.buf[base + 10] != 0.0;
            let ff_range_raw = scratch.buf[base + 11];

            let mut turret_field_count: usize = 2; // turret + state
            if has_target { turret_field_count += 1; }
            if has_ff_range { turret_field_count += 1; }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2);
            w.write_str("id");
            w.write_number(turret_id_code);
            w.write_str("angular");
            w.write_map_header(6);
            w.write_str("rot");
            w.write_number(qrot_t);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("acc");
            w.write_number(qacc);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);
            w.write_str("pitchAcc");
            w.write_number(qpitch_acc);

            if has_target {
                w.write_str("targetId");
                w.write_number(target_id_raw);
            }
            w.write_str("state");
            w.write_number(state_code);
            if has_ff_range {
                w.write_str("currentForceFieldRange");
                w.write_number(ff_range_raw);
            }
        }
    }

    if has_factory != 0 {
        w.write_str("factory");
        w.write_map_header(7);  // queue, progress, producing, energyRate, manaRate, metalRate, waypoints

        let qc = factory_queue_count as usize;
        w.write_str("queue");
        w.write_array_header(qc);
        if qc > 0 {
            let q = snapshot_encode_factory_queue_scratch();
            for i in 0..qc {
                w.write_uint(q.buf[i] as u64);
            }
        }

        w.write_str("progress");
        w.write_number(factory_progress);

        w.write_str("producing");
        w.write_bool(factory_producing != 0);

        w.write_str("energyRate");
        w.write_number(factory_energy_rate);

        w.write_str("manaRate");
        w.write_number(factory_mana_rate);

        w.write_str("metalRate");
        w.write_number(factory_metal_rate);

        let wpc = factory_waypoint_count as usize;
        w.write_str("waypoints");
        w.write_array_header(wpc);
        if wpc > 0 {
            let wp = snapshot_encode_waypoint_scratch();
            for i in 0..wpc {
                let base = i * SNAPSHOT_ENCODE_WAYPOINT_STRIDE;
                let pos_x = wp.buf[base];
                let pos_y = wp.buf[base + 1];
                let has_pos_z = wp.buf[base + 2] != 0.0;
                let pos_z = wp.buf[base + 3];
                let type_slot = wp.buf[base + 4] as u32;

                let wp_field_count = if has_pos_z { 3 } else { 2 };
                w.write_map_header(wp_field_count);
                w.write_str("pos");
                w.write_map_header(2);
                w.write_str("x");
                w.write_number(pos_x);
                w.write_str("y");
                w.write_number(pos_y);
                if has_pos_z {
                    w.write_str("posZ");
                    w.write_number(pos_z);
                }
                w.write_str("type");
                write_string_from_scratch(w, type_slot);
            }
        }
    }

    (w.buf.len() - start) as u32
}

/// Phase 10 D.3j-15: snapshot envelope encoder.
///
/// Mirrors stateSerializer.ts's `_snapshotBuf` pool entry layout:
/// the entries are inserted in declaration order at pool creation
/// (tick, entities, minimapEntities, economy, sprayTargets,
/// audioEvents, projectiles, gameState, grid, isDelta,
/// removedEntityIds, visibilityFiltered). msgpack-with-
/// ignoreUndefined emits ONLY the keys whose values are not
/// undefined.
///
/// This commit covers the always-present minimum subset:
///   - tick (uint)
///   - entities[] (array of unit/building DTOs appended between
///     `_begin` and `_continue` via the per-entity encoders)
///   - economy (empty map for now)
///   - isDelta (bool)
///
/// Other envelope fields (audioEvents, projectiles, gameState,
/// economy contents, etc.) come in follow-up commits.
///
/// API:
///   1. `snapshot_encode_envelope_begin(tick, entity_count)`
///      → clears the writer, writes the envelope map header + tick
///      key + entities key + array16 header.
///   2. For each entity: JS packs scratches and calls one of the
///      existing entity encoders. They APPEND now (no auto-clear).
///   3. `snapshot_encode_envelope_continue(is_delta)`
///      → writes economy = {} + isDelta key. Returns total
///      written bytes.
/// Removed-entity-IDs scratch — Uint32Array of EntityId values for
/// the envelope's removedEntityIds field. JS pre-fills before
/// calling snapshot_encode_envelope_continue with
/// has_removed_entity_ids=1.
struct SnapshotEncodeRemovedIdsScratch {
    buf: Vec<u32>,
}

struct SnapshotEncodeRemovedIdsScratchHolder(UnsafeCell<Option<SnapshotEncodeRemovedIdsScratch>>);
unsafe impl Sync for SnapshotEncodeRemovedIdsScratchHolder {}
static SNAPSHOT_ENCODE_REMOVED_IDS_SCRATCH: SnapshotEncodeRemovedIdsScratchHolder =
    SnapshotEncodeRemovedIdsScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_removed_ids_scratch() -> &'static mut SnapshotEncodeRemovedIdsScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_REMOVED_IDS_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeRemovedIdsScratch { buf: vec![0u32; 16] });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_removed_ids_scratch_ptr() -> *const u32 {
    snapshot_encode_removed_ids_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_removed_ids_scratch_ensure(count: u32) {
    let s = snapshot_encode_removed_ids_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

/// Open the envelope: clear writer, emit map header with the
/// caller-computed total_key_count, emit tick key + entities array
/// header. `total_key_count` includes tick + entities + every
/// optional envelope key the caller will subsequently emit (the
/// continue function counts only the ones it's about to write).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_begin(
    tick: u32,
    entity_count: u32,
    total_key_count: u32,
) {
    let w = messagepack_writer();
    w.buf.clear();
    w.write_map_header(total_key_count as usize);
    w.write_str("tick");
    w.write_uint(tick as u64);
    w.write_str("entities");
    w.write_array_header(entity_count as usize);
}

/// Close the envelope. Emits the post-entities optional keys in
/// stateSerializer.ts pool-insertion order: economy, gameState,
/// isDelta, removedEntityIds, visibilityFiltered. Caller flags
/// gate which appear; map-header count in _begin must match.
///
/// gameState arrives in a follow-up commit (needs the string scratch
/// for the `phase` field); placeholder reserved here so the argument
/// list stays stable.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_continue(
    has_economy: u8,
    is_delta: u8,
    has_removed_entity_ids: u8,
    removed_entity_id_count: u32,
    has_visibility_filtered: u8,
    visibility_filtered: u8,
) -> u32 {
    let w = messagepack_writer();
    if has_economy != 0 {
        w.write_str("economy");
        w.write_map_header(0);
    }
    w.write_str("isDelta");
    w.write_bool(is_delta != 0);
    if has_removed_entity_ids != 0 {
        let count = removed_entity_id_count as usize;
        let scratch = snapshot_encode_removed_ids_scratch();
        w.write_str("removedEntityIds");
        w.write_array_header(count);
        for i in 0..count {
            w.write_uint(scratch.buf[i] as u64);
        }
    }
    if has_visibility_filtered != 0 {
        w.write_str("visibilityFiltered");
        w.write_bool(visibility_filtered != 0);
    }
    w.buf.len() as u32
}
