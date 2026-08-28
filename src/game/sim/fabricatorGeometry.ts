import type { BuildingBlueprintId } from '../../types/blueprintIds';
import { productionHoldRingOuterRadius } from './productionHoldGeometry';

const FABRICATOR_RING_RADIUS_FRACTION = 0.46;
export const UNIVERSAL_FABRICATOR_TALLEST_UNIT_HEIGHT_MULTIPLIER = 2.2;

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

/** Place a radial fabricator at an exact multiple of the tallest visible
 * unit-top height in its production roster. */
export function fabricatorHoverHeightForMaxUnitVisualHeight(maxHeight: number): number {
  return maxHeight * UNIVERSAL_FABRICATOR_TALLEST_UNIT_HEIGHT_MULTIPLIER;
}
