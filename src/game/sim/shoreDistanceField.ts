// Shore-distance field — "how far is this point from the other medium".
//
// Initial-base placement, factory rally points, and the opening wave's water
// hulls all need one terrain fact the boolean `isWaterAt` cannot give them:
// not just WHETHER a point is water, but how far the nearest land is. A hull
// launched on the first water cell a ray finds sits on the beach; a factory
// whose footprint corners are all wet can still have a shoreline cutting
// through its middle; a rally point on the far side of a ridge is a beach.
//
// The field is baked by the Rust pathfinder from the same cell classification
// the planner uses (`pathfinder_bake_shore_distance_sq`): squared build-cell
// distances, exact Euclidean, clamped at the planner's clearance reach. It is
// terrain-only — buildings are not obstacles here, because the field answers
// "where is the water", and the build grid already answers occupancy.
//
// Everything here is deterministic integer work over a bake every peer
// derives from the same installed terrain, so it is safe on the lockstep
// spawn path. Callers must treat a `null` field as "no authoritative terrain
// installed" (bare test worlds) and fall back to the boolean medium test.

import { deterministicMath as DMath } from './deterministicMath';
import { getSimWasm } from '../sim-wasm/init';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { getAuthoritativeTerrainTileMap, getTerrainVersion } from './terrain/terrainState';
import { ensurePathfinderTerrain } from './pathfinderTerrainCache';
import type { TerrainTileMap } from '../../types/terrain';

export type ShoreMedium = 'ground' | 'water';

export type ShoreDistanceField = Readonly<{
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
  /** Largest distance the field can express (the EDT clamp), in world units. */
  reachWu: number;
  /** Squared cell distance from a fully submerged cell to the nearest cell
   *  that is not (shoreline, dry ground, or the map-edge buffer); 0 elsewhere. */
  waterSq: Uint16Array;
  /** Squared cell distance from a fully dry cell to the nearest cell touching
   *  water (or the map-edge buffer); 0 elsewhere. */
  landSq: Uint16Array;
}>;

// Shore margins, in world units. Each is the least distance the named thing
// may sit from the other medium; all must stay below the field's reach so a
// satisfied margin is a real measurement, not a clamp.
/** Every build cell of an offshore footprint keeps this much water around it. */
export const SHORE_MARGIN_WATER_FOOTPRINT_WU = 40;
/** Every build cell of a land footprint is fully dry (one whole cell). */
export const SHORE_MARGIN_LAND_FOOTPRINT_WU = BUILD_GRID_CELL_SIZE;
/** A water factory's rally/patrol point sits in open water, not on the beach. */
export const SHORE_MARGIN_WATER_WAYPOINT_WU = 120;
/** A land factory's rally point stays off the waterline. */
export const SHORE_MARGIN_LAND_WAYPOINT_WU = 40;
/** An opening-wave hull is launched with this much water under and around it. */
export const SHORE_MARGIN_WATER_SPAWN_WU = 120;
/** How far (in build cells) a nominal point may be walked to satisfy a margin. */
export const SHORE_POINT_SEARCH_CELLS = 24;

let cachedField: ShoreDistanceField | null = null;
let cachedTerrain: TerrainTileMap | null = null;
let cachedTerrainVersion = -1;
let cachedSim: ReturnType<typeof getSimWasm> | undefined = undefined;

/** The field for the installed authoritative terrain, or null when no
 *  authoritative tile map of these dimensions is installed (or the sim WASM
 *  is not ready). Cached per terrain install; cheap to call repeatedly. */
export function getShoreDistanceField(
  mapWidth: number,
  mapHeight: number,
): ShoreDistanceField | null {
  const terrain = getAuthoritativeTerrainTileMap();
  if (
    terrain === null ||
    terrain.mapWidth !== mapWidth ||
    terrain.mapHeight !== mapHeight
  ) {
    return null;
  }
  const sim = getSimWasm();
  if (sim === undefined) return null;
  const version = getTerrainVersion();
  if (
    cachedField !== null &&
    cachedSim === sim &&
    cachedTerrain === terrain &&
    cachedTerrainVersion === version &&
    cachedField.mapWidth === mapWidth &&
    cachedField.mapHeight === mapHeight
  ) {
    return cachedField;
  }
  ensurePathfinderTerrain(mapWidth, mapHeight);
  const cellsX = sim.pathfinder.gridWidth();
  const cellsY = sim.pathfinder.gridHeight();
  const cellCount = cellsX * cellsY;
  const waterSq = new Uint16Array(cellCount);
  const landSq = new Uint16Array(cellCount);
  if (sim.pathfinder.bakeShoreDistanceSq(waterSq, landSq) !== 1) return null;
  cachedField = Object.freeze({
    mapWidth,
    mapHeight,
    cellSize: BUILD_GRID_CELL_SIZE,
    cellsX,
    cellsY,
    reachWu: sim.pathfinder.clearanceReachCells() * BUILD_GRID_CELL_SIZE,
    waterSq,
    landSq,
  });
  cachedTerrain = terrain;
  cachedTerrainVersion = version;
  cachedSim = sim;
  return cachedField;
}

function cellIndexAt(field: ShoreDistanceField, x: number, y: number): number {
  const gx = Math.min(field.cellsX - 1, Math.max(0, Math.floor(x / field.cellSize)));
  const gy = Math.min(field.cellsY - 1, Math.max(0, Math.floor(y / field.cellSize)));
  return gy * field.cellsX + gx;
}

function mediumSq(field: ShoreDistanceField, medium: ShoreMedium): Uint16Array {
  return medium === 'water' ? field.waterSq : field.landSq;
}

/** Squared cell distance from the cell under (x, y) to the other medium; 0
 *  when the cell is not (fully) of `medium`. Integer, comparison-safe. */
export function shoreClearanceSqAt(
  field: ShoreDistanceField,
  medium: ShoreMedium,
  x: number,
  y: number,
): number {
  return mediumSq(field, medium)[cellIndexAt(field, x, y)];
}

/** World-unit distance from the cell under (x, y) to the other medium; 0 when
 *  the cell is not (fully) of `medium`. */
export function shoreClearanceAt(
  field: ShoreDistanceField,
  medium: ShoreMedium,
  x: number,
  y: number,
): number {
  return DMath.sqrt(shoreClearanceSqAt(field, medium, x, y)) * field.cellSize;
}

function marginSq(field: ShoreDistanceField, marginWu: number): number {
  const cells = marginWu / field.cellSize;
  return cells * cells;
}

/** Does the cell under (x, y) belong to `medium` with at least `marginWu` of
 *  it around? A zero margin still demands the cell itself be of the medium. */
export function pointHasShoreMargin(
  field: ShoreDistanceField,
  medium: ShoreMedium,
  x: number,
  y: number,
  marginWu: number,
): boolean {
  const sq = shoreClearanceSqAt(field, medium, x, y);
  return sq > 0 && sq >= marginSq(field, marginWu);
}

/** Walk outward from the nominal point in build-cell rings (nearest ring
 *  first) and return the centre of the first cell that holds `medium` with at
 *  least `marginWu` of it around; within a ring the deepest such cell wins.
 *  When no cell within `maxSearchCells` satisfies the margin, the deepest
 *  cell of the medium seen anywhere in the walk is returned; null only when
 *  the walk never touches the medium at all. Deterministic: fixed ring order,
 *  ties resolved by iteration order. */
export function findShorePointNear(
  field: ShoreDistanceField,
  medium: ShoreMedium,
  x: number,
  y: number,
  marginWu: number,
  maxSearchCells: number = SHORE_POINT_SEARCH_CELLS,
): { x: number; y: number } | null {
  const sqField = mediumSq(field, medium);
  const needSq = marginSq(field, marginWu);
  const cellSize = field.cellSize;
  const cx = Math.min(field.cellsX - 1, Math.max(0, Math.floor(x / cellSize)));
  const cy = Math.min(field.cellsY - 1, Math.max(0, Math.floor(y / cellSize)));
  let bestAnySq = 0;
  let bestAnyGx = -1;
  let bestAnyGy = -1;
  for (let ring = 0; ring <= maxSearchCells; ring++) {
    let ringBestSq = 0;
    let ringBestGx = -1;
    let ringBestGy = -1;
    const consider = (gx: number, gy: number): void => {
      if (gx < 0 || gy < 0 || gx >= field.cellsX || gy >= field.cellsY) return;
      const sq = sqField[gy * field.cellsX + gx];
      if (sq <= 0) return;
      if (sq > bestAnySq) {
        bestAnySq = sq;
        bestAnyGx = gx;
        bestAnyGy = gy;
      }
      if (sq >= needSq && sq > ringBestSq) {
        ringBestSq = sq;
        ringBestGx = gx;
        ringBestGy = gy;
      }
    };
    if (ring === 0) {
      consider(cx, cy);
    } else {
      // Top and bottom rows, then the left and right columns between them.
      for (let dx = -ring; dx <= ring; dx++) {
        consider(cx + dx, cy - ring);
        consider(cx + dx, cy + ring);
      }
      for (let dy = -ring + 1; dy <= ring - 1; dy++) {
        consider(cx - ring, cy + dy);
        consider(cx + ring, cy + dy);
      }
    }
    if (ringBestGx >= 0) {
      return { x: (ringBestGx + 0.5) * cellSize, y: (ringBestGy + 0.5) * cellSize };
    }
  }
  if (bestAnyGx < 0) return null;
  return { x: (bestAnyGx + 0.5) * cellSize, y: (bestAnyGy + 0.5) * cellSize };
}

/** Snap a nominal waypoint onto the medium with the given margin; the
 *  nominal point is kept verbatim when there is no field (bare worlds) or the
 *  walk finds no cell of the medium at all. */
export function snapPointToShoreMargin(
  field: ShoreDistanceField | null,
  medium: ShoreMedium,
  x: number,
  y: number,
  marginWu: number,
): { x: number; y: number } {
  if (field === null) return { x, y };
  return findShorePointNear(field, medium, x, y, marginWu) ?? { x, y };
}
