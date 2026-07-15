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
//   - preserves the path expansion surface while traversal policy and grid
//     cache ownership live in focused helpers.
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

import type { BuildingGrid } from './buildGrid';
import { LAND_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getSurfaceHeight,
} from './Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { ActionType, UnitPathPoint } from './types';
import { ensurePathfinderGrid } from './pathfinderGridCache';
import {
  resolvePathfinderTraversalInput,
  type PathTerrainFilter,
} from './pathfindingTraversal';

type Vec2 = { x: number; y: number };

export type PathResolution = 'complete' | 'snapped' | 'partial' | 'unreachable';

export type ExpandedPathPlan = {
  points: UnitPathPoint[];
  resolution: PathResolution;
};

/** When true, every path produced by `expandPathActions` is walked
 *  segment-by-segment and any world-space sample that lands over
 *  water is logged. */
const VALIDATE_PATHS = GAME_DIAGNOSTICS.pathValidation;

/** Spacing (world units) between water-check samples along each
 *  segment during path validation. */
const VALIDATE_SAMPLE_STEP_WU = 5;

// ── Public entry: findPath ───────────────────────────────────────

function decodePathResolution(code: number): PathResolution {
  switch (code) {
    case 1: return 'complete';
    case 2: return 'snapped';
    case 3: return 'partial';
    default: return 'unreachable';
  }
}

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): { points: Vec2[]; resolution: PathResolution } {
  ensurePathfinderGrid(buildingGrid, mapWidth, mapHeight);
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  const sim = getSimWasm()!;
  const count = sim.pathfinder.findPath(
    startX,
    startY,
    goalX,
    goalY,
    traversal.minSurfaceNormalZ,
    traversal.allowOnGround,
    traversal.allowInWater,
    traversal.allowInAir,
    unitRadius,
    traversal.flatDriveAccel,
    symmetricSlope,
  );
  const resolution = decodePathResolution(sim.pathfinder.lastResultStatus());
  if (count === 0) {
    return { points: [{ x: startX, y: startY }], resolution: 'unreachable' };
  }
  const view = new Float64Array(sim.memory.buffer, sim.pathfinder.waypointsPtr(), count * 2);
  const result: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = { x: view[i * 2], y: view[i * 2 + 1] };
  }
  return { points: result, resolution };
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
 *  `terrainFilter` carries explicit navigation-domain flags. Air can bypass
 *  terrain blockers; wet cells require water navigation even if the body
 *  could physically touch the bed; dry cells require ground navigation and
 *  use the unit's dry-ground climb profile. */
export function expandPathPlan(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ: number | null,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): ExpandedPathPlan {
  const result = findPath(
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
  const path = result.points;
  if (VALIDATE_PATHS) {
    const traversal = resolvePathfinderTraversalInput(terrainFilter);
    if (!traversal.allowInWater && !traversal.allowInAir) {
      validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
    }
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
  return { points: out, resolution: result.resolution };
}

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
  return expandPathPlan(
    startX,
    startY,
    goalX,
    goalY,
    mapWidth,
    mapHeight,
    buildingGrid,
    goalZ,
    terrainFilter,
    unitRadius,
    symmetricSlope,
  ).points;
}

let _pathValidationScratch = new Float64Array(64);

function validatePathScratch(
  length: number,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  const sim = getSimWasm()!;
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  return sim.pathfinder.validatePath(
    _pathValidationScratch.subarray(0, length),
    traversal.minSurfaceNormalZ,
    traversal.allowOnGround,
    traversal.allowInWater,
    traversal.allowInAir,
    unitRadius,
    symmetricSlope,
  ) === 1;
}

export function isPathSegmentTraversable(
  startX: number,
  startY: number,
  point: UnitPathPoint,
  mapWidth: number,
  mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  ensurePathfinderGrid(buildingGrid, mapWidth, mapHeight);
  _pathValidationScratch[0] = startX;
  _pathValidationScratch[1] = startY;
  _pathValidationScratch[2] = point.x;
  _pathValidationScratch[3] = point.y;
  return validatePathScratch(4, terrainFilter, unitRadius, symmetricSlope);
}

/** Validate a translated/shared polyline through the authoritative WASM
 * traversal kernel. The current position is the first point so the initial
 * segment is checked too. */
export function isPathPlanTraversable(
  startX: number,
  startY: number,
  points: readonly UnitPathPoint[],
  mapWidth: number,
  mapHeight: number,
  buildingGrid: BuildingGrid,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  if (points.length === 0) return false;
  ensurePathfinderGrid(buildingGrid, mapWidth, mapHeight);
  const requiredLength = (points.length + 1) * 2;
  if (_pathValidationScratch.length < requiredLength) {
    let capacity = _pathValidationScratch.length;
    while (capacity < requiredLength) capacity *= 2;
    _pathValidationScratch = new Float64Array(capacity);
  }
  _pathValidationScratch[0] = startX;
  _pathValidationScratch[1] = startY;
  for (let i = 0; i < points.length; i++) {
    _pathValidationScratch[(i + 1) * 2] = points[i].x;
    _pathValidationScratch[(i + 1) * 2 + 1] = points[i].y;
  }
  return validatePathScratch(requiredLength, terrainFilter, unitRadius, symmetricSlope);
}

export type MultiLegWaypoint = {
  x: number;
  y: number;
  z: number | null;
  type: ActionType;
};
