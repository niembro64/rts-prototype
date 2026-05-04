import type { Entity, Unit } from './types';

type UnitBodyCenterSource = Pick<Unit, 'bodyCenterHeight' | 'radius'>;

export function getUnitBodyCenterHeight(unit?: UnitBodyCenterSource | null): number {
  return unit?.bodyCenterHeight ?? unit?.radius.push ?? 0;
}

export function getUnitGroundZ(entity: Pick<Entity, 'transform' | 'unit'>): number {
  return entity.transform.z - getUnitBodyCenterHeight(entity.unit);
}
