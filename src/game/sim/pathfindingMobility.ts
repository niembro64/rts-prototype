import {
  GRAVITY,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
  UNIT_MASS_MULTIPLIER,
  UNIT_THRUST_MULTIPLIER_GAME,
} from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import type { UnitLocomotion } from './types';
import { getUnitLocomotionTraversalCapabilities } from './unitLocomotion';
import { UNIT_LOCOMOTION_FORCE_SCALE } from './unitLocomotionPresetConfig';
import {
  PATHFINDING_FORCE_SAFETY_RATIO,
  PATHFINDING_STABILITY_MAX_SLOPE_DEG,
} from './pathfindingTuning';

export type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  /** Minimum terrain-normal Z that can hold the unit at rest using its safe
   *  drive and Coulomb-grip budgets. Applies in every travel direction. */
  readonly minStandstillNormalZ: number | null;
  /** Uphill-only normal threshold after the standstill envelope is further
   *  constrained by the runtime force-coupling geometry. */
  readonly minClimbNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly gripLimitedSlopeDeg: number | null;
  readonly couplingLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
  /** Dry-ground tangential acceleration after the authoritative drive-force
   *  and Coulomb-grip clamp. */
  readonly flatDriveAccel: number | null;
  readonly allowOnGround: boolean;
  readonly allowInWater: boolean;
  readonly allowInAir: boolean;
  readonly surfaceGrip: number;
  readonly cacheKey: string;
};

const CLIMB_PROFILE_OUTPUT_LENGTH = 10;
const climbProfileOut = new Float64Array(CLIMB_PROFILE_OUTPUT_LENGTH);
const climbProfileCache = new Map<string, LocomotionClimbProfile>();

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME,
): LocomotionClimbProfile {
  const groundPhysics = locomotion.physics.ground;
  const { allowOnGround, allowInWater, allowInAir } =
    getUnitLocomotionTraversalCapabilities(locomotion.type);
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }
  const cacheKey = [
    groundPhysics.propulsion.driveForce,
    groundPhysics.propulsion.forceCoupling,
    groundPhysics.contact.surfaceGrip,
    mass,
    thrustMultiplier,
    UNIT_LOCOMOTION_FORCE_SCALE,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    UNIT_MASS_MULTIPLIER,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    PATHFINDING_STABILITY_MAX_SLOPE_DEG,
    locomotion.type,
  ].join(':');
  const cached = climbProfileCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Pathfinding mobility requires the authoritative simulation WASM to be initialized');
  }
  const computed = sim.pathfinder.computeLocomotionClimbProfile(
    groundPhysics.propulsion.driveForce,
    groundPhysics.propulsion.forceCoupling,
    groundPhysics.contact.surfaceGrip,
    mass,
    thrustMultiplier,
    UNIT_LOCOMOTION_FORCE_SCALE,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    UNIT_MASS_MULTIPLIER,
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
    minClimbNormalZ: finiteOrNull(climbProfileOut[8]),
    safeDriveAccel: climbProfileOut[2],
    driveLimitedSlopeDeg: finiteOrNull(climbProfileOut[3]),
    gripLimitedSlopeDeg: finiteOrNull(climbProfileOut[4]),
    couplingLimitedSlopeDeg: finiteOrNull(climbProfileOut[7]),
    stabilityLimitedSlopeDeg: finiteOrNull(climbProfileOut[5]),
    flatDriveAccel: finiteOrNull(climbProfileOut[6]),
    allowOnGround,
    allowInWater,
    allowInAir,
    surfaceGrip: climbProfileOut[9],
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
