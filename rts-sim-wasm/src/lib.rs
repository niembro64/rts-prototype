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

    let mut x = motion[0];
    let mut y = motion[1];
    let mut z = motion[2];
    let mut vx = motion[3];
    let mut vy = motion[4];
    let mut vz = motion[5];

    let penetration = ground_z - (z - ground_offset);
    let in_contact = is_in_contact(penetration);

    // Add ground spring acceleration to the input forces if in contact.
    let mut ax_total = ax;
    let mut ay_total = ay;
    let mut az_total = az;
    if in_contact {
        let normal_velocity = vx * normal_x + vy * normal_y + vz * normal_z;
        let spring = ground_spring_accel(penetration, normal_velocity);
        ax_total += normal_x * spring;
        ay_total += normal_y * spring;
        az_total += normal_z * spring;
    }

    // Velocity update + air damp.
    vx += ax_total * dt_sec;
    vy += ay_total * dt_sec;
    vz += az_total * dt_sec;
    vx *= air_damp;
    vy *= air_damp;
    vz *= air_damp;

    // Ground tangent damping + passive rebound limit (in-contact only).
    if in_contact {
        // Damp the component of velocity tangent to the ground,
        // leaving the normal component untouched.
        let v_normal = vx * normal_x + vy * normal_y + vz * normal_z;
        let tangent_x = vx - v_normal * normal_x;
        let tangent_y = vy - v_normal * normal_y;
        let tangent_z = vz - v_normal * normal_z;
        vx = v_normal * normal_x + tangent_x * ground_damp;
        vy = v_normal * normal_y + tangent_y * ground_damp;
        vz = v_normal * normal_z + tangent_z * ground_damp;

        // Cap outward (ground-normal-positive) velocity to the
        // passive rebound max + any active launch contribution.
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

    // Position update.
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
