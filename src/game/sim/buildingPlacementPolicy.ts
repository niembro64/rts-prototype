import type { BuildingBlueprintId, BuildingPlacementType } from './types';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import type { SensorMedium } from './sensorConfig';
import { WATER_LEVEL } from './Terrain';

/** Suspended and waterline-anchored structures do not require a flat bed. */
export function buildingIgnoresTerrainForPlacement(
  buildingBlueprintId: BuildingBlueprintId,
): boolean {
  return buildingBlueprintId === 'towerFabricator' ||
    buildingBlueprintId === 'buildingSonar';
}

/** Dedicated contact sensors must be placed in the source medium authored by
 * their sensor matrix; otherwise the building would be completed but inert. */
export function getBuildingRequiredSensorSourceMedium(
  buildingBlueprintId: BuildingBlueprintId,
): SensorMedium | null {
  if (buildingBlueprintId === 'buildingRadar') return 'aboveWater';
  if (
    buildingBlueprintId === 'buildingSonar' ||
    buildingBlueprintId === 'towerTorpedo'
  ) return 'underwater';
  return null;
}

/** Resolve the bottom of a building's collision cuboid. */
export function getBuildingPlacementBaseZ(
  placementType: BuildingPlacementType,
  buildingDepth: number,
  x: number,
  y: number,
  getSurfaceZ: (x: number, y: number) => number,
  getTerrainBedZ: (x: number, y: number) => number,
): number {
  switch (placementType) {
    case 'hover':
      return getSurfaceZ(x, y);
    case 'water-surface':
      // Runtime transform.z is base + depth/2, so this centers the collision
      // and combat volume exactly on the water plane.
      return WATER_LEVEL - buildingDepth * 0.5;
    case 'ground':
      return getTerrainBedZ(x, y);
  }
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
