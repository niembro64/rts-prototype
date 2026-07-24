import { GRAVITY, UNIT_MASS_MULTIPLIER } from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import type { UnitLocomotion } from './types';
import { PATHFINDING_FORCE_SAFETY_RATIO } from './pathfindingTuning';
import { SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD } from './surfaceProbeSets';

export type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  /** Minimum dry-terrain normal supported by safe propulsion and Coulomb grip. */
  readonly minGroundNormalZ: number | null;
  /** Full-immersion commanded wet movement may use both contact drive and water propulsion.
   * Fluid-supported bodies use null because lakebed slope is irrelevant. */
  readonly maxWaterMoveSlopeDeg: number | null;
  readonly minWaterMoveNormalZ: number | null;
  /** Full-immersion wet waypoint envelope after commanded water thrust ends. */
  readonly maxWaterWaypointSlopeDeg: number | null;
  readonly minWaterWaypointNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly safeWaterDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly tractionLimitedSlopeDeg: number | null;
  readonly flatDriveAccel: number | null;
  readonly flatWaterContactAccel: number | null;
  readonly waterSurfaceSupported: boolean;
  readonly allowOnGround: boolean;
  readonly allowInWater: boolean;
  readonly allowInAir: boolean;
  /** Coulomb coefficient after the same traversal reserve as propulsion. */
  readonly staticFrictionCoefficient: number;
  readonly cacheKey: string;
};

const CLIMB_PROFILE_OUTPUT_LENGTH = 12;
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
  const waterPhysics = locomotion.physics.water;
  const { allowOnGround, allowInWater, allowInAir } = locomotion.navigation.move;
  const groundMaxPropulsiveForce = allowOnGround
    ? groundPhysics.maxPropulsiveForce
    : 0;
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }
  const physicsMass = mass * UNIT_MASS_MULTIPLIER;
  const weightForce = physicsMass * GRAVITY / 1_000_000;
  const waterLift = waterPhysics.lift;
  const maximumInverseWaterLift =
    waterLift.surfaceFollowingInverseForceFromGround /
    SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD;
  const waterSurfaceSupported = allowInWater && (
    maximumInverseWaterLift >= weightForce ||
    waterLift.surfaceFollowingProportionalForceFromWater > 0
  );
  const cacheKey = [
    groundMaxPropulsiveForce,
    waterPhysics.maxPropulsiveForce,
    groundPhysics.staticFrictionCoefficient,
    physicsMass,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    allowOnGround,
    allowInWater,
    allowInAir,
    maximumInverseWaterLift,
    waterLift.surfaceFollowingProportionalForceFromWater,
    waterSurfaceSupported,
  ].join(':');
  const cached = climbProfileCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Pathfinding mobility requires the authoritative simulation WASM to be initialized');
  }
  const computed = sim.pathfinder.computeLocomotionClimbProfile(
    groundMaxPropulsiveForce,
    waterPhysics.maxPropulsiveForce,
    groundPhysics.staticFrictionCoefficient,
    physicsMass,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    allowOnGround,
    allowInWater,
    allowInAir,
    waterSurfaceSupported,
    climbProfileOut,
  );
  if (computed !== 1) {
    throw new Error(`WASM rejected pathfinding mobility inputs for mass ${mass}`);
  }

  const profile: LocomotionClimbProfile = Object.freeze({
    maxSlopeDeg: finiteOrNull(climbProfileOut[0]),
    minGroundNormalZ: finiteOrNull(climbProfileOut[1]),
    safeDriveAccel: climbProfileOut[2],
    driveLimitedSlopeDeg: finiteOrNull(climbProfileOut[3]),
    tractionLimitedSlopeDeg: finiteOrNull(climbProfileOut[4]),
    flatDriveAccel: finiteOrNull(climbProfileOut[5]),
    maxWaterMoveSlopeDeg: finiteOrNull(climbProfileOut[6]),
    minWaterMoveNormalZ: finiteOrNull(climbProfileOut[7]),
    safeWaterDriveAccel: climbProfileOut[8],
    flatWaterContactAccel: finiteOrNull(climbProfileOut[9]),
    maxWaterWaypointSlopeDeg: finiteOrNull(climbProfileOut[10]),
    minWaterWaypointNormalZ: finiteOrNull(climbProfileOut[11]),
    waterSurfaceSupported,
    allowOnGround,
    allowInWater,
    allowInAir,
    staticFrictionCoefficient:
      groundPhysics.staticFrictionCoefficient * PATHFINDING_FORCE_SAFETY_RATIO,
    cacheKey,
  });
  climbProfileCache.set(cacheKey, profile);
  return profile;
}

export function minGroundMoveNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minGroundNormalZ;
}
