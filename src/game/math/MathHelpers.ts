// Common math utility functions

/**
 * Compute squared distance between two points (avoids sqrt for comparisons)
 */
export function distanceSquared(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/**
 * Compute Euclidean distance between two points
 */
export function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(distanceSquared(x1, y1, x2, y2));
}

/**
 * Compute squared magnitude of a vector (avoids sqrt for comparisons)
 */
export function magnitudeSquared(x: number, y: number): number {
  return x * x + y * y;
}

/**
 * Compute magnitude of a vector
 */
export function magnitude(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** 3D squared distance. */
export function distanceSquared3(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  return dx * dx + dy * dy + dz * dz;
}

/** 3D Euclidean distance. Used everywhere a range check has to
 *  account for altitude (turret targeting, builder reach, area damage
 *  vs units) now that the sim runs in true 3D. */
export function distance3(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
): number {
  return Math.sqrt(distanceSquared3(x1, y1, z1, x2, y2, z2));
}

/** 3D vector magnitude. */
export function magnitude3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Normalize an angle to the range [-π, π]
 */
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp a value to [0, 1] range
 */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Linear interpolation between two values
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Compute angle difference wrapped to [-π, π]
 * Useful for smooth angle interpolation
 */
export function angleDiff(from: number, to: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/**
 * Interpolate between two angles, handling wrapping
 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}

/**
 * Normalize a vector and scale to given magnitude
 * Returns {x: 0, y: 0} if input is zero vector
 */
export function normalizeAndScale(dx: number, dy: number, scale: number): { x: number; y: number } {
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) return { x: 0, y: 0 };
  return {
    x: (dx / mag) * scale,
    y: (dy / mag) * scale,
  };
}

/**
 * Get direction from point (x1,y1) to point (x2,y2) scaled to given magnitude
 */
export function directionTo(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  scale: number = 1
): { x: number; y: number } {
  return normalizeAndScale(x2 - x1, y2 - y1, scale);
}

/**
 * Compute weapon world position from unit transform and weapon offset.
 * Applies 2D rotation transform: offset rotated by unit rotation + unit position.
 * Uses a reusable output object to avoid per-call allocations in the hot path.
 */
const _csOut = { cos: 0, sin: 0 };
export function getTransformCosSin(t: { rotation: number; rotCos?: number; rotSin?: number }): { cos: number; sin: number } {
  _csOut.cos = t.rotCos ?? Math.cos(t.rotation);
  _csOut.sin = t.rotSin ?? Math.sin(t.rotation);
  return _csOut;
}

const _wpOut = { x: 0, y: 0 };
export function getWeaponWorldPosition(
  unitX: number, unitY: number,
  cos: number, sin: number,
  offsetX: number, offsetY: number
): { x: number; y: number } {
  _wpOut.x = unitX + cos * offsetX - sin * offsetY;
  _wpOut.y = unitY + sin * offsetX + cos * offsetY;
  return _wpOut;
}
