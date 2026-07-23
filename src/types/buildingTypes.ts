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
export type BuildingHoveringType = 'fabricator' | null;
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
