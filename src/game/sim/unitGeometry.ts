import type { Entity, Unit } from './types';

type UnitBodyCenterSource = Pick<Unit, 'bodyCenterHeight' | 'radius'>;

export function getUnitBodyCenterHeight(unit?: UnitBodyCenterSource | null): number {
  return unit?.bodyCenterHeight ?? unit?.radius.push ?? 0;
}

/** World Z of the host's footprint base — the height the host sits on
 *  the terrain. For units that's `transform.z - bodyCenterHeight` since
 *  the unit chassis floats above the ground at body-center height. For
 *  buildings it's `transform.z - depth/2` since transform.z is the
 *  vertical center of the cuboid collider and depth/2 spans down to
 *  the foundation. The combat pipeline composes turret world Z as
 *  `groundZ + mount.z`, so the same math works for both hosts. */
export function getUnitGroundZ(entity: Pick<Entity, 'transform' | 'unit' | 'building'>): number {
  if (entity.unit) return entity.transform.z - getUnitBodyCenterHeight(entity.unit);
  if (entity.building) return entity.transform.z - entity.building.depth / 2;
  return entity.transform.z;
}
