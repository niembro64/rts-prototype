// Which blueprints exist ONLY for one medium — derived from the blueprints
// themselves, never listed by hand.
//
// A hand-kept id list would be a second source of truth that goes stale the
// first time someone authors a new hull, so both answers come out of facts the
// blueprint already had to state:
//
//   A UNIT is single-medium when its WAYPOINT domain names exactly one place a
//   player may intentionally send it. The waypoint domain (see unitLocomotion:
//   `navigation.waypoint`) is exactly the question being asked — a hull that
//   can be ordered onto ground OR into the air has somewhere to be on a dry
//   map, and one that can be ordered into water OR the air has somewhere to be
//   on a landless one. Note this is deliberately NOT the MOVE domain: every
//   unit in the game authors a small positive water drive so a body shoved
//   into a lake can swim out again, and reading that would classify the entire
//   roster as aquatic. An amphibian or an aerosub belongs to both questions'
//   "keep" set; a submarine is water-only; a tank is land-only; every flyer is
//   neither.
//
//   A BUILDING is water-only when every one of its placement sets is a water
//   set, and land-only when every one is a ground set. A structure that
//   authors both (the Extractor, the Fabricator) always has a square to stand
//   on.
//
// The classification is computed once, lazily, in ONE pass — the blueprint
// tables are immutable for the life of the process, so it cannot change under
// us and never needs recomputing. Whether it is APPLIED is a separate
// question, and belongs to `mapSurface.ts`.

import { getBuildingPlacementSetSquareType } from '../../../types/buildingTypes';
import { createUnitLocomotion } from '../unitLocomotion';
import { BUILDING_BLUEPRINTS } from './buildings';
import { UNIT_BLUEPRINTS } from './units';

type OnlyMedium = 'water' | 'land' | null;

let unitMediumById: ReadonlyMap<string, OnlyMedium> | null = null;
let buildingMediumById: ReadonlyMap<string, OnlyMedium> | null = null;

function computeUnitMediums(): ReadonlyMap<string, OnlyMedium> {
  const mediums = new Map<string, OnlyMedium>();
  for (const blueprint of Object.values(UNIT_BLUEPRINTS)) {
    const waypoint = createUnitLocomotion(blueprint.unitLocomotion).navigation.waypoint;
    let medium: OnlyMedium = null;
    if (waypoint.allowInWater && !waypoint.allowOnGround && !waypoint.allowInAir) {
      medium = 'water';
    } else if (waypoint.allowOnGround && !waypoint.allowInWater && !waypoint.allowInAir) {
      medium = 'land';
    }
    mediums.set(blueprint.unitBlueprintId, medium);
  }
  return mediums;
}

function computeBuildingMediums(): ReadonlyMap<string, OnlyMedium> {
  const mediums = new Map<string, OnlyMedium>();
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    let standsOnGround = false;
    let standsOnWater = false;
    for (const placementSet of blueprint.placementSets) {
      if (getBuildingPlacementSetSquareType(placementSet) === 'ground') standsOnGround = true;
      else standsOnWater = true;
    }
    const medium: OnlyMedium =
      standsOnGround && !standsOnWater ? 'land'
      : standsOnWater && !standsOnGround ? 'water'
      : null;
    mediums.set(blueprint.buildingBlueprintId, medium);
  }
  return mediums;
}

function unitMedium(unitBlueprintId: string): OnlyMedium {
  unitMediumById ??= computeUnitMediums();
  return unitMediumById.get(unitBlueprintId) ?? null;
}

function buildingMedium(buildingBlueprintId: string): OnlyMedium {
  buildingMediumById ??= computeBuildingMediums();
  return buildingMediumById.get(buildingBlueprintId) ?? null;
}

/** True when this unit has nowhere to be on a map with no water. */
export function isWaterOnlyUnitBlueprintId(unitBlueprintId: string): boolean {
  return unitMedium(unitBlueprintId) === 'water';
}

/** True when this unit has nowhere to be on a map with no dry ground. */
export function isLandOnlyUnitBlueprintId(unitBlueprintId: string): boolean {
  return unitMedium(unitBlueprintId) === 'land';
}

/** True when this structure has no square to stand on when the map is dry. */
export function isWaterOnlyBuildingBlueprintId(buildingBlueprintId: string): boolean {
  return buildingMedium(buildingBlueprintId) === 'water';
}

/** True when this structure has no square to stand on when the map is all
 *  sea. */
export function isLandOnlyBuildingBlueprintId(buildingBlueprintId: string): boolean {
  return buildingMedium(buildingBlueprintId) === 'land';
}
