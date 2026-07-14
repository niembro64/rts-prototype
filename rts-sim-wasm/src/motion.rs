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
//  Shared unit-motion integrator used by authoritative pool kernels.
//
//  Convention: ground sampling is the CALLER'S job (they know the
//  body's x,y already). Pass the pre-sampled groundZ + normal in.
//  The kernel only consults the normal if penetration is in contact;
//  the JS wrapper should still gate getGroundNormal() on the
//  pre-computed penetration to preserve the existing "skip the
//  expensive normal sample when in the air" optimization.
//
//  The motion slice is [x, y, z, vx, vy, vz] in/out (6 f64s).
//  Canonical state lives in the Rust SoA body pool.
// ─────────────────────────────────────────────────────────────────

/// Internal math kernel: applies authored acceleration, wind-relative
/// air-drag force, contact spring, and ground friction to a
/// single body's motion state. Operates on a fixed-size [6] slice
/// without heap traffic.
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

// ─────────────────────────────────────────────────────────────────
//  Buffer-based step_unit_motions_batch (Phase 3a) and
//  resolve_sphere_sphere_contacts (Phase 3c) were superseded by
//  the pool-backed pool_step_integrate / pool_resolve_sphere_sphere
//  in Phase 3d-2 — both bodies' state lives in the BodyPool now,
//  so the per-tick pack/unpack scratch buffer is gone. The old
//  functions are deleted; the inline integration helper above is shared by
//  the authoritative pool-backed kernels below.
// ─────────────────────────────────────────────────────────────────
