import { ARCHITECTURE_CONFIG } from '@/architectureConfig';

export type LockstepPerformanceBudget = {
  readonly measurementModel: 'local-server-sim-per-browser';
  readonly minimumSupportedDeviceClass: string;
  readonly slowClientPolicy: 'stall-and-resync-lockstep-frames';
  readonly fixedSimulationHz: number;
};

export const LOCKSTEP_PERFORMANCE_BUDGET: LockstepPerformanceBudget = {
  measurementModel: 'local-server-sim-per-browser',
  minimumSupportedDeviceClass:
    `desktop/laptop browser that can run the full local server simulation at ${ARCHITECTURE_CONFIG.lockstep.fixedStepHz} Hz`,
  slowClientPolicy: 'stall-and-resync-lockstep-frames',
  fixedSimulationHz: ARCHITECTURE_CONFIG.lockstep.fixedStepHz,
};

export type LockstepSnapshotPerformanceLaneTelemetry = {
  readonly snapshotMsAvg: number;
  readonly snapshotMsHi: number;
  readonly snapshotsEmitted: number;
};

export type LockstepSnapshotPerformanceTelemetry = LockstepSnapshotPerformanceLaneTelemetry & {
  readonly rich: LockstepSnapshotPerformanceLaneTelemetry;
  readonly delta: LockstepSnapshotPerformanceLaneTelemetry;
};
