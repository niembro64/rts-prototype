import type { UnitBlueprintId } from '../../types/blueprintIds';
import type { BuildingBlueprintId, Entity } from './types';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';

const EMPTY_FACTORY_UNIT_ROSTER: readonly UnitBlueprintId[] = Object.freeze([]);

export function getStructureFactoryAllowedUnitBlueprintIds(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): readonly UnitBlueprintId[] {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return EMPTY_FACTORY_UNIT_ROSTER;
  return BUILDING_BLUEPRINTS[buildingBlueprintId]?.allowedUnitBlueprintIds ?? EMPTY_FACTORY_UNIT_ROSTER;
}

export function getFactoryAllowedUnitBlueprintIds(
  factory: Entity | null | undefined,
): readonly UnitBlueprintId[] {
  if (factory === null || factory === undefined || factory.factory === null) return EMPTY_FACTORY_UNIT_ROSTER;
  return getStructureFactoryAllowedUnitBlueprintIds(factory.buildingBlueprintId);
}

export function factoryCanProduceUnit(
  factory: Entity | null | undefined,
  unitBlueprintId: string | null | undefined,
): boolean {
  if (unitBlueprintId === null || unitBlueprintId === undefined) return false;
  return getFactoryAllowedUnitBlueprintIds(factory).includes(unitBlueprintId as UnitBlueprintId);
}
