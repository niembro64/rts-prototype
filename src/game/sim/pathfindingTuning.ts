import rawPathfindingTuningConfig from './pathfindingTuningConfig.json';

type PathfindingTuningConfig = {
  forceSafetyRatio: number;
  arrivalRadius: number;
  intermediateCorridorWu: number;
  allowDiagonalNeighbors: boolean;
  softClearanceCells: number;
  softClearancePenaltyPerCell: number;
  aStarExpansionBudgetPerTeamTurn: number;
  refreshServiceIntervalTicks: number;
  chaseRepathCooldownTicks: number;
  chaseRepathDriftMinWu: number;
  chaseRepathDriftDistanceFraction: number;
  partialPlanRetryTicks: number;
  directPlanMaxDistanceWu: number;
  directPathMaxCostRatio: number;
  hierarchicalMinDistanceCells: number;
  hierarchicalClusterSizeCells: number;
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

/** Exact maximum number of navigation nodes the selected ally team may close
 *  during one round-robin turn. Unused work may serve another route for that
 *  team; one unfinished frontier is retained for its next turn. */
export const PATHFINDING_A_STAR_EXPANSIONS_PER_TEAM_TURN = requirePositiveInteger(
  'aStarExpansionBudgetPerTeamTurn',
  config.aStarExpansionBudgetPerTeamTurn,
);
/** A pending refresh lane gets first choice on this deterministic team-turn
 *  cadence; fresh jobs win other admissions. Free/stale requests never
 *  consume A* work, so admission can continue in the same tick. */
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
