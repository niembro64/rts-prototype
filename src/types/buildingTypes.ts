// Building identifiers and render/anchor classification.

import {
  type StructureBlueprintId,
} from './blueprintIds';

export type {
  StructureBlueprintId,
};

// Runtime/network fields retain the historical `buildingBlueprintId` name.
export type BuildingBlueprintId = StructureBlueprintId;
export type BuildingRenderProfile = StructureBlueprintId | 'unknown' | 'bodyless';
export type BuildingAnchorProfile = 'constantVisualTop' | 'fabricator' | 'collisionDepth';
export const BUILDING_PLACEMENT_SETS = [
  'ground-build-squares-hover',
  'ground-build-squares-surface',
  'water-build-squares-sea-bed',
  'water-build-squares-sea-on-surface',
  'water-build-squares-hover-surface',
] as const;
export type BuildingPlacementSet = typeof BUILDING_PLACEMENT_SETS[number];
type BuildSquareType = 'ground' | 'water';
export type BuildingPlacementAnchor = 'terrain-bed' | 'sea-on-surface' | 'hover-surface';

export function isBuildingPlacementSet(value: unknown): value is BuildingPlacementSet {
  return typeof value === 'string' &&
    (BUILDING_PLACEMENT_SETS as readonly string[]).includes(value);
}

export function getBuildingPlacementSetSquareType(
  placementSet: BuildingPlacementSet,
): BuildSquareType {
  return placementSet.startsWith('ground-') ? 'ground' : 'water';
}

export function getBuildingPlacementSetAnchor(
  placementSet: BuildingPlacementSet,
): BuildingPlacementAnchor {
  switch (placementSet) {
    case 'ground-build-squares-surface':
    case 'water-build-squares-sea-bed':
      return 'terrain-bed';
    case 'water-build-squares-sea-on-surface':
      return 'sea-on-surface';
    case 'ground-build-squares-hover':
    case 'water-build-squares-hover-surface':
      return 'hover-surface';
  }
}

export function getBuildingPlacementAnchor(
  placementSets: readonly BuildingPlacementSet[],
): BuildingPlacementAnchor {
  const first = placementSets[0];
  if (first === undefined) throw new Error('Building placementSets must not be empty');
  return getBuildingPlacementSetAnchor(first);
}
export type BuildingHoveringType = 'fabricator' | 'directionalFabricator' | null;
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

export function isMetalExtractorBlueprintId(
  t: string | null | undefined,
): t is Extract<StructureBlueprintId, 'buildingExtractor' | 'buildingExtractorT2'> {
  return t === 'buildingExtractor' || t === 'buildingExtractorT2';
}
