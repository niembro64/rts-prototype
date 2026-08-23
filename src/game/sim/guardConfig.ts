import rawGuardConfig from './guardConfig.json';

type GuardConfig = {
  recoilSimulationFramesPerSecond: number;
  retaliationMemoryFrames: number;
  recalculateDistanceWu: number;
  stoppedProximityGoalWu: number;
  stoppedExtraDistanceWu: number;
  movingProximityGoalWu: number;
  movingIntervalSeconds: number;
  interceptionLimitFrames: number;
  stoppedSpeedWuPerSecond: number;
};

const config = rawGuardConfig as GuardConfig;

function positive(label: keyof GuardConfig): number {
  const value = config[label];
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid Guard tuning ${label}: expected a finite positive number, got ${value}`);
  }
  return value;
}

/** Recoil/BAR authors retaliation in 30 Hz simulation frames. */
export const GUARD_RECOIL_SIMULATION_FRAMES_PER_SECOND = positive(
  'recoilSimulationFramesPerSecond',
);
export const GUARD_RETALIATION_MEMORY_SECONDS =
  positive('retaliationMemoryFrames') / GUARD_RECOIL_SIMULATION_FRAMES_PER_SECOND;
export const GUARD_RECALCULATE_DISTANCE_WU = positive('recalculateDistanceWu');
export const GUARD_STOPPED_PROXIMITY_GOAL_WU = positive('stoppedProximityGoalWu');
export const GUARD_STOPPED_EXTRA_DISTANCE_WU = positive('stoppedExtraDistanceWu');
export const GUARD_MOVING_PROXIMITY_GOAL_WU = positive('movingProximityGoalWu');
export const GUARD_MOVING_INTERVAL_SECONDS = positive('movingIntervalSeconds');
export const GUARD_INTERCEPTION_LIMIT_SECONDS =
  positive('interceptionLimitFrames') / GUARD_RECOIL_SIMULATION_FRAMES_PER_SECOND;
export const GUARD_STOPPED_SPEED_WU_PER_SECOND = positive('stoppedSpeedWuPerSecond');
