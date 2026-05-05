import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { TERRAIN_D_TERRAIN, TERRAIN_PLATEAU_CONFIG } from './terrainConfig';
import { findDepositFlatZoneAt } from './terrainFlatZones';
import { getTerrainMeshHeight } from './terrainTileMap';
import { isWaterAt } from './terrainSurface';

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
