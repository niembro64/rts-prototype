import rawPathfindingTuningConfig from './pathfindingTuningConfig.json';

type PathfindingTuningConfig = {
  forceSafetyRatio: number;
  arrivalRadius: number;
  intermediateCorridorWu: number;
  allowDiagonalNeighbors: boolean;
  softClearanceCells: number;
  softClearancePenaltyPerCell: number;
  aStarExpansionBudgetPerTick: number;
  refreshServiceIntervalTicks: number;
  chaseRepathCooldownTicks: number;
  chaseRepathDriftMinWu: number;
  chaseRepathDriftDistanceFraction: number;
  partialPlanRetryTicks: number;
  directPlanMaxDistanceWu: number;
  lineClearanceMarginWu: number;
  directPathMaxCostRatio: number;
  hierarchicalClusterSizeCells: number;
  corridorHeuristicWeight: number;
  trafficHeatPenalty: number;
  trafficHeatDecayTicks: number;
  pathPlanQuantumWorkUnits: number;
  firstLegMaxDistanceWu: number;
  firstLegMinDistanceWu: number;
  pathFailureBackoffTicks: number;
  pathFailureBackoffMaxTicks: number;
  avoidanceLookaheadWu: number;
  avoidanceLateralMarginWu: number;
  avoidanceStrength: number;
};

const config = rawPathfindingTuningConfig as PathfindingTuningConfig;

function requireFinite(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid pathfinding tuning ${label}: expected finite number, got ${value}`);
  }
  return value;
}

function readForceSafetyRatio(): number {
  const value = requireFinite('forceSafetyRatio', config.forceSafetyRatio);
  if (value <= 0 || value > 1) {
    throw new Error(
      `Invalid pathfinding tuning forceSafetyRatio: expected ratio in (0, 1], got ${value}`,
    );
  }
  return value;
}

function readArrivalRadius(): number {
  const value = requireFinite('arrivalRadius', config.arrivalRadius);
  if (value < 0) {
    throw new Error(
      `Invalid pathfinding tuning arrivalRadius: expected non-negative number, got ${value}`,
    );
  }
  return value;
}

function requirePositiveInteger(label: string, value: number): number {
  requireFinite(label, value);
  if (value < 1 || Math.floor(value) !== value) {
    throw new Error(
      `Invalid pathfinding tuning ${label}: expected positive integer, got ${value}`,
    );
  }
  return value;
}

function requireNonNegativeInteger(label: string, value: number): number {
  requireFinite(label, value);
  if (value < 0 || Math.floor(value) !== value) {
    throw new Error(
      `Invalid pathfinding tuning ${label}: expected non-negative integer, got ${value}`,
    );
  }
  return value;
}

function requireNonNegativeNumber(label: string, value: number): number {
  requireFinite(label, value);
  if (value < 0) {
    throw new Error(
      `Invalid pathfinding tuning ${label}: expected non-negative number, got ${value}`,
    );
  }
  return value;
}

function requireUnitIntervalRatio(label: string, value: number): number {
  requireFinite(label, value);
  if (value < 0 || value > 1) {
    throw new Error(
      `Invalid pathfinding tuning ${label}: expected ratio in [0, 1], got ${value}`,
    );
  }
  return value;
}

/** Arrival tolerance in world units (distance at which a unit ticks a waypoint
 *  as reached). This is controller behavior and is deliberately not folded
 *  into the unit's hard pathfinding collision clearance. */
export const PATHFINDING_ARRIVAL_RADIUS = readArrivalRadius();
/** Half-width (world units) of the corridor around a path leg inside which
 *  crossing an intermediate waypoint's perpendicular plane counts as passing
 *  the corner. Keeps corner capture tolerant of speed without letting a
 *  far-off-course unit skip waypoints. */
export const PATHFINDING_INTERMEDIATE_CORRIDOR_WU = requireNonNegativeNumber(
  'intermediateCorridorWu',
  config.intermediateCorridorWu,
);
export const PATHFINDING_FORCE_SAFETY_RATIO = readForceSafetyRatio();

// ── Plan scheduler (per-tick A* budget + request queue) ─────────────
//
// All of these are lockstep gameplay constants: every peer must fund the
// identical plan computations on the identical ticks, so none of them may
// ever be derived from measured frame time.

/** Exact maximum amount of pathfinding work funded in one fixed tick — the
 *  global ceiling. Players with demand are visited round-robin under it,
 *  each queue receiving one quantum per visit; a player that runs dry hands
 *  its leftover to the next player with demand in the same tick, and a
 *  player whose refine search outlives its quantum keeps the frontier in its
 *  own WASM arena for its next visit. */
export const PATHFINDING_A_STAR_EXPANSIONS_PER_TICK = requirePositiveInteger(
  'aStarExpansionBudgetPerTick',
  config.aStarExpansionBudgetPerTick,
);
/** Work one queue (a player's route queue or refine queue) may spend per
 *  visit before the cursor moves on. Smaller = fairer under contention,
 *  larger = fewer arena swaps; both are lockstep constants. */
export const PATHFINDING_PLAN_QUANTUM_WORK_UNITS = requirePositiveInteger(
  'pathPlanQuantumWorkUnits',
  config.pathPlanQuantumWorkUnits,
);
/** Longest validated straight first leg a planless unit drives toward a far
 *  goal while its full route is still queued, and the shortest leg worth
 *  installing (below it the unit holds for the refinement instead). */
export const PATHFINDING_FIRST_LEG_MAX_DISTANCE_WU = requireNonNegativeNumber(
  'firstLegMaxDistanceWu',
  config.firstLegMaxDistanceWu,
);
export const PATHFINDING_FIRST_LEG_MIN_DISTANCE_WU = requireNonNegativeNumber(
  'firstLegMinDistanceWu',
  config.firstLegMinDistanceWu,
);
/** A pending refresh lane gets first choice every N refine visits of a
 *  player (that player's served-turn counter, not a tick count); refine jobs
 *  win other admissions. Free/stale requests never consume A* work, so
 *  admission can continue in the same tick. */
export const PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS = requirePositiveInteger(
  'refreshServiceIntervalTicks',
  config.refreshServiceIntervalTicks,
);
/** Minimum plan age (ticks) before a chase (attack/guard) may repath. */
export const PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS = requireNonNegativeInteger(
  'chaseRepathCooldownTicks',
  config.chaseRepathCooldownTicks,
);
/** Minimum 2D drift (world units) between a chase plan's stamped goal and
 *  the live approach point before the route is considered stale. */
export const PATHFINDING_CHASE_REPATH_DRIFT_MIN_WU = requireNonNegativeNumber(
  'chaseRepathDriftMinWu',
  config.chaseRepathDriftMinWu,
);
/** Distance-proportional drift tolerance: far-away targets must move a
 *  larger fraction of the remaining distance before a repath is worth it. */
export const PATHFINDING_CHASE_REPATH_DRIFT_DISTANCE_FRACTION = requireUnitIntervalRatio(
  'chaseRepathDriftDistanceFraction',
  config.chaseRepathDriftDistanceFraction,
);
/** Retry cadence (ticks) for plans that resolved PARTIAL at the best reachable
 *  frontier — a changed dynamic obstacle layer may later open the goal. */
export const PATHFINDING_PARTIAL_PLAN_RETRY_TICKS = requireNonNegativeInteger(
  'partialPlanRetryTicks',
  config.partialPlanRetryTicks,
);
/** Goals within this 2D distance first try a single validated straight
 *  segment as the whole plan, skipping A* (and the plan budget) entirely. */
/** Extra clearance (world units) a straight segment must keep beyond the
 *  body radius — string-pull shortcuts, direct plans, the follower's corner
 *  shortcut and polyline validation all walk cells at this margin, while
 *  the cell-to-cell A* step keeps the exact body gate. Consumed by the Rust
 *  build (build.rs); validated here so a bad config value still fails fast
 *  from TS. */
requireNonNegativeNumber('lineClearanceMarginWu', config.lineClearanceMarginWu);

export const PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU = requireNonNegativeNumber(
  'directPlanMaxDistanceWu',
  config.directPlanMaxDistanceWu,
);
/** Fine navigation cells per side of one level-1 hierarchy cluster. */
export const PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS = requirePositiveInteger(
  'hierarchicalClusterSizeCells',
  config.hierarchicalClusterSizeCells,
);
/** Weighted-A* factor for the corridor refinement (WASM consumer): the
 *  hierarchy fixes the route's shape, so a bounded-suboptimal refinement
 *  keeps expansions low on sloped/heated terrain. Validated for build.rs. */
requireNonNegativeNumber('corridorHeuristicWeight', config.corridorHeuristicWeight);
/** Cost multiplier ceiling for a fully heated cell (WASM consumer);
 *  validated for build.rs. */
requireNonNegativeNumber('trafficHeatPenalty', config.trafficHeatPenalty);
/** Fixed-tick cadence at which the traffic-heat layer decays by a quarter. */
export const PATHFINDING_TRAFFIC_HEAT_DECAY_TICKS = requirePositiveInteger(
  'trafficHeatDecayTicks',
  config.trafficHeatDecayTicks,
);
/** First retry delay after a route request resolves unreachable/terminal;
 *  doubles per consecutive failure up to the max. The order is never
 *  dropped: the backoff is lifted the moment the unit's cell, the terrain
 *  version or the building layer changes, since only those can change the
 *  answer (the six-strike give-up was deleted 2026-08-26). */
export const PATHFINDING_PATH_FAILURE_BACKOFF_TICKS = requirePositiveInteger(
  'pathFailureBackoffTicks',
  config.pathFailureBackoffTicks,
);
export const PATHFINDING_PATH_FAILURE_BACKOFF_MAX_TICKS = requirePositiveInteger(
  'pathFailureBackoffMaxTicks',
  config.pathFailureBackoffMaxTicks,
);

/** Local avoidance: how far ahead (plus both radii) a ground mover looks for
 *  bodies in its lane, the extra lateral clearance it wants past touching,
 *  and the maximum sideways drive fraction it will apply. */
export const PATHFINDING_AVOIDANCE_LOOKAHEAD_WU = requireNonNegativeNumber(
  'avoidanceLookaheadWu',
  config.avoidanceLookaheadWu,
);
export const PATHFINDING_AVOIDANCE_LATERAL_MARGIN_WU = requireNonNegativeNumber(
  'avoidanceLateralMarginWu',
  config.avoidanceLateralMarginWu,
);
export const PATHFINDING_AVOIDANCE_STRENGTH = requireUnitIntervalRatio(
  'avoidanceStrength',
  config.avoidanceStrength,
);
