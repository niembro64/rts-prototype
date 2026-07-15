import { getSimWasm } from '../sim-wasm/init';
import { BUILD_GRID_CELL_SIZE, type BuildingGrid } from './buildGrid';
import { getTerrainVersion } from './Terrain';

let initializedMapWidth = 0;
let initializedMapHeight = 0;
let initializedSim: ReturnType<typeof getSimWasm> | null = null;
let cachedMapWidth = 0;
let cachedMapHeight = 0;
let cachedTerrainVersion = -1;
let cachedBuildingVersion = -1;
let cachedBuildingGrid: BuildingGrid | null = null;
const buildingGridIds = new WeakMap<BuildingGrid, number>();
let nextBuildingGridId = 1;
let buildingCellsScratch = new Float64Array(384);

function invalidateMaskCache(): void {
  cachedMapWidth = 0;
  cachedMapHeight = 0;
  cachedTerrainVersion = -1;
  cachedBuildingVersion = -1;
  cachedBuildingGrid = null;
}

function getBuildingGridId(buildingGrid: BuildingGrid): number {
  let id = buildingGridIds.get(buildingGrid);
  if (id !== undefined) return id;

  id = nextBuildingGridId++;
  if (nextBuildingGridId > 0xffff_ffff) nextBuildingGridId = 1;
  buildingGridIds.set(buildingGrid, id);
  return id;
}

function ensureInitialized(mapWidth: number, mapHeight: number): void {
  const sim = getSimWasm()!;
  if (sim !== initializedSim) {
    initializedSim = sim;
    initializedMapWidth = 0;
    initializedMapHeight = 0;
    invalidateMaskCache();
  }
  if (mapWidth === initializedMapWidth && mapHeight === initializedMapHeight) return;

  sim.pathfinder.init(mapWidth, mapHeight);
  initializedMapWidth = mapWidth;
  initializedMapHeight = mapHeight;
  invalidateMaskCache();
}

function collectBuildingCells(buildingGrid: BuildingGrid): Float64Array {
  let count = 0;
  for (const { gx, gy, cell } of buildingGrid.occupiedCells()) {
    if (count + 3 > buildingCellsScratch.length) {
      const next = new Float64Array(buildingCellsScratch.length * 2);
      next.set(buildingCellsScratch);
      buildingCellsScratch = next;
    }
    buildingCellsScratch[count++] = gx;
    buildingCellsScratch[count++] = gy;
    buildingCellsScratch[count++] =
      Number.isFinite(cell.pathTopZ) && cell.pathTopZ !== undefined
        ? cell.pathTopZ
        : BUILD_GRID_CELL_SIZE;
  }
  return buildingCellsScratch.subarray(0, count);
}

/** Ensure the WASM pathfinder grid and its terrain/building mask match the
 * current authoritative inputs. Both JS and Rust caches short-circuit hits. */
export function ensurePathfinderGrid(
  buildingGrid: BuildingGrid,
  mapWidth: number,
  mapHeight: number,
): void {
  ensureInitialized(mapWidth, mapHeight);
  const terrainVersion = getTerrainVersion();
  const buildingVersion = buildingGrid.getVersion();
  if (
    mapWidth === cachedMapWidth &&
    mapHeight === cachedMapHeight &&
    terrainVersion === cachedTerrainVersion &&
    buildingVersion === cachedBuildingVersion &&
    buildingGrid === cachedBuildingGrid
  ) {
    return;
  }

  getSimWasm()!.pathfinder.rebuildMaskAndCc(
    collectBuildingCells(buildingGrid),
    terrainVersion,
    buildingVersion,
    getBuildingGridId(buildingGrid),
  );
  cachedMapWidth = mapWidth;
  cachedMapHeight = mapHeight;
  cachedTerrainVersion = terrainVersion;
  cachedBuildingVersion = buildingVersion;
  cachedBuildingGrid = buildingGrid;
}
