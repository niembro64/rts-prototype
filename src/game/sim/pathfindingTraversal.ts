import type { UnitLocomotion } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';
import { PATHFINDING_STABILITY_MIN_NORMAL_Z } from './pathfindingTuning';

export type PathCostProfile = Readonly<{
  /** Locomotion capability consumed by the abstract terrain-time cost model. */
  flatDriveAccel: number | null;
}>;

export type PathTerrainFilter = Readonly<{
  minSurfaceNormalZ: number | null;
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
  cost: PathCostProfile;
}>;

export type PathfinderTraversalInput = Readonly<{
  minSurfaceNormalZ: number;
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
  flatDriveAccel: number;
}>;

/** Decode nullable public filter state once for each WASM query. */
export function resolvePathfinderTraversalInput(
  filter: PathTerrainFilter | null,
): PathfinderTraversalInput {
  const normal = filter?.allowInAir === true ? null : filter?.minSurfaceNormalZ;
  const minSurfaceNormalZ =
    normal !== null &&
    normal !== undefined &&
    Number.isFinite(normal) &&
    normal > PATHFINDING_STABILITY_MIN_NORMAL_Z
      ? Math.min(1, normal)
      : 0;
  const flatDriveAccel = filter?.cost.flatDriveAccel;
  return {
    minSurfaceNormalZ,
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
  };
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
  mass: number | undefined,
  thrustMultiplier?: number,
): PathTerrainFilter | null {
  if (locomotion === undefined || mass === undefined) return null;
  const mobility = computeLocomotionClimbProfile(locomotion, mass, thrustMultiplier);
  return {
    minSurfaceNormalZ: mobility.minSurfaceNormalZ,
    allowOnGround: mobility.allowOnGround,
    allowInWater: mobility.allowInWater,
    allowInAir: mobility.allowInAir,
    cost: { flatDriveAccel: mobility.flatDriveAccel },
  };
}

/** Stable cache identity for every traversal permission and route-cost input. */
export function pathTerrainFilterCacheKey(filter: PathTerrainFilter | null): string {
  if (filter === null) return 'default';
  return [
    filter.allowOnGround ? 'g1' : 'g0',
    filter.allowInWater ? 'w1' : 'w0',
    filter.allowInAir ? 'a1' : 'a0',
    `min:${filter.minSurfaceNormalZ ?? 'null'}`,
    `accel:${filter.cost.flatDriveAccel ?? 'null'}`,
  ].join(':');
}
