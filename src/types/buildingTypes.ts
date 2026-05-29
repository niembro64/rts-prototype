// Building identifiers and render/anchor classification.

import rawTowerBlueprints from '../game/sim/blueprints/towers.json';

export type BuildingType =
  | 'solar'
  | 'wind'
  | 'factory'
  | 'extractor'
  | 'radar'
  | 'megaBeamTower'
  | 'cannonTower'
  | 'resourceConverter';
export type BuildingRenderProfile = BuildingType | 'unknown';
export type BuildingAnchorProfile = 'constantVisualTop' | 'factoryTower' | 'collisionDepth';

// Tower-class buildingTypes. A "tower" is the immobile peer of a unit —
// it mounts turrets and carries a host-level lock-on target. Distinct
// from pure-infrastructure buildings (solar/wind/extractor/radar/
// resourceConverter) which mount no turrets and carry no host target.
// See design_philosophy.html "Towers Are Static Hosts That Lock On And
// Fire" and "Anything that locks onto an entity ID is a tower".
//
// Entities with a tower-class buildingType are spawned with
// entity.type === 'tower', so UI/selection code can dispatch on
// entity.type alone without re-checking the buildingType every time.
const TOWER_BUILDING_TYPES: ReadonlySet<BuildingType> = new Set(
  Object.keys(rawTowerBlueprints) as BuildingType[],
);

export function isTowerBuildingType(t: BuildingType): boolean {
  return TOWER_BUILDING_TYPES.has(t);
}
