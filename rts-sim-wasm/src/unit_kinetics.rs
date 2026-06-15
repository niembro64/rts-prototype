// unit_kinetics — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

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
//  Server unit-force kernel
//
//  TypeScript gathers unit/body/terrain rows and Rust owns the per-row
//  force decisions: airborne lift, drive thrust, water-wall response,
//  idle braking, movement-acceleration output, hover orientation, and
//  BodyPool acceleration writes. TS only scatters gameplay-facing
//  state that still lives on Entity/Unit objects.
// ─────────────────────────────────────────────────────────────────

pub const UNIT_FORCE_BATCH_STRIDE: usize = 36;

pub(crate) const UF_ROW_DIR_X: usize = 0;
pub(crate) const UF_ROW_DIR_Y: usize = 1;
pub(crate) const UF_ROW_ROTATION: usize = 2;
pub(crate) const UF_ROW_UNIT_MASS: usize = 3;
pub(crate) const UF_ROW_DRIVE_FORCE: usize = 4;
pub(crate) const UF_ROW_TRACTION: usize = 5;
pub(crate) const UF_ROW_GRAVITY_COUNTER_RATIO: usize = 6;
pub(crate) const UF_ROW_HOVER_HEIGHT_FORCE: usize = 7;
pub(crate) const UF_ROW_HOVER_RANDOM_AMOUNT: usize = 8;
pub(crate) const UF_ROW_HOVER_EMA_WEIGHT: usize = 9;
pub(crate) const UF_ROW_HOVER_SMOOTHED_FORCE: usize = 10;
pub(crate) const UF_ROW_HOVER_RANDOM_SAMPLE: usize = 11;
pub(crate) const UF_ROW_GROUND_Z: usize = 12;
pub(crate) const UF_ROW_NORMAL_X: usize = 13;
pub(crate) const UF_ROW_NORMAL_Y: usize = 14;
pub(crate) const UF_ROW_NORMAL_Z: usize = 15;
pub(crate) const UF_ROW_EXTERNAL_FX: usize = 16;
pub(crate) const UF_ROW_EXTERNAL_FY: usize = 17;
pub(crate) const UF_ROW_EXTERNAL_FZ: usize = 18;
pub(crate) const UF_ROW_ORIENTATION_X: usize = 19;
pub(crate) const UF_ROW_ORIENTATION_Y: usize = 20;
pub(crate) const UF_ROW_ORIENTATION_Z: usize = 21;
pub(crate) const UF_ROW_ORIENTATION_W: usize = 22;
pub(crate) const UF_ROW_OMEGA_X: usize = 23;
pub(crate) const UF_ROW_OMEGA_Y: usize = 24;
pub(crate) const UF_ROW_OMEGA_Z: usize = 25;
pub(crate) const UF_ROW_WATER_ESCAPE_MASK_0: usize = 26;
pub(crate) const UF_ROW_WATER_ESCAPE_MASK_1: usize = 27;
pub(crate) const UF_ROW_WATER_ESCAPE_MASK_2: usize = 28;
pub(crate) const UF_ROW_WATER_AHEAD_MASK: usize = 29;
pub(crate) const UF_ROW_MOVEMENT_ACCEL_X: usize = 30;
pub(crate) const UF_ROW_MOVEMENT_ACCEL_Y: usize = 31;
pub(crate) const UF_ROW_MOVEMENT_ACCEL_Z: usize = 32;
pub(crate) const UF_ROW_ANGULAR_ACCEL_X: usize = 33;
pub(crate) const UF_ROW_ANGULAR_ACCEL_Y: usize = 34;
pub(crate) const UF_ROW_ANGULAR_ACCEL_Z: usize = 35;

pub(crate) const UF_FLAG_HAS_THRUST: u32 = 1 << 0;
pub(crate) const UF_FLAG_IS_FLYING: u32 = 1 << 1;
pub(crate) const UF_FLAG_IS_AIRBORNE: u32 = 1 << 2;
pub(crate) const UF_FLAG_BLOCKED_OR_DEAD: u32 = 1 << 3;
pub(crate) const UF_FLAG_HAS_EXTERNAL_FORCE: u32 = 1 << 4;
pub(crate) const UF_FLAG_IN_WATER: u32 = 1 << 5;
pub(crate) const UF_FLAG_AHEAD_IN_WATER: u32 = 1 << 6;
pub(crate) const UF_FLAG_HAS_ORIENTATION: u32 = 1 << 7;

pub(crate) const UF_OUT_MOVEMENT_ACCEL: u32 = 1 << 0;
pub(crate) const UF_OUT_CLEAR_COMBAT: u32 = 1 << 1;
pub(crate) const UF_OUT_ROTATION_DIRTY: u32 = 1 << 2;
pub(crate) const UF_OUT_HOVER_ORIENTATION: u32 = 1 << 3;
pub(crate) const UF_OUT_WOKE_BODY: u32 = 1 << 4;

pub(crate) const UNIT_FORCE_WATER_PROBE_DX: [f64; 8] = [
    1.0,
    0.7071067811865476,
    0.0,
    -0.7071067811865475,
    -1.0,
    -0.7071067811865477,
    0.0,
    0.7071067811865474,
];
pub(crate) const UNIT_FORCE_WATER_PROBE_DY: [f64; 8] = [
    0.0,
    0.7071067811865475,
    1.0,
    0.7071067811865476,
    0.0,
    -0.7071067811865475,
    -1.0,
    -0.7071067811865477,
];

#[inline]
pub(crate) fn unit_force_locomotion_magnitudes(
    drive_force: f64,
    traction: f64,
    mass: f64,
    thrust_multiplier: f64,
    force_scale: f64,
) -> (f64, f64) {
    if !drive_force.is_finite()
        || !traction.is_finite()
        || !mass.is_finite()
        || !thrust_multiplier.is_finite()
        || !force_scale.is_finite()
        || force_scale <= 0.0
        || mass <= 0.0
    {
        return (0.0, 0.0);
    }
    let raw = drive_force * thrust_multiplier * mass / force_scale;
    let traction_mag = raw * traction;
    (
        if raw.is_finite() { raw } else { 0.0 },
        if traction_mag.is_finite() {
            traction_mag
        } else {
            0.0
        },
    )
}

#[inline]
pub(crate) fn unit_force_project_horizontal_onto_slope(
    hx: f64,
    hy: f64,
    nx: f64,
    ny: f64,
    nz: f64,
) -> (f64, f64, f64) {
    let dot = hx * nx + hy * ny;
    let tx = hx - dot * nx;
    let ty = hy - dot * ny;
    let tz = -dot * nz;
    let mag = (tx * tx + ty * ty + tz * tz).sqrt();
    let inv = if mag > 0.0 && mag.is_finite() {
        1.0 / mag
    } else {
        1.0
    };
    (tx * inv, ty * inv, tz * inv)
}

#[inline]
pub(crate) fn unit_force_water_out_from_mask(mask: u32) -> Option<(f64, f64)> {
    let mut ox = 0.0;
    let mut oy = 0.0;
    for i in 0..8 {
        if mask & (1_u32 << i) != 0 {
            ox += UNIT_FORCE_WATER_PROBE_DX[i];
            oy += UNIT_FORCE_WATER_PROBE_DY[i];
        }
    }
    let mag = (ox * ox + oy * oy).sqrt();
    if mag <= 0.0 || !mag.is_finite() {
        None
    } else {
        Some((ox / mag, oy / mag))
    }
}

#[inline]
pub(crate) fn unit_force_first_water_escape_out(rows: &[f64], base: usize) -> Option<(f64, f64)> {
    let masks = [
        rows[base + UF_ROW_WATER_ESCAPE_MASK_0] as u32,
        rows[base + UF_ROW_WATER_ESCAPE_MASK_1] as u32,
        rows[base + UF_ROW_WATER_ESCAPE_MASK_2] as u32,
    ];
    for mask in masks {
        if let Some(out) = unit_force_water_out_from_mask(mask) {
            return Some(out);
        }
    }
    None
}

#[inline]
pub(crate) fn unit_force_idle_brake(
    body_mass: f64,
    vx: f64,
    vy: f64,
    vz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    max_force: f64,
    dt_sec: f64,
) -> (f64, f64, f64) {
    if dt_sec <= 0.0 || max_force <= 0.0 || body_mass <= 0.0 {
        return (0.0, 0.0, 0.0);
    }

    let v_dot_n = vx * nx + vy * ny + vz * nz;
    let tangent_vx = vx - v_dot_n * nx;
    let tangent_vy = vy - v_dot_n * ny;
    let tangent_vz = vz - v_dot_n * nz;

    let slope_gravity_x = GRAVITY * nz * nx;
    let slope_gravity_y = GRAVITY * nz * ny;
    let slope_gravity_z = -GRAVITY + GRAVITY * nz * nz;

    let desired_ax = -slope_gravity_x - tangent_vx / dt_sec;
    let desired_ay = -slope_gravity_y - tangent_vy / dt_sec;
    let desired_az = -slope_gravity_z - tangent_vz / dt_sec;
    let desired_accel_mag =
        (desired_ax * desired_ax + desired_ay * desired_ay + desired_az * desired_az).sqrt();
    if desired_accel_mag <= 1e-6 || !desired_accel_mag.is_finite() {
        return (0.0, 0.0, 0.0);
    }

    let desired_force = desired_accel_mag * body_mass / 1_000_000.0;
    let scale = if desired_force > max_force {
        max_force / desired_force
    } else {
        1.0
    };
    let force_scale = body_mass / 1_000_000.0 * scale;
    (
        desired_ax * force_scale,
        desired_ay * force_scale,
        desired_az * force_scale,
    )
}

#[wasm_bindgen]
pub fn unit_force_step_batch(
    slots: &[u32],
    flags: &[u32],
    rows: &mut [f64],
    out_flags: &mut [u32],
    count: usize,
    dt_sec: f64,
    thrust_multiplier: f64,
    force_scale: f64,
    hover_orientation_k: f64,
    hover_orientation_c: f64,
) -> u32 {
    if slots.len() < count
        || flags.len() < count
        || out_flags.len() < count
        || rows.len() < count * UNIT_FORCE_BATCH_STRIDE
    {
        return 0;
    }

    let p = pool();
    let mut processed = 0_u32;

    for i in 0..count {
        out_flags[i] = 0;
        let slot = slots[i] as usize;
        if slot >= POOL_CAPACITY_USIZE || !pool_is_dynamic_sphere(p, slot) {
            continue;
        }

        let base = i * UNIT_FORCE_BATCH_STRIDE;
        rows[base + UF_ROW_MOVEMENT_ACCEL_X] = 0.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Z] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_X] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Y] = 0.0;
        rows[base + UF_ROW_ANGULAR_ACCEL_Z] = 0.0;

        let flag = flags[i];
        if flag & UF_FLAG_BLOCKED_OR_DEAD != 0 {
            out_flags[i] |= UF_OUT_MOVEMENT_ACCEL | UF_OUT_CLEAR_COMBAT;
            processed += 1;
            continue;
        }

        let has_thrust = flag & UF_FLAG_HAS_THRUST != 0;
        let is_flying = flag & UF_FLAG_IS_FLYING != 0;
        let is_airborne = flag & UF_FLAG_IS_AIRBORNE != 0;
        let has_external = flag & UF_FLAG_HAS_EXTERNAL_FORCE != 0;

        if p.flags[slot] & BODY_FLAG_SLEEPING != 0 && !is_flying && !has_thrust && !has_external {
            continue;
        }

        let body_mass = if p.inv_mass[slot] > 0.0 {
            1.0 / p.inv_mass[slot]
        } else {
            0.0
        };
        let (raw_force_mag, traction_force_mag) = unit_force_locomotion_magnitudes(
            rows[base + UF_ROW_DRIVE_FORCE],
            rows[base + UF_ROW_TRACTION],
            rows[base + UF_ROW_UNIT_MASS],
            thrust_multiplier,
            force_scale,
        );

        let dir_x = rows[base + UF_ROW_DIR_X];
        let dir_y = rows[base + UF_ROW_DIR_Y];
        let dir_len_sq = dir_x * dir_x + dir_y * dir_y;
        let thrust_input_mag = if has_thrust && dir_len_sq > 0.0 {
            dir_len_sq.sqrt()
        } else {
            0.0
        };
        let thrust_scale = thrust_input_mag.min(1.0);

        if has_thrust && !is_airborne {
            let next_rotation = dir_y.atan2(dir_x);
            if next_rotation != rows[base + UF_ROW_ROTATION] {
                rows[base + UF_ROW_ROTATION] = next_rotation;
                out_flags[i] |= UF_OUT_ROTATION_DIRTY;
            }
        }

        let mut thrust_force_x = 0.0;
        let mut thrust_force_y = 0.0;
        let mut thrust_force_z = 0.0;

        if is_airborne {
            let rotation = rows[base + UF_ROW_ROTATION];
            let forward_x = rotation.cos();
            let forward_y = rotation.sin();
            let mut air_target_dir_x = 0.0;
            let mut air_target_dir_y = 0.0;
            let mut air_has_target_dir = false;
            let air_thrust_scale = if has_thrust {
                thrust_scale
            } else if is_flying {
                1.0
            } else {
                0.0
            };
            if has_thrust && thrust_input_mag > 0.0 {
                let inv_dir_mag = 1.0 / thrust_input_mag;
                air_target_dir_x = dir_x * inv_dir_mag;
                air_target_dir_y = dir_y * inv_dir_mag;
                air_has_target_dir = true;
            } else if is_flying {
                air_target_dir_x = forward_x;
                air_target_dir_y = forward_y;
                air_has_target_dir = true;
            }

            let ground_z = rows[base + UF_ROW_GROUND_Z];
            let altitude = (p.pos_z[slot] - ground_z).max(0.5);
            let gravity_counter_ratio = rows[base + UF_ROW_GRAVITY_COUNTER_RATIO];
            let gravity_deficit_ratio = 1.0 - gravity_counter_ratio;
            let base_hover_height_force = if rows[base + UF_ROW_HOVER_HEIGHT_FORCE].is_finite() {
                rows[base + UF_ROW_HOVER_HEIGHT_FORCE]
            } else {
                altitude * gravity_deficit_ratio
            };
            let rand_amount = rows[base + UF_ROW_HOVER_RANDOM_AMOUNT];
            let raw_hover_height_force = if rand_amount > 0.0 {
                let sample = rows[base + UF_ROW_HOVER_RANDOM_SAMPLE];
                base_hover_height_force * (1.0 + (sample * 2.0 - 1.0) * rand_amount)
            } else {
                base_hover_height_force
            };
            let ema_weight = rows[base + UF_ROW_HOVER_EMA_WEIGHT];
            let hover_height_force = if ema_weight > 0.0 {
                let prev = rows[base + UF_ROW_HOVER_SMOOTHED_FORCE];
                let smoothed = if prev.is_finite() {
                    ema_weight * prev + (1.0 - ema_weight) * raw_hover_height_force
                } else {
                    raw_hover_height_force
                };
                rows[base + UF_ROW_HOVER_SMOOTHED_FORCE] = smoothed;
                smoothed
            } else {
                rows[base + UF_ROW_HOVER_SMOOTHED_FORCE] = f64::NAN;
                raw_hover_height_force
            };

            if body_mass > 0.0 && gravity_deficit_ratio > 0.0 && hover_height_force > 0.0 {
                let stable_altitude = hover_height_force / gravity_deficit_ratio;
                if stable_altitude > 0.0 && stable_altitude.is_finite() {
                    let counter_gravity_force = body_mass * GRAVITY * gravity_counter_ratio;
                    let lift_k = body_mass * GRAVITY * hover_height_force;
                    let vz_damp_per_mass =
                        2.0 * ((GRAVITY * gravity_deficit_ratio) / stable_altitude).sqrt();
                    thrust_force_z = (counter_gravity_force + lift_k / altitude
                        - body_mass * vz_damp_per_mass * p.vel_z[slot])
                        / 1_000_000.0;
                }
            }

            if air_has_target_dir {
                let thrust_mag = traction_force_mag * air_thrust_scale;
                if is_flying {
                    // Aircraft-style locomotion: engine thrust follows the nose, while
                    // the requested movement direction is only the yaw target below.
                    // Low traction therefore creates visible drift/wide turns instead
                    // of allowing instant sideways thrust.
                    thrust_force_x = forward_x * thrust_mag;
                    thrust_force_y = forward_y * thrust_mag;
                } else {
                    thrust_force_x = air_target_dir_x * thrust_mag;
                    thrust_force_y = air_target_dir_y * thrust_mag;
                }
            }

            if flag & UF_FLAG_HAS_ORIENTATION != 0 {
                let mut orientation = [
                    rows[base + UF_ROW_ORIENTATION_X],
                    rows[base + UF_ROW_ORIENTATION_Y],
                    rows[base + UF_ROW_ORIENTATION_Z],
                    rows[base + UF_ROW_ORIENTATION_W],
                ];
                let mut omega = [
                    rows[base + UF_ROW_OMEGA_X],
                    rows[base + UF_ROW_OMEGA_Y],
                    rows[base + UF_ROW_OMEGA_Z],
                ];
                let current_yaw = quat_yaw(orientation);
                let target_yaw = if air_has_target_dir {
                    air_target_dir_y.atan2(air_target_dir_x)
                } else {
                    current_yaw
                };
                let target = quat_from_yaw_pitch_roll(target_yaw, 0.0, 0.0);
                let axis_angle = quat_shortest_axis_angle(orientation, target);
                let traction_authority = rows[base + UF_ROW_TRACTION].max(0.0).min(2.0);
                let orientation_k = hover_orientation_k * traction_authority;
                let orientation_c = if orientation_k > 0.0 && hover_orientation_k > 0.0 {
                    hover_orientation_c * (orientation_k / hover_orientation_k).sqrt()
                } else {
                    0.0
                };
                let alpha_x = axis_angle[0] * orientation_k - omega[0] * orientation_c;
                let alpha_y = axis_angle[1] * orientation_k - omega[1] * orientation_c;
                let alpha_z = axis_angle[2] * orientation_k - omega[2] * orientation_c;
                omega[0] += alpha_x * dt_sec;
                omega[1] += alpha_y * dt_sec;
                omega[2] += alpha_z * dt_sec;
                quat_integrate_inplace(&mut orientation, omega, dt_sec);

                rows[base + UF_ROW_ORIENTATION_X] = orientation[0];
                rows[base + UF_ROW_ORIENTATION_Y] = orientation[1];
                rows[base + UF_ROW_ORIENTATION_Z] = orientation[2];
                rows[base + UF_ROW_ORIENTATION_W] = orientation[3];
                rows[base + UF_ROW_OMEGA_X] = omega[0];
                rows[base + UF_ROW_OMEGA_Y] = omega[1];
                rows[base + UF_ROW_OMEGA_Z] = omega[2];
                rows[base + UF_ROW_ANGULAR_ACCEL_X] = alpha_x;
                rows[base + UF_ROW_ANGULAR_ACCEL_Y] = alpha_y;
                rows[base + UF_ROW_ANGULAR_ACCEL_Z] = alpha_z;
                out_flags[i] |= UF_OUT_HOVER_ORIENTATION;

                let next_rotation = quat_yaw(orientation);
                if next_rotation != rows[base + UF_ROW_ROTATION] {
                    rows[base + UF_ROW_ROTATION] = next_rotation;
                    out_flags[i] |= UF_OUT_ROTATION_DIRTY;
                }
            }
        } else {
            let ground_z = rows[base + UF_ROW_GROUND_Z];
            let ground_contact = is_in_contact(ground_z - (p.pos_z[slot] - p.ground_offset[slot]));
            if ground_contact {
                if flag & UF_FLAG_IN_WATER != 0 {
                    if let Some((out_x, out_y)) = unit_force_first_water_escape_out(rows, base) {
                        let wall_push = 3.0 * raw_force_mag;
                        thrust_force_x = out_x * wall_push;
                        thrust_force_y = out_y * wall_push;
                    }
                } else if has_thrust && thrust_input_mag > 0.0 {
                    let inv_dir_mag = 1.0 / thrust_input_mag;
                    let mut use_dir_x = dir_x * inv_dir_mag;
                    let mut use_dir_y = dir_y * inv_dir_mag;

                    if flag & UF_FLAG_AHEAD_IN_WATER != 0 {
                        let mask = rows[base + UF_ROW_WATER_AHEAD_MASK] as u32;
                        if let Some((out_x, out_y)) = unit_force_water_out_from_mask(mask) {
                            let dot_out = use_dir_x * out_x + use_dir_y * out_y;
                            if dot_out < 0.0 {
                                use_dir_x -= dot_out * out_x;
                                use_dir_y -= dot_out * out_y;
                                let mag = (use_dir_x * use_dir_x + use_dir_y * use_dir_y).sqrt();
                                if mag > 1e-3 {
                                    let inv_mag = 1.0 / mag;
                                    use_dir_x *= inv_mag;
                                    use_dir_y *= inv_mag;
                                } else {
                                    use_dir_x = 0.0;
                                    use_dir_y = 0.0;
                                }
                            }
                        }
                    }

                    if use_dir_x != 0.0 || use_dir_y != 0.0 {
                        let thrust_mag = traction_force_mag * thrust_scale;
                        let (tx, ty, tz) = unit_force_project_horizontal_onto_slope(
                            use_dir_x,
                            use_dir_y,
                            rows[base + UF_ROW_NORMAL_X],
                            rows[base + UF_ROW_NORMAL_Y],
                            rows[base + UF_ROW_NORMAL_Z],
                        );
                        thrust_force_x = tx * thrust_mag;
                        thrust_force_y = ty * thrust_mag;
                        thrust_force_z = tz * thrust_mag;
                    }
                } else {
                    let (fx, fy, fz) = unit_force_idle_brake(
                        body_mass,
                        p.vel_x[slot],
                        p.vel_y[slot],
                        p.vel_z[slot],
                        rows[base + UF_ROW_NORMAL_X],
                        rows[base + UF_ROW_NORMAL_Y],
                        rows[base + UF_ROW_NORMAL_Z],
                        traction_force_mag,
                        dt_sec,
                    );
                    thrust_force_x = fx;
                    thrust_force_y = fy;
                    thrust_force_z = fz;
                }
            }
        }

        let external_fx = if has_external {
            rows[base + UF_ROW_EXTERNAL_FX] / 3600.0
        } else {
            0.0
        };
        let external_fy = if has_external {
            rows[base + UF_ROW_EXTERNAL_FY] / 3600.0
        } else {
            0.0
        };
        let external_fz = if has_external {
            rows[base + UF_ROW_EXTERNAL_FZ] / 3600.0
        } else {
            0.0
        };
        let total_force_x = thrust_force_x + external_fx;
        let total_force_y = thrust_force_y + external_fy;
        let total_force_z = thrust_force_z + external_fz;

        if !total_force_x.is_finite() || !total_force_y.is_finite() || !total_force_z.is_finite() {
            continue;
        }

        let movement_accel_scale = p.inv_mass[slot] * 1_000_000.0;
        rows[base + UF_ROW_MOVEMENT_ACCEL_X] = thrust_force_x * movement_accel_scale;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Y] = thrust_force_y * movement_accel_scale;
        rows[base + UF_ROW_MOVEMENT_ACCEL_Z] = thrust_force_z * movement_accel_scale;
        out_flags[i] |= UF_OUT_MOVEMENT_ACCEL;

        if total_force_x != 0.0 || total_force_y != 0.0 || total_force_z != 0.0 {
            if p.flags[slot] & BODY_FLAG_SLEEPING != 0 {
                out_flags[i] |= UF_OUT_WOKE_BODY;
            } else {
                p.sleep_ticks[slot] = 0.0;
            }
            p.accel_x[slot] += total_force_x * 1_000_000.0 * p.inv_mass[slot];
            p.accel_y[slot] += total_force_y * 1_000_000.0 * p.inv_mass[slot];
            p.accel_z[slot] += total_force_z * 1_000_000.0 * p.inv_mass[slot];
        }

        processed += 1;
    }

    processed
}
