import type { UnitBlueprintId } from '../../types/blueprintIds';
import type { BuildingBlueprintId, Entity } from './types';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';
import { getUnitBlueprint } from './blueprints';

const EMPTY_FACTORY_UNIT_ROSTER: readonly UnitBlueprintId[] = Object.freeze([]);

export function getStructureFactoryAllowedUnitBlueprintIds(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): readonly UnitBlueprintId[] {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return EMPTY_FACTORY_UNIT_ROSTER;
  return BUILDING_BLUEPRINTS[buildingBlueprintId]?.allowedUnitBlueprintIds ?? EMPTY_FACTORY_UNIT_ROSTER;
}

/** Mobile-factory (queen/carrier) rosters derive from the unit
 *  blueprint's spawn mounts — a unit blueprint carries no authored
 *  factory block (see WorldUnitFactory). Memoized per blueprint id so
 *  the per-tick production gate stays allocation-free. */
const UNIT_FACTORY_ROSTER_BY_BLUEPRINT = new Map<string, readonly UnitBlueprintId[]>();

function getUnitFactoryAllowedUnitBlueprintIds(unitBlueprintId: string): readonly UnitBlueprintId[] {
  let roster = UNIT_FACTORY_ROSTER_BY_BLUEPRINT.get(unitBlueprintId);
  if (roster === undefined) {
    const produced: UnitBlueprintId[] = [];
    try {
      const blueprint = getUnitBlueprint(unitBlueprintId);
      for (const mount of blueprint.turrets) {
        if (mount.producedBlueprintId !== null && mount.producedBlueprintId !== undefined) {
          produced.push(mount.producedBlueprintId as UnitBlueprintId);
        }
      }
    } catch {
      // Unknown blueprint id: empty roster.
    }
    roster = Object.freeze(produced);
    UNIT_FACTORY_ROSTER_BY_BLUEPRINT.set(unitBlueprintId, roster);
  }
  return roster;
}

export function getFactoryAllowedUnitBlueprintIds(
  factory: Entity | null | undefined,
): readonly UnitBlueprintId[] {
  if (factory === null || factory === undefined || factory.factory === null) return EMPTY_FACTORY_UNIT_ROSTER;
  if (factory.unit !== null) {
    return getUnitFactoryAllowedUnitBlueprintIds(factory.unit.unitBlueprintId);
  }
  return getStructureFactoryAllowedUnitBlueprintIds(factory.buildingBlueprintId);
}

export function factoryCanProduceUnit(
  factory: Entity | null | undefined,
  unitBlueprintId: string | null | undefined,
): boolean {
  if (unitBlueprintId === null || unitBlueprintId === undefined) return false;
  return getFactoryAllowedUnitBlueprintIds(factory).includes(unitBlueprintId as UnitBlueprintId);
}
