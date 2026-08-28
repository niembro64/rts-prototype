import type { EmissionMediumTrajectoryMatrix } from '@/types/blueprintSchema.generated';
import type { Entity } from '../types';
import type { Vec3 } from '@/types/vec2';
import { getBuildingCombatCenterZ } from '../buildingAnchors';
import { getEntityMediumOccupancy } from '../entityMediumOccupancy';
import {
  emissionMediumAtZ,
  emissionMediumRouteAllows,
  type EmissionMedium,
} from '../emissionMedium';
import { getLiquidSurfaceLevel } from '../worldSurfaceState';

export function emissionCanTargetEntity(
  matrix: EmissionMediumTrajectoryMatrix,
  sourceMedium: EmissionMedium,
  target: Entity,
): boolean {
  const occupancy = getEntityMediumOccupancy(target);
  return (
    occupancy.aboveWater > 0 &&
    emissionMediumRouteAllows(matrix, sourceMedium, 'aboveWater')
  ) || (
    occupancy.underwater > 0 &&
    emissionMediumRouteAllows(matrix, sourceMedium, 'underwater')
  );
}

/**
 * Keeps ordinary deterministic aim geometry whenever its point medium is a
 * true route. Only moves the aim Z into another occupied, legal target-medium
 * slice when necessary; true cells have no source/same-medium preference.
 */
export function constrainAimPointToEmissionRoutes(
  matrix: EmissionMediumTrajectoryMatrix,
  sourceMedium: EmissionMedium,
  target: Entity,
  aimPoint: Vec3,
): boolean {
  if (!emissionCanTargetEntity(matrix, sourceMedium, target)) return false;
  const waterLevel = getLiquidSurfaceLevel();
  const normalTargetMedium = emissionMediumAtZ(aimPoint.z, waterLevel);
  if (emissionMediumRouteAllows(matrix, sourceMedium, normalTargetMedium)) {
    return true;
  }

  let centerZ = target.transform.z;
  let verticalExtent = 0;
  if (target.building !== null) {
    centerZ = getBuildingCombatCenterZ(target);
    verticalExtent = target.building.depth * 0.5;
  } else if (target.unit !== null) {
    verticalExtent = target.unit.radius.hitbox;
  }
  const bottomZ = centerZ - verticalExtent;
  const topZ = centerZ + verticalExtent;

  if (
    topZ > waterLevel &&
    emissionMediumRouteAllows(matrix, sourceMedium, 'aboveWater')
  ) {
    aimPoint.z = aimPoint.z > waterLevel
      ? Math.min(aimPoint.z, topZ)
      : waterLevel + (topZ - waterLevel) * 0.5;
    return true;
  }
  if (
    bottomZ < waterLevel &&
    emissionMediumRouteAllows(matrix, sourceMedium, 'underwater')
  ) {
    aimPoint.z = Math.max(bottomZ, Math.min(aimPoint.z, waterLevel));
    return true;
  }
  return false;
}
