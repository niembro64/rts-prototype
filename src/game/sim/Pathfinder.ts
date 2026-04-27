// Pathfinder — Jump Point Search on the building grid + LOS smoothing.
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
// Algorithm — JPS (Harabor & Grastien, AAAI 2011), the canonical
// industry-standard upgrade over vanilla A* for uniform-cost grids.
// The outer loop is still A* — same heap, same gScore, same parent
// chain — but instead of expanding the 8 neighbours of every popped
// node, we "jump" in each pruned direction until hitting a jump
// point (a cell whose 8-neighbourhood contains a "forced" neighbour
// that wouldn't be reachable along an optimal path without bending
// here). On open ground this collapses thousands of redundant
// symmetric A* expansions into a single straight-line jump,
// producing the same path quality at a fraction of the node visits.
//
// Cell semantics — a cell is HARD-blocked iff:
//   - out of map bounds, or
//   - occupied by a building (BuildingGrid.getCell(...).occupied), or
//   - over water (isWaterAt — from the water-impassable feature), or
//   - terrain slope is too steep (mountain dividers / peaks).
//
// `isBlocked` is HARD-blocked OR any 8-neighbour is hard-blocked
// (configuration-space inflation). All JPS predicates run against
// this inflated definition so the path keeps a 1-cell buffer (20 wu)
// from every obstacle and the unit's body radius doesn't trip the
// runtime water-thrust gate while following waypoints.
//
// Variant: canonical CORNER-CUTTING JPS (the original 2011 paper's
// formulation). The "no corner cut" safety property is provided
// instead by C-space inflation: any cell whose 8-neighbour ring
// contains a hard-blocked cell is itself blocked. So a diagonal
// step that would have skimmed the corner of a hard obstacle hits
// the inflated blocked cell at the diagonal destination and is
// rejected by the standard `isBlocked` check. Inflation also
// strictly dominates per-step corner-cut rejection in coverage —
// the no-corner-cut variant is provably incomplete (misses paths
// in some L-shaped obstacle configurations) under canonical JPS
// pruning rules, whereas corner-cut JPS + inflation is complete
// AND optimal AND has simpler rules.
//
// Performance — bounded jump-point expansion (MAX_JP_EXPANSIONS)
// keeps a hopeless target from stalling the tick. The heap, scratch
// arrays, and duplicate-push idiom from the prior A* implementation
// carry over verbatim — JPS only changes which nodes get pushed.

import type { BuildingGrid } from './grid';
import { GRID_CELL_SIZE } from './grid';
import { isWaterAt, getSurfaceNormal, getSurfaceHeight, getTerrainVersion } from './Terrain';
import type { ActionType, UnitAction } from './types';

type Vec2 = { x: number; y: number };

const SQRT2 = Math.SQRT2;
const SQRT2_MINUS_1 = SQRT2 - 1;

/** Tie-break multiplier on the heuristic. Slightly > 1 prefers
 *  paths closer to the goal among nodes with equal f, dramatically
 *  reducing exploration in open terrain. Still admissible enough for
 *  RTS purposes. */
const HEURISTIC_TIE_BREAK = 1.001;

/** Hard cap on jump-point expansions per query (heap-pops). With
 *  the precomputed terrain + building inflation masks each
 *  expansion is just two array reads in `isBlocked`, so we can
 *  afford a generous limit. 100k ≈ 105% of the largest current
 *  grid (308×308 = ~95k cells) — the cap exists strictly to bail
 *  on truly unreachable goals rather than throttling
 *  complex-but-reachable searches. */
const MAX_JP_EXPANSIONS = 100_000;

/** Hard cap on TOTAL cells visited inside `jump` calls per query.
 *  JPS does most of its work inside the diagonal-step cardinal
 *  sub-recursion — for an N-cell diagonal jump in open ground,
 *  each step recurses into 2 cardinal sub-jumps that walk all the
 *  way to the next obstacle / map edge, costing N × (2 × edge
 *  distance) cell visits per heap-pop. Without this cap a single
 *  pathological query could visit billions of cells while staying
 *  well under the expansion cap, blocking the tick.
 *
 *  2 million cells ≈ 21 full-grid sweeps; comfortably above any
 *  realistic query but well below "stalls the simulation". When
 *  hit, the planner bails with `no-path`. */
const MAX_JUMP_CELL_VISITS = 2_000_000;

/** Slope passability threshold. Surface normals are sampled at cell
 *  centres; nz=1 is flat ground, nz=0 is a vertical cliff. Below
 *  this value the cell is treated as a wall.
 *
 *  Tuned to match what the PHYSICS engine can actually walk —
 *  `PhysicsEngine3D.integrate`'s slope-projection model is stable up
 *  to ~70° (nz ≈ 0.34, see its file comment). Anything physics can
 *  walk should be passable to the planner, otherwise the planner
 *  refuses paths the units could actually follow.
 *
 *  Why this matters: the central ripple pattern (LAKE or MOUNTAIN
 *  centre) has rolling sinusoidal slopes up to ~60° around its lake
 *  basins. With the old 0.85 threshold (~32°), every cell of those
 *  slopes was slope-blocked, which — combined with C-space inflation
 *  — sealed the thin near-centre corridor that physically connects
 *  the team slices when DIVIDERS=LAKE. The user could see the path
 *  visually (units walking around the lake shore) but JPS bailed
 *  with `no-path` because every crossing route hit the slope halo.
 *  Land is connected as long as it stays above WATER_LEVEL; the
 *  slope check should only reject genuine vertical cliffs that
 *  physics itself can't traverse, not gentle bumps. */
const SLOPE_BLOCK_NZ = 0.34;

/** C-space inflation radii (in cells), specified separately for
 *  terrain (water + slope + map-edge OOB) and buildings. The
 *  blocked-cell masks are dilated by these radii so paths and
 *  smoothed lines keep at least `radius * GRID_CELL_SIZE` world
 *  units of clearance from each obstacle type.
 *
 *  Why split: the two obstacle classes interact with units very
 *  differently.
 *
 *    Water — impassable to physics. The water-pusher in
 *    GameServer.applyForces ejects any unit whose body centre
 *    crosses the shoreline, so we need the planner to keep the
 *    body fully clear. Largest unit `push` radius is ~54 wu
 *    (mammoth/widow); 2 cells = 40 wu of clearance lets every
 *    unit smaller than 40 wu fully clear water at every waypoint,
 *    and the few units larger than that get nudged back inland by
 *    the pusher when they overhang the inflation halo.
 *
 *    Buildings — physics-pushable. Rigid-body collision in
 *    PhysicsEngine3D pushes a unit off any building it touches,
 *    so the planner doesn't need to keep the body fully clear of
 *    building walls. A 1-cell buffer is enough for path quality
 *    (avoids waypoints exactly at building edges) without sealing
 *    the demo map's narrow factory-to-factory and arc-to-arc gaps.
 *
 *  Sealing math (load-bearing): the demo battle places 14
 *  factories per player on a 45° arc at radius 2800. Centre-to-
 *  centre spacing is ~157 wu, edge-to-edge gap is ~77 wu = 3.85
 *  cells. With BUILDING=1 the inflated gap is 3.85 − 2 = 1.85
 *  cells of passable space. With BUILDING=2 the gap goes to
 *  −0.15 cells — every team's base is sealed and units can't
 *  pathfind out. Don't increase BUILDING_INFLATION_CELLS without
 *  re-checking these numbers against the current demo geometry. */
const TERRAIN_INFLATION_CELLS = 2;
const BUILDING_INFLATION_CELLS = 1;

/** When the start or goal cell is blocked, scan outward this many
 *  cells looking for the nearest open cell to use as a substitute.
 *  32 cells = 640 wu — covers the demo map's full central-water
 *  diameter under a default LAKE configuration. */
const NEAREST_OPEN_RADIUS = 32;

/** Pre-sorted (dx, dy) offsets within `NEAREST_OPEN_RADIUS`, ordered
 *  by Euclidean distance from the centre. This is what makes
 *  `findNearestOpenCell` return the actual nearest dry cell — not
 *  the first one a directionally-biased ring scan happens to hit.
 *
 *  The previous implementation iterated Chebyshev rings and within
 *  each ring tested top-row first, then bottom, then left-col,
 *  then right-col. For a unit in inflated space with all 4
 *  cardinals open, the snap deterministically picked the NW corner
 *  cell (top, leftmost-tested-first) — a real directional bias.
 *  Two units mirroring each other across an axis got snapped in
 *  the same world direction, producing visibly asymmetric routes.
 *
 *  By sorting by Euclidean distance the snap target is independent
 *  of compass direction: the 4 cardinals all sit at distance 1 and
 *  precede the 4 diagonals at distance √2. Within a tie band the
 *  iteration is still some fixed order, but the bias is now
 *  sub-cell rather than the prior "always grab NW corner" pattern. */
const _snapOffsets: Int16Array = (() => {
  const r = NEAREST_OPEN_RADIUS;
  const list: Array<{ dx: number; dy: number; d2: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue; // strict Euclidean disc, not Chebyshev square
      list.push({ dx, dy, d2 });
    }
  }
  list.sort((a, b) => a.d2 - b.d2);
  // Pack as (dx, dy) pairs in a single Int16Array for cache locality
  // on the hot scan.
  const buf = new Int16Array(list.length * 2);
  for (let i = 0; i < list.length; i++) {
    buf[i * 2] = list[i].dx;
    buf[i * 2 + 1] = list[i].dy;
  }
  return buf;
})();

/** All 8 neighbour direction deltas — used at the START node where
 *  no parent direction is defined. Cardinals first, diagonals after. */
const ALL_8_DIRS: ReadonlyArray<readonly [number, number]> = [
  [ 1, 0], [-1, 0], [ 0, 1], [ 0,-1],
  [ 1, 1], [ 1,-1], [-1, 1], [-1,-1],
];

// ── Module-level scratch + caches ────────────────────────────────
//
// All sized to (gridW × gridH) for the most-recently-queried map.
// On a map-size change (new lobby battle / different terrain) we
// reallocate; otherwise these arrays are reused across every
// findPath call, eliminating ~hundreds-of-KB-per-query allocations
// and the GC pressure that came with them.

let _scratchGridW = 0;
let _scratchGridH = 0;
let _scratchGScore: Float32Array | null = null;
let _scratchFScore: Float32Array | null = null;
let _scratchParent: Int32Array | null = null;
let _scratchClosed: Uint8Array | null = null;

function ensureScratch(gridW: number, gridH: number): void {
  if (gridW === _scratchGridW && gridH === _scratchGridH) {
    // Same dimensions — wipe to fresh state (.fill is fast — TypedArray.fill).
    _scratchGScore!.fill(Infinity);
    _scratchFScore!.fill(Infinity);
    _scratchParent!.fill(-1);
    _scratchClosed!.fill(0);
    return;
  }
  const n = gridW * gridH;
  _scratchGScore = new Float32Array(n);
  _scratchFScore = new Float32Array(n);
  _scratchParent = new Int32Array(n);
  _scratchClosed = new Uint8Array(n);
  _scratchGScore.fill(Infinity);
  _scratchFScore.fill(Infinity);
  _scratchParent.fill(-1);
  _scratchGridW = gridW;
  _scratchGridH = gridH;
}

/** Terrain-blocked cache (water + slope). Independent of buildings —
 *  it's a pure function of the heightmap and the SLOPE_BLOCK_NZ
 *  threshold, so we keep it across queries and invalidate ONLY when
 *  Terrain bumps its version (terrain shape / team count change).
 *  Massive win: filling this at first call is O(n) terrain samples,
 *  and every subsequent query becomes a pure array lookup —
 *  isWaterAt and getSurfaceNormal are NOT called per cell on the
 *  hot path anymore. 0 = unknown (uninitialised), 1 = blocked,
 *  2 = clear. */
let _terrainBlockedCache: Uint8Array | null = null;
let _terrainBlockedVersion = -1;
let _terrainBlockedGridW = 0;
let _terrainBlockedGridH = 0;
let _terrainBlockedMapW = 0;
let _terrainBlockedMapH = 0;

function ensureTerrainBlocked(
  gridW: number, gridH: number,
  mapWidth: number, mapHeight: number,
): Uint8Array {
  const ver = getTerrainVersion();
  if (
    _terrainBlockedCache !== null &&
    _terrainBlockedVersion === ver &&
    _terrainBlockedGridW === gridW &&
    _terrainBlockedGridH === gridH &&
    _terrainBlockedMapW === mapWidth &&
    _terrainBlockedMapH === mapHeight
  ) {
    return _terrainBlockedCache;
  }
  const n = gridW * gridH;
  if (_terrainBlockedCache === null || _terrainBlockedCache.length !== n) {
    _terrainBlockedCache = new Uint8Array(n);
  } else {
    _terrainBlockedCache.fill(0);
  }
  // Populate every cell once — water + slope at this terrain config.
  // Sampling at cell centres mirrors the per-query check this used to
  // do. The slope test calls `getSurfaceNormal` (4 height samples per
  // cell) — paying that cost ONCE here, not per JPS query.
  const cache = _terrainBlockedCache;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = (gx + 0.5) * GRID_CELL_SIZE;
      const cy = (gy + 0.5) * GRID_CELL_SIZE;
      let blocked = false;
      if (isWaterAt(cx, cy, mapWidth, mapHeight)) {
        blocked = true;
      } else {
        const normal = getSurfaceNormal(cx, cy, mapWidth, mapHeight, GRID_CELL_SIZE);
        if (normal.nz < SLOPE_BLOCK_NZ) blocked = true;
      }
      cache[gy * gridW + gx] = blocked ? 1 : 2;
    }
  }
  _terrainBlockedVersion = ver;
  _terrainBlockedGridW = gridW;
  _terrainBlockedGridH = gridH;
  _terrainBlockedMapW = mapWidth;
  _terrainBlockedMapH = mapHeight;
  return cache;
}

/** Inflated terrain-blocked mask. A cell is set iff itself OR any
 *  cell within Chebyshev distance `TERRAIN_INFLATION_CELLS` is
 *  terrain-blocked — i.e. C-space inflation applied to the terrain
 *  layer alone. Same version-key as `_terrainBlockedCache` so it's
 *  only rebuilt when terrain config changes. The `isBlocked`
 *  predicate becomes a SINGLE array lookup for the terrain side
 *  instead of a per-cell stencil scan, which dominates the JPS
 *  hot loop's cost. */
let _terrainInflatedCache: Uint8Array | null = null;
let _terrainInflatedVersion = -1;
let _terrainInflatedGridW = 0;
let _terrainInflatedGridH = 0;

function ensureTerrainInflated(
  gridW: number, gridH: number,
  mapWidth: number, mapHeight: number,
): Uint8Array {
  const ver = getTerrainVersion();
  if (
    _terrainInflatedCache !== null &&
    _terrainInflatedVersion === ver &&
    _terrainInflatedGridW === gridW &&
    _terrainInflatedGridH === gridH
  ) {
    return _terrainInflatedCache;
  }
  const tBlocked = ensureTerrainBlocked(gridW, gridH, mapWidth, mapHeight);
  const n = gridW * gridH;
  if (_terrainInflatedCache === null || _terrainInflatedCache.length !== n) {
    _terrainInflatedCache = new Uint8Array(n);
  } else {
    _terrainInflatedCache.fill(0);
  }
  const out = _terrainInflatedCache;
  // Dilation pass: mark every cell whose (2k+1)×(2k+1) neighbourhood
  // contains a blocked cell, where k = TERRAIN_INFLATION_CELLS.
  // Out-of-bounds is treated as blocked — a cell within k of the map
  // edge is adjacent to OOB and therefore inflated.
  const k = TERRAIN_INFLATION_CELLS;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let blocked = 0;
      if (gx < k || gy < k || gx >= gridW - k || gy >= gridH - k) {
        blocked = 1;
      } else {
        // (2k+1)×(2k+1) stencil scan; bail on first blocked.
        outer: for (let dy = -k; dy <= k; dy++) {
          const row = (gy + dy) * gridW;
          for (let dx = -k; dx <= k; dx++) {
            if (tBlocked[row + gx + dx] === 1) { blocked = 1; break outer; }
          }
        }
      }
      out[gy * gridW + gx] = blocked;
    }
  }
  _terrainInflatedVersion = ver;
  _terrainInflatedGridW = gridW;
  _terrainInflatedGridH = gridH;
  return out;
}

/** Inflated building-blocked mask. Rebuilt only when the building
 *  grid mutates (BuildingGrid.getVersion bumps on place/remove).
 *  Iterates the building grid's occupiedCells() and stamps the
 *  (2k+1)² stencil around each occupied cell into the mask, where
 *  k = BUILDING_INFLATION_CELLS — far cheaper than walking every
 *  cell in the grid since most cells are never near a building. */
let _buildingInflatedCache: Uint8Array | null = null;
let _buildingInflatedVersion = -1;
let _buildingInflatedGridW = 0;
let _buildingInflatedGridH = 0;
let _buildingInflatedGrid: BuildingGrid | null = null;

function ensureBuildingInflated(
  buildingGrid: BuildingGrid,
  gridW: number, gridH: number,
): Uint8Array {
  const ver = buildingGrid.getVersion();
  if (
    _buildingInflatedCache !== null &&
    _buildingInflatedGrid === buildingGrid &&
    _buildingInflatedVersion === ver &&
    _buildingInflatedGridW === gridW &&
    _buildingInflatedGridH === gridH
  ) {
    return _buildingInflatedCache;
  }
  const n = gridW * gridH;
  if (_buildingInflatedCache === null || _buildingInflatedCache.length !== n) {
    _buildingInflatedCache = new Uint8Array(n);
  } else {
    _buildingInflatedCache.fill(0);
  }
  const out = _buildingInflatedCache;
  const k = BUILDING_INFLATION_CELLS;
  for (const { gx, gy } of buildingGrid.occupiedCells()) {
    for (let dy = -k; dy <= k; dy++) {
      const ny = gy + dy;
      if (ny < 0 || ny >= gridH) continue;
      const row = ny * gridW;
      for (let dx = -k; dx <= k; dx++) {
        const nx = gx + dx;
        if (nx < 0 || nx >= gridW) continue;
        out[row + nx] = 1;
      }
    }
  }
  _buildingInflatedVersion = ver;
  _buildingInflatedGrid = buildingGrid;
  _buildingInflatedGridW = gridW;
  _buildingInflatedGridH = gridH;
  return out;
}

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

  // Reuse module-level scratch (gScore / fScore / parent / closed).
  ensureScratch(gridW, gridH);

  // Inflated-blocked predicate, built from two precomputed masks
  // that the planner used to recompute on every cell visit:
  //
  //   1. terrainInflated — terrain (water + slope) dilated by 1
  //      cell. Cached at module level, version-keyed to
  //      Terrain.getTerrainVersion(); rebuilt only when the host
  //      changes the lobby's CENTER / DIVIDERS / team count.
  //
  //   2. buildingInflated — occupied building cells dilated by 1
  //      cell. Cached at module level, version-keyed to
  //      BuildingGrid.getVersion(); rebuilt when buildings are
  //      placed or destroyed.
  //
  // `isBlocked` reduces to `terrainInflated[idx] || buildingInflated[idx]`
  // — two contiguous TypedArray reads per cell visit, replacing the
  // old 9-call hard-blocked + inflation-ring predicate that did up
  // to 9 Map.get calls into BuildingGrid per visit. Inflation
  // semantics are unchanged: any cell whose 8-neighbour ring
  // contains a hard-blocked cell is still itself blocked.
  const terrainInflated = ensureTerrainInflated(gridW, gridH, mapWidth, mapHeight);
  const buildingInflated = ensureBuildingInflated(buildingGrid, gridW, gridH);
  const isBlocked = (gx: number, gy: number): boolean => {
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return true;
    const idx = gy * gridW + gx;
    return terrainInflated[idx] === 1 || buildingInflated[idx] === 1;
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
  // BAIL POLICY. When the planner can't produce a valid route, it
  // emits a single waypoint at the unit's CURRENT position
  // (startX, startY) — i.e. "stay put". The previous behaviour was
  // to fall back to a single waypoint at the user's click point,
  // which let physics/water-pusher handle the rest, but it had two
  // bad UX consequences: the visualized path drew a straight line
  // from the unit through any obstacle the click was past (often
  // crossing water), and on the rare goal-snap fail the unit
  // beelined at the obstacle until the water-pusher stopped them.
  // Returning the unit's own position visualizes nothing and tells
  // the action system "queue is replaced with a no-op", which
  // resolves on the next tick. Bail counters are still tracked
  // through `_lastBailReason` for diagnostics.
  _lastBailReason = 'ok';
  let snappedStart = { gx: sgx, gy: sgy };
  if (isBlocked(sgx, sgy)) {
    const open = findNearestOpenCell(sgx, sgy, gridW, gridH, isBlocked);
    if (!open) {
      _lastBailReason = 'start-snap';
      return [{ x: startX, y: startY }];
    }
    snappedStart = open;
  }
  let snappedGoal = { gx: ggx, gy: ggy };
  let goalWasSnapped = false;
  if (isBlocked(ggx, ggy)) {
    const open = findNearestOpenCell(ggx, ggy, gridW, gridH, isBlocked);
    if (!open) {
      _lastBailReason = 'goal-snap';
      return [{ x: startX, y: startY }];
    }
    snappedGoal = open;
    goalWasSnapped = true;
  }
  const startCellGx = snappedStart.gx;
  const startCellGy = snappedStart.gy;
  const goalCellGx = snappedGoal.gx;
  const goalCellGy = snappedGoal.gy;

  // Same-cell after snapping → no planning needed. If the goal was
  // snapped (user clicked on water / a building / a peak that
  // collapsed to the unit's own snap target) the original click is
  // inside an impassable cell — walking to it would beeline at the
  // obstacle. Use the snapped cell's centre instead. Otherwise the
  // click cell is the goal cell and walking to the unsnapped coords
  // preserves "click here exactly" precision.
  if (startCellGx === goalCellGx && startCellGy === goalCellGy) {
    _lastBailReason = 'same-cell';
    if (goalWasSnapped) {
      return [{
        x: (snappedGoal.gx + 0.5) * GRID_CELL_SIZE,
        y: (snappedGoal.gy + 0.5) * GRID_CELL_SIZE,
      }];
    }
    return [{ x: goalX, y: goalY }];
  }

  // Module-level scratch already wiped at the top of the function.
  const gScore = _scratchGScore!;
  const fScore = _scratchFScore!;
  const parent = _scratchParent!;
  const closed = _scratchClosed!;

  const startIdx = startCellGy * gridW + startCellGx;
  const goalIdx = goalCellGy * gridW + goalCellGx;
  gScore[startIdx] = 0;
  fScore[startIdx] = octile(startCellGx, startCellGy, goalCellGx, goalCellGy) * HEURISTIC_TIE_BREAK;

  // Reset the per-query cell-visit budget consumed by `jump`.
  _jumpCellsRemaining = MAX_JUMP_CELL_VISITS;

  // Reuse the module-level heap; cheaper than allocating a fresh
  // `number[]` each query.
  const heap = _heap;
  heap.setScores(fScore);
  heap.reset();
  heap.push(startIdx);

  let expanded = 0;
  let foundGoal = false;
  // Scratch result struct reused across every jump() call to avoid
  // allocation in the hot loop. `jump` writes to (gx, gy) and
  // returns true on a hit, false on miss — output-parameter idiom.
  const jpResult = { gx: 0, gy: 0 };
  while (heap.size() > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goalIdx) {
      foundGoal = true;
      break;
    }
    expanded++;
    if (expanded >= MAX_JP_EXPANSIONS) break;

    const cgx = current % gridW;
    const cgy = (current - cgx) / gridW;
    const parentIdx = parent[current];

    // Determine which directions to jump in. From the start node
    // (no parent) try all 8; from any other node, prune based on
    // the direction we arrived from — the JPS symmetry-breaking
    // rules say most directions are dominated by an alternate
    // path that skipped this node entirely, so we only need to
    // jump along the "natural" successor and any forced
    // successors created by nearby obstacles.
    let pdx = 0;
    let pdy = 0;
    if (parentIdx >= 0) {
      const pgx = parentIdx % gridW;
      const pgy = (parentIdx - pgx) / gridW;
      // Parent might be a JP many cells away, so direction is the
      // sign of the delta, not the delta itself.
      pdx = Math.sign(cgx - pgx);
      pdy = Math.sign(cgy - pgy);
    }

    const dirs = parentIdx < 0
      ? ALL_8_DIRS
      : prunedSuccessorDirs(cgx, cgy, pdx, pdy, isBlocked);

    for (let i = 0; i < dirs.length; i++) {
      const dx = dirs[i][0];
      const dy = dirs[i][1];
      if (!jump(cgx, cgy, dx, dy, goalCellGx, goalCellGy, gridW, gridH, isBlocked, jpResult)) continue;
      const jx = jpResult.gx;
      const jy = jpResult.gy;
      const jIdx = jy * gridW + jx;
      if (closed[jIdx]) continue;
      const stepCost = octile(cgx, cgy, jx, jy);
      const tentative = gScore[current] + stepCost;
      if (tentative < gScore[jIdx]) {
        parent[jIdx] = current;
        gScore[jIdx] = tentative;
        fScore[jIdx] = tentative + octile(jx, jy, goalCellGx, goalCellGy) * HEURISTIC_TIE_BREAK;
        heap.push(jIdx);
      }
    }
  }

  if (!foundGoal) {
    // No path under the budget — return the unit's own position
    // (stay-put). Rare in normal play with our caches and 30k
    // expansion budget; if it does fire, the goal really is
    // unreachable and beelining at it would cross water.
    _lastBailReason = 'no-path';
    return [{ x: startX, y: startY }];
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
  //
  // EXCEPT when the start was snapped: the unit's actual position
  // is inside an inflated/blocked cell (knocked there, spawned
  // there, etc.) and the first hasLineOfSight call would test
  // those blocked cells and immediately return false anyway. Worse,
  // the unit's first MOTION goes from `(startX, startY)` straight
  // to whatever first waypoint we emit — and that line can cross
  // water if the start is on the wrong side of an inflation halo
  // from the JPS path. Inserting the snap-target cell as the first
  // waypoint keeps that initial segment short and inside the snap
  // radius (which is by definition open ground), so the unit walks
  // to safe ground BEFORE following the JPS route.
  const smoothed: Vec2[] = [];
  let anchorX: number;
  let anchorY: number;
  const startWasSnapped = snappedStart.gx !== sgx || snappedStart.gy !== sgy;
  if (startWasSnapped) {
    const snapX = (snappedStart.gx + 0.5) * GRID_CELL_SIZE;
    const snapY = (snappedStart.gy + 0.5) * GRID_CELL_SIZE;
    smoothed.push({ x: snapX, y: snapY });
    anchorX = snapX;
    anchorY = snapY;
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
 *  for AI-driven units (the player-driven case was already wired).
 *
 *  `goalZ` is the altitude of the actual 3D ground point the player
 *  clicked (from CursorGround.pickSim). When provided AND the planner
 *  did NOT have to snap the goal to a different cell, it's used
 *  verbatim as the final waypoint's `z` — preserving the precise
 *  altitude the user saw under the cursor end-to-end. When the goal
 *  was snapped (click landed on water / building / peak), the click's
 *  altitude is no longer the right one for the waypoint marker; the
 *  snapped-cell terrain altitude is used instead. Intermediate
 *  waypoints (cells the JPS smoother kept) get terrain-sampled z so
 *  every waypoint has a meaningful altitude regardless of click
 *  origin. */
export function expandPathActions(
  startX: number, startY: number,
  goalX: number, goalY: number,
  type: ActionType,
  mapWidth: number, mapHeight: number,
  buildingGrid: BuildingGrid,
  goalZ?: number,
): UnitAction[] {
  const path = findPath(startX, startY, goalX, goalY, mapWidth, mapHeight, buildingGrid);
  // Diagnostic: when the planner falls through to the straight-line
  // fallback on a NON-trivial query (goal is far from start), it's
  // a strong signal that JPS hit the expansion cap or the snap
  // logic surfaced a same-cell degenerate. We log it so the user
  // can paste console output and we can pinpoint which case fired.
  // Only fires for real "go across the map" queries — short moves
  // that legitimately collapse to one waypoint stay quiet.
  if (path.length === 1 && _lastBailReason !== 'ok') {
    const dx = goalX - startX;
    const dy = goalY - startY;
    if (dx * dx + dy * dy > PATH_BAIL_LOG_DISTANCE_SQ) {
      // Log every bail (no sampling). With the new bail-policy the
      // unit stays put on bail, so a flood here means a real
      // pathfinding failure the user can act on. Trim back to
      // sampling once bail rates are low again.
      // eslint-disable-next-line no-console
      console.warn(
        '[Pathfinder] BAIL[%s]: start=(%d,%d) goal=(%d,%d) dist=%d',
        _lastBailReason,
        Math.round(startX), Math.round(startY),
        Math.round(goalX), Math.round(goalY),
        Math.round(Math.sqrt(dx * dx + dy * dy)),
      );
    }
  }
  // Annotate every waypoint with an altitude (`z`) and an
  // `isPathExpansion` flag.
  //   - Final waypoint: the user's click point. When the planner
  //     returned that click unchanged (path's last point is
  //     goalX/goalY exactly) AND the caller passed a click-derived
  //     `goalZ`, use the click's altitude. Not flagged as expansion.
  //   - Intermediate waypoints (everything else): cells that JPS /
  //     smoother inserted along the route. Z falls back to terrain
  //     sample, isPathExpansion=true so renderers can hide them in
  //     SIMPLE mode while still letting units physically follow them.
  const out: UnitAction[] = [];
  const lastIdx = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const px = path[i].x;
    const py = path[i].y;
    const isFinal = i === lastIdx;
    const isFinalUnsnapped = isFinal && goalZ !== undefined && px === goalX && py === goalY;
    const z = isFinalUnsnapped
      ? goalZ
      : getSurfaceHeight(px, py, mapWidth, mapHeight, GRID_CELL_SIZE);
    const action: UnitAction = { type, x: px, y: py, z };
    if (!isFinal) action.isPathExpansion = true;
    out.push(action);
  }
  return out;
}

/** Squared distance threshold above which a single-waypoint path
 *  result is logged as a bail. 200 wu = 10 cells; below this is a
 *  legitimately-short move (unit clicked just next to itself, or
 *  goal collapsed to start cell after snapping). */
const PATH_BAIL_LOG_DISTANCE_SQ = 200 * 200;

/** Why the most recent `findPath` query produced a single-waypoint
 *  fallback — set by `findPath` on every bail and read by
 *  `expandPathActions` to surface the reason in its diagnostic
 *  log. Module-level because findPath is sequential (not
 *  re-entrant) and a single shared slot is simpler than threading
 *  a reason through the return type. Possible values:
 *    'ok'         — non-fallback success.
 *    'start-snap' — start cell was blocked AND the spiral snap
 *                   couldn't find an open cell within
 *                   NEAREST_OPEN_RADIUS.
 *    'goal-snap'  — goal cell was blocked AND likewise.
 *    'same-cell'  — start and goal mapped to the same cell after
 *                   snapping — no path needed.
 *    'no-path'    — JPS-A* exhausted MAX_JP_EXPANSIONS without
 *                   reaching the goal, OR the open list ran out
 *                   (target unreachable). */
let _lastBailReason: 'ok' | 'start-snap' | 'goal-snap' | 'same-cell' | 'no-path' = 'ok';

function octile(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return Math.max(dx, dy) + SQRT2_MINUS_1 * Math.min(dx, dy);
}

// ── Jump Point Search internals ──────────────────────────────────
//
// Reference: Harabor & Grastien, "Online Graph Pruning for
// Pathfinding On Grid Maps" (AAAI 2011). Canonical corner-cutting
// formulation. Safety against units squeezing through obstacle
// corners is provided by C-space inflation in the outer
// `isBlocked` predicate, not by per-step corner-cut rejection in
// `jump` — see the file header for the justification.
//
// Two operations:
//
//   `prunedSuccessorDirs(cgx, cgy, pdx, pdy, isBlocked)` — given
//   the direction (pdx, pdy) the search reached (cgx, cgy) from,
//   returns the directions worth jumping in:
//
//     • The "natural" successor (continue straight in the parent
//       direction — and for diagonals, also the two cardinal
//       components of the parent direction).
//     • Any "forced" successor — a direction that's only worth
//       expanding because an obstacle adjacent to (cgx, cgy)
//       blocks an otherwise-symmetric alternative path.
//
//   `jump(startGx, startGy, dx, dy, ...)` — walks from the given
//   start in direction (dx, dy) until either:
//
//     • The current cell is blocked or out of bounds → no JP.
//     • The current cell is the goal → JP.
//     • The current cell has a forced neighbour in this direction
//       → JP (must stop here so the outer A* can later re-expand
//       and reach the forced cell).
//     • The diagonal cardinal-recursion finds a JP → JP at the
//       diagonal cell (so the outer A* can later expand in the
//       cardinal sub-direction that produced the hit).
//
//   Hit/miss is signalled via the boolean return; on hit, the JP's
//   (gx, gy) is written into the caller's reusable scratch struct
//   so the inner loop never allocates.

/** Module-level scratch struct used inside `jump`'s diagonal
 *  cardinal-recursion. Reused across every recursive call — JPS
 *  jumps are sequential (not concurrent) so a single shared buffer
 *  is safe. The outer caller passes its own `jpResult` for the
 *  top-level jump. */
const _jumpRecursionScratch = { gx: 0, gy: 0 };

/** Cell-visit budget for the current query. Decremented inside
 *  `jump`'s inner loop and reset to `MAX_JUMP_CELL_VISITS` at the
 *  top of `findPath`. When it hits 0 the next jump call returns
 *  false; the outer A* loop sees no successors, drains the heap,
 *  and bails with `no-path`. Module-level because the cap is
 *  shared across diagonal-step cardinal sub-recursions within a
 *  single query. */
let _jumpCellsRemaining = 0;

/** Module-level scratch list reused across `prunedSuccessorDirs`
 *  calls. JPS expansion is sequential, so one buffer is fine.
 *  Capped at 5 entries (max forced+natural directions for any
 *  parent direction); cleared via .length = 0 at the top of every
 *  call. */
const _prunedDirsScratch: Array<readonly [number, number]> = [];

function prunedSuccessorDirs(
  cgx: number, cgy: number,
  pdx: number, pdy: number,
  isBlocked: (gx: number, gy: number) => boolean,
): ReadonlyArray<readonly [number, number]> {
  const out = _prunedDirsScratch;
  out.length = 0;
  if (pdx !== 0 && pdy !== 0) {
    // Diagonal parent direction. Natural successors:
    //   (pdx, 0), (0, pdy), (pdx, pdy)
    out.push([pdx, 0]);
    out.push([0, pdy]);
    out.push([pdx, pdy]);
    // Forced diagonal successors (no-corner-cut variant): if a
    // back-side cardinal is blocked AND its diagonal continuation
    // is open, we have to expand into that diagonal because the
    // obstacle prevents the symmetric alternate path that would
    // have skipped (cgx, cgy) entirely.
    if (isBlocked(cgx - pdx, cgy) && !isBlocked(cgx - pdx, cgy + pdy)) {
      out.push([-pdx, pdy]);
    }
    if (isBlocked(cgx, cgy - pdy) && !isBlocked(cgx + pdx, cgy - pdy)) {
      out.push([pdx, -pdy]);
    }
  } else if (pdx !== 0) {
    // Horizontal parent direction (pdx ≠ 0, pdy = 0).
    // Natural successor: (pdx, 0).
    out.push([pdx, 0]);
    // Forced diagonal successors: if a perpendicular cell
    // is blocked AND the diagonal continuation past it is open,
    // expand into that diagonal.
    if (isBlocked(cgx, cgy + 1) && !isBlocked(cgx + pdx, cgy + 1)) {
      out.push([pdx, 1]);
    }
    if (isBlocked(cgx, cgy - 1) && !isBlocked(cgx + pdx, cgy - 1)) {
      out.push([pdx, -1]);
    }
  } else {
    // Vertical parent direction (pdx = 0, pdy ≠ 0).
    out.push([0, pdy]);
    if (isBlocked(cgx + 1, cgy) && !isBlocked(cgx + 1, cgy + pdy)) {
      out.push([1, pdy]);
    }
    if (isBlocked(cgx - 1, cgy) && !isBlocked(cgx - 1, cgy + pdy)) {
      out.push([-1, pdy]);
    }
  }
  return out;
}

/** Walk from (startGx, startGy) in direction (dx, dy) until finding
 *  a jump point (writes JP coords into `out` and returns true) or
 *  hitting an obstacle / map edge (returns false). The starting
 *  cell itself is NOT inspected — we step first.
 *
 *  Canonical corner-cutting JPS: a diagonal step is rejected only
 *  when the destination cell itself is blocked. Per-step corner-
 *  cut rejection is NOT performed here because the outer
 *  `isBlocked` predicate already includes C-space inflation
 *  (every cell within a 1-cell ring of a hard obstacle is also
 *  blocked), so any diagonal that would have skimmed an obstacle
 *  corner naturally lands in the inflation halo and is rejected.
 *
 *  Recursion (only for diagonal cardinal-recursion) is bounded by
 *  gridW + gridH (a single jump can't visit more cells than the
 *  grid's diagonal). The diagonal cardinal-recursion uses a
 *  module-level scratch to avoid per-level allocation. */
function jump(
  startGx: number, startGy: number,
  dx: number, dy: number,
  goalGx: number, goalGy: number,
  gridW: number, gridH: number,
  isBlocked: (gx: number, gy: number) => boolean,
  out: { gx: number; gy: number },
): boolean {
  let x = startGx;
  let y = startGy;
  // Iterative inner loop along the (dx, dy) ray; recursion only
  // happens for diagonal steps that need to check cardinal sub-jumps.
  for (;;) {
    x += dx;
    y += dy;
    // Per-query cell-visit budget. Returning false here makes the
    // outer A* think this direction has no JP; subsequent
    // expansions will keep draining the heap until empty, at
    // which point findPath bails with `no-path`. Prevents a single
    // query from visiting billions of cells via diagonal-step
    // cardinal recursion in open ground.
    if (--_jumpCellsRemaining <= 0) return false;

    // Bounds + occupancy. With C-space inflation baked into
    // `isBlocked`, this single check rejects both hard obstacles
    // and any cell within 1 cell of one — covering the corner-cut
    // case without needing a separate per-step check.
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return false;
    if (isBlocked(x, y)) return false;

    // Reached the goal cell — that's a JP by definition.
    if (x === goalGx && y === goalGy) {
      out.gx = x;
      out.gy = y;
      return true;
    }

    // Forced-neighbour check. The cardinal/diagonal rules below
    // describe when an obstacle adjacent to (x, y) creates a
    // neighbour that's only reachable along an optimal path
    // through (x, y) — meaning we can't keep jumping past it.
    if (dx !== 0 && dy !== 0) {
      // Diagonal step at (x, y), arrived from (x−dx, y−dy).
      // Forced if a "back-side" cardinal is blocked AND its
      // diagonal continuation is open.
      if (
        (isBlocked(x - dx, y) && !isBlocked(x - dx, y + dy)) ||
        (isBlocked(x, y - dy) && !isBlocked(x + dx, y - dy))
      ) {
        out.gx = x;
        out.gy = y;
        return true;
      }
      // Diagonal cardinal-recursion: from (x, y), jump in each
      // cardinal sub-direction. If either finds a JP, (x, y) itself
      // becomes a JP — the outer A* must expand from here so that
      // the cardinal sub-jumps' targets can be reached.
      if (jump(x, y, dx, 0, goalGx, goalGy, gridW, gridH, isBlocked, _jumpRecursionScratch)) {
        out.gx = x;
        out.gy = y;
        return true;
      }
      if (jump(x, y, 0, dy, goalGx, goalGy, gridW, gridH, isBlocked, _jumpRecursionScratch)) {
        out.gx = x;
        out.gy = y;
        return true;
      }
    } else if (dx !== 0) {
      // Horizontal step. Forced when the perpendicular neighbour is
      // blocked AND its forward continuation is open — the
      // diagonal (x + dx, y ± 1) becomes the only way to reach
      // those cells without backtracking.
      if (
        (isBlocked(x, y + 1) && !isBlocked(x + dx, y + 1)) ||
        (isBlocked(x, y - 1) && !isBlocked(x + dx, y - 1))
      ) {
        out.gx = x;
        out.gy = y;
        return true;
      }
    } else {
      // Vertical step (dy ≠ 0).
      if (
        (isBlocked(x + 1, y) && !isBlocked(x + 1, y + dy)) ||
        (isBlocked(x - 1, y) && !isBlocked(x - 1, y + dy))
      ) {
        out.gx = x;
        out.gy = y;
        return true;
      }
    }

    // No JP found at (x, y); continue jumping along (dx, dy).
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Walk the precomputed Euclidean-sorted offset list and return the
 *  first open cell relative to (gx, gy). True nearest-by-Euclidean
 *  semantics — no Chebyshev-ring direction bias. Bounded loop, no
 *  allocations besides the return object. */
function findNearestOpenCell(
  gx: number, gy: number,
  gridW: number, gridH: number,
  isBlocked: (gx: number, gy: number) => boolean,
): { gx: number; gy: number } | null {
  const offs = _snapOffsets;
  const n = offs.length;
  for (let i = 0; i < n; i += 2) {
    const nx = gx + offs[i];
    const ny = gy + offs[i + 1];
    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
    if (!isBlocked(nx, ny)) return { gx: nx, gy: ny };
  }
  return null;
}

/** Supercover (thick) Bresenham line-of-sight: returns true iff
 *  EVERY cell the line from (x0, y0) to (x1, y1) crosses is
 *  unblocked. Standard Bresenham steps diagonally past 4-cell
 *  intersections and only samples the cells on its primary track,
 *  so a smoothed line could "corner-cut" past a single inflated
 *  halo cell — visually shaving the corner of a water patch. The
 *  thick variant fixes that by also checking the two cardinal
 *  cells the line passes through whenever it takes a diagonal step
 *  (advances both x and y in the same iteration).
 *
 *  World coords in, cell sampling internal. Used by the post-process
 *  smoother in `findPath`. */
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
    const advX = e2 > -dy;
    const advY = e2 < dx;
    if (advX && advY) {
      // True diagonal step — line grazes the two cardinal cells
      // adjacent to the diagonal corner. Reject if either is
      // blocked, otherwise the line corner-cuts inflation.
      if (isBlocked(gx0 + sx, gy0)) return false;
      if (isBlocked(gx0, gy0 + sy)) return false;
    }
    if (advX) { err -= dy; gx0 += sx; }
    if (advY) { err += dx; gy0 += sy; }
  }
  return false;
}

/** Binary-heap min-priority queue keyed off a parallel fScore array.
 *  Push duplicates instead of decrease-key — when a duplicate is
 *  popped after the node is already closed, the caller skips it.
 *  Standard A* idiom and faster than maintaining heap-index back-
 *  pointers in JS.
 *
 *  Single instance reused across every findPath call: `reset` clears
 *  the array length without freeing the backing storage, and
 *  `setScores` swaps the fScore reference if needed (in practice
 *  it's the same reused `_scratchFScore` so the swap is a no-op,
 *  but the API is here for clarity). */
class MinHeap {
  private heap: number[] = [];
  private f: Float32Array | null = null;

  setScores(fScores: Float32Array): void {
    this.f = fScores;
  }

  reset(): void {
    this.heap.length = 0;
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
    const f = this.f!;
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
    const f = this.f!;
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

const _heap = new MinHeap();
