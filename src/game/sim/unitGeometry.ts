import type { Entity, Unit } from './types';

type UnitBodyCenterSource = Pick<Unit, 'bodyCenterHeight' | 'unitRadiusCollider'>;

export function getUnitBodyCenterHeight(unit?: UnitBodyCenterSource | null): number {
  return unit?.bodyCenterHeight ?? unit?.unitRadiusCollider.push ?? 0;
}

export function getUnitGroundZ(entity: Pick<Entity, 'transform' | 'unit'>): number {
  return entity.transform.z - getUnitBodyCenterHeight(entity.unit);
}
