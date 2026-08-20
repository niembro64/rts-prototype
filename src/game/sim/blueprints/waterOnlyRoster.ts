// Which blueprints exist ONLY for water — derived from the blueprints
// themselves, never listed by hand.
//
// A hand-kept id list would be a second source of truth that goes stale the
// first time someone authors a new hull, so both answers come out of facts the
// blueprint already had to state:
//
//   A UNIT is water-only when its WAYPOINT domain is water and nothing else.
//   The waypoint domain is the set of media a player may intentionally send the
//   unit into (see unitLocomotion: `navigation.waypoint`), which is exactly the
//   question being asked — a hull that can be ordered onto ground or into the
//   air has somewhere to be on a dry map. Note this is deliberately NOT the
//   MOVE domain: every unit in the game authors a small positive water drive so
//   a body shoved into a lake can swim out again, and reading that would
//   classify the entire roster as aquatic. An amphibian or an aerosub keeps its
//   place; a submarine does not.
//
//   A BUILDING is water-only when every one of its placement sets is a water
//   set. A structure that authors even one ground set (the Extractor, the
//   Fabricator) still has a square to stand on when the map is dry.
//
// Both sets are computed once, lazily, on first ask — the blueprint tables are
// immutable for the life of the process, so the classification cannot change
// under us and never needs recomputing. Whether the sets are APPLIED is a
// separate question, and belongs to `mapHasWater()`.

import { getBuildingPlacementSetSquareType } from '../../../types/buildingTypes';
import { createUnitLocomotion } from '../unitLocomotion';
import { BUILDING_BLUEPRINTS } from './buildings';
import { UNIT_BLUEPRINTS } from './units';

let waterOnlyUnitBlueprintIds: ReadonlySet<string> | null = null;
let waterOnlyBuildingBlueprintIds: ReadonlySet<string> | null = null;

function computeWaterOnlyUnitBlueprintIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const blueprint of Object.values(UNIT_BLUEPRINTS)) {
    const waypoint = createUnitLocomotion(blueprint.unitLocomotion).navigation.waypoint;
    if (waypoint.allowInWater && !waypoint.allowOnGround && !waypoint.allowInAir) {
      ids.add(blueprint.unitBlueprintId);
    }
  }
  return ids;
}

function computeWaterOnlyBuildingBlueprintIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    const standsOnGround = blueprint.placementSets.some(
      (placementSet) => getBuildingPlacementSetSquareType(placementSet) === 'ground',
    );
    if (!standsOnGround) ids.add(blueprint.buildingBlueprintId);
  }
  return ids;
}

/** True when this unit has nowhere to be on a map with no water. */
export function isWaterOnlyUnitBlueprintId(unitBlueprintId: string): boolean {
  if (waterOnlyUnitBlueprintIds === null) {
    waterOnlyUnitBlueprintIds = computeWaterOnlyUnitBlueprintIds();
  }
  return waterOnlyUnitBlueprintIds.has(unitBlueprintId);
}

/** True when this structure has no square to stand on when the map is dry. */
export function isWaterOnlyBuildingBlueprintId(buildingBlueprintId: string): boolean {
  if (waterOnlyBuildingBlueprintIds === null) {
    waterOnlyBuildingBlueprintIds = computeWaterOnlyBuildingBlueprintIds();
  }
  return waterOnlyBuildingBlueprintIds.has(buildingBlueprintId);
}
