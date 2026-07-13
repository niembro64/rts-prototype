import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Pathfinder — 2D A* on the building grid.
//
// Phase 9: the heavy lifting (mask + CC rebuild, A* + LOS smoothing)
// runs inside WASM. This file is now a thin wrapper that:
//   - tracks (terrain × buildings) version pairs and packs the
//     buildingGrid.occupiedCells() into a Float64Array so WASM can
//     treat exact building/tower footprints as elevated terrain cells;
//   - keeps expandPathActions JS-side because it consults JS-side
//     blueprint config and constructs UnitAction objects;
//   - preserves the original public surface (`findPath`,
//     `expandPathActions`, `PathTerrainFilter`).
//
// Design choices we kept from the JS impl:
//   • 8-connected A* with the octile heuristic. Bounded by
//     MAX_A_STAR_NODES so a pathological query can't stall a tick.
//   • Multi-point water/slope sampling plus every terrain triangle
//     touching the path cell, so shoreline cells and vertical cliff
//     faces cannot slip between center samples.
//   • Terrain C-space inflation: configurable cells around water still
//     blocks ground-only routes, while water-capable routes can use wet
//     cells and the shoreline buffer. Building and tower footprints are
//     elevated flat terrain: uphill entry is rejected by the same directed
//     climb rule as cliffs, while top traversal and downhill falls are legal.
//   • Air-capable queries ignore terrain blocking so water and slope do
//     not force them onto land-only routes; they still stay inside the map.
//   • Connected-component pre-flight for symmetric blockers only. Slope
//     traversal is directional: A* and LOS smoothing reject illegal uphill
//     edges, while downhill moves and cliff falls remain valid.
//   • Euclidean-sorted snap offsets — no compass bias.
//   • Stay-put bail: when there's no possible path, return a
//     single waypoint at the unit's current position so the queue
//     gets cleared and the visualization doesn't draw a fake
//     straight line through obstacles.

import { BUILD_GRID_CELL_SIZE, type BuildingGrid } from './buildGrid';
import { LAND_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getSurfaceHeight,
  getTerrainVersion,
} from './Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { ActionType, UnitLocomotion, UnitPathPoint } from './types';
import { computeLocomotionClimbProfile } from './pathfindingMobility';
import { PATHFINDING_STABILITY_MIN_NORMAL_Z } from './pathfindingTuning';

type Vec2 = { x: number; y: number };

export type PathTerrainFilter = {
  minSurfaceNormalZ: number | null;
  allowGround: boolean;
  allowWater: boolean;
  allowAir: boolean;
  ignoreTerrainBlocking: boolean;
};

/** When true, every path produced by `expandPathActions` is walked
 *  segment-by-segment and any world-space sample that lands over
 *  water is logged. */
const VALIDATE_PATHS = GAME_DIAGNOSTICS.pathValidation;

/** Spacing (world units) between water-check samples along each
 *  segment during path validation. */
const VALIDATE_SAMPLE_STEP_WU = 5;

// ── Init / mask cache ────────────────────────────────────────────

let _initMapWidth = 0;
let _initMapHeight = 0;
let _initSim: ReturnType<typeof getSimWasm> | null = null;
let _maskCacheMapWidth = 0;
let _maskCacheMapHeight = 0;
let _maskCacheTerrainVersion = -1;
let _maskCacheBuildingVersion = -1;
let _maskCacheBuildingGrid: BuildingGrid | null = null;
const _buildingGridIds = new WeakMap<BuildingGrid, number>();
let _nextBuildingGridId = 1;

function invalidateMaskCache(): void {
  _maskCacheMapWidth = 0;
  _maskCacheMapHeight = 0;
  _maskCacheTerrainVersion = -1;
  _maskCacheBuildingVersion = -1;
  _maskCacheBuildingGrid = null;
}

function buildingGridId(buildingGrid: BuildingGrid): number {
  let id = _buildingGridIds.get(buildingGrid);
  if (id === undefined) {
    id = _nextBuildingGridId++;
    if (_nextBuildingGridId > 0xffff_ffff) _nextBuildingGridId = 1;
    _buildingGridIds.set(buildingGrid, id);
  }
  return id;
}

function ensureInitialized(mapWidth: number, mapHeight: number): void {
  const sim = getSimWasm()!;
  if (sim !== _initSim) {
    _initSim = sim;
    _initMapWidth = 0;
    _initMapHeight = 0;
    invalidateMaskCache();
  }
  if (mapWidth === _initMapWidth && mapHeight === _initMapHeight) return;
  sim.pathfinder.init(mapWidth, mapHeight);
  _initMapWidth = mapWidth;
  _initMapHeight = mapHeight;
  invalidateMaskCache();
}

// Reusable Float64Array for the per-rebuild structure-cell payload:
// gx, gy, pathTopZ triples. Grows on demand; never shrinks.
let _buildingCellsScratch = new Float64Array(384);

function collectBuildingCells(buildingGrid: BuildingGrid): Float64Array {
  let count = 0;
  for (const { gx, gy, cell } of buildingGrid.occupiedCells()) {
    if (count + 3 > _buildingCellsScratch.length) {
      const next = new Float64Array(_buildingCellsScratch.length * 2);
      next.set(_buildingCellsScratch);
      _buildingCellsScratch = next;
    }
    _buildingCellsScratch[count++] = gx;
    _buildingCellsScratch[count++] = gy;
    _buildingCellsScratch[count++] = Number.isFinite(cell.pathTopZ) && cell.pathTopZ !== undefined
      ? cell.pathTopZ
      : BUILD_GRID_CELL_SIZE;
  }
  return _buildingCellsScratch.subarray(0, count);
}

function normalizeMinSurfaceNormalZ(filter: PathTerrainFilter | null): number {
  if (filter === null || filter.allowAir) return 0;
  const value = filter.minSurfaceNormalZ;
  if (value === null || !Number.isFinite(value) || value <= PATHFINDING_STABILITY_MIN_NORMAL_Z) {
    return 0;
  }
  return Math.min(1, value);
}

function pathAllowsGround(filter: PathTerrainFilter | null): boolean {
  return filter === null || filter.allowGround;
}

function pathAllowsWater(filter: PathTerrainFilter | null): boolean {
  return filter !== null && filter.allowWater;
}

function pathAllowsAir(filter: PathTerrainFilter | null): boolean {
  return filter !== null && filter.allowAir;
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
  mass: number | undefined,
): PathTerrainFilter | null {
  if (locomotion === undefined) return null;
  if (mass === undefined) return null;
  const mobility = computeLocomotionClimbProfile(locomotion, mass);
  return {
    minSurfaceNormalZ: mobility.minSurfaceNormalZ,
    allowGround: mobility.allowGround,
    allowWater: mobility.allowWater,
    allowAir: mobility.allowAir,
    ignoreTerrainBlocking: mobility.allowAir,
  };
}

function ensureMaskAndCC(
  buildingGrid: BuildingGrid,
  mapWidth: number, mapHeight: number,
): void {
  ensureInitialized(mapWidth, mapHeight);
  const sim = getSimWasm()!;
  const tVer = getTerrainVersion();
  const bVer = buildingGrid.getVersion();
  if (
    mapWidth === _maskCacheMapWidth &&
    mapHeight === _maskCacheMapHeight &&
    tVer === _maskCacheTerrainVersion &&
    bVer === _maskCacheBuildingVersion &&
    buildingGrid === _maskCacheBuildingGrid
  ) {
    return;
  }
  const occ = collectBuildingCells(buildingGrid);
  // Rust caches mask + CC by terrain/building versions plus grid identity;
  // this is a no-op when nothing has changed.
  sim.pathfinder.rebuildMaskAndCc(occ, tVer, bVer, buildingGridId(buildingGrid));
  _maskCacheMapWidth = mapWidth;
  _maskCacheMapHeight = mapHeight;
  _maskCacheTerrainVersion = tVer;
  _maskCacheBuildingVersion = bVer;
  _maskCacheBuildingGrid = buildingGrid;
}

// ── Public entry: findPath ───────────────────────────────────────

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): Vec2[] {
  ensureMaskAndCC(buildingGrid, mapWidth, mapHeight);
  const minSurfaceNormalZ = normalizeMinSurfaceNormalZ(terrainFilter);
  const sim = getSimWasm()!;
  const count = sim.pathfinder.findPath(
    startX,
    startY,
    goalX,
    goalY,
    minSurfaceNormalZ,
    pathAllowsGround(terrainFilter),
    pathAllowsWater(terrainFilter),
    pathAllowsAir(terrainFilter),
    unitRadius,
    symmetricSlope,
  );
  if (count === 0) {
    return [{ x: startX, y: startY }];
  }
  const view = new Float64Array(sim.memory.buffer, sim.pathfinder.waypointsPtr(), count * 2);
  const result: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = { x: view[i * 2], y: view[i * 2 + 1] };
  }
  return result;
}

// ── Path validator (developer self-check) ────────────────────────

/** Walks every segment of `path` (starting from the unit's actual
 *  position) and samples world points at VALIDATE_SAMPLE_STEP_WU
 *  spacing. Logs once if the path RE-ENTERS water after first
 *  reaching dry land — that's a real planner bug.
 *
 *  Important nuance: the unit's CURRENT position can legitimately
 *  be in water (knocked there, pushed by physics, spawned at a
 *  shoreline cell). The pathfinder gets asked to plan a route
 *  out, and the first leg necessarily starts wet. A naive
 *  "any sample is wet → violation" check would flag every move
 *  command issued while a unit is in water, which isn't useful
 *  signal. Instead we look for the wet → dry transition: once
 *  the path has reached dry land (any sample is on land), every
 *  sample after that must stay dry. A wet sample after the
 *  transition means the planned path is geometrically dipping
 *  back into water — that IS a planner bug.
 *
 *  Returns true iff a re-entry violation was found. */
function validatePathDoesNotCrossWater(
  startX: number, startY: number,
  goalX: number, goalY: number,
  path: ReadonlyArray<Vec2>,
  mapWidth: number, mapHeight: number,
): boolean {
  let reachedDryLand = false;
  let prevX = startX;
  let prevY = startY;
  for (let segIdx = 0; segIdx < path.length; segIdx++) {
    const wp = path[segIdx];
    const dx = wp.x - prevX;
    const dy = wp.y - prevY;
    const length = DMath.sqrt(dx * dx + dy * dy);
    if (length >= 1) {
      const samples = Math.max(2, Math.ceil(length / VALIDATE_SAMPLE_STEP_WU));
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const x = prevX + dx * t;
        const y = prevY + dy * t;
        const wet = isWaterAt(x, y, mapWidth, mapHeight);
        if (wet) {
          if (reachedDryLand) {
            debugWarn(
              VALIDATE_PATHS,
              '[Pathfinder] path RE-ENTERS water at (%d,%d) on segment %d — segment (%d,%d)→(%d,%d), full path (%d,%d)→(%d,%d) with %d waypoints',
              Math.round(x), Math.round(y),
              segIdx,
              Math.round(prevX), Math.round(prevY),
              Math.round(wp.x), Math.round(wp.y),
              Math.round(startX), Math.round(startY),
              Math.round(goalX), Math.round(goalY),
              path.length,
            );
            return true;
          }
        } else {
          reachedDryLand = true;
        }
      }
    }
    prevX = wp.x;
    prevY = wp.y;
  }
  return false;
}

// ── Public entry: expandPathPoints / expandPathActions ───────────

/** Plan a path from (startX, startY) to (goalX, goalY) and return one
 *  transient pathfinding point per smoothed waypoint.
 *
 *  `goalZ` is the click-derived altitude (from CursorGround.pickSim).
 *  When provided AND the planner did NOT have to snap the goal, the
 *  click's altitude is used verbatim on the final waypoint —
 *  preserving "the cursor was there, the dot is there" precision.
 *  Otherwise z falls back to a terrain sample at the waypoint's xy.
 *
 *  `terrainFilter.minSurfaceNormalZ` adds a per-unit locomotion climb
 *  gate on directed uphill edges. Higher values mean flatter required
 *  uphill terrain; downhill movement and cliff falls remain valid.
 *
 *  `terrainFilter` carries medium-aware traversal flags. Air can bypass
 *  terrain blockers; wet cells can be traversed by water locomotion or
 *  ground drive on the bed; dry cells require ground capability and use
 *  the unit's dry-ground climb profile. */
export function expandPathPoints(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ: number | null,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): UnitPathPoint[] {
  if (pathAllowsAir(terrainFilter)) {
    const x = Math.max(0, Math.min(mapWidth, goalX));
    const y = Math.max(0, Math.min(mapHeight, goalY));
    return [{
      x,
      y,
      z: goalZ !== null ? goalZ : getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE),
    }];
  }
  const path = findPath(
    startX,
    startY,
    goalX,
    goalY,
    mapWidth,
    mapHeight,
    buildingGrid,
    terrainFilter,
    unitRadius,
    symmetricSlope,
  );
  if (VALIDATE_PATHS && !pathAllowsWater(terrainFilter) && !pathAllowsAir(terrainFilter)) {
    validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
  }
  const out: UnitPathPoint[] = [];
  const lastIdx = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const px = path[i].x;
    const py = path[i].y;
    const isFinal = i === lastIdx;
    const isFinalUnsnapped = isFinal && goalZ !== null && px === goalX && py === goalY;
    const z = isFinalUnsnapped
      ? goalZ
      : getSurfaceHeight(px, py, mapWidth, mapHeight, LAND_CELL_SIZE);
    out.push({ x: px, y: py, z });
  }
  return out;
}

export type MultiLegWaypoint = {
  x: number;
  y: number;
  z: number | null;
  type: ActionType;
};
