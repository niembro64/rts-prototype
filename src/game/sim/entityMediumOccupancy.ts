import { isProjectileShot, type Entity } from './types';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { WATER_LEVEL } from './Terrain';

export type EntityMediumOccupancy = {
  aboveWater: number;
  underwater: number;
};

const _mediumOccupancy: EntityMediumOccupancy = {
  aboveWater: 1,
  underwater: 0,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Exact submerged volume fraction for a sphere cut by the water plane. */
export function getSphericalUnderwaterFraction(
  centerZ: number,
  radius: number,
): number {
  if (!Number.isFinite(centerZ)) return 0;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  if (safeRadius <= 0) return centerZ <= WATER_LEVEL ? 1 : 0;
  const submergedHeight = clamp01(
    (WATER_LEVEL - (centerZ - safeRadius)) / (2 * safeRadius),
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
  const safeHalfHeight = Number.isFinite(halfHeight) && halfHeight > 0
    ? halfHeight
    : 0;
  if (safeHalfHeight <= 0) return centerZ <= WATER_LEVEL ? 1 : 0;
  const bottomZ = centerZ - safeHalfHeight;
  const submergedHeight = Math.max(
    0,
    Math.min(2 * safeHalfHeight, WATER_LEVEL - bottomZ),
  );
  return clamp01(submergedHeight / (2 * safeHalfHeight));
}

/**
 * Returns complementary above-water/underwater volume fractions for every
 * targetable entity family. Buildings use their combat cuboid; units and
 * travelling projectiles use their authored spherical hitbox.
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
    const shot = entity.projectile.config.shot;
    const radius = isProjectileShot(shot)
      ? shot.radius.hitbox
      : 0;
    underwater = getSphericalUnderwaterFraction(entity.transform.z, radius);
  } else {
    underwater = entity.transform.z <= WATER_LEVEL ? 1 : 0;
  }
  _mediumOccupancy.underwater = underwater;
  _mediumOccupancy.aboveWater = 1 - underwater;
  return _mediumOccupancy;
}
