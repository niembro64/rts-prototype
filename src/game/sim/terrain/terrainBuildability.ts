import { LAND_CELL_SIZE } from '../../../config';
import { BUILD_CONFIG, minBuildableSurfaceNormalUp } from '../../../buildConfig';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { BUILD_GRID_CELL_SIZE } from '../buildGrid';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { getSimWasm } from '../../sim-wasm/init';
import {
  TERRAIN_D_TERRAIN,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_PLATEAU_WALL_SLOPE_DEGREES,
  WATER_LEVEL,
} from './terrainConfig';
import { findDepositFlatZoneAt, getMetalDepositFlatZones } from './terrainFlatZones';
import { getTerrainMeshHeight, getTerrainMeshNormal } from './terrainTileMap';
import { getAuthoritativeTerrainTileMap, getTerrainVersion } from './terrainState';

const TERRAIN_FLAT_ZONE_WASM_STRIDE = 4;
const TERRAIN_FLAT_ZONE_LEVEL_OFFSET = 1_000_000;
const TERRAIN_FLAT_ZONE_LEVEL_SCALE = 1_000;

export function getTerrainBuildabilityConfigKey(): string {
  // TERRAIN_D_TERRAIN doubles as the on/off signal — `0` is the
  // D-PLATEAU "NONE" option and short-circuits terracing.
  return [
    TERRAIN_D_TERRAIN,
    TERRAIN_PLATEAU_WALL_SLOPE_DEGREES,
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance,
    BUILD_CONFIG.maxBuildableSlopeAngleDegrees,
  ].join(':');
}

function getTerrainPlateauLevelForHeight(height: number): number | null {
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return 0;
  const level = Math.round(height / step);
  return Math.abs(height - level * step) <=
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance
    ? level
    : null;
}

function getFlatZoneBuildabilityLevel(height: number): number | null {
  const terrainLevel = getTerrainPlateauLevelForHeight(height);
  if (terrainLevel !== null) return terrainLevel;
  if (!Number.isFinite(height)) return null;
  return TERRAIN_FLAT_ZONE_LEVEL_OFFSET
    + Math.round(height * TERRAIN_FLAT_ZONE_LEVEL_SCALE);
}

type FootprintBuildability = {
  /** True iff every sampled corner/edge/center is under the max buildable
   *  slope angle and on the same plateau level. Applies to dry ground and
   *  underwater sea bed alike. */
  terrainBuildable: boolean;
  /** Exact medium when every sample agrees; null means waterline-split. */
  squareType: 'ground' | 'water' | null;
  /** The shared plateau level (when buildable). null when buildable
   *  is false OR the underlying sample yielded no plateau level. */
  level: number | null;
};

type BuildabilityTerrainSample = {
  water: boolean;
  normalUp: number;
  plateauLevel: number | null;
};

type BuildabilityTerrainSampler = (
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
) => BuildabilityTerrainSample;

type TerrainHeightVertex = { x: number; y: number; height: number };

function clipTerrainHeightPolygon(
  input: readonly TerrainHeightVertex[],
  coordinate: 'x' | 'y',
  limit: number,
  keepGreater: boolean,
): TerrainHeightVertex[] {
  if (input.length === 0) return [];
  const inside = (value: number): boolean => keepGreater ? value >= limit : value <= limit;
  const output: TerrainHeightVertex[] = [];
  let previous = input[input.length - 1];
  let previousValue = previous[coordinate];
  let previousInside = inside(previousValue);
  for (const current of input) {
    const currentValue = current[coordinate];
    const currentInside = inside(currentValue);
    if (currentInside !== previousInside) {
      const denominator = currentValue - previousValue;
      if (Math.abs(denominator) > 1e-12) {
        const t = Math.max(0, Math.min(1, (limit - previousValue) / denominator));
        output.push({
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
          height: previous.height + (current.height - previous.height) * t,
        });
      }
    }
    if (currentInside) output.push(current);
    previous = current;
    previousValue = currentValue;
    previousInside = currentInside;
  }
  return output;
}

function getExactBuildSquareTerrainSafety(
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
): {
  squareType: 'ground' | 'water' | null;
  minNormalUp: number;
  minHeight: number;
  maxHeight: number;
} | null {
  const map = getAuthoritativeTerrainTileMap();
  if (
    map === null ||
    map.mapWidth !== mapWidth ||
    map.mapHeight !== mapHeight ||
    map.cellSize <= 0
  ) return null;
  const minX = Math.max(0, centerX - halfWidth);
  const minY = Math.max(0, centerY - halfDepth);
  const maxX = Math.min(mapWidth, centerX + halfWidth);
  const maxY = Math.min(mapHeight, centerY + halfDepth);
  const minCellX = Math.max(0, Math.min(map.cellsX - 1, Math.floor(minX / map.cellSize)));
  const maxCellX = Math.max(0, Math.min(map.cellsX - 1, Math.floor(maxX / map.cellSize)));
  const minCellY = Math.max(0, Math.min(map.cellsY - 1, Math.floor(minY / map.cellSize)));
  const maxCellY = Math.max(0, Math.min(map.cellsY - 1, Math.floor(maxY / map.cellSize)));
  let hasWater = false;
  let hasGround = false;
  let found = false;
  let minNormalUp = 1;
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (let cy = minCellY; cy <= maxCellY; cy++) {
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      const cellIndex = cy * map.cellsX + cx;
      const start = Math.max(0, map.meshCellTriangleOffsets[cellIndex] ?? 0);
      const end = Math.min(
        map.meshCellTriangleIndices.length,
        Math.max(start, map.meshCellTriangleOffsets[cellIndex + 1] ?? start),
      );
      for (let ref = start; ref < end; ref++) {
        const triangleIndex = map.meshCellTriangleIndices[ref];
        if (triangleIndex === undefined || triangleIndex < 0) continue;
        const triangleOffset = triangleIndex * 3;
        const ia = map.meshTriangleIndices[triangleOffset];
        const ib = map.meshTriangleIndices[triangleOffset + 1];
        const ic = map.meshTriangleIndices[triangleOffset + 2];
        if (ia === undefined || ib === undefined || ic === undefined) continue;
        const ax = map.meshVertexCoords[ia * 2];
        const ay = map.meshVertexCoords[ia * 2 + 1];
        const ah = map.meshVertexHeights[ia];
        const bx = map.meshVertexCoords[ib * 2];
        const by = map.meshVertexCoords[ib * 2 + 1];
        const bh = map.meshVertexHeights[ib];
        const cxWorld = map.meshVertexCoords[ic * 2];
        const cyWorld = map.meshVertexCoords[ic * 2 + 1];
        const ch = map.meshVertexHeights[ic];
        if ([ax, ay, ah, bx, by, bh, cxWorld, cyWorld, ch].some((value) => !Number.isFinite(value))) {
          continue;
        }
        let polygon: TerrainHeightVertex[] = [
          { x: ax, y: ay, height: ah },
          { x: bx, y: by, height: bh },
          { x: cxWorld, y: cyWorld, height: ch },
        ];
        polygon = clipTerrainHeightPolygon(polygon, 'x', minX, true);
        polygon = clipTerrainHeightPolygon(polygon, 'x', maxX, false);
        polygon = clipTerrainHeightPolygon(polygon, 'y', minY, true);
        polygon = clipTerrainHeightPolygon(polygon, 'y', maxY, false);
        if (polygon.length === 0) continue;
        found = true;
        for (const vertex of polygon) {
          minHeight = Math.min(minHeight, vertex.height);
          maxHeight = Math.max(maxHeight, vertex.height);
          hasWater ||= vertex.height < WATER_LEVEL;
          hasGround ||= vertex.height >= WATER_LEVEL;
        }
        const ux = bx - ax;
        const uy = bh - ah;
        const uz = by - ay;
        const vx = cxWorld - ax;
        const vy = ch - ah;
        const vz = cyWorld - ay;
        const nx = uy * vz - uz * vy;
        const up = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const length = Math.sqrt(nx * nx + up * up + nz * nz) || 1;
        minNormalUp = Math.min(minNormalUp, Math.abs(up) / length);
      }
    }
  }
  if (!found) return null;
  return {
    squareType: hasWater === hasGround ? null : hasWater ? 'water' : 'ground',
    minNormalUp,
    minHeight,
    maxHeight,
  };
}

/** Exact bed-height range over an installed piecewise-planar terrain mesh. */
export function getBuildSquareTerrainHeightRange(
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
): { minHeight: number; maxHeight: number } | null {
  const safety = getExactBuildSquareTerrainSafety(
    centerX,
    centerY,
    halfWidth,
    halfDepth,
    mapWidth,
    mapHeight,
  );
  return safety === null
    ? null
    : { minHeight: safety.minHeight, maxHeight: safety.maxHeight };
}

function sampleBuildabilityTerrain(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
): BuildabilityTerrainSample {
  const flatZone = findDepositFlatZoneAt(x, z);
  if (flatZone) {
    return {
      water: flatZone.height < WATER_LEVEL,
      normalUp: 1,
      plateauLevel: getFlatZoneBuildabilityLevel(flatZone.height),
    };
  }
  const height = getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize);
  const normal = getTerrainMeshNormal(x, z, mapWidth, mapHeight, cellSize);
  return {
    water: height < WATER_LEVEL,
    normalUp: normal.nz,
    plateauLevel: getTerrainPlateauLevelForHeight(height),
  };
}

function evaluateBuildabilityFootprintWithSampler(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  sampleTerrain: BuildabilityTerrainSampler,
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
  let footprintWater: boolean | null = null;
  for (const [sx, sz] of samples) {
    const sample = sampleTerrain(sx, sz, mapWidth, mapHeight, cellSize);
    if (footprintWater === null) {
      footprintWater = sample.water;
    } else if (sample.water !== footprintWater) {
      return { terrainBuildable: false, level: null, squareType: null };
    }
    if (sample.normalUp < minBuildableSurfaceNormalUp()) {
      return {
        terrainBuildable: false,
        level: null,
        squareType: sample.water ? 'water' : 'ground',
      };
    }
    const level = sample.plateauLevel;
    if (level === null) {
      return {
        terrainBuildable: false,
        level: null,
        squareType: sample.water ? 'water' : 'ground',
      };
    }
    if (footprintLevel === null) {
      footprintLevel = level;
    } else if (level !== footprintLevel) {
      return {
        terrainBuildable: false,
        level: null,
        squareType: sample.water ? 'water' : 'ground',
      };
    }
  }
  return {
    terrainBuildable: true,
    level: footprintLevel,
    squareType: footprintWater ? 'water' : 'ground',
  };
}

/** Resolve medium, slope, and shared plateau level for one footprint. The
 *  installed triangle mesh supplies exact medium and maximum-slope coverage;
 *  the nine support samples establish a common authored plateau level. */
export function evaluateBuildabilityFootprint(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): FootprintBuildability {
  const sampled = evaluateBuildabilityFootprintWithSampler(
    centerX,
    centerZ,
    halfWidth,
    halfDepth,
    mapWidth,
    mapHeight,
    cellSize,
    sampleBuildabilityTerrain,
  );
  const exact = getExactBuildSquareTerrainSafety(
    centerX,
    centerZ,
    halfWidth,
    halfDepth,
    mapWidth,
    mapHeight,
  );
  if (exact === null) return sampled;
  const terrainBuildable =
    exact.squareType !== null &&
    exact.minNormalUp >= minBuildableSurfaceNormalUp() &&
    sampled.terrainBuildable;
  return {
    terrainBuildable,
    squareType: exact.squareType,
    level: terrainBuildable ? sampled.level : null,
  };
}

export const TERRAIN_BUILDABLE_FLAG = 1 << 0;
export const GROUND_BUILD_SQUARE_FLAG = 1 << 1;
export const WATER_BUILD_SQUARE_FLAG = 1 << 2;
export const FLAT_GROUND_BUILD_SQUARE_FLAGS =
  TERRAIN_BUILDABLE_FLAG | GROUND_BUILD_SQUARE_FLAG;
export const FLAT_WATER_BUILD_SQUARE_FLAGS =
  TERRAIN_BUILDABLE_FLAG | WATER_BUILD_SQUARE_FLAG;

type TerrainBuildabilityCell = {
  terrainBuildable: boolean;
  squareType: 'ground' | 'water' | null;
  level: number | null;
};

export function getTerrainBuildabilityGridCell(
  grid: TerrainBuildabilityGrid,
  gx: number,
  gy: number,
): TerrainBuildabilityCell {
  if (gx < 0 || gy < 0 || gx >= grid.cellsX || gy >= grid.cellsY) {
    return { terrainBuildable: false, squareType: null, level: null };
  }
  const index = gy * grid.cellsX + gx;
  const flags = grid.flags[index] ?? 0;
  const terrainBuildable = (flags & TERRAIN_BUILDABLE_FLAG) !== 0;
  const ground = (flags & GROUND_BUILD_SQUARE_FLAG) !== 0;
  const water = (flags & WATER_BUILD_SQUARE_FLAG) !== 0;
  return {
    terrainBuildable,
    squareType: ground === water ? null : ground ? 'ground' : 'water',
    level: terrainBuildable ? grid.levels[index] : null,
  };
}

export function buildTerrainBuildabilityGrid(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = BUILD_GRID_CELL_SIZE,
): TerrainBuildabilityGrid {
  const cellsX = Math.max(1, Math.ceil(mapWidth / cellSize));
  const cellsY = Math.max(1, Math.ceil(mapHeight / cellSize));
  const wasmGrid = buildTerrainBuildabilityGridFromWasm(
    mapWidth,
    mapHeight,
    cellSize,
    cellsX,
    cellsY,
  );
  if (wasmGrid !== null) return wasmGrid;

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
        LAND_CELL_SIZE,
      );
      const index = gy * cellsX + gx;
      const squareFlag = evaluated.squareType === 'ground'
        ? GROUND_BUILD_SQUARE_FLAG
        : evaluated.squareType === 'water'
          ? WATER_BUILD_SQUARE_FLAG
          : 0;
      flags[index] = squareFlag |
        (evaluated.terrainBuildable ? TERRAIN_BUILDABLE_FLAG : 0);
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

function buildTerrainBuildabilityGridFromWasm(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellsX: number,
  cellsY: number,
): TerrainBuildabilityGrid | null {
  const sim = getSimWasm();
  if (sim === undefined || sim.terrainIsInstalled() === 0) return null;

  const flags = new Uint8Array(cellsX * cellsY);
  const levels = new Int32Array(cellsX * cellsY);
  const ok = sim.terrainBakeBuildabilityGrid(
    mapWidth,
    mapHeight,
    cellSize,
    TERRAIN_D_TERRAIN,
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance,
    minBuildableSurfaceNormalUp(),
    packTerrainFlatZoneRowsForWasm(),
    flags,
    levels,
  );
  if (ok === 0) return null;

  return {
    mapWidth,
    mapHeight,
    cellSize,
    cellsX,
    cellsY,
    version: getTerrainVersion(),
    configKey: getTerrainBuildabilityConfigKey(),
    flags: Array.from(flags),
    levels: Array.from(levels),
  };
}

function packTerrainFlatZoneRowsForWasm(): Float64Array {
  const zones = getMetalDepositFlatZones();
  const rows = new Float64Array(zones.length * TERRAIN_FLAT_ZONE_WASM_STRIDE);
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const base = i * TERRAIN_FLAT_ZONE_WASM_STRIDE;
    rows[base] = zone.x;
    rows[base + 1] = zone.y;
    // Buildability's flat guarantee only holds where the terrain truly
    // equals zone.height: the full pad for classic zones, the plateau
    // for grouped zones (their pad annulus is a smoothed slope and gets
    // classified from the real mesh instead).
    rows[base + 2] = zone.groupId >= 0 ? zone.plateauRadius : zone.radius;
    rows[base + 3] = zone.height;
  }
  return rows;
}
