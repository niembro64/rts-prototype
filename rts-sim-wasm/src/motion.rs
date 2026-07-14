// motion — extracted from lib.rs (pure code motion).

use crate::air_drag::{drag_rate_from_coefficient, integrate_linear_drag_axis};
#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────
//  Contact-cell broadphase encoding (shared helper)
//
//  Mirrors the JS-side packContactCellKey in PhysicsEngine3D.ts —
//  16-bit cx + 16-bit cy + 16-bit cz packed into a u64. Used by
//  the sphere-sphere broadphase in pool_resolve_sphere_sphere
//  (Phase 3d-2).
// ─────────────────────────────────────────────────────────────────
pub(crate) const CONTACT_CELL_BIAS: i64 = 32768;
pub(crate) const CONTACT_CELL_MASK: i64 = 0xFFFF;

#[inline]
pub(crate) fn pack_contact_cell_key(cx: i32, cy: i32, cz: i32) -> u64 {
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

/// Internal math kernel: applies authored acceleration, wind-relative
/// air-drag force, contact spring, and ground friction to a
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
pub(crate) fn integrate_unit_motion_inline(
    motion: &mut [f64; 6],
    dt_sec: f64,
    ground_offset: f64,
    ax_in: f64,
    ay_in: f64,
    az_in: f64,
    air_drag_coefficient: f64,
    inv_mass: f64,
    ground_damp: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
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

    let drag_rate = drag_rate_from_coefficient(air_drag_coefficient, inv_mass);
    integrate_linear_drag_axis(&mut x, &mut vx, ax_total, dt_sec, drag_rate, wind_x);
    integrate_linear_drag_axis(&mut y, &mut vy, ay_total, dt_sec, drag_rate, wind_y);
    integrate_linear_drag_axis(&mut z, &mut vz, az_total, dt_sec, drag_rate, wind_z);

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
    air_drag_coefficient: f64,
    inv_mass: f64,
    ground_damp: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
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
    // Release builds must not panic the authoritative sim on a
    // malformed JS-side buffer — silently skipping the step is the
    // recoverable failure; the debug_assert above catches it in dev.
    if motion.len() < 6 {
        return;
    }
    let m: &mut [f64; 6] = (&mut motion[0..6]).try_into().unwrap();
    integrate_unit_motion_inline(
        m,
        dt_sec,
        ground_offset,
        ax,
        ay,
        az,
        air_drag_coefficient,
        inv_mass,
        ground_damp,
        wind_x,
        wind_y,
        wind_z,
        launch_ax,
        launch_ay,
        launch_az,
        ground_z,
        normal_x,
        normal_y,
        normal_z,
    );
}

#[wasm_bindgen]
pub fn client_predict_unit_motion_batch(
    count: u32,
    motions: &mut [f64],
    ground_offsets: &[f64],
    ground_z: &[f64],
    ground_normals: &[f64],
    air_drag_coefficients: &[f64],
    inv_mass: &[f64],
    yaw_rates: &[f64],
    coordinated_turn_flags: &[u8],
    dt_sec: f64,
    ground_damp: f64,
    wind_x: f64,
    wind_y: f64,
    wind_z: f64,
    rest_penetration_epsilon: f64,
    rest_speed_sq: f64,
) {
    let count = count as usize;
    debug_assert!(motions.len() >= count * 6);
    debug_assert!(ground_offsets.len() >= count);
    debug_assert!(ground_z.len() >= count);
    debug_assert!(ground_normals.len() >= count * 3);
    debug_assert!(air_drag_coefficients.len() >= count);
    debug_assert!(inv_mass.len() >= count);
    debug_assert!(yaw_rates.len() >= count);
    debug_assert!(coordinated_turn_flags.len() >= count);
    if air_drag_coefficients.len() < count
        || inv_mass.len() < count
        || yaw_rates.len() < count
        || coordinated_turn_flags.len() < count
    {
        return;
    }

    for i in 0..count {
        let base = i * 6;
        let ground_offset = ground_offsets[i];
        let g_z = ground_z[i];
        let penetration = g_z - (motions[base + 2] - ground_offset);
        if is_in_contact(penetration) && penetration <= rest_penetration_epsilon {
            let vx = motions[base + 3];
            let vy = motions[base + 4];
            let vz = motions[base + 5];
            let speed_sq = vx * vx + vy * vy + vz * vz;
            if speed_sq <= rest_speed_sq {
                motions[base + 2] = g_z + ground_offset;
                motions[base + 3] = 0.0;
                motions[base + 4] = 0.0;
                motions[base + 5] = 0.0;
                continue;
            }
        }

        // Airframes do not travel along a series of snapshot-length straight
        // chords while their body yaw turns continuously. Rotate horizontal
        // velocity by half the predicted yaw step before position integration
        // and by the other half afterward. This is a midpoint integration of
        // coordinated curved flight: position and heading advance together at
        // render cadence, speed is preserved, and the latest snapshot still
        // owns the state through the client drift channels.
        let coordinated_turn = coordinated_turn_flags[i] != 0
            && yaw_rates[i].is_finite()
            && dt_sec.is_finite()
            && dt_sec > 0.0;
        let half_turn = if coordinated_turn {
            yaw_rates[i] * dt_sec * 0.5
        } else {
            0.0
        };
        let (half_turn_sin, half_turn_cos) = half_turn.sin_cos();
        let (mid_vx, mid_vy) = if coordinated_turn {
            let vx = motions[base + 3];
            let vy = motions[base + 4];
            (
                half_turn_cos * vx - half_turn_sin * vy,
                half_turn_sin * vx + half_turn_cos * vy,
            )
        } else {
            (motions[base + 3], motions[base + 4])
        };

        let mut motion = [
            motions[base],
            motions[base + 1],
            motions[base + 2],
            mid_vx,
            mid_vy,
            motions[base + 5],
        ];
        integrate_unit_motion_inline(
            &mut motion,
            dt_sec,
            ground_offset,
            0.0,
            0.0,
            0.0,
            air_drag_coefficients[i],
            inv_mass[i],
            ground_damp,
            wind_x,
            wind_y,
            wind_z,
            0.0,
            0.0,
            0.0,
            g_z,
            ground_normals[i * 3],
            ground_normals[i * 3 + 1],
            ground_normals[i * 3 + 2],
        );
        motions[base] = motion[0];
        motions[base + 1] = motion[1];
        motions[base + 2] = motion[2];
        if coordinated_turn {
            motions[base + 3] = half_turn_cos * motion[3] - half_turn_sin * motion[4];
            motions[base + 4] = half_turn_sin * motion[3] + half_turn_cos * motion[4];
        } else {
            motions[base + 3] = motion[3];
            motions[base + 4] = motion[4];
        }
        motions[base + 5] = motion[5];
    }
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
