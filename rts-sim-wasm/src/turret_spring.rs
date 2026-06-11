// turret_spring — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use crate::*;

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
pub(crate) fn normalize_angle_ts(mut angle: f64) -> f64 {
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
    let (angle, angular_vel, angular_acc) = compute_damped_rotation(
        angle,
        angular_vel,
        target_angle,
        k,
        c,
        dt_sec,
        flags,
        min_angle,
        max_angle,
    );
    out_buf[0] = angle;
    out_buf[1] = angular_vel;
    out_buf[2] = angular_acc;
}

#[inline]
pub(crate) fn compute_damped_rotation(
    angle: f64,
    angular_vel: f64,
    target_angle: f64,
    k: f64,
    c: f64,
    dt_sec: f64,
    flags: u32,
    min_angle: f64,
    max_angle: f64,
) -> (f64, f64, f64) {
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
    (new_angle, new_vel, out_acc)
}

#[wasm_bindgen]
pub fn turret_rotation_step_batch(
    current_yaw: &[f64],
    yaw_velocity: &[f64],
    target_yaw: &[f64],
    current_pitch: &[f64],
    pitch_velocity: &[f64],
    target_pitch: &[f64],
    turn_accel: &[f64],
    drag: &[f64],
    out_yaw: &mut [f64],
    out_yaw_velocity: &mut [f64],
    out_yaw_acceleration: &mut [f64],
    out_pitch: &mut [f64],
    out_pitch_velocity: &mut [f64],
    out_pitch_acceleration: &mut [f64],
    out_aim_error_yaw: &mut [f64],
    out_aim_error_pitch: &mut [f64],
    count: u32,
    dt_sec: f64,
    pitch_min: f64,
    pitch_max: f64,
) -> u32 {
    let count = count as usize;
    debug_assert!(current_yaw.len() >= count);
    debug_assert!(yaw_velocity.len() >= count);
    debug_assert!(target_yaw.len() >= count);
    debug_assert!(current_pitch.len() >= count);
    debug_assert!(pitch_velocity.len() >= count);
    debug_assert!(target_pitch.len() >= count);
    debug_assert!(turn_accel.len() >= count);
    debug_assert!(drag.len() >= count);
    debug_assert!(out_yaw.len() >= count);
    debug_assert!(out_yaw_velocity.len() >= count);
    debug_assert!(out_yaw_acceleration.len() >= count);
    debug_assert!(out_pitch.len() >= count);
    debug_assert!(out_pitch_velocity.len() >= count);
    debug_assert!(out_pitch_acceleration.len() >= count);
    debug_assert!(out_aim_error_yaw.len() >= count);
    debug_assert!(out_aim_error_pitch.len() >= count);

    for i in 0..count {
        let k = turn_accel[i];
        let damping_k = if k.is_finite() { k.max(0.0) } else { 0.0 };
        let c_critical = 2.0 * damping_k.sqrt();
        let c = c_critical * (1.0 + drag[i]);

        let (yaw, yaw_vel, yaw_acc) = compute_damped_rotation(
            current_yaw[i],
            yaw_velocity[i],
            target_yaw[i],
            k,
            c,
            dt_sec,
            DAMPED_ROTATION_FLAG_WRAP,
            0.0,
            0.0,
        );
        let (pitch, pitch_vel, pitch_acc) = compute_damped_rotation(
            current_pitch[i],
            pitch_velocity[i],
            target_pitch[i],
            k,
            c,
            dt_sec,
            DAMPED_ROTATION_FLAG_HAS_MIN | DAMPED_ROTATION_FLAG_HAS_MAX,
            pitch_min,
            pitch_max,
        );

        out_yaw[i] = yaw;
        out_yaw_velocity[i] = yaw_vel;
        out_yaw_acceleration[i] = yaw_acc;
        out_pitch[i] = pitch;
        out_pitch_velocity[i] = pitch_vel;
        out_pitch_acceleration[i] = pitch_acc;
        out_aim_error_yaw[i] = normalize_angle_ts(target_yaw[i] - yaw);
        out_aim_error_pitch[i] = target_pitch[i] - pitch;
    }

    count as u32
}

