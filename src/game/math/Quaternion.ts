// Quaternion + angular-velocity helpers for sim-side orientation
// math. Three.js has its own quaternion class, but it's a render-
// layer dependency we don't want in authoritative sim code; this
// helper file keeps the math local and pure.
//
// Convention: unit quaternions {x, y, z, w} where w is the scalar
// part. The identity is { x:0, y:0, z:0, w:1 }. The "yaw" axis is
// world +Z (rotation around the vertical), pitch is rotation about
// the world +Y axis after yaw, roll is rotation about the world +X
// axis after yaw + pitch. ZYX intrinsic Euler order.

export type Quat = { x: number; y: number; z: number; w: number };
export type AngularVec3 = { x: number; y: number; z: number };

const TWO_PI = Math.PI * 2;

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatCopy(src: Quat, dst: Quat): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.w = src.w;
}

export function quatLengthSq(q: Quat): number {
  return q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
}

/** Normalize in-place. Returns the quaternion's prior magnitude (so
 *  callers can detect numerical degeneracy if they care). */
export function quatNormalize(q: Quat): number {
  const m2 = quatLengthSq(q);
  if (m2 <= 1e-20) {
    q.x = 0; q.y = 0; q.z = 0; q.w = 1;
    return 0;
  }
  const inv = 1 / Math.sqrt(m2);
  q.x *= inv; q.y *= inv; q.z *= inv; q.w *= inv;
  return Math.sqrt(m2);
}

/** Conjugate of a unit quaternion = its inverse. Mutates `q` (or
 *  use `quatCopy` first if you need to preserve the input). */
export function quatConjugateInPlace(q: Quat): void {
  q.x = -q.x;
  q.y = -q.y;
  q.z = -q.z;
}

/** out = a · b. The arguments may alias `out`. */
export function quatMultiply(a: Quat, b: Quat, out: Quat): void {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

/** ZYX intrinsic Euler from (yaw, pitch, roll) angles in radians.
 *  Yaw is rotation about world Z, pitch about the body-Y after yaw,
 *  roll about the body-X after yaw + pitch. */
export function quatFromYawPitchRoll(
  yaw: number, pitch: number, roll: number, out: Quat,
): void {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  out.x = cy * cp * sr - sy * sp * cr;
  out.y = sy * cp * sr + cy * sp * cr;
  out.z = sy * cp * cr - cy * sp * sr;
  out.w = cy * cp * cr + sy * sp * sr;
}

/** Yaw extraction (rotation about world Z) from a unit quaternion.
 *  Useful for renderers / scalar consumers that still want a single
 *  heading angle. Mirrors Three.js's `Euler.setFromQuaternion('ZYX')`
 *  yaw component. */
export function quatYaw(q: Quat): number {
  const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
  const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  return Math.atan2(siny_cosp, cosy_cosp);
}

/** Integrate `q ← q ⊕ (ω · dt)` using the small-step quaternion
 *  derivative `dq = 0.5 · ωq · q · dt`, then renormalize.
 *  ω is in rad/s expressed in the world frame (NOT body frame). */
export function quatIntegrate(
  q: Quat, omega: AngularVec3, dtSec: number, out: Quat,
): void {
  const halfDt = 0.5 * dtSec;
  const ox = omega.x * halfDt;
  const oy = omega.y * halfDt;
  const oz = omega.z * halfDt;
  // dq = (ω as pure-imaginary quaternion) · q  (multiplied by halfDt
  // implicitly via ox/oy/oz).
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const dqx = ox * qw + oy * qz - oz * qy;
  const dqy = -ox * qz + oy * qw + oz * qx;
  const dqz = ox * qy - oy * qx + oz * qw;
  const dqw = -ox * qx - oy * qy - oz * qz;
  out.x = qx + dqx;
  out.y = qy + dqy;
  out.z = qz + dqz;
  out.w = qw + dqw;
  quatNormalize(out);
}

/** Damped-spring step toward a target orientation, in quaternion +
 *  world-frame ω form. Writes the integrated orientation back into
 *  `orientation`, the new angular velocity into `omega`, and the
 *  step's angular acceleration (the spring "torque") into
 *  `outAlpha`. Critical damping is c = 2·√k.
 *
 *  This is the elegant per-step replacement for the two scalar
 *  springs (yaw + pitch) used by ground-unit / turret math: one law
 *  applied to the full 3-vector axis-angle of error, no preferred
 *  axis, no singularity. Used by hover units' bank-into-turn
 *  physics and by any future entity with arbitrary orientation. */
export function quatDampedSpringStep(
  orientation: Quat,
  omega: AngularVec3,
  target: Quat,
  k: number,
  c: number,
  dtSec: number,
  outAlpha: AngularVec3,
): void {
  // axis · angle of the shortest-path rotation from orientation to target.
  // Spring law: α = k · (axis·angle) − c · ω.
  quatShortestAxisAngle(orientation, target, outAlpha);
  outAlpha.x = outAlpha.x * k - omega.x * c;
  outAlpha.y = outAlpha.y * k - omega.y * c;
  outAlpha.z = outAlpha.z * k - omega.z * c;
  omega.x += outAlpha.x * dtSec;
  omega.y += outAlpha.y * dtSec;
  omega.z += outAlpha.z * dtSec;
  quatIntegrate(orientation, omega, dtSec, orientation);
}

/** Extract the shortest-path axis-angle of error from current to
 *  target. Writes the (axis · angle) product into `outAxisAngle`
 *  (so callers don't need a separate normalize step) and returns
 *  the angle for convenience. The sign hemisphere is normalized
 *  (negative-w Δq is flipped) so the angle is always in [0, π]. */
export function quatShortestAxisAngle(
  current: Quat, target: Quat, outAxisAngle: AngularVec3,
): number {
  // Δq = target · conjugate(current)
  const cx = -current.x, cy = -current.y, cz = -current.z, cw = current.w;
  const tx = target.x, ty = target.y, tz = target.z, tw = target.w;
  let dx = tw * cx + tx * cw + ty * cz - tz * cy;
  let dy = tw * cy - tx * cz + ty * cw + tz * cx;
  let dz = tw * cz + tx * cy - ty * cx + tz * cw;
  let dw = tw * cw - tx * cx - ty * cy - tz * cz;
  // Pick the shortest hemisphere.
  if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; dw = -dw; }
  // angle = 2 · atan2(|xyz|, w); axis = xyz / sin(angle/2). The
  // `outAxisAngle = axis · angle` simplification skips the division
  // by sin(angle/2) which would explode near θ=0; instead we use
  // the identity (xyz / sin(angle/2)) · angle = xyz · (angle /
  // sin(angle/2)) and take the small-angle limit angle/sin(angle/2)
  // → 2 as angle → 0.
  const sin2 = dx * dx + dy * dy + dz * dz;
  const sinHalf = Math.sqrt(sin2);
  let angle: number;
  let scale: number;
  if (sinHalf < 1e-7) {
    // Small-angle: angle ≈ 2 · sinHalf, and angle / sinHalf ≈ 2.
    angle = 2 * sinHalf;
    scale = 2;
  } else {
    angle = 2 * Math.atan2(sinHalf, dw);
    scale = angle / sinHalf;
  }
  // Wrap angle to (-π, π] just in case the atan2 returned something
  // outside the canonical range (shouldn't happen for unit quats but
  // defensive).
  if (angle > Math.PI) angle -= TWO_PI;
  outAxisAngle.x = dx * scale;
  outAxisAngle.y = dy * scale;
  outAxisAngle.z = dz * scale;
  return angle;
}
