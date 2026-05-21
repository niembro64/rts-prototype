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
//  Cross-language tuning values that must not drift are generated
//  from src/sharedSimConstants.json by build.rs.
// ─────────────────────────────────────────────────────────────────

// Generated from src/sharedSimConstants.json by rts-sim-wasm/build.rs.
include!(concat!(env!("OUT_DIR"), "/shared_sim_constants.rs"));

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
        ax,
        ay,
        az,
        air_damp,
        ground_damp,
        launch_ax,
        launch_ay,
        launch_az,
        ground_z,
        normal_x,
        normal_y,
        normal_z,
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
//  forever (no per-tick view refresh). Sized for the current scale
//  target: 5k active units plus commanders, buildings, and headroom
//  for short-lived bodies during stress captures.
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

pub const POOL_CAPACITY: u32 = 8192;
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
        debug_assert_ne!(
            self.flags[i] & BODY_FLAG_OCCUPIED,
            0,
            "freeing already-free slot"
        );
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
            if is_in_contact(next_penetration) && next_penetration <= SLEEP_GROUND_PENETRATION_EPS {
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
                                let seed = (a_id.wrapping_mul(73856093)
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
static ENGINE_STATICS: EngineStaticsHolder =
    EngineStaticsHolder(UnsafeCell::new(EngineStaticsTable {
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
        debug_assert!(
            idx < v.handles.len(),
            "engine_statics_destroy: handle out of range"
        );
        debug_assert!(
            v.handles[idx].is_some(),
            "engine_statics_destroy: handle already destroyed"
        );
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
        let mut orientation = [buf[base], buf[base + 1], buf[base + 2], buf[base + 3]];
        let mut omega = [buf[base + 4], buf[base + 5], buf[base + 6]];
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
//  The public TypeScript targeting API derives projectile_acceleration
//  from its required gravity parameter as (0, 0, -gravity). It does not
//  pass air resistance or entity ids into this calculation.
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
    intercept_clamp_time(
        (2.0_f64)
            .max(base_time * 8.0 + 4.0)
            .max(accel_time * 2.0 + 1.0),
    )
}

#[inline]
fn intercept_function(input: &[f64; 22], t: f64) -> f64 {
    let rel_x =
        input[9] - input[0] + (input[12] - input[3]) * t + 0.5 * (input[15] - input[18]) * t * t;
    let rel_y =
        input[10] - input[1] + (input[13] - input[4]) * t + 0.5 * (input[16] - input[19]) * t * t;
    let rel_z =
        input[11] - input[2] + (input[14] - input[5]) * t + 0.5 * (input[17] - input[20]) * t * t;
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

#[inline]
fn solve_kinematic_intercept_inline(
    inp: &[f64; 22],
    out_buf: &mut [f64],
    prefer_late_solution: u8,
    max_time_sec_or_zero: f64,
) -> bool {
    if !intercept_input_finite(inp) {
        return false;
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
        return false;
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
    true
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
    if solve_kinematic_intercept_inline(inp, out_buf, prefer_late_solution, max_time_sec_or_zero) {
        1
    } else {
        0
    }
}

// ─────────────────────────────────────────────────────────────────
//  AIM-05 — Homing thrust acceleration
//
//  Mirrors src/game/math/HomingSteering.ts computeHomingThrust.
//  Returns the bounded steering acceleration a guided projectile
//  applies this tick: lateral guidance toward the predicted intercept
//  plus optional gravity compensation, clamped to the projectile's
//  available thrust acceleration. Rocket-class callers pass gravity 0
//  so their engine budget goes to steering rather than holding altitude.
//
//  Output buffer (3 f64s): thrustX, thrustY, thrustZ.
//
//  Used per-homing-projectile per-tick by both the server projectile
//  system and the client prediction stepper. Per-call WASM dispatch —
//  call sites already loop over projectiles individually; batching
//  would require a substantial caller refactor.
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn compute_homing_thrust(
    out_buf: &mut [f64],
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    current_x: f64,
    current_y: f64,
    current_z: f64,
    homing_turn_rate: f64,
    max_thrust_accel: f64,
    gravity: f64,
    dt_sec: f64,
) {
    debug_assert!(out_buf.len() >= 3);
    out_buf[0] = 0.0;
    out_buf[1] = 0.0;
    out_buf[2] = 0.0;

    // Spent / failed guidance: no thrust this tick. The caller still
    // integrates whatever projectile gravity applies to this shot.
    if max_thrust_accel <= 0.0 || dt_sec <= 0.0 {
        return;
    }

    let dx = target_x - current_x;
    let dy = target_y - current_y;
    let dz = target_z - current_z;
    let d_mag = (dx * dx + dy * dy + dz * dz).sqrt();
    let speed = (vel_x * vel_x + vel_y * vel_y + vel_z * vel_z).sqrt();

    // Lateral steering direction (unit vector perpendicular to v in the
    // plane of v and d, pointing toward d) and magnitude (ω · |v|,
    // bounded by θ / dt so we don't overshoot the angle this tick).
    let mut perp_x = 0.0;
    let mut perp_y = 0.0;
    let mut perp_z = 0.0;
    let mut theta = 0.0;

    if d_mag > 1e-6 {
        let inv_d_mag = 1.0 / d_mag;
        let dxn = dx * inv_d_mag;
        // `dyn` is reserved in Rust — use `dyn_` for the y-direction unit.
        let dyn_ = dy * inv_d_mag;
        let dzn = dz * inv_d_mag;

        if speed > 1e-6 {
            let inv_speed = 1.0 / speed;
            let vxn = vel_x * inv_speed;
            let vyn = vel_y * inv_speed;
            let vzn = vel_z * inv_speed;
            let mut cos_a = vxn * dxn + vyn * dyn_ + vzn * dzn;
            if cos_a > 1.0 {
                cos_a = 1.0;
            } else if cos_a < -1.0 {
                cos_a = -1.0;
            }
            theta = cos_a.acos();

            // perp = d̂ − (d̂·v̂)·v̂, normalized
            let p_x = dxn - cos_a * vxn;
            let p_y = dyn_ - cos_a * vyn;
            let p_z = dzn - cos_a * vzn;
            let p_mag = (p_x * p_x + p_y * p_y + p_z * p_z).sqrt();
            if p_mag > 1e-6 {
                let inv = 1.0 / p_mag;
                perp_x = p_x * inv;
                perp_y = p_y * inv;
                perp_z = p_z * inv;
            } else if cos_a < 0.0 {
                // v̂ and d̂ are (nearly) anti-parallel — Gram-Schmidt
                // residual collapses. Pick a stable horizontal
                // perpendicular (rotate v in the xy-plane) so the
                // rocket starts pivoting instead of sitting on the
                // anti-parallel axis.
                let xy_mag = (vxn * vxn + vyn * vyn).sqrt();
                if xy_mag > 0.05 {
                    perp_x = -vyn / xy_mag;
                    perp_y = vxn / xy_mag;
                    perp_z = 0.0;
                } else {
                    // Velocity is essentially vertical — fall back to world +x.
                    perp_x = 1.0;
                    perp_y = 0.0;
                    perp_z = 0.0;
                }
                theta = core::f64::consts::PI;
            }
            // (cos_a ≈ +1: already aligned, theta ≈ 0, no lateral thrust needed.)
        }
        // Zero-velocity edge case: leave perp = 0 and let any caller-
        // provided gravity compensation define the thrust direction.
    }

    let omega_eff = if theta / dt_sec < homing_turn_rate {
        theta / dt_sec
    } else {
        homing_turn_rate
    };
    let a_lateral_mag = omega_eff * speed;

    // Desired thrust: lateral steering plus optional vertical gravity
    // compensation. The clamp below decides how much of that the
    // projectile's engine can actually deliver.
    let mut a_x = perp_x * a_lateral_mag;
    let mut a_y = perp_y * a_lateral_mag;
    let mut a_z = perp_z * a_lateral_mag + gravity;

    let a_mag = (a_x * a_x + a_y * a_y + a_z * a_z).sqrt();
    if a_mag > max_thrust_accel {
        let scale = max_thrust_accel / a_mag;
        a_x *= scale;
        a_y *= scale;
        a_z *= scale;
    }

    out_buf[0] = a_x;
    out_buf[1] = a_y;
    out_buf[2] = a_z;
}

/// Per-tick ballistic integrator. For slots 0..count, advances with the
/// same constant-acceleration equation the ballistic aim solver uses:
///   pos_x[i] += vel_x[i] * dt_sec
///   pos_y[i] += vel_y[i] * dt_sec
///   pos_z[i] += vel_z[i] * dt_sec - 0.5 * GRAVITY * dt_sec^2
///   vel_z[i] -= GRAVITY * dt_sec
/// Same math as the inner loop in projectileSystem._updatePackedProjectilesJS.
#[wasm_bindgen]
pub fn pool_step_packed_projectiles_batch(count: u32, dt_sec: f64) {
    let p = projectile_pool();
    let n = count as usize;
    debug_assert!(n <= PROJECTILE_POOL_CAPACITY_USIZE);
    let half_dt_sq = 0.5 * dt_sec * dt_sec;
    for i in 0..n {
        p.pos_x[i] += p.vel_x[i] * dt_sec;
        p.pos_y[i] += p.vel_y[i] * dt_sec;
        if p.has_gravity[i] != 0 {
            p.pos_z[i] += p.vel_z[i] * dt_sec - GRAVITY * half_dt_sq;
            p.vel_z[i] -= GRAVITY * dt_sec;
        } else {
            p.pos_z[i] += p.vel_z[i] * dt_sec;
        }
    }
}

// ─────────────────────────────────────────────────────────────────
//  Phase 6a — Damped-spring single-axis rotation integrator
//
//  Mirrors src/game/math/MathHelpers.ts integrateDampedRotation.
//  Used by the authoritative turretSystem per tick. Client prediction
//  consumes the emitted angle/velocity and coasts from velocity only,
//  so this kernel is the source of the turret spring contract.
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

    let safe_dt = if dt_sec.is_finite() {
        dt_sec.max(0.0)
    } else {
        0.0
    };
    let safe_k = if k.is_finite() { k.max(0.0) } else { 0.0 };
    let safe_c = if c.is_finite() { c.max(0.0) } else { 0.0 };
    let safe_angle = if angle.is_finite() { angle } else { 0.0 };
    let safe_vel = if angular_vel.is_finite() {
        angular_vel
    } else {
        0.0
    };
    let safe_target = if target_angle.is_finite() {
        target_angle
    } else {
        0.0
    };

    let relative_angle = if wrap {
        normalize_angle_ts(safe_angle - safe_target)
    } else {
        safe_angle - safe_target
    };

    let mut new_relative = relative_angle;
    let mut new_vel = safe_vel;
    if safe_dt > 0.0 && safe_k > 0.0 {
        let discriminant = safe_c * safe_c - 4.0 * safe_k;
        if discriminant.abs() <= 1e-9 {
            let r = -safe_c / 2.0;
            let b = safe_vel - r * relative_angle;
            let e = (r * safe_dt).exp();
            new_relative = (relative_angle + b * safe_dt) * e;
            new_vel = (b + r * (relative_angle + b * safe_dt)) * e;
        } else if discriminant > 0.0 {
            let root = discriminant.sqrt();
            let r1 = (-safe_c + root) / 2.0;
            let r2 = (-safe_c - root) / 2.0;
            let denom = r1 - r2;
            let a = if denom != 0.0 {
                (safe_vel - r2 * relative_angle) / denom
            } else {
                relative_angle
            };
            let b = relative_angle - a;
            let e1 = (r1 * safe_dt).exp();
            let e2 = (r2 * safe_dt).exp();
            new_relative = a * e1 + b * e2;
            new_vel = a * r1 * e1 + b * r2 * e2;
        } else {
            let alpha = -safe_c / 2.0;
            let omega = (-discriminant).sqrt() / 2.0;
            let a = relative_angle;
            let b = if omega > 0.0 {
                (safe_vel - alpha * relative_angle) / omega
            } else {
                0.0
            };
            let e = (alpha * safe_dt).exp();
            let cos = (omega * safe_dt).cos();
            let sin = (omega * safe_dt).sin();
            new_relative = e * (a * cos + b * sin);
            new_vel = e * (alpha * (a * cos + b * sin) + (-a * omega * sin + b * omega * cos));
        }
    } else if safe_dt > 0.0 && safe_c > 0.0 {
        let e = (-safe_c * safe_dt).exp();
        new_relative = relative_angle + safe_vel * (1.0 - e) / safe_c;
        new_vel = safe_vel * e;
    } else if safe_dt > 0.0 {
        new_relative = relative_angle + safe_vel * safe_dt;
    }

    let mut new_angle = safe_target + new_relative;
    let mut out_acc = if safe_dt > 0.0 {
        (new_vel - safe_vel) / safe_dt
    } else {
        0.0
    };
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
    vertex_coords: Vec<f64>, // (x, z) pairs, length = 2 * vertex_count
    vertex_heights: Vec<f64>,
    triangle_indices: Vec<i32>, // (ia, ib, ic) triples, length = 3 * triangle_count
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
    t.cell_triangle_offsets
        .extend_from_slice(cell_triangle_offsets);
    t.cell_triangle_indices.clear();
    t.cell_triangle_indices
        .extend_from_slice(cell_triangle_indices);
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
    if terrain_grid().installed {
        1
    } else {
        0
    }
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
    px: f64,
    pz: f64,
    ax: f64,
    az: f64,
    bx: f64,
    bz: f64,
    cx: f64,
    cz: f64,
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
    f64,
    f64,
    f64, // weights
    f64,
    f64,
    f64, // a (x, z, h)
    f64,
    f64,
    f64, // b
    f64,
    f64,
    f64, // c
);

fn terrain_triangle_sample_at(
    t: &TerrainGrid,
    px: f64,
    pz: f64,
    cell_x: i32,
    cell_y: i32,
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
            final_wa, final_wb, final_wc, ax, az, ah, bx, bz, bh, cx, cz, ch,
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
    let px = if x <= 0.0 {
        0.0
    } else if x >= max_x {
        max_x
    } else {
        x
    };
    let pz = if z <= 0.0 {
        0.0
    } else if z >= max_z {
        max_z
    } else {
        z
    };
    let cell_x = ((px / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_x - 1);
    let cell_y = ((pz / t.cell_size).floor() as i32)
        .max(0)
        .min(t.cells_y - 1);
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
/// Mirrors hasTerrainLineOfSight in terrainLineOfSight.ts. Caller passes
/// the JS-side step_len (LAND_CELL_SIZE * 0.5 today — kept JS-side
/// so we don't duplicate the LAND_CELL_SIZE constant across the
/// boundary).
#[wasm_bindgen]
pub fn terrain_has_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
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
//  Big-bang port of src/game/sim/SpatialGrid.ts (1438 lines, query
//  families and mutation methods). The JS-side
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
const SPATIAL_TERRAIN_MAX_RENDER_Y: f64 = 1600.0; // TERRAIN_SHAPE_MAGNITUDE(800) * 2

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

struct SpatialGridState {
    cell_size: f64,
    half_cell_size: f64,

    cells: HashMap<u64, SpatialCellBucket>,
    cell_pool: Vec<SpatialCellBucket>,

    // Per-slot SoA. slot_kind == SPATIAL_KIND_UNSET means free.
    slot_kind: Vec<u8>,
    slot_entity_id: Vec<i32>,
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
            slot_entity_id: Vec::new(),
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

fn spatial_get_or_create_cell<'a>(
    state: &'a mut SpatialGridState,
    key: u64,
) -> &'a mut SpatialCellBucket {
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
            if idx != last {
                bucket.units.swap(idx, last);
            }
            bucket.units.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

fn spatial_remove_projectile_from_cell(state: &mut SpatialGridState, cell_key: u64, slot: u32) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.projectiles.iter().position(|&s| s == slot) {
            let last = bucket.projectiles.len() - 1;
            if idx != last {
                bucket.projectiles.swap(idx, last);
            }
            bucket.projectiles.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
}

fn spatial_remove_building_from_cell(state: &mut SpatialGridState, cell_key: u64, slot: u32) {
    if let Some(bucket) = state.cells.get_mut(&cell_key) {
        if let Some(idx) = bucket.buildings.iter().position(|&s| s == slot) {
            let last = bucket.buildings.len() - 1;
            if idx != last {
                bucket.buildings.swap(idx, last);
            }
            bucket.buildings.pop();
        }
    }
    spatial_prune_cell_if_empty(state, cell_key);
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
    bx: f64,
    by: f64,
    bz: f64,
    hx: f64,
    hy: f64,
    hz: f64,
    px: f64,
    py: f64,
    pz: f64,
) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let min_z = bz - hz;
    let max_z = bz + hz;
    let cxp = if px < min_x {
        min_x
    } else if px > max_x {
        max_x
    } else {
        px
    };
    let cyp = if py < min_y {
        min_y
    } else if py > max_y {
        max_y
    } else {
        py
    };
    let czp = if pz < min_z {
        min_z
    } else if pz > max_z {
        max_z
    } else {
        pz
    };
    let dx = cxp - px;
    let dy = cyp - py;
    let dz = czp - pz;
    dx * dx + dy * dy + dz * dz
}

#[inline]
fn spatial_dist_sq_to_aabb2(bx: f64, by: f64, hx: f64, hy: f64, px: f64, py: f64) -> f64 {
    let min_x = bx - hx;
    let max_x = bx + hx;
    let min_y = by - hy;
    let max_y = by + hy;
    let cxp = if px < min_x {
        min_x
    } else if px > max_x {
        max_x
    } else {
        px
    };
    let cyp = if py < min_y {
        min_y
    } else if py > max_y {
        max_y
    } else {
        py
    };
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
    state.free_slots.clear();
    state.next_slot = 0;
    state.nearby_cells.clear();
    state.dedup.clear();
    state.scratch_u32.clear();
    // Pre-size per-slot arrays.
    let cap = initial_slot_capacity as usize;
    state.slot_kind.clear();
    state.slot_kind.resize(cap, SPATIAL_KIND_UNSET);
    state.slot_entity_id.clear();
    state.slot_entity_id.resize(cap, -1);
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
    // Reset slot ownership but keep allocations.
    for k in state.slot_kind.iter_mut() {
        *k = SPATIAL_KIND_UNSET;
    }
    for id in state.slot_entity_id.iter_mut() {
        *id = -1;
    }
    for c in state.building_cells.iter_mut() {
        c.clear();
    }
    for cube in state.slot_cube_key.iter_mut() {
        *cube = 0;
    }
    state.free_slots.clear();
    state.next_slot = 0;
}

fn spatial_ensure_slot_capacity(state: &mut SpatialGridState, slot: u32) {
    let needed = (slot as usize) + 1;
    if state.slot_kind.len() >= needed {
        return;
    }
    state.slot_kind.resize(needed, SPATIAL_KIND_UNSET);
    state.slot_entity_id.resize(needed, -1);
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
pub fn spatial_set_entity_id(slot: u32, entity_id: i32) {
    let state = spatial_grid();
    let s = slot as usize;
    spatial_ensure_slot_capacity(state, slot);
    state.slot_entity_id[s] = entity_id;
}

#[wasm_bindgen]
pub fn spatial_free_slot(slot: u32) {
    spatial_unset_slot(slot);
    spatial_grid().free_slots.push(slot);
}

// ===================== Mutations =====================

/// Insert or update a unit at slot. owner_player == 0 means "no owner"
/// (matches the JS `entity.ownership?.playerId ?? 0`). hp_alive is the
/// HP > 0 flag — pass 0 to remove the slot.
#[wasm_bindgen]
pub fn spatial_set_unit(
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
    radius_push: f64,
    radius_shot: f64,
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
}

#[wasm_bindgen]
pub fn spatial_set_projectile(
    slot: u32,
    x: f64,
    y: f64,
    z: f64,
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
            spatial_get_or_create_cell(state, new_key)
                .projectiles
                .push(slot);
            state.slot_cube_key[s] = new_key;
        }
    } else {
        spatial_get_or_create_cell(state, new_key)
            .projectiles
            .push(slot);
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
    x: f64,
    y: f64,
    z: f64,
    hx: f64,
    hy: f64,
    hz: f64,
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
}

#[wasm_bindgen]
pub fn spatial_unset_slot(slot: u32) {
    let state = spatial_grid();
    let s = slot as usize;
    if s >= state.slot_kind.len() {
        return;
    }
    match state.slot_kind[s] {
        SPATIAL_KIND_UNIT => {
            let key = state.slot_cube_key[s];
            spatial_remove_unit_from_cell(state, key, slot);
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
        }
        _ => {}
    }
    state.slot_kind[s] = SPATIAL_KIND_UNSET;
    state.slot_entity_id[s] = -1;
    state.slot_hp_alive[s] = 0;
    state.slot_entity_active[s] = 0;
    state.slot_cube_key[s] = 0;
}

// ===================== Cell-sweep helpers =====================

fn spatial_collect_cells_in_radius(
    state: &mut SpatialGridState,
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
) {
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
    x: f64,
    y: f64,
    radius: f64,
    z_min: f64,
    z_max: f64,
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
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> bool {
    state.nearby_cells.clear();
    if !x1.is_finite()
        || !y1.is_finite()
        || !z1.is_finite()
        || !x2.is_finite()
        || !y2.is_finite()
        || !z2.is_finite()
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
        return spatial_fill_occupied_cells_for_line(
            state, min_x, max_x, min_y, max_y, min_z, max_z,
        );
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
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    min_z: f64,
    max_z: f64,
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
        if cell_max_x < min_x || cell_min_x > max_x {
            continue;
        }
        let cell_min_y = cy * cs;
        let cell_max_y = cell_min_y + cs;
        if cell_max_y < min_y || cell_min_y > max_y {
            continue;
        }
        let cell_min_z = cz * cs - hcs;
        let cell_max_z = cell_min_z + cs;
        if cell_max_z < min_z || cell_min_z > max_z {
            continue;
        }
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    include_shot_radius: bool,
    ground_plane_only: bool,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_UNIT {
        return;
    }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player {
        return;
    }
    if require_alive && state.slot_hp_alive[s] == 0 {
        return;
    }

    let mut check_radius_sq = radius_sq;
    if include_shot_radius {
        let shot = state.slot_radius_shot[s];
        // JS path: `if (shotRadius === undefined) return;` We treat
        // 0.0 as "no shot radius" since units always set it positively.
        if shot <= 0.0 {
            return;
        }
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
    x: f64,
    y: f64,
    z: f64,
    radius_sq: f64,
    exclude_player: u8,
) {
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_PROJECTILE {
        return;
    }
    if state.slot_proj_is_projectile_type[s] == 0 {
        return;
    }
    let owner = state.slot_owner_player[s];
    if owner == exclude_player {
        return;
    }
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
    x: f64,
    y: f64,
    z: f64,
    radius_sq: f64,
    exclude_player: u8,
    require_alive: bool,
    ground_plane_only: bool,
) {
    if !dedup.insert(slot) {
        return;
    }
    let s = slot as usize;
    if state.slot_kind[s] != SPATIAL_KIND_BUILDING {
        return;
    }
    let owner = state.slot_owner_player[s];
    if exclude_player != 0 && owner == exclude_player {
        return;
    }
    if require_alive && state.slot_hp_alive[s] == 0 {
        return;
    }

    let dist_sq = if ground_plane_only {
        spatial_dist_sq_to_aabb2(
            state.slot_x[s],
            state.slot_y[s],
            state.slot_aabb_hx[s],
            state.slot_aabb_hy[s],
            x,
            y,
        )
    } else {
        spatial_dist_sq_to_aabb3(
            state.slot_x[s],
            state.slot_y[s],
            state.slot_z[s],
            state.slot_aabb_hx[s],
            state.slot_aabb_hy[s],
            state.slot_aabb_hz[s],
            x,
            y,
            z,
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
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
                    state,
                    &mut out,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    require_alive != 0,
                    false,
                    false,
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
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
                    state,
                    &mut dedup,
                    &mut out,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                    require_alive != 0,
                    false,
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
pub fn spatial_query_units_and_buildings_in_radius(x: f64, y: f64, z: f64, radius: f64) -> u32 {
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
                    state, &mut buf, slot, x, y, z, radius, radius_sq, 0, false, false, false,
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
                    state, &mut dedup, &mut buf, slot, x, y, z, radius_sq, 0, false, false,
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
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // header: n_units
    state.scratch_u32.push(0); // header: n_buildings
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_buildings
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
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
                    false,
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
                    state,
                    &mut dedup,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
                    true,
                    false,
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
    x: f64,
    y: f64,
    radius: f64,
    exclude_player: u8,
    z_min: f64,
    z_max: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0);
    state.scratch_u32.push(0);
    state.dedup.clear();
    spatial_collect_cells_in_circle2d(
        state,
        x,
        y,
        radius + SPATIAL_MAX_UNIT_SHOT_RADIUS,
        z_min,
        z_max,
    );
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut dedup = std::mem::take(&mut state.dedup);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    0.0,
                    radius,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
                    true,
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
                    state,
                    &mut dedup,
                    &mut buf,
                    slot,
                    x,
                    y,
                    0.0,
                    radius_sq,
                    exclude_player,
                    true,
                    true,
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
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
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
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
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
    x1: f64,
    y1: f64,
    z1: f64,
    x2: f64,
    y2: f64,
    z2: f64,
    line_width: f64,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_buildings
    if !spatial_collect_cells_along_line(state, x1, y1, z1, x2, y2, z2, line_width) {
        return 2; // headers only, both zero
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

#[inline]
fn spatial_slot_is_los_excluded(
    state: &SpatialGridState,
    slot: u32,
    source_entity_id: i32,
    target_entity_id: i32,
) -> bool {
    let s = slot as usize;
    if s >= state.slot_entity_id.len() {
        return false;
    }
    let entity_id = state.slot_entity_id[s];
    entity_id >= 0 && (entity_id == source_entity_id || entity_id == target_entity_id)
}

#[inline]
fn segment_intersects_sphere(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    radius: f64,
) -> bool {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;
    let a = dx * dx + dy * dy + dz * dz;
    if a == 0.0 {
        return false;
    }
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - radius * radius;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 >= 0.0 && t1 <= 1.0) || (t2 >= 0.0 && t2 <= 1.0)
}

#[inline]
fn segment_intersects_aabb(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    max_x: f64,
    max_y: f64,
    max_z: f64,
) -> bool {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let mut tmin = 0.0;
    let mut tmax = 1.0;

    if dx.abs() > 1e-9 {
        let mut t1 = (min_x - sx) / dx;
        let mut t2 = (max_x - sx) / dx;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sx < min_x || sx > max_x {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    if dy.abs() > 1e-9 {
        let mut t1 = (min_y - sy) / dy;
        let mut t2 = (max_y - sy) / dy;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sy < min_y || sy > max_y {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    if dz.abs() > 1e-9 {
        let mut t1 = (min_z - sz) / dz;
        let mut t2 = (max_z - sz) / dz;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin {
            tmin = t1;
        }
        if t2 < tmax {
            tmax = t2;
        }
    } else if sz < min_z || sz > max_z {
        return false;
    }
    if tmin > tmax {
        return false;
    }

    tmax >= 0.0
}

fn spatial_has_entity_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    line_width: f64,
    source_entity_id: i32,
    target_entity_id: i32,
) -> bool {
    let state = spatial_grid();
    if !spatial_collect_cells_along_line(state, sx, sy, sz, tx, ty, tz, line_width) {
        return true;
    }

    state.dedup.clear();
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut dedup = std::mem::take(&mut state.dedup);

    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                let s = slot as usize;
                if !dedup.insert(slot) {
                    continue;
                }
                if s >= state.slot_kind.len()
                    || state.slot_kind[s] != SPATIAL_KIND_UNIT
                    || state.slot_hp_alive[s] == 0
                    || spatial_slot_is_los_excluded(state, slot, source_entity_id, target_entity_id)
                {
                    continue;
                }
                if segment_intersects_sphere(
                    sx,
                    sy,
                    sz,
                    tx,
                    ty,
                    tz,
                    state.slot_x[s],
                    state.slot_y[s],
                    state.slot_z[s],
                    state.slot_radius_push[s],
                ) {
                    state.nearby_cells = nearby;
                    state.dedup = dedup;
                    return false;
                }
            }
        }
    }

    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.buildings {
                let s = slot as usize;
                if !dedup.insert(slot) {
                    continue;
                }
                if s >= state.slot_kind.len()
                    || state.slot_kind[s] != SPATIAL_KIND_BUILDING
                    || state.slot_hp_alive[s] == 0
                    || spatial_slot_is_los_excluded(state, slot, source_entity_id, target_entity_id)
                {
                    continue;
                }
                let hx = state.slot_aabb_hx[s];
                let hy = state.slot_aabb_hy[s];
                let hz = state.slot_aabb_hz[s];
                if segment_intersects_aabb(
                    sx,
                    sy,
                    sz,
                    tx,
                    ty,
                    tz,
                    state.slot_x[s] - hx,
                    state.slot_y[s] - hy,
                    state.slot_z[s] - hz,
                    state.slot_x[s] + hx,
                    state.slot_y[s] + hy,
                    state.slot_z[s] + hz,
                ) {
                    state.nearby_cells = nearby;
                    state.dedup = dedup;
                    return false;
                }
            }
        }
    }

    state.nearby_cells = nearby;
    state.dedup = dedup;
    true
}

/// AIM-08.LOS — full combat line-of-sight gate. One WASM dispatch
/// checks terrain first, then live unit/building blockers from the
/// spatial slab. Returns 1 when clear and 0 when any terrain sample,
/// unit push sphere, or building AABB blocks the segment. A missing
/// terrain mesh is treated as terrain-clear; normal server/client
/// boot installs the mesh before combat ticks, and this keeps the
/// kernel usable in low-level tests that only populate blockers.
#[wasm_bindgen]
pub fn combat_has_line_of_sight(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    terrain_step_len: f64,
    entity_line_width: f64,
    source_entity_id: i32,
    target_entity_id: i32,
) -> u32 {
    if terrain_has_line_of_sight(sx, sy, sz, tx, ty, tz, terrain_step_len) == 0 {
        return 0;
    }
    if !spatial_has_entity_line_of_sight(
        sx,
        sy,
        sz,
        tx,
        ty,
        tz,
        entity_line_width,
        source_entity_id,
        target_entity_id,
    ) {
        return 0;
    }
    1
}

#[wasm_bindgen]
pub fn spatial_query_enemy_units_in_radius(
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
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
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    false,
                    false,
                    false,
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
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
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
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
    x: f64,
    y: f64,
    z: f64,
    radius: f64,
    exclude_player: u8,
) -> u32 {
    let state = spatial_grid();
    state.scratch_u32.clear();
    state.scratch_u32.push(0); // n_units
    state.scratch_u32.push(0); // n_projectiles
    spatial_collect_cells_in_radius(state, x, y, z, radius);
    let radius_sq = radius * radius;
    let nearby = std::mem::take(&mut state.nearby_cells);
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let unit_start = buf.len();
    for key in &nearby {
        if let Some(bucket) = state.cells.get(key) {
            for &slot in &bucket.units {
                spatial_push_unit_if_in_radius(
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius,
                    radius_sq,
                    exclude_player,
                    false,
                    false,
                    false,
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
                    state,
                    &mut buf,
                    slot,
                    x,
                    y,
                    z,
                    radius_sq,
                    exclude_player,
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

// ===================== Debug queries =====================

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
    let cells_iter: Vec<(u64, &SpatialCellBucket)> =
        state.cells.iter().map(|(k, v)| (*k, v)).collect();
    let mut buf = std::mem::take(&mut state.scratch_u32);
    let mut seen_players: std::collections::HashSet<u8> = std::collections::HashSet::new();
    for (key, bucket) in cells_iter {
        if bucket.units.is_empty() {
            continue;
        }
        seen_players.clear();
        for &slot in &bucket.units {
            let owner = state.slot_owner_player[slot as usize];
            if owner != 0 {
                seen_players.insert(owner);
            }
        }
        if seen_players.is_empty() {
            continue;
        }
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
    if (slot as usize) >= state.slot_kind.len() {
        return SPATIAL_KIND_UNSET;
    }
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
    terrain_only_key: u64, // = (tVer as u64) << 32 | (gridW as u64) << 16 | gridH
    full_mask_key: u128,   // = tVer | bVer | gridW | gridH

    // Sorted snap offsets — populated once per grid-dim change.
    snap_offsets: Vec<(i16, i16)>,

    // Output: smoothed waypoints as (x, y) f64 pairs.
    waypoint_scratch: Vec<f64>,
}

impl PathfinderState {
    fn empty() -> Self {
        Self {
            grid_w: 0,
            grid_h: 0,
            n: 0,
            map_width: 0.0,
            map_height: 0.0,
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
            if dx == 0 && dy == 0 {
                continue;
            }
            let d2 = dx * dx + dy * dy;
            if d2 > r * r {
                continue;
            }
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
    state.blocked.clear();
    state.blocked.resize(n, 0);
    state.terrain_blocked.clear();
    state.terrain_blocked.resize(n, 0);
    state.terrain_normal_z.clear();
    state.terrain_normal_z.resize(n, 1.0);
    state.cc_labels.clear();
    state.cc_labels.resize(n, 0);
    state.g_score.clear();
    state.g_score.resize(n, f32::INFINITY);
    state.f_score.clear();
    state.f_score.resize(n, f32::INFINITY);
    state.parent.clear();
    state.parent.resize(n, -1);
    state.closed.clear();
    state.closed.resize(n, 0);
    state.heap.clear();
    state.bfs_queue.clear();
    state.bfs_queue.resize(n, 0);
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
    let key =
        ((terrain_version as u64) << 32) | ((state.grid_w as u64) << 16) | (state.grid_h as u64);
    if key == state.terrain_only_key {
        return;
    }

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
    for cell in state.terrain_blocked.iter_mut() {
        *cell = 0;
    }
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
    if key == state.full_mask_key {
        return;
    }

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
            if ny < 0 || ny >= grid_h {
                continue;
            }
            let row = ny * grid_w;
            for dx in -bk..=bk {
                let nx = gx + dx;
                if nx < 0 || nx >= grid_w {
                    continue;
                }
                state.blocked[(row + nx) as usize] = 1;
            }
        }
    }

    // CC labelling via BFS over open cells.
    state.cc_labels.fill(0);
    let mut next_label: i16 = 1;
    for seed in 0..state.n {
        if state.blocked[seed] == 1 || state.cc_labels[seed] != 0 {
            continue;
        }
        if next_label > 32_000 {
            break;
        }
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
                if ny < 0 || ny >= grid_h {
                    continue;
                }
                let row = ny * grid_w;
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = cgx + dx;
                    if nx < 0 || nx >= grid_w {
                        continue;
                    }
                    let nidx = (row + nx) as usize;
                    if state.blocked[nidx] == 1 || state.cc_labels[nidx] != 0 {
                        continue;
                    }
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
    if state.blocked[idx] == 1 {
        return false;
    }
    if min_normal_z <= 0.0 {
        return true;
    }
    state.terrain_normal_z[idx] >= min_normal_z
}

#[inline]
fn pathfinder_is_grid_cell_passable(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    min_normal_z: f32,
) -> bool {
    if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
        return false;
    }
    pathfinder_is_cell_passable(state, (gy * state.grid_w + gx) as usize, min_normal_z)
}

fn pathfinder_find_nearest_open(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    min_normal_z: f32,
) -> Option<(i32, i32)> {
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        if pathfinder_is_cell_passable(state, (ny * state.grid_w + nx) as usize, min_normal_z) {
            return Some((nx, ny));
        }
    }
    None
}

fn pathfinder_find_nearest_in_component(
    state: &PathfinderState,
    gx: i32,
    gy: i32,
    component: i16,
    min_normal_z: f32,
) -> Option<(i32, i32)> {
    if component <= 0 {
        return None;
    }
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    // Fast snap-radius scan first.
    for &(dx, dy) in &state.snap_offsets {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
            continue;
        }
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
            if state.cc_labels[idx] != component {
                continue;
            }
            if !pathfinder_is_cell_passable(state, idx, min_normal_z) {
                continue;
            }
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
            if l < len
                && state.f_score[state.heap[l] as usize] < state.f_score[state.heap[s] as usize]
            {
                s = l;
            }
            if r < len
                && state.f_score[state.heap[r] as usize] < state.f_score[state.heap[s] as usize]
            {
                s = r;
            }
            if s == i {
                break;
            }
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
    1.0,
    1.0,
    1.0,
    1.0,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
    PATHFINDER_SQRT2,
];

struct AStarResult {
    cells: Vec<u32>, // sequence of cell indices from start to goal (excluding start)
    goal_gx: i32,
    goal_gy: i32,
    reached_goal: bool,
}

fn pathfinder_a_star(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    min_normal_z: f32,
) -> Option<AStarResult> {
    let grid_w = state.grid_w;
    let grid_h = state.grid_h;
    let n = state.n;
    // Reset scratch.
    for v in state.g_score.iter_mut() {
        *v = f32::INFINITY;
    }
    for v in state.f_score.iter_mut() {
        *v = f32::INFINITY;
    }
    for v in state.parent.iter_mut() {
        *v = -1;
    }
    for v in state.closed.iter_mut() {
        *v = 0;
    }
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
        if state.closed[cur_us] != 0 {
            continue;
        }
        state.closed[cur_us] = 1;
        expanded += 1;
        if cur == goal_idx {
            found = true;
            break;
        }

        let cur_i32 = cur as i32;
        let cgx = cur_i32 % grid_w;
        let cgy = (cur_i32 - cgx) / grid_w;
        for k in 0..8 {
            let nx = cgx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = cgy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < 0 || ny < 0 || nx >= grid_w || ny >= grid_h {
                continue;
            }
            let nidx = (ny * grid_w + nx) as usize;
            if !pathfinder_is_cell_passable(state, nidx, min_normal_z) {
                continue;
            }
            if state.closed[nidx] != 0 {
                continue;
            }
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
    if !path.is_empty()
        && state.parent[*path.last().unwrap() as usize] == -1
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
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
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
        if gx < 0 || gy < 0 || gx >= state.grid_w || gy >= state.grid_h {
            return false;
        }
        if !pathfinder_is_grid_cell_passable(state, gx, gy, min_normal_z) {
            return false;
        }
        if gx == tgx && gy == tgy {
            return true;
        }
        let e2 = 2 * err;
        let a_x = e2 > -dy;
        let a_y = e2 < dx;
        if a_x && a_y {
            if !pathfinder_is_grid_cell_passable(state, gx + sx, gy, min_normal_z) {
                return false;
            }
            if !pathfinder_is_grid_cell_passable(state, gx, gy + sy, min_normal_z) {
                return false;
            }
        }
        if a_x {
            err -= dy;
            gx += sx;
        }
        if a_y {
            err += dx;
            gy += sy;
        }
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
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
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
        state,
        start_cell_gx,
        start_cell_gy,
        goal_cell_gx,
        goal_cell_gy,
        min_normal_z,
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
        Self {
            buf: Vec::with_capacity(64),
        }
    }

    fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
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
        if v.fract() == 0.0
            && v >= -9_223_372_036_854_775_808.0
            && v <= 18_446_744_073_709_551_615.0
        {
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

    fn append_raw_value(&mut self, bytes: &[u8]) {
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

#[wasm_bindgen]
pub fn messagepack_writer_append_raw_value(bytes: &[u8]) -> u32 {
    let w = messagepack_writer();
    w.append_raw_value(bytes);
    w.buf.len() as u32
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
    if !check(&mut w, &[0xC0], 0) {
        failures |= 1 << 0;
    }

    // case 1: true / false
    w.write_bool(true);
    w.write_bool(false);
    if !check(&mut w, &[0xC3, 0xC2], 1) {
        failures |= 1 << 1;
    }

    // case 2: positive fixint 0, 127
    w.write_number(0.0);
    w.write_number(127.0);
    if !check(&mut w, &[0x00, 0x7F], 2) {
        failures |= 1 << 2;
    }

    // case 3: negative fixint -1, -32
    w.write_number(-1.0);
    w.write_number(-32.0);
    if !check(&mut w, &[0xFF, 0xE0], 3) {
        failures |= 1 << 3;
    }

    // case 4: uint8 (128, 255)
    w.write_number(128.0);
    w.write_number(255.0);
    if !check(&mut w, &[0xCC, 0x80, 0xCC, 0xFF], 4) {
        failures |= 1 << 4;
    }

    // case 5: uint16 (256, 65535)
    w.write_number(256.0);
    w.write_number(65535.0);
    if !check(&mut w, &[0xCD, 0x01, 0x00, 0xCD, 0xFF, 0xFF], 5) {
        failures |= 1 << 5;
    }

    // case 6: uint32 (65536, 4294967295)
    w.write_number(65536.0);
    w.write_number(4_294_967_295.0);
    if !check(
        &mut w,
        &[0xCE, 0x00, 0x01, 0x00, 0x00, 0xCE, 0xFF, 0xFF, 0xFF, 0xFF],
        6,
    ) {
        failures |= 1 << 6;
    }

    // case 7: int8 (-33, -128)
    w.write_number(-33.0);
    w.write_number(-128.0);
    if !check(&mut w, &[0xD0, 0xDF, 0xD0, 0x80], 7) {
        failures |= 1 << 7;
    }

    // case 8: int16 (-129, -32768)
    w.write_number(-129.0);
    w.write_number(-32768.0);
    if !check(&mut w, &[0xD1, 0xFF, 0x7F, 0xD1, 0x80, 0x00], 8) {
        failures |= 1 << 8;
    }

    // case 9: int32 (-32769, -2147483648)
    w.write_number(-32769.0);
    w.write_number(-2_147_483_648.0);
    if !check(
        &mut w,
        &[0xD2, 0xFF, 0xFF, 0x7F, 0xFF, 0xD2, 0x80, 0x00, 0x00, 0x00],
        9,
    ) {
        failures |= 1 << 9;
    }

    // case 10: float64 0.5 (non-integer)
    w.write_number(0.5);
    if !check(
        &mut w,
        &[0xCB, 0x3F, 0xE0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
        10,
    ) {
        failures |= 1 << 10;
    }

    // case 11: float64 NaN (non-finite)
    w.write_number(f64::NAN);
    let bytes = w.as_slice();
    // NaN: 0xCB + 8 bytes whose first byte has bit7 unset/set varies;
    // we just check the marker + length.
    let nan_ok = bytes.len() == 9 && bytes[0] == 0xCB;
    w.clear();
    if !nan_ok {
        failures |= 1 << 11;
    }

    // case 12: fixstr ""
    w.write_str("");
    if !check(&mut w, &[0xA0], 12) {
        failures |= 1 << 12;
    }

    // case 13: fixstr "hi"
    w.write_str("hi");
    if !check(&mut w, &[0xA2, b'h', b'i'], 13) {
        failures |= 1 << 13;
    }

    // case 14: str8 — 32-byte string
    let s32 = "abcdefghijklmnopqrstuvwxyz012345"; // 32 bytes
    w.write_str(s32);
    let bytes = w.as_slice();
    let str8_ok =
        bytes.len() == 34 && bytes[0] == 0xD9 && bytes[1] == 32 && &bytes[2..] == s32.as_bytes();
    w.clear();
    if !str8_ok {
        failures |= 1 << 14;
    }

    // case 15: fixarray with 3 entries
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_number(3.0);
    if !check(&mut w, &[0x93, 0x01, 0x02, 0x03], 15) {
        failures |= 1 << 15;
    }

    // case 16: array16 with 16 entries
    w.write_array_header(16);
    for _ in 0..16 {
        w.write_number(0.0);
    }
    let bytes = w.as_slice();
    let arr16_ok = bytes.len() == 19
        && bytes[0] == 0xDC
        && bytes[1] == 0
        && bytes[2] == 16
        && bytes[3..].iter().all(|&b| b == 0x00);
    w.clear();
    if !arr16_ok {
        failures |= 1 << 16;
    }

    // case 17: fixmap (k:v) "a" → 1
    w.write_map_header(1);
    w.write_str("a");
    w.write_number(1.0);
    if !check(&mut w, &[0x81, 0xA1, b'a', 0x01], 17) {
        failures |= 1 << 17;
    }

    // case 18: empty fixmap, empty fixarray
    w.write_map_header(0);
    w.write_array_header(0);
    if !check(&mut w, &[0x80, 0x90], 18) {
        failures |= 1 << 18;
    }

    // case 19: bin8 — 3 bytes
    w.write_bin(&[0x01, 0x02, 0x03]);
    if !check(&mut w, &[0xC4, 0x03, 0x01, 0x02, 0x03], 19) {
        failures |= 1 << 19;
    }

    // case 20: nested — map { "arr": [1, 2, "hi"] }
    w.write_map_header(1);
    w.write_str("arr");
    w.write_array_header(3);
    w.write_number(1.0);
    w.write_number(2.0);
    w.write_str("hi");
    if !check(
        &mut w,
        &[
            0x81, 0xA3, b'a', b'r', b'r', 0x93, 0x01, 0x02, 0xA2, b'h', b'i',
        ],
        20,
    ) {
        failures |= 1 << 20;
    }

    failures
}

// ─────────────────────────────────────────────────────────────────
//  Phase 10 D.1 — Entity-meta SoA pool
//
//  Per-entity scalar fields the snapshot serializer reads. Position,
//  velocity, orientation, etc. already live in BodyPool / projectile
//  pool / quat orientation views. This pool covers the *snapshot-
//  only* state: HP, ownership tag, combat mode, build progress,
//  suspension kinematics, factory/solar booleans, build target
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
    build_paid_metal: Vec<f32>,
    /// -1 sentinel for "no build target"; otherwise the target EntityId.
    build_target_id: Vec<i32>,
    suspension_spring_offset: Vec<f32>,
    suspension_spring_velocity: Vec<f32>,

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
            build_paid_metal: Vec::new(),
            build_target_id: Vec::new(),
            suspension_spring_offset: Vec::new(),
            suspension_spring_velocity: Vec::new(),
            factory_is_producing: Vec::new(),
            factory_build_queue_len: Vec::new(),
            factory_progress: Vec::new(),
            solar_open: Vec::new(),
            build_progress: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.entity_type.len() >= needed {
            return;
        }
        self.entity_type.resize(needed, ENTITY_META_TYPE_UNSET);
        self.player_id.resize(needed, 0);
        self.hp_curr.resize(needed, 0.0);
        self.hp_max.resize(needed, 0.0);
        self.combat_mode.resize(needed, 0);
        self.is_commander.resize(needed, 0);
        self.build_complete.resize(needed, 0);
        self.build_paid_energy.resize(needed, 0.0);
        self.build_paid_metal.resize(needed, 0.0);
        self.build_target_id.resize(needed, -1);
        self.suspension_spring_offset.resize(needed, 0.0);
        self.suspension_spring_velocity.resize(needed, 0.0);
        self.factory_is_producing.resize(needed, 0);
        self.factory_build_queue_len.resize(needed, 0);
        self.factory_progress.resize(needed, 0.0);
        self.solar_open.resize(needed, 0);
        self.build_progress.resize(needed, 0.0);
    }

    fn unset_slot(&mut self, slot: u32) {
        let s = slot as usize;
        if s >= self.entity_type.len() {
            return;
        }
        self.entity_type[s] = ENTITY_META_TYPE_UNSET;
        self.player_id[s] = 0;
        self.hp_curr[s] = 0.0;
        self.hp_max[s] = 0.0;
        self.combat_mode[s] = 0;
        self.is_commander[s] = 0;
        self.build_complete[s] = 0;
        self.build_paid_energy[s] = 0.0;
        self.build_paid_metal[s] = 0.0;
        self.build_target_id[s] = -1;
        self.suspension_spring_offset[s] = 0.0;
        self.suspension_spring_velocity[s] = 0.0;
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
    for k in pool.entity_type.iter_mut() {
        *k = ENTITY_META_TYPE_UNSET;
    }
}

#[wasm_bindgen]
pub fn entity_meta_clear() {
    let pool = entity_meta_pool();
    for k in pool.entity_type.iter_mut() {
        *k = ENTITY_META_TYPE_UNSET;
    }
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
    build_paid_metal: f32,
    build_target_id: i32,
    suspension_spring_offset: f32,
    suspension_spring_velocity: f32,
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
    pool.build_paid_metal[s] = build_paid_metal;
    pool.build_target_id[s] = build_target_id;
    pool.suspension_spring_offset[s] = suspension_spring_offset;
    pool.suspension_spring_velocity[s] = suspension_spring_velocity;
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
    if (slot as usize) >= pool.entity_type.len() {
        return ENTITY_META_TYPE_UNSET;
    }
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
entity_meta_ptr_export!(entity_meta_build_paid_metal_ptr, build_paid_metal, f32);
entity_meta_ptr_export!(entity_meta_build_target_id_ptr, build_target_id, i32);
entity_meta_ptr_export!(
    entity_meta_suspension_spring_offset_ptr,
    suspension_spring_offset,
    f32
);
entity_meta_ptr_export!(
    entity_meta_suspension_spring_velocity_ptr,
    suspension_spring_velocity,
    f32
);
entity_meta_ptr_export!(
    entity_meta_factory_is_producing_ptr,
    factory_is_producing,
    u8
);
entity_meta_ptr_export!(
    entity_meta_factory_build_queue_len_ptr,
    factory_build_queue_len,
    u8
);
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
        if s >= self.count_per_entity.len() {
            return;
        }
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
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
}

#[wasm_bindgen]
pub fn turret_pool_clear() {
    let pool = turret_pool();
    for c in pool.count_per_entity.iter_mut() {
        *c = 0;
    }
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
    let global_idx =
        (entity_slot as usize) * (TURRET_POOL_MAX_PER_ENTITY as usize) + (turret_idx as usize);
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
    if (entity_slot as usize) >= pool.count_per_entity.len() {
        return 0;
    }
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
turret_pool_ptr_export!(
    turret_pool_angular_acceleration_ptr,
    angular_acceleration,
    f32
);
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
// AIM-08.1 — Targeting input slabs
//
// Per-tick stamping from JS state of every input the upcoming
// targeting kernels (AIM-08.2..5) will read. The TS targeting FSM in
// targetingSystem.ts remains authoritative until AIM-08.5; the slabs
// are a non-authoritative shadow today. AIM-08.6 deletes the JS path
// and the slab becomes the source of truth.
//
// Layout:
//   - Entity slab (keyed by spatial-grid entity slot): hp, owner,
//     position, velocity, shot radius, flags.
//   - Turret slab (keyed by entity_slot * MAX_PER_ENTITY + turret_idx):
//     world mount kinematics, rotation/pitch, FSM state, target,
//     pre-squared range envelopes (fire max + min + tracking),
//     aim error, losBlockedTicks, packed config flags.
//   - Field slab (compact list of `count` active force fields): id,
//     owner entity id, center, radius. Rebuilt from scratch each tick.
// ─────────────────────────────────────────────────────────────────

pub const COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY: u32 = TURRET_POOL_MAX_PER_ENTITY;

// Entity-flag bits — packed into `entity_flags`.
pub const CT_ENTITY_FLAG_ALIVE: u8 = 1 << 0;
pub const CT_ENTITY_FLAG_HAS_COMBAT: u8 = 1 << 1;
pub const CT_ENTITY_FLAG_FIRE_ENABLED: u8 = 1 << 2;
pub const CT_ENTITY_FLAG_BUILDABLE_COMPLETE: u8 = 1 << 3;
pub const CT_ENTITY_FLAG_CLOAKED: u8 = 1 << 4;

// Turret-config-flag bits — packed into `turret_config_flags`.
pub const CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS: u8 = 1 << 0;
pub const CT_TURRET_CFG_NEEDS_BALLISTIC: u8 = 1 << 1;
pub const CT_TURRET_CFG_VERTICAL_LAUNCHER: u8 = 1 << 2;
pub const CT_TURRET_CFG_IS_MANUAL_FIRE: u8 = 1 << 3;
pub const CT_TURRET_CFG_PASSIVE: u8 = 1 << 4;
pub const CT_TURRET_CFG_VISUAL_ONLY: u8 = 1 << 5;
pub const CT_TURRET_CFG_SHOT_IS_FORCE: u8 = 1 << 6;
pub const CT_TURRET_CFG_HAS_TRACKING_RANGE: u8 = 1 << 7;

// FSM state encodings — match TurretState string order in TS.
pub const CT_TURRET_STATE_IDLE: u8 = 0;
pub const CT_TURRET_STATE_TRACKING: u8 = 1;
pub const CT_TURRET_STATE_ENGAGED: u8 = 2;

struct CombatTargetingPool {
    // Per-entity, indexed by spatial-grid slot.
    entity_id: Vec<i32>,
    entity_owner_player_id: Vec<u8>,
    entity_pos_x: Vec<f64>,
    entity_pos_y: Vec<f64>,
    entity_pos_z: Vec<f64>,
    entity_vel_x: Vec<f64>,
    entity_vel_y: Vec<f64>,
    entity_vel_z: Vec<f64>,
    entity_radius_shot: Vec<f64>,
    // AABB half-extents for AABB-shaped targets (buildings). Zero on
    // sphere-shaped targets (units / projectiles) so aim-point
    // resolution can clamp uniformly without branching on entity
    // shape: a zero half-extent collapses the clamp to the entity
    // center, matching the sphere behaviour.
    entity_aabb_half_x: Vec<f64>,
    entity_aabb_half_y: Vec<f64>,
    entity_aabb_half_z: Vec<f64>,
    entity_hp: Vec<f32>,
    entity_flags: Vec<u8>,
    // Per-entity detector radius. 0 = entity is not a detector. The
    // observability helper walks this array to find detector entities
    // owned by the viewer; storing the radius inline avoids a
    // per-player detector pool.
    entity_detector_radius: Vec<f32>,
    // Per-entity detection padding the cloak-observability walk adds
    // when this entity is the *target*. Matches the JS
    // `getEntityDetectionPadding` value (max body/shot/push radius for
    // units; max half-extent for buildings).
    entity_detection_padding: Vec<f32>,
    entity_slot_by_id: HashMap<i32, u32>,

    // Per-turret, indexed by entity_slot * MAX_PER_ENTITY + turret_idx.
    turret_count_per_entity: Vec<u8>,
    turret_mount_x: Vec<f64>,
    turret_mount_y: Vec<f64>,
    turret_mount_z: Vec<f64>,
    turret_mount_vx: Vec<f64>,
    turret_mount_vy: Vec<f64>,
    turret_mount_vz: Vec<f64>,
    turret_rotation: Vec<f32>,
    turret_pitch: Vec<f32>,
    turret_state: Vec<u8>,
    turret_target_id: Vec<i32>,
    // Pre-squared range envelopes. Sentinels: fire_min_*_sq <= 0 means
    // "no min preference"; tracking_*_sq <= 0 and the
    // HAS_TRACKING_RANGE flag together encode "no separate tracking
    // shell — fire.max is the outermost release boundary".
    turret_fire_max_acquire_sq: Vec<f64>,
    turret_fire_max_release_sq: Vec<f64>,
    turret_fire_min_acquire_sq: Vec<f64>,
    turret_fire_min_release_sq: Vec<f64>,
    turret_tracking_acquire_sq: Vec<f64>,
    turret_tracking_release_sq: Vec<f64>,
    // Raw acquire distance for the outermost shell (tracking when
    // present, fire.max otherwise) — used by the broadphase spatial
    // query, which wants the un-squared radius.
    turret_outermost_acquire: Vec<f64>,
    // Raw 2D local-mount distance from the host entity origin. Used by
    // the auto-targeting pre-scan to widen one unit-centered
    // broadphase query enough to cover every turret-centered range.
    turret_mount_offset_2d: Vec<f64>,
    // Per-turret sustained DPS. Static per shot blueprint
    // (cooldown + shot damage / dps). Zero for visualOnly /
    // force-shot / missing-shot turrets. Used by the Rust passive-
    // mirror target check to walk a target's turrets and score them.
    turret_dps: Vec<f32>,
    turret_aim_error_yaw: Vec<f32>,
    turret_aim_error_pitch: Vec<f32>,
    turret_los_blocked_ticks: Vec<u16>,
    turret_config_flags: Vec<u8>,
    // AIM-08.4 ballistic solver outputs. Written by the Rust solver
    // using turret mount data from the slab; JS reads these outputs
    // for transitional targeting gates and turret pose until AIM-08.5
    // consumes them directly inside the FSM kernel.
    turret_ballistic_has_solution: Vec<u8>,
    turret_ballistic_flight_time: Vec<f64>,
    turret_ballistic_launch_vx: Vec<f64>,
    turret_ballistic_launch_vy: Vec<f64>,
    turret_ballistic_launch_vz: Vec<f64>,
    turret_ballistic_yaw: Vec<f32>,
    turret_ballistic_pitch: Vec<f32>,
    turret_ballistic_aim_x: Vec<f64>,
    turret_ballistic_aim_y: Vec<f64>,
    turret_ballistic_aim_z: Vec<f64>,
}

impl CombatTargetingPool {
    fn empty() -> Self {
        Self {
            entity_id: Vec::new(),
            entity_owner_player_id: Vec::new(),
            entity_pos_x: Vec::new(),
            entity_pos_y: Vec::new(),
            entity_pos_z: Vec::new(),
            entity_vel_x: Vec::new(),
            entity_vel_y: Vec::new(),
            entity_vel_z: Vec::new(),
            entity_radius_shot: Vec::new(),
            entity_aabb_half_x: Vec::new(),
            entity_aabb_half_y: Vec::new(),
            entity_aabb_half_z: Vec::new(),
            entity_hp: Vec::new(),
            entity_flags: Vec::new(),
            entity_detector_radius: Vec::new(),
            entity_detection_padding: Vec::new(),
            entity_slot_by_id: HashMap::new(),
            turret_count_per_entity: Vec::new(),
            turret_mount_x: Vec::new(),
            turret_mount_y: Vec::new(),
            turret_mount_z: Vec::new(),
            turret_mount_vx: Vec::new(),
            turret_mount_vy: Vec::new(),
            turret_mount_vz: Vec::new(),
            turret_rotation: Vec::new(),
            turret_pitch: Vec::new(),
            turret_state: Vec::new(),
            turret_target_id: Vec::new(),
            turret_fire_max_acquire_sq: Vec::new(),
            turret_fire_max_release_sq: Vec::new(),
            turret_fire_min_acquire_sq: Vec::new(),
            turret_fire_min_release_sq: Vec::new(),
            turret_tracking_acquire_sq: Vec::new(),
            turret_tracking_release_sq: Vec::new(),
            turret_outermost_acquire: Vec::new(),
            turret_mount_offset_2d: Vec::new(),
            turret_dps: Vec::new(),
            turret_aim_error_yaw: Vec::new(),
            turret_aim_error_pitch: Vec::new(),
            turret_los_blocked_ticks: Vec::new(),
            turret_config_flags: Vec::new(),
            turret_ballistic_has_solution: Vec::new(),
            turret_ballistic_flight_time: Vec::new(),
            turret_ballistic_launch_vx: Vec::new(),
            turret_ballistic_launch_vy: Vec::new(),
            turret_ballistic_launch_vz: Vec::new(),
            turret_ballistic_yaw: Vec::new(),
            turret_ballistic_pitch: Vec::new(),
            turret_ballistic_aim_x: Vec::new(),
            turret_ballistic_aim_y: Vec::new(),
            turret_ballistic_aim_z: Vec::new(),
        }
    }

    fn ensure_entity_capacity(&mut self, entity_slot: u32) {
        let entity_needed = (entity_slot as usize) + 1;
        if self.entity_id.len() < entity_needed {
            self.entity_id.resize(entity_needed, -1);
            self.entity_owner_player_id.resize(entity_needed, 0);
            self.entity_pos_x.resize(entity_needed, 0.0);
            self.entity_pos_y.resize(entity_needed, 0.0);
            self.entity_pos_z.resize(entity_needed, 0.0);
            self.entity_vel_x.resize(entity_needed, 0.0);
            self.entity_vel_y.resize(entity_needed, 0.0);
            self.entity_vel_z.resize(entity_needed, 0.0);
            self.entity_radius_shot.resize(entity_needed, 0.0);
            self.entity_aabb_half_x.resize(entity_needed, 0.0);
            self.entity_aabb_half_y.resize(entity_needed, 0.0);
            self.entity_aabb_half_z.resize(entity_needed, 0.0);
            self.entity_hp.resize(entity_needed, 0.0);
            self.entity_flags.resize(entity_needed, 0);
            self.entity_detector_radius.resize(entity_needed, 0.0);
            self.entity_detection_padding.resize(entity_needed, 0.0);
            self.turret_count_per_entity.resize(entity_needed, 0);
        }
        let turret_needed = entity_needed * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
        if self.turret_mount_x.len() < turret_needed {
            self.turret_mount_x.resize(turret_needed, 0.0);
            self.turret_mount_y.resize(turret_needed, 0.0);
            self.turret_mount_z.resize(turret_needed, 0.0);
            self.turret_mount_vx.resize(turret_needed, 0.0);
            self.turret_mount_vy.resize(turret_needed, 0.0);
            self.turret_mount_vz.resize(turret_needed, 0.0);
            self.turret_rotation.resize(turret_needed, 0.0);
            self.turret_pitch.resize(turret_needed, 0.0);
            self.turret_state
                .resize(turret_needed, CT_TURRET_STATE_IDLE);
            self.turret_target_id.resize(turret_needed, -1);
            self.turret_fire_max_acquire_sq.resize(turret_needed, 0.0);
            self.turret_fire_max_release_sq.resize(turret_needed, 0.0);
            self.turret_fire_min_acquire_sq.resize(turret_needed, 0.0);
            self.turret_fire_min_release_sq.resize(turret_needed, 0.0);
            self.turret_tracking_acquire_sq.resize(turret_needed, 0.0);
            self.turret_tracking_release_sq.resize(turret_needed, 0.0);
            self.turret_outermost_acquire.resize(turret_needed, 0.0);
            self.turret_mount_offset_2d.resize(turret_needed, 0.0);
            self.turret_dps.resize(turret_needed, 0.0);
            self.turret_aim_error_yaw.resize(turret_needed, 0.0);
            self.turret_aim_error_pitch.resize(turret_needed, 0.0);
            self.turret_los_blocked_ticks.resize(turret_needed, 0);
            self.turret_config_flags.resize(turret_needed, 0);
            self.turret_ballistic_has_solution.resize(turret_needed, 0);
            self.turret_ballistic_flight_time.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vx.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vy.resize(turret_needed, 0.0);
            self.turret_ballistic_launch_vz.resize(turret_needed, 0.0);
            self.turret_ballistic_yaw.resize(turret_needed, 0.0);
            self.turret_ballistic_pitch.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_x.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_y.resize(turret_needed, 0.0);
            self.turret_ballistic_aim_z.resize(turret_needed, 0.0);
        }
    }

    fn clear_all(&mut self) {
        for f in self.entity_flags.iter_mut() {
            *f = 0;
        }
        for c in self.turret_count_per_entity.iter_mut() {
            *c = 0;
        }
        self.entity_slot_by_id.clear();
        for has_solution in self.turret_ballistic_has_solution.iter_mut() {
            *has_solution = 0;
        }
    }

    fn unset_entity(&mut self, entity_slot: u32) {
        let s = entity_slot as usize;
        if s >= self.entity_flags.len() {
            return;
        }
        let old_entity_id = self.entity_id[s];
        if old_entity_id >= 0 {
            self.entity_slot_by_id.remove(&old_entity_id);
        }
        self.entity_flags[s] = 0;
        self.turret_count_per_entity[s] = 0;
    }
}

#[inline]
fn combat_targeting_turret_global_idx(entity_slot: u32, turret_idx: u32) -> usize {
    (entity_slot as usize) * (COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        + (turret_idx as usize)
}

#[inline]
fn combat_targeting_write_no_ballistic_solution(
    pool: &mut CombatTargetingPool,
    idx: usize,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) {
    let yaw = if fallback_yaw.is_finite() {
        fallback_yaw
    } else {
        0.0
    };
    let pitch = if fallback_pitch.is_finite() {
        fallback_pitch
    } else {
        0.0
    };
    let cos_pitch = pitch.cos();
    pool.turret_ballistic_has_solution[idx] = 0;
    pool.turret_ballistic_flight_time[idx] = 0.0;
    pool.turret_ballistic_launch_vx[idx] = 0.0;
    pool.turret_ballistic_launch_vy[idx] = 0.0;
    pool.turret_ballistic_launch_vz[idx] = 0.0;
    pool.turret_ballistic_yaw[idx] = yaw as f32;
    pool.turret_ballistic_pitch[idx] = pitch as f32;
    pool.turret_ballistic_aim_x[idx] = mount_x + yaw.cos() * cos_pitch;
    pool.turret_ballistic_aim_y[idx] = mount_y + yaw.sin() * cos_pitch;
    pool.turret_ballistic_aim_z[idx] = mount_z + pitch.sin();
}

struct CombatTargetingPoolHolder(UnsafeCell<Option<CombatTargetingPool>>);
unsafe impl Sync for CombatTargetingPoolHolder {}
static COMBAT_TARGETING: CombatTargetingPoolHolder =
    CombatTargetingPoolHolder(UnsafeCell::new(None));

#[inline]
fn combat_targeting_pool() -> &'static mut CombatTargetingPool {
    unsafe {
        let cell = &mut *COMBAT_TARGETING.0.get();
        if cell.is_none() {
            *cell = Some(CombatTargetingPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

// AIM-08.5 — per-candidate observability scratch buffer used by the
// candidate-batch kernel. Lives outside the pool so the kernel can
// borrow the pool mutably for ballistic-solver writes while reading
// the observability mask as a separate slice. Resized in-place per
// call; never freed.
struct CombatTargetingScratchHolder(UnsafeCell<Vec<u8>>);
unsafe impl Sync for CombatTargetingScratchHolder {}
static COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH: CombatTargetingScratchHolder =
    CombatTargetingScratchHolder(UnsafeCell::new(Vec::new()));

#[inline]
fn combat_targeting_candidate_observable_scratch() -> &'static mut Vec<u8> {
    unsafe { &mut *COMBAT_TARGETING_CANDIDATE_OBSERVABLE_SCRATCH.0.get() }
}

#[wasm_bindgen]
pub fn combat_targeting_init(initial_entity_capacity: u32) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(initial_entity_capacity);
    pool.clear_all();
}

#[wasm_bindgen]
pub fn combat_targeting_clear() {
    combat_targeting_pool().clear_all();
}

#[wasm_bindgen]
pub fn combat_targeting_max_turrets_per_entity() -> u32 {
    COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY
}

#[wasm_bindgen]
pub fn combat_targeting_entity_capacity() -> u32 {
    combat_targeting_pool().entity_id.len() as u32
}

/// Bulk per-entity stamp. Called once per armed entity per tick by the
/// JS stamping pass. `flags` is the OR'd `CT_ENTITY_FLAG_*` bits.
/// `turret_count` advertises how many `combat_targeting_set_turret`
/// calls will follow for this slot — past the count, slots hold stale
/// data and the kernel gates on `turret_count_per_entity`.
#[wasm_bindgen]
pub fn combat_targeting_set_entity(
    entity_slot: u32,
    entity_id: i32,
    owner_player_id: u8,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    radius_shot: f64,
    aabb_half_x: f64,
    aabb_half_y: f64,
    aabb_half_z: f64,
    hp: f32,
    flags: u8,
    detector_radius: f32,
    detection_padding: f32,
    turret_count: u8,
) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(entity_slot);
    let s = entity_slot as usize;
    let old_entity_id = pool.entity_id[s];
    if old_entity_id >= 0 && old_entity_id != entity_id {
        pool.entity_slot_by_id.remove(&old_entity_id);
    }
    pool.entity_id[s] = entity_id;
    if entity_id >= 0 {
        pool.entity_slot_by_id.insert(entity_id, entity_slot);
    }
    pool.entity_owner_player_id[s] = owner_player_id;
    pool.entity_pos_x[s] = pos_x;
    pool.entity_pos_y[s] = pos_y;
    pool.entity_pos_z[s] = pos_z;
    pool.entity_vel_x[s] = vel_x;
    pool.entity_vel_y[s] = vel_y;
    pool.entity_vel_z[s] = vel_z;
    pool.entity_radius_shot[s] = radius_shot;
    pool.entity_aabb_half_x[s] = aabb_half_x;
    pool.entity_aabb_half_y[s] = aabb_half_y;
    pool.entity_aabb_half_z[s] = aabb_half_z;
    pool.entity_hp[s] = hp;
    pool.entity_flags[s] = flags;
    pool.entity_detector_radius[s] = detector_radius;
    pool.entity_detection_padding[s] = detection_padding;
    let max = COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as u8;
    pool.turret_count_per_entity[s] = if turret_count > max {
        max
    } else {
        turret_count
    };
}

#[wasm_bindgen]
pub fn combat_targeting_unset_entity(entity_slot: u32) {
    combat_targeting_pool().unset_entity(entity_slot);
}

/// Bulk per-turret stamp. The range arguments are pre-squared so the
/// kernel can compare against distSq without re-multiplying.
/// `outermost_acquire` is the raw (un-squared) outermost-shell acquire
/// distance — the broadphase spatial query wants a radius, not a
/// squared radius, so storing it lets the kernel avoid sqrt.
/// `mount_offset_2d` is the raw local XY distance from host origin to
/// turret mount, matching the TypeScript pre-scan's `hypot(mount.x,
/// mount.y)` broadphase padding.
#[wasm_bindgen]
pub fn combat_targeting_set_turret(
    entity_slot: u32,
    turret_idx: u32,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
    mount_vx: f64,
    mount_vy: f64,
    mount_vz: f64,
    rotation: f32,
    pitch: f32,
    state: u8,
    target_id: i32,
    fire_max_acquire_sq: f64,
    fire_max_release_sq: f64,
    fire_min_acquire_sq: f64,
    fire_min_release_sq: f64,
    tracking_acquire_sq: f64,
    tracking_release_sq: f64,
    outermost_acquire: f64,
    mount_offset_2d: f64,
    aim_error_yaw: f32,
    aim_error_pitch: f32,
    los_blocked_ticks: u16,
    config_flags: u8,
    dps: f32,
) {
    let pool = combat_targeting_pool();
    pool.ensure_entity_capacity(entity_slot);
    debug_assert!(turret_idx < COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY);
    let global_idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    pool.turret_mount_x[global_idx] = mount_x;
    pool.turret_mount_y[global_idx] = mount_y;
    pool.turret_mount_z[global_idx] = mount_z;
    pool.turret_mount_vx[global_idx] = mount_vx;
    pool.turret_mount_vy[global_idx] = mount_vy;
    pool.turret_mount_vz[global_idx] = mount_vz;
    pool.turret_rotation[global_idx] = rotation;
    pool.turret_pitch[global_idx] = pitch;
    pool.turret_state[global_idx] = state;
    pool.turret_target_id[global_idx] = target_id;
    pool.turret_fire_max_acquire_sq[global_idx] = fire_max_acquire_sq;
    pool.turret_fire_max_release_sq[global_idx] = fire_max_release_sq;
    pool.turret_fire_min_acquire_sq[global_idx] = fire_min_acquire_sq;
    pool.turret_fire_min_release_sq[global_idx] = fire_min_release_sq;
    pool.turret_tracking_acquire_sq[global_idx] = tracking_acquire_sq;
    pool.turret_tracking_release_sq[global_idx] = tracking_release_sq;
    pool.turret_outermost_acquire[global_idx] = outermost_acquire;
    pool.turret_mount_offset_2d[global_idx] = mount_offset_2d;
    pool.turret_aim_error_yaw[global_idx] = aim_error_yaw;
    pool.turret_aim_error_pitch[global_idx] = aim_error_pitch;
    pool.turret_los_blocked_ticks[global_idx] = los_blocked_ticks;
    pool.turret_config_flags[global_idx] = config_flags;
    pool.turret_dps[global_idx] = dps;
    combat_targeting_write_no_ballistic_solution(
        pool,
        global_idx,
        mount_x,
        mount_y,
        mount_z,
        rotation as f64,
        pitch as f64,
    );
}

#[wasm_bindgen]
pub fn combat_targeting_entity_flags(entity_slot: u32) -> u8 {
    let pool = combat_targeting_pool();
    let s = entity_slot as usize;
    if s >= pool.entity_flags.len() {
        return 0;
    }
    pool.entity_flags[s]
}

#[wasm_bindgen]
pub fn combat_targeting_turret_count(entity_slot: u32) -> u8 {
    let pool = combat_targeting_pool();
    let s = entity_slot as usize;
    if s >= pool.turret_count_per_entity.len() {
        return 0;
    }
    pool.turret_count_per_entity[s]
}

/// AIM-08.5 — JS-callable wrapper around the internal observability
/// helper. Returns 1 when `viewer_player_id` can observe the entity
/// addressed by `target_id` (alive + (uncloaked OR own-team OR
/// reached by a viewer-owned detector)), 0 otherwise. Used by the
/// priority-target path to fall through to auto-targeting when the
/// command target is dead, lost, or stealthed beyond detection.
#[wasm_bindgen]
pub fn combat_targeting_can_player_observe_entity(
    target_id: i32,
    viewer_player_id: u8,
) -> u8 {
    let pool = combat_targeting_pool();
    if combat_targeting_player_observes_entity_id(pool, target_id, viewer_player_id) {
        1
    } else {
        0
    }
}

macro_rules! combat_targeting_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            combat_targeting_pool().$field.as_ptr()
        }
    };
}

combat_targeting_ptr_export!(combat_targeting_entity_id_ptr, entity_id, i32);
combat_targeting_ptr_export!(
    combat_targeting_entity_owner_player_id_ptr,
    entity_owner_player_id,
    u8
);
combat_targeting_ptr_export!(combat_targeting_entity_pos_x_ptr, entity_pos_x, f64);
combat_targeting_ptr_export!(combat_targeting_entity_pos_y_ptr, entity_pos_y, f64);
combat_targeting_ptr_export!(combat_targeting_entity_pos_z_ptr, entity_pos_z, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_x_ptr, entity_vel_x, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_y_ptr, entity_vel_y, f64);
combat_targeting_ptr_export!(combat_targeting_entity_vel_z_ptr, entity_vel_z, f64);
combat_targeting_ptr_export!(
    combat_targeting_entity_radius_shot_ptr,
    entity_radius_shot,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_x_ptr,
    entity_aabb_half_x,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_y_ptr,
    entity_aabb_half_y,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_entity_aabb_half_z_ptr,
    entity_aabb_half_z,
    f64
);
combat_targeting_ptr_export!(combat_targeting_entity_hp_ptr, entity_hp, f32);
combat_targeting_ptr_export!(combat_targeting_entity_flags_ptr, entity_flags, u8);
combat_targeting_ptr_export!(
    combat_targeting_turret_count_per_entity_ptr,
    turret_count_per_entity,
    u8
);
combat_targeting_ptr_export!(combat_targeting_turret_mount_x_ptr, turret_mount_x, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_y_ptr, turret_mount_y, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_z_ptr, turret_mount_z, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vx_ptr, turret_mount_vx, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vy_ptr, turret_mount_vy, f64);
combat_targeting_ptr_export!(combat_targeting_turret_mount_vz_ptr, turret_mount_vz, f64);
combat_targeting_ptr_export!(combat_targeting_turret_rotation_ptr, turret_rotation, f32);
combat_targeting_ptr_export!(combat_targeting_turret_pitch_ptr, turret_pitch, f32);
combat_targeting_ptr_export!(combat_targeting_turret_state_ptr, turret_state, u8);
combat_targeting_ptr_export!(combat_targeting_turret_target_id_ptr, turret_target_id, i32);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_max_acquire_sq_ptr,
    turret_fire_max_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_max_release_sq_ptr,
    turret_fire_max_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_min_acquire_sq_ptr,
    turret_fire_min_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_fire_min_release_sq_ptr,
    turret_fire_min_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_tracking_acquire_sq_ptr,
    turret_tracking_acquire_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_tracking_release_sq_ptr,
    turret_tracking_release_sq,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_outermost_acquire_ptr,
    turret_outermost_acquire,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_aim_error_yaw_ptr,
    turret_aim_error_yaw,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_aim_error_pitch_ptr,
    turret_aim_error_pitch,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_los_blocked_ticks_ptr,
    turret_los_blocked_ticks,
    u16
);
combat_targeting_ptr_export!(
    combat_targeting_turret_config_flags_ptr,
    turret_config_flags,
    u8
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_has_solution_ptr,
    turret_ballistic_has_solution,
    u8
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_flight_time_ptr,
    turret_ballistic_flight_time,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vx_ptr,
    turret_ballistic_launch_vx,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vy_ptr,
    turret_ballistic_launch_vy,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_launch_vz_ptr,
    turret_ballistic_launch_vz,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_yaw_ptr,
    turret_ballistic_yaw,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_pitch_ptr,
    turret_ballistic_pitch,
    f32
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_x_ptr,
    turret_ballistic_aim_x,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_y_ptr,
    turret_ballistic_aim_y,
    f64
);
combat_targeting_ptr_export!(
    combat_targeting_turret_ballistic_aim_z_ptr,
    turret_ballistic_aim_z,
    f64
);

// ─────────────────────────────────────────────────────────────────
// AIM-08.4 — Ballistic turret aim kernel.
//
// JS still resolves object-owned gameplay inputs (target aim point,
// target velocity/acceleration, origin acceleration, shot config), but
// the hot intercept and arc solve now reads the turret mount kinematic
// slab and writes reusable ballistic outputs beside that turret slot.
// The transitional JS bridge copies these outputs into its existing
// TurretAimSolution scratch; AIM-08.5 can read the same fields directly
// when the full targeting FSM moves into Rust.
// ─────────────────────────────────────────────────────────────────

const CT_BALLISTIC_ARC_HIGH: u8 = 1;
const CT_HIGH_ARC_MIN_TIME_SEPARATION: f64 = 1.0 / 120.0;
const CT_SHOT_DIRECTION_EPSILON: f64 = 1e-6;

#[inline]
fn combat_targeting_ballistic_params_finite(values: &[f64]) -> bool {
    for v in values.iter() {
        if !v.is_finite() {
            return false;
        }
    }
    true
}

#[wasm_bindgen]
pub fn combat_targeting_solve_ballistic_aim(
    entity_slot: u32,
    turret_idx: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    target_vx: f64,
    target_vy: f64,
    target_vz: f64,
    target_ax: f64,
    target_ay: f64,
    target_az: f64,
    origin_ax: f64,
    origin_ay: f64,
    origin_az: f64,
    projectile_speed: f64,
    gravity: f64,
    arc_preference: u8,
    max_time_sec_or_zero: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) -> u32 {
    let pool = combat_targeting_pool();
    combat_targeting_solve_ballistic_aim_inner(
        pool,
        entity_slot,
        turret_idx,
        target_x, target_y, target_z,
        target_vx, target_vy, target_vz,
        target_ax, target_ay, target_az,
        origin_ax, origin_ay, origin_az,
        projectile_speed,
        gravity,
        arc_preference,
        max_time_sec_or_zero,
        fallback_yaw,
        fallback_pitch,
    )
}

/// Inner helper for the ballistic solver. Takes the slab by &mut so
/// the kernel can be called from other batched paths that already hold
/// the pool reference (e.g. the unified priority-point gate+FSM batch).
/// All slab reads/writes live here; the wasm-bindgen entry above is a
/// thin wrapper that acquires the pool then defers to this.
fn combat_targeting_solve_ballistic_aim_inner(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    target_vx: f64,
    target_vy: f64,
    target_vz: f64,
    target_ax: f64,
    target_ay: f64,
    target_az: f64,
    origin_ax: f64,
    origin_ay: f64,
    origin_az: f64,
    projectile_speed: f64,
    gravity: f64,
    arc_preference: u8,
    max_time_sec_or_zero: f64,
    fallback_yaw: f64,
    fallback_pitch: f64,
) -> u32 {
    if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return 0;
    }
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.entity_id.len() {
        return 0;
    }

    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let mount_x = pool.turret_mount_x[idx];
    let mount_y = pool.turret_mount_y[idx];
    let mount_z = pool.turret_mount_z[idx];
    let mount_vx = pool.turret_mount_vx[idx];
    let mount_vy = pool.turret_mount_vy[idx];
    let mount_vz = pool.turret_mount_vz[idx];
    if turret_idx >= pool.turret_count_per_entity[entity_idx] as u32 {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let finite_values = [
        mount_x,
        mount_y,
        mount_z,
        mount_vx,
        mount_vy,
        mount_vz,
        target_x,
        target_y,
        target_z,
        target_vx,
        target_vy,
        target_vz,
        target_ax,
        target_ay,
        target_az,
        origin_ax,
        origin_ay,
        origin_az,
        projectile_speed,
        gravity,
        max_time_sec_or_zero,
        fallback_yaw,
        fallback_pitch,
    ];
    if !combat_targeting_ballistic_params_finite(&finite_values)
        || projectile_speed <= 1e-6
        || gravity < 0.0
        || max_time_sec_or_zero < 0.0
    {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let input = [
        mount_x,
        mount_y,
        mount_z,
        mount_vx,
        mount_vy,
        mount_vz,
        origin_ax,
        origin_ay,
        origin_az,
        target_x,
        target_y,
        target_z,
        target_vx,
        target_vy,
        target_vz,
        target_ax,
        target_ay,
        target_az,
        0.0,
        0.0,
        -gravity,
        projectile_speed,
    ];
    let mut solution = [0.0_f64; 7];
    let found = if arc_preference == CT_BALLISTIC_ARC_HIGH {
        let mut low_solution = [0.0_f64; 7];
        let low_found =
            solve_kinematic_intercept_inline(&input, &mut low_solution, 0, max_time_sec_or_zero);
        let high_found =
            solve_kinematic_intercept_inline(&input, &mut solution, 1, max_time_sec_or_zero);
        high_found && low_found && solution[0] > low_solution[0] + CT_HIGH_ARC_MIN_TIME_SEPARATION
    } else {
        solve_kinematic_intercept_inline(&input, &mut solution, 0, max_time_sec_or_zero)
    };

    if !found {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let launch_vx = solution[4];
    let launch_vy = solution[5];
    let launch_vz = solution[6];
    let horizontal = (launch_vx * launch_vx + launch_vy * launch_vy).sqrt();
    let speed = (horizontal * horizontal + launch_vz * launch_vz).sqrt();
    if !speed.is_finite() || speed <= CT_SHOT_DIRECTION_EPSILON {
        combat_targeting_write_no_ballistic_solution(
            pool,
            idx,
            mount_x,
            mount_y,
            mount_z,
            fallback_yaw,
            fallback_pitch,
        );
        return 0;
    }

    let yaw = if horizontal > CT_SHOT_DIRECTION_EPSILON {
        launch_vy.atan2(launch_vx)
    } else {
        (solution[2] - mount_y).atan2(solution[1] - mount_x)
    };
    let pitch = launch_vz.atan2(horizontal);
    let dir_x = launch_vx / speed;
    let dir_y = launch_vy / speed;
    let dir_z = launch_vz / speed;
    let aim_dx = solution[1] - mount_x;
    let aim_dy = solution[2] - mount_y;
    let aim_dz = solution[3] - mount_z;
    let distance_to_intercept = (aim_dx * aim_dx + aim_dy * aim_dy + aim_dz * aim_dz)
        .sqrt()
        .max(1.0);

    pool.turret_ballistic_has_solution[idx] = 1;
    pool.turret_ballistic_flight_time[idx] = solution[0];
    pool.turret_ballistic_launch_vx[idx] = launch_vx;
    pool.turret_ballistic_launch_vy[idx] = launch_vy;
    pool.turret_ballistic_launch_vz[idx] = launch_vz;
    pool.turret_ballistic_yaw[idx] = yaw as f32;
    pool.turret_ballistic_pitch[idx] = pitch as f32;
    pool.turret_ballistic_aim_x[idx] = mount_x + dir_x * distance_to_intercept;
    pool.turret_ballistic_aim_y[idx] = mount_y + dir_y * distance_to_intercept;
    pool.turret_ballistic_aim_z[idx] = mount_z + dir_z * distance_to_intercept;
    1
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.3 — Target candidate scoring + ranking kernel.
//
// TypeScript still owns candidate stamping and the expensive fire
// gates that have not migrated yet (LOS/force-field/ballistic), but
// the cheap per-candidate score, target preference ranks, mirror
// ordering, top-K bubble sort, and fallback budget now run in Rust.
// The JS side calls this once per turret candidate slice and receives
// the chosen local candidate index plus its rank/dist/mirror tuple.
// ─────────────────────────────────────────────────────────────────

const CT_TARGET_RANK_NONE: u8 = 0;
const CT_TARGET_RANK_TRACKING_ONLY: u8 = 1;
const CT_TARGET_RANK_FIRE_FALLBACK: u8 = 2;
const CT_TARGET_RANK_FIRE_PREFERRED: u8 = 3;

const CT_TARGET_RANK_MODE_ACQUISITION: u8 = 1;

const CT_TARGET_EDGE_RELEASE: u8 = 1;

const TARGETING_TOPK_LOS: usize = 4;
const TARGETING_FALLBACK_LOS_BUDGET: u32 = 12;
const CT_TARGETING_PREP_HAS_APPLY: u8 = 1;
const CT_TARGETING_PREP_HAS_PASSIVE_APPLY: u8 = 1 << 1;

#[inline]
fn combat_targeting_live_turret_idx(
    pool: &CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
) -> Option<usize> {
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return None;
    }
    if turret_idx >= pool.turret_count_per_entity[entity_idx] as u32 {
        return None;
    }
    if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
        return None;
    }
    Some(combat_targeting_turret_global_idx(entity_slot, turret_idx))
}

#[inline]
fn combat_targeting_set_target_state(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target_id: i32,
    state: u8,
) {
    if pool.turret_target_id[idx] != target_id {
        pool.turret_los_blocked_ticks[idx] = 0;
    }
    pool.turret_target_id[idx] = target_id;
    pool.turret_state[idx] = state;
}

#[inline]
fn combat_targeting_entity_alive(pool: &CombatTargetingPool, entity_slot: usize) -> bool {
    entity_slot < pool.entity_flags.len()
        && (pool.entity_flags[entity_slot] & CT_ENTITY_FLAG_ALIVE) != 0
}

/// AIM-08.5 — Rust port of `canPlayerObserveCloakedEntity` /
/// `isEntityDetectedByPlayer`. Returns true when `viewer_player_id`
/// can see `target_slot`:
///   - not cloaked → always observable
///   - cloaked, owned by viewer → observable (own team)
///   - cloaked, enemy → walks every detector entity owned by the
///     viewer (radius > 0, alive, buildable-complete) and returns
///     true if any detector reaches the target's center + padding
///
/// The detector walk is O(N) over the slab but only triggers for
/// cloaked enemy targets — the common case (uncloaked) short-circuits.
fn combat_targeting_player_observes_entity(
    pool: &CombatTargetingPool,
    target_slot: usize,
    viewer_player_id: u8,
) -> bool {
    if target_slot >= pool.entity_flags.len() {
        return false;
    }
    let target_flags = pool.entity_flags[target_slot];
    if (target_flags & CT_ENTITY_FLAG_ALIVE) == 0 {
        return false;
    }
    if (target_flags & CT_ENTITY_FLAG_CLOAKED) == 0 {
        return true;
    }
    if pool.entity_owner_player_id[target_slot] == viewer_player_id {
        return true;
    }
    let tx = pool.entity_pos_x[target_slot];
    let ty = pool.entity_pos_y[target_slot];
    let padding = pool.entity_detection_padding[target_slot] as f64;

    let n = pool.entity_flags.len();
    for i in 0..n {
        let f = pool.entity_flags[i];
        // Online-for-sensors gate mirrors JS isEntityOnlineForSensors:
        // alive AND buildable-complete (incomplete shells don't sense).
        if (f & CT_ENTITY_FLAG_ALIVE) == 0 {
            continue;
        }
        if (f & CT_ENTITY_FLAG_BUILDABLE_COMPLETE) == 0 {
            continue;
        }
        if pool.entity_owner_player_id[i] != viewer_player_id {
            continue;
        }
        let radius = pool.entity_detector_radius[i] as f64;
        if radius <= 0.0 {
            continue;
        }
        let dx = tx - pool.entity_pos_x[i];
        let dy = ty - pool.entity_pos_y[i];
        let r = radius + padding;
        if dx * dx + dy * dy <= r * r {
            return true;
        }
    }
    false
}

#[inline]
fn combat_targeting_player_observes_entity_id(
    pool: &CombatTargetingPool,
    target_id: i32,
    viewer_player_id: u8,
) -> bool {
    match combat_targeting_entity_slot_for_id(pool, target_id) {
        Some(slot) => combat_targeting_player_observes_entity(pool, slot, viewer_player_id),
        None => false,
    }
}

/// AIM-08.5 — Rust port of `pickMirrorTargetTurret` /
/// `scoreMirrorTargetTurret` from `mirrorTargetPriority.ts`. Walks the
/// target entity's turrets in the slab and returns the maximum
/// sustained DPS of any non-passive, non-visual, non-manual turret
/// currently locked onto `our_entity_id` in a non-idle state. Returns
/// 0 when no qualifying turret exists — matches the JS scorer's "any
/// qualifying mirror target scores at its DPS; otherwise 0" rule.
#[inline]
fn combat_targeting_mirror_target_score_for_slot(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    our_entity_id: i32,
) -> f64 {
    if target_entity_slot >= pool.turret_count_per_entity.len() {
        return 0.0;
    }
    let count = (pool.turret_count_per_entity[target_entity_slot] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize);
    let exclude_flags = CT_TURRET_CFG_PASSIVE
        | CT_TURRET_CFG_VISUAL_ONLY
        | CT_TURRET_CFG_IS_MANUAL_FIRE;
    let mut best: f32 = 0.0;
    for ti in 0..count {
        let idx = combat_targeting_turret_global_idx(target_entity_slot as u32, ti as u32);
        let flags = pool.turret_config_flags[idx];
        if (flags & exclude_flags) != 0 {
            continue;
        }
        if pool.turret_target_id[idx] != our_entity_id {
            continue;
        }
        if pool.turret_state[idx] == CT_TURRET_STATE_IDLE {
            continue;
        }
        let dps = pool.turret_dps[idx];
        if dps > best {
            best = dps;
        }
    }
    best as f64
}

/// AIM-08.5 — boolean wrapper over `mirror_target_score_for_slot`.
/// Matches `isMirrorTarget` in `mirrorTargetPriority.ts`: true iff the
/// target carries a damaging turret currently locked onto us.
#[inline]
fn combat_targeting_is_mirror_target_for_slot(
    pool: &CombatTargetingPool,
    target_entity_slot: usize,
    our_entity_id: i32,
) -> bool {
    combat_targeting_mirror_target_score_for_slot(pool, target_entity_slot, our_entity_id) > 0.0
}

#[inline]
fn combat_targeting_range_with_radius_sq(range_sq: f64, target_radius: f64) -> f64 {
    if target_radius <= 0.0 {
        return range_sq;
    }
    let range = range_sq.max(0.0).sqrt();
    let r = range + target_radius;
    r * r
}

#[inline]
fn combat_targeting_fire_max_with_radius_sq(
    pool: &CombatTargetingPool,
    idx: usize,
    release_edge: bool,
    target_radius: f64,
) -> f64 {
    let range_sq = if release_edge {
        pool.turret_fire_max_release_sq[idx]
    } else {
        pool.turret_fire_max_acquire_sq[idx]
    };
    combat_targeting_range_with_radius_sq(range_sq, target_radius)
}

#[inline]
fn combat_targeting_outermost_release_with_radius_sq(
    pool: &CombatTargetingPool,
    idx: usize,
    target_radius: f64,
) -> f64 {
    let has_tracking = (pool.turret_config_flags[idx] & CT_TURRET_CFG_HAS_TRACKING_RANGE) != 0;
    let range_sq = if has_tracking {
        pool.turret_tracking_release_sq[idx]
    } else {
        pool.turret_fire_max_release_sq[idx]
    };
    combat_targeting_range_with_radius_sq(range_sq, target_radius)
}

#[inline]
fn combat_targeting_fire_rank_from_pool_sq(
    pool: &CombatTargetingPool,
    idx: usize,
    release_edge: bool,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    if dist_sq > combat_targeting_fire_max_with_radius_sq(pool, idx, release_edge, target_radius) {
        return CT_TARGET_RANK_NONE;
    }

    let min_sq = if release_edge {
        pool.turret_fire_min_release_sq[idx]
    } else {
        pool.turret_fire_min_acquire_sq[idx]
    };
    if min_sq <= 0.0 {
        return CT_TARGET_RANK_FIRE_PREFERRED;
    }

    let min_range = min_sq.sqrt();
    let threshold = min_range - target_radius;
    if threshold <= 0.0 {
        return CT_TARGET_RANK_FIRE_PREFERRED;
    }
    let threshold_sq = if target_radius <= 0.0 {
        min_sq
    } else {
        threshold * threshold
    };
    if dist_sq >= threshold_sq {
        CT_TARGET_RANK_FIRE_PREFERRED
    } else {
        CT_TARGET_RANK_FIRE_FALLBACK
    }
}

#[inline]
fn combat_targeting_entity_slot_for_id(
    pool: &CombatTargetingPool,
    entity_id: i32,
) -> Option<usize> {
    if entity_id < 0 {
        return None;
    }
    let slot = *pool.entity_slot_by_id.get(&entity_id)? as usize;
    if slot >= pool.entity_id.len() || pool.entity_id[slot] != entity_id {
        return None;
    }
    Some(slot)
}

#[inline]
fn combat_targeting_dist_sq_to_entity_slot(
    pool: &CombatTargetingPool,
    turret_idx: usize,
    entity_slot: usize,
) -> f64 {
    let dx = pool.turret_mount_x[turret_idx] - pool.entity_pos_x[entity_slot];
    let dy = pool.turret_mount_y[turret_idx] - pool.entity_pos_y[entity_slot];
    let dz = pool.turret_mount_z[turret_idx] - pool.entity_pos_z[entity_slot];
    dx * dx + dy * dy + dz * dz
}

#[inline]
fn combat_targeting_current_fire_target_rank_sq(
    pool: &CombatTargetingPool,
    turret_idx: usize,
) -> (u8, f64) {
    let target_id = pool.turret_target_id[turret_idx];
    let Some(target_slot) = combat_targeting_entity_slot_for_id(pool, target_id) else {
        return (CT_TARGET_RANK_NONE, f64::INFINITY);
    };
    let dist_sq = combat_targeting_dist_sq_to_entity_slot(pool, turret_idx, target_slot);
    let rank = combat_targeting_fire_rank_from_pool_sq(
        pool,
        turret_idx,
        true,
        dist_sq,
        pool.entity_radius_shot[target_slot],
    );
    (rank, dist_sq)
}

#[inline]
fn combat_targeting_weapon_system_disabled(
    pool: &CombatTargetingPool,
    idx: usize,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
) -> bool {
    let flags = pool.turret_config_flags[idx];
    (flags & CT_TURRET_CFG_VISUAL_ONLY) != 0
        || ((flags & CT_TURRET_CFG_PASSIVE) != 0 && mirrors_enabled == 0)
        || ((flags & CT_TURRET_CFG_SHOT_IS_FORCE) != 0 && force_fields_enabled == 0)
}

/// AIM-08.5 — Rust auto-targeting pre-scan over the combat-targeting
/// slab. This replaces the TypeScript loop that derived:
///   - whether any turret needs a batched enemy query,
///   - the maximum outer acquire range,
///   - the maximum mount offset used to widen that query,
///   - and the per-turret current-fire rank cache for min-range
///     fallback promotion.
#[wasm_bindgen]
pub fn combat_targeting_prepare_auto_scan(
    entity_slot: u32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    cached_fire_ranks: &mut [u8],
    cached_fire_dist_sqs: &mut [f64],
    out_f64: &mut [f64],
) -> u8 {
    if out_f64.len() >= 2 {
        out_f64[0] = 0.0;
        out_f64[1] = 0.0;
    }

    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let turret_count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(cached_fire_ranks.len())
        .min(cached_fire_dist_sqs.len());
    if turret_count == 0 {
        return 0;
    }

    let mut needs_any_query = false;
    let mut max_acquire_range = 0.0;
    let mut max_weapon_offset = 0.0;

    for turret_idx in 0..turret_count {
        cached_fire_ranks[turret_idx] = CT_TARGET_RANK_NONE;
        cached_fire_dist_sqs[turret_idx] = f64::INFINITY;

        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(pool, idx, mirrors_enabled, force_fields_enabled)
        {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }

        let acquire = pool.turret_outermost_acquire[idx];
        if acquire > max_acquire_range {
            max_acquire_range = acquire;
        }
        let offset = pool.turret_mount_offset_2d[idx];
        if offset > max_weapon_offset {
            max_weapon_offset = offset;
        }

        let mut cached_rank = CT_TARGET_RANK_NONE;
        if pool.turret_state[idx] == CT_TURRET_STATE_ENGAGED
            && pool.turret_fire_min_release_sq[idx] > 0.0
        {
            let (rank, dist_sq) = combat_targeting_current_fire_target_rank_sq(pool, idx);
            cached_rank = rank;
            cached_fire_ranks[turret_idx] = rank;
            cached_fire_dist_sqs[turret_idx] = dist_sq;
        }

        if pool.turret_target_id[idx] < 0
            || pool.turret_state[idx] == CT_TURRET_STATE_TRACKING
            || cached_rank == CT_TARGET_RANK_FIRE_FALLBACK
        {
            needs_any_query = true;
        }
    }

    if out_f64.len() >= 2 {
        out_f64[0] = max_acquire_range;
        out_f64[1] = max_weapon_offset;
    }

    if needs_any_query {
        1
    } else {
        0
    }
}

#[inline]
fn combat_targeting_clear_choice_prep_outputs(
    count: usize,
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_mirror_scores: &mut [f64],
) {
    for i in 0..count {
        apply_mask[i] = 0;
        seed_ranks[i] = CT_TARGET_RANK_NONE;
        seed_dist_sqs[i] = f64::INFINITY;
        seed_mirror_scores[i] = 0.0;
    }
}

#[inline]
fn combat_targeting_choice_prep_result(current: u8, flags: u8) -> u8 {
    if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
        current | CT_TARGETING_PREP_HAS_APPLY | CT_TARGETING_PREP_HAS_PASSIVE_APPLY
    } else {
        current | CT_TARGETING_PREP_HAS_APPLY
    }
}

/// AIM-08.5 — Rust-owned fire-choice gate preparation for one entity.
/// Replaces the TS per-weapon loop that decided which existing locks
/// should scan the shared candidate list and seeded each turret's
/// current fire-band rank/distance. Passive mirror seed scores remain
/// object-owned on the JS side because their priority function still
/// reads target turret activity.
#[wasm_bindgen]
pub fn combat_targeting_prepare_fire_choice_fsm_inputs(
    entity_slot: u32,
    source_entity_id: i32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    cached_fire_ranks: &[u8],
    cached_fire_dist_sqs: &[f64],
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_mirror_scores: &mut [f64],
) -> u8 {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(cached_fire_ranks.len())
        .min(cached_fire_dist_sqs.len())
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_mirror_scores.len());
    combat_targeting_clear_choice_prep_outputs(
        count,
        apply_mask,
        seed_ranks,
        seed_dist_sqs,
        seed_mirror_scores,
    );

    let mut result = 0u8;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(pool, idx, mirrors_enabled, force_fields_enabled)
        {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        let target_id = pool.turret_target_id[idx];
        if target_id < 0 {
            continue;
        }

        let cached_rank = cached_fire_ranks[turret_idx];
        if pool.turret_state[idx] != CT_TURRET_STATE_TRACKING
            && cached_rank != CT_TARGET_RANK_FIRE_FALLBACK
        {
            continue;
        }

        apply_mask[turret_idx] = 1;
        seed_ranks[turret_idx] = cached_rank;
        seed_dist_sqs[turret_idx] = cached_fire_dist_sqs[turret_idx];
        // Passive turrets seed their fire-choice rank against the
        // mirror DPS of their current target so candidate scoring can
        // prefer higher-DPS lock-on opportunities. Non-passive turrets
        // leave the score at the 0 cleared above.
        if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            if let Some(&target_slot) = pool.entity_slot_by_id.get(&target_id) {
                seed_mirror_scores[turret_idx] = combat_targeting_mirror_target_score_for_slot(
                    pool,
                    target_slot as usize,
                    source_entity_id,
                );
            }
        }
        result = combat_targeting_choice_prep_result(result, flags);
    }

    result
}

/// AIM-08.5 — Rust-owned acquisition gate preparation for one entity.
/// Replaces the TS per-weapon loop that selected idle turrets for the
/// acquisition candidate scan and seeded them with the empty target.
#[wasm_bindgen]
pub fn combat_targeting_prepare_acquisition_choice_fsm_inputs(
    entity_slot: u32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    apply_mask: &mut [u8],
    seed_ranks: &mut [u8],
    seed_dist_sqs: &mut [f64],
    seed_mirror_scores: &mut [f64],
) -> u8 {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return 0;
    }

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_mirror_scores.len());
    combat_targeting_clear_choice_prep_outputs(
        count,
        apply_mask,
        seed_ranks,
        seed_dist_sqs,
        seed_mirror_scores,
    );

    let mut result = 0u8;
    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if combat_targeting_weapon_system_disabled(pool, idx, mirrors_enabled, force_fields_enabled)
        {
            continue;
        }

        let flags = pool.turret_config_flags[idx];
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if pool.turret_target_id[idx] >= 0 {
            continue;
        }

        apply_mask[turret_idx] = 1;
        result = combat_targeting_choice_prep_result(result, flags);
    }

    result
}

/// Clear one turret's lock in the combat-targeting slab. JS uses this
/// for object-owned gates (manual/passive/disabled branches) while the
/// rest of the FSM transition writes live here.
#[wasm_bindgen]
pub fn combat_targeting_clear_turret_lock(entity_slot: u32, turret_idx: u32) {
    let pool = combat_targeting_pool();
    let Some(idx) = combat_targeting_live_turret_idx(pool, entity_slot, turret_idx) else {
        return;
    };
    combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
}

/// Clear every live turret lock for one entity in one boundary call.
/// Used by global fire-disable paths while JS still owns priority
/// command fields and cooldown bookkeeping.
#[wasm_bindgen]
pub fn combat_targeting_clear_entity_locks(entity_slot: u32) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = pool.turret_count_per_entity[entity_idx] as u32;
    for turret_idx in 0..count {
        if turret_idx >= COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY {
            break;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
    }
}

#[inline]
fn combat_targeting_apply_priority_point_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    dist_sq: f64,
    los_clear: u8,
    ballistic_clear: u8,
    force_field_clear: u8,
) {
    let old_state = pool.turret_state[idx];
    let next_state = if los_clear == 0 || ballistic_clear == 0 {
        CT_TURRET_STATE_IDLE
    } else if force_field_clear == 0 {
        CT_TURRET_STATE_IDLE
    } else if dist_sq <= combat_targeting_fire_max_with_radius_sq(pool, idx, false, 0.0) {
        CT_TURRET_STATE_ENGAGED
    } else if dist_sq <= combat_targeting_fire_max_with_radius_sq(pool, idx, true, 0.0) {
        if old_state == CT_TURRET_STATE_ENGAGED {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        }
    } else {
        CT_TURRET_STATE_TRACKING
    };
    combat_targeting_set_target_state(pool, idx, -1, next_state);
}

/// AIM-08.5 — batch attack-ground priority transitions for one entity.
/// JS supplies the still-object-owned gates as parallel per-turret
/// masks; Rust reads the current mount positions from the slab and
/// applies all target/state transitions in one boundary call.
#[wasm_bindgen]
pub fn combat_targeting_apply_priority_point_fsm_batch(
    entity_slot: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    apply_mask: &[u8],
    los_clear: &[u8],
    ballistic_clear: &[u8],
    force_field_clear: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(los_clear.len())
        .min(ballistic_clear.len())
        .min(force_field_clear.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let dx = pool.turret_mount_x[idx] - target_x;
        let dy = pool.turret_mount_y[idx] - target_y;
        let dz = pool.turret_mount_z[idx] - target_z;
        combat_targeting_apply_priority_point_fsm_idx(
            pool,
            idx,
            dx * dx + dy * dy + dz * dz,
            los_clear[turret_idx],
            ballistic_clear[turret_idx],
            force_field_clear[turret_idx],
        );
    }
}

/// Under-only ballistic lock floor: the lock-on point must sit at least
/// this far below the weapon mount along the world Z axis. Matches the
/// TypeScript UNDER_ONLY_MIN_BELOW_DISTANCE in targetingSystem.ts.
const CT_UNDER_ONLY_MIN_BELOW_DISTANCE: f64 = 30.0;
const CT_UNDER_ONLY_LOCK_EPS: f64 = 1e-6;

/// AIM-08.5 — Shared gate-compute helper for the three unified priority
/// / existing-lock kernels. Returns the three per-turret clearance
/// flags the FSM transition functions consume:
///   - `los_clear`: terrain + entity LOS from mount to the raw aim
///     point (or `1` for high-arc / line-of-sight-exempt weapons).
///   - `ballistic_clear`: weapon can produce a flight solution given
///     the under-only floor, ground-aim adjustment, and target
///     kinematics. Direct-fire and vertical-launcher weapons auto-pass,
///     mirroring the TS `weaponUsesNormalAim`/`weaponNeedsBallisticSolution`
///     short-circuit.
///   - `force_field_clear`: segment-checks the FF pool from mount to
///     raw aim point and ANDs with the JS-precomputed mirror-panel
///     mask. Skipped (returns `1`) when the feature is off or for
///     force-shot weapons that maintain the material themselves.
///
/// The helper short-circuits in cost-increasing order to match the TS
/// gate evaluation: LOS → ballistic → FF. Ground-aim fraction applies
/// only to the ballistic solve's aim point — LOS and FF use the raw
/// aim point, the same way the TS path does.
fn compute_turret_gates_for_aim_point(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    idx: usize,
    flags: u8,
    mount_x: f64, mount_y: f64, mount_z: f64,
    raw_aim_x: f64, raw_aim_y: f64, raw_aim_z: f64,
    target_vx: f64, target_vy: f64, target_vz: f64,
    target_entity_id: i32,
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    force_field_obstruction_active: u8,
    projectile_speed: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
    gravity: f64,
) -> (u8, u8, u8) {
    let los_clear: u8 = if (flags & CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS) != 0 {
        combat_has_line_of_sight(
            mount_x, mount_y, mount_z,
            raw_aim_x, raw_aim_y, raw_aim_z,
            terrain_step_len,
            entity_line_width,
            source_entity_id,
            target_entity_id,
        ) as u8
    } else {
        1
    };

    let mut ballistic_clear: u8 = 0;
    if los_clear != 0 {
        let under_only_ok = if under_only {
            raw_aim_z <= mount_z - CT_UNDER_ONLY_MIN_BELOW_DISTANCE + CT_UNDER_ONLY_LOCK_EPS
        } else {
            true
        };
        if under_only_ok {
            if (flags & CT_TURRET_CFG_NEEDS_BALLISTIC) == 0
                || (flags & CT_TURRET_CFG_VERTICAL_LAUNCHER) != 0
            {
                // Direct-fire / vertical-launcher: skip the solve. Same
                // outcome the TS `weaponUsesNormalAim()==false` branch
                // produces via `solveTurretAimAtPoint`.
                ballistic_clear = 1;
            } else {
                // Ground-aim fraction blends the aim point toward the
                // mount and onto terrain (and scales target velocity
                // accordingly). `f == 0` means "use the raw aim point."
                let f = ground_aim_fraction;
                let (ball_aim_x, ball_aim_y, ball_aim_z, ball_tvx, ball_tvy, ball_tvz) =
                    if f > 0.0 {
                        let ax = mount_x + f * (raw_aim_x - mount_x);
                        let ay = mount_y + f * (raw_aim_y - mount_y);
                        let az = terrain_get_surface_height(ax, ay);
                        (ax, ay, az, target_vx * f, target_vy * f, 0.0)
                    } else {
                        (raw_aim_x, raw_aim_y, raw_aim_z, target_vx, target_vy, target_vz)
                    };
                let fallback_yaw = pool.turret_rotation[idx] as f64;
                let fallback_pitch = pool.turret_pitch[idx] as f64;
                ballistic_clear = combat_targeting_solve_ballistic_aim_inner(
                    pool,
                    entity_slot,
                    turret_idx,
                    ball_aim_x, ball_aim_y, ball_aim_z,
                    ball_tvx, ball_tvy, ball_tvz,
                    0.0, 0.0, 0.0,
                    0.0, 0.0, 0.0,
                    projectile_speed,
                    gravity,
                    arc_preference,
                    max_time_sec,
                    fallback_yaw,
                    fallback_pitch,
                ) as u8;
            }
        }
    }

    let mut force_field_clear: u8 = 1;
    if ballistic_clear != 0
        && force_field_obstruction_active != 0
        && (flags & CT_TURRET_CFG_SHOT_IS_FORCE) == 0
    {
        let ff_seg = force_field_clearance_segment(
            mount_x, mount_y, mount_z,
            raw_aim_x, raw_aim_y, raw_aim_z,
            -1,
            0,
        );
        // Passive (mirror) weapons skip the mirror-panel walk by
        // contract: a mirror turret cannot block its own sightline
        // class. Matches the JS-side `weapon.config.passive !== true`
        // gate in fillCandidateMirrorPanelMask / fillExistingLockGateInputs.
        let mirror_clear: u8 = if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            1
        } else {
            mirror_panel_clearance_segment(
                mount_x, mount_y, mount_z,
                raw_aim_x, raw_aim_y, raw_aim_z,
            )
        };
        if ff_seg == 0 || mirror_clear == 0 {
            force_field_clear = 0;
        }
    }

    (los_clear, ballistic_clear, force_field_clear)
}

/// AIM-08.5 — unified priority-point gate compute + FSM apply for one
/// entity. Replaces the per-weapon TypeScript loop that called the LOS,
/// ballistic, and force-field kernels separately and then applied the
/// FSM through `combat_targeting_apply_priority_point_fsm_batch`. The
/// kernel iterates the slab turrets once and computes every gate
/// internally, so a 5-turret entity makes one boundary call instead of
/// ~16 (3 gates × 5 turrets + 1 batch apply).
///
/// JS still owns:
///   - the per-shot ballistic config (`projectile_speed`, `arc_preference`,
///     `max_time_sec`) and `ground_aim_fraction`, supplied as parallel
///     per-turret arrays. These derive from blueprint data and don't
///     change per tick; a follow-up can stamp them on the slab.
///   - the under-only ballistic mask: 1 for `ballisticArcLowOnlyUnder`
///     weapons, 0 otherwise.
///
/// The kernel handles disabled/manual-fire/passive turrets the same way
/// the TS path does:
///   - manual fire → no FSM update
///   - weapon system disabled (visualOnly / passive&&!mirrors /
///     forceShot&&!fields) → no FSM update (the TS resetDisabledWeapon
///     pass has already cleared their state)
///   - passive → clear the lock (matches `targeting.clearTurretLock(...)`)
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_priority_point_fsm_batch(
    entity_slot: u32,
    point_x: f64,
    point_y: f64,
    point_z: f64,
    source_entity_id: i32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    force_field_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    projectile_speeds: &[f64],
    arc_preferences: &[u8],
    max_time_secs: &[f64],
    ground_aim_fractions: &[f64],
    under_only_mask: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(projectile_speeds.len())
        .min(arc_preferences.len())
        .min(max_time_secs.len())
        .min(ground_aim_fractions.len())
        .min(under_only_mask.len());

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        // Manual-fire weapons never participate in priority FSM transitions.
        // The TS Pass 0 also forces their state to 'idle' for the kinematics
        // step, but the priority-point branch skips them outright.
        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        // System-disabled weapons have already been reset by the TS
        // resetDisabledWeapon pre-pass; mirror this kernel's skip there.
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            mirrors_enabled,
            force_fields_enabled,
        ) {
            continue;
        }
        // Passive (mirror) weapons never lock onto an attack-ground
        // order. Clear any existing lock — same behaviour as the old
        // targeting.clearTurretLock(unitSlot, wi) call.
        if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
            continue;
        }

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];

        let (los_clear, ballistic_clear, force_field_clear) =
            compute_turret_gates_for_aim_point(
                pool,
                entity_slot,
                turret_idx as u32,
                idx,
                flags,
                mount_x, mount_y, mount_z,
                point_x, point_y, point_z,
                0.0, 0.0, 0.0,
                -1,
                source_entity_id,
                terrain_step_len,
                entity_line_width,
                force_field_obstruction_active,
                projectile_speeds[turret_idx],
                arc_preferences[turret_idx],
                max_time_secs[turret_idx],
                ground_aim_fractions[turret_idx],
                under_only_mask[turret_idx] != 0,
                gravity,
            );

        let dx = mount_x - point_x;
        let dy = mount_y - point_y;
        let dz = mount_z - point_z;
        combat_targeting_apply_priority_point_fsm_idx(
            pool,
            idx,
            dx * dx + dy * dy + dz * dz,
            los_clear,
            ballistic_clear,
            force_field_clear,
        );
    }
}

#[inline]
fn combat_targeting_apply_priority_target_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target_id: i32,
    target_radius: f64,
    dist_sq: f64,
    target_valid: u8,
    mirror_valid: u8,
    los_clear: u8,
    ballistic_clear: u8,
    force_field_clear: u8,
) {
    if target_id < 0
        || target_valid == 0
        || mirror_valid == 0
        || los_clear == 0
        || ballistic_clear == 0
        || force_field_clear == 0
    {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let old_state = pool.turret_state[idx];
    let next_state = if dist_sq
        <= combat_targeting_fire_max_with_radius_sq(pool, idx, false, target_radius)
    {
        CT_TURRET_STATE_ENGAGED
    } else if dist_sq <= combat_targeting_fire_max_with_radius_sq(pool, idx, true, target_radius) {
        if old_state == CT_TURRET_STATE_ENGAGED {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        }
    } else {
        CT_TURRET_STATE_TRACKING
    };
    combat_targeting_set_target_state(pool, idx, target_id, next_state);
}

/// AIM-08.5 — batch attack-entity priority transitions for one entity.
/// Rust resolves the target slot/radius and per-turret distances from
/// the slab; JS supplies visibility/mirror/LOS/ballistic/field gates.
#[wasm_bindgen]
pub fn combat_targeting_apply_priority_target_fsm_batch(
    entity_slot: u32,
    target_id: i32,
    apply_mask: &[u8],
    mirror_valid: &[u8],
    los_clear: &[u8],
    ballistic_clear: &[u8],
    force_field_clear: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
    let target_valid = if let Some(slot) = target_slot {
        if combat_targeting_entity_alive(pool, slot) {
            1
        } else {
            0
        }
    } else {
        0
    };
    let target_radius = target_slot
        .map(|slot| pool.entity_radius_shot[slot])
        .unwrap_or(0.0);
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(mirror_valid.len())
        .min(los_clear.len())
        .min(ballistic_clear.len())
        .min(force_field_clear.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let dist_sq = target_slot
            .map(|slot| combat_targeting_dist_sq_to_entity_slot(pool, idx, slot))
            .unwrap_or(f64::INFINITY);
        combat_targeting_apply_priority_target_fsm_idx(
            pool,
            idx,
            target_id,
            target_radius,
            dist_sq,
            target_valid,
            mirror_valid[turret_idx],
            los_clear[turret_idx],
            ballistic_clear[turret_idx],
            force_field_clear[turret_idx],
        );
    }
}

#[inline]
fn combat_targeting_validate_existing_lock_fsm_idx(
    pool: &mut CombatTargetingPool,
    idx: usize,
    target_radius: f64,
    dist_sq: f64,
    target_valid: u8,
    mirror_valid: u8,
    ballistic_clear: u8,
    los_blocked: u8,
    los_drop_grace_ticks: u16,
) {
    if target_valid == 0 || mirror_valid == 0 || ballistic_clear == 0 {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let blocked = los_blocked != 0;
    pool.turret_los_blocked_ticks[idx] = if blocked {
        pool.turret_los_blocked_ticks[idx].saturating_add(1)
    } else {
        0
    };
    let los_drop = pool.turret_los_blocked_ticks[idx] > los_drop_grace_ticks;
    if dist_sq > combat_targeting_outermost_release_with_radius_sq(pool, idx, target_radius)
        || los_drop
    {
        combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
        return;
    }

    let state = pool.turret_state[idx];
    if state == CT_TURRET_STATE_TRACKING {
        if !blocked
            && dist_sq <= combat_targeting_fire_max_with_radius_sq(pool, idx, false, target_radius)
        {
            pool.turret_state[idx] = CT_TURRET_STATE_ENGAGED;
        }
    } else if state == CT_TURRET_STATE_ENGAGED
        && (blocked
            || dist_sq > combat_targeting_fire_max_with_radius_sq(pool, idx, true, target_radius))
    {
        pool.turret_state[idx] = CT_TURRET_STATE_TRACKING;
    }
}

/// AIM-08.5 — batch existing-lock validation for one entity. Rust
/// reads target ids, target liveness, target radii, and per-turret
/// distance from the slab; JS only supplies gates that still depend on
/// object-owned systems during migration.
#[wasm_bindgen]
pub fn combat_targeting_validate_existing_lock_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_observable: &[u8],
    mirror_valid: &[u8],
    ballistic_clear: &[u8],
    los_blocked: &[u8],
    los_drop_grace_ticks: u16,
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_observable.len())
        .min(mirror_valid.len())
        .min(ballistic_clear.len())
        .min(los_blocked.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let target_slot = combat_targeting_entity_slot_for_id(pool, pool.turret_target_id[idx]);
        let target_valid = if target_observable[turret_idx] != 0 {
            target_slot
                .map(|slot| combat_targeting_entity_alive(pool, slot) as u8)
                .unwrap_or(0)
        } else {
            0
        };
        let target_radius = target_slot
            .map(|slot| pool.entity_radius_shot[slot])
            .unwrap_or(0.0);
        let dist_sq = target_slot
            .map(|slot| combat_targeting_dist_sq_to_entity_slot(pool, idx, slot))
            .unwrap_or(f64::INFINITY);
        combat_targeting_validate_existing_lock_fsm_idx(
            pool,
            idx,
            target_radius,
            dist_sq,
            target_valid,
            mirror_valid[turret_idx],
            ballistic_clear[turret_idx],
            los_blocked[turret_idx],
            los_drop_grace_ticks,
        );
    }
}

/// AIM-08.5 — unified attack-entity priority gate compute + FSM apply.
/// Combines the JS-side per-weapon LOS / ballistic / FF / mirror-valid
/// gate prep with the existing `apply_priority_target_fsm_idx`
/// transitions inside one boundary call. The mirror-panel sightline
/// walk now lives in Rust (slab-backed) along with the passive-turret
/// `isMirrorTarget` score. Per-turret aim points are TS-resolved so
/// `lockOnToBody` AABB clamps and `lockOnToTurret` resolution stay in
/// one place; the kernel consumes them.
///
/// Same disabled / manual-fire skip semantics as the priority-point
/// kernel. Passive turrets continue to participate (mirror_valid then
/// reflects whether the target has a damaging turret in range).
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_priority_target_fsm_batch(
    entity_slot: u32,
    target_id: i32,
    source_entity_id: i32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    force_field_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
    projectile_speeds: &[f64],
    arc_preferences: &[u8],
    max_time_secs: &[f64],
    ground_aim_fractions: &[f64],
    under_only_mask: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }

    let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
    let (target_valid, target_radius, target_vx, target_vy, target_vz) =
        if let Some(slot) = target_slot {
            if combat_targeting_entity_alive(pool, slot) {
                (
                    1u8,
                    pool.entity_radius_shot[slot],
                    pool.entity_vel_x[slot],
                    pool.entity_vel_y[slot],
                    pool.entity_vel_z[slot],
                )
            } else {
                (0u8, 0.0, 0.0, 0.0, 0.0)
            }
        } else {
            (0u8, 0.0, 0.0, 0.0, 0.0)
        };

    // Mirror-valid is identical for every passive turret on this unit
    // (it depends only on target + source, not on the turret), so
    // compute it once up front using the Rust mirror-target helper.
    // Non-passive turrets get mirror_valid = 1 unconditionally.
    let passive_mirror_valid: u8 = match target_slot {
        Some(slot) => {
            if combat_targeting_is_mirror_target_for_slot(pool, slot, source_entity_id) {
                1
            } else {
                0
            }
        }
        None => 0,
    };

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(aim_x.len())
        .min(aim_y.len())
        .min(aim_z.len())
        .min(projectile_speeds.len())
        .min(arc_preferences.len())
        .min(max_time_secs.len())
        .min(ground_aim_fractions.len())
        .min(under_only_mask.len());

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            mirrors_enabled,
            force_fields_enabled,
        ) {
            continue;
        }

        let mirror_valid = if (flags & CT_TURRET_CFG_PASSIVE) == 0 {
            1u8
        } else {
            passive_mirror_valid
        };

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];

        // Short-circuit when the target or mirror gate has already
        // failed — saves the LOS/ballistic/FF compute since the FSM
        // is going to idle anyway.
        let (los_clear, ballistic_clear, force_field_clear) =
            if target_valid == 0 || mirror_valid == 0 {
                (0u8, 0u8, 0u8)
            } else {
                compute_turret_gates_for_aim_point(
                    pool,
                    entity_slot,
                    turret_idx as u32,
                    idx,
                    flags,
                    mount_x, mount_y, mount_z,
                    aim_x[turret_idx], aim_y[turret_idx], aim_z[turret_idx],
                    target_vx, target_vy, target_vz,
                    target_id,
                    source_entity_id,
                    terrain_step_len,
                    entity_line_width,
                    force_field_obstruction_active,
                    projectile_speeds[turret_idx],
                    arc_preferences[turret_idx],
                    max_time_secs[turret_idx],
                    ground_aim_fractions[turret_idx],
                    under_only_mask[turret_idx] != 0,
                    gravity,
                )
            };

        let dist_sq = target_slot
            .map(|slot| combat_targeting_dist_sq_to_entity_slot(pool, idx, slot))
            .unwrap_or(f64::INFINITY);
        combat_targeting_apply_priority_target_fsm_idx(
            pool,
            idx,
            target_id,
            target_radius,
            dist_sq,
            target_valid,
            mirror_valid,
            los_clear,
            ballistic_clear,
            force_field_clear,
        );
    }
}

/// AIM-08.5 — unified existing-lock gate compute + FSM apply. Each
/// turret resolves its own target via `pool.turret_target_id[idx]`, so
/// the kernel walks the slab and looks up per-turret target metadata
/// itself. The `sight_blocked` predicate (TS `ballistic && (!los ||
/// !ff)`) is derived from the helper's three gates in-place. The
/// cloak observability check now reads from slab detector/cloak data
/// stamped by the stamping pass — no observable mask required.
#[wasm_bindgen]
pub fn combat_targeting_compute_and_apply_validate_existing_lock_fsm_batch(
    entity_slot: u32,
    source_entity_id: i32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    force_field_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    los_drop_grace_ticks: u16,
    aim_x: &[f64],
    aim_y: &[f64],
    aim_z: &[f64],
    projectile_speeds: &[f64],
    arc_preferences: &[u8],
    max_time_secs: &[f64],
    ground_aim_fractions: &[f64],
    under_only_mask: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let source_player_id = pool.entity_owner_player_id[entity_idx];

    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(aim_x.len())
        .min(aim_y.len())
        .min(aim_z.len())
        .min(projectile_speeds.len())
        .min(arc_preferences.len())
        .min(max_time_secs.len())
        .min(ground_aim_fractions.len())
        .min(under_only_mask.len());

    for turret_idx in 0..count {
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];

        if (flags & CT_TURRET_CFG_IS_MANUAL_FIRE) != 0 {
            continue;
        }
        if combat_targeting_weapon_system_disabled(
            pool,
            idx,
            mirrors_enabled,
            force_fields_enabled,
        ) {
            continue;
        }
        // No existing target → nothing to validate; matches the TS
        // `weapon.target === null` skip.
        let target_id = pool.turret_target_id[idx];
        if target_id < 0 {
            continue;
        }

        let target_slot = combat_targeting_entity_slot_for_id(pool, target_id);
        let observable = match target_slot {
            Some(slot) => combat_targeting_player_observes_entity(pool, slot, source_player_id),
            None => false,
        };
        let (target_valid, target_radius, target_vx, target_vy, target_vz) = if observable {
            if let Some(slot) = target_slot {
                if combat_targeting_entity_alive(pool, slot) {
                    (
                        1u8,
                        pool.entity_radius_shot[slot],
                        pool.entity_vel_x[slot],
                        pool.entity_vel_y[slot],
                        pool.entity_vel_z[slot],
                    )
                } else {
                    (0u8, 0.0, 0.0, 0.0, 0.0)
                }
            } else {
                (0u8, 0.0, 0.0, 0.0, 0.0)
            }
        } else {
            (0u8, 0.0, 0.0, 0.0, 0.0)
        };

        // For passive turrets, "valid" requires the target to still
        // carry a damaging turret locked onto us. Non-passive turrets
        // skip the mirror check.
        let mirror_valid = if target_valid == 0 {
            0u8
        } else if (flags & CT_TURRET_CFG_PASSIVE) == 0 {
            1u8
        } else {
            target_slot
                .map(|slot| {
                    if combat_targeting_is_mirror_target_for_slot(pool, slot, source_entity_id) {
                        1u8
                    } else {
                        0u8
                    }
                })
                .unwrap_or(0u8)
        };

        let mount_x = pool.turret_mount_x[idx];
        let mount_y = pool.turret_mount_y[idx];
        let mount_z = pool.turret_mount_z[idx];

        // Short-circuit when target invalid or mirror invalid — the
        // FSM will set state idle without consulting gates anyway.
        let (ballistic_clear, sight_blocked) =
            if target_valid == 0 || mirror_valid == 0 {
                (0u8, 0u8)
            } else {
                let (los_clear, bc, ff_clear) = compute_turret_gates_for_aim_point(
                    pool,
                    entity_slot,
                    turret_idx as u32,
                    idx,
                    flags,
                    mount_x, mount_y, mount_z,
                    aim_x[turret_idx], aim_y[turret_idx], aim_z[turret_idx],
                    target_vx, target_vy, target_vz,
                    target_id,
                    source_entity_id,
                    terrain_step_len,
                    entity_line_width,
                    force_field_obstruction_active,
                    projectile_speeds[turret_idx],
                    arc_preferences[turret_idx],
                    max_time_secs[turret_idx],
                    ground_aim_fractions[turret_idx],
                    under_only_mask[turret_idx] != 0,
                    gravity,
                );
                // sight_blocked = the weapon could otherwise fire
                // (ballistic OK) but a visibility gate failed. Matches
                // the TS predicate `ballisticClear && (!los || !ff)`.
                let blocked = if bc != 0 && (los_clear == 0 || ff_clear == 0) {
                    1u8
                } else {
                    0u8
                };
                (bc, blocked)
            };

        let dist_sq = target_slot
            .map(|slot| combat_targeting_dist_sq_to_entity_slot(pool, idx, slot))
            .unwrap_or(f64::INFINITY);
        combat_targeting_validate_existing_lock_fsm_idx(
            pool,
            idx,
            target_radius,
            dist_sq,
            target_valid,
            mirror_valid,
            ballistic_clear,
            sight_blocked,
            los_drop_grace_ticks,
        );
    }
}

/// AIM-08.5 — batch fire-band candidate switches for one entity.
#[wasm_bindgen]
pub fn combat_targeting_apply_fire_choice_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_ids: &[i32],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_ids.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let target_id = target_ids[turret_idx];
        if target_id < 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        combat_targeting_set_target_state(pool, idx, target_id, CT_TURRET_STATE_ENGAGED);
    }
}

/// AIM-08.5 — batch acquisition candidate results for one entity.
#[wasm_bindgen]
pub fn combat_targeting_apply_acquisition_choice_fsm_batch(
    entity_slot: u32,
    apply_mask: &[u8],
    target_ids: &[i32],
    ranks: &[u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(target_ids.len())
        .min(ranks.len());
    for turret_idx in 0..count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let target_id = target_ids[turret_idx];
        if target_id < 0 {
            combat_targeting_set_target_state(pool, idx, -1, CT_TURRET_STATE_IDLE);
            continue;
        }
        let state = if ranks[turret_idx] >= CT_TARGET_RANK_FIRE_FALLBACK {
            CT_TURRET_STATE_ENGAGED
        } else {
            CT_TURRET_STATE_TRACKING
        };
        combat_targeting_set_target_state(pool, idx, target_id, state);
    }
}

#[inline]
fn targeting_edge_value(acquire: f64, release: f64, edge: u8) -> f64 {
    if edge == CT_TARGET_EDGE_RELEASE {
        release
    } else {
        acquire
    }
}

#[inline]
fn targeting_max_range_with_radius_sq(
    acquire: f64,
    release: f64,
    edge: u8,
    target_radius: f64,
) -> f64 {
    let range = targeting_edge_value(acquire, release, edge);
    if target_radius <= 0.0 {
        range * range
    } else {
        let r = range + target_radius;
        r * r
    }
}

#[inline]
fn targeting_min_range_prefers_target_sq(
    has_min: u8,
    min_acquire: f64,
    min_release: f64,
    edge: u8,
    target_radius: f64,
    dist_sq: f64,
) -> bool {
    if has_min == 0 {
        return true;
    }
    let min_range = targeting_edge_value(min_acquire, min_release, edge);
    if min_range <= 0.0 {
        return true;
    }

    let threshold = min_range - target_radius;
    if threshold <= 0.0 {
        return true;
    }
    let threshold_sq = if target_radius <= 0.0 {
        min_range * min_range
    } else {
        threshold * threshold
    };
    dist_sq >= threshold_sq
}

#[inline]
fn targeting_fire_rank_sq(
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    edge: u8,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    let max_sq =
        targeting_max_range_with_radius_sq(fire_max_acquire, fire_max_release, edge, target_radius);
    if !(dist_sq <= max_sq) {
        return CT_TARGET_RANK_NONE;
    }
    if targeting_min_range_prefers_target_sq(
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        edge,
        target_radius,
        dist_sq,
    ) {
        CT_TARGET_RANK_FIRE_PREFERRED
    } else {
        CT_TARGET_RANK_FIRE_FALLBACK
    }
}

#[inline]
fn targeting_acquisition_rank_sq(
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    edge: u8,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    let fire_rank = targeting_fire_rank_sq(
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        edge,
        dist_sq,
        target_radius,
    );
    if fire_rank != CT_TARGET_RANK_NONE {
        return fire_rank;
    }
    if has_tracking != 0 {
        let tracking_sq = targeting_max_range_with_radius_sq(
            tracking_acquire,
            tracking_release,
            edge,
            target_radius,
        );
        if dist_sq <= tracking_sq {
            return CT_TARGET_RANK_TRACKING_ONLY;
        }
    }
    CT_TARGET_RANK_NONE
}

#[inline]
fn targeting_rank_sq(
    rank_mode: u8,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    edge: u8,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    if rank_mode == CT_TARGET_RANK_MODE_ACQUISITION {
        targeting_acquisition_rank_sq(
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            has_tracking,
            tracking_acquire,
            tracking_release,
            edge,
            dist_sq,
            target_radius,
        )
    } else {
        targeting_fire_rank_sq(
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            edge,
            dist_sq,
            target_radius,
        )
    }
}

#[inline]
fn targeting_is_better_candidate(rank: u8, dist_sq: f64, best_rank: u8, best_dist_sq: f64) -> bool {
    rank > best_rank || (rank == best_rank && dist_sq < best_dist_sq)
}

#[inline]
fn targeting_is_better_mirror_candidate(
    mirror_score: f64,
    rank: u8,
    dist_sq: f64,
    best_mirror_score: f64,
    best_rank: u8,
    best_dist_sq: f64,
) -> bool {
    if mirror_score != best_mirror_score {
        return mirror_score > best_mirror_score;
    }
    targeting_is_better_candidate(rank, dist_sq, best_rank, best_dist_sq)
}

#[inline]
fn targeting_candidate_beats_seed(
    is_passive: u8,
    rank: u8,
    dist_sq: f64,
    mirror_score: f64,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_mirror_score: f64,
) -> bool {
    if is_passive != 0 {
        targeting_is_better_mirror_candidate(
            mirror_score,
            rank,
            dist_sq,
            seed_mirror_score,
            seed_rank,
            seed_dist_sq,
        )
    } else {
        targeting_is_better_candidate(rank, dist_sq, seed_rank, seed_dist_sq)
    }
}

#[inline]
fn targeting_score_candidate(
    candidate_idx: usize,
    weapon_x: f64,
    weapon_y: f64,
    weapon_z: f64,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    rank_mode: u8,
    minimum_rank: u8,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_mirror_score: f64,
    is_passive: u8,
    candidate_observable: &[u8],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_mirror_score: &[f64],
) -> Option<(u8, f64, f64)> {
    if candidate_observable[candidate_idx] == 0 {
        return None;
    }
    let mut mirror_score = 0.0;
    if is_passive != 0 {
        mirror_score = candidate_mirror_score[candidate_idx];
        if mirror_score <= 0.0 {
            return None;
        }
    }
    let dx = weapon_x - candidate_pos_x[candidate_idx];
    let dy = weapon_y - candidate_pos_y[candidate_idx];
    let dz = weapon_z - candidate_pos_z[candidate_idx];
    let dist_sq = dx * dx + dy * dy + dz * dz;
    let rank = targeting_rank_sq(
        rank_mode,
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        has_tracking,
        tracking_acquire,
        tracking_release,
        0,
        dist_sq,
        candidate_radius[candidate_idx],
    );
    if rank < minimum_rank {
        return None;
    }
    if !targeting_candidate_beats_seed(
        is_passive,
        rank,
        dist_sq,
        mirror_score,
        seed_rank,
        seed_dist_sq,
        seed_mirror_score,
    ) {
        return None;
    }
    Some((rank, dist_sq, mirror_score))
}

#[inline]
fn targeting_pool_entry_is_better(
    is_passive: u8,
    rank: u8,
    dist_sq: f64,
    mirror_score: f64,
    best_rank: u8,
    best_dist_sq: f64,
    best_mirror_score: f64,
) -> bool {
    if is_passive != 0 {
        targeting_is_better_mirror_candidate(
            mirror_score,
            rank,
            dist_sq,
            best_mirror_score,
            best_rank,
            best_dist_sq,
        )
    } else {
        targeting_is_better_candidate(rank, dist_sq, best_rank, best_dist_sq)
    }
}

struct TargetingCandidateChoice {
    candidate_idx: i32,
    rank: u8,
}

#[inline]
fn targeting_seed_choice(seed_rank: u8) -> TargetingCandidateChoice {
    TargetingCandidateChoice {
        candidate_idx: -1,
        rank: seed_rank,
    }
}

#[wasm_bindgen]
pub fn combat_targeting_rank_target(
    rank_mode: u8,
    edge: u8,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    dist_sq: f64,
    target_radius: f64,
) -> u8 {
    targeting_rank_sq(
        rank_mode,
        fire_max_acquire,
        fire_max_release,
        has_fire_min,
        fire_min_acquire,
        fire_min_release,
        has_tracking,
        tracking_acquire,
        tracking_release,
        edge,
        dist_sq,
        target_radius,
    )
}

/// AIM-08.5 — resolve a candidate's aim point against a turret mount.
/// Sphere targets (zero AABB half-extents) use entity center; AABB
/// targets (buildings) clamp the mount to the box. If the mount sits
/// inside the box (a turret embedded in an enemy building), aim at the
/// entity center to avoid a zero-length direction. Matches the TS
/// `resolveTargetAimPoint` body-lock path; lockOnToTurret resolution
/// is not handled here (no Rust mirror-pivot resolver yet — the
/// candidate-selection path doesn't use lockOnToTurret today).
#[inline]
fn resolve_candidate_aim_point_from_slab(
    pool: &CombatTargetingPool,
    candidate_id: i32,
    candidate_pos_x: f64,
    candidate_pos_y: f64,
    candidate_pos_z: f64,
    mount_x: f64,
    mount_y: f64,
    mount_z: f64,
) -> (f64, f64, f64) {
    let (hx, hy, hz) = match pool.entity_slot_by_id.get(&candidate_id) {
        Some(&slot) => {
            let i = slot as usize;
            if i < pool.entity_aabb_half_x.len() {
                (
                    pool.entity_aabb_half_x[i],
                    pool.entity_aabb_half_y[i],
                    pool.entity_aabb_half_z[i],
                )
            } else {
                (0.0, 0.0, 0.0)
            }
        }
        None => (0.0, 0.0, 0.0),
    };
    if hx > 0.0 || hy > 0.0 || hz > 0.0 {
        let min_x = candidate_pos_x - hx;
        let max_x = candidate_pos_x + hx;
        let min_y = candidate_pos_y - hy;
        let max_y = candidate_pos_y + hy;
        let min_z = candidate_pos_z - hz;
        let max_z = candidate_pos_z + hz;
        let ax = mount_x.max(min_x).min(max_x);
        let ay = mount_y.max(min_y).min(max_y);
        let az = mount_z.max(min_z).min(max_z);
        if ax == mount_x && ay == mount_y && az == mount_z {
            (candidate_pos_x, candidate_pos_y, candidate_pos_z)
        } else {
            (ax, ay, az)
        }
    } else {
        (candidate_pos_x, candidate_pos_y, candidate_pos_z)
    }
}

/// AIM-08.5 — Rust-internal candidate fire-gate. Replaces the
/// JS `passesWeaponFireGates` callback. Resolves the candidate aim
/// point from the slab AABB, then dispatches to the shared
/// `compute_turret_gates_for_aim_point` helper. Returns 1 if all
/// three gates (LOS, ballistic, FF) pass.
#[inline]
fn combat_targeting_candidate_gate_passes(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    candidate_idx: usize,
    candidate_ids: &[i32],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_count: usize,
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    force_field_obstruction_active: u8,
    gravity: f64,
    projectile_speed: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
) -> bool {
    if candidate_idx >= candidate_count {
        return false;
    }
    let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx);
    let flags = pool.turret_config_flags[idx];
    let mount_x = pool.turret_mount_x[idx];
    let mount_y = pool.turret_mount_y[idx];
    let mount_z = pool.turret_mount_z[idx];

    let candidate_id = candidate_ids[candidate_idx];
    let (aim_x, aim_y, aim_z) = resolve_candidate_aim_point_from_slab(
        pool,
        candidate_id,
        candidate_pos_x[candidate_idx],
        candidate_pos_y[candidate_idx],
        candidate_pos_z[candidate_idx],
        mount_x,
        mount_y,
        mount_z,
    );

    let target_vx = pool
        .entity_slot_by_id
        .get(&candidate_id)
        .and_then(|&s| pool.entity_vel_x.get(s as usize).copied())
        .unwrap_or(0.0);
    let target_vy = pool
        .entity_slot_by_id
        .get(&candidate_id)
        .and_then(|&s| pool.entity_vel_y.get(s as usize).copied())
        .unwrap_or(0.0);
    let target_vz = pool
        .entity_slot_by_id
        .get(&candidate_id)
        .and_then(|&s| pool.entity_vel_z.get(s as usize).copied())
        .unwrap_or(0.0);

    let (los_clear, ballistic_clear, force_field_clear) =
        compute_turret_gates_for_aim_point(
            pool,
            entity_slot,
            turret_idx,
            idx,
            flags,
            mount_x, mount_y, mount_z,
            aim_x, aim_y, aim_z,
            target_vx, target_vy, target_vz,
            candidate_id,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            force_field_obstruction_active,
            projectile_speed,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
            gravity,
        );

    los_clear != 0 && ballistic_clear != 0 && force_field_clear != 0
}

/// AIM-08.5 — batch target candidate scoring/selection + internal
/// fire-gate evaluation for one entity's turrets. Replaces the
/// legacy `combat_targeting_choose_best_candidates_batch` which
/// relied on a JS `gate_fn` callback for the per-(turret, candidate)
/// LOS / ballistic / force-field check. The kernel now resolves
/// candidate aim points from the slab AABB and dispatches to
/// `compute_turret_gates_for_aim_point` inline — same physics as the
/// priority kernels, no per-pair boundary crossing.
///
/// Mirror-panel clearance is consulted via the slab inside
/// `compute_turret_gates_for_aim_point`; JS no longer needs to fill
/// a per-(turret, candidate) clearance mask.
///
/// Per-candidate observability (cloak/detector) is computed
/// internally from slab data — the dedicated scratch global is
/// filled before the per-turret loop and reused across turrets,
/// since the observer player is the same for every turret on this
/// entity.
#[wasm_bindgen]
pub fn combat_targeting_compute_and_choose_best_candidates_batch(
    entity_slot: u32,
    rank_mode: u8,
    minimum_rank: u8,
    apply_mask: &[u8],
    seed_ranks: &[u8],
    seed_dist_sqs: &[f64],
    seed_mirror_scores: &[f64],
    candidate_count: u32,
    candidate_ids: &[i32],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    // Output: per-candidate mirror-target DPS, filled by the kernel
    // from the slab using candidate_ids + source_entity_id. JS no
    // longer needs to populate this — it passes the scratch buffer
    // and reads nothing back. Tuned per-source not per-turret, so
    // one walk per candidate covers every turret on this entity.
    candidate_mirror_score: &mut [f64],
    source_entity_id: i32,
    mirrors_enabled: u8,
    force_fields_enabled: u8,
    force_field_obstruction_active: u8,
    terrain_step_len: f64,
    entity_line_width: f64,
    gravity: f64,
    projectile_speeds: &[f64],
    arc_preferences: &[u8],
    max_time_secs: &[f64],
    ground_aim_fractions: &[f64],
    under_only_mask: &[u8],
    out_target_ids: &mut [i32],
    out_ranks: &mut [u8],
) {
    let pool = combat_targeting_pool();
    let entity_idx = entity_slot as usize;
    if entity_idx >= pool.turret_count_per_entity.len() {
        return;
    }
    let source_player_id = pool.entity_owner_player_id[entity_idx];
    let turret_count = (pool.turret_count_per_entity[entity_idx] as usize)
        .min(COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY as usize)
        .min(apply_mask.len())
        .min(seed_ranks.len())
        .min(seed_dist_sqs.len())
        .min(seed_mirror_scores.len())
        .min(out_target_ids.len())
        .min(out_ranks.len())
        .min(projectile_speeds.len())
        .min(arc_preferences.len())
        .min(max_time_secs.len())
        .min(ground_aim_fractions.len())
        .min(under_only_mask.len());
    let clamped_candidate_count = (candidate_count as usize)
        .min(candidate_ids.len())
        .min(candidate_pos_x.len())
        .min(candidate_pos_y.len())
        .min(candidate_pos_z.len())
        .min(candidate_radius.len())
        .min(candidate_mirror_score.len());
    if turret_count == 0 || clamped_candidate_count == 0 {
        return;
    }
    // We use the existing apply_mask=0 turrets are NOT system-disabled
    // checks in the choose-best path; mirror that here. The JS side
    // already gates apply_mask via `prepareFireChoiceFsmInputs` /
    // `prepareAcquisitionChoiceFsmInputs`, but a belt-and-braces
    // check inside the gate helper keeps disabled/manual-fire
    // turrets from running the LOS+ballistic+FF kernels for free.
    let _ = (mirrors_enabled, force_fields_enabled);

    // Fill per-candidate observability from the slab — same observer
    // (this entity's owner) for every turret on this entity. Stored
    // in the dedicated scratch global so the kernel can pass it as a
    // separate slice while still borrowing the pool mutably for
    // ballistic-solver writes inside the inner gate loop.
    let observable_scratch = combat_targeting_candidate_observable_scratch();
    if observable_scratch.len() < clamped_candidate_count {
        observable_scratch.resize(clamped_candidate_count, 0);
    }
    for ci in 0..clamped_candidate_count {
        let target_id = candidate_ids[ci];
        observable_scratch[ci] =
            combat_targeting_player_observes_entity_id(pool, target_id, source_player_id) as u8;
    }
    let candidate_observable: &[u8] = &observable_scratch[..clamped_candidate_count];

    // Fill per-candidate mirror-target DPS from the slab. Only walks
    // when at least one turret on this entity is passive — non-passive
    // turrets ignore the score (zeroed via `clear` below). Avoids the
    // walk entirely on units with no mirror turrets.
    let mut any_passive = false;
    for turret_idx in 0..turret_count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }
        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        if (pool.turret_config_flags[idx] & CT_TURRET_CFG_PASSIVE) != 0 {
            any_passive = true;
            break;
        }
    }
    if any_passive {
        for ci in 0..clamped_candidate_count {
            if candidate_observable[ci] == 0 {
                candidate_mirror_score[ci] = 0.0;
                continue;
            }
            let target_id = candidate_ids[ci];
            candidate_mirror_score[ci] = match pool.entity_slot_by_id.get(&target_id) {
                Some(&slot) => combat_targeting_mirror_target_score_for_slot(
                    pool,
                    slot as usize,
                    source_entity_id,
                ),
                None => 0.0,
            };
        }
    } else {
        for ci in 0..clamped_candidate_count {
            candidate_mirror_score[ci] = 0.0;
        }
    }

    for turret_idx in 0..turret_count {
        if apply_mask[turret_idx] == 0 {
            continue;
        }

        out_target_ids[turret_idx] = -1;
        out_ranks[turret_idx] = seed_ranks[turret_idx];

        let idx = combat_targeting_turret_global_idx(entity_slot, turret_idx as u32);
        let flags = pool.turret_config_flags[idx];
        let has_fire_min = if pool.turret_fire_min_acquire_sq[idx] > 0.0 {
            1
        } else {
            0
        };
        let has_tracking = if (flags & CT_TURRET_CFG_HAS_TRACKING_RANGE) != 0 {
            1
        } else {
            0
        };
        let is_passive = if (flags & CT_TURRET_CFG_PASSIVE) != 0 {
            1
        } else {
            0
        };

        let projectile_speed = projectile_speeds[turret_idx];
        let arc_preference = arc_preferences[turret_idx];
        let max_time_sec = max_time_secs[turret_idx];
        let ground_aim_fraction = ground_aim_fractions[turret_idx];
        let under_only = under_only_mask[turret_idx] != 0;

        let choice = combat_targeting_choose_best_candidate_inner_with_internal_gate(
            pool,
            entity_slot,
            turret_idx as u32,
            pool.turret_mount_x[idx],
            pool.turret_mount_y[idx],
            pool.turret_mount_z[idx],
            pool.turret_fire_max_acquire_sq[idx].sqrt(),
            pool.turret_fire_max_release_sq[idx].sqrt(),
            has_fire_min,
            pool.turret_fire_min_acquire_sq[idx].sqrt(),
            pool.turret_fire_min_release_sq[idx].sqrt(),
            has_tracking,
            pool.turret_tracking_acquire_sq[idx].sqrt(),
            pool.turret_tracking_release_sq[idx].sqrt(),
            rank_mode,
            minimum_rank,
            seed_ranks[turret_idx],
            seed_dist_sqs[turret_idx],
            seed_mirror_scores[turret_idx],
            is_passive,
            clamped_candidate_count as u32,
            candidate_ids,
            candidate_observable,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            candidate_radius,
            candidate_mirror_score,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            force_field_obstruction_active,
            gravity,
            projectile_speed,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        );
        let candidate_idx = choice.candidate_idx;
        if candidate_idx >= 0 {
            let candidate_idx = candidate_idx as usize;
            if candidate_idx < candidate_ids.len() {
                out_target_ids[turret_idx] = candidate_ids[candidate_idx];
                out_ranks[turret_idx] = choice.rank;
            }
        }
    }
}

/// Same shape as `combat_targeting_choose_best_candidate_inner` but
/// resolves the fire-gate inline by calling
/// `combat_targeting_candidate_gate_passes` instead of crossing the
/// JS boundary. Takes the pool by `&mut` so the inline ballistic solver
/// can write its scratch slot back to the slab; the choose-best logic
/// is otherwise identical to the legacy path.
fn combat_targeting_choose_best_candidate_inner_with_internal_gate(
    pool: &mut CombatTargetingPool,
    entity_slot: u32,
    turret_idx: u32,
    weapon_x: f64,
    weapon_y: f64,
    weapon_z: f64,
    fire_max_acquire: f64,
    fire_max_release: f64,
    has_fire_min: u8,
    fire_min_acquire: f64,
    fire_min_release: f64,
    has_tracking: u8,
    tracking_acquire: f64,
    tracking_release: f64,
    rank_mode: u8,
    minimum_rank: u8,
    seed_rank: u8,
    seed_dist_sq: f64,
    seed_mirror_score: f64,
    is_passive: u8,
    candidate_count: u32,
    candidate_ids: &[i32],
    candidate_observable: &[u8],
    candidate_pos_x: &[f64],
    candidate_pos_y: &[f64],
    candidate_pos_z: &[f64],
    candidate_radius: &[f64],
    candidate_mirror_score: &[f64],
    source_entity_id: i32,
    terrain_step_len: f64,
    entity_line_width: f64,
    force_field_obstruction_active: u8,
    gravity: f64,
    projectile_speed: f64,
    arc_preference: u8,
    max_time_sec: f64,
    ground_aim_fraction: f64,
    under_only: bool,
) -> TargetingCandidateChoice {
    let seed = targeting_seed_choice(seed_rank);
    let count = (candidate_count as usize)
        .min(candidate_observable.len())
        .min(candidate_pos_x.len())
        .min(candidate_pos_y.len())
        .min(candidate_pos_z.len())
        .min(candidate_radius.len())
        .min(candidate_mirror_score.len())
        .min(candidate_ids.len());
    if count == 0 {
        return seed;
    }

    let mut top_candidate_idx = [-1i32; TARGETING_TOPK_LOS];
    let mut top_rank = [CT_TARGET_RANK_NONE; TARGETING_TOPK_LOS];
    let mut top_dist_sq = [0.0f64; TARGETING_TOPK_LOS];
    let mut top_mirror_score = [0.0f64; TARGETING_TOPK_LOS];
    let mut top_count = 0usize;

    for ci in 0..count {
        let Some((rank, dist_sq, mirror_score)) = targeting_score_candidate(
            ci,
            weapon_x,
            weapon_y,
            weapon_z,
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            has_tracking,
            tracking_acquire,
            tracking_release,
            rank_mode,
            minimum_rank,
            seed_rank,
            seed_dist_sq,
            seed_mirror_score,
            is_passive,
            candidate_observable,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            candidate_radius,
            candidate_mirror_score,
        ) else {
            continue;
        };

        let insert_idx: usize;
        if top_count < TARGETING_TOPK_LOS {
            insert_idx = top_count;
            top_count += 1;
        } else {
            let last = top_count - 1;
            if !targeting_pool_entry_is_better(
                is_passive,
                rank,
                dist_sq,
                mirror_score,
                top_rank[last],
                top_dist_sq[last],
                top_mirror_score[last],
            ) {
                continue;
            }
            insert_idx = last;
        }

        top_candidate_idx[insert_idx] = ci as i32;
        top_rank[insert_idx] = rank;
        top_dist_sq[insert_idx] = dist_sq;
        top_mirror_score[insert_idx] = mirror_score;

        let mut i = insert_idx;
        while i > 0 {
            let j = i - 1;
            let better = targeting_pool_entry_is_better(
                is_passive,
                top_rank[i],
                top_dist_sq[i],
                top_mirror_score[i],
                top_rank[j],
                top_dist_sq[j],
                top_mirror_score[j],
            );
            if !better {
                break;
            }
            top_candidate_idx.swap(i, j);
            top_rank.swap(i, j);
            top_dist_sq.swap(i, j);
            top_mirror_score.swap(i, j);
            i = j;
        }
    }

    for k in 0..top_count {
        let candidate_idx = top_candidate_idx[k];
        if candidate_idx < 0 {
            continue;
        }
        let ci = candidate_idx as usize;
        if combat_targeting_candidate_gate_passes(
            pool,
            entity_slot,
            turret_idx,
            ci,
            candidate_ids,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            count,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            force_field_obstruction_active,
            gravity,
            projectile_speed,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) {
            return TargetingCandidateChoice {
                candidate_idx,
                rank: top_rank[k],
            };
        }
    }

    if top_count == 0 {
        return seed;
    }

    let mut fallback_budget = TARGETING_FALLBACK_LOS_BUDGET;
    for ci in 0..count {
        if fallback_budget == 0 {
            break;
        }
        let mut in_top_k = false;
        for k in 0..top_count {
            if top_candidate_idx[k] == ci as i32 {
                in_top_k = true;
                break;
            }
        }
        if in_top_k {
            continue;
        }

        let Some((rank, _dist_sq, _mirror_score)) = targeting_score_candidate(
            ci,
            weapon_x,
            weapon_y,
            weapon_z,
            fire_max_acquire,
            fire_max_release,
            has_fire_min,
            fire_min_acquire,
            fire_min_release,
            has_tracking,
            tracking_acquire,
            tracking_release,
            rank_mode,
            minimum_rank,
            seed_rank,
            seed_dist_sq,
            seed_mirror_score,
            is_passive,
            candidate_observable,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            candidate_radius,
            candidate_mirror_score,
        ) else {
            continue;
        };

        fallback_budget -= 1;
        if combat_targeting_candidate_gate_passes(
            pool,
            entity_slot,
            turret_idx,
            ci,
            candidate_ids,
            candidate_pos_x,
            candidate_pos_y,
            candidate_pos_z,
            count,
            source_entity_id,
            terrain_step_len,
            entity_line_width,
            force_field_obstruction_active,
            gravity,
            projectile_speed,
            arc_preference,
            max_time_sec,
            ground_aim_fraction,
            under_only,
        ) {
            return TargetingCandidateChoice {
                candidate_idx: ci as i32,
                rank,
            };
        }
    }

    seed
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.1 — Force field input slab
//
// Compact list of `count` active force fields, rebuilt from scratch
// each tick from the JS-side getActiveForceFields(). Owner entity id
// is the entity that emits the field (sentinel -1 if not tied to one).
// ─────────────────────────────────────────────────────────────────

struct ForceFieldPool {
    count: u32,
    id: Vec<i32>,
    owner_entity_id: Vec<i32>,
    center_x: Vec<f64>,
    center_y: Vec<f64>,
    center_z: Vec<f64>,
    radius: Vec<f64>,
}

impl ForceFieldPool {
    fn empty() -> Self {
        Self {
            count: 0,
            id: Vec::new(),
            owner_entity_id: Vec::new(),
            center_x: Vec::new(),
            center_y: Vec::new(),
            center_z: Vec::new(),
            radius: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.id.len() < needed {
            self.id.resize(needed, -1);
            self.owner_entity_id.resize(needed, -1);
            self.center_x.resize(needed, 0.0);
            self.center_y.resize(needed, 0.0);
            self.center_z.resize(needed, 0.0);
            self.radius.resize(needed, 0.0);
        }
    }
}

struct ForceFieldPoolHolder(UnsafeCell<Option<ForceFieldPool>>);
unsafe impl Sync for ForceFieldPoolHolder {}
static FORCE_FIELD_POOL: ForceFieldPoolHolder = ForceFieldPoolHolder(UnsafeCell::new(None));

#[inline]
fn force_field_pool() -> &'static mut ForceFieldPool {
    unsafe {
        let cell = &mut *FORCE_FIELD_POOL.0.get();
        if cell.is_none() {
            *cell = Some(ForceFieldPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn force_field_pool_clear() {
    force_field_pool().count = 0;
}

#[wasm_bindgen]
pub fn force_field_pool_count() -> u32 {
    force_field_pool().count
}

#[wasm_bindgen]
pub fn force_field_pool_set_count(count: u32) {
    let pool = force_field_pool();
    pool.ensure_capacity(count);
    pool.count = count;
}

#[wasm_bindgen]
pub fn force_field_pool_set_field(
    idx: u32,
    id: i32,
    owner_entity_id: i32,
    center_x: f64,
    center_y: f64,
    center_z: f64,
    radius: f64,
) {
    let pool = force_field_pool();
    pool.ensure_capacity(idx + 1);
    let i = idx as usize;
    pool.id[i] = id;
    pool.owner_entity_id[i] = owner_entity_id;
    pool.center_x[i] = center_x;
    pool.center_y[i] = center_y;
    pool.center_z[i] = center_z;
    pool.radius[i] = radius;
}

macro_rules! force_field_pool_ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        #[wasm_bindgen]
        pub fn $name() -> *const $ty {
            force_field_pool().$field.as_ptr()
        }
    };
}

force_field_pool_ptr_export!(force_field_pool_id_ptr, id, i32);
force_field_pool_ptr_export!(force_field_pool_owner_entity_id_ptr, owner_entity_id, i32);
force_field_pool_ptr_export!(force_field_pool_center_x_ptr, center_x, f64);
force_field_pool_ptr_export!(force_field_pool_center_y_ptr, center_y, f64);
force_field_pool_ptr_export!(force_field_pool_center_z_ptr, center_z, f64);
force_field_pool_ptr_export!(force_field_pool_radius_ptr, radius, f64);

// ─────────────────────────────────────────────────────────────────
// AIM-08.2 — Force field clearance kernels.
//
// Both kernels read the FORCE_FIELD_POOL slab rebuilt per tick by the
// JS-side stampForceFieldPool pass. They replace the JS-side
// hasForceFieldClearance / hasArcForceFieldClearance in
// lineOfSight.ts; the JS wrappers are now thin dispatchers.
//
// `exclude_owner_entity_id` is a legacy per-call exemption hook. The
// current OBSTRUCT SIGHT path passes sentinel -1 so every active boundary is
// considered, including a shooter's own field.
//
// Graze epsilon: crossings within FORCE_FIELD_GRAZE_EPS of the segment
// endpoints don't count, matching the JS path's behaviour so a turret
// or target sitting on a shield edge doesn't flicker between locked
// and unlocked.
// ─────────────────────────────────────────────────────────────────

const FORCE_FIELD_GRAZE_EPS: f64 = 1e-6;
const ARC_FF_CLEARANCE_SAMPLES: u32 = 16;

#[inline]
fn force_field_segment_crosses_sphere(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    r: f64,
    lo: f64,
    hi: f64,
) -> bool {
    if sx.max(tx) < cx - r || sx.min(tx) > cx + r {
        return false;
    }
    if sy.max(ty) < cy - r || sy.min(ty) > cy + r {
        return false;
    }
    if sz.max(tz) < cz - r || sz.min(tz) > cz + r {
        return false;
    }
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let a = dx * dx + dy * dy + dz * dz;
    if a < 1e-9 {
        return false;
    }
    let fx = sx - cx;
    let fy = sy - cy;
    let fz = sz - cz;
    let b = 2.0 * (fx * dx + fy * dy + fz * dz);
    let c = fx * fx + fy * fy + fz * fz - r * r;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return false;
    }
    let sqrt_disc = disc.sqrt();
    let inv_denom = 1.0 / (2.0 * a);
    let t1 = (-b - sqrt_disc) * inv_denom;
    let t2 = (-b + sqrt_disc) * inv_denom;
    (t1 > lo && t1 < hi) || (t2 > lo && t2 < hi)
}

/// Direct-segment force-field clearance. Returns 1 if the segment
/// (sx, sy, sz) → (tx, ty, tz) crosses at most `max_crossings` field
/// sphere boundaries, 0 otherwise. Endpoint grazes (within
/// FORCE_FIELD_GRAZE_EPS) don't count.
#[wasm_bindgen]
pub fn force_field_clearance_segment(
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
) -> u32 {
    let pool = force_field_pool();
    let count = pool.count as usize;
    if count == 0 {
        return 1;
    }
    let lo = FORCE_FIELD_GRAZE_EPS;
    let hi = 1.0 - FORCE_FIELD_GRAZE_EPS;
    let mut crossings: u32 = 0;
    for i in 0..count {
        if pool.owner_entity_id[i] == exclude_owner_entity_id {
            continue;
        }
        if force_field_segment_crosses_sphere(
            sx,
            sy,
            sz,
            tx,
            ty,
            tz,
            pool.center_x[i],
            pool.center_y[i],
            pool.center_z[i],
            pool.radius[i],
            lo,
            hi,
        ) {
            crossings += 1;
            if crossings > max_crossings {
                return 0;
            }
        }
    }
    1
}

/// Ballistic-arc force-field clearance. Approximates the parabola
/// `pos = launch + v·t − 0.5·GRAVITY·ẑ·t²` with
/// ARC_FF_CLEARANCE_SAMPLES chords and reports the same boundary-
/// crossing budget as the segment kernel. Staying inside one field for
/// the whole arc is clear; only crossing a boundary is blocked.
#[wasm_bindgen]
pub fn force_field_clearance_arc(
    launch_x: f64,
    launch_y: f64,
    launch_z: f64,
    launch_vx: f64,
    launch_vy: f64,
    launch_vz: f64,
    flight_time: f64,
    exclude_owner_entity_id: i32,
    max_crossings: u32,
) -> u32 {
    let pool = force_field_pool();
    let count = pool.count as usize;
    if count == 0 {
        return 1;
    }
    if !flight_time.is_finite() || flight_time <= 0.0 {
        return 1;
    }
    let inv_n = 1.0 / ARC_FF_CLEARANCE_SAMPLES as f64;
    let mut crossings: u32 = 0;
    for f in 0..count {
        if pool.owner_entity_id[f] == exclude_owner_entity_id {
            continue;
        }
        let cx = pool.center_x[f];
        let cy = pool.center_y[f];
        let cz = pool.center_z[f];
        let r = pool.radius[f];
        let mut crossed = false;
        let mut prev_x = launch_x;
        let mut prev_y = launch_y;
        let mut prev_z = launch_z;
        for i in 1..=ARC_FF_CLEARANCE_SAMPLES {
            let t_norm = i as f64 * inv_n;
            let t = t_norm * flight_time;
            let x = launch_x + launch_vx * t;
            let y = launch_y + launch_vy * t;
            let z = launch_z + launch_vz * t - 0.5 * GRAVITY * t * t;
            let lo = if i == 1 {
                FORCE_FIELD_GRAZE_EPS
            } else {
                -FORCE_FIELD_GRAZE_EPS
            };
            let hi = if i == ARC_FF_CLEARANCE_SAMPLES {
                1.0 - FORCE_FIELD_GRAZE_EPS
            } else {
                1.0 + FORCE_FIELD_GRAZE_EPS
            };
            if force_field_segment_crosses_sphere(
                prev_x, prev_y, prev_z, x, y, z, cx, cy, cz, r, lo, hi,
            ) {
                crossed = true;
                break;
            }
            prev_x = x;
            prev_y = y;
            prev_z = z;
        }
        if crossed {
            crossings += 1;
            if crossings > max_crossings {
                return 0;
            }
        }
    }
    1
}

// ─────────────────────────────────────────────────────────────────
// AIM-08.5 — Mirror panel input slab
//
// Two parallel pools rebuilt each tick (analogous to ForceFieldPool):
//
//   Per-mirror-unit data: world pose, broadphase radius, slope-aware
//   mirror turret pivot, and a [panel_start, panel_count) range into
//   the per-panel data.
//
//   Per-panel data: panel geometry (arm length, lateral offset, panel
//   yaw offset, base/top Y in chassis-local space, half-width).
//
// The kernel walks every unit's broadphase first, then dispatches to
// the per-panel ray-tilted-rect test for each panel. Crossings within
// FORCE_MATERIAL_GRAZE_EPS of either segment endpoint don't count,
// matching the JS-side `hasForceMirrorPanelClearance` behaviour so
// turret pose and lock-on point flicker the same way regardless of
// which path computed the gate.
// ─────────────────────────────────────────────────────────────────

const FORCE_MATERIAL_GRAZE_EPS: f64 = 1e-6;

struct MirrorPanelPool {
    // Per-mirror-unit fields. Counts are tracked separately so the
    // backing Vecs can be reused across ticks; the kernel reads only
    // `unit_count` rows.
    unit_count: u32,
    unit_id: Vec<i32>,
    unit_x: Vec<f64>,
    unit_y: Vec<f64>,
    unit_z: Vec<f64>,
    unit_ground_z: Vec<f64>,
    unit_broad_radius: Vec<f32>,
    mirror_yaw: Vec<f32>,
    mirror_pitch: Vec<f32>,
    pivot_x: Vec<f64>,
    pivot_y: Vec<f64>,
    pivot_z: Vec<f64>,
    panel_start: Vec<u32>,
    panel_count: Vec<u8>,

    // Per-panel fields.
    total_panels: u32,
    panel_arm_length: Vec<f32>,
    panel_offset_y: Vec<f32>,
    panel_angle: Vec<f32>,
    panel_base_y: Vec<f32>,
    panel_top_y: Vec<f32>,
    panel_half_width: Vec<f32>,
}

impl MirrorPanelPool {
    fn empty() -> Self {
        Self {
            unit_count: 0,
            unit_id: Vec::new(),
            unit_x: Vec::new(),
            unit_y: Vec::new(),
            unit_z: Vec::new(),
            unit_ground_z: Vec::new(),
            unit_broad_radius: Vec::new(),
            mirror_yaw: Vec::new(),
            mirror_pitch: Vec::new(),
            pivot_x: Vec::new(),
            pivot_y: Vec::new(),
            pivot_z: Vec::new(),
            panel_start: Vec::new(),
            panel_count: Vec::new(),
            total_panels: 0,
            panel_arm_length: Vec::new(),
            panel_offset_y: Vec::new(),
            panel_angle: Vec::new(),
            panel_base_y: Vec::new(),
            panel_top_y: Vec::new(),
            panel_half_width: Vec::new(),
        }
    }

    fn ensure_unit_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.unit_id.len() < needed {
            self.unit_id.resize(needed, -1);
            self.unit_x.resize(needed, 0.0);
            self.unit_y.resize(needed, 0.0);
            self.unit_z.resize(needed, 0.0);
            self.unit_ground_z.resize(needed, 0.0);
            self.unit_broad_radius.resize(needed, 0.0);
            self.mirror_yaw.resize(needed, 0.0);
            self.mirror_pitch.resize(needed, 0.0);
            self.pivot_x.resize(needed, 0.0);
            self.pivot_y.resize(needed, 0.0);
            self.pivot_z.resize(needed, 0.0);
            self.panel_start.resize(needed, 0);
            self.panel_count.resize(needed, 0);
        }
    }

    fn ensure_panel_capacity(&mut self, count: u32) {
        let needed = count as usize;
        if self.panel_arm_length.len() < needed {
            self.panel_arm_length.resize(needed, 0.0);
            self.panel_offset_y.resize(needed, 0.0);
            self.panel_angle.resize(needed, 0.0);
            self.panel_base_y.resize(needed, 0.0);
            self.panel_top_y.resize(needed, 0.0);
            self.panel_half_width.resize(needed, 0.0);
        }
    }
}

struct MirrorPanelPoolHolder(UnsafeCell<Option<MirrorPanelPool>>);
unsafe impl Sync for MirrorPanelPoolHolder {}
static MIRROR_PANEL_POOL: MirrorPanelPoolHolder = MirrorPanelPoolHolder(UnsafeCell::new(None));

#[inline]
fn mirror_panel_pool() -> &'static mut MirrorPanelPool {
    unsafe {
        let cell = &mut *MIRROR_PANEL_POOL.0.get();
        if cell.is_none() {
            *cell = Some(MirrorPanelPool::empty());
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn mirror_panel_pool_clear() {
    let pool = mirror_panel_pool();
    pool.unit_count = 0;
    pool.total_panels = 0;
}

#[wasm_bindgen]
pub fn mirror_panel_pool_set_unit_count(count: u32) {
    let pool = mirror_panel_pool();
    pool.ensure_unit_capacity(count);
    pool.unit_count = count;
}

#[wasm_bindgen]
pub fn mirror_panel_pool_set_panel_count(count: u32) {
    let pool = mirror_panel_pool();
    pool.ensure_panel_capacity(count);
    pool.total_panels = count;
}

#[wasm_bindgen]
pub fn mirror_panel_pool_set_unit(
    idx: u32,
    unit_id: i32,
    unit_x: f64,
    unit_y: f64,
    unit_z: f64,
    unit_ground_z: f64,
    unit_broad_radius: f32,
    mirror_yaw: f32,
    mirror_pitch: f32,
    pivot_x: f64,
    pivot_y: f64,
    pivot_z: f64,
    panel_start: u32,
    panel_count: u8,
) {
    let pool = mirror_panel_pool();
    pool.ensure_unit_capacity(idx + 1);
    let i = idx as usize;
    pool.unit_id[i] = unit_id;
    pool.unit_x[i] = unit_x;
    pool.unit_y[i] = unit_y;
    pool.unit_z[i] = unit_z;
    pool.unit_ground_z[i] = unit_ground_z;
    pool.unit_broad_radius[i] = unit_broad_radius;
    pool.mirror_yaw[i] = mirror_yaw;
    pool.mirror_pitch[i] = mirror_pitch;
    pool.pivot_x[i] = pivot_x;
    pool.pivot_y[i] = pivot_y;
    pool.pivot_z[i] = pivot_z;
    pool.panel_start[i] = panel_start;
    pool.panel_count[i] = panel_count;
}

#[wasm_bindgen]
pub fn mirror_panel_pool_set_panel(
    idx: u32,
    arm_length: f32,
    offset_y: f32,
    panel_angle: f32,
    base_y: f32,
    top_y: f32,
    half_width: f32,
) {
    let pool = mirror_panel_pool();
    pool.ensure_panel_capacity(idx + 1);
    let i = idx as usize;
    pool.panel_arm_length[i] = arm_length;
    pool.panel_offset_y[i] = offset_y;
    pool.panel_angle[i] = panel_angle;
    pool.panel_base_y[i] = base_y;
    pool.panel_top_y[i] = top_y;
    pool.panel_half_width[i] = half_width;
}

/// Squared distance from a point to a 3D segment, used by the
/// mirror-panel broadphase. Mirrors `pointSegmentDistanceSq3` in
/// lineOfSight.ts byte-for-byte.
#[inline]
fn point_segment_dist_sq3(
    px: f64, py: f64, pz: f64,
    ax: f64, ay: f64, az: f64,
    bx: f64, by: f64, bz: f64,
) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let len_sq = abx * abx + aby * aby + abz * abz;
    if len_sq <= 1e-9 {
        let dx = px - ax;
        let dy = py - ay;
        let dz = pz - az;
        return dx * dx + dy * dy + dz * dz;
    }
    let t = (((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len_sq)
        .max(0.0)
        .min(1.0);
    let cx = ax + abx * t;
    let cy = ay + aby * t;
    let cz = az + abz * t;
    let dx = px - cx;
    let dy = py - cy;
    let dz = pz - cz;
    dx * dx + dy * dy + dz * dz
}

/// Ray-vs-tilted-rectangle intersection T (CollisionHelpers.ts port).
/// Returns `Some(t)` in [0, 1] for the first hit, or `None`.
#[inline]
fn ray_tilted_rect_intersection_t(
    sx: f64, sy: f64, sz: f64,
    ex: f64, ey: f64, ez: f64,
    pcx: f64, pcy: f64, pcz: f64,
    nx: f64, ny: f64, nz: f64,
    edx: f64, edy: f64, edz: f64,
    half_w: f64,
    half_h: f64,
) -> Option<f64> {
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    let denom = dx * nx + dy * ny + dz * nz;
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = ((pcx - sx) * nx + (pcy - sy) * ny + (pcz - sz) * nz) / denom;
    if !(0.0..=1.0).contains(&t) {
        return None;
    }
    let hx = sx + t * dx;
    let hy = sy + t * dy;
    let hz = sz + t * dz;
    let lx = hx - pcx;
    let ly = hy - pcy;
    let lz = hz - pcz;
    let along = lx * edx + ly * edy + lz * edz;
    if along < -half_w || along > half_w {
        return None;
    }
    // up-in-plane axis = n × ed
    let ux = ny * edz - nz * edy;
    let uy = nz * edx - nx * edz;
    let uz = nx * edy - ny * edx;
    let up = lx * ux + ly * uy + lz * uz;
    if up < -half_h || up > half_h {
        return None;
    }
    Some(t)
}

/// AIM-08.5 — slab-backed port of `hasForceMirrorPanelClearance`.
/// Returns 1 when the straight sightline from (sx,sy,sz) → (tx,ty,tz)
/// does not cross any active force-mirror panel; 0 when at least one
/// panel blocks the segment. Hits within FORCE_MATERIAL_GRAZE_EPS of
/// either endpoint don't count (matching the JS path).
fn mirror_panel_clearance_segment(
    sx: f64, sy: f64, sz: f64,
    tx: f64, ty: f64, tz: f64,
) -> u8 {
    let pool = mirror_panel_pool();
    let unit_count = pool.unit_count as usize;
    if unit_count == 0 {
        return 1;
    }
    for u in 0..unit_count {
        let panel_count = pool.panel_count[u] as usize;
        if panel_count == 0 {
            continue;
        }
        let ux = pool.unit_x[u];
        let uy = pool.unit_y[u];
        let uz = pool.unit_z[u];
        let broad_r = pool.unit_broad_radius[u] as f64;
        if point_segment_dist_sq3(ux, uy, uz, sx, sy, sz, tx, ty, tz) > broad_r * broad_r {
            continue;
        }

        let mirror_yaw = pool.mirror_yaw[u] as f64;
        let mirror_pitch = pool.mirror_pitch[u] as f64;
        let cos_yaw = mirror_yaw.cos();
        let sin_yaw = mirror_yaw.sin();
        let cos_pitch = mirror_pitch.cos();
        let sin_pitch = mirror_pitch.sin();

        let pivot_x = pool.pivot_x[u];
        let pivot_y = pool.pivot_y[u];
        let pivot_z = pool.pivot_z[u];

        let panel_start = pool.panel_start[u] as usize;
        for pi in panel_start..panel_start + panel_count {
            // Panel arm extends from pivot along the panel-yaw / pitch
            // direction (same `a(α, β)` formula MirrorPanelHit.ts uses).
            // Per-panel lateral pivot offset goes along the chassis-
            // perpendicular axis, derived from the mirror's yaw on
            // tick (matches JS `perpX = -sinRot; perpY = cosRot`).
            let perp_x = -sin_yaw;
            let perp_y = cos_yaw;
            let offset_y = pool.panel_offset_y[pi] as f64;
            let panel_pivot_x = pivot_x + perp_x * offset_y;
            let panel_pivot_y = pivot_y + perp_y * offset_y;
            let panel_pivot_z = pivot_z;

            // Per-panel yaw composes the mirror turret yaw with the
            // panel's authored angle (typically 0).
            let panel_angle = pool.panel_angle[pi] as f64;
            let panel_yaw = mirror_yaw + panel_angle;
            let panel_cos_yaw = panel_yaw.cos();
            let panel_sin_yaw = panel_yaw.sin();

            let arm_length = pool.panel_arm_length[pi] as f64;
            let pcx = panel_pivot_x + cos_yaw * cos_pitch * arm_length;
            let pcy = panel_pivot_y + sin_yaw * cos_pitch * arm_length;
            let pcz = panel_pivot_z + sin_pitch * arm_length;

            // Panel face normal = arm direction. Using the panel's
            // composed yaw + the mirror pitch matches getMirrorArmDirection.
            let nx = panel_cos_yaw * cos_pitch;
            let ny = panel_sin_yaw * cos_pitch;
            let nz = sin_pitch;

            // Horizontal perpendicular to panel yaw (edge axis); pitch
            // rotates around this axis so it stays in the XY plane.
            let edx = -panel_sin_yaw;
            let edy = panel_cos_yaw;
            let edz = 0.0;

            let half_w = pool.panel_half_width[pi] as f64;
            let base_y = pool.panel_base_y[pi] as f64;
            let top_y = pool.panel_top_y[pi] as f64;
            let half_h = (top_y - base_y) * 0.5;

            let hit_t = ray_tilted_rect_intersection_t(
                sx, sy, sz, tx, ty, tz,
                pcx, pcy, pcz,
                nx, ny, nz,
                edx, edy, edz,
                half_w, half_h,
            );
            if let Some(t) = hit_t {
                if t > FORCE_MATERIAL_GRAZE_EPS && t < 1.0 - FORCE_MATERIAL_GRAZE_EPS {
                    return 0;
                }
            }
        }
    }
    1
}

/// JS-callable mirror-panel sightline clearance probe. Mirrors
/// `force_field_clearance_segment` for callers that want the slab
/// answer without going through the unified gate kernel.
#[wasm_bindgen]
pub fn mirror_panel_clearance_segment_export(
    sx: f64, sy: f64, sz: f64,
    tx: f64, ty: f64, tz: f64,
) -> u8 {
    mirror_panel_clearance_segment(sx, sy, sz, tx, ty, tz)
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
    x: Vec<f64>,
    y: Vec<f64>,
    z: Vec<f64>,
    rotation: Vec<f64>,
    velocity_x: Vec<f64>,
    velocity_y: Vec<f64>,
    velocity_z: Vec<f64>,
    movement_accel_x: Vec<f64>,
    movement_accel_y: Vec<f64>,
    movement_accel_z: Vec<f64>,
    hp: Vec<f32>,
    action_count: Vec<u16>,
    action_hash: Vec<u32>,
    is_engaged_bits: Vec<u32>,
    target_bits: Vec<u32>,
    weapon_count: Vec<u8>,
    turret_rots: Vec<f32>,
    turret_ang_vels: Vec<f32>,
    turret_pitches: Vec<f32>,
    // Per-turret pitch velocity baseline. Compared with rot_vel_threshold
    // so pitch-only motion (and zero-edge transitions) dirties the turret
    // independently from yaw velocity.
    turret_pitch_vels: Vec<f32>,
    // Per-turret target ID baseline (-1 = no target). Replaces the
    // target_bits aggregate as the source of truth for "target switched":
    // a same-presence A→B switch with both IDs non-null is invisible to
    // the bitmask but must still dirty the turret.
    turret_target_ids: Vec<i32>,
    force_field_ranges: Vec<f32>,
    normal_x: Vec<f64>,
    normal_y: Vec<f64>,
    normal_z: Vec<f64>,
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
            x: Vec::new(),
            y: Vec::new(),
            z: Vec::new(),
            rotation: Vec::new(),
            velocity_x: Vec::new(),
            velocity_y: Vec::new(),
            velocity_z: Vec::new(),
            movement_accel_x: Vec::new(),
            movement_accel_y: Vec::new(),
            movement_accel_z: Vec::new(),
            hp: Vec::new(),
            action_count: Vec::new(),
            action_hash: Vec::new(),
            is_engaged_bits: Vec::new(),
            target_bits: Vec::new(),
            weapon_count: Vec::new(),
            turret_rots: Vec::new(),
            turret_ang_vels: Vec::new(),
            turret_pitches: Vec::new(),
            turret_pitch_vels: Vec::new(),
            turret_target_ids: Vec::new(),
            force_field_ranges: Vec::new(),
            normal_x: Vec::new(),
            normal_y: Vec::new(),
            normal_z: Vec::new(),
            build_progress: Vec::new(),
            solar_open: Vec::new(),
            factory_progress: Vec::new(),
            is_producing: Vec::new(),
            build_queue_len: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, slot: u32) {
        let needed = (slot as usize) + 1;
        if self.used.len() >= needed {
            return;
        }
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
        self.turret_pitch_vels.resize(turret_needed, 0.0);
        self.turret_target_ids.resize(turret_needed, -1);
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
        if s >= self.used.len() {
            return;
        }
        self.used[s] = 0;
    }

    fn clear(&mut self) {
        for u in self.used.iter_mut() {
            *u = 0;
        }
    }
}

struct SnapshotBaselineRegistry {
    baselines: Vec<Option<SnapshotBaseline>>,
    free_list: Vec<u32>,
}

impl SnapshotBaselineRegistry {
    fn new() -> Self {
        Self {
            baselines: Vec::new(),
            free_list: Vec::new(),
        }
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
        if h >= self.baselines.len() {
            return;
        }
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
// (turrets, build/factory/solar state, suspension) come from the
// already-populated entity-meta + turret pools.

#[wasm_bindgen]
pub fn snapshot_baseline_capture_unit_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    changed_fields: u32,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    velocity_x: f64,
    velocity_y: f64,
    velocity_z: f64,
    movement_accel_x: f64,
    movement_accel_y: f64,
    movement_accel_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    action_count: u16,
    action_hash: u32,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return;
    };
    b.ensure_capacity(slot);
    let s = slot as usize;
    let is_full = b.used[s] == 0 || changed_fields == SNAPSHOT_BASELINE_CAPTURE_FULL;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        b.x[s] = x;
        b.y[s] = y;
        b.z[s] = z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        b.rotation[s] = rotation;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_VEL) != 0 {
        b.velocity_x[s] = velocity_x;
        b.velocity_y[s] = velocity_y;
        b.velocity_z[s] = velocity_z;
        b.movement_accel_x[s] = movement_accel_x;
        b.movement_accel_y[s] = movement_accel_y;
        b.movement_accel_z[s] = movement_accel_z;
    }
    if is_full || (changed_fields & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL)) != 0 {
        b.normal_x[s] = normal_x;
        b.normal_y[s] = normal_y;
        b.normal_z[s] = normal_z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ACTIONS) != 0 {
        b.action_count[s] = action_count;
        b.action_hash[s] = action_hash;
    }

    // HP + build/suspension from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        if is_full || (changed_fields & ENTITY_CHANGED_HP) != 0 {
            b.hp[s] = meta.hp_curr[s];
        }
        if is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0 {
            b.build_progress[s] = if s < meta.build_progress.len() {
                meta.build_progress[s]
            } else {
                0.0
            };
        }
    }

    // Turret state from the turret pool.
    if is_full || (changed_fields & ENTITY_CHANGED_TURRETS) != 0 {
        b.is_engaged_bits[s] = is_engaged_bits;
        b.target_bits[s] = target_bits;
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
                b.turret_pitch_vels[dst] = turret.pitch_velocity[src];
                b.turret_target_ids[dst] = turret.target_id[src];
                b.force_field_ranges[dst] = turret.force_field_range[src];
            }
        } else {
            b.weapon_count[s] = 0;
        }
    }
}

#[wasm_bindgen]
pub fn snapshot_baseline_capture_building_slot(
    handle: u32,
    slot: u32,
    tick: u32,
    changed_fields: u32,
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    is_engaged_bits: u32,
    target_bits: u32,
) {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return;
    };
    b.ensure_capacity(slot);
    let s = slot as usize;
    let is_full = b.used[s] == 0 || changed_fields == SNAPSHOT_BASELINE_CAPTURE_FULL;
    b.used[s] = 1;
    b.last_tick[s] = tick;
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        b.x[s] = x;
        b.y[s] = y;
        b.z[s] = z;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        b.rotation[s] = rotation;
    }
    if is_full {
        // Buildings don't move — clear physics-fields so a stray emit can't
        // pick up stale unit data left over from a slot recycle.
        b.velocity_x[s] = 0.0;
        b.velocity_y[s] = 0.0;
        b.velocity_z[s] = 0.0;
        b.movement_accel_x[s] = 0.0;
        b.movement_accel_y[s] = 0.0;
        b.movement_accel_z[s] = 0.0;
    }

    // HP + factory/solar/build progress from the entity-meta pool.
    let meta = entity_meta_pool();
    if s < meta.hp_curr.len() {
        if is_full || (changed_fields & ENTITY_CHANGED_HP) != 0 {
            b.hp[s] = meta.hp_curr[s];
        }
        if is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0 {
            b.build_progress[s] = if s < meta.build_progress.len() {
                meta.build_progress[s]
            } else {
                1.0
            };
            b.solar_open[s] = if s < meta.solar_open.len() {
                meta.solar_open[s]
            } else {
                1
            };
        }
        if is_full || (changed_fields & ENTITY_CHANGED_FACTORY) != 0 {
            b.factory_progress[s] = if s < meta.factory_progress.len() {
                meta.factory_progress[s]
            } else {
                0.0
            };
            b.is_producing[s] = if s < meta.factory_is_producing.len() {
                meta.factory_is_producing[s]
            } else {
                0
            };
            b.build_queue_len[s] = if s < meta.factory_build_queue_len.len() {
                meta.factory_build_queue_len[s]
            } else {
                0
            };
        }
    }

    // Turret state — buildings with defense turrets (combat) need
    // weapon_count + per-turret state captured the same as units, or
    // the diff kernel would see ENTITY_CHANGED_TURRETS divergence
    // every tick.
    if is_full || (changed_fields & ENTITY_CHANGED_TURRETS) != 0 {
        b.is_engaged_bits[s] = is_engaged_bits;
        b.target_bits[s] = target_bits;
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
                b.turret_pitch_vels[dst] = turret.pitch_velocity[src];
                b.turret_target_ids[dst] = turret.target_id[src];
                b.force_field_ranges[dst] = turret.force_field_range[src];
            }
        } else {
            b.weapon_count[s] = 0;
        }
    }
}

/// Read-back accessor used by the (future) D.3d diff kernel and by
/// invariant checks. Returns 0 (unset) or 1 (used).
#[wasm_bindgen]
pub fn snapshot_baseline_slot_used(handle: u32, slot: u32) -> u8 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.used.len() {
        return 0;
    }
    b.used[s]
}

/// Read-back accessor for the last tick at which the baseline was
/// captured for `slot`. Returns 0 if the slot is unset.
#[wasm_bindgen]
pub fn snapshot_baseline_slot_last_tick(handle: u32, slot: u32) -> u32 {
    let registry = snapshot_baseline_registry();
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.last_tick.len() {
        return 0;
    }
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

const SNAPSHOT_BASELINE_CAPTURE_FULL: u32 = u32::MAX;
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
    x: f64,
    y: f64,
    z: f64,
    rotation: f64,
    velocity_x: f64,
    velocity_y: f64,
    velocity_z: f64,
    movement_accel_x: f64,
    movement_accel_y: f64,
    movement_accel_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
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
    let Some(b) = registry.get_mut(handle) else {
        return 0;
    };
    let s = slot as usize;
    if s >= b.used.len() || b.used[s] == 0 {
        return 0;
    }

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
        // movement_accel_x/y/z params remain on the ABI for now but are
        // no longer compared against baseline: server stopped shipping
        // acceleration on the wire, so the per-axis bit is dead.
        let _ = movement_accel_x;
        let _ = movement_accel_y;
        let _ = movement_accel_z;
        let cur_hp = {
            let meta = entity_meta_pool();
            if s < meta.hp_curr.len() {
                meta.hp_curr[s]
            } else {
                0.0
            }
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
                if s < meta.build_progress.len() {
                    meta.build_progress[s]
                } else {
                    0.0
                }
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
        } else {
            0
        };
        if cur_weapon_count != b.weapon_count[s] {
            mask |= ENTITY_CHANGED_TURRETS;
        } else if cur_weapon_count > 0 {
            let base = s * (SNAPSHOT_BASELINE_MAX_TURRETS_PER_ENTITY as usize);
            let mut turrets_changed = false;
            for t in 0..(cur_weapon_count as usize) {
                let idx = base + t;
                if ((turret.rotation[idx] - b.turret_rots[idx]).abs() as f64) > rot_pos_threshold
                    || ((turret.angular_velocity[idx] - b.turret_ang_vels[idx]).abs() as f64)
                        > rot_vel_threshold
                    || ((turret.pitch[idx] - b.turret_pitches[idx]).abs() as f64)
                        > rot_pos_threshold
                    || ((turret.pitch_velocity[idx] - b.turret_pitch_vels[idx]).abs() as f64)
                        > rot_vel_threshold
                    || turret.target_id[idx] != b.turret_target_ids[idx]
                    || (turret.force_field_range[idx] - b.force_field_ranges[idx]).abs()
                        > SNAPSHOT_FORCE_FIELD_RANGE_THRESHOLD
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
        let cur_hp = if s < meta.hp_curr.len() {
            meta.hp_curr[s]
        } else {
            0.0
        };
        if cur_hp != b.hp[s] {
            mask |= ENTITY_CHANGED_HP;
        }
        let cur_build = if s < meta.build_progress.len() {
            meta.build_progress[s]
        } else {
            0.0
        };
        let cur_solar = if s < meta.solar_open.len() {
            meta.solar_open[s]
        } else {
            1
        };
        if cur_build != b.build_progress[s] || cur_solar != b.solar_open[s] {
            mask |= ENTITY_CHANGED_BUILDING;
        }
        if has_factory != 0 {
            let cur_fp = if s < meta.factory_progress.len() {
                meta.factory_progress[s]
            } else {
                0.0
            };
            let cur_ip = if s < meta.factory_is_producing.len() {
                meta.factory_is_producing[s]
            } else {
                0
            };
            let cur_bql = if s < meta.factory_build_queue_len.len() {
                meta.factory_build_queue_len[s]
            } else {
                0
            };
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
/// turrets array. Layout per turret (10 f64 = 80 bytes):
///   [0..4]  qRot(rotation, vel, pitch, pitchVel)
///   [4]     turret-id code (TurretTypeCode as f64)
///   [5]     state code (TurretStateCode as f64)
///   [6]     has_target_id (0 or 1)
///   [7]     target_id (raw entity id as f64; ignored when has_target_id==0)
///   [8]     has_force_field_range (0 or 1)
///   [9]     force_field_range (raw value; ignored when has_ff_range==0)
///
/// Capacity grown on demand by snapshot_encode_turret_scratch_ensure.
const SNAPSHOT_ENCODE_TURRET_STRIDE: usize = 10;

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

struct SnapshotEncodeFactoryQueueScratchHolder(
    UnsafeCell<Option<SnapshotEncodeFactoryQueueScratch>>,
);
unsafe impl Sync for SnapshotEncodeFactoryQueueScratchHolder {}
static SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH: SnapshotEncodeFactoryQueueScratchHolder =
    SnapshotEncodeFactoryQueueScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_factory_queue_scratch() -> &'static mut SnapshotEncodeFactoryQueueScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_FACTORY_QUEUE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeFactoryQueueScratch {
                buf: vec![0u32; 16],
            });
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

/// Write the sparse envelope key-value pairs (id, type, optional pos,
/// optional rotation, playerId, changedFields) shared by every encoder kernel. Caller
/// is responsible for writing the parent map header with the right
/// key count (envelope keys + sub-object keys). `changed_fields` is
/// emitted only when `has_changed_fields != 0` so the full-snapshot
/// path can omit the key entirely.
fn write_entity_envelope_keys(
    w: &mut MessagePackWriter,
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) {
    let is_full = has_changed_fields == 0;
    let has_pos = is_full || (changed_fields & ENTITY_CHANGED_POS) != 0;
    let has_rotation = is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0;

    w.write_str("id");
    w.write_uint(id as u64);

    w.write_str("type");
    match type_tag {
        SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
        SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
        _ => w.write_str(""),
    }

    if has_pos {
        w.write_str("pos");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qpos_x);
        w.write_str("y");
        w.write_number(qpos_y);
        w.write_str("z");
        w.write_number(qpos_z);
    }

    if has_rotation {
        w.write_str("rotation");
        w.write_number(qrot);
    }

    w.write_str("playerId");
    w.write_uint(player_id as u64);

    if has_changed_fields != 0 {
        w.write_str("changedFields");
        w.write_uint(changed_fields as u64);
    }
}

fn entity_envelope_key_count(has_changed_fields: u8, changed_fields: u32) -> usize {
    let is_full = has_changed_fields == 0;
    let mut key_count: usize = 3; // id, type, playerId
    if is_full || (changed_fields & ENTITY_CHANGED_POS) != 0 {
        key_count += 1;
    }
    if is_full || (changed_fields & ENTITY_CHANGED_ROT) != 0 {
        key_count += 1;
    }
    if has_changed_fields != 0 {
        key_count += 1;
    }
    key_count
}

/// Encode the entity envelope: `{id, type, [pos,] [rotation,] playerId
/// [, changedFields]}` — the base fields every
/// NetworkServerSnapshotEntity carries plus the optional delta mask.
/// Output written to the D.2 writer; returns the number of bytes.
///
/// Field order matches the JS DTO's property insertion order so the
/// MessagePack key sequence is identical: id → type → pos → rotation
/// → playerId → changedFields. Quantized numbers are passed in as
/// f64 (caller does qPos / qRot conversion).
#[wasm_bindgen]
pub fn snapshot_encode_entity_basic(
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        type_tag,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );
    (w.buf.len() - start) as u32
}

/// Encode an entity with a unit sub-object. Delta records only emit
/// `hp` and `velocity` when the corresponding changedFields bit is set.
/// Optional keys gated by `has_*` flags: movementAccel, surfaceNormal,
/// suspension.
///
/// suspension is nested: `{offset, velocity, [legContact]}`. The
/// `legContact` key is either `true` or absent (never `false`) —
/// JS writes `out.legContact = ... ? true : undefined;` and
/// ignoreUndefined drops the undefined case. `leg_contact` here is
/// 0 (omit) or 1 (emit true).
///
/// Field order inside `unit` mirrors the pooled DTO's runtime
/// insertion order in stateSerializerEntities.ts.
#[wasm_bindgen]
pub fn snapshot_encode_entity_unit(
    id: u32,
    type_tag: u8,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    hp_curr: f64,
    hp_max: f64,
    qvel_x: f64,
    qvel_y: f64,
    qvel_z: f64,
    has_unit_type: u8,
    unit_type_code: u32,
    has_radius: u8,
    radius_body: f64,
    radius_shot: f64,
    radius_push: f64,
    has_body_center_height: u8,
    body_center_height: f64,
    has_mass: u8,
    mass: f64,
    has_surface_normal: u8,
    qnormal_x: f64,
    qnormal_y: f64,
    qnormal_z: f64,
    has_suspension: u8,
    qsuspension_offset_x: f64,
    qsuspension_offset_y: f64,
    qsuspension_offset_z: f64,
    qsuspension_vel_x: f64,
    qsuspension_vel_y: f64,
    qsuspension_vel_z: f64,
    suspension_leg_contact: u8,
    has_orientation: u8,
    qorient_x: f64,
    qorient_y: f64,
    qorient_z: f64,
    qorient_w: f64,
    has_angular_velocity3: u8,
    qangvel_x: f64,
    qangvel_y: f64,
    qangvel_z: f64,
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
    build_paid_metal: f64,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    key_count += 1; // unit
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        type_tag,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );

    let is_full = has_changed_fields == 0;
    let has_hp = is_full || (changed_fields & ENTITY_CHANGED_HP) != 0;
    let has_velocity = is_full || (changed_fields & ENTITY_CHANGED_VEL) != 0;
    let mut unit_field_count: usize = 0;
    if has_hp {
        unit_field_count += 1;
    }
    if has_velocity {
        unit_field_count += 1;
    }
    if has_unit_type != 0 {
        unit_field_count += 1;
    }
    if has_radius != 0 {
        unit_field_count += 1;
    }
    if has_body_center_height != 0 {
        unit_field_count += 1;
    }
    if has_mass != 0 {
        unit_field_count += 1;
    }
    if has_is_commander != 0 {
        unit_field_count += 1;
    }
    if has_surface_normal != 0 {
        unit_field_count += 1;
    }
    if has_suspension != 0 {
        unit_field_count += 1;
    }
    if has_orientation != 0 {
        unit_field_count += 1;
    }
    if has_angular_velocity3 != 0 {
        unit_field_count += 1;
    }
    if has_fire_enabled != 0 {
        unit_field_count += 1;
    }
    if has_build != 0 {
        unit_field_count += 1;
    }
    if has_actions != 0 {
        unit_field_count += 1;
    }
    if has_turrets != 0 {
        unit_field_count += 1;
    }
    if has_build_target_id != 0 {
        unit_field_count += 1;
    }

    w.write_str("unit");
    w.write_map_header(unit_field_count);

    if has_hp {
        w.write_str("hp");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(hp_curr);
        w.write_str("max");
        w.write_number(hp_max);
    }

    if has_velocity {
        w.write_str("velocity");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qvel_x);
        w.write_str("y");
        w.write_number(qvel_y);
        w.write_str("z");
        w.write_number(qvel_z);
    }

    if has_unit_type != 0 {
        w.write_str("unitType");
        w.write_uint(unit_type_code as u64);
    }

    if has_radius != 0 {
        w.write_str("radius");
        w.write_map_header(3);
        w.write_str("body");
        w.write_number(radius_body);
        w.write_str("shot");
        w.write_number(radius_shot);
        w.write_str("push");
        w.write_number(radius_push);
    }

    if has_body_center_height != 0 {
        w.write_str("bodyCenterHeight");
        w.write_number(body_center_height);
    }

    if has_mass != 0 {
        w.write_str("mass");
        w.write_number(mass);
    }

    if has_is_commander != 0 {
        w.write_str("isCommander");
        w.write_bool(true);
    }

    if has_surface_normal != 0 {
        w.write_str("surfaceNormal");
        w.write_map_header(3);
        w.write_str("nx");
        w.write_number(qnormal_x);
        w.write_str("ny");
        w.write_number(qnormal_y);
        w.write_str("nz");
        w.write_number(qnormal_z);
    }

    if has_suspension != 0 {
        let suspension_field_count = if suspension_leg_contact != 0 { 3 } else { 2 };
        w.write_str("suspension");
        w.write_map_header(suspension_field_count);
        w.write_str("offset");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qsuspension_offset_x);
        w.write_str("y");
        w.write_number(qsuspension_offset_y);
        w.write_str("z");
        w.write_number(qsuspension_offset_z);
        w.write_str("velocity");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qsuspension_vel_x);
        w.write_str("y");
        w.write_number(qsuspension_vel_y);
        w.write_str("z");
        w.write_number(qsuspension_vel_z);
        if suspension_leg_contact != 0 {
            w.write_str("legContact");
            w.write_bool(true);
        }
    }

    if has_orientation != 0 {
        w.write_str("orientation");
        w.write_map_header(4);
        w.write_str("x");
        w.write_number(qorient_x);
        w.write_str("y");
        w.write_number(qorient_y);
        w.write_str("z");
        w.write_number(qorient_z);
        w.write_str("w");
        w.write_number(qorient_w);
    }

    if has_angular_velocity3 != 0 {
        w.write_str("angularVelocity3");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(qangvel_x);
        w.write_str("y");
        w.write_number(qangvel_y);
        w.write_str("z");
        w.write_number(qangvel_z);
    }

    // Tri-state scalar/boolean optionals — JS emits them as
    // `false`/`true`/`number|null` or undefined (omitted). Each
    // `has_*` flag gates the key-value pair entirely.
    if has_fire_enabled != 0 {
        w.write_str("fireEnabled");
        w.write_bool(false);
    }

    if has_build != 0 {
        w.write_str("build");
        w.write_map_header(2); // complete + paid
        w.write_str("complete");
        w.write_bool(build_complete != 0);
        w.write_str("paid");
        w.write_map_header(2);
        w.write_str("energy");
        w.write_number(build_paid_energy);
        w.write_str("metal");
        w.write_number(build_paid_metal);
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
            if has_pos {
                action_field_count += 1;
            }
            if has_pos_z {
                action_field_count += 1;
            }
            if path_exp {
                action_field_count += 1;
            }
            if has_target_id {
                action_field_count += 1;
            }
            if has_building_type {
                action_field_count += 1;
            }
            if has_grid {
                action_field_count += 1;
            }
            if has_building_id {
                action_field_count += 1;
            }
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
            let qpitch = scratch.buf[base + 2];
            let qpitch_vel = scratch.buf[base + 3];
            let turret_id_code = scratch.buf[base + 4];
            let state_code = scratch.buf[base + 5];
            let has_target = scratch.buf[base + 6] != 0.0;
            let target_id_raw = scratch.buf[base + 7];
            let has_ff_range = scratch.buf[base + 8] != 0.0;
            let ff_range_raw = scratch.buf[base + 9];

            // turret DTO: { turret: { id, angular: {4 fields} }, [targetId,]
            // state, [currentForceFieldRange] }
            let mut turret_field_count: usize = 2; // turret + state
            if has_target {
                turret_field_count += 1;
            }
            if has_ff_range {
                turret_field_count += 1;
            }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2); // id + angular
            w.write_str("id");
            w.write_number(turret_id_code);
            w.write_str("angular");
            w.write_map_header(4);
            w.write_str("rot");
            w.write_number(qrot);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);

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

    if has_build_target_id != 0 {
        w.write_str("buildTargetId");
        if build_target_id_is_null != 0 {
            w.write_nil();
        } else {
            w.write_uint(build_target_id as u64);
        }
    }

    (w.buf.len() - start) as u32
}

/// Encode a building entity DTO: `{...envelope, building: {
///   [type,] [dim,] [hp,] [build,] [metalExtractionRate,] [solar,] [turrets]
/// }}` — covers everything except the factory sub-object (next commit).
///
/// hp + build are sparse on delta records and are emitted only when
/// their changedFields group is set. Other building-sub fields are gated
/// by their `has_*` flags. Turrets reuse the same scratch as units
/// (D.3j-9).
#[wasm_bindgen]
pub fn snapshot_encode_entity_building(
    id: u32,
    qpos_x: f64,
    qpos_y: f64,
    qpos_z: f64,
    qrot: f64,
    player_id: u8,
    has_changed_fields: u8,
    changed_fields: u32,
    has_type: u8,
    type_code: f64,
    has_dim: u8,
    dim_x: f64,
    dim_y: f64,
    hp_curr: f64,
    hp_max: f64,
    build_complete: u8,
    build_paid_energy: f64,
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
    factory_metal_rate: f64,
    factory_waypoint_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let start = w.buf.len();

    let mut key_count = entity_envelope_key_count(has_changed_fields, changed_fields);
    key_count += 1; // building
    w.write_map_header(key_count);
    write_entity_envelope_keys(
        w,
        id,
        SNAPSHOT_ENTITY_TYPE_BUILDING,
        qpos_x,
        qpos_y,
        qpos_z,
        qrot,
        player_id,
        has_changed_fields,
        changed_fields,
    );

    let is_full = has_changed_fields == 0;
    let has_hp = is_full || (changed_fields & ENTITY_CHANGED_HP) != 0;
    let has_build = is_full || (changed_fields & ENTITY_CHANGED_BUILDING) != 0;
    let mut building_field_count: usize = 0;
    if has_hp {
        building_field_count += 1;
    }
    if has_build {
        building_field_count += 1;
    }
    if has_type != 0 {
        building_field_count += 1;
    }
    if has_dim != 0 {
        building_field_count += 1;
    }
    if has_metal_extraction_rate != 0 {
        building_field_count += 1;
    }
    if has_solar != 0 {
        building_field_count += 1;
    }
    if has_turrets != 0 {
        building_field_count += 1;
    }
    if has_factory != 0 {
        building_field_count += 1;
    }

    w.write_str("building");
    w.write_map_header(building_field_count);

    if has_type != 0 {
        w.write_str("type");
        w.write_number(type_code);
    }
    if has_dim != 0 {
        w.write_str("dim");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(dim_x);
        w.write_str("y");
        w.write_number(dim_y);
    }

    if has_hp {
        w.write_str("hp");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(hp_curr);
        w.write_str("max");
        w.write_number(hp_max);
    }

    if has_build {
        w.write_str("build");
        w.write_map_header(2);
        w.write_str("complete");
        w.write_bool(build_complete != 0);
        w.write_str("paid");
        w.write_map_header(2);
        w.write_str("energy");
        w.write_number(build_paid_energy);
        w.write_str("metal");
        w.write_number(build_paid_metal);
    }

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
            let qpitch = scratch.buf[base + 2];
            let qpitch_vel = scratch.buf[base + 3];
            let turret_id_code = scratch.buf[base + 4];
            let state_code = scratch.buf[base + 5];
            let has_target = scratch.buf[base + 6] != 0.0;
            let target_id_raw = scratch.buf[base + 7];
            let has_ff_range = scratch.buf[base + 8] != 0.0;
            let ff_range_raw = scratch.buf[base + 9];

            let mut turret_field_count: usize = 2; // turret + state
            if has_target {
                turret_field_count += 1;
            }
            if has_ff_range {
                turret_field_count += 1;
            }
            w.write_map_header(turret_field_count);

            w.write_str("turret");
            w.write_map_header(2);
            w.write_str("id");
            w.write_number(turret_id_code);
            w.write_str("angular");
            w.write_map_header(4);
            w.write_str("rot");
            w.write_number(qrot_t);
            w.write_str("vel");
            w.write_number(qvel);
            w.write_str("pitch");
            w.write_number(qpitch);
            w.write_str("pitchVel");
            w.write_number(qpitch_vel);

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
        w.write_map_header(6); // queue, progress, producing, energyRate, metalRate, waypoints

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
/// Minimap-entities scratch — 6 f64 per entry:
///   [0]   id (entity id)
///   [1]   pos.x
///   [2]   pos.y
///   [3]   type_tag (1 = unit, 2 = building, matches SNAPSHOT_ENTITY_TYPE_*)
///   [4]   playerId
///   [5]   has_radar_only + (radar_only << 1) packed: 0 = omit, 2 = emit
///         false (rare), 3 = emit true. Practically only 0 or 3 appear.
const SNAPSHOT_ENCODE_MINIMAP_STRIDE: usize = 6;

struct SnapshotEncodeMinimapScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeMinimapScratchHolder(UnsafeCell<Option<SnapshotEncodeMinimapScratch>>);
unsafe impl Sync for SnapshotEncodeMinimapScratchHolder {}
static SNAPSHOT_ENCODE_MINIMAP_SCRATCH: SnapshotEncodeMinimapScratchHolder =
    SnapshotEncodeMinimapScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_minimap_scratch() -> &'static mut SnapshotEncodeMinimapScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_MINIMAP_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeMinimapScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_MINIMAP_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_minimap_scratch_ptr() -> *const f64 {
    snapshot_encode_minimap_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_minimap_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
    let s = snapshot_encode_minimap_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Projectile-despawn scratch — Uint32Array of projectile ids
/// (one u32 per despawn entry).
struct SnapshotEncodeProjDespawnScratch {
    buf: Vec<u32>,
}

struct SnapshotEncodeProjDespawnScratchHolder(UnsafeCell<Option<SnapshotEncodeProjDespawnScratch>>);
unsafe impl Sync for SnapshotEncodeProjDespawnScratchHolder {}
static SNAPSHOT_ENCODE_PROJ_DESPAWN_SCRATCH: SnapshotEncodeProjDespawnScratchHolder =
    SnapshotEncodeProjDespawnScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_proj_despawn_scratch() -> &'static mut SnapshotEncodeProjDespawnScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_DESPAWN_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjDespawnScratch {
                buf: vec![0u32; 32],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_despawn_scratch_ptr() -> *const u32 {
    snapshot_encode_proj_despawn_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_despawn_scratch_ensure(count: u32) {
    let s = snapshot_encode_proj_despawn_scratch();
    if s.buf.len() < count as usize {
        s.buf.resize(count as usize, 0);
    }
}

/// Projectile velocity-update scratch — 7 f64 per entry:
///   [0]   id
///   [1..4] pos.x, pos.y, pos.z
///   [4..7] velocity.x, velocity.y, velocity.z
const SNAPSHOT_ENCODE_PROJ_VEL_STRIDE: usize = 7;

struct SnapshotEncodeProjVelScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeProjVelScratchHolder(UnsafeCell<Option<SnapshotEncodeProjVelScratch>>);
unsafe impl Sync for SnapshotEncodeProjVelScratchHolder {}
static SNAPSHOT_ENCODE_PROJ_VEL_SCRATCH: SnapshotEncodeProjVelScratchHolder =
    SnapshotEncodeProjVelScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_proj_vel_scratch() -> &'static mut SnapshotEncodeProjVelScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_VEL_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjVelScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_PROJ_VEL_STRIDE * 32],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_vel_scratch_ptr() -> *const f64 {
    snapshot_encode_proj_vel_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_vel_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
    let s = snapshot_encode_proj_vel_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Projectile spawn scratch — 27 f64 per entry. Field order matches
/// `createPooledProjectileSpawn` in stateSerializerProjectiles.ts so
/// the emit loop walks the slots in DTO insertion order.
///   [0]    id
///   [1..4] pos.x, pos.y, pos.z
///   [4]    rotation
///   [5..8] velocity.x, velocity.y, velocity.z
///   [8]    projectileType (code)
///   [9]    maxLifespan (gated by flag bit 0)
///   [10]   turretId (code)
///   [11]   shotId (gated by flag bit 1)
///   [12]   sourceTurretId (gated by flag bit 2)
///   [13]   playerId
///   [14]   sourceEntityId
///   [15]   turretIndex
///   [16]   barrelIndex
///   [17..20] beam.start.x/y/z (gated by flag bit 5)
///   [20..23] beam.end.x/y/z (gated by flag bit 5)
///   [23]   targetEntityId (gated by flag bit 6)
///   [24]   homingTurnRate (gated by flag bit 7)
///   [25]   reserved (future expansion)
///   [26]   flags: bit 0 maxLifespan, 1 shotId, 2 sourceTurretId,
///          3 isDGun(true), 4 fromParentDetonation(true), 5 beam,
///          6 targetEntityId, 7 homingTurnRate, 8 isDGun(false),
///          9 fromParentDetonation(false).
const SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE: usize = 27;

struct SnapshotEncodeProjSpawnScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeProjSpawnScratchHolder(UnsafeCell<Option<SnapshotEncodeProjSpawnScratch>>);
unsafe impl Sync for SnapshotEncodeProjSpawnScratchHolder {}
static SNAPSHOT_ENCODE_PROJ_SPAWN_SCRATCH: SnapshotEncodeProjSpawnScratchHolder =
    SnapshotEncodeProjSpawnScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_proj_spawn_scratch() -> &'static mut SnapshotEncodeProjSpawnScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_PROJ_SPAWN_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeProjSpawnScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_spawn_scratch_ptr() -> *const f64 {
    snapshot_encode_proj_spawn_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_proj_spawn_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
    let s = snapshot_encode_proj_spawn_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Beam-update header scratch — 4 f64 per update:
///   [0]   id
///   [1]   flags: bit 0 has_obstructionT, bit 1 has_endpointDamageable_false,
///         bit 2 has_endpointDamageable_true
///   [2]   obstructionT (qRot value, only valid if flag set)
///   [3]   point_count (u32 as f64, points come from beam_point_scratch
///         in order — first update's points then next update's, etc.)
const SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE: usize = 4;

struct SnapshotEncodeBeamUpdateScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeBeamUpdateScratchHolder(UnsafeCell<Option<SnapshotEncodeBeamUpdateScratch>>);
unsafe impl Sync for SnapshotEncodeBeamUpdateScratchHolder {}
static SNAPSHOT_ENCODE_BEAM_UPDATE_SCRATCH: SnapshotEncodeBeamUpdateScratchHolder =
    SnapshotEncodeBeamUpdateScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_beam_update_scratch() -> &'static mut SnapshotEncodeBeamUpdateScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_BEAM_UPDATE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeBeamUpdateScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_update_scratch_ptr() -> *const f64 {
    snapshot_encode_beam_update_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_update_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
    let s = snapshot_encode_beam_update_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Beam-point scratch — flat 15 f64 per point across ALL beam updates
/// (first update's N1 points, then next update's N2 points, etc.).
///   [0..3]  x, y, z
///   [3..6]  vx, vy, vz
///   [6..9]  ax, ay, az (server zeros these — kept for byte-equality
///           with current JS encoder; future commit may drop)
///   [9]     flags: bit 0 has_mirrorEntityId, bit 1 has_reflectorKind,
///           bit 2 reflectorKind_is_forceField (else 'mirror' when
///           bit 1 set), bit 3 has_reflectorPlayerId, bit 4 has_normalX,
///           bit 5 has_normalY, bit 6 has_normalZ.
///   [10]    mirrorEntityId
///   [11]    reflectorPlayerId
///   [12..15] normalX, normalY, normalZ
const SNAPSHOT_ENCODE_BEAM_POINT_STRIDE: usize = 15;

struct SnapshotEncodeBeamPointScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeBeamPointScratchHolder(UnsafeCell<Option<SnapshotEncodeBeamPointScratch>>);
unsafe impl Sync for SnapshotEncodeBeamPointScratchHolder {}
static SNAPSHOT_ENCODE_BEAM_POINT_SCRATCH: SnapshotEncodeBeamPointScratchHolder =
    SnapshotEncodeBeamPointScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_beam_point_scratch() -> &'static mut SnapshotEncodeBeamPointScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_BEAM_POINT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeBeamPointScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_BEAM_POINT_STRIDE * 64],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_point_scratch_ptr() -> *const f64 {
    snapshot_encode_beam_point_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_beam_point_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE;
    let s = snapshot_encode_beam_point_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Death-context scratch — 16 f64 per deathContext (one per audio
/// event that has the has_deathContext flag set). Caller packs in
/// the same order as the audio events appear; Rust walks audio
/// events and uses a local offset to pull the next deathContext.
///   [0..2]  unitVel.x, unitVel.y
///   [2..4]  hitDir.x, hitDir.y
///   [4..6]  projectileVel.x, projectileVel.y
///   [6]     attackMagnitude
///   [7]     radius
///   [8]     color
///   [9]     visualRadius (gated by flags bit 0)
///   [10]    pushRadius (gated by flags bit 1)
///   [11]    baseZ (gated by flags bit 2)
///   [12]    rotation (gated by flags bit 4)
///   [13]    unitType string-scratch slot (gated by flags bit 3)
///   [14]    turretPoses_count (gated by flags bit 5)
///   [15]    flags: bit 0 has_visualRadius, bit 1 has_pushRadius,
///            bit 2 has_baseZ, bit 3 has_unitType, bit 4 has_rotation,
///            bit 5 has_turretPoses
const SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE: usize = 16;

struct SnapshotEncodeDeathContextScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeDeathContextScratchHolder(
    UnsafeCell<Option<SnapshotEncodeDeathContextScratch>>,
);
unsafe impl Sync for SnapshotEncodeDeathContextScratchHolder {}
static SNAPSHOT_ENCODE_DEATH_CONTEXT_SCRATCH: SnapshotEncodeDeathContextScratchHolder =
    SnapshotEncodeDeathContextScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_death_context_scratch() -> &'static mut SnapshotEncodeDeathContextScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_DEATH_CONTEXT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeDeathContextScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE * 4],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_death_context_scratch_ptr() -> *const f64 {
    snapshot_encode_death_context_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_death_context_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
    let s = snapshot_encode_death_context_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Turret-pose scratch (for deathContext.turretPoses arrays) — flat
/// across all deathContexts in pack order; stride 2 (rotation, pitch).
const SNAPSHOT_ENCODE_TURRET_POSE_STRIDE: usize = 2;

struct SnapshotEncodeTurretPoseScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeTurretPoseScratchHolder(UnsafeCell<Option<SnapshotEncodeTurretPoseScratch>>);
unsafe impl Sync for SnapshotEncodeTurretPoseScratchHolder {}
static SNAPSHOT_ENCODE_TURRET_POSE_SCRATCH: SnapshotEncodeTurretPoseScratchHolder =
    SnapshotEncodeTurretPoseScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_turret_pose_scratch() -> &'static mut SnapshotEncodeTurretPoseScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_TURRET_POSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeTurretPoseScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_TURRET_POSE_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_pose_scratch_ptr() -> *const f64 {
    snapshot_encode_turret_pose_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_turret_pose_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
    let s = snapshot_encode_turret_pose_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Impact-context scratch — 11 f64 per impactContext (one per audio
/// event with has_impactContext flag set). All fields are required
/// in the source DTO (no optionals).
///   [0]    collisionRadius
///   [1]    explosionRadius
///   [2..4] projectile.pos.x, projectile.pos.y
///   [4..6] projectile.vel.x, projectile.vel.y
///   [6..8] entity.vel.x, entity.vel.y
///   [8]    entity.collisionRadius
///   [9..11] penetrationDir.x, penetrationDir.y
const SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE: usize = 11;

struct SnapshotEncodeImpactContextScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeImpactContextScratchHolder(
    UnsafeCell<Option<SnapshotEncodeImpactContextScratch>>,
);
unsafe impl Sync for SnapshotEncodeImpactContextScratchHolder {}
static SNAPSHOT_ENCODE_IMPACT_CONTEXT_SCRATCH: SnapshotEncodeImpactContextScratchHolder =
    SnapshotEncodeImpactContextScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_impact_context_scratch() -> &'static mut SnapshotEncodeImpactContextScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_IMPACT_CONTEXT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeImpactContextScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE * 4],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_impact_context_scratch_ptr() -> *const f64 {
    snapshot_encode_impact_context_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_impact_context_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
    let s = snapshot_encode_impact_context_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Audio-event scratch — 16 f64 per event (NetworkServerSnapshotSimEvent
/// minus deathContext / impactContext, which arrive in follow-ups).
///   [0]    type_code (0='fire', 1='hit', 2='death', 3='laserStart',
///           4='laserStop', 5='forceFieldStart', 6='forceFieldStop',
///           7='forceFieldImpact', 8='ping', 9='attackAlert',
///           10='projectileExpire')
///   [1..4] pos.x, pos.y, pos.z (always present)
///   [4]    playerId (gated by flags bit 2)
///   [5]    entityId (gated by flags bit 3)
///   [6]    killerPlayerId (gated by flags bit 5)
///   [7]    victimPlayerId (gated by flags bit 6)
///   [8..11] forceFieldImpact.normal.x/y/z (gated by flags bit 4)
///   [11]   forceFieldImpact.playerId
///   [12]   sourceType_code (gated by flags bit 0; 0='turret', 1='unit',
///           2='building', 3='system')
///   [13]   turretId string-scratch slot (always present — empty
///           string is a valid value, encoded as fixstr 0xA0)
///   [14]   sourceKey string-scratch slot (gated by flags bit 1)
///   [15]   flags: bit 0 has_sourceType, bit 1 has_sourceKey,
///           bit 2 has_playerId, bit 3 has_entityId,
///           bit 4 has_forceFieldImpact, bit 5 has_killerPlayerId,
///           bit 6 has_victimPlayerId, bit 7 has_audioOnly,
///           bit 8 audioOnly_value, bit 9 has_deathContext (TBD),
///           bit 10 has_impactContext (TBD).
const SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE: usize = 16;

struct SnapshotEncodeAudioEventScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeAudioEventScratchHolder(UnsafeCell<Option<SnapshotEncodeAudioEventScratch>>);
unsafe impl Sync for SnapshotEncodeAudioEventScratchHolder {}
static SNAPSHOT_ENCODE_AUDIO_EVENT_SCRATCH: SnapshotEncodeAudioEventScratchHolder =
    SnapshotEncodeAudioEventScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_audio_event_scratch() -> &'static mut SnapshotEncodeAudioEventScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_AUDIO_EVENT_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeAudioEventScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_audio_event_scratch_ptr() -> *const f64 {
    snapshot_encode_audio_event_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_audio_event_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
    let s = snapshot_encode_audio_event_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

#[inline]
fn audio_event_type_str(code: u8) -> &'static str {
    match code {
        0 => "fire",
        1 => "hit",
        2 => "death",
        3 => "laserStart",
        4 => "laserStop",
        5 => "forceFieldStart",
        6 => "forceFieldStop",
        7 => "forceFieldImpact",
        8 => "ping",
        9 => "attackAlert",
        10 => "projectileExpire",
        _ => "",
    }
}

#[inline]
fn audio_event_source_type_str(code: u8) -> &'static str {
    match code {
        0 => "turret",
        1 => "unit",
        2 => "building",
        3 => "system",
        _ => "",
    }
}

/// Economy scratch — 11 f64 per player (caller must pack in ASCENDING
/// playerId order to match @msgpack/msgpack's iteration of a JS
/// object with integer-string keys).
///   [0]   playerId (becomes the outer-map string key)
///   [1..3] stockpile.curr, stockpile.max
///   [3..5] income.base, income.production
///   [5]   expenditure
///   [6..8] metal.stockpile.curr, metal.stockpile.max
///   [8..10] metal.income.base, metal.income.extraction
///   [10]  metal.expenditure
const SNAPSHOT_ENCODE_ECONOMY_STRIDE: usize = 11;

struct SnapshotEncodeEconomyScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeEconomyScratchHolder(UnsafeCell<Option<SnapshotEncodeEconomyScratch>>);
unsafe impl Sync for SnapshotEncodeEconomyScratchHolder {}
static SNAPSHOT_ENCODE_ECONOMY_SCRATCH: SnapshotEncodeEconomyScratchHolder =
    SnapshotEncodeEconomyScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_economy_scratch() -> &'static mut SnapshotEncodeEconomyScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_ECONOMY_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeEconomyScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_ECONOMY_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_economy_scratch_ptr() -> *const f64 {
    snapshot_encode_economy_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_economy_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_ECONOMY_STRIDE;
    let s = snapshot_encode_economy_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Spray-target scratch — 16 f64 per spray (NetworkServerSnapshotSprayTarget).
///   [0]    source.id
///   [1..3] source.pos.x, source.pos.y
///   [3]    source.z (gated by flags bit 1)
///   [4]    source.playerId
///   [5]    target.id
///   [6..8] target.pos.x, target.pos.y
///   [8]    target.z (gated by flags bit 2)
///   [9..11] target.dim.x, target.dim.y (gated by flags bit 3)
///   [11]   target.radius (gated by flags bit 4)
///   [12]   intensity
///   [13]   speed (gated by flags bit 5)
///   [14]   particleRadius (gated by flags bit 6)
///   [15]   flags: bit 0 type_is_heal (else 'build'), bit 1 has_source_z,
///          bit 2 has_target_z, bit 3 has_target_dim, bit 4 has_target_radius,
///          bit 5 has_speed, bit 6 has_particleRadius.
const SNAPSHOT_ENCODE_SPRAY_STRIDE: usize = 16;

struct SnapshotEncodeSprayScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeSprayScratchHolder(UnsafeCell<Option<SnapshotEncodeSprayScratch>>);
unsafe impl Sync for SnapshotEncodeSprayScratchHolder {}
static SNAPSHOT_ENCODE_SPRAY_SCRATCH: SnapshotEncodeSprayScratchHolder =
    SnapshotEncodeSprayScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_spray_scratch() -> &'static mut SnapshotEncodeSprayScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SPRAY_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeSprayScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_SPRAY_STRIDE * 16],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_spray_scratch_ptr() -> *const f64 {
    snapshot_encode_spray_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_spray_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_SPRAY_STRIDE;
    let s = snapshot_encode_spray_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

/// Shroud-bitmap scratch — flat Uint8Array of explored-tile bits. JS
/// fills before calling snapshot_encode_envelope_emit_shroud which
/// emits the wrapper map (gridW, gridH, cellSize, bitmap) using the
/// MessagePack writer's `write_bin` for the bitmap payload.
struct SnapshotEncodeShroudScratch {
    buf: Vec<u8>,
}

struct SnapshotEncodeShroudScratchHolder(UnsafeCell<Option<SnapshotEncodeShroudScratch>>);
unsafe impl Sync for SnapshotEncodeShroudScratchHolder {}
static SNAPSHOT_ENCODE_SHROUD_SCRATCH: SnapshotEncodeShroudScratchHolder =
    SnapshotEncodeShroudScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_shroud_scratch() -> &'static mut SnapshotEncodeShroudScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SHROUD_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeShroudScratch {
                buf: vec![0u8; 4096],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_shroud_scratch_ptr() -> *const u8 {
    snapshot_encode_shroud_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_shroud_scratch_ensure(byte_count: u32) {
    let s = snapshot_encode_shroud_scratch();
    if s.buf.len() < byte_count as usize {
        s.buf.resize(byte_count as usize, 0);
    }
}

/// Shared numeric scratch for low-frequency top-level snapshot
/// payloads such as terrain and buildability. JS packs one or more
/// number arrays back-to-back, then passes offsets/counts into the
/// dedicated envelope emitters below.
struct SnapshotEncodeNumberScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeNumberScratchHolder(UnsafeCell<Option<SnapshotEncodeNumberScratch>>);
unsafe impl Sync for SnapshotEncodeNumberScratchHolder {}
static SNAPSHOT_ENCODE_NUMBER_SCRATCH: SnapshotEncodeNumberScratchHolder =
    SnapshotEncodeNumberScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_number_scratch() -> &'static mut SnapshotEncodeNumberScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_NUMBER_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeNumberScratch {
                buf: vec![0.0; 4096],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_number_scratch_ptr() -> *const f64 {
    snapshot_encode_number_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_number_scratch_ensure(number_count: u32) {
    let s = snapshot_encode_number_scratch();
    if s.buf.len() < number_count as usize {
        s.buf.resize(number_count as usize, 0.0);
    }
}

#[inline]
fn write_number_array_from_scratch(w: &mut MessagePackWriter, offset: u32, count: u32) {
    let scratch = snapshot_encode_number_scratch();
    let start = offset as usize;
    let n = count as usize;
    w.write_array_header(n);
    for i in 0..n {
        w.write_number(scratch.buf[start + i]);
    }
}

/// Scan-pulse scratch — 6 f64 per pulse:
///   [0] playerId   [1] x   [2] y   [3] z
///   [4] radius     [5] expiresAtTick
/// Field count is fixed (no optionals on NetworkServerSnapshotScanPulse).
const SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE: usize = 6;

struct SnapshotEncodeScanPulseScratch {
    buf: Vec<f64>,
}

struct SnapshotEncodeScanPulseScratchHolder(UnsafeCell<Option<SnapshotEncodeScanPulseScratch>>);
unsafe impl Sync for SnapshotEncodeScanPulseScratchHolder {}
static SNAPSHOT_ENCODE_SCAN_PULSE_SCRATCH: SnapshotEncodeScanPulseScratchHolder =
    SnapshotEncodeScanPulseScratchHolder(UnsafeCell::new(None));

#[inline]
fn snapshot_encode_scan_pulse_scratch() -> &'static mut SnapshotEncodeScanPulseScratch {
    unsafe {
        let cell = &mut *SNAPSHOT_ENCODE_SCAN_PULSE_SCRATCH.0.get();
        if cell.is_none() {
            *cell = Some(SnapshotEncodeScanPulseScratch {
                buf: vec![0.0; SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE * 8],
            });
        }
        cell.as_mut().unwrap()
    }
}

#[wasm_bindgen]
pub fn snapshot_encode_scan_pulse_scratch_ptr() -> *const f64 {
    snapshot_encode_scan_pulse_scratch().buf.as_ptr()
}

#[wasm_bindgen]
pub fn snapshot_encode_scan_pulse_scratch_ensure(count: u32) {
    let needed = (count as usize) * SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE;
    let s = snapshot_encode_scan_pulse_scratch();
    if s.buf.len() < needed {
        s.buf.resize(needed, 0.0);
    }
}

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
            *cell = Some(SnapshotEncodeRemovedIdsScratch {
                buf: vec![0u32; 16],
            });
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
pub fn snapshot_encode_envelope_begin(tick: u32, entity_count: u32, total_key_count: u32) {
    let w = messagepack_writer();
    w.buf.clear();
    w.write_map_header(total_key_count as usize);
    w.write_str("tick");
    w.write_uint(tick as u64);
    w.write_str("entities");
    w.write_array_header(entity_count as usize);
}

/// Append a top-level snapshot key whose value has already been
/// MessagePack-encoded by a transitional JS fallback. This keeps the
/// envelope writer authoritative for key ordering while DP-02 ports
/// the remaining low-frequency DTO fields.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_raw_key_value(key: &str, value: &[u8]) -> u32 {
    let w = messagepack_writer();
    w.write_str(key);
    w.append_raw_value(value);
    w.buf.len() as u32
}

/// Append the `serverMeta` top-level snapshot key. This mirrors the
/// ServerSnapshotMetaBuilder object-literal insertion order so the
/// Rust envelope remains byte-identical with @msgpack/msgpack while
/// removing one always-present raw fallback from the DP-02 hot path.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_server_meta(
    ticks_avg: f64,
    ticks_low: f64,
    ticks_rate: f64,
    snaps_rate_is_string: u8,
    snaps_rate: f64,
    snaps_rate_slot: u32,
    snaps_keyframes_is_string: u8,
    snaps_keyframes: f64,
    snaps_keyframes_slot: u32,
    server_time_slot: u32,
    server_ip_slot: u32,
    grid_enabled: u8,
    has_units_allowed: u8,
    units_allowed_slot_start: u32,
    units_allowed_count: u32,
    has_units_max: u8,
    units_max: f64,
    has_units_count: u8,
    units_count: f64,
    has_mirrors_enabled: u8,
    mirrors_enabled: u8,
    has_force_fields_enabled: u8,
    force_fields_enabled: u8,
    has_force_fields_obstruct_sight: u8,
    force_fields_obstruct_sight: u8,
    has_force_field_reflection_mode: u8,
    force_field_reflection_mode_slot: u32,
    has_fog_of_war_enabled: u8,
    fog_of_war_enabled: u8,
    cpu_avg: f64,
    cpu_hi: f64,
    wind_x: f64,
    wind_y: f64,
    wind_speed: f64,
    wind_angle: f64,
    tilt_ema_slot: u32,
) -> u32 {
    let w = messagepack_writer();

    let mut field_count: usize = 8; // ticks, snaps, server, grid, units, cpu, wind, unitGroundNormalEma
    if has_mirrors_enabled != 0 {
        field_count += 1;
    }
    if has_force_fields_enabled != 0 {
        field_count += 1;
    }
    if has_force_fields_obstruct_sight != 0 {
        field_count += 1;
    }
    if has_force_field_reflection_mode != 0 {
        field_count += 1;
    }
    if has_fog_of_war_enabled != 0 {
        field_count += 1;
    }

    w.write_str("serverMeta");
    w.write_map_header(field_count);

    w.write_str("ticks");
    w.write_map_header(3);
    w.write_str("avg");
    w.write_number(ticks_avg);
    w.write_str("low");
    w.write_number(ticks_low);
    w.write_str("rate");
    w.write_number(ticks_rate);

    w.write_str("snaps");
    w.write_map_header(2);
    w.write_str("rate");
    if snaps_rate_is_string != 0 {
        write_string_from_scratch(w, snaps_rate_slot);
    } else {
        w.write_number(snaps_rate);
    }
    w.write_str("keyframes");
    if snaps_keyframes_is_string != 0 {
        write_string_from_scratch(w, snaps_keyframes_slot);
    } else {
        w.write_number(snaps_keyframes);
    }

    w.write_str("server");
    w.write_map_header(2);
    w.write_str("time");
    write_string_from_scratch(w, server_time_slot);
    w.write_str("ip");
    write_string_from_scratch(w, server_ip_slot);

    w.write_str("grid");
    w.write_bool(grid_enabled != 0);

    let mut units_field_count: usize = 0;
    if has_units_allowed != 0 {
        units_field_count += 1;
    }
    if has_units_max != 0 {
        units_field_count += 1;
    }
    if has_units_count != 0 {
        units_field_count += 1;
    }
    w.write_str("units");
    w.write_map_header(units_field_count);
    if has_units_allowed != 0 {
        w.write_str("allowed");
        let count = units_allowed_count as usize;
        w.write_array_header(count);
        for i in 0..count {
            write_string_from_scratch(w, units_allowed_slot_start + i as u32);
        }
    }
    if has_units_max != 0 {
        w.write_str("max");
        w.write_number(units_max);
    }
    if has_units_count != 0 {
        w.write_str("count");
        w.write_number(units_count);
    }

    if has_mirrors_enabled != 0 {
        w.write_str("mirrorsEnabled");
        w.write_bool(mirrors_enabled != 0);
    }
    if has_force_fields_enabled != 0 {
        w.write_str("forceFieldsEnabled");
        w.write_bool(force_fields_enabled != 0);
    }
    if has_force_fields_obstruct_sight != 0 {
        w.write_str("forceFieldsObstructSight");
        w.write_bool(force_fields_obstruct_sight != 0);
    }
    if has_force_field_reflection_mode != 0 {
        w.write_str("forceFieldReflectionMode");
        write_string_from_scratch(w, force_field_reflection_mode_slot);
    }
    if has_fog_of_war_enabled != 0 {
        w.write_str("fogOfWarEnabled");
        w.write_bool(fog_of_war_enabled != 0);
    }

    w.write_str("cpu");
    w.write_map_header(2);
    w.write_str("avg");
    w.write_number(cpu_avg);
    w.write_str("hi");
    w.write_number(cpu_hi);

    w.write_str("wind");
    w.write_map_header(4);
    w.write_str("x");
    w.write_number(wind_x);
    w.write_str("y");
    w.write_number(wind_y);
    w.write_str("speed");
    w.write_number(wind_speed);
    w.write_str("angle");
    w.write_number(wind_angle);

    w.write_str("unitGroundNormalEma");
    write_string_from_scratch(w, tilt_ema_slot);

    w.buf.len() as u32
}

/// Append the envelope's `projectiles: {...}` nested object.
/// Supports `spawns`, `despawns`, `velocityUpdates`, `beamUpdates`.
/// Called between emit_economy and _continue (pool order: projectiles
/// sits after economy and before gameState).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_projectiles(
    has_spawns: u8,
    spawn_count: u32,
    has_despawns: u8,
    despawn_count: u32,
    has_velocity_updates: u8,
    velocity_update_count: u32,
    has_beam_updates: u8,
    beam_update_count: u32,
) {
    let w = messagepack_writer();
    let mut nested_count: usize = 0;
    if has_spawns != 0 {
        nested_count += 1;
    }
    if has_despawns != 0 {
        nested_count += 1;
    }
    if has_velocity_updates != 0 {
        nested_count += 1;
    }
    if has_beam_updates != 0 {
        nested_count += 1;
    }
    if nested_count == 0 {
        return;
    }

    w.write_str("projectiles");
    w.write_map_header(nested_count);

    // Sub-key order in ProjectileSnapshot (stateSerializerProjectiles.ts
    // _projectilesBuf pool init): spawns, despawns, velocityUpdates,
    // beamUpdates. We emit only the present subset.
    if has_spawns != 0 {
        let n = spawn_count as usize;
        let scratch = snapshot_encode_proj_spawn_scratch();
        w.write_str("spawns");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
            let flags = scratch.buf[base + 26] as u32;
            let has_max_lifespan = (flags & 0x01) != 0;
            let has_shot_id = (flags & 0x02) != 0;
            let has_source_turret_id = (flags & 0x04) != 0;
            let has_is_dgun_true = (flags & 0x08) != 0;
            let has_from_parent_true = (flags & 0x10) != 0;
            let has_beam = (flags & 0x20) != 0;
            let has_target = (flags & 0x40) != 0;
            let has_homing = (flags & 0x80) != 0;
            let has_is_dgun_false = (flags & 0x100) != 0;
            let has_from_parent_false = (flags & 0x200) != 0;
            let has_is_dgun = has_is_dgun_true || has_is_dgun_false;
            let has_from_parent = has_from_parent_true || has_from_parent_false;

            // Field count = always-present 9 (id, pos, rotation,
            // velocity, projectileType, turretId, playerId,
            // sourceEntityId, turretIndex, barrelIndex) -> 10.
            let mut field_count: usize = 10;
            if has_max_lifespan {
                field_count += 1;
            }
            if has_shot_id {
                field_count += 1;
            }
            if has_source_turret_id {
                field_count += 1;
            }
            if has_is_dgun {
                field_count += 1;
            }
            if has_from_parent {
                field_count += 1;
            }
            if has_beam {
                field_count += 1;
            }
            if has_target {
                field_count += 1;
            }
            if has_homing {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order from createPooledProjectileSpawn.
            w.write_str("id");
            w.write_uint(scratch.buf[base] as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 1]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 2]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 3]);
            w.write_str("rotation");
            w.write_number(scratch.buf[base + 4]);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 5]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 6]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 7]);
            w.write_str("projectileType");
            w.write_uint(scratch.buf[base + 8] as u64);
            if has_max_lifespan {
                w.write_str("maxLifespan");
                w.write_number(scratch.buf[base + 9]);
            }
            w.write_str("turretId");
            w.write_uint(scratch.buf[base + 10] as u64);
            if has_shot_id {
                w.write_str("shotId");
                w.write_uint(scratch.buf[base + 11] as u64);
            }
            if has_source_turret_id {
                w.write_str("sourceTurretId");
                w.write_uint(scratch.buf[base + 12] as u64);
            }
            w.write_str("playerId");
            w.write_uint(scratch.buf[base + 13] as u64);
            w.write_str("sourceEntityId");
            w.write_uint(scratch.buf[base + 14] as u64);
            w.write_str("turretIndex");
            w.write_uint(scratch.buf[base + 15] as u64);
            w.write_str("barrelIndex");
            w.write_uint(scratch.buf[base + 16] as u64);
            if has_is_dgun {
                w.write_str("isDGun");
                w.write_bool(has_is_dgun_true);
            }
            if has_from_parent {
                w.write_str("fromParentDetonation");
                w.write_bool(has_from_parent_true);
            }
            if has_beam {
                w.write_str("beam");
                w.write_map_header(2);
                w.write_str("start");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 17]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 18]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 19]);
                w.write_str("end");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 20]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 21]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 22]);
            }
            if has_target {
                w.write_str("targetEntityId");
                w.write_uint(scratch.buf[base + 23] as u64);
            }
            if has_homing {
                w.write_str("homingTurnRate");
                w.write_number(scratch.buf[base + 24]);
            }
        }
    }
    if has_despawns != 0 {
        let n = despawn_count as usize;
        let scratch = snapshot_encode_proj_despawn_scratch();
        w.write_str("despawns");
        w.write_array_header(n);
        for i in 0..n {
            // Despawn DTO: {id: number}
            w.write_map_header(1);
            w.write_str("id");
            w.write_uint(scratch.buf[i] as u64);
        }
    }
    if has_velocity_updates != 0 {
        let n = velocity_update_count as usize;
        let scratch = snapshot_encode_proj_vel_scratch();
        w.write_str("velocityUpdates");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
            let id = scratch.buf[base] as u32;
            let px = scratch.buf[base + 1];
            let py = scratch.buf[base + 2];
            let pz = scratch.buf[base + 3];
            let vx = scratch.buf[base + 4];
            let vy = scratch.buf[base + 5];
            let vz = scratch.buf[base + 6];
            // velocityUpdate DTO: {id, pos: {x, y, z}, velocity: {x, y, z}}
            w.write_map_header(3);
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(px);
            w.write_str("y");
            w.write_number(py);
            w.write_str("z");
            w.write_number(pz);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(vx);
            w.write_str("y");
            w.write_number(vy);
            w.write_str("z");
            w.write_number(vz);
        }
    }
    if has_beam_updates != 0 {
        let n = beam_update_count as usize;
        let header_scratch = snapshot_encode_beam_update_scratch();
        let point_scratch = snapshot_encode_beam_point_scratch();
        w.write_str("beamUpdates");
        w.write_array_header(n);
        let mut point_offset: usize = 0;
        for i in 0..n {
            let h = i * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
            let id = header_scratch.buf[h] as u32;
            let flags = header_scratch.buf[h + 1] as u32;
            let has_obstruction_t = (flags & 0x01) != 0;
            let has_endpoint_damageable_false = (flags & 0x02) != 0;
            let has_endpoint_damageable_true = (flags & 0x04) != 0;
            let has_endpoint_damageable =
                has_endpoint_damageable_false || has_endpoint_damageable_true;
            let obstruction_t = header_scratch.buf[h + 2];
            let point_count = header_scratch.buf[h + 3] as usize;

            // BeamUpdate DTO field count = always 2 (id + points) +
            // optional obstructionT + optional endpointDamageable.
            let mut field_count: usize = 2;
            if has_obstruction_t {
                field_count += 1;
            }
            if has_endpoint_damageable {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order in createPooledBeamUpdate: id, points,
            // obstructionT, endpointDamageable.
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("points");
            w.write_array_header(point_count);
            for p in 0..point_count {
                let pb = (point_offset + p) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE;
                let x = point_scratch.buf[pb];
                let y = point_scratch.buf[pb + 1];
                let z = point_scratch.buf[pb + 2];
                let vx = point_scratch.buf[pb + 3];
                let vy = point_scratch.buf[pb + 4];
                let vz = point_scratch.buf[pb + 5];
                let ax = point_scratch.buf[pb + 6];
                let ay = point_scratch.buf[pb + 7];
                let az = point_scratch.buf[pb + 8];
                let pflags = point_scratch.buf[pb + 9] as u32;
                let has_mirror_id = (pflags & 0x01) != 0;
                let has_reflector_kind = (pflags & 0x02) != 0;
                let kind_is_force_field = (pflags & 0x04) != 0;
                let has_reflector_player = (pflags & 0x08) != 0;
                let has_normal_x = (pflags & 0x10) != 0;
                let has_normal_y = (pflags & 0x20) != 0;
                let has_normal_z = (pflags & 0x40) != 0;
                let mirror_id = point_scratch.buf[pb + 10] as u32;
                let reflector_player = point_scratch.buf[pb + 11] as u32;
                let nx = point_scratch.buf[pb + 12];
                let ny = point_scratch.buf[pb + 13];
                let nz = point_scratch.buf[pb + 14];

                // BeamPoint DTO field count = always 9 (x,y,z,vx,vy,vz,
                // ax,ay,az) + optional reflector + normal fields.
                let mut pf_count: usize = 9;
                if has_mirror_id {
                    pf_count += 1;
                }
                if has_reflector_kind {
                    pf_count += 1;
                }
                if has_reflector_player {
                    pf_count += 1;
                }
                if has_normal_x {
                    pf_count += 1;
                }
                if has_normal_y {
                    pf_count += 1;
                }
                if has_normal_z {
                    pf_count += 1;
                }
                w.write_map_header(pf_count);

                // Pool order from createPooledBeamPoint: x, y, z,
                // vx, vy, vz, ax, ay, az, [mirrorEntityId,
                // reflectorKind, reflectorPlayerId, normalX/Y/Z].
                w.write_str("x");
                w.write_number(x);
                w.write_str("y");
                w.write_number(y);
                w.write_str("z");
                w.write_number(z);
                w.write_str("vx");
                w.write_number(vx);
                w.write_str("vy");
                w.write_number(vy);
                w.write_str("vz");
                w.write_number(vz);
                w.write_str("ax");
                w.write_number(ax);
                w.write_str("ay");
                w.write_number(ay);
                w.write_str("az");
                w.write_number(az);
                if has_mirror_id {
                    w.write_str("mirrorEntityId");
                    w.write_uint(mirror_id as u64);
                }
                if has_reflector_kind {
                    w.write_str("reflectorKind");
                    if kind_is_force_field {
                        w.write_str("forceField");
                    } else {
                        w.write_str("mirror");
                    }
                }
                if has_reflector_player {
                    w.write_str("reflectorPlayerId");
                    w.write_uint(reflector_player as u64);
                }
                if has_normal_x {
                    w.write_str("normalX");
                    w.write_number(nx);
                }
                if has_normal_y {
                    w.write_str("normalY");
                    w.write_number(ny);
                }
                if has_normal_z {
                    w.write_str("normalZ");
                    w.write_number(nz);
                }
            }
            point_offset += point_count;
            if has_obstruction_t {
                w.write_str("obstructionT");
                w.write_number(obstruction_t);
            }
            if has_endpoint_damageable {
                w.write_str("endpointDamageable");
                w.write_bool(has_endpoint_damageable_true);
            }
        }
    }
}

/// Append the minimapEntities array. Called after the last
/// entity in the envelope's `entities[]` is written and BEFORE
/// snapshot_encode_envelope_continue runs (minimapEntities sits
/// between entities and economy in the pool insertion order).
/// Reads count entries from the minimap scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_minimap(count: u32) {
    let w = messagepack_writer();
    let scratch = snapshot_encode_minimap_scratch();
    let n = count as usize;
    w.write_str("minimapEntities");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
        let id = scratch.buf[base] as u32;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let type_tag = scratch.buf[base + 3] as u8;
        let player_id = scratch.buf[base + 4] as u8;
        let radar_packed = scratch.buf[base + 5] as u8;
        let has_radar = (radar_packed & 0x01) != 0;
        let radar_value = (radar_packed & 0x02) != 0;

        // Pool insertion order for the minimap DTO: id, pos, type,
        // playerId, radarOnly.
        let field_count = if has_radar { 5 } else { 4 };
        w.write_map_header(field_count);
        w.write_str("id");
        w.write_uint(id as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("type");
        match type_tag {
            SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
            SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
            _ => w.write_str(""),
        }
        w.write_str("playerId");
        w.write_uint(player_id as u64);
        if has_radar {
            w.write_str("radarOnly");
            w.write_bool(radar_value);
        }
    }
}

/// Append the economy key. Sits between minimapEntities and
/// sprayTargets in pool insertion order. Body is a Record<PlayerId,
/// EconomySnapshot>; the caller pre-packs the economy scratch with
/// per-player data sorted ASC by playerId (so msgpack key iteration
/// matches @msgpack/msgpack on a JS object with integer-string keys),
/// then passes the player count.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_economy(player_count: u32) -> u32 {
    let w = messagepack_writer();
    let n = player_count as usize;
    w.write_str("economy");
    w.write_map_header(n);
    if n == 0 {
        return w.buf.len() as u32;
    }
    let scratch = snapshot_encode_economy_scratch();
    let mut key_buf = [0u8; 12];
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_ECONOMY_STRIDE;
        let player_id = scratch.buf[base] as u32;
        let key_str = u32_to_decimal(&mut key_buf, player_id);
        w.write_str(key_str);

        // Per-player DTO field count = 4 (stockpile, income,
        // expenditure, metal — all required).
        w.write_map_header(4);
        // stockpile: { curr, max }
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 1]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 2]);
        // income: { base, production }
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 3]);
        w.write_str("production");
        w.write_number(scratch.buf[base + 4]);
        // expenditure
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 5]);
        // metal: { stockpile, income, expenditure }
        w.write_str("metal");
        w.write_map_header(3);
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 6]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 7]);
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 8]);
        w.write_str("extraction");
        w.write_number(scratch.buf[base + 9]);
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 10]);
    }
    w.buf.len() as u32
}

/// Append `audioEvents: [...]`. Sits between sprayTargets and
/// projectiles in iteration order. Per-event pool-iteration order
/// matches NetworkServerSnapshotSimEvent / createPooledSimEvent:
/// type, turretId, sourceType, sourceKey, pos, playerId, entityId,
/// deathContext, impactContext, forceFieldImpact, killerPlayerId,
/// victimPlayerId, audioOnly.
///
/// D.3j-27 adds deathContext + impactContext support. Caller pre-packs
/// per-context scratches in event order; the encoder walks audio
/// events with local offsets into each context scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_audio_events(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_audio_event_scratch();
    let death_scratch = snapshot_encode_death_context_scratch();
    let pose_scratch = snapshot_encode_turret_pose_scratch();
    let impact_scratch = snapshot_encode_impact_context_scratch();
    w.write_str("audioEvents");
    w.write_array_header(n);
    let mut death_offset: usize = 0;
    let mut pose_offset: usize = 0;
    let mut impact_offset: usize = 0;
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
        let type_code = scratch.buf[base] as u8;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let pos_z = scratch.buf[base + 3];
        let player_id = scratch.buf[base + 4] as u32;
        let entity_id = scratch.buf[base + 5] as u32;
        let killer_player_id = scratch.buf[base + 6] as u32;
        let victim_player_id = scratch.buf[base + 7] as u32;
        let ff_nx = scratch.buf[base + 8];
        let ff_ny = scratch.buf[base + 9];
        let ff_nz = scratch.buf[base + 10];
        let ff_player_id = scratch.buf[base + 11] as u32;
        let source_type_code = scratch.buf[base + 12] as u8;
        let turret_id_slot = scratch.buf[base + 13] as u32;
        let source_key_slot = scratch.buf[base + 14] as u32;
        let flags = scratch.buf[base + 15] as u32;

        let has_source_type = (flags & 0x001) != 0;
        let has_source_key = (flags & 0x002) != 0;
        let has_player_id = (flags & 0x004) != 0;
        let has_entity_id = (flags & 0x008) != 0;
        let has_ff_impact = (flags & 0x010) != 0;
        let has_killer = (flags & 0x020) != 0;
        let has_victim = (flags & 0x040) != 0;
        let has_audio_only = (flags & 0x080) != 0;
        let audio_only_value = (flags & 0x100) != 0;
        let has_death_context = (flags & 0x200) != 0;
        let has_impact_context = (flags & 0x400) != 0;

        // Per-event field count: 3 always (type, turretId, pos) +
        // optionals.
        let mut field_count: usize = 3;
        if has_source_type {
            field_count += 1;
        }
        if has_source_key {
            field_count += 1;
        }
        if has_player_id {
            field_count += 1;
        }
        if has_entity_id {
            field_count += 1;
        }
        if has_death_context {
            field_count += 1;
        }
        if has_impact_context {
            field_count += 1;
        }
        if has_ff_impact {
            field_count += 1;
        }
        if has_killer {
            field_count += 1;
        }
        if has_victim {
            field_count += 1;
        }
        if has_audio_only {
            field_count += 1;
        }
        w.write_map_header(field_count);

        // Pool-iteration order as documented above.
        w.write_str("type");
        w.write_str(audio_event_type_str(type_code));
        w.write_str("turretId");
        write_string_from_scratch(w, turret_id_slot);
        if has_source_type {
            w.write_str("sourceType");
            w.write_str(audio_event_source_type_str(source_type_code));
        }
        if has_source_key {
            w.write_str("sourceKey");
            write_string_from_scratch(w, source_key_slot);
        }
        w.write_str("pos");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("z");
        w.write_number(pos_z);
        if has_player_id {
            w.write_str("playerId");
            w.write_uint(player_id as u64);
        }
        if has_entity_id {
            w.write_str("entityId");
            w.write_uint(entity_id as u64);
        }
        if has_death_context {
            let db = death_offset * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
            let unit_vel_x = death_scratch.buf[db];
            let unit_vel_y = death_scratch.buf[db + 1];
            let hit_dir_x = death_scratch.buf[db + 2];
            let hit_dir_y = death_scratch.buf[db + 3];
            let proj_vel_x = death_scratch.buf[db + 4];
            let proj_vel_y = death_scratch.buf[db + 5];
            let attack_magnitude = death_scratch.buf[db + 6];
            let radius = death_scratch.buf[db + 7];
            let color = death_scratch.buf[db + 8];
            let visual_radius = death_scratch.buf[db + 9];
            let push_radius = death_scratch.buf[db + 10];
            let base_z = death_scratch.buf[db + 11];
            let rotation = death_scratch.buf[db + 12];
            let unit_type_slot = death_scratch.buf[db + 13] as u32;
            let turret_pose_count = death_scratch.buf[db + 14] as usize;
            let dflags = death_scratch.buf[db + 15] as u32;

            let has_visual_radius = (dflags & 0x01) != 0;
            let has_push_radius = (dflags & 0x02) != 0;
            let has_base_z = (dflags & 0x04) != 0;
            let has_unit_type = (dflags & 0x08) != 0;
            let has_rotation = (dflags & 0x10) != 0;
            let has_turret_poses = (dflags & 0x20) != 0;

            // Field count: 6 always (unitVel, hitDir, projectileVel,
            // attackMagnitude, radius, color) + optionals.
            let mut dc_field_count: usize = 6;
            if has_visual_radius {
                dc_field_count += 1;
            }
            if has_push_radius {
                dc_field_count += 1;
            }
            if has_base_z {
                dc_field_count += 1;
            }
            if has_unit_type {
                dc_field_count += 1;
            }
            if has_rotation {
                dc_field_count += 1;
            }
            if has_turret_poses {
                dc_field_count += 1;
            }

            w.write_str("deathContext");
            w.write_map_header(dc_field_count);

            // Literal order from damageHelpers.ts: unitVel, hitDir,
            // projectileVel, attackMagnitude, radius, visualRadius,
            // pushRadius, baseZ, color, unitType, rotation, turretPoses.
            w.write_str("unitVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(unit_vel_x);
            w.write_str("y");
            w.write_number(unit_vel_y);
            w.write_str("hitDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(hit_dir_x);
            w.write_str("y");
            w.write_number(hit_dir_y);
            w.write_str("projectileVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("attackMagnitude");
            w.write_number(attack_magnitude);
            w.write_str("radius");
            w.write_number(radius);
            if has_visual_radius {
                w.write_str("visualRadius");
                w.write_number(visual_radius);
            }
            if has_push_radius {
                w.write_str("pushRadius");
                w.write_number(push_radius);
            }
            if has_base_z {
                w.write_str("baseZ");
                w.write_number(base_z);
            }
            w.write_str("color");
            w.write_number(color);
            if has_unit_type {
                w.write_str("unitType");
                write_string_from_scratch(w, unit_type_slot);
            }
            if has_rotation {
                w.write_str("rotation");
                w.write_number(rotation);
            }
            if has_turret_poses {
                w.write_str("turretPoses");
                w.write_array_header(turret_pose_count);
                for p in 0..turret_pose_count {
                    let pb = (pose_offset + p) * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
                    let rot = pose_scratch.buf[pb];
                    let pitch = pose_scratch.buf[pb + 1];
                    // Inner pose DTO: {rotation, pitch}
                    w.write_map_header(2);
                    w.write_str("rotation");
                    w.write_number(rot);
                    w.write_str("pitch");
                    w.write_number(pitch);
                }
                pose_offset += turret_pose_count;
            }
            death_offset += 1;
        }
        if has_impact_context {
            let ib = impact_offset * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
            let collision_radius = impact_scratch.buf[ib];
            let explosion_radius = impact_scratch.buf[ib + 1];
            let proj_pos_x = impact_scratch.buf[ib + 2];
            let proj_pos_y = impact_scratch.buf[ib + 3];
            let proj_vel_x = impact_scratch.buf[ib + 4];
            let proj_vel_y = impact_scratch.buf[ib + 5];
            let entity_vel_x = impact_scratch.buf[ib + 6];
            let entity_vel_y = impact_scratch.buf[ib + 7];
            let entity_radius = impact_scratch.buf[ib + 8];
            let pen_dir_x = impact_scratch.buf[ib + 9];
            let pen_dir_y = impact_scratch.buf[ib + 10];

            w.write_str("impactContext");
            // Per the ImpactContext type def, all 5 fields are
            // required: collisionRadius, explosionRadius, projectile,
            // entity, penetrationDir.
            w.write_map_header(5);
            w.write_str("collisionRadius");
            w.write_number(collision_radius);
            w.write_str("explosionRadius");
            w.write_number(explosion_radius);
            w.write_str("projectile");
            w.write_map_header(2);
            w.write_str("pos");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_pos_x);
            w.write_str("y");
            w.write_number(proj_pos_y);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("entity");
            w.write_map_header(2);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(entity_vel_x);
            w.write_str("y");
            w.write_number(entity_vel_y);
            w.write_str("collisionRadius");
            w.write_number(entity_radius);
            w.write_str("penetrationDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(pen_dir_x);
            w.write_str("y");
            w.write_number(pen_dir_y);
            impact_offset += 1;
        }
        if has_ff_impact {
            w.write_str("forceFieldImpact");
            // Pool order: normal, playerId (from copySimEventInto's
            // defensive literal).
            w.write_map_header(2);
            w.write_str("normal");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(ff_nx);
            w.write_str("y");
            w.write_number(ff_ny);
            w.write_str("z");
            w.write_number(ff_nz);
            w.write_str("playerId");
            w.write_uint(ff_player_id as u64);
        }
        if has_killer {
            w.write_str("killerPlayerId");
            w.write_uint(killer_player_id as u64);
        }
        if has_victim {
            w.write_str("victimPlayerId");
            w.write_uint(victim_player_id as u64);
        }
        if has_audio_only {
            w.write_str("audioOnly");
            w.write_bool(audio_only_value);
        }
    }
    w.buf.len() as u32
}

/// Append `sprayTargets: [...]`. Sits between economy and projectiles
/// in iteration order (sprayTargets is in the _snapshotBuf static
/// init). Reads `count` entries (16 f64 each) from the spray scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_spray_targets(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_spray_scratch();
    w.write_str("sprayTargets");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_SPRAY_STRIDE;
        let flags = scratch.buf[base + 15] as u32;
        let type_is_heal = (flags & 0x01) != 0;
        let has_source_z = (flags & 0x02) != 0;
        let has_target_z = (flags & 0x04) != 0;
        let has_target_dim = (flags & 0x08) != 0;
        let has_target_radius = (flags & 0x10) != 0;
        let has_speed = (flags & 0x20) != 0;
        let has_particle_radius = (flags & 0x40) != 0;

        // Outer field count: source, target, type, intensity always +
        // optional speed + particleRadius.
        let mut field_count: usize = 4;
        if has_speed {
            field_count += 1;
        }
        if has_particle_radius {
            field_count += 1;
        }
        w.write_map_header(field_count);

        // source: { id, pos: {x, y}, [z], playerId } in pool order.
        w.write_str("source");
        let src_field_count = if has_source_z { 4 } else { 3 };
        w.write_map_header(src_field_count);
        w.write_str("id");
        w.write_uint(scratch.buf[base] as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(scratch.buf[base + 1]);
        w.write_str("y");
        w.write_number(scratch.buf[base + 2]);
        if has_source_z {
            w.write_str("z");
            w.write_number(scratch.buf[base + 3]);
        }
        w.write_str("playerId");
        w.write_uint(scratch.buf[base + 4] as u64);

        // target: { id, pos: {x, y}, [z], [dim], [radius] } in pool order.
        w.write_str("target");
        let mut tgt_field_count: usize = 2;
        if has_target_z {
            tgt_field_count += 1;
        }
        if has_target_dim {
            tgt_field_count += 1;
        }
        if has_target_radius {
            tgt_field_count += 1;
        }
        w.write_map_header(tgt_field_count);
        w.write_str("id");
        w.write_uint(scratch.buf[base + 5] as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(scratch.buf[base + 6]);
        w.write_str("y");
        w.write_number(scratch.buf[base + 7]);
        if has_target_z {
            w.write_str("z");
            w.write_number(scratch.buf[base + 8]);
        }
        if has_target_dim {
            w.write_str("dim");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(scratch.buf[base + 9]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 10]);
        }
        if has_target_radius {
            w.write_str("radius");
            w.write_number(scratch.buf[base + 11]);
        }

        w.write_str("type");
        if type_is_heal {
            w.write_str("heal");
        } else {
            w.write_str("build");
        }
        w.write_str("intensity");
        w.write_number(scratch.buf[base + 12]);
        if has_speed {
            w.write_str("speed");
            w.write_number(scratch.buf[base + 13]);
        }
        if has_particle_radius {
            w.write_str("particleRadius");
            w.write_number(scratch.buf[base + 14]);
        }
    }
    w.buf.len() as u32
}

/// Close the envelope. Emits the post-projectiles optional keys in
/// stateSerializer.ts pool-insertion order: gameState, isDelta,
/// removedEntityIds, visibilityFiltered. Caller flags gate which
/// appear; map-header count in _begin must match.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_continue(
    has_game_state: u8,
    game_state_phase_slot: u32,
    has_winner_id: u8,
    winner_id: u8,
    is_delta: u8,
    has_removed_entity_ids: u8,
    removed_entity_id_count: u32,
    has_visibility_filtered: u8,
    visibility_filtered: u8,
) -> u32 {
    let w = messagepack_writer();
    if has_game_state != 0 {
        w.write_str("gameState");
        let gs_field_count = if has_winner_id != 0 { 2 } else { 1 };
        w.write_map_header(gs_field_count);
        w.write_str("phase");
        write_string_from_scratch(w, game_state_phase_slot);
        if has_winner_id != 0 {
            w.write_str("winnerId");
            w.write_uint(winner_id as u64);
        }
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

/// Append the shroud wrapper. Sits AFTER scanPulses in iteration
/// order — both lazily added to _snapshotBuf, scanPulses first then
/// shroud. The bitmap bytes come from the shroud scratch (caller
/// pre-fills + supplies byte length).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_shroud(
    grid_w: u32,
    grid_h: u32,
    cell_size: f64,
    bitmap_byte_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let scratch = snapshot_encode_shroud_scratch();
    let n = bitmap_byte_count as usize;
    w.write_str("shroud");
    // Pool order from createShroudDto: gridW, gridH, cellSize, bitmap.
    w.write_map_header(4);
    w.write_str("gridW");
    w.write_uint(grid_w as u64);
    w.write_str("gridH");
    w.write_uint(grid_h as u64);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("bitmap");
    w.write_bin(&scratch.buf[0..n]);
    w.buf.len() as u32
}

/// Append the static `terrain` top-level snapshot key. Full keyframes
/// use this to ship the authoritative TerrainTileMap without falling
/// back to JS object MessagePack encoding.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_terrain(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    subdiv: f64,
    cells_x: f64,
    cells_y: f64,
    vertices_x: f64,
    vertices_y: f64,
    version: f64,
    mesh_vertex_coords_offset: u32,
    mesh_vertex_coords_count: u32,
    mesh_vertex_heights_offset: u32,
    mesh_vertex_heights_count: u32,
    mesh_triangle_indices_offset: u32,
    mesh_triangle_indices_count: u32,
    mesh_triangle_levels_offset: u32,
    mesh_triangle_levels_count: u32,
    mesh_triangle_neighbor_indices_offset: u32,
    mesh_triangle_neighbor_indices_count: u32,
    mesh_triangle_neighbor_levels_offset: u32,
    mesh_triangle_neighbor_levels_count: u32,
    mesh_cell_triangle_offsets_offset: u32,
    mesh_cell_triangle_offsets_count: u32,
    mesh_cell_triangle_indices_offset: u32,
    mesh_cell_triangle_indices_count: u32,
) -> u32 {
    let w = messagepack_writer();
    w.write_str("terrain");
    w.write_map_header(17);

    w.write_str("mapWidth");
    w.write_number(map_width);
    w.write_str("mapHeight");
    w.write_number(map_height);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("subdiv");
    w.write_number(subdiv);
    w.write_str("cellsX");
    w.write_number(cells_x);
    w.write_str("cellsY");
    w.write_number(cells_y);
    w.write_str("verticesX");
    w.write_number(vertices_x);
    w.write_str("verticesY");
    w.write_number(vertices_y);
    w.write_str("version");
    w.write_number(version);

    w.write_str("meshVertexCoords");
    write_number_array_from_scratch(w, mesh_vertex_coords_offset, mesh_vertex_coords_count);
    w.write_str("meshVertexHeights");
    write_number_array_from_scratch(w, mesh_vertex_heights_offset, mesh_vertex_heights_count);
    w.write_str("meshTriangleIndices");
    write_number_array_from_scratch(w, mesh_triangle_indices_offset, mesh_triangle_indices_count);
    w.write_str("meshTriangleLevels");
    write_number_array_from_scratch(w, mesh_triangle_levels_offset, mesh_triangle_levels_count);
    w.write_str("meshTriangleNeighborIndices");
    write_number_array_from_scratch(
        w,
        mesh_triangle_neighbor_indices_offset,
        mesh_triangle_neighbor_indices_count,
    );
    w.write_str("meshTriangleNeighborLevels");
    write_number_array_from_scratch(
        w,
        mesh_triangle_neighbor_levels_offset,
        mesh_triangle_neighbor_levels_count,
    );
    w.write_str("meshCellTriangleOffsets");
    write_number_array_from_scratch(
        w,
        mesh_cell_triangle_offsets_offset,
        mesh_cell_triangle_offsets_count,
    );
    w.write_str("meshCellTriangleIndices");
    write_number_array_from_scratch(
        w,
        mesh_cell_triangle_indices_offset,
        mesh_cell_triangle_indices_count,
    );

    w.buf.len() as u32
}

/// Append the static `buildability` top-level snapshot key. The
/// configKey string is read from string scratch; flags/levels are read
/// from the shared numeric scratch as JS-number arrays so MessagePack
/// integer/float selection stays byte-identical with @msgpack/msgpack.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_buildability(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    cells_x: f64,
    cells_y: f64,
    version: f64,
    config_key_slot: u32,
    flags_offset: u32,
    flags_count: u32,
    levels_offset: u32,
    levels_count: u32,
) -> u32 {
    let w = messagepack_writer();
    w.write_str("buildability");
    w.write_map_header(9);

    w.write_str("mapWidth");
    w.write_number(map_width);
    w.write_str("mapHeight");
    w.write_number(map_height);
    w.write_str("cellSize");
    w.write_number(cell_size);
    w.write_str("cellsX");
    w.write_number(cells_x);
    w.write_str("cellsY");
    w.write_number(cells_y);
    w.write_str("version");
    w.write_number(version);
    w.write_str("configKey");
    write_string_from_scratch(w, config_key_slot);
    w.write_str("flags");
    write_number_array_from_scratch(w, flags_offset, flags_count);
    w.write_str("levels");
    write_number_array_from_scratch(w, levels_offset, levels_count);

    w.buf.len() as u32
}

/// Write `value` in base-10 ASCII into the END of `buf`, return the
/// &str slice covering the digits. Avoids std::fmt allocation in WASM.
#[inline]
fn u32_to_decimal<'a>(buf: &'a mut [u8; 12], mut value: u32) -> &'a str {
    if value == 0 {
        buf[11] = b'0';
        return core::str::from_utf8(&buf[11..12]).unwrap();
    }
    let mut idx = 12;
    while value > 0 {
        idx -= 1;
        buf[idx] = b'0' + (value % 10) as u8;
        value /= 10;
    }
    core::str::from_utf8(&buf[idx..12]).unwrap()
}

/// Append the scanPulses array. Sits AFTER visibilityFiltered in
/// pool-insertion order because scanPulses is added to _snapshotBuf
/// (stateSerializer.ts) lazily on its first non-undefined assignment,
/// not in the static init — so its property slot lands at the end of
/// the iteration order. Reads `count` entries (6 f64 each) from the
/// scan-pulse scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_scan_pulses(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_scan_pulse_scratch();
    w.write_str("scanPulses");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_SCAN_PULSE_STRIDE;
        let player_id = scratch.buf[base] as u32;
        let x = scratch.buf[base + 1];
        let y = scratch.buf[base + 2];
        let z = scratch.buf[base + 3];
        let radius = scratch.buf[base + 4];
        let expires_at_tick = scratch.buf[base + 5] as u32;

        // Pool order from createScanPulseDto: playerId, x, y, z,
        // radius, expiresAtTick. All 6 fields always present.
        w.write_map_header(6);
        w.write_str("playerId");
        w.write_uint(player_id as u64);
        w.write_str("x");
        w.write_number(x);
        w.write_str("y");
        w.write_number(y);
        w.write_str("z");
        w.write_number(z);
        w.write_str("radius");
        w.write_number(radius);
        w.write_str("expiresAtTick");
        w.write_uint(expires_at_tick as u64);
    }
    w.buf.len() as u32
}
