// Pathfinder — 2D A* on the building grid.
//
// Phase 9: the heavy lifting (mask + CC rebuild, A* + LOS smoothing)
// runs inside WASM. This file is now a thin wrapper that:
//   - tracks (terrain × buildings) version pairs and packs the
//     buildingGrid.occupiedCells() into a Uint32Array for the WASM
//     rebuild step;
//   - keeps expandPathActions JS-side because it consults JS-side
//     blueprint config and constructs UnitAction objects;
//   - preserves the original public surface (`findPath`,
//     `expandPathActions`, `PathTerrainFilter`).
//
// Design choices we kept from the JS impl:
//   • 8-connected A* with the octile heuristic. Bounded by
//     MAX_A_STAR_NODES so a pathological query can't stall a tick.
//   • Multi-point water sampling per cell (centre + 4 corners) so
//     shoreline cells get classified correctly even when their
//     centre is a hair above water level — moved to Rust; falls
//     back to centre-only sampling when no mesh is installed.
//   • Two-tier C-space inflation: 2 cells around water (so unit
//     bodies clear the shore), 1 cell around buildings (so the
//     demo's tight factory gaps stay passable).
//   • Airborne queries (hover + flying) ignore terrain blocking so
//     water and slope do not force them onto land-only routes; they
//     still stay inside the map and avoid occupied building cells.
//   • Connected-component pre-flight. If start and goal are in
//     different components A* would just thrash; instead we snap
//     the goal to the nearest cell in start's component.
//   • Euclidean-sorted snap offsets — no compass bias.
//   • Stay-put bail: when there's no possible path, return a
//     single waypoint at the unit's current position so the queue
//     gets cleared and the visualization doesn't draw a fake
//     straight line through obstacles.

import type { BuildingGrid } from './buildGrid';
import { LAND_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getSurfaceHeight,
  getTerrainVersion,
} from './Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { ActionType, UnitAction, UnitLocomotion, Waypoint } from './types';

type Vec2 = { x: number; y: number };

export type PathTerrainFilter = {
  minSurfaceNormalZ: number | null;
  ignoreTerrainBlocking: boolean;
};

/** Slope nz floor — anything flatter than this nz is walkable.
 *  0.34 ≈ 70°, matches PhysicsEngine3D.integrate's stable limit. */
const SLOPE_BLOCK_NZ = 0.34;

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

// Reusable Uint32Array for the per-rebuild building-occupied-cells
// payload. Grows on demand; never shrinks (steady-state busy combat
// sees the upper bound).
let _buildingCellsScratch = new Uint32Array(256);

function collectBuildingCells(buildingGrid: BuildingGrid): Uint32Array {
  let count = 0;
  for (const { gx, gy } of buildingGrid.occupiedCells()) {
    if (count + 2 > _buildingCellsScratch.length) {
      const next = new Uint32Array(_buildingCellsScratch.length * 2);
      next.set(_buildingCellsScratch);
      _buildingCellsScratch = next;
    }
    _buildingCellsScratch[count++] = gx;
    _buildingCellsScratch[count++] = gy;
  }
  return _buildingCellsScratch.subarray(0, count);
}

function normalizeMinSurfaceNormalZ(filter: PathTerrainFilter | null): number {
  if (filter === null || filter.ignoreTerrainBlocking) return 0;
  const value = filter.minSurfaceNormalZ;
  if (value === null || !Number.isFinite(value) || value <= SLOPE_BLOCK_NZ) return 0;
  return Math.min(1, value);
}

function shouldIgnoreTerrainBlocking(filter: PathTerrainFilter | null): boolean {
  return filter !== null && filter.ignoreTerrainBlocking;
}

export function pathTerrainFilterForLocomotion(
  locomotion: UnitLocomotion | undefined,
): PathTerrainFilter | null {
  if (locomotion === undefined) return null;
  const pathfinding = locomotion.pathfinding;
  if (pathfinding.ignoreTerrainBlocking) {
    return { minSurfaceNormalZ: null, ignoreTerrainBlocking: true };
  }
  const minSurfaceNormalZ = pathfinding.minSurfaceNormalZ;
  return minSurfaceNormalZ !== undefined
    ? { minSurfaceNormalZ, ignoreTerrainBlocking: false }
    : null;
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
): Vec2[] {
  ensureMaskAndCC(buildingGrid, mapWidth, mapHeight);
  const minSurfaceNormalZ = normalizeMinSurfaceNormalZ(terrainFilter);
  const ignoreTerrainBlocking = shouldIgnoreTerrainBlocking(terrainFilter);
  const sim = getSimWasm()!;
  const count = sim.pathfinder.findPath(
    startX,
    startY,
    goalX,
    goalY,
    minSurfaceNormalZ,
    ignoreTerrainBlocking,
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
    const length = Math.sqrt(dx * dx + dy * dy);
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

// ── Public entry: expandPathActions ──────────────────────────────

/** Plan a path from (startX, startY) to (goalX, goalY) and return one
 *  UnitAction per smoothed waypoint, all with the given `type`.
 *  Intermediate waypoints (cells the smoother kept along the route)
 *  are flagged `isPathExpansion = true` so renderers can tell them
 *  apart from the user's clicked endpoint.
 *
 *  `goalZ` is the click-derived altitude (from CursorGround.pickSim).
 *  When provided AND the planner did NOT have to snap the goal, the
 *  click's altitude is used verbatim on the final waypoint —
 *  preserving "the cursor was there, the dot is there" precision.
 *  Otherwise z falls back to a terrain sample at the waypoint's xy.
 *
 *  `terrainFilter.minSurfaceNormalZ` adds a per-unit locomotion slope
 *  gate on top of the global terrain mask. Higher values mean flatter
 *  required terrain; cells whose surface normal z falls below the
 *  threshold are treated as blocked for that path query.
 *
 *  `terrainFilter.ignoreTerrainBlocking` is for airborne locomotion:
 *  water, terrain inflation, and slope are ignored, while map bounds
 *  and building-occupied cells remain blockers. */
export type MultiLegWaypoint = {
  x: number;
  y: number;
  z: number | null;
  type: ActionType;
};

type MultiLegWaypointInput = MultiLegWaypoint | Waypoint;

/** Plan a sequence of legs from a start position through `waypoints`,
 *  expanding each leg with `expandPathActions` and concatenating the
 *  resulting per-cell actions. Returns the combined action list and
 *  the index of the first action that belongs to a 'patrol' waypoint
 *  (or null if no patrol waypoint was supplied), suitable for setting
 *  `unit.patrolStartIndex` so the rotation loop in
 *  Simulation.completeAction cycles through every action from that
 *  point onward. */
export function expandMultiLegPathActions(
  startX: number, startY: number,
  waypoints: readonly MultiLegWaypointInput[],
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter: PathTerrainFilter | null,
): { actions: UnitAction[]; patrolStartIndex: number | null } {
  const actions: UnitAction[] = [];
  let anchorX = startX;
  let anchorY = startY;
  let patrolStartIndex: number | null = null;
  for (let w = 0; w < waypoints.length; w++) {
    const wp = waypoints[w];
    if (wp.type === 'patrol' && patrolStartIndex === null) {
      patrolStartIndex = actions.length;
    }
    const leg = expandPathActions(
      anchorX, anchorY, wp.x, wp.y, wp.type,
      mapWidth, mapHeight, buildingGrid,
      wp.z ?? null, terrainFilter,
    );
    for (let i = 0; i < leg.length; i++) actions.push(leg[i]);
    anchorX = wp.x;
    anchorY = wp.y;
  }
  return { actions, patrolStartIndex };
}

export function expandPathActions(
  startX: number, startY: number,
  goalX: number, goalY: number,
  type: ActionType,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ: number | null,
  terrainFilter: PathTerrainFilter | null,
): UnitAction[] {
  const path = findPath(
    startX,
    startY,
    goalX,
    goalY,
    mapWidth,
    mapHeight,
    buildingGrid,
    terrainFilter,
  );
  if (VALIDATE_PATHS && !shouldIgnoreTerrainBlocking(terrainFilter)) {
    validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
  }
  const out: UnitAction[] = [];
  const lastIdx = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const px = path[i].x;
    const py = path[i].y;
    const isFinal = i === lastIdx;
    const isFinalUnsnapped = isFinal && goalZ !== null && px === goalX && py === goalY;
    const z = isFinalUnsnapped
      ? goalZ
      : getSurfaceHeight(px, py, mapWidth, mapHeight, LAND_CELL_SIZE);
    const action: UnitAction = { type, x: px, y: py, z };
    if (!isFinal) action.isPathExpansion = true;
    out.push(action);
  }
  return out;
}
