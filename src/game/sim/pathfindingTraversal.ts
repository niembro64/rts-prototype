import type { UnitLocomotion } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';

export type PathCostProfile = Readonly<{
  flatDriveAccel: number | null;
  safeDriveAccel: number;
  staticFrictionCoefficient: number;
}>;

export type PathTerrainFilter = Readonly<{
  navigation: UnitLocomotion['navigation'];
  minStandstillNormalZ: number | null;
  minClimbNormalZ: number | null;
  cost: PathCostProfile;
}>;

export type PathfinderTraversalInput = Readonly<{
  minStandstillNormalZ: number;
  minClimbNormalZ: number;
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
  flatDriveAccel: number;
  safeDriveAccel: number;
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
  const navigation = filter?.navigation ??
    { allowOnGround: true, allowInWater: false, allowInAir: false };
  const normal = navigation.allowInAir ? null : filter?.minStandstillNormalZ;
  const minStandstillNormalZ = finiteNormalOrZero(normal);
  const minClimbNormalZ = navigation.allowInAir
    ? 0
    : finiteNormalOrZero(filter?.minClimbNormalZ);
  const flatDriveAccel = filter?.cost.flatDriveAccel;
  return {
    minStandstillNormalZ,
    minClimbNormalZ,
    allowOnGround: navigation.allowOnGround,
    allowInWater: navigation.allowInWater,
    allowInAir: navigation.allowInAir,
    flatDriveAccel:
      flatDriveAccel !== null &&
      flatDriveAccel !== undefined &&
      Number.isFinite(flatDriveAccel) &&
      flatDriveAccel > 0
        ? flatDriveAccel
        : 0,
    safeDriveAccel: finitePositiveOrZero(filter?.cost.safeDriveAccel),
    staticFrictionCoefficient: finitePositiveOrZero(filter?.cost.staticFrictionCoefficient),
  };
}

function finitePositiveOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
  mass: number | undefined,
): PathTerrainFilter | null {
  if (locomotion === undefined || mass === undefined) return null;
  const mobility = computeLocomotionClimbProfile(locomotion, mass);
  return {
    navigation: { ...locomotion.navigation },
    minStandstillNormalZ: mobility.minStandstillNormalZ,
    minClimbNormalZ: mobility.minClimbNormalZ,
    cost: {
      flatDriveAccel: mobility.flatDriveAccel,
      safeDriveAccel: mobility.safeDriveAccel,
      staticFrictionCoefficient: mobility.staticFrictionCoefficient,
    },
  };
}

/** Stable cache identity for every traversal permission and route-cost input. */
export function pathTerrainFilterCacheKey(filter: PathTerrainFilter | null): string {
  if (filter === null) return 'default';
  return [
    `ground:${filter.navigation.allowOnGround}`,
    `water:${filter.navigation.allowInWater}`,
    `air:${filter.navigation.allowInAir}`,
    `standstill:${filter.minStandstillNormalZ ?? 'null'}`,
    `climb:${filter.minClimbNormalZ ?? 'null'}`,
    `accel:${filter.cost.flatDriveAccel ?? 'null'}`,
    `safe:${filter.cost.safeDriveAccel}`,
    `staticFriction:${filter.cost.staticFrictionCoefficient}`,
  ].join(':');
}
