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
//  Batched PhysicsEngine3D.integrate() — Phase 3a
//
//  Runs the full integrate() loop over every awake dynamic sphere
//  body in ONE WASM call. Eliminates the per-body marshalling cost
//  that Phase 2's `step_unit_motion` boundary calls still paid.
//
//  Buffer layout (per body, 19 f64s = 152 bytes):
//    0..6   x, y, z, vx, vy, vz           (in/out — motion)
//    6..9   ax, ay, az                    (in — authored accel; gravity added inside)
//    9..12  launch_ax, launch_ay, launch_az (in — only contributes to rebound cap)
//    12     ground_offset                 (in)
//    13..17 ground_z, normal_x/y/z        (in — pre-sampled JS-side)
//    17     sleeping_flag                 (in 0.0; out 0.0 still-awake, 1.0 just-slept)
//    18     sleep_ticks                   (in/out f64 counter)
//
//  Caller responsibility:
//    - Pack only awake dynamic SPHERE bodies (sleeping bodies skip
//      integration today; non-sphere dynamic bodies use the old
//      free-Euler TS path and aren't in the buffer).
//    - Pre-sample ground_z + normal per body. Gate the normal sample
//      on penetration if you want to skip the expensive gradient
//      lookup for airborne bodies (same optimization as Phase 2).
//    - On return, scan the sleeping_flag for 0→1 transitions: those
//      are bodies that just slept this step; clear their force
//      accumulators in the JS Body3D mirror and decrement
//      awakeDynamicBodyCount.
//
//  Sleep heuristic note: the per-body sleep check re-samples ground_z
//  at the body's NEW position in the TS implementation. The batched
//  Rust path uses the STARTING ground_z instead (the pre-sampled
//  value). For sleep-eligible bodies (speed ≤ 0.5 wu/s) the per-tick
//  displacement is at most ~0.008 wu — terrain elevation can't
//  change meaningfully across that distance, so the approximation
//  is numerically indistinguishable from the original. If a future
//  change adds high-speed sleep cases this assumption must be
//  revisited; today it's free.
// ─────────────────────────────────────────────────────────────────

pub const STEP_UNIT_MOTIONS_BATCH_STRIDE: usize = 19;

#[wasm_bindgen]
pub fn step_unit_motions_batch(
    buf: &mut [f64],
    count: usize,
    dt_sec: f64,
    air_damp: f64,
    ground_damp: f64,
) {
    debug_assert!(
        buf.len() >= count * STEP_UNIT_MOTIONS_BATCH_STRIDE,
        "step_unit_motions_batch buffer too small"
    );
    let stride = STEP_UNIT_MOTIONS_BATCH_STRIDE;
    for i in 0..count {
        let base = i * stride;
        let slot = &mut buf[base..base + stride];

        let ground_offset = slot[12];
        let ground_z = slot[13];
        let normal_x = slot[14];
        let normal_y = slot[15];
        let normal_z = slot[16];

        // authoredAccelSq is measured BEFORE adding gravity — it
        // represents external force only, matching the TS path's
        // `b.ax * b.ax + b.ay * b.ay + b.az * b.az` check.
        let authored_ax = slot[6];
        let authored_ay = slot[7];
        let authored_az = slot[8];
        let authored_accel_sq =
            authored_ax * authored_ax + authored_ay * authored_ay + authored_az * authored_az;

        // Gravity is added to az BEFORE the integrate helper runs.
        // Matches PhysicsEngine3D.ts integrate(): `let az = b.az - GRAVITY`.
        let ax_with_g = authored_ax;
        let ay_with_g = authored_ay;
        let az_with_g = authored_az - GRAVITY;

        let launch_ax = slot[9];
        let launch_ay = slot[10];
        let launch_az = slot[11];

        let motion: &mut [f64; 6] = (&mut slot[0..6]).try_into().unwrap();
        integrate_unit_motion_inline(
            motion,
            dt_sec,
            ground_offset,
            ax_with_g, ay_with_g, az_with_g,
            air_damp, ground_damp,
            launch_ax, launch_ay, launch_az,
            ground_z,
            normal_x, normal_y, normal_z,
        );

        // Re-load mutated motion for the sleep check.
        let x = slot[0];
        let y = slot[1];
        let z = slot[2];
        let vx = slot[3];
        let vy = slot[4];
        let vz = slot[5];
        let _ = (x, y); // silence unused-binding lint — kept for symmetry

        // Sleep heuristic. Uses the STARTING ground_z (pre-sampled JS-
        // side) as an approximation; see header comment for why this
        // is exact for sleep-eligible bodies.
        let speed_sq = vx * vx + vy * vy + vz * vz;
        let mut sleep_ticks = slot[18];
        let mut sleeping_flag = 0.0_f64;
        if authored_accel_sq <= SLEEP_ACCEL_SQ && speed_sq <= SLEEP_SPEED_SQ {
            let next_penetration = ground_z - (z - ground_offset);
            if is_in_contact(next_penetration)
                && next_penetration <= SLEEP_GROUND_PENETRATION_EPS
            {
                sleep_ticks += 1.0;
                if sleep_ticks >= SLEEP_TICKS {
                    // Snap to surface + zero velocity exactly as
                    // PhysicsEngine3D.sleepBody does.
                    slot[2] = ground_z + ground_offset;
                    slot[3] = 0.0;
                    slot[4] = 0.0;
                    slot[5] = 0.0;
                    sleep_ticks = SLEEP_TICKS;
                    sleeping_flag = 1.0;
                }
            } else {
                sleep_ticks = 0.0;
            }
        } else {
            sleep_ticks = 0.0;
        }
        slot[17] = sleeping_flag;
        slot[18] = sleep_ticks;
    }
}

// ─────────────────────────────────────────────────────────────────
//  Phase 3c — Sphere-vs-sphere contact resolver + broadphase
//
//  Ports PhysicsEngine3D.ts `rebuildContactCells()` AND the
//  iterated `resolveSphereSphereContacts()` loop into one batched
//  WASM call. JS-side per-tick work shrinks to: pack body state,
//  call this once, unpack body state + wake/upward-contact flags.
//
//  Cell broadphase matches the TS implementation exactly:
//    - Bucket each body by its CENTER (one cell each).
//    - cx/cy: floor(v / cell_size).
//    - cz:    floor((v + cell_size/2) / cell_size)   ← half-cell bias
//             so z=0 falls in the MIDDLE of the bottom cell instead
//             of straddling an edge (ground units cluster cleanly).
//    - Cell key encoding: same 48-bit pack as packContactCellKey
//      in PhysicsEngine3D.ts — useful when cross-reading WASM and
//      TS log dumps side-by-side.
//    - Neighbor range scales with max radius across all bodies so
//      the largest active push pair stays in-window even if its
//      centers are more than one cell apart.
//
//  Iteration: caller passes the sub-iteration budget (TS computes
//  it from awake-body count via getSphereIterationBudget). The
//  whole 1..4-pass loop happens inside this one WASM call.
//
//  Sleeping bodies: TS iterates them in the broadphase even when
//  sleeping (see the long comment around line 806 of
//  PhysicsEngine3D.ts) so that a sleeping body which spawns into
//  another body's slot still gets pushed apart. We match that here:
//  every body gets a broadphase entry, no sleep filter. The
//  wake_flag in the output buffer is set when a pair resolves; JS
//  then runs `wakeBody` on the marked entries (no-op if already
//  awake — same as the TS path).
//
//  Buffer layout per body (RESOLVE_SPHERE_SPHERE_STRIDE = 13 f64s):
//    0..6  x, y, z, vx, vy, vz             in/out
//    6     radius                           in
//    7     inv_mass                         in
//    8     restitution                      in
//    9     entity_id_or_zero                in   (0 = use buffer index)
//    10    sleeping_flag                    in   (informational; resolver doesn't gate)
//    11    wake_flag                        out  (1.0 if a pair resolved on this body)
//    12    upward_contact_flag              out  (1.0 if got an upward-normal contact)
// ─────────────────────────────────────────────────────────────────

pub const RESOLVE_SPHERE_SPHERE_STRIDE: usize = 13;

const CONTACT_CELL_BIAS: i64 = 32768;
const CONTACT_CELL_MASK: i64 = 0xFFFF;

#[inline]
fn pack_contact_cell_key(cx: i32, cy: i32, cz: i32) -> u64 {
    let cxb = ((cx as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    let cyb = ((cy as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    let czb = ((cz as i64 + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK) as u64;
    (cxb << 32) | (cyb << 16) | czb
}

#[wasm_bindgen]
pub fn resolve_sphere_sphere_contacts(
    buf: &mut [f64],
    count: usize,
    iterations: usize,
    cell_size: f64,
) {
    let stride = RESOLVE_SPHERE_SPHERE_STRIDE;
    debug_assert!(
        buf.len() >= count * stride,
        "resolve_sphere_sphere_contacts buffer too small"
    );
    if count == 0 || iterations == 0 || cell_size <= 0.0 {
        return;
    }

    let half_cs = cell_size * 0.5;

    // Bucket bodies by center cell. Done once, reused across all
    // sub-iterations — matches the TS path where rebuildContactCells
    // runs once before the iteration loop and small positional drift
    // from sub-passes is well below CONTACT_CELL_SIZE.
    let mut cells: HashMap<u64, Vec<u32>> = HashMap::new();
    let mut max_radius = 0.0_f64;
    for i in 0..count {
        let base = i * stride;
        let x = buf[base];
        let y = buf[base + 1];
        let z = buf[base + 2];
        let r = buf[base + 6];
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

    for _iter in 0..iterations {
        for i in 0..count {
            let base_a = i * stride;
            let ar = buf[base_a + 6];
            let a_inv_mass = buf[base_a + 7];
            let a_restitution = buf[base_a + 8];

            // Re-cell the body each iteration on its CURRENT position.
            // Drift across sub-passes is small but visible; the TS path
            // also re-reads `a.x`, `a.y`, `a.z` each iter through the
            // outer cell-coord computation.
            let acx = (buf[base_a] / cell_size).floor() as i32;
            let acy = (buf[base_a + 1] / cell_size).floor() as i32;
            let acz = ((buf[base_a + 2] + half_cs) / cell_size).floor() as i32;

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
                            let base_b = j * stride;
                            let br = buf[base_b + 6];

                            // Re-read positions fresh per pair — earlier
                            // pairs may have pushed a or b this iter.
                            let ax = buf[base_a];
                            let ay = buf[base_a + 1];
                            let az = buf[base_a + 2];
                            let bx = buf[base_b];
                            let by = buf[base_b + 1];
                            let bz = buf[base_b + 2];

                            let ddx = bx - ax;
                            let ddy = by - ay;
                            let ddz = bz - az;
                            let r_sum = ar + br;
                            let dist_sq = ddx * ddx + ddy * ddy + ddz * ddz;
                            if dist_sq >= r_sum * r_sum {
                                continue;
                            }

                            // Both bodies got involved in a pair → mark
                            // wake flags. wakeBody on the JS side is
                            // idempotent so we don't gate on prior state.
                            buf[base_a + 11] = 1.0;
                            buf[base_b + 11] = 1.0;

                            let dist: f64;
                            let nx: f64;
                            let ny: f64;
                            let nz: f64;
                            if dist_sq < 1e-12 {
                                // Degenerate: pick a deterministic random
                                // horizontal direction from the entity-id
                                // hash. Matches the TS path's seed scheme
                                // bit-for-bit when entity ids are small
                                // enough to fit JS int32 mul; for ids that
                                // wrap, the seed differs but the case is
                                // vanishingly rare (two centers exactly
                                // co-located).
                                let a_id_raw = buf[base_a + 9] as u64;
                                let b_id_raw = buf[base_b + 9] as u64;
                                let a_id = if a_id_raw == 0 { i as u64 } else { a_id_raw };
                                let b_id = if b_id_raw == 0 { j as u64 } else { b_id_raw };
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
                            let b_inv_mass = buf[base_b + 7];
                            let inv_mass_sum_inv = 1.0 / (a_inv_mass + b_inv_mass);
                            let w_a = a_inv_mass * inv_mass_sum_inv;
                            let w_b = b_inv_mass * inv_mass_sum_inv;
                            buf[base_a] = ax - nx * penetration * w_a;
                            buf[base_a + 1] = ay - ny * penetration * w_a;
                            buf[base_a + 2] = az - nz * penetration * w_a;
                            buf[base_b] = bx + nx * penetration * w_b;
                            buf[base_b + 1] = by + ny * penetration * w_b;
                            buf[base_b + 2] = bz + nz * penetration * w_b;

                            if nz > 0.35 {
                                buf[base_b + 12] = 1.0;
                            } else if nz < -0.35 {
                                buf[base_a + 12] = 1.0;
                            }

                            let a_vx = buf[base_a + 3];
                            let a_vy = buf[base_a + 4];
                            let a_vz = buf[base_a + 5];
                            let b_vx = buf[base_b + 3];
                            let b_vy = buf[base_b + 4];
                            let b_vz = buf[base_b + 5];
                            let rvx = b_vx - a_vx;
                            let rvy = b_vy - a_vy;
                            let rvz = b_vz - a_vz;
                            let v_dot_n = rvx * nx + rvy * ny + rvz * nz;
                            if v_dot_n >= 0.0 {
                                continue;
                            }
                            let b_restitution = buf[base_b + 8];
                            let e = a_restitution.min(b_restitution);
                            let j_mag = -(1.0 + e) * v_dot_n * inv_mass_sum_inv;
                            let ix = j_mag * nx;
                            let iy = j_mag * ny;
                            let iz = j_mag * nz;
                            buf[base_a + 3] = a_vx - ix * a_inv_mass;
                            buf[base_a + 4] = a_vy - iy * a_inv_mass;
                            buf[base_a + 5] = a_vz - iz * a_inv_mass;
                            buf[base_b + 3] = b_vx + ix * b_inv_mass;
                            buf[base_b + 4] = b_vy + iy * b_inv_mass;
                            buf[base_b + 5] = b_vz + iz * b_inv_mass;
                        }
                    }
                }
            }
        }
    }
}

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
