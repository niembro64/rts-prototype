/**
 * Authored terrain requirements for map roster filtering.
 *
 * These are availability facts, not locomotion or placement deductions. A
 * unit may be able to recover through water without needing water to be useful,
 * and a building may support multiple placement surfaces without requiring
 * either terrain type to exist. Keeping these decisions on the entity
 * blueprints gives lobby previews, runtime rosters, and build authorization one
 * shared source of truth.
 */

import { BUILDING_BLUEPRINTS } from './buildings';
import type { BuildingBlueprint } from './buildings';
import { UNIT_BLUEPRINTS } from './units';

const BUILDING_BLUEPRINTS_BY_STRING = BUILDING_BLUEPRINTS as Readonly<
  Partial<Record<string, BuildingBlueprint>>
>;

export function isWaterOnlyUnitBlueprintId(unitBlueprintId: string): boolean {
  return UNIT_BLUEPRINTS[unitBlueprintId]?.requiresWater === true;
}

export function isLandOnlyUnitBlueprintId(unitBlueprintId: string): boolean {
  return UNIT_BLUEPRINTS[unitBlueprintId]?.requiresLand === true;
}

export function isWaterOnlyBuildingBlueprintId(buildingBlueprintId: string): boolean {
  return BUILDING_BLUEPRINTS_BY_STRING[buildingBlueprintId]?.requiresWater === true;
}

export function isLandOnlyBuildingBlueprintId(buildingBlueprintId: string): boolean {
  return BUILDING_BLUEPRINTS_BY_STRING[buildingBlueprintId]?.requiresLand === true;
}
