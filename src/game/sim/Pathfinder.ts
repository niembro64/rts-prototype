// Pathfinder — 2D A* on the building grid.
//
// Pipeline:
//   1. `ensureMaskAndCC` — runs once per (terrain × buildings) change.
//      Builds the blocked-cell mask and connected-component labels
//      for the whole grid. Everything downstream is cheap lookups
//      against these two arrays.
//   2. `findPath` — snap endpoints, run A* over open cells, smooth
//      the cell-path with a Bresenham line-of-sight walk.
//   3. `expandPathActions` — turn the smoothed waypoints into the
//      `UnitAction[]` callers actually consume.
//
// Design choices we kept after a long round of bugs:
//   • 8-connected A* with the octile heuristic. Bounded by
//     MAX_A_STAR_NODES so a pathological query can't stall a tick.
//     JPS would be faster on open ground but is ~10× more code and
//     wasn't actually load-bearing.
//   • Multi-point water sampling per cell (centre + 4 corners) so
//     shoreline cells get classified correctly even when their
//     centre is a hair above water level.
//   • Two-tier C-space inflation: 2 cells around water (so unit
//     bodies clear the shore), 1 cell around buildings (so the
//     demo's tight factory gaps stay passable). Buildings are
//     physics-pushable, so a generous halo around them isn't
//     needed; water can't be re-entered after the water-pusher
//     ejects, so the wider halo earns its keep there.
//   • Connected-component pre-flight. If start and goal are in
//     different components A* would just thrash; instead we snap
//     the goal to the nearest cell in start's component. A*
//     proper always succeeds within budget by construction.
//   • Euclidean-sorted snap offsets — no compass bias.
//   • Stay-put bail: when there's no possible path, return a
//     single waypoint at the unit's current position so the queue
//     gets cleared and the visualization doesn't draw a fake
//     straight line through obstacles.

import type { BuildingGrid } from './grid';
import { GRID_CELL_SIZE } from './grid';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
import { GAME_DIAGNOSTICS, debugWarn } from '../diagnostics';
import {
  isWaterAt,
  getSurfaceNormal,
  getSurfaceHeight,
  getTerrainVersion,
  getTerrainHeight,
  WATER_LEVEL,
} from './Terrain';
import type { ActionType, UnitAction } from './types';

type Vec2 = { x: number; y: number };

// ── Tunables ─────────────────────────────────────────────────────

/** Cells dilated around water/slope/map-edge. 2 cells = 40 wu of
 *  buffer, comfortably above most unit bodies; the water-pusher in
 *  GameServer.applyForces handles the few units larger than that. */
const TERRAIN_INFLATION_CELLS = 2;

/** Cells dilated around buildings. 1 cell = small smoothing buffer
 *  that keeps paths off building edges without sealing the demo's
 *  3.85-cell factory-to-factory gaps. Bumping this to 2 seals every
 *  team's base — don't. */
const BUILDING_INFLATION_CELLS = 1;

/** Slope nz floor — anything flatter than this nz is walkable.
 *  0.34 ≈ 70°, matches PhysicsEngine3D.integrate's stable limit. */
const SLOPE_BLOCK_NZ = 0.34;

/** Snap radius for blocked endpoints, in cells. 32 cells = 640 wu;
 *  enough to find a shore from the deepest part of the demo's
 *  central valley. */
const SNAP_RADIUS_CELLS = 32;

/** Hard cap on A* expansions per query. With the CC pre-flight
 *  we should never come close (the path is guaranteed to exist),
 *  but the cap is here to keep a hypothetical pathological query
 *  from stalling a tick. */
const MAX_A_STAR_NODES = 50_000;

/** When true, every path produced by `expandPathActions` is walked
 *  segment-by-segment and any world-space sample that lands over
 *  water is logged. Self-check for the planner's correctness — the
 *  output of A* + LOS smoothing should never put a line over water,
 *  so any log here is a real bug. Set to false to silence in
 *  production once the planner is trusted. */
const VALIDATE_PATHS = GAME_DIAGNOSTICS.pathValidation;

/** Spacing (world units) between water-check samples along each
 *  segment during path validation. 5 wu = quarter-cell resolution
 *  on a 20 wu grid; small enough to catch sub-cell water that
 *  cell-centred classification might miss, large enough not to
 *  flood the console. */
const VALIDATE_SAMPLE_STEP_WU = 5;

const SQRT2 = Math.SQRT2;
const SQRT2_MINUS_1 = SQRT2 - 1;

// ── Mask + CC cache ──────────────────────────────────────────────
//
// The full `_blocked` mask depends on BOTH terrain (water + slope) and
// the current building footprints. Terrain barely ever changes mid-
// battle (only when the host changes the map shape), but buildings
// change every time something is built or destroyed — and the demo
// battle does that constantly. Step 1 of the rebuild (terrain water
// sampling, 5 samples per cell × ~25k cells) was responsible for an
// observed ~500ms host-tick freeze whenever a building changed and the
// next path query landed: the whole mask was thrown out and rebuilt.
//
// Split the cache so the *terrain-only* mask + dilation is keyed on
// terrain version alone and reused across all building changes; only
// step 3 (building dilation) and step 4 (CC labels) re-run when the
// building grid changes.

let _maskKey = '';
let _gridW = 0;
let _gridH = 0;
let _blocked: Uint8Array | null = null;   // 1 = blocked, 0 = open
let _ccLabels: Int16Array | null = null;  // 0 = blocked, 1+ = component id

// Terrain-only blocked mask: water + slope cells, dilated by
// TERRAIN_INFLATION_CELLS, with map-edge cells clamped to blocked.
// Independent of buildings — only invalidated when terrain changes
// shape (host re-config) or grid dimensions change.
let _terrainBlockedKey = '';
let _terrainBlocked: Uint8Array | null = null;

function ensureTerrainBlocked(mapWidth: number, mapHeight: number): {
  terrainBlocked: Uint8Array;
  gridW: number;
  gridH: number;
  n: number;
} {
  const tVer = getTerrainVersion();
  const gridW = Math.ceil(mapWidth / GRID_CELL_SIZE);
  const gridH = Math.ceil(mapHeight / GRID_CELL_SIZE);
  const n = gridW * gridH;
  const tKey = `${tVer}|${gridW}|${gridH}`;
  if (
    tKey === _terrainBlockedKey &&
    _terrainBlocked !== null &&
    _terrainBlocked.length === n
  ) {
    return { terrainBlocked: _terrainBlocked, gridW, gridH, n };
  }

  // Step 1 — terrain mask. Water is a flat plane at WATER_LEVEL —
  // a cell is water-blocked iff its centre's underlying heightmap
  // dips below that plane. One raw heightmap sample per cell, no
  // mesh-aware interpolation and no shoreline-corner multi-sampling
  // (TERRAIN_INFLATION_CELLS below dilates the mask outward by 2
  // cells, which already gives the planner the shoreline buffer
  // those extra samples were trying to produce). Slope check stays
  // since steep cells can show up well above water.
  const terrainMask = new Uint8Array(n);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = (gx + 0.5) * GRID_CELL_SIZE;
      const cy = (gy + 0.5) * GRID_CELL_SIZE;
      let blk = false;
      if (getTerrainHeight(cx, cy, mapWidth, mapHeight) < WATER_LEVEL) {
        blk = true;
      } else {
        const norm = getSurfaceNormal(cx, cy, mapWidth, mapHeight, SPATIAL_GRID_CELL_SIZE);
        if (norm.nz < SLOPE_BLOCK_NZ) blk = true;
      }
      if (blk) terrainMask[gy * gridW + gx] = 1;
    }
  }

  // Step 2 — dilate the terrain mask by TERRAIN_INFLATION_CELLS into
  // the cached `terrainBlocked` array. Cells within `tk` of the map
  // edge are blocked too (out-of-bounds is treated as a wall). Result
  // is purely a function of terrain — buildings change does not
  // invalidate this and we reuse it across building churn.
  const tk = TERRAIN_INFLATION_CELLS;
  const terrainBlocked = new Uint8Array(n);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (gx < tk || gy < tk || gx >= gridW - tk || gy >= gridH - tk) {
        terrainBlocked[gy * gridW + gx] = 1;
        continue;
      }
      let blk = 0;
      stencil: for (let dy = -tk; dy <= tk; dy++) {
        const row = (gy + dy) * gridW;
        for (let dx = -tk; dx <= tk; dx++) {
          if (terrainMask[row + gx + dx] === 1) { blk = 1; break stencil; }
        }
      }
      if (blk) terrainBlocked[gy * gridW + gx] = 1;
    }
  }

  _terrainBlockedKey = tKey;
  _terrainBlocked = terrainBlocked;
  return { terrainBlocked, gridW, gridH, n };
}

function ensureMaskAndCC(
  buildingGrid: BuildingGrid,
  mapWidth: number, mapHeight: number,
): void {
  const tVer = getTerrainVersion();
  const bVer = buildingGrid.getVersion();
  // Terrain-only mask: cached across all building churn; recomputed
  // only when terrain config changes (very rare during a battle).
  const { terrainBlocked, gridW, gridH, n } = ensureTerrainBlocked(mapWidth, mapHeight);
  const key = `${tVer}|${bVer}|${gridW}|${gridH}`;
  if (key === _maskKey && _blocked !== null && _ccLabels !== null && _blocked.length === n) {
    return;
  }

  // Start the per-tick mask from the cached terrain mask. Avoids the
  // ~500ms terrain water-sampling pass on every building-version bump
  // — that pass was responsible for the host-side freeze whenever a
  // building was built or destroyed and the next path query landed.
  const blocked = new Uint8Array(terrainBlocked);

  // Step 3 — buildings dilated by BUILDING_INFLATION_CELLS, OR'd into
  // the same blocked mask. Iterating the BuildingGrid's occupied
  // cells (rather than scanning the grid) is far cheaper than the
  // terrain pass: ~50 buildings × 9 cells × 9-cell stencil = ~4 k
  // writes versus the grid's 95 k.
  const bk = BUILDING_INFLATION_CELLS;
  for (const { gx, gy } of buildingGrid.occupiedCells()) {
    for (let dy = -bk; dy <= bk; dy++) {
      const ny = gy + dy;
      if (ny < 0 || ny >= gridH) continue;
      const row = ny * gridW;
      for (let dx = -bk; dx <= bk; dx++) {
        const nx = gx + dx;
        if (nx < 0 || nx >= gridW) continue;
        blocked[row + nx] = 1;
      }
    }
  }

  // Step 4 — connected-component labelling via BFS over open cells.
  // Used by findPath's pre-flight: clicks landing in a different
  // component from the unit get snapped to the nearest cell in the
  // unit's component, instead of triggering a full A* exhaustion.
  const labels = new Int16Array(n);
  const queue = new Int32Array(n);
  let nextLabel = 1;
  for (let seed = 0; seed < n; seed++) {
    if (blocked[seed] === 1 || labels[seed] !== 0) continue;
    if (nextLabel > 32_000) break;
    labels[seed] = nextLabel;
    let qHead = 0, qTail = 0;
    queue[qTail++] = seed;
    while (qHead < qTail) {
      const idx = queue[qHead++];
      const cgx = idx % gridW;
      const cgy = (idx - cgx) / gridW;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cgy + dy;
        if (ny < 0 || ny >= gridH) continue;
        const row = ny * gridW;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cgx + dx;
          if (nx < 0 || nx >= gridW) continue;
          const nidx = row + nx;
          if (blocked[nidx] === 1 || labels[nidx] !== 0) continue;
          labels[nidx] = nextLabel;
          queue[qTail++] = nidx;
        }
      }
    }
    nextLabel++;
  }

  _maskKey = key;
  _gridW = gridW;
  _gridH = gridH;
  _blocked = blocked;
  _ccLabels = labels;
}

// ── Snap helpers ─────────────────────────────────────────────────

/** Precomputed (dx, dy) offsets within `SNAP_RADIUS_CELLS`, sorted
 *  by Euclidean distance². Iterating in distance order means the
 *  first acceptable cell we hit IS the nearest cell — no compass
 *  bias from the iteration order. Stored as a packed Int16Array
 *  (alternating dx, dy entries) for cache locality on the scan. */
const _snapOffsets: Int16Array = (() => {
  const r = SNAP_RADIUS_CELLS;
  const list: Array<{ dx: number; dy: number; d2: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      list.push({ dx, dy, d2 });
    }
  }
  list.sort((a, b) => a.d2 - b.d2);
  const buf = new Int16Array(list.length * 2);
  for (let i = 0; i < list.length; i++) {
    buf[i * 2] = list[i].dx;
    buf[i * 2 + 1] = list[i].dy;
  }
  return buf;
})();

function findNearestOpenCell(gx: number, gy: number): { gx: number; gy: number } | null {
  const blocked = _blocked!;
  const gridW = _gridW, gridH = _gridH;
  for (let i = 0; i < _snapOffsets.length; i += 2) {
    const nx = gx + _snapOffsets[i];
    const ny = gy + _snapOffsets[i + 1];
    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
    if (blocked[ny * gridW + nx] === 0) return { gx: nx, gy: ny };
  }
  return null;
}

function findNearestCellInComponent(
  gx: number, gy: number, componentLabel: number,
): { gx: number; gy: number } | null {
  if (componentLabel <= 0) return null;
  const labels = _ccLabels!;
  const gridW = _gridW, gridH = _gridH;
  for (let i = 0; i < _snapOffsets.length; i += 2) {
    const nx = gx + _snapOffsets[i];
    const ny = gy + _snapOffsets[i + 1];
    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
    if (labels[ny * gridW + nx] === componentLabel) return { gx: nx, gy: ny };
  }
  return null;
}

// ── A* with octile heuristic ─────────────────────────────────────

const NEIGHBOR_DX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NEIGHBOR_DY = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);
const NEIGHBOR_COST = new Float32Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + SQRT2_MINUS_1 * Math.min(dx, dy);
}

// Module-level scratch (resized once per grid-size change, then
// reused across queries).
let _scratchN = 0;
let _gScore: Float32Array | null = null;
let _fScore: Float32Array | null = null;
let _parent: Int32Array | null = null;
let _closed: Uint8Array | null = null;

function ensureScratch(n: number): void {
  if (_scratchN === n && _gScore !== null) {
    _gScore.fill(Infinity);
    _fScore!.fill(Infinity);
    _parent!.fill(-1);
    _closed!.fill(0);
    return;
  }
  _gScore = new Float32Array(n);
  _fScore = new Float32Array(n);
  _parent = new Int32Array(n);
  _closed = new Uint8Array(n);
  _gScore.fill(Infinity);
  _fScore.fill(Infinity);
  _parent.fill(-1);
  _scratchN = n;
}

// Pooled binary min-heap. Push duplicates instead of decrease-key —
// when the same node gets popped twice we skip the second pop via
// the `closed` flag. Standard A* idiom and faster than maintaining
// heap-index back-pointers in JS.
const _heap: number[] = [];

function heapPush(idx: number): void {
  const f = _fScore!;
  _heap.push(idx);
  let i = _heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (f[_heap[i]] < f[_heap[p]]) {
      const tmp = _heap[i]; _heap[i] = _heap[p]; _heap[p] = tmp;
      i = p;
    } else break;
  }
}

function heapPop(): number {
  const f = _fScore!;
  const top = _heap[0];
  const last = _heap.pop()!;
  if (_heap.length > 0) {
    _heap[0] = last;
    let i = 0;
    const len = _heap.length;
    while (true) {
      const l = (i << 1) + 1;
      const r = l + 1;
      let s = i;
      if (l < len && f[_heap[l]] < f[_heap[s]]) s = l;
      if (r < len && f[_heap[r]] < f[_heap[s]]) s = r;
      if (s === i) break;
      const tmp = _heap[i]; _heap[i] = _heap[s]; _heap[s] = tmp;
      i = s;
    }
  }
  return top;
}

function aStar(startGx: number, startGy: number, goalGx: number, goalGy: number): number[] | null {
  const gridW = _gridW, gridH = _gridH;
  const blocked = _blocked!;
  const n = gridW * gridH;

  ensureScratch(n);
  const gScore = _gScore!, fScore = _fScore!, parent = _parent!, closed = _closed!;
  _heap.length = 0;

  const startIdx = startGy * gridW + startGx;
  const goalIdx = goalGy * gridW + goalGx;
  gScore[startIdx] = 0;
  fScore[startIdx] = octile(startGx, startGy, goalGx, goalGy);
  heapPush(startIdx);

  let expanded = 0;
  let found = false;
  while (_heap.length > 0 && expanded < MAX_A_STAR_NODES) {
    const cur = heapPop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goalIdx) { found = true; break; }

    const cgx = cur % gridW;
    const cgy = (cur - cgx) / gridW;
    for (let k = 0; k < 8; k++) {
      const nx = cgx + NEIGHBOR_DX[k];
      const ny = cgy + NEIGHBOR_DY[k];
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      const nidx = ny * gridW + nx;
      if (blocked[nidx] === 1 || closed[nidx]) continue;
      const tentative = gScore[cur] + NEIGHBOR_COST[k];
      if (tentative < gScore[nidx]) {
        parent[nidx] = cur;
        gScore[nidx] = tentative;
        fScore[nidx] = tentative + octile(nx, ny, goalGx, goalGy);
        heapPush(nidx);
      }
    }
  }
  if (!found) return null;

  const path: number[] = [];
  for (let n = goalIdx; n !== startIdx && n !== -1; n = parent[n]) {
    path.push(n);
  }
  path.reverse();
  return path;
}

// ── LOS check (supercover Bresenham) ─────────────────────────────

/** Returns true iff every cell the line from (x0, y0) to (x1, y1)
 *  crosses is unblocked. Standard Bresenham + a side-cell check on
 *  diagonal steps so the line can't corner-cut past a single
 *  inflated halo cell. */
function hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
  const blocked = _blocked!;
  const gridW = _gridW, gridH = _gridH;
  let gx = Math.floor(x0 / GRID_CELL_SIZE);
  let gy = Math.floor(y0 / GRID_CELL_SIZE);
  const tgx = Math.floor(x1 / GRID_CELL_SIZE);
  const tgy = Math.floor(y1 / GRID_CELL_SIZE);
  const sx = gx < tgx ? 1 : -1;
  const sy = gy < tgy ? 1 : -1;
  const dx = Math.abs(tgx - gx);
  const dy = Math.abs(tgy - gy);
  let err = dx - dy;
  const maxSteps = dx + dy + 2;
  for (let step = 0; step < maxSteps; step++) {
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return false;
    if (blocked[gy * gridW + gx] === 1) return false;
    if (gx === tgx && gy === tgy) return true;
    const e2 = 2 * err;
    const aX = e2 > -dy;
    const aY = e2 < dx;
    if (aX && aY) {
      if (blocked[gy * gridW + (gx + sx)] === 1) return false;
      if (blocked[(gy + sy) * gridW + gx] === 1) return false;
    }
    if (aX) { err -= dy; gx += sx; }
    if (aY) { err += dx; gy += sy; }
  }
  return false;
}

// ── Public entry: findPath ───────────────────────────────────────

function findPath(
  startX: number, startY: number,
  goalX: number, goalY: number,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
): Vec2[] {
  ensureMaskAndCC(buildingGrid, mapWidth, mapHeight);
  const blocked = _blocked!;
  const ccLabels = _ccLabels!;
  const gridW = _gridW, gridH = _gridH;

  const sgx = Math.max(0, Math.min(gridW - 1, Math.floor(startX / GRID_CELL_SIZE)));
  const sgy = Math.max(0, Math.min(gridH - 1, Math.floor(startY / GRID_CELL_SIZE)));
  const ggx = Math.max(0, Math.min(gridW - 1, Math.floor(goalX / GRID_CELL_SIZE)));
  const ggy = Math.max(0, Math.min(gridH - 1, Math.floor(goalY / GRID_CELL_SIZE)));

  // Snap blocked start to nearest open cell. The unit's actual
  // position may sit inside the inflation halo (knockback, spawn
  // inside a factory footprint, etc.); we plan from the snapped
  // cell instead.
  let startCellGx = sgx, startCellGy = sgy;
  let startWasSnapped = false;
  if (blocked[sgy * gridW + sgx] === 1) {
    const open = findNearestOpenCell(sgx, sgy);
    if (!open) return [{ x: startX, y: startY }];
    startCellGx = open.gx;
    startCellGy = open.gy;
    startWasSnapped = true;
  }

  // Snap goal to start's connected component. Catches both blocked
  // goal cells AND open-but-unreachable goal cells (e.g. a click on
  // an island the unit can't get to). After this snap A* is
  // guaranteed to succeed — start and goal are in the same
  // component by construction.
  const startLabel = ccLabels[startCellGy * gridW + startCellGx];
  let goalCellGx = ggx, goalCellGy = ggy;
  let goalWasSnapped = false;
  if (ccLabels[ggy * gridW + ggx] !== startLabel) {
    const remap = findNearestCellInComponent(ggx, ggy, startLabel);
    if (!remap) return [{ x: startX, y: startY }];
    goalCellGx = remap.gx;
    goalCellGy = remap.gy;
    goalWasSnapped = true;
  }

  // Same cell after snapping — no A* needed.
  if (startCellGx === goalCellGx && startCellGy === goalCellGy) {
    if (goalWasSnapped) {
      return [{
        x: (goalCellGx + 0.5) * GRID_CELL_SIZE,
        y: (goalCellGy + 0.5) * GRID_CELL_SIZE,
      }];
    }
    return [{ x: goalX, y: goalY }];
  }

  const cellPath = aStar(startCellGx, startCellGy, goalCellGx, goalCellGy);
  if (!cellPath) return [{ x: startX, y: startY }];

  // String-pull LOS smoothing. Keep candidate cells only when LOS
  // from the previous anchor to the cell AFTER the candidate fails.
  // Long open runs collapse to two waypoints.
  const smoothed: Vec2[] = [];
  let anchorX: number, anchorY: number;
  if (startWasSnapped) {
    const sxw = (startCellGx + 0.5) * GRID_CELL_SIZE;
    const syw = (startCellGy + 0.5) * GRID_CELL_SIZE;
    smoothed.push({ x: sxw, y: syw });
    anchorX = sxw;
    anchorY = syw;
  } else {
    anchorX = startX;
    anchorY = startY;
  }
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
    if (!hasLineOfSight(anchorX, anchorY, nextX, nextY)) {
      smoothed.push({ x: candX, y: candY });
      anchorX = candX;
      anchorY = candY;
    }
  }
  if (goalWasSnapped) {
    smoothed.push({
      x: (goalCellGx + 0.5) * GRID_CELL_SIZE,
      y: (goalCellGy + 0.5) * GRID_CELL_SIZE,
    });
  } else {
    smoothed.push({ x: goalX, y: goalY });
  }
  return smoothed;
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
          // else: still walking out of water — OK, keep scanning
          //       until the first dry sample.
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
 *  Otherwise z falls back to a terrain sample at the waypoint's xy. */
export function expandPathActions(
  startX: number, startY: number,
  goalX: number, goalY: number,
  type: ActionType,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ?: number,
): UnitAction[] {
  const path = findPath(startX, startY, goalX, goalY, mapWidth, mapHeight, buildingGrid);
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
      : getSurfaceHeight(px, py, mapWidth, mapHeight, SPATIAL_GRID_CELL_SIZE);
    const action: UnitAction = { type, x: px, y: py, z };
    if (!isFinal) action.isPathExpansion = true;
    out.push(action);
  }
  return out;
}
