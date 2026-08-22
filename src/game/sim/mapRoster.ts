// What this map can field.
//
// Joins the two halves that are deliberately kept apart: `mapSurface` knows
// whether a map has water and whether it has land, `mediumOnlyRoster` knows
// which blueprints exist only for one medium. Neither knows about the other;
// this is the one place the facts meet, so every roster surface — factory
// menus, builder build lists, the demo layout, the lobby grids — narrows in
// exactly the same way.
//
// A map with BOTH mediums returns the caller's own array untouched, so the
// common case costs one comparison and allocates nothing.

import {
  MEDIUM_KEY_BOTH,
  MEDIUM_KEY_LAND,
  MEDIUM_KEY_WATER,
  mapMediumKeyForSetup,
  type MapSurfaceSetup,
} from './mapSurface';
import {
  isLandOnlyBuildingBlueprintId,
  isLandOnlyUnitBlueprintId,
  isWaterOnlyBuildingBlueprintId,
  isWaterOnlyUnitBlueprintId,
} from './blueprints/mediumOnlyRoster';

/** The units a map with these mediums can field. `mediumKey` is the 2-bit
 *  pack from mapSurface (`installedMapMediumKey` / `mapMediumKeyForSetup`). */
export function unitBlueprintIdsForMediumKey<T extends string>(
  unitBlueprintIds: readonly T[],
  mediumKey: number,
): readonly T[] {
  if (mediumKey === MEDIUM_KEY_BOTH) return unitBlueprintIds;
  return unitBlueprintIds.filter((id) => {
    if ((mediumKey & MEDIUM_KEY_WATER) === 0 && isWaterOnlyUnitBlueprintId(id)) return false;
    if ((mediumKey & MEDIUM_KEY_LAND) === 0 && isLandOnlyUnitBlueprintId(id)) return false;
    return true;
  });
}

/** The structures a map with these mediums can host. */
export function buildingBlueprintIdsForMediumKey<T extends string>(
  buildingBlueprintIds: readonly T[],
  mediumKey: number,
): readonly T[] {
  if (mediumKey === MEDIUM_KEY_BOTH) return buildingBlueprintIds;
  return buildingBlueprintIds.filter((id) => {
    if ((mediumKey & MEDIUM_KEY_WATER) === 0 && isWaterOnlyBuildingBlueprintId(id)) return false;
    if ((mediumKey & MEDIUM_KEY_LAND) === 0 && isLandOnlyBuildingBlueprintId(id)) return false;
    return true;
  });
}

/** The units a map with THIS setup could field. The lobby edits a map nothing
 *  has generated yet, so it supplies the setup instead of reading the installed
 *  one; the narrowing itself is the same. */
export function unitBlueprintIdsForMapSetup<T extends string>(
  unitBlueprintIds: readonly T[],
  setup: MapSurfaceSetup,
): readonly T[] {
  return unitBlueprintIdsForMediumKey(unitBlueprintIds, mapMediumKeyForSetup(setup));
}

/** The structures a map with THIS setup could host. See above. */
export function buildingBlueprintIdsForMapSetup<T extends string>(
  buildingBlueprintIds: readonly T[],
  setup: MapSurfaceSetup,
): readonly T[] {
  return buildingBlueprintIdsForMediumKey(buildingBlueprintIds, mapMediumKeyForSetup(setup));
}
