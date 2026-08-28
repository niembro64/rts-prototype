import type { Entity } from './types';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { clamp01 } from '../math';
import { getLiquidSurfaceLevel } from './worldSurfaceState';

type EntityMediumOccupancy = {
  aboveWater: number;
  underwater: number;
};

const _mediumOccupancy: EntityMediumOccupancy = {
  aboveWater: 1,
  underwater: 0,
};

/** Exact submerged volume fraction for a sphere cut by the water plane. */
function getSphericalUnderwaterFraction(
  centerZ: number,
  radius: number,
): number {
  if (!Number.isFinite(centerZ)) return 0;
  const waterLevel = getLiquidSurfaceLevel();
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  if (safeRadius <= 0) return centerZ <= waterLevel ? 1 : 0;
  const submergedHeight = clamp01(
    (waterLevel - (centerZ - safeRadius)) / (2 * safeRadius),
  ) * 2 * safeRadius;
  if (submergedHeight <= 0) return 0;
  if (submergedHeight >= 2 * safeRadius) return 1;
  return clamp01(
    submergedHeight * submergedHeight * (3 * safeRadius - submergedHeight)
      / (4 * safeRadius * safeRadius * safeRadius),
  );
}

/** Submerged volume fraction for an axis-aligned cuboid. */
export function getCuboidUnderwaterFraction(
  centerZ: number,
  halfHeight: number,
): number {
  if (!Number.isFinite(centerZ)) return 0;
  const waterLevel = getLiquidSurfaceLevel();
  const safeHalfHeight = Number.isFinite(halfHeight) && halfHeight > 0
    ? halfHeight
    : 0;
  if (safeHalfHeight <= 0) return centerZ <= waterLevel ? 1 : 0;
  const bottomZ = centerZ - safeHalfHeight;
  const submergedHeight = Math.max(
    0,
    Math.min(2 * safeHalfHeight, waterLevel - bottomZ),
  );
  return clamp01(submergedHeight / (2 * safeHalfHeight));
}

/**
 * Returns complementary above-water/underwater volume fractions for every
 * targetable entity family. Buildings use their combat cuboid and units use
 * their authored spherical hitbox. Travelling shots are points for medium
 * membership regardless of their collision radius.
 *
 * The returned object is reused. Callers must consume it synchronously.
 */
export function getEntityMediumOccupancy(entity: Entity): EntityMediumOccupancy {
  let underwater = 0;
  if (entity.building !== null) {
    underwater = getCuboidUnderwaterFraction(
      getBuildingCombatCenterZ(entity),
      entity.building.depth * 0.5,
    );
  } else if (entity.unit !== null) {
    underwater = getSphericalUnderwaterFraction(
      entity.transform.z,
      entity.unit.radius.hitbox,
    );
  } else if (entity.projectile !== null) {
    underwater = entity.transform.z <= getLiquidSurfaceLevel() ? 1 : 0;
  } else {
    underwater = entity.transform.z <= getLiquidSurfaceLevel() ? 1 : 0;
  }
  _mediumOccupancy.underwater = underwater;
  _mediumOccupancy.aboveWater = 1 - underwater;
  return _mediumOccupancy;
}
