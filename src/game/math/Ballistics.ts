// Ballistic aim helpers. The core solver predicts entity velocity only;
// control acceleration is deliberately absent because it is too noisy to
// extrapolate. Projectile acceleration is
// gravity plus optional medium-relative linear damping.
// This file is imported by authoritative simulation and aim-preview callers.
// Zero state, pure functions.

import { getSimWasm } from '../sim-wasm/init';
import { deterministicMath as DMath } from '../sim/deterministicMath';

// Cached at module scope so the per-call dispatch in
// solveKinematicIntercept doesn't pay the function-call cost
// for every invocation. Refreshed once per call (cheap — a
// single module-scope pointer read) so it picks up the WASM
// handle as soon as initSimWasm() resolves during boot.
function simHandle() {
  return getSimWasm();
}

type KinematicVec3 = {
  x: number;
  y: number;
  z: number;
};

export type KinematicState3 = {
  position: KinematicVec3;
  velocity: KinematicVec3;
};

type KinematicInterceptInput = {
  myPosition: KinematicVec3;
  myVelocity: KinematicVec3;
  targetPosition: KinematicVec3;
  targetVelocity: KinematicVec3;
  projectileSpeed: number;
  /** Continuous linear damping rate in inverse seconds. */
  projectileLinearDampingRate?: number;
  /** Velocity of the surrounding medium in world units/s. */
  mediumVelocity?: KinematicVec3;
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

const INTERCEPT_SAMPLE_COUNT = 64;
const INTERCEPT_BISECT_STEPS = 14;
const INTERCEPT_MIN_TIME = 1 / 120;
const INTERCEPT_MAX_TIME = 30;
const INTERCEPT_ROOT_EPSILON = 1e-5;

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
  const dist = DMath.hypot(dx, dy, dz);
  const speed = input.projectileSpeed;
  const baseTime = speed > 1e-6 ? dist / speed : 0;
  const accelTime = input.gravity > 1e-6 ? (2 * speed) / input.gravity : 0;
  return clampTime(Math.max(2, baseTime * 8 + 4, accelTime * 2 + 1));
}

function getLinearDampingRate(input: KinematicInterceptInput): number {
  const rate = input.projectileLinearDampingRate ?? 0;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function getMediumVelocity(input: KinematicInterceptInput): KinematicVec3 | null {
  return getLinearDampingRate(input) > 0 && input.mediumVelocity !== undefined
    ? input.mediumVelocity
    : null;
}

function interceptFunction(input: KinematicInterceptInput, t: number): number {
  const myPos = input.myPosition;
  const myVel = input.myVelocity;
  const targetPos = input.targetPosition;
  const targetVel = input.targetVelocity;

  const relX = targetPos.x - myPos.x +
    (targetVel.x - myVel.x) * t;
  const relY = targetPos.y - myPos.y +
    (targetVel.y - myVel.y) * t;
  const relZ = targetPos.z - myPos.z +
    (targetVel.z - myVel.z) * t +
    0.5 * input.gravity * t * t;

  return DMath.hypot(relX, relY, relZ) - input.projectileSpeed * t;
}

function dampedRequiredWorldVelocityAxis(
  displacement: number,
  acceleration: number,
  time: number,
  dampingRate: number,
): number {
  const damp = DMath.exp(-dampingRate * time);
  const retentionLoss = 1 - damp;
  if (!Number.isFinite(retentionLoss) || retentionLoss <= 1e-12) return Number.NaN;
  const terminal = acceleration / dampingRate;
  return terminal + (displacement - terminal * time) * dampingRate / retentionLoss;
}

function dampedInterceptFunction(
  input: KinematicInterceptInput,
  t: number,
  dampingRate: number,
): number {
  const aimX = input.targetPosition.x + input.targetVelocity.x * t;
  const aimY = input.targetPosition.y + input.targetVelocity.y * t;
  const aimZ = input.targetPosition.z + input.targetVelocity.z * t;
  const medium = getMediumVelocity(input);
  const mediumX = medium === null ? 0 : medium.x;
  const mediumY = medium === null ? 0 : medium.y;
  const mediumZ = medium === null ? 0 : medium.z;

  const worldVx = dampedRequiredWorldVelocityAxis(
    aimX - input.myPosition.x - mediumX * t,
    0,
    t,
    dampingRate,
  ) + mediumX;
  const worldVy = dampedRequiredWorldVelocityAxis(
    aimY - input.myPosition.y - mediumY * t,
    0,
    t,
    dampingRate,
  ) + mediumY;
  const worldVz = dampedRequiredWorldVelocityAxis(
    aimZ - input.myPosition.z - mediumZ * t,
    -input.gravity,
    t,
    dampingRate,
  ) + mediumZ;
  if (!Number.isFinite(worldVx) || !Number.isFinite(worldVy) || !Number.isFinite(worldVz)) {
    return Number.POSITIVE_INFINITY;
  }

  return DMath.hypot(
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
  dampingRate: number,
  loT: number,
  hiT: number,
): number {
  let lo = loT;
  let hi = hiT;
  let loF = dampedInterceptFunction(input, lo, dampingRate);
  for (let i = 0; i < INTERCEPT_BISECT_STEPS; i++) {
    const mid = (lo + hi) * 0.5;
    const midF = dampedInterceptFunction(input, mid, dampingRate);
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
  out.aimPoint.x = input.targetPosition.x + input.targetVelocity.x * time;
  out.aimPoint.y = input.targetPosition.y + input.targetVelocity.y * time;
  out.aimPoint.z = input.targetPosition.z + input.targetVelocity.z * time;

  const invT = 1 / time;
  out.launchVelocity.x = (out.aimPoint.x - myPos.x) * invT - myVel.x;
  out.launchVelocity.y = (out.aimPoint.y - myPos.y) * invT - myVel.y;
  out.launchVelocity.z =
    (out.aimPoint.z - myPos.z) * invT - myVel.z + 0.5 * input.gravity * time;
  out.time = time;
  return out;
}

function writeDampedInterceptSolution(
  input: KinematicInterceptInput,
  time: number,
  dampingRate: number,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  out.aimPoint.x = input.targetPosition.x + input.targetVelocity.x * time;
  out.aimPoint.y = input.targetPosition.y + input.targetVelocity.y * time;
  out.aimPoint.z = input.targetPosition.z + input.targetVelocity.z * time;
  const medium = getMediumVelocity(input);
  const mediumX = medium === null ? 0 : medium.x;
  const mediumY = medium === null ? 0 : medium.y;
  const mediumZ = medium === null ? 0 : medium.z;

  const worldVx = dampedRequiredWorldVelocityAxis(
    out.aimPoint.x - input.myPosition.x - mediumX * time,
    0,
    time,
    dampingRate,
  ) + mediumX;
  const worldVy = dampedRequiredWorldVelocityAxis(
    out.aimPoint.y - input.myPosition.y - mediumY * time,
    0,
    time,
    dampingRate,
  ) + mediumY;
  const worldVz = dampedRequiredWorldVelocityAxis(
    out.aimPoint.z - input.myPosition.z - mediumZ * time,
    -input.gravity,
    time,
    dampingRate,
  ) + mediumZ;
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
const _noDampingInterceptInput: KinematicInterceptInput = {
  myPosition: { x: 0, y: 0, z: 0 },
  myVelocity: { x: 0, y: 0, z: 0 },
  targetPosition: { x: 0, y: 0, z: 0 },
  targetVelocity: { x: 0, y: 0, z: 0 },
  projectileSpeed: 0,
  projectileLinearDampingRate: 0,
  mediumVelocity: undefined,
  gravity: 0,
  preferLateSolution: false,
  maxTimeSec: 0,
};

function writeNoDampingInterceptInput(input: KinematicInterceptInput): KinematicInterceptInput {
  const noDampingInput = _noDampingInterceptInput;
  noDampingInput.myPosition = input.myPosition;
  noDampingInput.myVelocity = input.myVelocity;
  noDampingInput.targetPosition = input.targetPosition;
  noDampingInput.targetVelocity = input.targetVelocity;
  noDampingInput.projectileSpeed = input.projectileSpeed;
  noDampingInput.projectileLinearDampingRate = 0;
  noDampingInput.mediumVelocity = undefined;
  noDampingInput.gravity = input.gravity;
  noDampingInput.preferLateSolution = input.preferLateSolution;
  noDampingInput.maxTimeSec = input.maxTimeSec;
  return noDampingInput;
}

/**
 * Velocity-only intercept solver. Callers pass shooter and target position/
 * velocity plus the universal gravity constant. When
 * `projectileLinearDampingRate` is positive, the solver inverts the same
 * medium-relative linear damping model used by projectile integration.
 */
export function solveKinematicIntercept(
  input: KinematicInterceptInput,
  out: KinematicInterceptSolution,
): KinematicInterceptSolution | null {
  if (
    !isFiniteVec3(input.myPosition) ||
    !isFiniteVec3(input.myVelocity) ||
    !isFiniteVec3(input.targetPosition) ||
    !isFiniteVec3(input.targetVelocity) ||
    (
      input.mediumVelocity !== undefined &&
      !isFiniteVec3(input.mediumVelocity)
    ) ||
    !Number.isFinite(input.projectileSpeed) ||
    input.projectileSpeed <= 1e-6 ||
    !Number.isFinite(input.projectileLinearDampingRate ?? 0) ||
    (input.projectileLinearDampingRate ?? 0) < 0 ||
    !Number.isFinite(input.gravity) ||
    input.gravity < 0 ||
    !Number.isFinite(input.maxTimeSec) ||
    input.maxTimeSec < 0
  ) {
    return null;
  }

  const linearDampingRate = getLinearDampingRate(input);
  if (linearDampingRate > 0) {
    return solveKinematicInterceptTs(input, out);
  }

  const noDampingInput = input.mediumVelocity === undefined
    ? input
    : writeNoDampingInterceptInput(input);
  const sim = simHandle();
  if (sim !== undefined) {
    return solveKinematicInterceptWasm(sim, noDampingInput, out);
  }
  return solveKinematicInterceptTs(noDampingInput, out);
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
  buf[6] = 0;
  buf[7] = 0;
  buf[8] = 0;
  buf[9] = input.targetPosition.x;
  buf[10] = input.targetPosition.y;
  buf[11] = input.targetPosition.z;
  buf[12] = input.targetVelocity.x;
  buf[13] = input.targetVelocity.y;
  buf[14] = input.targetVelocity.z;
  buf[15] = 0;
  buf[16] = 0;
  buf[17] = 0;
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
  const linearDampingRate = getLinearDampingRate(input);
  if (linearDampingRate > 0) {
    return solveDampedKinematicInterceptTs(input, out, linearDampingRate);
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
  linearDampingRate: number,
): KinematicInterceptSolution | null {
  const dampingRate = linearDampingRate;
  if (!Number.isFinite(dampingRate) || dampingRate <= 1e-9) {
    return solveKinematicInterceptTs(writeNoDampingInterceptInput(input), out);
  }

  const maxTime = input.maxTimeSec > 0
    ? clampTime(input.maxTimeSec)
    : defaultInterceptMaxTime(input);
  if (maxTime <= INTERCEPT_MIN_TIME) return null;

  let selectedRoot = 0;
  let prevT = INTERCEPT_MIN_TIME;
  let prevF = dampedInterceptFunction(input, prevT, dampingRate);
  if (Math.abs(prevF) <= INTERCEPT_ROOT_EPSILON) {
    selectedRoot = prevT;
  }

  for (let i = 1; i <= INTERCEPT_SAMPLE_COUNT; i++) {
    const t = INTERCEPT_MIN_TIME +
      (maxTime - INTERCEPT_MIN_TIME) * i / INTERCEPT_SAMPLE_COUNT;
    const f = dampedInterceptFunction(input, t, dampingRate);
    if (!Number.isFinite(f) || !Number.isFinite(prevF)) {
      prevT = t;
      prevF = f;
      continue;
    }

    let root = 0;
    if (Math.abs(f) <= INTERCEPT_ROOT_EPSILON) {
      root = t;
    } else if ((prevF > 0 && f < 0) || (prevF < 0 && f > 0)) {
      root = bisectDampedInterceptRoot(input, dampingRate, prevT, t);
    }

    if (root > 0) {
      selectedRoot = root;
      if (!input.preferLateSolution) break;
    }

    prevT = t;
    prevF = f;
  }

  if (selectedRoot <= INTERCEPT_MIN_TIME) return null;
  return writeDampedInterceptSolution(input, selectedRoot, dampingRate, out);
}
