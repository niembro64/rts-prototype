// Ballistic aim helpers. The core solver finds intercept time from raw
// shooter ("my") and target kinematic vectors under constant acceleration;
// projectile acceleration is gravity plus optional wind-relative linear
// air-drag force.
// solveTurretShotAngles is the single turret-facing API that turns that
// intercept into yaw/pitch. Low arcs use the earliest root. High arcs require
// a distinct later lofted root instead of silently using the only/low root.
// This file is imported by both the authoritative sim and client prediction.
// Zero state, pure functions.

import { getSimWasm } from '../sim-wasm/init';
import { dragRateFromVelocityFrictionPer60HzFrame } from '../sim/motionFriction';

// Cached at module scope so the per-call dispatch in
// solveKinematicIntercept doesn't pay the function-call cost
// for every invocation. Refreshed once per call (cheap — a
// single module-scope pointer read) so it picks up the WASM
// handle as soon as initSimWasm() resolves during boot.
function simHandle() {
  return getSimWasm();
}

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
  myPosition: KinematicVec3;
  myVelocity: KinematicVec3;
  myAcceleration: KinematicVec3;
  targetPosition: KinematicVec3;
  targetVelocity: KinematicVec3;
  targetAcceleration: KinematicVec3;
  projectileSpeed: number;
  projectileMass?: number;
  /** Per-shot velocity loss authored as friction per 60 Hz frame. */
  projectileAirFrictionPer60HzFrame?: number;
  /** Air velocity in world units/s. Used only by drag-aware projectile solves. */
  windVelocity?: KinematicVec3;
  /** Universal gravity constant in world units/s^2. Projectile acceleration is (0, 0, -gravity). */
  gravity: number;
  preferLateSolution: boolean;
  /** Positive values cap the search horizon; 0 asks the solver to choose one. */
  maxTimeSec: number;
};

export type KinematicInterceptSolution = {
  time: number;
  aimPoint: KinematicVec3;
  launchVelocity: KinematicVec3;
};

export type TurretShotArcPreference = 'low' | 'high';

export type TurretShotAngleInput = {
  myPosition: KinematicVec3;
  myVelocity: KinematicVec3;
  myAcceleration: KinematicVec3;
  targetPosition: KinematicVec3;
  targetVelocity: KinematicVec3;
  targetAcceleration: KinematicVec3;
  projectileSpeed: number;
  projectileMass?: number;
  /** Per-shot velocity loss authored as friction per 60 Hz frame. */
  projectileAirFrictionPer60HzFrame?: number;
  /** Air velocity in world units/s. Used only by drag-aware projectile solves. */
  windVelocity?: KinematicVec3;
  /** Universal gravity constant in world units/s^2. Projectile acceleration is (0, 0, -gravity). */
  gravity: number;
  arcPreference: TurretShotArcPreference;
  /** Positive values cap the search horizon; 0 asks the solver to choose one. */
  maxTimeSec: number;
};

export type TurretShotAngleSolution = KinematicInterceptSolution & {
  yaw: number;
  pitch: number;
  direction: KinematicVec3;
};

const INTERCEPT_SAMPLE_COUNT = 64;
const INTERCEPT_BISECT_STEPS = 14;
const INTERCEPT_MIN_TIME = 1 / 120;
const INTERCEPT_MAX_TIME = 30;
const INTERCEPT_ROOT_EPSILON = 1e-5;
const HIGH_ARC_MIN_TIME_SEPARATION = 1 / 120;
const SHOT_DIRECTION_EPSILON = 1e-6;

export function integrateConstantAccelerationPosition(
  position: number,
  velocity: number,
  acceleration: number,
  dtSec: number,
): number {
  return position + velocity * dtSec + 0.5 * acceleration * dtSec * dtSec;
}

export function integrateConstantAccelerationVelocity(
  velocity: number,
  acceleration: number,
  dtSec: number,
): number {
  return velocity + acceleration * dtSec;
}

function isFiniteVec3(v: KinematicVec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function clampTime(value: number): number {
  return Math.max(INTERCEPT_MIN_TIME, Math.min(INTERCEPT_MAX_TIME, value));
}

function defaultInterceptMaxTime(input: KinematicInterceptInput): number {
  const dx = input.targetPosition.x - input.myPosition.x;
  const dy = input.targetPosition.y - input.myPosition.y;
  const dz = input.targetPosition.z - input.myPosition.z;
  const dist = Math.hypot(dx, dy, dz);
  const speed = input.projectileSpeed;
  const baseTime = speed > 1e-6 ? dist / speed : 0;
  const myAccel = input.myAcceleration;
  const relAx =
    (input.targetAcceleration.x - myAccel.x) -
    (0 - myAccel.x);
  const relAy =
    (input.targetAcceleration.y - myAccel.y) -
    (0 - myAccel.y);
  const relAz =
    (input.targetAcceleration.z - myAccel.z) -
    (-input.gravity - myAccel.z);
  const relAccel = Math.hypot(relAx, relAy, relAz);
  const accelTime = relAccel > 1e-6 ? (2 * speed) / relAccel : 0;
  return clampTime(Math.max(2, baseTime * 8 + 4, accelTime * 2 + 1));
}

function getAirFrictionPer60HzFrame(input: KinematicInterceptInput): number {
  const friction = input.projectileAirFrictionPer60HzFrame ?? 0;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

function getWindVelocity(input: KinematicInterceptInput): KinematicVec3 | null {
  const wind = input.windVelocity;
  return wind === undefined ? null : wind;
}

function getProjectileMass(input: KinematicInterceptInput): number {
  const mass = input.projectileMass;
  return Number.isFinite(mass) && mass !== undefined && mass > 1e-6 ? mass : 0;
}

function interceptFunction(input: KinematicInterceptInput, t: number): number {
  const myPos = input.myPosition;
  const myVel = input.myVelocity;
  const myAcc = input.myAcceleration;
  const targetPos = input.targetPosition;
  const targetVel = input.targetVelocity;
  const targetAcc = input.targetAcceleration;
  const relProjectileAx = 0 - myAcc.x;
  const relProjectileAy = 0 - myAcc.y;
  const relProjectileAz = -input.gravity - myAcc.z;
  const relTargetAx = targetAcc.x - myAcc.x;
  const relTargetAy = targetAcc.y - myAcc.y;
  const relTargetAz = targetAcc.z - myAcc.z;

  const relX = targetPos.x - myPos.x +
    (targetVel.x - myVel.x) * t +
    0.5 * (relTargetAx - relProjectileAx) * t * t;
  const relY = targetPos.y - myPos.y +
    (targetVel.y - myVel.y) * t +
    0.5 * (relTargetAy - relProjectileAy) * t * t;
  const relZ = targetPos.z - myPos.z +
    (targetVel.z - myVel.z) * t +
    0.5 * (relTargetAz - relProjectileAz) * t * t;

  return Math.hypot(relX, relY, relZ) - input.projectileSpeed * t;
}

function dampedRequiredWorldVelocityAxis(
  displacement: number,
  acceleration: number,
  time: number,
  dragK: number,
): number {
  const damp = Math.exp(-dragK * time);
  const retentionLoss = 1 - damp;
  if (!Number.isFinite(retentionLoss) || retentionLoss <= 1e-12) return Number.NaN;
  const terminal = acceleration / dragK;
  return terminal + (displacement - terminal * time) * dragK / retentionLoss;
}

function dampedInterceptFunction(
  input: KinematicInterceptInput,
  t: number,
  dragK: number,
): number {
  const aimX = input.targetPosition.x +
    input.targetVelocity.x * t +
    0.5 * input.targetAcceleration.x * t * t;
  const aimY = input.targetPosition.y +
    input.targetVelocity.y * t +
    0.5 * input.targetAcceleration.y * t * t;
  const aimZ = input.targetPosition.z +
    input.targetVelocity.z * t +
    0.5 * input.targetAcceleration.z * t * t;
  const wind = getWindVelocity(input);
  const windX = wind === null ? 0 : wind.x;
  const windY = wind === null ? 0 : wind.y;
  const windZ = wind === null ? 0 : wind.z;

  const worldVx = dampedRequiredWorldVelocityAxis(
    aimX - input.myPosition.x - windX * t,
    0,
    t,
    dragK,
  ) + windX;
  const worldVy = dampedRequiredWorldVelocityAxis(
    aimY - input.myPosition.y - windY * t,
    0,
    t,
    dragK,
  ) + windY;
  const worldVz = dampedRequiredWorldVelocityAxis(
    aimZ - input.myPosition.z - windZ * t,
    -input.gravity,
    t,
    dragK,
  ) + windZ;
  if (!Number.isFinite(worldVx) || !Number.isFinite(worldVy) || !Number.isFinite(worldVz)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.hypot(
    worldVx - input.myVelocity.x,
    worldVy - input.myVelocity.y,
    worldVz - input.myVelocity.z,
  ) - input.projectileSpeed;
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

function bisectDampedInterceptRoot(
  input: KinematicInterceptInput,
  dragK: number,
  loT: number,
  hiT: number,
): number {
  let lo = loT;
  let hi = hiT;
  let loF = dampedInterceptFunction(input, lo, dragK);
  for (let i = 0; i < INTERCEPT_BISECT_STEPS; i++) {
    const mid = (lo + hi) * 0.5;
    const midF = dampedInterceptFunction(input, mid, dragK);
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

function writeInterceptSolution(
  input: KinematicInterceptInput,
  time: number,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution {
  const myPos = input.myPosition;
  const myVel = input.myVelocity;
  const myAcc = input.myAcceleration;
  out.aimPoint.x = input.targetPosition.x + input.targetVelocity.x * time + 0.5 * input.targetAcceleration.x * time * time;
  out.aimPoint.y = input.targetPosition.y + input.targetVelocity.y * time + 0.5 * input.targetAcceleration.y * time * time;
  out.aimPoint.z = input.targetPosition.z + input.targetVelocity.z * time + 0.5 * input.targetAcceleration.z * time * time;

  const originX = myPos.x + myVel.x * time + 0.5 * myAcc.x * time * time;
  const originY = myPos.y + myVel.y * time + 0.5 * myAcc.y * time * time;
  const originZ = myPos.z + myVel.z * time + 0.5 * myAcc.z * time * time;
  const projectileRelAx = 0 - myAcc.x;
  const projectileRelAy = 0 - myAcc.y;
  const projectileRelAz = -input.gravity - myAcc.z;
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

function writeDampedInterceptSolution(
  input: KinematicInterceptInput,
  time: number,
  dragK: number,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  out.aimPoint.x = input.targetPosition.x + input.targetVelocity.x * time + 0.5 * input.targetAcceleration.x * time * time;
  out.aimPoint.y = input.targetPosition.y + input.targetVelocity.y * time + 0.5 * input.targetAcceleration.y * time * time;
  out.aimPoint.z = input.targetPosition.z + input.targetVelocity.z * time + 0.5 * input.targetAcceleration.z * time * time;
  const wind = getWindVelocity(input);
  const windX = wind === null ? 0 : wind.x;
  const windY = wind === null ? 0 : wind.y;
  const windZ = wind === null ? 0 : wind.z;

  const worldVx = dampedRequiredWorldVelocityAxis(
    out.aimPoint.x - input.myPosition.x - windX * time,
    0,
    time,
    dragK,
  ) + windX;
  const worldVy = dampedRequiredWorldVelocityAxis(
    out.aimPoint.y - input.myPosition.y - windY * time,
    0,
    time,
    dragK,
  ) + windY;
  const worldVz = dampedRequiredWorldVelocityAxis(
    out.aimPoint.z - input.myPosition.z - windZ * time,
    -input.gravity,
    time,
    dragK,
  ) + windZ;
  if (!Number.isFinite(worldVx) || !Number.isFinite(worldVy) || !Number.isFinite(worldVz)) {
    return null;
  }

  out.launchVelocity.x = worldVx - input.myVelocity.x;
  out.launchVelocity.y = worldVy - input.myVelocity.y;
  out.launchVelocity.z = worldVz - input.myVelocity.z;
  out.time = time;
  return out;
}

// Phase 5b — solveKinematicIntercept dispatches through the Rust
// kernel when the WASM module is loaded. Module-scope scratch
// buffers keep per-call allocation down to zero. The pure-TS
// implementation below stays as a fallback for the bootstrap
// window (initSimWasm hasn't resolved) and as a reference impl.
const _interceptInputScratch = new Float64Array(22);
const _interceptOutScratch = new Float64Array(7);
const _lowArcProbeSolution: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};
const _turretInterceptInput: KinematicInterceptInput = {
  myPosition: { x: 0, y: 0, z: 0 },
  myVelocity: { x: 0, y: 0, z: 0 },
  myAcceleration: { x: 0, y: 0, z: 0 },
  targetPosition: { x: 0, y: 0, z: 0 },
  targetVelocity: { x: 0, y: 0, z: 0 },
  targetAcceleration: { x: 0, y: 0, z: 0 },
  projectileSpeed: 0,
  projectileMass: 0,
  projectileAirFrictionPer60HzFrame: 0,
  windVelocity: undefined,
  gravity: 0,
  preferLateSolution: false,
  maxTimeSec: 0,
};
const _noFrictionInterceptInput: KinematicInterceptInput = {
  myPosition: { x: 0, y: 0, z: 0 },
  myVelocity: { x: 0, y: 0, z: 0 },
  myAcceleration: { x: 0, y: 0, z: 0 },
  targetPosition: { x: 0, y: 0, z: 0 },
  targetVelocity: { x: 0, y: 0, z: 0 },
  targetAcceleration: { x: 0, y: 0, z: 0 },
  projectileSpeed: 0,
  projectileMass: 0,
  projectileAirFrictionPer60HzFrame: 0,
  windVelocity: undefined,
  gravity: 0,
  preferLateSolution: false,
  maxTimeSec: 0,
};

/**
 * Constant-acceleration intercept solver. Callers pass only raw kinematic
 * vectors for the shooter ("my") and target states, plus the universal
 * gravity constant. When `projectileAirFrictionPer60HzFrame` is positive,
 * the solver inverts the same wind-relative linear drag-force model used by
 * projectile integration, with drag acceleration scaled by projectile mass.
 */
export function solveKinematicIntercept(
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  if (
    !isFiniteVec3(input.myPosition) ||
    !isFiniteVec3(input.myVelocity) ||
    !isFiniteVec3(input.myAcceleration) ||
    !isFiniteVec3(input.targetPosition) ||
    !isFiniteVec3(input.targetVelocity) ||
    !isFiniteVec3(input.targetAcceleration) ||
    (
      input.windVelocity !== undefined &&
      !isFiniteVec3(input.windVelocity)
    ) ||
    !Number.isFinite(input.projectileSpeed) ||
    input.projectileSpeed <= 1e-6 ||
    !Number.isFinite(input.projectileMass ?? 0) ||
    (input.projectileMass ?? 0) < 0 ||
    !Number.isFinite(input.projectileAirFrictionPer60HzFrame ?? 0) ||
    (input.projectileAirFrictionPer60HzFrame ?? 0) < 0 ||
    (input.projectileAirFrictionPer60HzFrame ?? 0) >= 1 ||
    (
      (input.projectileAirFrictionPer60HzFrame ?? 0) > 0 &&
      (input.projectileMass ?? 0) <= 1e-6
    ) ||
    !Number.isFinite(input.gravity) ||
    input.gravity < 0 ||
    !Number.isFinite(input.maxTimeSec) ||
    input.maxTimeSec < 0
  ) {
    return null;
  }

  const airFrictionPer60HzFrame = getAirFrictionPer60HzFrame(input);
  if (airFrictionPer60HzFrame > 0) {
    return solveKinematicInterceptTs(input, out);
  }

  const sim = simHandle();
  if (sim !== undefined) {
    return solveKinematicInterceptWasm(sim, input, out);
  }
  return solveKinematicInterceptTs(input, out);
}

/**
 * Canonical turret shot-angle solver. Callers provide raw kinematic vectors
 * for the firing mount and target plus the universal gravity constant; this
 * returns the yaw/pitch for the launch velocity that actually reaches the
 * target. `low` selects the earliest intercept root. `high` keeps the later
 * lofted root only when it is distinct from the earliest root.
 */
export function solveTurretShotAngles(
  input: TurretShotAngleInput,
  out: TurretShotAngleSolution,
): TurretShotAngleSolution | null {
  const interceptInput = _turretInterceptInput;
  interceptInput.myPosition = input.myPosition;
  interceptInput.myVelocity = input.myVelocity;
  interceptInput.myAcceleration = input.myAcceleration;
  interceptInput.targetPosition = input.targetPosition;
  interceptInput.targetVelocity = input.targetVelocity;
  interceptInput.targetAcceleration = input.targetAcceleration;
  interceptInput.projectileSpeed = input.projectileSpeed;
  interceptInput.projectileMass = input.projectileMass;
  interceptInput.projectileAirFrictionPer60HzFrame = input.projectileAirFrictionPer60HzFrame;
  interceptInput.windVelocity = input.windVelocity;
  interceptInput.gravity = input.gravity;
  interceptInput.preferLateSolution = false;
  interceptInput.maxTimeSec = input.maxTimeSec;

  let intercept: KinematicInterceptSolution | null = null;
  if (input.arcPreference === 'high') {
    const lowIntercept = solveKinematicIntercept(interceptInput, _lowArcProbeSolution);
    interceptInput.preferLateSolution = true;
    intercept = solveKinematicIntercept(interceptInput, out);
    if (
      intercept !== null &&
      (
        lowIntercept === null ||
        intercept.time <= lowIntercept.time + HIGH_ARC_MIN_TIME_SEPARATION
      )
    ) {
      return null;
    }
  } else {
    intercept = solveKinematicIntercept(interceptInput, out);
  }
  if (intercept === null) return null;

  const launch = out.launchVelocity;
  const horizontal = Math.hypot(launch.x, launch.y);
  const speed = Math.hypot(horizontal, launch.z);
  if (!Number.isFinite(speed) || speed <= SHOT_DIRECTION_EPSILON) return null;

  out.direction.x = launch.x / speed;
  out.direction.y = launch.y / speed;
  out.direction.z = launch.z / speed;
  out.yaw = horizontal > SHOT_DIRECTION_EPSILON
    ? Math.atan2(launch.y, launch.x)
    : Math.atan2(
        out.aimPoint.y - input.myPosition.y,
        out.aimPoint.x - input.myPosition.x,
      );
  out.pitch = Math.atan2(launch.z, horizontal);
  return out;
}

function solveKinematicInterceptWasm(
  sim: NonNullable<ReturnType<typeof simHandle>>,
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  const buf = _interceptInputScratch;
  buf[0] = input.myPosition.x;
  buf[1] = input.myPosition.y;
  buf[2] = input.myPosition.z;
  buf[3] = input.myVelocity.x;
  buf[4] = input.myVelocity.y;
  buf[5] = input.myVelocity.z;
  buf[6] = input.myAcceleration.x;
  buf[7] = input.myAcceleration.y;
  buf[8] = input.myAcceleration.z;
  buf[9] = input.targetPosition.x;
  buf[10] = input.targetPosition.y;
  buf[11] = input.targetPosition.z;
  buf[12] = input.targetVelocity.x;
  buf[13] = input.targetVelocity.y;
  buf[14] = input.targetVelocity.z;
  buf[15] = input.targetAcceleration.x;
  buf[16] = input.targetAcceleration.y;
  buf[17] = input.targetAcceleration.z;
  buf[18] = 0;
  buf[19] = 0;
  buf[20] = -input.gravity;
  buf[21] = input.projectileSpeed;
  const preferLate = input.preferLateSolution ? 1 : 0;
  const found = sim.solveKinematicIntercept(
    buf,
    _interceptOutScratch,
    preferLate,
    input.maxTimeSec,
  );
  if (found === 0) return null;
  out.time = _interceptOutScratch[0];
  out.aimPoint.x = _interceptOutScratch[1];
  out.aimPoint.y = _interceptOutScratch[2];
  out.aimPoint.z = _interceptOutScratch[3];
  out.launchVelocity.x = _interceptOutScratch[4];
  out.launchVelocity.y = _interceptOutScratch[5];
  out.launchVelocity.z = _interceptOutScratch[6];
  return out;
}

function solveKinematicInterceptTs(
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  const airFrictionPer60HzFrame = getAirFrictionPer60HzFrame(input);
  if (airFrictionPer60HzFrame > 0) {
    return solveDampedKinematicInterceptTs(input, out, airFrictionPer60HzFrame);
  }

  const maxTime = input.maxTimeSec > 0
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

function solveDampedKinematicInterceptTs(
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
  airFrictionPer60HzFrame: number,
): KinematicInterceptSolution | null {
  const dragK = getProjectileMass(input) > 0
    ? dragRateFromVelocityFrictionPer60HzFrame(airFrictionPer60HzFrame)
    : 0;
  if (!Number.isFinite(dragK) || dragK <= 1e-9) {
    const noFrictionInput = _noFrictionInterceptInput;
    noFrictionInput.myPosition = input.myPosition;
    noFrictionInput.myVelocity = input.myVelocity;
    noFrictionInput.myAcceleration = input.myAcceleration;
    noFrictionInput.targetPosition = input.targetPosition;
    noFrictionInput.targetVelocity = input.targetVelocity;
    noFrictionInput.targetAcceleration = input.targetAcceleration;
    noFrictionInput.projectileSpeed = input.projectileSpeed;
    noFrictionInput.projectileMass = input.projectileMass;
    noFrictionInput.projectileAirFrictionPer60HzFrame = 0;
    noFrictionInput.windVelocity = input.windVelocity;
    noFrictionInput.gravity = input.gravity;
    noFrictionInput.preferLateSolution = input.preferLateSolution;
    noFrictionInput.maxTimeSec = input.maxTimeSec;
    return solveKinematicInterceptTs(noFrictionInput, out);
  }

  const maxTime = input.maxTimeSec > 0
    ? clampTime(input.maxTimeSec)
    : defaultInterceptMaxTime(input);
  if (maxTime <= INTERCEPT_MIN_TIME) return null;

  let selectedRoot = 0;
  let prevT = INTERCEPT_MIN_TIME;
  let prevF = dampedInterceptFunction(input, prevT, dragK);
  if (Math.abs(prevF) <= INTERCEPT_ROOT_EPSILON) {
    selectedRoot = prevT;
  }

  for (let i = 1; i <= INTERCEPT_SAMPLE_COUNT; i++) {
    const t = INTERCEPT_MIN_TIME +
      (maxTime - INTERCEPT_MIN_TIME) * i / INTERCEPT_SAMPLE_COUNT;
    const f = dampedInterceptFunction(input, t, dragK);
    if (!Number.isFinite(f) || !Number.isFinite(prevF)) {
      prevT = t;
      prevF = f;
      continue;
    }

    let root = 0;
    if (Math.abs(f) <= INTERCEPT_ROOT_EPSILON) {
      root = t;
    } else if ((prevF > 0 && f < 0) || (prevF < 0 && f > 0)) {
      root = bisectDampedInterceptRoot(input, dragK, prevT, t);
    }

    if (root > 0) {
      selectedRoot = root;
      if (!input.preferLateSolution) break;
    }

    prevT = t;
    prevF = f;
  }

  if (selectedRoot <= INTERCEPT_MIN_TIME) return null;
  return writeDampedInterceptSolution(input, selectedRoot, dragK, out);
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
