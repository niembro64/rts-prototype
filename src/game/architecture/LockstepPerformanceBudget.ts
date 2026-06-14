export type LockstepPerformanceBudget = {
  readonly measurementModel: 'local-server-sim-per-browser';
  readonly minimumSupportedDeviceClass: string;
  readonly slowClientPolicy: 'stall-or-use-authoritative-server';
  readonly fixedSimulationHz: 60;
};

export const LOCKSTEP_PERFORMANCE_BUDGET: LockstepPerformanceBudget = {
  measurementModel: 'local-server-sim-per-browser',
  minimumSupportedDeviceClass:
    'desktop/laptop browser that can run the full local server simulation at 60 Hz',
  slowClientPolicy: 'stall-or-use-authoritative-server',
  fixedSimulationHz: 60,
};

export type LockstepSnapshotPerformanceTelemetry = {
  readonly snapshotMsAvg: number;
  readonly snapshotMsHi: number;
  readonly snapshotsEmitted: number;
};
