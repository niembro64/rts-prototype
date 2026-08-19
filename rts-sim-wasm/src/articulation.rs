// articulation — deterministic, physically bounded local-joint actuation.
//
// Targeting supplies a world-space intent, while TypeScript orchestration
// converts it into the moving parent piece's local frame. This kernel owns the
// high-count fixed-tick motor step: angular speed and acceleration are both
// hard physical limits, continuous joints take the shortest wrapped route,
// and limited joints cannot cross authored stops.

use crate::normalize_angle_ts;
use wasm_bindgen::prelude::*;

#[inline]
fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

#[inline]
pub(crate) fn step_revolute_joint(
    angle: f64,
    angular_velocity: f64,
    target_angle: f64,
    continuous: bool,
    min_angle: f64,
    max_angle: f64,
    max_speed: f64,
    max_acceleration: f64,
    dt_sec: f64,
) -> (f64, f64, f64, f64) {
    let dt = finite_or(dt_sec, 0.0).max(0.0);
    let speed_limit = finite_or(max_speed, 0.0).max(0.0);
    let acceleration_limit = finite_or(max_acceleration, 0.0).max(0.0);
    let min = finite_or(min_angle, -core::f64::consts::PI);
    let max = finite_or(max_angle, core::f64::consts::PI).max(min);
    let mut current = finite_or(angle, 0.0);
    let velocity = finite_or(angular_velocity, 0.0).clamp(-speed_limit, speed_limit);
    let target = if continuous {
        normalize_angle_ts(finite_or(target_angle, 0.0))
    } else {
        finite_or(target_angle, 0.0).clamp(min, max)
    };
    if continuous {
        current = normalize_angle_ts(current);
    } else {
        current = current.clamp(min, max);
    }

    let error = if continuous {
        normalize_angle_ts(target - current)
    } else {
        target - current
    };
    if dt <= 0.0 || speed_limit <= 0.0 || acceleration_limit <= 0.0 {
        return (current, 0.0, 0.0, error);
    }

    // The fastest non-overshooting speed at this remaining distance follows
    // v² = 2 a d. Accelerating toward min(maxSpeed, brakingSpeed) yields a
    // deterministic trapezoidal/triangular motion profile with no spring
    // stiffness masquerading as a physical unit.
    let direction = if error > 0.0 { 1.0 } else if error < 0.0 { -1.0 } else { 0.0 };
    let braking_speed = (2.0 * acceleration_limit * error.abs()).sqrt();
    let desired_velocity = direction * speed_limit.min(braking_speed);
    let max_delta_velocity = acceleration_limit * dt;
    let velocity_delta = (desired_velocity - velocity)
        .clamp(-max_delta_velocity, max_delta_velocity);
    let next_velocity = (velocity + velocity_delta).clamp(-speed_limit, speed_limit);
    let step = (velocity + next_velocity) * 0.5 * dt;
    let mut next_angle = current + step;
    let mut final_velocity = next_velocity;

    // Did this step's swept arc actually contain the target? Measure the
    // distance to the target the same way round the circle the joint is
    // travelling. A continuous joint that is still coasting away from a new
    // target crosses the antipode without ever passing the target, and there
    // the shortest-path error flips sign on its own; reading that flip as an
    // overshoot teleported the piece half a turn.
    let travel_to_target = if !continuous || step == 0.0 {
        error
    } else if step > 0.0 && error < 0.0 {
        error + core::f64::consts::TAU
    } else if step < 0.0 && error > 0.0 {
        error - core::f64::consts::TAU
    } else {
        error
    };
    let reached = error == 0.0
        || (step != 0.0
            && (step > 0.0) == (travel_to_target > 0.0)
            && step.abs() >= travel_to_target.abs());
    if reached {
        next_angle = target;
        final_velocity = 0.0;
    } else if continuous {
        next_angle = normalize_angle_ts(next_angle);
    } else {
        let clamped = next_angle.clamp(min, max);
        if clamped != next_angle {
            next_angle = clamped;
            final_velocity = 0.0;
        }
    }

    let acceleration = (final_velocity - velocity) / dt;
    let final_error = if continuous {
        normalize_angle_ts(target - next_angle)
    } else {
        target - next_angle
    };
    (next_angle, final_velocity, acceleration, final_error)
}

#[wasm_bindgen]
pub fn articulation_joint_step_batch(
    current_yaw: &[f64],
    yaw_velocity: &[f64],
    target_yaw: &[f64],
    yaw_continuous: &[u8],
    yaw_min: &[f64],
    yaw_max: &[f64],
    yaw_max_speed: &[f64],
    yaw_max_acceleration: &[f64],
    current_pitch: &[f64],
    pitch_velocity: &[f64],
    target_pitch: &[f64],
    pitch_min: &[f64],
    pitch_max: &[f64],
    pitch_max_speed: &[f64],
    pitch_max_acceleration: &[f64],
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
) -> u32 {
    let count = count as usize;
    debug_assert!(current_yaw.len() >= count);
    debug_assert!(yaw_velocity.len() >= count);
    debug_assert!(target_yaw.len() >= count);
    debug_assert!(yaw_continuous.len() >= count);
    debug_assert!(yaw_min.len() >= count);
    debug_assert!(yaw_max.len() >= count);
    debug_assert!(yaw_max_speed.len() >= count);
    debug_assert!(yaw_max_acceleration.len() >= count);
    debug_assert!(current_pitch.len() >= count);
    debug_assert!(pitch_velocity.len() >= count);
    debug_assert!(target_pitch.len() >= count);
    debug_assert!(pitch_min.len() >= count);
    debug_assert!(pitch_max.len() >= count);
    debug_assert!(pitch_max_speed.len() >= count);
    debug_assert!(pitch_max_acceleration.len() >= count);

    for i in 0..count {
        let (yaw, yaw_vel, yaw_acc, yaw_error) = step_revolute_joint(
            current_yaw[i],
            yaw_velocity[i],
            target_yaw[i],
            yaw_continuous[i] != 0,
            yaw_min[i],
            yaw_max[i],
            yaw_max_speed[i],
            yaw_max_acceleration[i],
            dt_sec,
        );
        let (pitch, pitch_vel, pitch_acc, pitch_error) = step_revolute_joint(
            current_pitch[i],
            pitch_velocity[i],
            target_pitch[i],
            false,
            pitch_min[i],
            pitch_max[i],
            pitch_max_speed[i],
            pitch_max_acceleration[i],
            dt_sec,
        );
        out_yaw[i] = yaw;
        out_yaw_velocity[i] = yaw_vel;
        out_yaw_acceleration[i] = yaw_acc;
        out_pitch[i] = pitch;
        out_pitch_velocity[i] = pitch_vel;
        out_pitch_acceleration[i] = pitch_acc;
        out_aim_error_yaw[i] = yaw_error;
        out_aim_error_pitch[i] = pitch_error;
    }
    count as u32
}

#[wasm_bindgen]
pub fn articulation_yaw_step_batch(
    current_yaw: &[f64],
    yaw_velocity: &[f64],
    target_yaw: &[f64],
    max_speed: &[f64],
    max_acceleration: &[f64],
    out_yaw: &mut [f64],
    out_yaw_velocity: &mut [f64],
    out_yaw_acceleration: &mut [f64],
    out_aim_error: &mut [f64],
    count: u32,
    dt_sec: f64,
) -> u32 {
    let count = count as usize;
    debug_assert!(current_yaw.len() >= count);
    debug_assert!(yaw_velocity.len() >= count);
    debug_assert!(target_yaw.len() >= count);
    debug_assert!(max_speed.len() >= count);
    debug_assert!(max_acceleration.len() >= count);
    debug_assert!(out_yaw.len() >= count);
    debug_assert!(out_yaw_velocity.len() >= count);
    debug_assert!(out_yaw_acceleration.len() >= count);
    debug_assert!(out_aim_error.len() >= count);
    for i in 0..count {
        let (yaw, velocity, acceleration, error) = step_revolute_joint(
            current_yaw[i],
            yaw_velocity[i],
            target_yaw[i],
            true,
            -core::f64::consts::PI,
            core::f64::consts::PI,
            max_speed[i],
            max_acceleration[i],
            dt_sec,
        );
        out_yaw[i] = yaw;
        out_yaw_velocity[i] = velocity;
        out_yaw_acceleration[i] = acceleration;
        out_aim_error[i] = error;
    }
    count as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joint_never_exceeds_rate_or_acceleration_limits() {
        let dt = 0.05;
        let (_, velocity, acceleration, _) = step_revolute_joint(
            0.0, 0.0, core::f64::consts::PI, true,
            -core::f64::consts::PI, core::f64::consts::PI,
            1.5, 3.0, dt,
        );
        assert!(velocity.abs() <= 1.5 + 1e-12);
        assert!(acceleration.abs() <= 3.0 + 1e-12);
    }

    #[test]
    fn limited_joint_clamps_unreachable_target() {
        let (angle, _, _, error) = step_revolute_joint(
            0.49, 0.0, 2.0, false, -0.5, 0.5, 2.0, 8.0, 1.0,
        );
        assert!(angle <= 0.5);
        assert!(error.abs() <= 1e-12);
    }

    /// A bot waist coasting one way when a new claim lands behind it must brake
    /// and come round under its own rate limits. It crosses the far side of the
    /// circle on the way, which flips the shortest-path error sign without the
    /// joint ever passing its target; that is ordinary travel, not an overshoot.
    #[test]
    fn continuous_joint_coasting_past_the_antipode_never_teleports() {
        let max_speed = 0.75;
        let max_acceleration = 1.2;
        let dt = 1.0 / 30.0;
        let target = 3.0;
        let mut angle = 0.0;
        let mut velocity = -max_speed;
        for tick in 0..600 {
            let (next_angle, next_velocity, _, _) = step_revolute_joint(
                angle, velocity, target, true,
                -core::f64::consts::PI, core::f64::consts::PI,
                max_speed, max_acceleration, dt,
            );
            let travelled = normalize_angle_ts(next_angle - angle).abs();
            assert!(
                travelled <= max_speed * dt + 1e-9,
                "tick {tick} swept {travelled} rad, above the {max_speed} rad/s limit",
            );
            angle = next_angle;
            velocity = next_velocity;
        }
        assert!(normalize_angle_ts(target - angle).abs() <= 1e-9);
    }

    /// The same crossing on the other side of the circle, so the fix cannot be
    /// a sign special case.
    #[test]
    fn continuous_joint_coasting_past_the_antipode_never_teleports_mirrored() {
        let max_speed = 0.75;
        let max_acceleration = 1.2;
        let dt = 1.0 / 30.0;
        let target = -3.0;
        let mut angle = 0.0;
        let mut velocity = max_speed;
        for tick in 0..600 {
            let (next_angle, next_velocity, _, _) = step_revolute_joint(
                angle, velocity, target, true,
                -core::f64::consts::PI, core::f64::consts::PI,
                max_speed, max_acceleration, dt,
            );
            let travelled = normalize_angle_ts(next_angle - angle).abs();
            assert!(
                travelled <= max_speed * dt + 1e-9,
                "tick {tick} swept {travelled} rad, above the {max_speed} rad/s limit",
            );
            angle = next_angle;
            velocity = next_velocity;
        }
        assert!(normalize_angle_ts(target - angle).abs() <= 1e-9);
    }

    /// Reaching the target the ordinary way must still settle exactly, with no
    /// residual error and no creeping past the stop.
    #[test]
    fn continuous_joint_settles_exactly_on_its_target() {
        let (angle, velocity, _, error) = step_revolute_joint(
            0.0, 0.0, 0.001, true,
            -core::f64::consts::PI, core::f64::consts::PI,
            1.5, 3.0, 0.05,
        );
        assert!((angle - 0.001).abs() <= 1e-12);
        assert_eq!(velocity, 0.0);
        assert!(error.abs() <= 1e-12);
    }

    #[test]
    fn continuous_joint_takes_short_wrapped_route() {
        let (_, velocity, _, _) = step_revolute_joint(
            3.10, 0.0, -3.10, true,
            -core::f64::consts::PI, core::f64::consts::PI,
            2.0, 10.0, 0.05,
        );
        assert!(velocity > 0.0);
    }
}
