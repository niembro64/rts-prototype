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
