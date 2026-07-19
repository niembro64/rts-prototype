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
//   • 8-connected A* with the octile heuristic. Bounded by
//     MAX_A_STAR_NODES so a pathological query can't stall a tick.
//   • Multi-point water/slope sampling plus every terrain triangle
//     touching the path cell, so shoreline cells and vertical cliff
//     faces cannot slip between center samples.
//   • Terrain C-space inflation: configurable cells around water still
//     blocks ground-only routes, while water-capable routes can use wet
//     cells and the shoreline buffer. Construction and hovering building
//     footprints reserve placement squares only; they do not alter the
//     terrain locomotion surface.
//   • Air-capable queries ignore terrain blocking so water and slope do
//     not force them onto land-only routes; they still stay inside the map.
//   • Connected-component pre-flight for symmetric blockers only. Every dry
//     route surface must support a physics-derived standstill; directional
//     traversal then adds the force-coupling constraint only to uphill edges.
//   • Euclidean-sorted snap offsets — no compass bias.
//   • Stay-put bail: when there's no possible path, return a
//     single waypoint at the unit's current position so the queue
//     gets cleared and the visualization doesn't draw a fake
//     straight line through obstacles.

import { LAND_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getSurfaceHeight,
} from './Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { ActionType, UnitPathPoint } from './types';
import { ensurePathfinderTerrain } from './pathfinderTerrainCache';
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

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  terrainFilter: PathTerrainFilter | null,
  unitRadius: number,
  symmetricSlope: boolean,
): { points: Vec2[]; resolution: PathResolution } {
  ensurePathfinderTerrain(mapWidth, mapHeight);
  const traversal = resolvePathfinderTraversalInput(terrainFilter);
  const sim = getSimWasm()!;
  const count = sim.pathfinder.findPath(
    startX,
    startY,
    goalX,
    goalY,
    traversal.minStandstillNormalZ,
    traversal.minClimbNormalZ,
    traversal.allowOnGround,
    traversal.allowInWater,
    traversal.allowInAir,
    unitRadius,
    traversal.flatDriveAccel,
    traversal.safeDriveAccel,
    traversal.staticFrictionCoefficient,
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
 *  `terrainFilter.minStandstillNormalZ` requires every traversed ground
 *  surface to support the unit from rest. `minClimbNormalZ` adds the stricter
 *  force-coupling gate to powered uphill edges.
 *
 *  `terrainFilter` carries explicit navigation-domain flags. Air can bypass
 *  terrain blockers; wet cells require water navigation even if the body
 *  could physically touch the bed; dry cells require ground navigation and
 *  use the unit's dry-ground climb profile. */
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
  const path = result.points;
  if (VALIDATE_PATHS) {
    const traversal = resolvePathfinderTraversalInput(terrainFilter);
    if (!traversal.allowInWater && !traversal.allowInAir) {
      validatePathDoesNotCrossWater(startX, startY, goalX, goalY, path, mapWidth, mapHeight);
    } else if (traversal.allowInWater && !traversal.allowOnGround && !traversal.allowInAir) {
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
      : getSurfaceHeight(px, py, mapWidth, mapHeight, LAND_CELL_SIZE);
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
    traversal.minStandstillNormalZ,
    traversal.minClimbNormalZ,
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
  if (points.length === 0) return false;
  ensurePathfinderTerrain(mapWidth, mapHeight);
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
