// What this map can field.
//
// Joins the two halves that are deliberately kept apart: `mapWater` knows
// whether a map has water, `waterOnlyRoster` knows which blueprints exist only
// for water. Neither knows about the other; this is the one place the two facts
// meet, so every roster surface — factory menus, builder build lists, the demo
// layout, the lobby grids — narrows in exactly the same way.
//
// A map WITH water returns the caller's own array untouched, so the common case
// costs one boolean and allocates nothing.

import { mapHasWaterForSetup, type MapWaterSetup } from './mapWater';
import {
  isWaterOnlyBuildingBlueprintId,
  isWaterOnlyUnitBlueprintId,
} from './blueprints/waterOnlyRoster';

/** Strip the units that only exist for water, unconditionally. Callers that
 *  have already decided the map is dry — and want to cache the result rather
 *  than re-filter every tick — use this directly. */
export function unitBlueprintIdsWithoutWaterOnly<T extends string>(
  unitBlueprintIds: readonly T[],
): readonly T[] {
  return unitBlueprintIds.filter((id) => !isWaterOnlyUnitBlueprintId(id));
}

/** Strip the structures that only exist for water, unconditionally. */
export function buildingBlueprintIdsWithoutWaterOnly<T extends string>(
  buildingBlueprintIds: readonly T[],
): readonly T[] {
  return buildingBlueprintIds.filter((id) => !isWaterOnlyBuildingBlueprintId(id));
}

/** The units a map with THIS setup could field. The lobby edits a map nothing
 *  has generated yet, so it supplies the setup instead of reading the installed
 *  one; the narrowing itself is the same. */
export function unitBlueprintIdsForMapSetup<T extends string>(
  unitBlueprintIds: readonly T[],
  setup: MapWaterSetup,
): readonly T[] {
  if (mapHasWaterForSetup(setup)) return unitBlueprintIds;
  return unitBlueprintIdsWithoutWaterOnly(unitBlueprintIds);
}

/** The structures a map with THIS setup could host. See above. */
export function buildingBlueprintIdsForMapSetup<T extends string>(
  buildingBlueprintIds: readonly T[],
  setup: MapWaterSetup,
): readonly T[] {
  if (mapHasWaterForSetup(setup)) return buildingBlueprintIds;
  return buildingBlueprintIdsWithoutWaterOnly(buildingBlueprintIds);
}
