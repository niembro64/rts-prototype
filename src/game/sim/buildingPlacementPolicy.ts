import type { BuildingBlueprintId } from './types';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import type { SensorMedium } from './sensorConfig';

/** Fabricators are suspended unit builders; terrain shape never rejects them. */
export function buildingIgnoresTerrainForPlacement(
  buildingBlueprintId: BuildingBlueprintId,
): boolean {
  return buildingBlueprintId === 'towerFabricator';
}

/** Dedicated contact sensors must be placed in the source medium authored by
 * their sensor matrix; otherwise the building would be completed but inert. */
export function getBuildingRequiredSensorSourceMedium(
  buildingBlueprintId: BuildingBlueprintId,
): SensorMedium | null {
  if (buildingBlueprintId === 'buildingRadar') return 'aboveWater';
  if (buildingBlueprintId === 'buildingSonar') return 'underwater';
  return null;
}

/** Normal buildings sit on the solid terrain bed, including underwater.
 *  Hovering buildings instead use the visible terrain/water surface and apply
 *  their authored hover clearance from there. */
export function getBuildingPlacementBaseZ(
  hovering: boolean,
  x: number,
  y: number,
  getSurfaceZ: (x: number, y: number) => number,
  getTerrainBedZ: (x: number, y: number) => number,
): number {
  return hovering ? getSurfaceZ(x, y) : getTerrainBedZ(x, y);
}

/**
 * Find the highest terrain sample beneath a build footprint. Sampling every
 * grid vertex plus every cell center keeps the suspended baseline above both
 * sharp cell boundaries and local extrema inside a build square.
 */
export function getHighestBuildFootprintGroundZ(
  gridX: number,
  gridY: number,
  gridWidth: number,
  gridHeight: number,
  getGroundZ: (x: number, y: number) => number,
): number {
  let highest = -Infinity;
  for (let y = 0; y <= gridHeight; y++) {
    for (let x = 0; x <= gridWidth; x++) {
      highest = Math.max(
        highest,
        getGroundZ(
          (gridX + x) * BUILD_GRID_CELL_SIZE,
          (gridY + y) * BUILD_GRID_CELL_SIZE,
        ),
      );
    }
  }
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      highest = Math.max(
        highest,
        getGroundZ(
          (gridX + x + 0.5) * BUILD_GRID_CELL_SIZE,
          (gridY + y + 0.5) * BUILD_GRID_CELL_SIZE,
        ),
      );
    }
  }
  return Number.isFinite(highest) ? highest : 0;
}
