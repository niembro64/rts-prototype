import rawPathfindingTuningConfig from './pathfindingTuningConfig.json';

type PathfindingTuningConfig = {
  waterBufferCells: number;
  forceSafetyRatio: number;
  stabilityMaxSlopeDeg: number;
  arrivalRadius: number;
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

function readStabilityMaxSlopeDeg(): number {
  const value = requireFinite('stabilityMaxSlopeDeg', config.stabilityMaxSlopeDeg);
  if (value <= 0 || value >= 90) {
    throw new Error(
      `Invalid pathfinding tuning stabilityMaxSlopeDeg: expected degrees in (0, 90), got ${value}`,
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

export const PATHFINDING_WATER_BUFFER_CELLS = readWaterBufferCells();
/** Arrival tolerance in world units (distance at which a unit ticks a waypoint
 *  as reached). Owned here so the WASM pathfinder's clearance margin and the
 *  arrival controller cannot drift apart. */
export const PATHFINDING_ARRIVAL_RADIUS = readArrivalRadius();
export const PATHFINDING_FORCE_SAFETY_RATIO = readForceSafetyRatio();
export const PATHFINDING_STABILITY_MAX_SLOPE_DEG = readStabilityMaxSlopeDeg();
export const PATHFINDING_STABILITY_MIN_NORMAL_Z = Math.cos(
  PATHFINDING_STABILITY_MAX_SLOPE_DEG * Math.PI / 180,
);
