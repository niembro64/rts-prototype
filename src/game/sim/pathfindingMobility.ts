import { GRAVITY, UNIT_MASS_MULTIPLIER } from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import type { UnitLocomotion } from './types';
import {
  PATHFINDING_FORCE_SAFETY_RATIO,
  PATHFINDING_STABILITY_MAX_SLOPE_DEG,
} from './pathfindingTuning';

export type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  /** Minimum terrain-normal Z that can hold the unit at rest using its safe
   * direct-force and static-friction budgets. */
  readonly minStandstillNormalZ: number | null;
  /** Identical to the standstill envelope: there is no separate coupling
   * cutoff for uphill propulsion. */
  readonly minClimbNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly tractionLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
  readonly flatDriveAccel: number | null;
  readonly allowOnGround: boolean;
  readonly allowInWater: boolean;
  readonly allowInAir: boolean;
  readonly staticFrictionCoefficient: number;
  readonly cacheKey: string;
};

const CLIMB_PROFILE_OUTPUT_LENGTH = 9;
const climbProfileOut = new Float64Array(CLIMB_PROFILE_OUTPUT_LENGTH);
const climbProfileCache = new Map<string, LocomotionClimbProfile>();

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
): LocomotionClimbProfile {
  const groundPhysics = locomotion.physics.ground;
  const { allowOnGround, allowInWater, allowInAir } = locomotion.navigation;
  const groundMaxPropulsiveForce = allowOnGround
    ? locomotion.actuator.maxPropulsiveForce
    : 0;
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }
  const physicsMass = mass * UNIT_MASS_MULTIPLIER;
  const cacheKey = [
    groundMaxPropulsiveForce,
    groundPhysics.staticFrictionCoefficient,
    physicsMass,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    PATHFINDING_STABILITY_MAX_SLOPE_DEG,
    allowOnGround,
    allowInWater,
    allowInAir,
  ].join(':');
  const cached = climbProfileCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Pathfinding mobility requires the authoritative simulation WASM to be initialized');
  }
  const computed = sim.pathfinder.computeLocomotionClimbProfile(
    groundMaxPropulsiveForce,
    groundPhysics.staticFrictionCoefficient,
    physicsMass,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    PATHFINDING_STABILITY_MAX_SLOPE_DEG,
    allowOnGround,
    allowInAir,
    climbProfileOut,
  );
  if (computed !== 1) {
    throw new Error(`WASM rejected pathfinding mobility inputs for mass ${mass}`);
  }

  const profile: LocomotionClimbProfile = Object.freeze({
    maxSlopeDeg: finiteOrNull(climbProfileOut[0]),
    minStandstillNormalZ: finiteOrNull(climbProfileOut[1]),
    minClimbNormalZ: finiteOrNull(climbProfileOut[7]),
    safeDriveAccel: climbProfileOut[2],
    driveLimitedSlopeDeg: finiteOrNull(climbProfileOut[3]),
    tractionLimitedSlopeDeg: finiteOrNull(climbProfileOut[4]),
    stabilityLimitedSlopeDeg: finiteOrNull(climbProfileOut[5]),
    flatDriveAccel: finiteOrNull(climbProfileOut[6]),
    allowOnGround,
    allowInWater,
    allowInAir,
    staticFrictionCoefficient: climbProfileOut[8],
    cacheKey,
  });
  climbProfileCache.set(cacheKey, profile);
  return profile;
}

export function minStandstillNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minStandstillNormalZ;
}
