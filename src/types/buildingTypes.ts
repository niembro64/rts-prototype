// Building identifiers and render/anchor classification.

import rawTowerBlueprints from '../game/sim/blueprints/towers.json';
import { type BuildingBlueprintId } from './blueprintIds';

export type { BuildingBlueprintId };
export type BuildingRenderProfile = BuildingBlueprintId | 'unknown' | 'bodyless';
export type BuildingAnchorProfile = 'constantVisualTop' | 'factoryTower' | 'collisionDepth';
export type BuildingSupportSurface =
  | { kind: 'none' }
  | {
      kind: 'boxTop';
      /** Walkable top height above the building base, in world units. */
      topZ: number;
      /** Support footprint width on the world X axis, in world units. */
      width: number;
      /** Support footprint height on the world Y axis, in world units. */
      height: number;
    };

// Tower-class buildingTypes. A "tower" is the immobile peer of a unit —
// it mounts turrets and carries a host-level lock-on target. Distinct
// from pure-infrastructure buildings (solar/wind/extractor/radar/
// resourceConverter) which mount no turrets and carry no host target.
// See design_philosophy.html "Towers Are Static Hosts That Lock On And
// Fire" and "Anything that locks onto an entity ID is a tower".
//
// Entities with a tower-class buildingBlueprintId are spawned with
// entity.type === 'tower', so UI/selection code can dispatch on
// entity.type alone without re-checking the buildingBlueprintId every time.
const TOWER_BUILDING_TYPES: ReadonlySet<BuildingBlueprintId> = new Set(
  Object.keys(rawTowerBlueprints) as BuildingBlueprintId[],
);

export function isTowerBuildingBlueprintId(t: BuildingBlueprintId): boolean {
  return TOWER_BUILDING_TYPES.has(t);
}
