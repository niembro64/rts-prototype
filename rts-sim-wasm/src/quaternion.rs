// quaternion — extracted from lib.rs (pure code motion).

#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

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
pub(crate) fn quat_normalize_inplace(q: &mut [f64; 4]) {
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

/// Returns (axis · angle) of the shortest-path rotation from
/// `current` to `target`. Mirrors quatShortestAxisAngle in TS:
/// computes Δq = target · conjugate(current), flips to shortest
/// hemisphere if w<0, then expands axis · angle via the small-
/// angle-safe scale factor `angle / sin(angle/2)`.
#[inline]
pub(crate) fn quat_shortest_axis_angle(current: [f64; 4], target: [f64; 4]) -> [f64; 3] {
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
pub(crate) fn quat_integrate_inplace(q: &mut [f64; 4], omega: [f64; 3], dt_sec: f64) {
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
pub(crate) fn quat_yaw(q: [f64; 4]) -> f64 {
    let siny_cosp = 2.0 * (q[3] * q[2] + q[0] * q[1]);
    let cosy_cosp = 1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]);
    siny_cosp.atan2(cosy_cosp)
}
