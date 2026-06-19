import { LAND_CELL_SIZE } from '../../../config';
import { BUILD_CONFIG } from '../../../buildConfig';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { BUILD_GRID_CELL_SIZE } from '../buildGrid';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { getSimWasm } from '../../sim-wasm/init';
import { TERRAIN_D_TERRAIN, TERRAIN_PLATEAU_CONFIG, WATER_LEVEL } from './terrainConfig';
import { findDepositFlatZoneAt, getMetalDepositFlatZones } from './terrainFlatZones';
import { getTerrainMeshHeight, getTerrainMeshNormal } from './terrainTileMap';
import { getTerrainVersion } from './terrainState';

const TERRAIN_FLAT_ZONE_WASM_STRIDE = 4;
const TERRAIN_FLAT_ZONE_LEVEL_OFFSET = 1_000_000;
const TERRAIN_FLAT_ZONE_LEVEL_SCALE = 1_000;

export function getTerrainBuildabilityConfigKey(): string {
  // TERRAIN_D_TERRAIN doubles as the on/off signal — `0` is the
  // D-PLATEAU "NONE" option and short-circuits terracing.
  return [
    TERRAIN_D_TERRAIN,
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


export type FootprintBuildability = {
  /** True iff every sampled corner/edge/center is dry land, under the
   *  max buildable slope angle, and on the same plateau level. */
  buildable: boolean;
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
  if (height < WATER_LEVEL) {
    return {
      water: true,
      normalUp: 1,
      plateauLevel: null,
    };
  }
  const normal = getTerrainMeshNormal(x, z, mapWidth, mapHeight, cellSize);
  return {
    water: false,
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
  for (const [sx, sz] of samples) {
    const sample = sampleTerrain(sx, sz, mapWidth, mapHeight, cellSize);
    if (sample.water) {
      return { buildable: false, level: null };
    }
    if (sample.normalUp < BUILD_CONFIG.minBuildableSurfaceNormalUp) {
      return { buildable: false, level: null };
    }
    const level = sample.plateauLevel;
    if (level === null) return { buildable: false, level: null };
    if (footprintLevel === null) {
      footprintLevel = level;
    } else if (level !== footprintLevel) {
      return { buildable: false, level: null };
    }
  }
  return { buildable: true, level: footprintLevel };
}

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
  return evaluateBuildabilityFootprintWithSampler(
    centerX,
    centerZ,
    halfWidth,
    halfDepth,
    mapWidth,
    mapHeight,
    cellSize,
    sampleBuildabilityTerrain,
  );
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
  const sampleCache = new Map<string, BuildabilityTerrainSample>();
  const sampleTerrain: BuildabilityTerrainSampler = (
    x,
    z,
    terrainMapWidth,
    terrainMapHeight,
    terrainCellSize,
  ) => {
    const key = `${x}:${z}`;
    const cached = sampleCache.get(key);
    if (cached !== undefined) return cached;
    const sample = sampleBuildabilityTerrain(
      x,
      z,
      terrainMapWidth,
      terrainMapHeight,
      terrainCellSize,
    );
    sampleCache.set(key, sample);
    return sample;
  };

  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const x = gx * cellSize + cellSize / 2;
      const y = gy * cellSize + cellSize / 2;
      const evaluated = evaluateBuildabilityFootprintWithSampler(
        x,
        y,
        cellSize / 2,
        cellSize / 2,
        mapWidth,
        mapHeight,
        LAND_CELL_SIZE,
        sampleTerrain,
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
    BUILD_CONFIG.minBuildableSurfaceNormalUp,
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
    rows[base + 2] = zone.radius;
    rows[base + 3] = zone.height;
  }
  return rows;
}
