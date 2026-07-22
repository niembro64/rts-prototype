import rawPathfindingTuningConfig from './pathfindingTuningConfig.json';

type PathfindingTuningConfig = {
  waterBufferCells: number;
  forceSafetyRatio: number;
  arrivalRadius: number;
  allowDiagonalNeighbors: boolean;
  softClearanceCells: number;
  softClearancePenaltyPerCell: number;
};

const config = rawPathfindingTuningConfig as PathfindingTuningConfig;

function requireFinite(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid pathfinding tuning ${label}: expected finite number, got ${value}`);
  }
  return value;
}

function readWaterBufferCells(): number {
  const value = requireFinite('waterBufferCells', config.waterBufferCells);
  if (value < 0 || Math.floor(value) !== value) {
    throw new Error(
      `Invalid pathfinding tuning waterBufferCells: expected non-negative integer, got ${value}`,
    );
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

export const PATHFINDING_WATER_BUFFER_CELLS = readWaterBufferCells();
/** Arrival tolerance in world units (distance at which a unit ticks a waypoint
 *  as reached). This is controller behavior and is deliberately not folded
 *  into the unit's hard pathfinding collision clearance. */
export const PATHFINDING_ARRIVAL_RADIUS = readArrivalRadius();
export const PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS = readAllowDiagonalNeighbors();
export const PATHFINDING_SOFT_CLEARANCE_CELLS = readSoftClearanceCells();
export const PATHFINDING_SOFT_CLEARANCE_PENALTY_PER_CELL = readSoftClearancePenaltyPerCell();
export const PATHFINDING_FORCE_SAFETY_RATIO = readForceSafetyRatio();
