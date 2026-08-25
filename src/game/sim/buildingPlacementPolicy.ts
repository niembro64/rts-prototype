import type { BuildingBlueprintId } from './types';
import type { BuildingPlacementAnchor } from '../../types/buildingTypes';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import type { BuildingPlacementFootprint } from './types';
import type { SensorMedium } from './sensorConfig';
import { WATER_LEVEL } from './Terrain';

/** Sensor-bearing mounts must be placed in the source medium authored by
 * their sensor matrix; otherwise the building would be completed but inert. */
export function getBuildingRequiredSensorSourceMedium(
  buildingBlueprintId: BuildingBlueprintId,
): { medium: SensorMedium; mountId: string } | null {
  if (
    buildingBlueprintId === 'buildingRadar'
    || buildingBlueprintId === 'buildingRadarJammer'
  ) {
    return { medium: 'aboveWater', mountId: 'sensor' };
  }
  if (
    buildingBlueprintId === 'buildingSonar'
    || buildingBlueprintId === 'buildingSonarJammer'
  ) {
    return { medium: 'underwater', mountId: 'sensor' };
  }
  if (buildingBlueprintId === 'towerTorpedo') {
    return { medium: 'underwater', mountId: 'torpedoPort' };
  }
  return null;
}

/** Resolve the bottom of a building's collision cuboid. */
export function getBuildingPlacementBaseZ(
  placementAnchor: BuildingPlacementAnchor,
  buildingDepth: number,
  x: number,
  y: number,
  getSurfaceZ: (x: number, y: number) => number,
  getTerrainBedZ: (x: number, y: number) => number,
): number {
  switch (placementAnchor) {
    case 'hover-surface':
      return getSurfaceZ(x, y);
    case 'sea-on-surface':
      // Runtime transform.z is base + depth/2, so this centers the collision
      // and combat volume exactly on the water plane.
      return WATER_LEVEL - buildingDepth * 0.5;
    case 'terrain-bed':
      return getTerrainBedZ(x, y);
  }
}

/** Mask-aware variant used by authored building reservations. Shared vertices
 *  may be sampled more than once; placement is cold-path and exact agreement
 *  with the visible/build-grid silhouette matters more than deduplication. */
export function getHighestBuildFootprintCellsGroundZ(
  gridX: number,
  gridY: number,
  footprint: BuildingPlacementFootprint,
  getGroundZ: (x: number, y: number) => number,
): number {
  let highest = -Infinity;
  for (const cell of footprint.cells) {
    const left = (gridX + cell.dx) * BUILD_GRID_CELL_SIZE;
    const top = (gridY + cell.dy) * BUILD_GRID_CELL_SIZE;
    const right = left + BUILD_GRID_CELL_SIZE;
    const bottom = top + BUILD_GRID_CELL_SIZE;
    highest = Math.max(
      highest,
      getGroundZ(left, top),
      getGroundZ(right, top),
      getGroundZ(left, bottom),
      getGroundZ(right, bottom),
      getGroundZ(left + BUILD_GRID_CELL_SIZE * 0.5, top + BUILD_GRID_CELL_SIZE * 0.5),
    );
  }
  return Number.isFinite(highest) ? highest : 0;
}
