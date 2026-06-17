import {
  GRAVITY,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
  UNIT_MASS_MULTIPLIER,
  UNIT_THRUST_MULTIPLIER_GAME,
} from '../../config';
import type { UnitLocomotion } from './types';
import {
  LOCOMOTION_FORCE_SCALE,
  getLocomotionForceProfile,
} from './locomotion';
import {
  PATHFINDING_FORCE_SAFETY_RATIO,
  PATHFINDING_STABILITY_MAX_SLOPE_DEG,
} from './pathfindingTuning';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  readonly minSurfaceNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly tractionLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
};

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function slopeDegToMinSurfaceNormalZ(slopeDeg: number): number {
  return Math.cos(slopeDeg * DEG_TO_RAD);
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME,
): LocomotionClimbProfile {
  if (locomotion.pathfinding.ignoreTerrainBlocking) {
    return {
      maxSlopeDeg: null,
      minSurfaceNormalZ: null,
      safeDriveAccel: Infinity,
      driveLimitedSlopeDeg: null,
      tractionLimitedSlopeDeg: null,
      stabilityLimitedSlopeDeg: null,
    };
  }
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }

  const forceProfile = getLocomotionForceProfile(
    locomotion,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    thrustMultiplier,
    LOCOMOTION_FORCE_SCALE,
  );
  const effectiveMass = mass * UNIT_MASS_MULTIPLIER;
  const safeDriveForceMagnitude =
    forceProfile.tractionForceMagnitude * PATHFINDING_FORCE_SAFETY_RATIO;
  const safeDriveAccel = safeDriveForceMagnitude * 1_000_000 / effectiveMass;
  const driveLimitedSlopeDeg = Math.asin(clamp01(safeDriveAccel / GRAVITY)) * RAD_TO_DEG;
  const tractionLimitedSlopeDeg = Math.atan(Math.max(0, locomotion.traction)) * RAD_TO_DEG;
  const stabilityLimitedSlopeDeg = PATHFINDING_STABILITY_MAX_SLOPE_DEG;
  const maxSlopeDeg = Math.max(
    0,
    Math.min(
      driveLimitedSlopeDeg,
      tractionLimitedSlopeDeg,
      stabilityLimitedSlopeDeg,
    ),
  );

  return {
    maxSlopeDeg,
    minSurfaceNormalZ: slopeDegToMinSurfaceNormalZ(maxSlopeDeg),
    safeDriveAccel,
    driveLimitedSlopeDeg,
    tractionLimitedSlopeDeg,
    stabilityLimitedSlopeDeg,
  };
}

export function minSurfaceNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minSurfaceNormalZ;
}
