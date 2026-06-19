


/**
 * Compute magnitude of a vector
 */
export function magnitude(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}



/** 3D vector magnitude. */
export function magnitude3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Normalize an angle to the range [-π, π]
 */
const TWO_PI = Math.PI * 2;
export function normalizeAngle(angle: number): number {
  if (angle <= Math.PI && angle >= -Math.PI) return angle;
  if (!Number.isFinite(angle)) return 0;
  if (angle > Math.PI && angle <= Math.PI + TWO_PI) return angle - TWO_PI;
  if (angle < -Math.PI && angle >= -Math.PI - TWO_PI) return angle + TWO_PI;
  angle = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
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
 * Absolute wrapped difference between two angles in radians.
 */
export function angleDeltaAbs(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
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
function angleDiff(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/**
 * Interpolate between two angles, handling wrapping
 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}

/** Cached cos/sin from a transform's rotation, preferring the
 *  pre-computed `rotCos`/`rotSin` fields when populated.
 *
 *  WARNING — SHARED SCRATCH RETURN: every call returns the same module
 *  object, overwritten in place. Read `.cos`/`.sin` (or copy them into
 *  locals) immediately; holding the returned reference across another
 *  getTransformCosSin call — including one buried inside a helper you
 *  call in between — silently corrupts the first read. */
const _csOut = { cos: 0, sin: 0 };
export function getTransformCosSin(t: { rotation: number; rotCos: number | null; rotSin: number | null }): { cos: number; sin: number } {
  _csOut.cos = t.rotCos ?? Math.cos(t.rotation);
  _csOut.sin = t.rotSin ?? Math.sin(t.rotation);
  return _csOut;
}

/** Type guard that narrows `unknown` to a real, finite `number` —
 *  rejects `NaN`, `Infinity`, and anything that isn't a JS number.
 *  Used at wire / snapshot boundaries where decoded values can be
 *  any shape and presence-checks alone aren't enough. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Stride-cadence predicate: returns true when this `tick` is the
 *  one a stride-`stride` work bucket should fire on. The optional
 *  `entityPhase` jitters the modulo so per-entity work spreads
 *  evenly across the stride window instead of every entity firing on
 *  the same tick. `stride <= 1` short-circuits to true so callers
 *  don't have to special-case the disabled-stride path. */
export function shouldRunOnStride(
  tick: number,
  stride: number,
  entityPhase: number = 0,
): boolean {
  if (stride <= 1) return true;
  return ((tick + entityPhase) % stride) === 0;
}



