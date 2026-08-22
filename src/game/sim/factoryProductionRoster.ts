import type { UnitBlueprintId } from '../../types/blueprintIds';
import type { BuildingBlueprintId, Entity } from './types';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';
import { getUnitBlueprint } from './blueprints';
import { unitBlueprintIdsForMediumKey } from './mapRoster';
import { installedMapMediumKey, MEDIUM_KEY_BOTH } from './mapSurface';

const EMPTY_FACTORY_UNIT_ROSTER: readonly UnitBlueprintId[] = Object.freeze([]);

/** Authored roster narrowed to what the installed map can field — water-only
 *  hulls gone on a dry map, land-only hulls gone on an all-sea one — memoized
 *  per (factory blueprint, medium key) so the per-tick production gate stays
 *  allocation-free on every map kind. The narrowing is a pure function of the
 *  authored roster; which variant applies is decided per call by the
 *  installed map's medium key. */
const NARROWED_ROSTER_BY_STRUCTURE = new Map<string, readonly UnitBlueprintId[]>();

function narrowedRoster(
  cache: Map<string, readonly UnitBlueprintId[]>,
  blueprintKey: string,
  mediumKey: number,
  authored: readonly UnitBlueprintId[],
): readonly UnitBlueprintId[] {
  const key = `${blueprintKey}|${mediumKey}`;
  let roster = cache.get(key);
  if (roster === undefined) {
    roster = Object.freeze([...unitBlueprintIdsForMediumKey(authored, mediumKey)]);
    cache.set(key, roster);
  }
  return roster;
}

export function getStructureFactoryAllowedUnitBlueprintIds(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): readonly UnitBlueprintId[] {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return EMPTY_FACTORY_UNIT_ROSTER;
  const authored =
    BUILDING_BLUEPRINTS[buildingBlueprintId]?.allowedUnitBlueprintIds ?? EMPTY_FACTORY_UNIT_ROSTER;
  const mediumKey = installedMapMediumKey();
  if (mediumKey === MEDIUM_KEY_BOTH) return authored;
  return narrowedRoster(NARROWED_ROSTER_BY_STRUCTURE, buildingBlueprintId, mediumKey, authored);
}

/** Mobile-factory (queen/carrier) rosters derive from the unit host's
 *  factoryProducedUnitBlueprintId. Memoized per blueprint id so the per-tick
 *  production gate stays allocation-free. */
const UNIT_FACTORY_ROSTER_BY_BLUEPRINT = new Map<string, readonly UnitBlueprintId[]>();
const NARROWED_ROSTER_BY_UNIT = new Map<string, readonly UnitBlueprintId[]>();

function getUnitFactoryAllowedUnitBlueprintIds(unitBlueprintId: string): readonly UnitBlueprintId[] {
  let roster = UNIT_FACTORY_ROSTER_BY_BLUEPRINT.get(unitBlueprintId);
  if (roster === undefined) {
    const produced: UnitBlueprintId[] = [];
    try {
      const blueprint = getUnitBlueprint(unitBlueprintId);
      const producedUnitBlueprintId = blueprint.factoryProducedUnitBlueprintId ?? null;
      if (producedUnitBlueprintId !== null) produced.push(producedUnitBlueprintId);
    } catch {
      // Unknown blueprint id: empty roster.
    }
    roster = Object.freeze(produced);
    UNIT_FACTORY_ROSTER_BY_BLUEPRINT.set(unitBlueprintId, roster);
  }
  const mediumKey = installedMapMediumKey();
  if (mediumKey === MEDIUM_KEY_BOTH) return roster;
  return narrowedRoster(NARROWED_ROSTER_BY_UNIT, unitBlueprintId, mediumKey, roster);
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
