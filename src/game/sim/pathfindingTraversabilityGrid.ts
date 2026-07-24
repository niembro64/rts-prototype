import { getSimWasm } from '../sim-wasm/init';
import { getAllUnitBlueprints, getUnitLocomotion } from './blueprints';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { ensurePathfinderTerrain } from './pathfinderTerrainCache';
import {
  computeLocomotionClimbProfile,
  type LocomotionClimbProfile,
} from './pathfindingMobility';
import {
  pathTerrainFilterForLocomotion,
  resolvePathfinderTraversalInput,
} from './pathfindingTraversal';
import { getTerrainVersion } from './Terrain';
import { getAuthoritativeTerrainTileMap } from './terrain/terrainState';

/**
 * Immutable match-start description of one unit's validity on every visible
 * build square. WAYPOINT is intentional destination validity; MOVE is the
 * broader physical traversal/recovery domain.
 */
export type UnitPathTraversabilityGrid = Readonly<{
  unitBlueprintId: string;
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
  terrainVersion: number;
  climb: LocomotionClimbProfile;
  waypoint: Uint8Array;
  move: Uint8Array;
}>;

let cachedSim: ReturnType<typeof getSimWasm> | null = null;
let cachedTerrainVersion = -1;
let cachedMapWidth = 0;
let cachedMapHeight = 0;
let cachedGrids = new Map<string, UnitPathTraversabilityGrid>();

function cacheMatches(mapWidth: number, mapHeight: number): boolean {
  return cachedSim === getSimWasm() &&
    cachedTerrainVersion === getTerrainVersion() &&
    cachedMapWidth === mapWidth &&
    cachedMapHeight === mapHeight &&
    cachedGrids.size === getAllUnitBlueprints().length;
}

/**
 * Bake all unit/build-square domains synchronously while the match is still
 * loading. The WASM pathfinder owns every classification rule; this module
 * only retains the resulting per-unit masks for path overlays and diagnostics.
 */
export function precomputeAllUnitPathTraversabilityGrids(
  mapWidth: number,
  mapHeight: number,
): ReadonlyMap<string, UnitPathTraversabilityGrid> {
  if (cacheMatches(mapWidth, mapHeight)) return cachedGrids;
  const terrain = getAuthoritativeTerrainTileMap();
  if (
    terrain === null ||
    terrain.mapWidth !== mapWidth ||
    terrain.mapHeight !== mapHeight
  ) {
    throw new Error(
      'Path traversability grids require the authoritative match terrain to be installed',
    );
  }
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Path traversability grids require authoritative simulation WASM');
  }

  ensurePathfinderTerrain(mapWidth, mapHeight);
  const cellsX = sim.pathfinder.gridWidth();
  const cellsY = sim.pathfinder.gridHeight();
  const expectedCellsX = Math.max(1, Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE));
  const expectedCellsY = Math.max(1, Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE));
  if (cellsX !== expectedCellsX || cellsY !== expectedCellsY) {
    throw new Error(
      `Pathfinder/build-grid resolution mismatch: ${cellsX}x${cellsY} vs ${expectedCellsX}x${expectedCellsY}`,
    );
  }

  const cellCount = cellsX * cellsY;
  const next = new Map<string, UnitPathTraversabilityGrid>();
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    const climb = computeLocomotionClimbProfile(locomotion, blueprint.mass);
    const filter = pathTerrainFilterForLocomotion(
      locomotion,
      blueprint.mass,
      blueprint.supportPointOffsetZ,
    );
    if (filter === null) {
      throw new Error(`Missing path capability profile for ${blueprint.unitBlueprintId}`);
    }
    const traversal = resolvePathfinderTraversalInput(filter);
    const waypoint = new Uint8Array(cellCount);
    const move = new Uint8Array(cellCount);
    const baked = sim.pathfinder.bakeTraversabilityGrid(
      traversal.minGroundNormalZ,
      traversal.waterSurfaceSupported,
      traversal.supportPointOffsetZ,
      traversal.waypoint.allowOnGround,
      traversal.waypoint.allowInWater,
      traversal.waypoint.allowInAir,
      traversal.move.allowOnGround,
      traversal.move.allowInWater,
      traversal.move.allowInAir,
      blueprint.radius.collision,
      traversal.safeDriveAccel,
      traversal.safeWaterDriveAccel,
      traversal.staticFrictionCoefficient,
      waypoint,
      move,
    );
    if (baked !== 1) {
      throw new Error(`WASM failed to bake path traversability for ${blueprint.unitBlueprintId}`);
    }
    next.set(blueprint.unitBlueprintId, Object.freeze({
      unitBlueprintId: blueprint.unitBlueprintId,
      mapWidth,
      mapHeight,
      cellSize: BUILD_GRID_CELL_SIZE,
      cellsX,
      cellsY,
      terrainVersion: getTerrainVersion(),
      climb,
      waypoint,
      move,
    }));
  }

  cachedSim = sim;
  cachedTerrainVersion = getTerrainVersion();
  cachedMapWidth = mapWidth;
  cachedMapHeight = mapHeight;
  cachedGrids = next;
  return cachedGrids;
}

export function getUnitPathTraversabilityGrid(
  unitBlueprintId: string,
  mapWidth: number,
  mapHeight: number,
): UnitPathTraversabilityGrid | null {
  const terrain = getAuthoritativeTerrainTileMap();
  if (
    terrain === null ||
    terrain.mapWidth !== mapWidth ||
    terrain.mapHeight !== mapHeight
  ) {
    return null;
  }
  const grids = precomputeAllUnitPathTraversabilityGrids(mapWidth, mapHeight);
  return grids.get(unitBlueprintId) ?? null;
}
