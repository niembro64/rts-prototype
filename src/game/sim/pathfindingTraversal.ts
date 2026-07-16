import type { UnitLocomotion } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';

export type PathCostProfile = Readonly<{
  /** Locomotion capability consumed by the abstract terrain-time cost model. */
  flatDriveAccel: number | null;
  safeDriveAccel: number;
  surfaceGrip: number;
}>;

export type PathTerrainFilter = Readonly<{
  minStandstillNormalZ: number | null;
  minClimbNormalZ: number | null;
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
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
  surfaceGrip: number;
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
  const normal = filter?.allowInAir === true ? null : filter?.minStandstillNormalZ;
  const minStandstillNormalZ = finiteNormalOrZero(normal);
  const minClimbNormalZ = filter?.allowInAir === true
    ? 0
    : finiteNormalOrZero(filter?.minClimbNormalZ);
  const flatDriveAccel = filter?.cost.flatDriveAccel;
  return {
    minStandstillNormalZ,
    minClimbNormalZ,
    allowOnGround: filter === null || filter.allowOnGround,
    allowInWater: filter?.allowInWater === true,
    allowInAir: filter?.allowInAir === true,
    flatDriveAccel:
      flatDriveAccel !== null &&
      flatDriveAccel !== undefined &&
      Number.isFinite(flatDriveAccel) &&
      flatDriveAccel > 0
        ? flatDriveAccel
        : 0,
    safeDriveAccel: finitePositiveOrZero(filter?.cost.safeDriveAccel),
    surfaceGrip: finitePositiveOrZero(filter?.cost.surfaceGrip),
  };
}

function finitePositiveOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
  mass: number | undefined,
  thrustMultiplier?: number,
): PathTerrainFilter | null {
  if (locomotion === undefined || mass === undefined) return null;
  const mobility = computeLocomotionClimbProfile(locomotion, mass, thrustMultiplier);
  return {
    minStandstillNormalZ: mobility.minStandstillNormalZ,
    minClimbNormalZ: mobility.minClimbNormalZ,
    allowOnGround: mobility.allowOnGround,
    allowInWater: mobility.allowInWater,
    allowInAir: mobility.allowInAir,
    cost: {
      flatDriveAccel: mobility.flatDriveAccel,
      safeDriveAccel: mobility.safeDriveAccel,
      surfaceGrip: mobility.surfaceGrip,
    },
  };
}

/** Stable cache identity for every traversal permission and route-cost input. */
export function pathTerrainFilterCacheKey(filter: PathTerrainFilter | null): string {
  if (filter === null) return 'default';
  return [
    filter.allowOnGround ? 'g1' : 'g0',
    filter.allowInWater ? 'w1' : 'w0',
    filter.allowInAir ? 'a1' : 'a0',
    `standstill:${filter.minStandstillNormalZ ?? 'null'}`,
    `climb:${filter.minClimbNormalZ ?? 'null'}`,
    `accel:${filter.cost.flatDriveAccel ?? 'null'}`,
    `safe:${filter.cost.safeDriveAccel}`,
    `grip:${filter.cost.surfaceGrip}`,
  ].join(':');
}
