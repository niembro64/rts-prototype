// Pathfinder — A* on the building grid + line-of-sight smoothing.
//
// Planning happens once at command-execution time. The planner takes
// the unit's current position and the player's clicked goal, finds a
// cell-path that avoids buildings / water / steep terrain, smooths it
// down to the minimum number of waypoints whose straight-line
// connections all stay clear, and returns those waypoints in world
// coords. The caller turns each waypoint into a UnitAction so the
// existing Simulation.updateUnits()/advanceAction() loop walks the
// path one segment at a time.
//
// Cell semantics — a cell is blocked iff:
//   - out of map bounds, or
//   - occupied by a building (BuildingGrid.getCell(...).occupied), or
//   - over water (isWaterAt — from the water-impassable feature), or
//   - terrain slope is too steep (mountain dividers / peaks).
//
// The A* uses 8-connected neighbours with octile heuristic (admissible
// for diagonal moves at √2 cost). Diagonal corner-clipping is
// disallowed — the diagonal step is rejected unless BOTH adjacent
// cardinals are clear, so a unit can't slip between two buildings
// touching at a corner.
//
// Performance — bounded expansion (MAX_EXPANDED_NODES) keeps a
// hopeless target from stalling the tick; the binary-heap open list,
// flat Float32/Int32/Uint8 scratch arrays, and duplicate-push (vs
// decrease-key) keep the inner loop allocation-free per node visit.

import type { BuildingGrid } from './grid';
import { GRID_CELL_SIZE } from './grid';
import { isWaterAt, getSurfaceNormal } from './Terrain';
import type { ActionType, UnitAction } from './types';

type Vec2 = { x: number; y: number };

const SQRT2 = Math.SQRT2;
const SQRT2_MINUS_1 = SQRT2 - 1;

/** Tie-break multiplier on the heuristic. Slightly > 1 prefers
 *  paths closer to the goal among nodes with equal f, dramatically
 *  reducing exploration in open terrain. Still admissible enough for
 *  RTS purposes. */
const HEURISTIC_TIE_BREAK = 1.001;

/** Hard cap on A* expansions per query. With a 308×308 grid (largest
 *  current map) the worst legitimate path explores a few thousand
 *  cells; 8000 is a generous ceiling that catches infinite searches
 *  (target inside a sealed mountain) without sacrificing reachable
 *  paths. When hit, the planner falls back to the straight-line
 *  waypoint and lets physics resolve any local block. */
const MAX_EXPANDED_NODES = 8000;

/** Slope passability threshold. Surface normals are sampled at cell
 *  centres; nz=1 is flat ground, nz=0 is a vertical cliff. Below
 *  this value the cell is treated as a wall — chosen so that the
 *  carved/lifted ridges produced by `MOUNTAIN_SEPARATOR_AMPLITUDE`
 *  (when DIVIDERS = MOUNTAIN) become impassable, but gentle ripples
 *  in the central LAKE pattern stay walkable. */
const SLOPE_BLOCK_NZ = 0.85;

/** When the start or goal cell is blocked, scan outward this many
 *  cells in a Chebyshev-distance spiral looking for the nearest
 *  open cell to use as a substitute. 8 cells = 160 wu — generous
 *  enough to escape the inside of any single building footprint
 *  (factories are 5×4 cells; the centre is at most 2 cells from a
 *  boundary), short enough that a click on the middle of a deep
 *  lake still falls through to the straight-line fallback rather
 *  than rerouting to some unrelated open cell across the map. */
const NEAREST_OPEN_RADIUS = 8;

const CARDINAL_COST = 1;
const DIAGONAL_COST = SQRT2;

/** Eight neighbour deltas in (dx, dy, cost) groups: cardinals first,
 *  then diagonals. Order matters because the diagonal-clip check
 *  references the two cardinal neighbours as already-known states. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [ 1, 0, CARDINAL_COST],
  [-1, 0, CARDINAL_COST],
  [ 0, 1, CARDINAL_COST],
  [ 0,-1, CARDINAL_COST],
  [ 1, 1, DIAGONAL_COST],
  [ 1,-1, DIAGONAL_COST],
  [-1, 1, DIAGONAL_COST],
  [-1,-1, DIAGONAL_COST],
];

/** Plan a path from (startX, startY) to (goalX, goalY) in world
 *  coords. Returns the ORDERED list of waypoints the unit should
 *  visit, ending at the goal. Always returns at least one waypoint
 *  (the goal) — when no path is found, the unit gets the original
 *  click as a single straight-line action and physics handles
 *  whatever obstacle is in the way (water blocks thrust, buildings
 *  push back). */
export function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
): Vec2[] {
  const gridW = Math.ceil(mapWidth / GRID_CELL_SIZE);
  const gridH = Math.ceil(mapHeight / GRID_CELL_SIZE);

  const sgx = clampInt(Math.floor(startX / GRID_CELL_SIZE), 0, gridW - 1);
  const sgy = clampInt(Math.floor(startY / GRID_CELL_SIZE), 0, gridH - 1);
  const ggx = clampInt(Math.floor(goalX / GRID_CELL_SIZE), 0, gridW - 1);
  const ggy = clampInt(Math.floor(goalY / GRID_CELL_SIZE), 0, gridH - 1);

  // Per-query HARD-blocked cell cache (water / building / steep
  // slope). Terrain sampling and grid lookups are cheap individually
  // but each cell is visited up to 18 times across A*'s 8 neighbour
  // expansions plus the inflation halo below; memoising drops the
  // sample count by an order of magnitude.
  const hardBlockedCache = new Int8Array(gridW * gridH); // 0 unknown, 1 blocked, 2 clear
  const isHardBlocked = (gx: number, gy: number): boolean => {
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return true;
    const idx = gy * gridW + gx;
    const cached = hardBlockedCache[idx];
    if (cached !== 0) return cached === 1;
    let blocked = false;
    const cell = buildingGrid.getCell(gx, gy);
    if (cell?.occupied) {
      blocked = true;
    } else {
      const cx = (gx + 0.5) * GRID_CELL_SIZE;
      const cy = (gy + 0.5) * GRID_CELL_SIZE;
      if (isWaterAt(cx, cy, mapWidth, mapHeight)) {
        blocked = true;
      } else {
        const n = getSurfaceNormal(cx, cy, mapWidth, mapHeight, GRID_CELL_SIZE);
        if (n.nz < SLOPE_BLOCK_NZ) blocked = true;
      }
    }
    hardBlockedCache[idx] = blocked ? 1 : 2;
    return blocked;
  };

  // Configuration-space inflation. The planner reasons about cell
  // CENTRES; the unit is a sphere of radius ~10–30 wu = 0.5–1.5 cells
  // (GRID_CELL_SIZE = 20 wu). A path that hugs a coast/wall — even
  // one all of whose cells are technically dry — puts the unit's
  // body across the obstacle boundary, which trips
  // `GameServer.applyForces`' lookahead water-thrust gate and the
  // unit halts as if no path were planned. Treating any cell whose
  // 8-neighbour ring contains a hard-blocked cell as ALSO blocked
  // gives the path a one-cell buffer (20 wu of clearance) and the
  // unit's body stays clear of the shoreline / building boundary
  // while following waypoints.
  //
  // `isBlocked` is what A* and LOS smoothing both call. We never
  // directly use the un-inflated predicate after this point — the
  // snap-to-nearest-open helper, the diagonal-corner-clip check,
  // and Bresenham LOS all run against the inflated definition.
  const isBlocked = (gx: number, gy: number): boolean => {
    if (isHardBlocked(gx, gy)) return true;
    if (isHardBlocked(gx - 1, gy - 1)) return true;
    if (isHardBlocked(gx,     gy - 1)) return true;
    if (isHardBlocked(gx + 1, gy - 1)) return true;
    if (isHardBlocked(gx - 1, gy    )) return true;
    if (isHardBlocked(gx + 1, gy    )) return true;
    if (isHardBlocked(gx - 1, gy + 1)) return true;
    if (isHardBlocked(gx,     gy + 1)) return true;
    if (isHardBlocked(gx + 1, gy + 1)) return true;
    return false;
  };

  // Snap blocked endpoints to the nearest open cell within a small
  // spiral search. This is what makes pathfinding actually useful in
  // practice:
  //
  //   - Factory-produced units spawn at `factory.transform` which is
  //     INSIDE the factory's own occupied cells — the start is
  //     always blocked. Without snapping, every factory-produced
  //     unit would fall through to the straight-line fallback and
  //     never route around water/buildings (the dominant case in a
  //     demo battle).
  //
  //   - The user clicks into water / onto a building / on a peak —
  //     the goal cell is blocked. With snapping, the unit walks to
  //     the nearest accessible cell instead of pressing into the
  //     shoreline / wall. Cleaner UX than "I clicked, nothing
  //     happens."
  //
  // Snap radius is small (NEAREST_OPEN_RADIUS) so a deeply-blocked
  // target (e.g. middle of a lake) still falls through to straight-
  // line — we don't want the unit to walk to some random open cell
  // far from the user's actual intent.
  let snappedStart = { gx: sgx, gy: sgy };
  if (isBlocked(sgx, sgy)) {
    const open = findNearestOpenCell(sgx, sgy, gridW, gridH, isBlocked);
    if (!open) return [{ x: goalX, y: goalY }];
    snappedStart = open;
  }
  let snappedGoal = { gx: ggx, gy: ggy };
  let goalWasSnapped = false;
  if (isBlocked(ggx, ggy)) {
    const open = findNearestOpenCell(ggx, ggy, gridW, gridH, isBlocked);
    if (!open) return [{ x: goalX, y: goalY }];
    snappedGoal = open;
    goalWasSnapped = true;
  }
  const startCellGx = snappedStart.gx;
  const startCellGy = snappedStart.gy;
  const goalCellGx = snappedGoal.gx;
  const goalCellGy = snappedGoal.gy;

  // Same-cell after snapping → no planning needed.
  if (startCellGx === goalCellGx && startCellGy === goalCellGy) {
    return [{ x: goalX, y: goalY }];
  }

  // Scratch arrays scoped to this query. Allocating per call keeps
  // the planner stateless (no module-level dirty-bit bookkeeping)
  // at a few hundred KB / query for the largest map — pathfinding
  // is rare enough that the allocation noise is negligible.
  const cellCount = gridW * gridH;
  const gScore = new Float32Array(cellCount);
  const fScore = new Float32Array(cellCount);
  const parent = new Int32Array(cellCount);
  const closed = new Uint8Array(cellCount);
  gScore.fill(Infinity);
  fScore.fill(Infinity);
  parent.fill(-1);

  const startIdx = startCellGy * gridW + startCellGx;
  const goalIdx = goalCellGy * gridW + goalCellGx;
  gScore[startIdx] = 0;
  fScore[startIdx] = octile(startCellGx, startCellGy, goalCellGx, goalCellGy) * HEURISTIC_TIE_BREAK;

  const heap = new MinHeap(fScore);
  heap.push(startIdx);

  let expanded = 0;
  let foundGoal = false;
  while (heap.size() > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    expanded++;
    if (current === goalIdx) {
      foundGoal = true;
      break;
    }
    if (expanded >= MAX_EXPANDED_NODES) break;

    const cgx = current % gridW;
    const cgy = (current - cgx) / gridW;

    for (let i = 0; i < NEIGHBOURS.length; i++) {
      const [dx, dy, cost] = NEIGHBOURS[i];
      const ngx = cgx + dx;
      const ngy = cgy + dy;
      if (ngx < 0 || ngy < 0 || ngx >= gridW || ngy >= gridH) continue;
      if (isBlocked(ngx, ngy)) continue;
      // Disallow diagonal corner clipping — both adjacent
      // cardinals must be clear for the diagonal step to be
      // legal. Without this, units squirt through the corner
      // joint between two buildings touching at a vertex.
      if (dx !== 0 && dy !== 0) {
        if (isBlocked(cgx + dx, cgy)) continue;
        if (isBlocked(cgx, cgy + dy)) continue;
      }
      const neighbourIdx = ngy * gridW + ngx;
      if (closed[neighbourIdx]) continue;
      const tentative = gScore[current] + cost;
      if (tentative < gScore[neighbourIdx]) {
        parent[neighbourIdx] = current;
        gScore[neighbourIdx] = tentative;
        fScore[neighbourIdx] = tentative + octile(ngx, ngy, goalCellGx, goalCellGy) * HEURISTIC_TIE_BREAK;
        heap.push(neighbourIdx);
      }
    }
  }

  if (!foundGoal) {
    // No path under the budget — let the caller's straight-line
    // intent stand. Rare in normal play; the budget is generous.
    return [{ x: goalX, y: goalY }];
  }

  // Reconstruct grid-cell path (start excluded, goal included).
  const cellPath: number[] = [];
  for (let n = goalIdx; n !== startIdx && n !== -1; n = parent[n]) {
    cellPath.push(n);
  }
  cellPath.reverse();

  // String-pull: walk the raw cell path and keep only the waypoints
  // a straight Bresenham ray can't reach from the previous kept
  // waypoint. Long straight runs collapse to two waypoints, diagonal
  // staircases unstep into a clean slope. The unit's actual position
  // (startX/Y) is the implicit first anchor — we never emit it as a
  // waypoint, just use it for the first LOS test.
  const smoothed: Vec2[] = [];
  let anchorX = startX;
  let anchorY = startY;
  for (let i = 0; i < cellPath.length - 1; i++) {
    const candIdx = cellPath[i];
    const nextIdx = cellPath[i + 1];
    const cgx = candIdx % gridW;
    const cgy = (candIdx - cgx) / gridW;
    const ngx = nextIdx % gridW;
    const ngy = (nextIdx - ngx) / gridW;
    const candX = (cgx + 0.5) * GRID_CELL_SIZE;
    const candY = (cgy + 0.5) * GRID_CELL_SIZE;
    const nextX = (ngx + 0.5) * GRID_CELL_SIZE;
    const nextY = (ngy + 0.5) * GRID_CELL_SIZE;
    if (!hasLineOfSight(anchorX, anchorY, nextX, nextY, gridW, gridH, isBlocked)) {
      smoothed.push({ x: candX, y: candY });
      anchorX = candX;
      anchorY = candY;
    }
  }
  // Last waypoint:
  //   - Goal NOT snapped → user's actual click coordinates, preserving
  //     "click here exactly" precision.
  //   - Goal SNAPPED (click landed on water / building / peak) → use
  //     the snapped cell's centre, the actual reachable point. Falling
  //     back to the original click here would put the final waypoint
  //     inside an impassable cell, and the unit would press at the
  //     shore/wall via the thrust-block instead of stopping cleanly.
  if (goalWasSnapped) {
    smoothed.push({
      x: (snappedGoal.gx + 0.5) * GRID_CELL_SIZE,
      y: (snappedGoal.gy + 0.5) * GRID_CELL_SIZE,
    });
  } else {
    smoothed.push({ x: goalX, y: goalY });
  }

  return smoothed;
}

/** Plan a path from (startX, startY) to (goalX, goalY) and return one
 *  UnitAction per smoothed waypoint, all with the given `type`. Used by
 *  every code path that ASSIGNS unit.actions for a movement intent —
 *  player commands (commandExecution.executeMoveCommand), demo-battle
 *  unit spawn (BackgroundBattleStandalone.spawnUnit), and factory unit
 *  spawn (factoryProduction.createUnit). All three previously wrote a
 *  single straight-line action; routing them through `findPath` here
 *  is what actually makes water / building / mountain avoidance happen
 *  for AI-driven units (the player-driven case was already wired). */
export function expandPathActions(
  startX: number, startY: number,
  goalX: number, goalY: number,
  type: ActionType,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
): UnitAction[] {
  const path = findPath(startX, startY, goalX, goalY, mapWidth, mapHeight, buildingGrid);
  const out: UnitAction[] = [];
  for (let i = 0; i < path.length; i++) {
    out.push({ type, x: path[i].x, y: path[i].y });
  }
  return out;
}

function octile(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return Math.max(dx, dy) + SQRT2_MINUS_1 * Math.min(dx, dy);
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Spiral search outward from (gx, gy) for the nearest cell where
 *  `isBlocked` returns false, using Chebyshev distance (8-connected
 *  rings) so the search fans out one ring per radius step. Returns
 *  null if nothing within `NEAREST_OPEN_RADIUS` is open. The order
 *  inside a ring is arbitrary — first hit wins. Bounded loop, no
 *  allocations besides the return object. */
function findNearestOpenCell(
  gx: number, gy: number,
  gridW: number, gridH: number,
  isBlocked: (gx: number, gy: number) => boolean,
): { gx: number; gy: number } | null {
  for (let r = 1; r <= NEAREST_OPEN_RADIUS; r++) {
    // Top + bottom rows of the ring.
    for (let dx = -r; dx <= r; dx++) {
      const nxTop = gx + dx, nyTop = gy - r;
      if (nxTop >= 0 && nyTop >= 0 && nxTop < gridW && nyTop < gridH
        && !isBlocked(nxTop, nyTop)) return { gx: nxTop, gy: nyTop };
      const nxBot = gx + dx, nyBot = gy + r;
      if (nxBot >= 0 && nyBot >= 0 && nxBot < gridW && nyBot < gridH
        && !isBlocked(nxBot, nyBot)) return { gx: nxBot, gy: nyBot };
    }
    // Left + right columns of the ring (excluding corners already
    // covered by the top/bottom rows above).
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      const nxL = gx - r, nyL = gy + dy;
      if (nxL >= 0 && nyL >= 0 && nxL < gridW && nyL < gridH
        && !isBlocked(nxL, nyL)) return { gx: nxL, gy: nyL };
      const nxR = gx + r, nyR = gy + dy;
      if (nxR >= 0 && nyR >= 0 && nxR < gridW && nyR < gridH
        && !isBlocked(nxR, nyR)) return { gx: nxR, gy: nyR };
    }
  }
  return null;
}

/** Bresenham line-of-sight: returns true iff every cell the line
 *  from (x0, y0) to (x1, y1) crosses is unblocked. World coords in,
 *  cell sampling internal. Used by the post-process smoother. */
function hasLineOfSight(
  x0: number, y0: number, x1: number, y1: number,
  gridW: number, gridH: number,
  isBlocked: (gx: number, gy: number) => boolean,
): boolean {
  let gx0 = Math.floor(x0 / GRID_CELL_SIZE);
  let gy0 = Math.floor(y0 / GRID_CELL_SIZE);
  const gx1 = Math.floor(x1 / GRID_CELL_SIZE);
  const gy1 = Math.floor(y1 / GRID_CELL_SIZE);
  const sx = gx0 < gx1 ? 1 : -1;
  const sy = gy0 < gy1 ? 1 : -1;
  let dx = Math.abs(gx1 - gx0);
  let dy = Math.abs(gy1 - gy0);
  let err = dx - dy;
  // Cap iterations at the Manhattan distance + 1 — the line can
  // never visit more cells than that, so an unbounded loop would
  // be a logic bug.
  const maxSteps = dx + dy + 2;
  for (let step = 0; step < maxSteps; step++) {
    if (gx0 < 0 || gy0 < 0 || gx0 >= gridW || gy0 >= gridH) return false;
    if (isBlocked(gx0, gy0)) return false;
    if (gx0 === gx1 && gy0 === gy1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; gx0 += sx; }
    if (e2 <  dx) { err += dx; gy0 += sy; }
  }
  return false;
}

/** Binary-heap min-priority queue keyed off a parallel fScore array.
 *  Push duplicates instead of decrease-key — when a duplicate is
 *  popped after the node is already closed, the caller skips it.
 *  Standard A* idiom and faster than maintaining heap-index back-
 *  pointers in JS. */
class MinHeap {
  private heap: number[] = [];
  private f: Float32Array;

  constructor(fScores: Float32Array) {
    this.f = fScores;
  }

  size(): number {
    return this.heap.length;
  }

  push(idx: number): void {
    this.heap.push(idx);
    this.siftUp(this.heap.length - 1);
  }

  pop(): number {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const f = this.f;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (f[heap[i]] < f[heap[parent]]) {
        const tmp = heap[i]; heap[i] = heap[parent]; heap[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const f = this.f;
    const n = heap.length;
    for (;;) {
      const l = (i << 1) + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && f[heap[l]] < f[heap[smallest]]) smallest = l;
      if (r < n && f[heap[r]] < f[heap[smallest]]) smallest = r;
      if (smallest === i) break;
      const tmp = heap[i]; heap[i] = heap[smallest]; heap[smallest] = tmp;
      i = smallest;
    }
  }
}
