import type { BuildingBlueprintId } from '../../types/blueprintIds';
import { productionHoldRingOuterRadius } from './productionHoldGeometry';

const FABRICATOR_RING_RADIUS_FRACTION = 0.46;
const FABRICATOR_HOVER_COLLISION_DIAMETERS = 1.2;

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

/** Clearance for a radial fabricator that produces units up to `maxRadius`. */
export function fabricatorHoverHeightForMaxCollisionRadius(maxRadius: number): number {
  return FABRICATOR_HOVER_COLLISION_DIAMETERS * (2 * maxRadius);
}
