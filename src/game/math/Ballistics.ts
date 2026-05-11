// Ballistic aim solver — pick the pitch angle that lands a projectile
// with speed `v` under constant gravity `g` on a target at horizontal
// distance `d` and vertical offset `h` from the launch origin.
//
// Given a flat-ground starting point, the projectile equation is:
//   x(t) = v·cos(θ)·t
//   z(t) = v·sin(θ)·t - ½·g·t²
//
// Eliminating t (= d / (v·cos(θ))) and using 1/cos²(θ) = 1 + tan²(θ),
// the problem reduces to a quadratic in tan(θ):
//
//   A·tan²(θ) − d·tan(θ) + (h + A) = 0        where A = g·d² / (2·v²)
//
// The quadratic has two real roots whenever the discriminant
//   v⁴ − g·(g·d² + 2·h·v²) ≥ 0
// is non-negative. Both roots are valid firing angles — one low /
// direct-fire, one high / lofted. Beyond the discriminant threshold
// the target is out of range and no ballistic solution exists.
//
// This file is imported by both the server turret system and the
// client for any future prediction. Zero state, pure function.

/** Two real solutions to the ballistic equation, in radians. */
export type BallisticSolution = {
  low: number;
  high: number;
};

export type KinematicVec3 = {
  x: number;
  y: number;
  z: number;
};

export type KinematicState3 = {
  position: KinematicVec3;
  velocity: KinematicVec3;
  acceleration: KinematicVec3;
};

export type KinematicInterceptInput = {
  origin: KinematicState3;
  target: KinematicState3;
  projectileSpeed: number;
  /** Absolute projectile acceleration after launch, in world units/s^2. */
  projectileAcceleration: KinematicVec3;
  preferLateSolution?: boolean;
  maxTimeSec?: number;
};

export type KinematicInterceptSolution = {
  time: number;
  aimPoint: KinematicVec3;
  launchVelocity: KinematicVec3;
};

const INTERCEPT_SAMPLE_COUNT = 64;
const INTERCEPT_BISECT_STEPS = 14;
const INTERCEPT_MIN_TIME = 1 / 120;
const INTERCEPT_MAX_TIME = 30;
const INTERCEPT_ROOT_EPSILON = 1e-5;

function isFiniteVec3(v: KinematicVec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isFiniteState3(s: KinematicState3): boolean {
  return (
    isFiniteVec3(s.position) &&
    isFiniteVec3(s.velocity) &&
    isFiniteVec3(s.acceleration)
  );
}

function clampTime(value: number): number {
  return Math.max(INTERCEPT_MIN_TIME, Math.min(INTERCEPT_MAX_TIME, value));
}

function defaultInterceptMaxTime(input: KinematicInterceptInput): number {
  const dx = input.target.position.x - input.origin.position.x;
  const dy = input.target.position.y - input.origin.position.y;
  const dz = input.target.position.z - input.origin.position.z;
  const dist = Math.hypot(dx, dy, dz);
  const speed = input.projectileSpeed;
  const baseTime = speed > 1e-6 ? dist / speed : 0;
  const relAx = input.target.acceleration.x - input.projectileAcceleration.x;
  const relAy = input.target.acceleration.y - input.projectileAcceleration.y;
  const relAz = input.target.acceleration.z - input.projectileAcceleration.z;
  const relAccel = Math.hypot(relAx, relAy, relAz);
  const accelTime = relAccel > 1e-6 ? (2 * speed) / relAccel : 0;
  return clampTime(Math.max(2, baseTime * 8 + 4, accelTime * 2 + 1));
}

function interceptFunction(input: KinematicInterceptInput, t: number): number {
  const origin = input.origin;
  const target = input.target;
  const projectileAcc = input.projectileAcceleration;

  const relX = target.position.x - origin.position.x +
    (target.velocity.x - origin.velocity.x) * t +
    0.5 * (target.acceleration.x - projectileAcc.x) * t * t;
  const relY = target.position.y - origin.position.y +
    (target.velocity.y - origin.velocity.y) * t +
    0.5 * (target.acceleration.y - projectileAcc.y) * t * t;
  const relZ = target.position.z - origin.position.z +
    (target.velocity.z - origin.velocity.z) * t +
    0.5 * (target.acceleration.z - projectileAcc.z) * t * t;

  return Math.hypot(relX, relY, relZ) - input.projectileSpeed * t;
}

function bisectInterceptRoot(
  input: KinematicInterceptInput,
  loT: number,
  hiT: number,
): number {
  let lo = loT;
  let hi = hiT;
  let loF = interceptFunction(input, lo);
  for (let i = 0; i < INTERCEPT_BISECT_STEPS; i++) {
    const mid = (lo + hi) * 0.5;
    const midF = interceptFunction(input, mid);
    if (Math.abs(midF) <= INTERCEPT_ROOT_EPSILON) return mid;
    if ((loF <= 0 && midF <= 0) || (loF >= 0 && midF >= 0)) {
      lo = mid;
      loF = midF;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}

function writeKinematicPosition(state: KinematicState3, t: number, out: KinematicVec3): void {
  out.x = state.position.x + state.velocity.x * t + 0.5 * state.acceleration.x * t * t;
  out.y = state.position.y + state.velocity.y * t + 0.5 * state.acceleration.y * t * t;
  out.z = state.position.z + state.velocity.z * t + 0.5 * state.acceleration.z * t * t;
}

function writeInterceptSolution(
  input: KinematicInterceptInput,
  time: number,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution {
  const origin = input.origin;
  const projectileAcc = input.projectileAcceleration;
  writeKinematicPosition(input.target, time, out.aimPoint);

  const originX = origin.position.x + origin.velocity.x * time + 0.5 * origin.acceleration.x * time * time;
  const originY = origin.position.y + origin.velocity.y * time + 0.5 * origin.acceleration.y * time * time;
  const originZ = origin.position.z + origin.velocity.z * time + 0.5 * origin.acceleration.z * time * time;
  const projectileRelAx = projectileAcc.x - origin.acceleration.x;
  const projectileRelAy = projectileAcc.y - origin.acceleration.y;
  const projectileRelAz = projectileAcc.z - origin.acceleration.z;
  const invT = 1 / time;
  out.launchVelocity.x =
    (out.aimPoint.x - originX - 0.5 * projectileRelAx * time * time) * invT;
  out.launchVelocity.y =
    (out.aimPoint.y - originY - 0.5 * projectileRelAy * time * time) * invT;
  out.launchVelocity.z =
    (out.aimPoint.z - originZ - 0.5 * projectileRelAz * time * time) * invT;
  out.time = time;
  return out;
}

/**
 * Constant-acceleration intercept solver. Both origin and target are
 * explicit 3D kinematic states; projectile acceleration is explicit so
 * callers can pass gravity, zero gravity, or any future force model
 * without this helper knowing game-specific constants.
 */
export function solveKinematicIntercept(
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  if (
    !isFiniteState3(input.origin) ||
    !isFiniteState3(input.target) ||
    !isFiniteVec3(input.projectileAcceleration) ||
    !Number.isFinite(input.projectileSpeed) ||
    input.projectileSpeed <= 1e-6
  ) {
    return null;
  }

  const maxTime = input.maxTimeSec !== undefined && Number.isFinite(input.maxTimeSec)
    ? clampTime(input.maxTimeSec)
    : defaultInterceptMaxTime(input);

  let selectedRoot = 0;
  let prevT = 0;
  let prevF = interceptFunction(input, prevT);

  for (let i = 1; i <= INTERCEPT_SAMPLE_COUNT; i++) {
    const t = (maxTime * i) / INTERCEPT_SAMPLE_COUNT;
    const f = interceptFunction(input, t);

    let root = 0;
    if (Math.abs(f) <= INTERCEPT_ROOT_EPSILON) {
      root = t;
    } else if ((prevF > 0 && f < 0) || (prevF < 0 && f > 0)) {
      root = bisectInterceptRoot(input, prevT, t);
    }

    if (root > 0) {
      selectedRoot = root;
      if (!input.preferLateSolution) break;
    }

    prevT = t;
    prevF = f;
  }

  if (selectedRoot <= INTERCEPT_MIN_TIME) return null;
  return writeInterceptSolution(input, selectedRoot, out);
}

/** Return the ballistic pitch pair for a target at horizontal distance
 *  `d` and vertical offset `h` (positive = target above shooter),
 *  fired at speed `v` under gravity `g`. Returns `null` when the
 *  target is unreachable with that speed. */
export function ballisticSolutions(
  d: number,
  h: number,
  v: number,
  g: number,
): BallisticSolution | null {
  if (d <= 1e-6) {
    // Target directly above / below the launch origin — straight up
    // or down is the only angle.
    const pitch = h >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return { low: pitch, high: pitch };
  }
  if (v <= 1e-6 || g <= 0) return null;

  const v2 = v * v;
  const v4 = v2 * v2;
  const disc = v4 - g * (g * d * d + 2 * h * v2);
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const gd = g * d;
  const tanLow = (v2 - sqrtDisc) / gd;
  const tanHigh = (v2 + sqrtDisc) / gd;
  return {
    low: Math.atan(tanLow),
    high: Math.atan(tanHigh),
  };
}

/** Convenience wrapper: pick the preferred arc (low by default, high
 *  for lobbing weapons) and fall back to a sensible "best effort"
 *  pitch when the target is out of ballistic range. That fallback is
 *  the elevation angle of maximum horizontal range for the given
 *  height difference — approximately 45° for level targets, tilted
 *  slightly up/down when the target is above/below. This keeps the
 *  turret aimed in a reasonable direction so a future in-range shot
 *  lands where the turret was already pointing. */
export function solveBallisticPitch(
  horizDist: number,
  heightDiff: number,
  launchSpeed: number,
  gravity: number,
  preferHigh: boolean,
): number {
  const sol = ballisticSolutions(horizDist, heightDiff, launchSpeed, gravity);
  if (sol) return preferHigh ? sol.high : sol.low;

  // Out of range. Keep low-arc weapons low even when no exact solution
  // exists; otherwise low/high aiming styles collapse to the same
  // 45-degree fallback at the edge of reach.
  if (horizDist <= 1e-6) return heightDiff >= 0 ? Math.PI / 2 : -Math.PI / 2;
  if (!preferHigh) return Math.atan2(heightDiff, horizDist);

  // High-arc fallback: maximum-range pitch for a launch that lands at
  // a height `h` relative to launcher is π/4 + atan(h/d)/2 (for large
  // enough v); at shorter v this collapses toward 45°. Use that as the
  // best-we-can-do lob.
  return Math.PI / 4 + Math.atan2(heightDiff, horizDist) * 0.5;
}

/**
 * Closed-form projectile-intercept time for a target moving with
 * constant velocity. Solves
 *
 *     |T0 + v_t · t  −  P0| = v_p · t          (t > 0)
 *
 * where T0 = target position (relative to shooter), v_t = target
 * velocity, v_p = projectile speed (assumed constant straight-line).
 * Squaring gives a quadratic in t:
 *
 *     (|v_t|² − v_p²) · t²  +  2 (T0 · v_t) · t  +  |T0|²  =  0
 *
 * Returns the smallest positive root, or 0 when no intercept exists
 * (target faster than projectile and pulling away, or moving with the
 * shot speed in a non-converging direction). The caller should fall
 * back to the unleaded target position when 0 is returned.
 *
 * The "straight-line at v_p" assumption is exact for non-ballistic
 * shots (lasers don't apply, dgun-style straight shots do). For
 * ballistic arcs it's a first-order approximation; pass v_p · cos(p)
 * (horizontal projectile speed at solved pitch p) for a refinement
 * pass on lobbed shots.
 */
export function computeInterceptTime(
  dx: number, dy: number, dz: number,
  vtx: number, vty: number, vtz: number,
  vp: number,
): number {
  const distSq = dx * dx + dy * dy + dz * dz;
  const vt2 = vtx * vtx + vty * vty + vtz * vtz;
  const dotDV = dx * vtx + dy * vty + dz * vtz;
  const a = vt2 - vp * vp;
  const b = 2 * dotDV;
  const c = distSq;

  // Linear case: target speed equals projectile speed.
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return 0;
    const t = -c / b;
    return t > 0 ? t : 0;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return 0; // Target out-runs the projectile.

  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t1 > 0 && t2 > 0) return Math.min(t1, t2);
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return 0;
}
