import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Pathfinder — 2D A* on the terrain locomotion grid.
//
// Phase 9: the heavy lifting (mask + CC rebuild, A* + LOS smoothing)
// runs inside WASM. This file is now a thin wrapper that:
//   - keeps the WASM terrain locomotion grid current; construction-grid
//     reservations are intentionally absent from route planning;
//   - keeps expandPathActions JS-side because it consults JS-side
//     blueprint config and constructs UnitAction objects;
//   - preserves the path expansion surface while traversal policy and grid
//     cache ownership live in focused helpers.
//
// Design choices we kept from the JS impl:
//   • 8-connected A* with the octile heuristic. Authoritative queries retain
//     their frontier and advance by a fixed expansion slice each tick; there
//     is no total-node timeout that can turn a hard route into a guess.
//   • Exact clipped-triangle water/slope classification. A cell can contain
//     exposed terrain, water, or both; mixed cells must pass both cases.
//   • Terrain C-space inflation comes only from the unit's physical radius.
//     There is no extra shoreline band. Construction and hovering building
//     footprints reserve placement squares only; they do not alter terrain.
//   • Air capability removes slope coupling, but does not bypass an explicitly
//     invalid water case for a water-containing cell.
//   • Connected-component pre-flight for symmetric blockers only. Every cell
//     must fit the query's dry/wet force envelope; directional traversal then
//     applies the inter-cell climb coupling only to uphill edges.
//   • Euclidean-sorted snap offsets — no compass bias.
//   • Stay-put bail: when there's no possible path, return a
//     single waypoint at the unit's current position so the queue
//     gets cleared and the visualization doesn't draw a fake
//     straight line through obstacles.

import { LAND_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugLog, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getTerrainBedHeight,
} from './Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { ActionType, UnitPathPoint } from './types';
import { ensurePathfinderTerrain } from './pathfinderTerrainCache';
import {
  resolvePathfinderTraversalInput,
  type PathTerrainFilter,
} from './pathfindingTraversal';

type Vec2 = { x: number; y: number };

type PathResolution = 'complete' | 'snapped' | 'partial' | 'unreachable';
export type PathSearchStrategy = 'none' | 'direct' | 'hierarchical';

type PathQueryResult =
  | { status: 'pending'; expansionsUsed: number }
  | {
      status: 'complete';
      points: Vec2[];
      resolution: PathResolution;
      strategy: PathSearchStrategy;
      expansionsUsed: number;
    };

export type ExpandedPathPlan = {
  points: UnitPathPoint[];
  resolution: PathResolution;
};

type PathPlanSliceResult =
  | { status: 'pending'; expansionsUsed: number }
  | {
      status: 'complete';
      plan: ExpandedPathPlan;
      strategy: PathSearchStrategy;
      expansionsUsed: number;
    };

/** When true, every path produced by `expandPathActions` is walked
 *  segment-by-segment and any world-space sample outside its exclusive
 *  ground or water domain is logged. */
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

function decodePathSearchStrategy(code: number): PathSearchStrategy {
  switch (code) {
    case 1: return 'direct';
    case 2: return 'hierarchical';
    default: return 'none';
  }
}

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
  expansionBudget: number | null = null,
  continuationOwner: number = 0,
): PathQueryResult {
  ensurePathfinderTerrain(mapWidth, mapHeight);
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  const sim = getSimWasm()!;
  const count = expansionBudget === null
    ? sim.pathfinder.findPath(
        startX,
        startY,
        goalX,
        goalY,
        traversal.minGroundNormalZ,
        traversal.waterSurfaceSupported,
        traversal.supportPointOffsetZ,
        traversal.waypoint.allowOnGround,
        traversal.waypoint.allowInWater,
        traversal.waypoint.allowInAir,
        traversal.move.allowOnGround,
        traversal.move.allowInWater,
        traversal.move.allowInAir,
        unitRadius,
        traversal.flatDriveAccel,
        traversal.safeDriveAccel,
        traversal.flatWaterContactAccel,
        traversal.safeWaterDriveAccel,
        traversal.staticFrictionCoefficient,
        symmetricSlope,
      )
    : sim.pathfinder.findPathSlice(
        startX,
        startY,
        goalX,
        goalY,
        traversal.minGroundNormalZ,
        traversal.waterSurfaceSupported,
        traversal.supportPointOffsetZ,
        traversal.waypoint.allowOnGround,
        traversal.waypoint.allowInWater,
        traversal.waypoint.allowInAir,
        traversal.move.allowOnGround,
        traversal.move.allowInWater,
        traversal.move.allowInAir,
        unitRadius,
        traversal.flatDriveAccel,
        traversal.safeDriveAccel,
        traversal.flatWaterContactAccel,
        traversal.safeWaterDriveAccel,
        traversal.staticFrictionCoefficient,
        symmetricSlope,
        continuationOwner,
        expansionBudget,
      );
  const resultStatus = sim.pathfinder.lastResultStatus();
  const expansionsUsed = sim.pathfinder.lastFineExpandedNodesThisSlice();
  const pending = resultStatus === 4;
  const resolution = decodePathResolution(resultStatus);
  const strategy = decodePathSearchStrategy(sim.pathfinder.lastSearchStrategy());
  debugLog(GAME_DIAGNOSTICS.pathfindingSearch, '[pathfinding-search]', {
    strategy,
    resolution: pending ? 'pending' : resolution,
    directCostRatio: sim.pathfinder.lastDirectCostRatio(),
    abstractExpandedNodes: sim.pathfinder.lastCoarseExpandedNodes(),
    hierarchyWork: sim.pathfinder.lastHpaWork(),
    corridorClusters: sim.pathfinder.lastCorridorClusters(),
    fineExpandedNodes: sim.pathfinder.lastFineExpandedNodes(),
    smoothingLineChecks: sim.pathfinder.lastSmoothingLineChecks(),
    waypointCount: count,
    start: { x: startX, y: startY },
    goal: { x: goalX, y: goalY },
  });
  if (pending) return { status: 'pending', expansionsUsed };
  if (count === 0) {
    return {
      status: 'complete',
      points: [{ x: startX, y: startY }],
      resolution: 'unreachable',
      strategy,
      expansionsUsed,
    };
  }
  const view = new Float64Array(sim.memory.buffer, sim.pathfinder.waypointsPtr(), count * 2);
  const result: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = { x: view[i * 2], y: view[i * 2 + 1] };
  }
  return { status: 'complete', points: result, resolution, strategy, expansionsUsed };
}

/** Decay the WASM traffic-heat layer by a quarter. Called on a fixed tick
 *  cadence by the simulation (lockstep constant), never from presentation. */
export function decayPathfindingTrafficHeat(): void {
  getSimWasm()?.pathfinder.decayTrafficHeat();
}

// ── Path validator (developer self-check) ────────────────────────

/** Walk a land-only route and report any water sample. Invalid starts are
 * rejected before pathfinding, so even the first segment must stay dry. */
function validatePathDoesNotCrossWater(
  startX: number, startY: number,
  goalX: number, goalY: number,
  path: ReadonlyArray<Vec2>,
  mapWidth: number, mapHeight: number,
): boolean {
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
          debugWarn(
            VALIDATE_PATHS,
            '[Pathfinder] land route enters water at (%d,%d) on segment %d — segment (%d,%d)→(%d,%d), full path (%d,%d)→(%d,%d) with %d waypoints',
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
      }
    }
    prevX = wp.x;
    prevY = wp.y;
  }
  return false;
}

/** Walk a water-only route and report any dry sample. This mirrors the
 * planner's strict-submersion rule and catches accidental raw beach goals in
 * development before they become a visible beaching regression. */
function validatePathStaysInWater(
  startX: number, startY: number,
  goalX: number, goalY: number,
  path: ReadonlyArray<Vec2>,
  mapWidth: number, mapHeight: number,
): boolean {
  let prevX = startX;
  let prevY = startY;
  for (let segIdx = 0; segIdx < path.length; segIdx++) {
    const wp = path[segIdx];
    const dx = wp.x - prevX;
    const dy = wp.y - prevY;
    const length = DMath.sqrt(dx * dx + dy * dy);
    const samples = length >= 1
      ? Math.max(2, Math.ceil(length / VALIDATE_SAMPLE_STEP_WU))
      : 1;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = prevX + dx * t;
      const y = prevY + dy * t;
      if (!isWaterAt(x, y, mapWidth, mapHeight)) {
        debugWarn(
          VALIDATE_PATHS,
          '[Pathfinder] water-only route leaves water at (%d,%d) on segment %d — segment (%d,%d)→(%d,%d), full path (%d,%d)→(%d,%d) with %d waypoints',
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
 *  Dry contact uses its force/mass/grip normal threshold. Bed-supported wet
 *  cells derive MOVE and WAYPOINT thresholds from that same budget plus the
 *  body's conservative per-cell displaced-water fraction.
 *
 *  `terrainFilter` carries separate waypoint and move domains. The waypoint
 *  domain validates intentional destinations and prevents entry into
 *  recovery-only media; the move domain describes physical traversal from
 *  wherever forces placed the body. Dry cells still use the unit's
 *  dry-ground climb profile. */
export function expandPathPlan(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
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
    terrainFilter,
    unitRadius,
    symmetricSlope,
  );
  if (result.status !== 'complete') {
    throw new Error('Synchronous path query unexpectedly returned a pending frontier');
  }
  return materializeExpandedPathPlan(
    result,
    startX,
    startY,
    goalX,
    goalY,
    mapWidth,
    mapHeight,
    goalZ,
    terrainFilter,
  );
}

/** Advance one team's authoritative resumable path job by a deterministic
 *  node budget. The caller must repeat the exact same inputs until completion
 *  or explicitly abandon the job; the team-owned WASM arena retains the
 *  fine-A* frontier. */
export function advancePathPlanSlice(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  goalZ: number | null,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
  continuationOwner: number,
  expansionBudget: number,
): PathPlanSliceResult {
  const result = findPath(
    startX,
    startY,
    goalX,
    goalY,
    mapWidth,
    mapHeight,
    terrainFilter,
    unitRadius,
    symmetricSlope,
    expansionBudget,
    continuationOwner,
  );
  if (result.status === 'pending') return result;
  return {
    status: 'complete',
    strategy: result.strategy,
    plan: materializeExpandedPathPlan(
      result,
      startX,
      startY,
      goalX,
      goalY,
      mapWidth,
      mapHeight,
      goalZ,
      terrainFilter,
    ),
    expansionsUsed: result.expansionsUsed,
  };
}

export function cancelPathPlanSlice(continuationOwner: number): void {
  getSimWasm()?.pathfinder.cancelPathSlice(continuationOwner);
}

/** Reset every query-derived pathfinder cache (heat, class graphs, retained
 *  frontiers). Called at match start and on simulation reset so lockstep
 *  peers — and a rejoiner replaying from frame 0 — begin from the same cold
 *  state; a warm cache would change WHEN routes complete. */
export function resetPathfinderMatchState(): void {
  getSimWasm()?.pathfinder.resetMatchState();
}

function materializeExpandedPathPlan(
  result: Extract<PathQueryResult, { status: 'complete' }>,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  mapWidth: number,
  mapHeight: number,
  goalZ: number | null,
  terrainFilter: PathTerrainFilter | null,
): ExpandedPathPlan {
  const path = result.points;
  if (VALIDATE_PATHS) {
    const traversal = resolvePathfinderTraversalInput(terrainFilter);
    const startIsWet = isWaterAt(startX, startY, mapWidth, mapHeight);
    const startIsWaypointValid = startIsWet
      ? traversal.waypoint.allowInWater || traversal.waypoint.allowInAir
      : traversal.waypoint.allowOnGround || traversal.waypoint.allowInAir;
    if (
      startIsWaypointValid &&
      !traversal.waypoint.allowInWater &&
      !traversal.waypoint.allowInAir
    ) {
      validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
    } else if (
      startIsWaypointValid &&
      traversal.waypoint.allowInWater &&
      !traversal.waypoint.allowOnGround &&
      !traversal.waypoint.allowInAir
    ) {
      validatePathStaysInWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
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
      : getTerrainBedHeight(px, py, mapWidth, mapHeight, LAND_CELL_SIZE);
    out.push({ x: px, y: py, z });
  }
  return { points: out, resolution: result.resolution };
}

export function expandPathPoints(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
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
    traversal.minGroundNormalZ,
    traversal.waterSurfaceSupported,
    traversal.supportPointOffsetZ,
    traversal.waypoint.allowOnGround,
    traversal.waypoint.allowInWater,
    traversal.waypoint.allowInAir,
    traversal.move.allowOnGround,
    traversal.move.allowInWater,
    traversal.move.allowInAir,
    unitRadius,
    traversal.safeDriveAccel,
    traversal.safeWaterDriveAccel,
    traversal.staticFrictionCoefficient,
    symmetricSlope,
  ) === 1;
}

export function isPathSegmentTraversable(
  startX: number,
  startY: number,
  point: UnitPathPoint,
  mapWidth: number,
  mapHeight: number,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  ensurePathfinderTerrain(mapWidth, mapHeight);
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
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  return isPathPlanSuffixTraversable(
    startX,
    startY,
    points,
    0,
    mapWidth,
    mapHeight,
    terrainFilter,
    unitRadius,
    symmetricSlope,
  );
}

/** Validate the remaining legs of a partially walked plan (points from
 * `fromIndex` on), with the live position as the first vertex. Used when
 * building occupancy changes underneath an installed route. */
export function isPathPlanSuffixTraversable(
  startX: number,
  startY: number,
  points: readonly UnitPathPoint[],
  fromIndex: number,
  mapWidth: number,
  mapHeight: number,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): boolean {
  const remaining = points.length - fromIndex;
  if (remaining <= 0) return false;
  ensurePathfinderTerrain(mapWidth, mapHeight);
  const requiredLength = (remaining + 1) * 2;
  if (_pathValidationScratch.length < requiredLength) {
    let capacity = _pathValidationScratch.length;
    while (capacity < requiredLength) capacity *= 2;
    _pathValidationScratch = new Float64Array(capacity);
  }
  _pathValidationScratch[0] = startX;
  _pathValidationScratch[1] = startY;
  for (let i = 0; i < remaining; i++) {
    const point = points[fromIndex + i];
    _pathValidationScratch[(i + 1) * 2] = point.x;
    _pathValidationScratch[(i + 1) * 2 + 1] = point.y;
  }
  return validatePathScratch(requiredLength, terrainFilter, unitRadius, symmetricSlope);
}

export type MultiLegWaypoint = {
  x: number;
  y: number;
  z: number | null;
  type: ActionType;
};
