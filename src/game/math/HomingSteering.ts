// Homing steering — rotate a projectile's 3D velocity vector toward a
// target at a clamped angular rate.
//
// Single primitive shared by the server (projectileSystem) and the
// client (ClientViewState) so predicted and authoritative missile
// paths agree frame-for-frame. Preserves speed (|v| unchanged), so the
// missile "turns" instead of "accelerating" — exactly how a thrust-
// guided missile behaves in real physics: the engine keeps it at its
// cruise speed while fins deflect the velocity vector toward the
// target. Gravity is integrated separately (in the per-tick physics
// step); homing cancels its effect on the direction by steering the
// post-gravity velocity back onto the target ray each frame.
//
// This replaces an earlier 2D-only implementation that spun yaw on
// the horizontal plane while vz fell under gravity. That was fine on
// flat ground but produced an unnatural "drop + yaw-swerve" curve
// when target and shooter were at different altitudes. The Rodrigues
// rotation below keeps the full 3D velocity vector on a single great-
// circle arc toward the target — what the user asked for: parametric,
// physics-natural homing.

import { magnitude3 } from './MathHelpers';

// Reusable output to avoid per-call allocations in a hot path.
const _hsOut = { velocityX: 0, velocityY: 0, velocityZ: 0, rotation: 0 };

/**
 * Rotate `(velX, velY, velZ)` toward the direction from the projectile's
 * current position to the target, by at most `homingTurnRate · dt`
 * radians this tick. Speed is preserved.
 *
 * The rotation is performed around the axis perpendicular to both the
 * current velocity and the target direction (Rodrigues' formula), so
 * the turn happens entirely in the plane containing the velocity and
 * the line-to-target — the most direct curve. If the velocity is
 * already aimed within the allowed turn this frame, the velocity snaps
 * exactly onto the target ray.
 *
 * `rotation` returns the horizontal yaw of the new velocity so the
 * renderer can orient the projectile sprite/mesh as before.
 */
export function applyHomingSteering(
  velX: number, velY: number, velZ: number,
  targetX: number, targetY: number, targetZ: number,
  currentX: number, currentY: number, currentZ: number,
  homingTurnRate: number, dtSec: number,
): { velocityX: number; velocityY: number; velocityZ: number; rotation: number } {
  const speed = magnitude3(velX, velY, velZ);
  _hsOut.velocityX = velX;
  _hsOut.velocityY = velY;
  _hsOut.velocityZ = velZ;
  _hsOut.rotation = Math.atan2(velY, velX);

  // Degenerate: missile has no velocity — nothing to turn.
  if (speed < 1e-6) return _hsOut;

  // Desired direction = unit vector from current position toward target.
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  const dz = targetZ - currentZ;
  const dMag = magnitude3(dx, dy, dz);
  // Degenerate: missile is sitting on top of the target — no direction
  // to turn toward. Let the collision handler catch it next tick.
  if (dMag < 1e-6) return _hsOut;

  // Unit velocity (v̂) and unit target direction (d̂).
  const vxN = velX / speed;
  const vyN = velY / speed;
  const vzN = velZ / speed;
  const dxN = dx / dMag;
  const dyN = dy / dMag;
  const dzN = dz / dMag;

  // Angle between current heading and target ray. clamp guards
  // against tiny floating-point overshoots that would NaN the acos.
  let cosAngle = vxN * dxN + vyN * dyN + vzN * dzN;
  if (cosAngle > 1) cosAngle = 1;
  else if (cosAngle < -1) cosAngle = -1;
  const angle = Math.acos(cosAngle);

  const maxTurn = homingTurnRate * dtSec;

  // Already aiming within this frame's budget — snap to target ray,
  // keeping speed. Also handles the "already aligned" case (angle ≈ 0).
  if (angle <= maxTurn) {
    _hsOut.velocityX = dxN * speed;
    _hsOut.velocityY = dyN * speed;
    _hsOut.velocityZ = dzN * speed;
    _hsOut.rotation = Math.atan2(_hsOut.velocityY, _hsOut.velocityX);
    return _hsOut;
  }

  // Rodrigues' rotation formula: rotate v̂ by `maxTurn` around the
  // axis perpendicular to both v̂ and d̂.
  //   v' = v·cosθ + (k × v)·sinθ + k·(k·v)·(1−cosθ)
  let axisX = vyN * dzN - vzN * dyN;
  let axisY = vzN * dxN - vxN * dzN;
  let axisZ = vxN * dyN - vyN * dxN;
  const axisMag = magnitude3(axisX, axisY, axisZ);

  // v̂ and d̂ are (nearly) anti-parallel — the cross product is
  // degenerate, so there's no unique rotation plane. Pick any
  // perpendicular: prefer the horizontal plane (world up) if the
  // velocity has any horizontal component, fall back to world +X
  // otherwise. This guarantees a stable rotation even in the rare
  // "missile heading directly away from target" case.
  if (axisMag < 1e-6) {
    if (Math.abs(vxN) < 0.99 && Math.abs(vyN) < 0.99) {
      axisX = -vyN; axisY = vxN; axisZ = 0;
    } else {
      axisX = 0; axisY = 0; axisZ = 1;
    }
    const fallbackMag = magnitude3(axisX, axisY, axisZ) || 1;
    axisX /= fallbackMag;
    axisY /= fallbackMag;
    axisZ /= fallbackMag;
  } else {
    axisX /= axisMag;
    axisY /= axisMag;
    axisZ /= axisMag;
  }

  const cosT = Math.cos(maxTurn);
  const sinT = Math.sin(maxTurn);
  const oneMinusCos = 1 - cosT;
  // k · v̂
  const kDotV = axisX * vxN + axisY * vyN + axisZ * vzN;
  // k × v̂
  const kxvX = axisY * vzN - axisZ * vyN;
  const kxvY = axisZ * vxN - axisX * vzN;
  const kxvZ = axisX * vyN - axisY * vxN;

  const rotXN = vxN * cosT + kxvX * sinT + axisX * kDotV * oneMinusCos;
  const rotYN = vyN * cosT + kxvY * sinT + axisY * kDotV * oneMinusCos;
  const rotZN = vzN * cosT + kxvZ * sinT + axisZ * kDotV * oneMinusCos;

  _hsOut.velocityX = rotXN * speed;
  _hsOut.velocityY = rotYN * speed;
  _hsOut.velocityZ = rotZN * speed;
  _hsOut.rotation = Math.atan2(rotYN, rotXN);
  return _hsOut;
}
