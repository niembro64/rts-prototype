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
import type { ActionType, UnitAction } from './types';

type Vec2 = { x: number; y: number };

export type PathTerrainFilter = {
  minSurfaceNormalZ?: number;
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

function ensureInitialized(mapWidth: number, mapHeight: number): void {
  if (mapWidth === _initMapWidth && mapHeight === _initMapHeight) return;
  const sim = getSimWasm()!;
  sim.pathfinder.init(mapWidth, mapHeight);
  _initMapWidth = mapWidth;
  _initMapHeight = mapHeight;
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

function normalizeMinSurfaceNormalZ(filter?: PathTerrainFilter): number {
  const value = filter?.minSurfaceNormalZ;
  if (value === undefined || !Number.isFinite(value) || value <= SLOPE_BLOCK_NZ) return 0;
  return Math.min(1, value);
}

function ensureMaskAndCC(
  buildingGrid: BuildingGrid,
  mapWidth: number, mapHeight: number,
): void {
  ensureInitialized(mapWidth, mapHeight);
  const sim = getSimWasm()!;
  const tVer = getTerrainVersion();
  const bVer = buildingGrid.getVersion();
  const occ = collectBuildingCells(buildingGrid);
  // Rust caches mask + CC by (tVer, bVer) pair; this is a no-op when
  // nothing has changed.
  sim.pathfinder.rebuildMaskAndCc(occ, tVer, bVer);
}

// ── Public entry: findPath ───────────────────────────────────────

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter?: PathTerrainFilter,
): Vec2[] {
  ensureMaskAndCC(buildingGrid, mapWidth, mapHeight);
  const minSurfaceNormalZ = normalizeMinSurfaceNormalZ(terrainFilter);
  const sim = getSimWasm()!;
  const count = sim.pathfinder.findPath(startX, startY, goalX, goalY, minSurfaceNormalZ);
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
 *  threshold are treated as blocked for that path query. */
export function expandPathActions(
  startX: number, startY: number,
  goalX: number, goalY: number,
  type: ActionType,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ?: number,
  terrainFilter?: PathTerrainFilter,
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
  if (VALIDATE_PATHS) {
    validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
  }
  const out: UnitAction[] = [];
  const lastIdx = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const px = path[i].x;
    const py = path[i].y;
    const isFinal = i === lastIdx;
    const isFinalUnsnapped = isFinal && goalZ !== undefined && px === goalX && py === goalY;
    const z = isFinalUnsnapped
      ? goalZ
      : getSurfaceHeight(px, py, mapWidth, mapHeight, LAND_CELL_SIZE);
    const action: UnitAction = { type, x: px, y: py, z };
    if (!isFinal) action.isPathExpansion = true;
    out.push(action);
  }
  return out;
}
