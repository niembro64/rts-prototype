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

type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  readonly minSurfaceNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly tractionLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
  readonly allowGround: boolean;
  readonly allowWater: boolean;
  readonly allowAir: boolean;
};

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function slopeDegToMinSurfaceNormalZ(slopeDeg: number): number {
  return Math.cos(slopeDeg * DEG_TO_RAD);
}

function mediumHasHorizontalAuthority(
  physics: UnitLocomotion['physics']['ground'],
): boolean {
  return physics.force > 0 && physics.traction > 0;
}

function mediumHasLiftAuthority(
  physics: UnitLocomotion['physics']['air'],
): boolean {
  return physics.buoyancy > 0 || physics.heightUpwardForce > 0;
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME,
): LocomotionClimbProfile {
  const groundPhysics = locomotion.physics.ground;
  const airPhysics = locomotion.physics.air;
  const waterPhysics = locomotion.physics.water;
  const allowGround = mediumHasHorizontalAuthority(groundPhysics);
  const allowWater = mediumHasHorizontalAuthority(waterPhysics);
  const allowAir = mediumHasHorizontalAuthority(airPhysics) && mediumHasLiftAuthority(airPhysics);

  if (allowAir) {
    return {
      maxSlopeDeg: null,
      minSurfaceNormalZ: null,
      safeDriveAccel: Infinity,
      driveLimitedSlopeDeg: null,
      tractionLimitedSlopeDeg: null,
      stabilityLimitedSlopeDeg: null,
      allowGround,
      allowWater,
      allowAir,
    };
  }
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }

  if (!allowGround) {
    return {
      maxSlopeDeg: null,
      minSurfaceNormalZ: null,
      safeDriveAccel: 0,
      driveLimitedSlopeDeg: null,
      tractionLimitedSlopeDeg: null,
      stabilityLimitedSlopeDeg: null,
      allowGround,
      allowWater,
      allowAir,
    };
  }

  const forceProfile = getLocomotionForceProfile(
    groundPhysics,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    thrustMultiplier,
    LOCOMOTION_FORCE_SCALE,
  );
  const effectiveMass = mass * UNIT_MASS_MULTIPLIER;
  const safeDriveForceMagnitude =
    forceProfile.tractionForceMagnitude * PATHFINDING_FORCE_SAFETY_RATIO;
  const safeDriveAccel = safeDriveForceMagnitude * 1_000_000 / effectiveMass;
  const driveLimitedSlopeDeg = Math.asin(clamp01(safeDriveAccel / GRAVITY)) * RAD_TO_DEG;
  const tractionLimitedSlopeDeg = Math.atan(Math.max(0, groundPhysics.traction)) * RAD_TO_DEG;
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
    allowGround,
    allowWater,
    allowAir,
  };
}

export function minSurfaceNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minSurfaceNormalZ;
}
