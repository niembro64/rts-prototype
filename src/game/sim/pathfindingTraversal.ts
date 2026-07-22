import type { UnitLocomotion } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';

export type PathCostProfile = Readonly<{
  flatDriveAccel: number | null;
  safeDriveAccel: number;
  flatWaterContactAccel: number | null;
  safeWaterDriveAccel: number;
  staticFrictionCoefficient: number;
}>;

export type PathTerrainFilter = Readonly<{
  navigation: UnitLocomotion['navigation'];
  minGroundNormalZ: number | null;
  waterSurfaceSupported: boolean;
  supportPointOffsetZ: number;
  cost: PathCostProfile;
}>;

export type PathfinderTraversalInput = Readonly<{
  minGroundNormalZ: number;
  waterSurfaceSupported: boolean;
  supportPointOffsetZ: number;
  waypoint: UnitLocomotion['navigation']['waypoint'];
  move: UnitLocomotion['navigation']['move'];
  flatDriveAccel: number;
  safeDriveAccel: number;
  flatWaterContactAccel: number;
  safeWaterDriveAccel: number;
  staticFrictionCoefficient: number;
}>;

function finiteNormalOrZero(value: number | null | undefined): number {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? Math.min(1, value)
    : 0;
}

/** Decode nullable public filter state once for each WASM query. */
export function resolvePathfinderTraversalInput(
  filter: PathTerrainFilter | null,
): PathfinderTraversalInput {
  const navigation = filter?.navigation ?? {
    waypoint: { allowOnGround: true, allowInWater: false, allowInAir: false },
    move: { allowOnGround: true, allowInWater: false, allowInAir: false },
  };
  const minGroundNormalZ = navigation.move.allowInAir
    ? 0
    : finiteNormalOrZero(filter?.minGroundNormalZ);
  const flatDriveAccel = filter?.cost.flatDriveAccel;
  const flatWaterContactAccel = filter?.cost.flatWaterContactAccel;
  return {
    minGroundNormalZ,
    waterSurfaceSupported: filter?.waterSurfaceSupported === true,
    supportPointOffsetZ: finitePositiveOrZero(filter?.supportPointOffsetZ),
    waypoint: { ...navigation.waypoint },
    move: { ...navigation.move },
    flatDriveAccel:
      flatDriveAccel !== null &&
      flatDriveAccel !== undefined &&
      Number.isFinite(flatDriveAccel) &&
      flatDriveAccel > 0
        ? flatDriveAccel
        : 0,
    safeDriveAccel: finitePositiveOrZero(filter?.cost.safeDriveAccel),
    flatWaterContactAccel:
      flatWaterContactAccel !== null &&
      flatWaterContactAccel !== undefined &&
      Number.isFinite(flatWaterContactAccel) &&
      flatWaterContactAccel > 0
        ? flatWaterContactAccel
        : 0,
    safeWaterDriveAccel: finitePositiveOrZero(filter?.cost.safeWaterDriveAccel),
    staticFrictionCoefficient: finitePositiveOrZero(filter?.cost.staticFrictionCoefficient),
  };
}

function finitePositiveOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
  mass: number | undefined,
  supportPointOffsetZ: number | undefined,
): PathTerrainFilter | null {
  if (locomotion === undefined || mass === undefined) return null;
  const mobility = computeLocomotionClimbProfile(locomotion, mass);
  return {
    navigation: {
      waypoint: { ...locomotion.navigation.waypoint },
      move: { ...locomotion.navigation.move },
    },
    minGroundNormalZ: mobility.minGroundNormalZ,
    waterSurfaceSupported: mobility.waterSurfaceSupported,
    supportPointOffsetZ: finitePositiveOrZero(supportPointOffsetZ),
    cost: {
      flatDriveAccel: mobility.flatDriveAccel,
      safeDriveAccel: mobility.safeDriveAccel,
      flatWaterContactAccel: mobility.flatWaterContactAccel,
      safeWaterDriveAccel: mobility.safeWaterDriveAccel,
      staticFrictionCoefficient: mobility.staticFrictionCoefficient,
    },
  };
}

/** Stable cache identity for every traversal permission and route-cost input. */
export function pathTerrainFilterCacheKey(filter: PathTerrainFilter | null): string {
  if (filter === null) return 'default';
  return [
    `waypoint-ground:${filter.navigation.waypoint.allowOnGround}`,
    `waypoint-water:${filter.navigation.waypoint.allowInWater}`,
    `waypoint-air:${filter.navigation.waypoint.allowInAir}`,
    `move-ground:${filter.navigation.move.allowOnGround}`,
    `move-water:${filter.navigation.move.allowInWater}`,
    `move-air:${filter.navigation.move.allowInAir}`,
    `groundNormal:${filter.minGroundNormalZ ?? 'null'}`,
    `waterSurfaceSupported:${filter.waterSurfaceSupported}`,
    `supportPointOffsetZ:${filter.supportPointOffsetZ}`,
    `accel:${filter.cost.flatDriveAccel ?? 'null'}`,
    `safe:${filter.cost.safeDriveAccel}`,
    `waterAccel:${filter.cost.flatWaterContactAccel ?? 'null'}`,
    `waterSafe:${filter.cost.safeWaterDriveAccel}`,
    `staticFriction:${filter.cost.staticFrictionCoefficient}`,
  ].join(':');
}
