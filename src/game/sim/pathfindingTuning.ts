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
  directPathMaxCostRatio: number;
  hierarchicalClusterSizeCells: number;
  corridorHeuristicWeight: number;
  trafficHeatPenalty: number;
  trafficHeatDecayTicks: number;
  pathFailureBackoffTicks: number;
  pathFailureBackoffMaxTicks: number;
  pathFailureGiveUpCount: number;
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

/** Exact maximum number of fine navigation nodes closed in one fixed tick —
 *  the global ceiling. Sides with demand are admitted round-robin under it:
 *  a served side resumes its retained frontier, may spend leftover on more of
 *  its own routes, and hands any remainder to the next side with demand in
 *  the same tick. One unfinished frontier per side is retained for that
 *  side's next turn. */
export const PATHFINDING_A_STAR_EXPANSIONS_PER_TICK = requirePositiveInteger(
  'aStarExpansionBudgetPerTick',
  config.aStarExpansionBudgetPerTick,
);
/** A pending refresh lane gets first choice every N served turns of a side
 *  (a side's served-turn counter, not a tick count); fresh jobs win other
 *  admissions. Free/stale requests never consume A* work, so admission can
 *  continue in the same tick. */
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
 *  keeps expansions low on sloped/heated terrain. */
export const PATHFINDING_CORRIDOR_HEURISTIC_WEIGHT = requireNonNegativeNumber(
  'corridorHeuristicWeight',
  config.corridorHeuristicWeight,
);
/** Cost multiplier ceiling for a fully heated cell (WASM consumer). */
export const PATHFINDING_TRAFFIC_HEAT_PENALTY = requireNonNegativeNumber(
  'trafficHeatPenalty',
  config.trafficHeatPenalty,
);
/** Fixed-tick cadence at which the traffic-heat layer decays by a quarter. */
export const PATHFINDING_TRAFFIC_HEAT_DECAY_TICKS = requirePositiveInteger(
  'trafficHeatDecayTicks',
  config.trafficHeatDecayTicks,
);
/** First retry delay after a route request resolves unreachable/terminal;
 *  doubles per consecutive failure up to the max, then the order is dropped
 *  after the give-up count (BAR: a unit that cannot get there stops). */
export const PATHFINDING_PATH_FAILURE_BACKOFF_TICKS = requirePositiveInteger(
  'pathFailureBackoffTicks',
  config.pathFailureBackoffTicks,
);
export const PATHFINDING_PATH_FAILURE_BACKOFF_MAX_TICKS = requirePositiveInteger(
  'pathFailureBackoffMaxTicks',
  config.pathFailureBackoffMaxTicks,
);
export const PATHFINDING_PATH_FAILURE_GIVE_UP_COUNT = requirePositiveInteger(
  'pathFailureGiveUpCount',
  config.pathFailureGiveUpCount,
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
