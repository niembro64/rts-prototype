import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { GRID_CELL_SIZE } from '../grid';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { TERRAIN_D_TERRAIN, TERRAIN_PLATEAU_CONFIG } from './terrainConfig';
import { findDepositFlatZoneAt } from './terrainFlatZones';
import { getTerrainMeshHeight } from './terrainTileMap';
import { getTerrainVersion } from './terrainState';
import { isWaterAt } from './terrainSurface';

export function getTerrainBuildabilityConfigKey(): string {
  return [
    TERRAIN_PLATEAU_CONFIG.enabled ? 1 : 0,
    TERRAIN_D_TERRAIN,
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance,
  ].join(':');
}

export function getTerrainPlateauLevelAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number | null {
  assertCanonicalLandCellSize('getTerrainPlateauLevelAt cellSize', cellSize);
  if (!TERRAIN_PLATEAU_CONFIG.enabled) return 0;
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return 0;
  const flatZone = findDepositFlatZoneAt(x, z);
  const height = flatZone
    ? flatZone.height
    : getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize);
  const level = Math.round(height / step);
  return Math.abs(height - level * step) <=
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance
    ? level
    : null;
}

export type FootprintBuildability = {
  /** True iff every sampled corner/edge/center is dry land AND on
   *  the same plateau level. */
  buildable: boolean;
  /** The shared plateau level (when buildable). null when buildable
   *  is false OR the underlying sample yielded no plateau level. */
  level: number | null;
};

/** Walk the 9-sample buildability perimeter (corners + edges + center)
 *  ONCE and return both the buildable boolean and the shared plateau
 *  level. Callers that need only the boolean go through the
 *  `isBuildableTerrainFootprint` wrapper below; callers that also need
 *  the level (e.g. build-placement diagnostics) can read both off the
 *  returned struct without a second mesh-sample walk. */
export function evaluateBuildabilityFootprint(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): FootprintBuildability {
  assertCanonicalLandCellSize('evaluateBuildabilityFootprint cellSize', cellSize);
  const rx = Math.max(0, halfWidth - 1);
  const rz = Math.max(0, halfDepth - 1);
  const samples: [number, number][] = [
    [centerX, centerZ],
    [centerX - rx, centerZ - rz],
    [centerX + rx, centerZ - rz],
    [centerX - rx, centerZ + rz],
    [centerX + rx, centerZ + rz],
    [centerX, centerZ - rz],
    [centerX, centerZ + rz],
    [centerX - rx, centerZ],
    [centerX + rx, centerZ],
  ];

  let footprintLevel: number | null = null;
  for (const [sx, sz] of samples) {
    if (isWaterAt(sx, sz, mapWidth, mapHeight, cellSize)) {
      return { buildable: false, level: null };
    }
    const level = getTerrainPlateauLevelAt(
      sx,
      sz,
      mapWidth,
      mapHeight,
      cellSize,
    );
    if (level === null) return { buildable: false, level: null };
    if (footprintLevel === null) {
      footprintLevel = level;
    } else if (level !== footprintLevel) {
      return { buildable: false, level: null };
    }
  }
  return { buildable: true, level: footprintLevel };
}

export function isBuildableTerrainFootprint(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): boolean {
  return evaluateBuildabilityFootprint(
    centerX, centerZ, halfWidth, halfDepth, mapWidth, mapHeight, cellSize,
  ).buildable;
}

export type TerrainBuildabilityCell = {
  buildable: boolean;
  level: number | null;
};

export function getTerrainBuildabilityGridCell(
  grid: TerrainBuildabilityGrid,
  gx: number,
  gy: number,
): TerrainBuildabilityCell {
  if (gx < 0 || gy < 0 || gx >= grid.cellsX || gy >= grid.cellsY) {
    return { buildable: false, level: null };
  }
  const index = gy * grid.cellsX + gx;
  const buildable = grid.flags[index] === 1;
  return {
    buildable,
    level: buildable ? grid.levels[index] : null,
  };
}

export function buildTerrainBuildabilityGrid(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = GRID_CELL_SIZE,
): TerrainBuildabilityGrid {
  const cellsX = Math.max(1, Math.ceil(mapWidth / cellSize));
  const cellsY = Math.max(1, Math.ceil(mapHeight / cellSize));
  const flags = new Array<number>(cellsX * cellsY);
  const levels = new Array<number>(cellsX * cellsY);

  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const x = gx * cellSize + cellSize / 2;
      const y = gy * cellSize + cellSize / 2;
      const evaluated = evaluateBuildabilityFootprint(
        x,
        y,
        cellSize / 2,
        cellSize / 2,
        mapWidth,
        mapHeight,
      );
      const index = gy * cellsX + gx;
      flags[index] = evaluated.buildable ? 1 : 0;
      levels[index] = evaluated.level ?? 0;
    }
  }

  return {
    mapWidth,
    mapHeight,
    cellSize,
    cellsX,
    cellsY,
    version: getTerrainVersion(),
    configKey: getTerrainBuildabilityConfigKey(),
    flags,
    levels,
  };
}
