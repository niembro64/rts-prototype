// Common math utility functions

import {
  getSimWasm,
  DAMPED_ROTATION_FLAG_WRAP,
  DAMPED_ROTATION_FLAG_HAS_MIN,
  DAMPED_ROTATION_FLAG_HAS_MAX,
} from '../sim-wasm/init';

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

/** 3D Euclidean distance. Used where a range or sweep check has to
 *  account for altitude (builder reach, area damage vs units, projectile
 *  motion) now that the sim runs in true 3D. */
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
  return normalizeAngle(to - from);
}

/**
 * Interpolate between two angles, handling wrapping
 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}

/** Cached cos/sin from a transform's rotation, preferring the
 *  pre-computed `rotCos`/`rotSin` fields when present. The output
 *  object is reused — copy the values out before another call. */
const _csOut = { cos: 0, sin: 0 };
export function getTransformCosSin(t: { rotation: number; rotCos?: number; rotSin?: number }): { cos: number; sin: number } {
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

export type DampedRotationOptions = {
  /** Wrap the diff and the integrated angle through normalizeAngle.
   *  Use for yaw axes that need to turn the short way around ±π. */
  wrap?: boolean;
  /** Inclusive lower clamp; when hit, angularVel snaps to 0. */
  minAngle?: number;
  /** Inclusive upper clamp; when hit, angularVel snaps to 0. */
  maxAngle?: number;
};

/** Result object reused across calls — copy `angle` / `angularVel` /
 *  `angularAcc` out before another `integrateDampedRotation` call.
 *  `angularAcc` is the average acceleration across this stable spring
 *  step (rad/s²). It is sim/debug state; acceleration is not shipped on
 *  the snapshot wire. */
const _dampedRotationResult = { angle: 0, angularVel: 0, angularAcc: 0 };
// Module-scope scratch for the WASM dispatch — written by Rust into
// (angle, angularVel, angularAcc) at indices 0..3.
const _dampedRotationWasmScratch = new Float64Array(3);

/** Damped-spring single-axis rotation integrator:
 *
 *    accel = (target − angle) · k  −  angularVel · c
 *
 *  The implementation solves the spring exactly for the supplied
 *  timestep instead of using explicit Euler. That keeps turret yaw and
 *  pitch stable when the host tick rate is low or the client prediction
 *  frame has a long dt.
 *
 *  `k` is the stiffness; `c = 2·√k` produces critical damping (no
 *  overshoot). Pass `{ wrap: true }` for yaw axes, or
 *  `{ minAngle, maxAngle }` for clamped axes that should kill the
 *  velocity at the limit (e.g. turret pitch). The returned object is
 *  reused — destructure or copy out before the next call. */
export function integrateDampedRotation(
  angle: number,
  angularVel: number,
  targetAngle: number,
  k: number,
  c: number,
  dtSec: number,
  options?: DampedRotationOptions,
): { angle: number; angularVel: number; angularAcc: number } {
  const sim = getSimWasm();
  if (sim !== undefined) {
    let flags = 0;
    let minA = 0;
    let maxA = 0;
    if (options !== undefined) {
      if (options.wrap) flags |= DAMPED_ROTATION_FLAG_WRAP;
      if (options.minAngle !== undefined) {
        flags |= DAMPED_ROTATION_FLAG_HAS_MIN;
        minA = options.minAngle;
      }
      if (options.maxAngle !== undefined) {
        flags |= DAMPED_ROTATION_FLAG_HAS_MAX;
        maxA = options.maxAngle;
      }
    }
    sim.integrateDampedRotation(
      _dampedRotationWasmScratch,
      angle, angularVel, targetAngle, k, c, dtSec,
      flags, minA, maxA,
    );
    _dampedRotationResult.angle = _dampedRotationWasmScratch[0];
    _dampedRotationResult.angularVel = _dampedRotationWasmScratch[1];
    _dampedRotationResult.angularAcc = _dampedRotationWasmScratch[2];
    return _dampedRotationResult;
  }
  // Bootstrap-window fallback — pure-TS impl kept on the same stable
  // equations as the Rust kernel so motion does not change character
  // across the swap.
  const safeDt = Math.max(0, Number.isFinite(dtSec) ? dtSec : 0);
  const safeK = Math.max(0, Number.isFinite(k) ? k : 0);
  const safeC = Math.max(0, Number.isFinite(c) ? c : 0);
  const safeVel = Number.isFinite(angularVel) ? angularVel : 0;
  const safeTarget = Number.isFinite(targetAngle) ? targetAngle : 0;
  const relativeAngle = options?.wrap
    ? normalizeAngle(angle - safeTarget)
    : (Number.isFinite(angle) ? angle : 0) - safeTarget;

  let newRelative = relativeAngle;
  let newVel = safeVel;
  if (safeDt > 0 && safeK > 0) {
    const discriminant = safeC * safeC - 4 * safeK;
    if (Math.abs(discriminant) <= 1e-9) {
      const r = -safeC / 2;
      const b = safeVel - r * relativeAngle;
      const e = Math.exp(r * safeDt);
      newRelative = (relativeAngle + b * safeDt) * e;
      newVel = (b + r * (relativeAngle + b * safeDt)) * e;
    } else if (discriminant > 0) {
      const root = Math.sqrt(discriminant);
      const r1 = (-safeC + root) / 2;
      const r2 = (-safeC - root) / 2;
      const denom = r1 - r2;
      const a = denom !== 0 ? (safeVel - r2 * relativeAngle) / denom : relativeAngle;
      const b = relativeAngle - a;
      const e1 = Math.exp(r1 * safeDt);
      const e2 = Math.exp(r2 * safeDt);
      newRelative = a * e1 + b * e2;
      newVel = a * r1 * e1 + b * r2 * e2;
    } else {
      const alpha = -safeC / 2;
      const omega = Math.sqrt(-discriminant) / 2;
      const a = relativeAngle;
      const b = omega > 0 ? (safeVel - alpha * relativeAngle) / omega : 0;
      const e = Math.exp(alpha * safeDt);
      const cos = Math.cos(omega * safeDt);
      const sin = Math.sin(omega * safeDt);
      newRelative = e * (a * cos + b * sin);
      newVel = e * (
        alpha * (a * cos + b * sin) +
        (-a * omega * sin + b * omega * cos)
      );
    }
  } else if (safeDt > 0 && safeC > 0) {
    const e = Math.exp(-safeC * safeDt);
    newRelative = relativeAngle + safeVel * (1 - e) / safeC;
    newVel = safeVel * e;
  } else if (safeDt > 0) {
    newRelative = relativeAngle + safeVel * safeDt;
  }

  let newAngle = safeTarget + newRelative;
  let outAcc = safeDt > 0 ? (newVel - safeVel) / safeDt : 0;
  if (options?.wrap) {
    newAngle = normalizeAngle(newAngle);
  }
  if (options?.minAngle !== undefined && newAngle < options.minAngle) {
    newAngle = options.minAngle;
    newVel = 0;
    outAcc = 0;
  } else if (options?.maxAngle !== undefined && newAngle > options.maxAngle) {
    newAngle = options.maxAngle;
    newVel = 0;
    outAcc = 0;
  }
  _dampedRotationResult.angle = newAngle;
  _dampedRotationResult.angularVel = newVel;
  _dampedRotationResult.angularAcc = outAcc;
  return _dampedRotationResult;
}
