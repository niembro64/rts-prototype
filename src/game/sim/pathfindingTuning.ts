import rawPathfindingTuningConfig from './pathfindingTuningConfig.json';

type PathfindingTuningConfig = {
  forceSafetyRatio: number;
  arrivalRadius: number;
  allowDiagonalNeighbors: boolean;
  softClearanceCells: number;
  softClearancePenaltyPerCell: number;
  planBudgetPerPlayerPerTick: number;
  planBudgetGlobalPerTick: number;
  chaseRepathCooldownTicks: number;
  chaseRepathDriftMinWu: number;
  chaseRepathDriftDistanceFraction: number;
  partialPlanRetryTicks: number;
  directPlanMaxDistanceWu: number;
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

function readSoftClearanceCells(): number {
  const value = requireFinite('softClearanceCells', config.softClearanceCells);
  if (value < 0 || Math.floor(value) !== value) {
    throw new Error(
      `Invalid pathfinding tuning softClearanceCells: expected non-negative integer, got ${value}`,
    );
  }
  return value;
}

function readSoftClearancePenaltyPerCell(): number {
  const value = requireFinite(
    'softClearancePenaltyPerCell',
    config.softClearancePenaltyPerCell,
  );
  if (value < 0) {
    throw new Error(
      `Invalid pathfinding tuning softClearancePenaltyPerCell: expected non-negative number, got ${value}`,
    );
  }
  return value;
}

function readAllowDiagonalNeighbors(): boolean {
  if (typeof config.allowDiagonalNeighbors !== 'boolean') {
    throw new Error(
      `Invalid pathfinding tuning allowDiagonalNeighbors: expected boolean, got ${String(config.allowDiagonalNeighbors)}`,
    );
  }
  return config.allowDiagonalNeighbors;
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
export const PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS = readAllowDiagonalNeighbors();
export const PATHFINDING_SOFT_CLEARANCE_CELLS = readSoftClearanceCells();
export const PATHFINDING_SOFT_CLEARANCE_PENALTY_PER_CELL = readSoftClearancePenaltyPerCell();
export const PATHFINDING_FORCE_SAFETY_RATIO = readForceSafetyRatio();

// ── Plan scheduler (per-tick A* budget + request queue) ─────────────
//
// All of these are lockstep gameplay constants: every peer must fund the
// identical plan computations on the identical ticks, so none of them may
// ever be derived from measured frame time.

/** Max full plan computations (A* runs) funded per player per fixed tick,
 *  shared between synchronous dispatch-time planning and queued serves. */
export const PATHFINDING_PLAN_BUDGET_PER_PLAYER_PER_TICK = requirePositiveInteger(
  'planBudgetPerPlayerPerTick',
  config.planBudgetPerPlayerPerTick,
);
/** Global per-tick ceiling across all players so many-player matches cannot
 *  multiply the per-player budget past the tick's compute envelope. */
export const PATHFINDING_PLAN_BUDGET_GLOBAL_PER_TICK = requirePositiveInteger(
  'planBudgetGlobalPerTick',
  config.planBudgetGlobalPerTick,
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
/** Retry cadence (ticks) for plans that resolved PARTIAL — the blocked
 *  world may have opened up (pile-up cleared, node budget exhausted). */
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
