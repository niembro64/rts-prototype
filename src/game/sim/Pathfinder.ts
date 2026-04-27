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
import { isWaterAt, getSurfaceNormal, getSurfaceHeight } from './Terrain';
import type { ActionType, UnitAction } from './types';

type Vec2 = { x: number; y: number };

const SQRT2 = Math.SQRT2;
const SQRT2_MINUS_1 = SQRT2 - 1;

/** Tie-break multiplier on the heuristic. Slightly > 1 prefers
 *  paths closer to the goal among nodes with equal f, dramatically
 *  reducing exploration in open terrain. Still admissible enough for
 *  RTS purposes. */
const HEURISTIC_TIE_BREAK = 1.001;

/** Hard cap on jump-point expansions per query. JPS expansions are
 *  rarer than vanilla A* expansions — each pop from the heap may
 *  walk hundreds of grid cells in a single jump — but on a demo
 *  map with high obstacle-edge density (e.g. 5 radial LAKE
 *  dividers + LAKE centre + multiple buildings) every water-
 *  adjacent cell becomes a potential JP, and a cross-map query
 *  can push an order of magnitude more JPs than the JP-count of
 *  the actual optimal path. 30000 ≈ 30% of the largest current
 *  grid (308×308 = ~95k cells) and is generous enough to cover
 *  any legitimately-reachable target on terrain we ship; the
 *  cap exists strictly to bail on truly unreachable goals
 *  (target inside a sealed-off pocket) rather than throttling
 *  complex-but-reachable searches. */
const MAX_JP_EXPANSIONS = 30000;

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

/** When the start or goal cell is blocked, scan outward this many
 *  cells in a Chebyshev-distance spiral looking for the nearest
 *  open cell to use as a substitute. 32 cells = 640 wu — covers
 *  the demo map's full central-water diameter under a default
 *  LAKE configuration. The factory fight-target geometry
 *  (`factoryFightDistance = 1.22`, with factories at radial
 *  ~2800 wu) puts the *intended* goal ~617 wu past centre on the
 *  opposite side, i.e. inside the central water region. With
 *  this radius the snap can always reach a valid shore cell on
 *  the goal's side; the unit walks the path and stops at that
 *  shore. Smaller radii surfaced as "factory units walk straight
 *  into water" because the snap returned null and findPath fell
 *  through to a single straight-line waypoint. */
const NEAREST_OPEN_RADIUS = 32;

/** All 8 neighbour direction deltas — used at the START node where
 *  no parent direction is defined. Cardinals first, diagonals after. */
const ALL_8_DIRS: ReadonlyArray<readonly [number, number]> = [
  [ 1, 0], [-1, 0], [ 0, 1], [ 0,-1],
  [ 1, 1], [ 1,-1], [-1, 1], [-1,-1],
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
  _lastBailReason = 'ok';
  let snappedStart = { gx: sgx, gy: sgy };
  if (isBlocked(sgx, sgy)) {
    const open = findNearestOpenCell(sgx, sgy, gridW, gridH, isBlocked);
    if (!open) {
      _lastBailReason = 'start-snap';
      return [{ x: goalX, y: goalY }];
    }
    snappedStart = open;
  }
  let snappedGoal = { gx: ggx, gy: ggy };
  let goalWasSnapped = false;
  if (isBlocked(ggx, ggy)) {
    const open = findNearestOpenCell(ggx, ggy, gridW, gridH, isBlocked);
    if (!open) {
      _lastBailReason = 'goal-snap';
      return [{ x: goalX, y: goalY }];
    }
    snappedGoal = open;
    goalWasSnapped = true;
  }
  const startCellGx = snappedStart.gx;
  const startCellGy = snappedStart.gy;
  const goalCellGx = snappedGoal.gx;
  const goalCellGy = snappedGoal.gy;

  // Same-cell after snapping → no planning needed.
  if (startCellGx === goalCellGx && startCellGy === goalCellGy) {
    _lastBailReason = 'same-cell';
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
    // No path under the budget — let the caller's straight-line
    // intent stand. Rare in normal play; the budget is generous.
    _lastBailReason = 'no-path';
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
  if (path.length === 1) {
    const dx = goalX - startX;
    const dy = goalY - startY;
    // Sample-rate the diagnostic so a chokepoint pile-up doesn't
    // flood the console with hundreds of identical bail lines per
    // second. 2% sampling still surfaces a representative trickle
    // of every distinct failure mode without becoming spam.
    if (
      dx * dx + dy * dy > PATH_BAIL_LOG_DISTANCE_SQ
      && Math.random() < 0.02
    ) {
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
  // Annotate every waypoint with an altitude (`z`).
  //   - Final waypoint: when the planner returned the user's click
  //     unchanged (path's last point is goalX/goalY exactly) AND the
  //     caller passed a click-derived `goalZ`, prefer the click's
  //     altitude — preserves "the cursor was there, the dot is there"
  //     end-to-end.
  //   - All other waypoints (intermediates from JPS / smoother, or a
  //     final waypoint that was snapped to a reachable cell): sample
  //     the terrain so the z reflects the actual ground at that XY.
  // Without this, downstream renderers would have to re-sample the
  // terrain to visualize each waypoint, which is exactly what we're
  // trying to avoid (the click altitude can differ from the terrain
  // sample, e.g. when CursorGround's submerged-hit fallback projected
  // to y=0 on a lake-shore click).
  const out: UnitAction[] = [];
  const lastIdx = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const px = path[i].x;
    const py = path[i].y;
    const isFinalUnsnapped =
      i === lastIdx && goalZ !== undefined && px === goalX && py === goalY;
    const z = isFinalUnsnapped
      ? goalZ
      : getSurfaceHeight(px, py, mapWidth, mapHeight, GRID_CELL_SIZE);
    out.push({ type, x: px, y: py, z });
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
