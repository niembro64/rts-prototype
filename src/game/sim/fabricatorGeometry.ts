import type { BuildingBlueprintId } from '../../types/blueprintIds';
import { productionHoldRingOuterRadius } from './productionHoldGeometry';

const FABRICATOR_RING_RADIUS_FRACTION = 0.46;
const FABRICATOR_VISUAL_CLEARANCE_FRACTION = 0.08;
const FABRICATOR_MIN_VISUAL_CLEARANCE = 8;

const DEFAULT_RADIAL_FABRICATOR_BLUEPRINT_ID: BuildingBlueprintId =
  'towerFabricator';

export function radialFabricatorBlueprintIdOrDefault(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): BuildingBlueprintId {
  return buildingBlueprintId ?? DEFAULT_RADIAL_FABRICATOR_BLUEPRINT_ID;
}

/** Radius of the torus ring — the circle the construction pylons hang on. */
export function fabricatorTorusRingRadius(width: number, depth: number): number {
  return Math.max(width, depth) * FABRICATOR_RING_RADIUS_FRACTION;
}

export function fabricatorTorusOuterRadius(width: number, depth: number): number {
  return productionHoldRingOuterRadius(fabricatorTorusRingRadius(width, depth));
}

/** Place a radial fabricator slightly above the tallest visible unit in its
 * production roster. */
export function fabricatorHoverHeightForMaxUnitVisualHeight(maxHeight: number): number {
  return maxHeight + Math.max(
    FABRICATOR_MIN_VISUAL_CLEARANCE,
    maxHeight * FABRICATOR_VISUAL_CLEARANCE_FRACTION,
  );
}
