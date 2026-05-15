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

struct EngineStaticsHolder(UnsafeCell<Vec<EngineStatics>>);
unsafe impl Sync for EngineStaticsHolder {}
static ENGINE_STATICS: EngineStaticsHolder = EngineStaticsHolder(UnsafeCell::new(Vec::new()));

#[inline]
fn engine_statics(handle: u32) -> &'static mut EngineStatics {
    // SAFETY: WASM is single-threaded; only one Rust call active at a
    // time. The Vec never shrinks (engine_statics_create only pushes)
    // so existing &mut references stay valid across calls.
    unsafe {
        let v = &mut *ENGINE_STATICS.0.get();
        &mut v[handle as usize]
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
        let handle = v.len() as u32;
        v.push(EngineStatics::new());
        handle
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
