import type { UnitLocomotion } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';
import { getUnitLocomotionTraversalCapabilities } from './unitLocomotion';
import type { UnitLocomotionType } from '@/types/unitLocomotionTypes';

export type PathCostProfile = Readonly<{
  /** Locomotion capability consumed by the abstract terrain-time cost model. */
  flatDriveAccel: number | null;
  safeDriveAccel: number;
  surfaceGrip: number;
}>;

export type PathTerrainFilter = Readonly<{
  /** The authored locomotion mechanism. Compatibility flags are produced
   * only at the WASM boundary from this field. */
  locomotionType: UnitLocomotionType;
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
  const capabilities = filter === null
    ? { allowOnGround: true, allowInWater: false, allowInAir: false }
    : getUnitLocomotionTraversalCapabilities(filter.locomotionType);
  const normal = capabilities.allowInAir ? null : filter?.minStandstillNormalZ;
  const minStandstillNormalZ = finiteNormalOrZero(normal);
  const minClimbNormalZ = capabilities.allowInAir
    ? 0
    : finiteNormalOrZero(filter?.minClimbNormalZ);
  const flatDriveAccel = filter?.cost.flatDriveAccel;
  return {
    minStandstillNormalZ,
    minClimbNormalZ,
    allowOnGround: capabilities.allowOnGround,
    allowInWater: capabilities.allowInWater,
    allowInAir: capabilities.allowInAir,
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
    locomotionType: locomotion.type,
    minStandstillNormalZ: mobility.minStandstillNormalZ,
    minClimbNormalZ: mobility.minClimbNormalZ,
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
    `locomotion:${filter.locomotionType}`,
    `standstill:${filter.minStandstillNormalZ ?? 'null'}`,
    `climb:${filter.minClimbNormalZ ?? 'null'}`,
    `accel:${filter.cost.flatDriveAccel ?? 'null'}`,
    `safe:${filter.cost.safeDriveAccel}`,
    `grip:${filter.cost.surfaceGrip}`,
  ].join(':');
}
