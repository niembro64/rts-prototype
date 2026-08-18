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

// For the kinematic position update used below, the discrete critically
// damped spring has a repeated eigenvalue `1 - sqrt(k)*dt`. It is stable only
// while `sqrt(k)*dt < 2`. Keep a 25% margin and split only the inexpensive
// per-body motion/contact arithmetic; terrain sampling and pair broadphases
// remain once per authoritative simulation tick.
const GROUND_SPRING_MAX_DIMENSIONLESS_STEP: f64 = 1.5;
const GROUND_SPRING_MAX_CONTACT_SUBSTEPS: usize = 256;

#[inline]
fn ground_contact_substep_count(dt_sec: f64) -> usize {
    if !dt_sec.is_finite() || dt_sec <= 0.0 {
        return 1;
    }
    let omega = UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT.max(0.0).sqrt();
    if omega <= 0.0 {
        return 1;
    }
    ((omega * dt_sec / GROUND_SPRING_MAX_DIMENSIONLESS_STEP).ceil() as usize)
        .clamp(1, GROUND_SPRING_MAX_CONTACT_SUBSTEPS)
}

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
    if !dt_sec.is_finite() || dt_sec <= 0.0 {
        return;
    }
    let mut x = motion[0];
    let mut y = motion[1];
    let mut z = motion[2];
    let mut vx = motion[3];
    let mut vy = motion[4];
    let mut vz = motion[5];

    let drag_rate = drag_rate_from_coefficient(air_drag_coefficient, inv_mass);
    // Airborne bodies that cannot reach the sampled support during this tick
    // retain the single exact constant-acceleration/linear-drag step. Only a
    // body already touching support, or whose free endpoint would cross it,
    // pays for contact safety substeps.
    let current_penetration = ground_z - (z - ground_offset);
    let mut free_end_z = z;
    let mut free_end_vz = vz;
    integrate_linear_drag_axis(
        &mut free_end_z,
        &mut free_end_vz,
        az_in,
        dt_sec,
        drag_rate,
        wind_z,
    );
    let free_end_penetration = ground_z - (free_end_z - ground_offset);
    let contact_substeps = if is_in_contact(current_penetration)
        || is_in_contact(free_end_penetration)
    {
        ground_contact_substep_count(dt_sec)
    } else {
        1
    };
    let sub_dt = dt_sec / contact_substeps as f64;
    // `ground_damp` is the full-tick exponential retention supplied by the
    // pool. Its per-substep root composes back to exactly the same full-tick
    // tangent damping rather than multiplying the authored damping N times.
    let substep_ground_damp =
        if contact_substeps > 1 && ground_damp.is_finite() && ground_damp >= 0.0 {
            ground_damp.powf(1.0 / contact_substeps as f64)
        } else {
            ground_damp
        };
    let launch_normal_accel = launch_ax * normal_x + launch_ay * normal_y + launch_az * normal_z;

    for substep in 0..contact_substeps {
        let penetration = ground_z - (z - ground_offset);
        let in_contact = is_in_contact(penetration);

        let mut ax_total = ax_in;
        let mut ay_total = ay_in;
        let mut az_total = az_in;
        if in_contact {
            let normal_velocity = vx * normal_x + vy * normal_y + vz * normal_z;
            let spring = ground_spring_accel(penetration, normal_velocity, sub_dt);
            ax_total += normal_x * spring;
            ay_total += normal_y * spring;
            az_total += normal_z * spring;
        }

        integrate_linear_drag_axis(&mut x, &mut vx, ax_total, sub_dt, drag_rate, wind_x);
        integrate_linear_drag_axis(&mut y, &mut vy, ay_total, sub_dt, drag_rate, wind_y);
        integrate_linear_drag_axis(&mut z, &mut vz, az_total, sub_dt, drag_rate, wind_z);

        if in_contact {
            let v_normal = vx * normal_x + vy * normal_y + vz * normal_z;
            let tangent_x = vx - v_normal * normal_x;
            let tangent_y = vy - v_normal * normal_y;
            let tangent_z = vz - v_normal * normal_z;
            vx = v_normal * normal_x + tangent_x * substep_ground_damp;
            vy = v_normal * normal_y + tangent_y * substep_ground_damp;
            vz = v_normal * normal_z + tangent_z * substep_ground_damp;

            // A launch force earns the same total outward-speed allowance as
            // the old one-step path. Use cumulative elapsed time so applying
            // the cap after each safety substep cannot erase a deliberate
            // launch's later-substep acceleration.
            let launch_elapsed = sub_dt * (substep + 1) as f64;
            let launch_outward_speed = if launch_normal_accel.is_finite() {
                (launch_normal_accel * launch_elapsed).max(0.0)
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
    }

    motion[0] = x;
    motion[1] = y;
    motion[2] = z;
    motion[3] = vx;
    motion[4] = vy;
    motion[5] = vz;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step_flat_ground(motion: &mut [f64; 6], rate_hz: f64, seconds: usize) {
        let dt_sec = 1.0 / rate_hz;
        for _ in 0..(rate_hz as usize * seconds) {
            integrate_unit_motion_inline(
                motion, dt_sec, 0.0, 0.0, 0.0, -GRAVITY, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                0.0, 0.0, 0.0, 0.0, 1.0,
            );
        }
    }

    #[test]
    fn ground_contact_uses_tick_aware_discrete_critical_damping() {
        assert!((ground_spring_damping_accel_per_speed(1.0 / 60.0) - 52.5).abs() < 1e-12);
        assert!((ground_spring_damping_accel_per_speed(1.0 / 30.0) - 45.0).abs() < 1e-12);
        assert!((ground_spring_damping_accel_per_speed(1.0 / 20.0) - 37.5).abs() < 1e-12);
    }

    #[test]
    fn ground_contact_substeps_only_beyond_the_discrete_stability_margin() {
        assert_eq!(ground_contact_substep_count(1.0 / 60.0), 1);
        assert_eq!(ground_contact_substep_count(1.0 / 30.0), 1);
        assert_eq!(ground_contact_substep_count(1.0 / 20.0), 1);
        assert_eq!(ground_contact_substep_count(1.0 / 15.0), 2);
        assert_eq!(ground_contact_substep_count(1.0 / 10.0), 2);
        assert_eq!(ground_contact_substep_count(1.0 / 5.0), 4);
        assert_eq!(ground_contact_substep_count(1.0), 20);
    }

    #[test]
    fn flat_ground_contact_settles_at_every_supported_server_rate() {
        for rate_hz in [1.0, 5.0, 10.0, 15.0, 20.0, 30.0, 45.0, 60.0] {
            let mut motion = [0.0; 6];
            step_flat_ground(&mut motion, rate_hz, 12);
            let equilibrium_z = -GRAVITY / UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT;
            assert!(
                (motion[2] - equilibrium_z).abs() < 1e-9,
                "{rate_hz} Hz ground height did not settle: {}",
                motion[2]
            );
            assert!(
                motion[5].abs() < 1e-9,
                "{rate_hz} Hz vertical speed did not settle: {}",
                motion[5]
            );
        }
    }
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
