import type { Entity, Unit } from './types';

type UnitBodyCenterSource = Pick<Unit, 'supportPointOffsetZ' | 'radius'>;

export function getUnitSupportPointOffsetZ(
  unit: UnitBodyCenterSource | null | undefined = null,
): number {
  if (unit === null || unit === undefined) return 0;
  return unit.supportPointOffsetZ ?? unit.radius.collision;
}

/** World Z of the host's footprint base — the height the host sits on
 *  the terrain. For units that's `transform.z - supportPointOffsetZ` since
 *  the unit chassis floats above the ground by its support-point offset. For
 *  buildings it's `transform.z - depth/2` since transform.z is the
 *  vertical center of the cuboid collider and depth/2 spans down to
 *  the foundation. The combat pipeline composes turret world Z as
 *  `groundZ + mount.z`, so the same math works for both hosts. */
export function getUnitGroundZ(entity: Pick<Entity, 'transform' | 'unit' | 'building'>): number {
  if (entity.unit) return entity.transform.z - getUnitSupportPointOffsetZ(entity.unit);
  if (entity.building) return entity.transform.z - entity.building.depth / 2;
  return entity.transform.z;
}
