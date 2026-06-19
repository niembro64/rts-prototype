import { GAME_DIAGNOSTICS } from '../diagnostics';
import {
  createRunningStats,
  formatRunningAverage,
  formatRunningMax,
  type RunningStats,
} from '../diagnosticStats';
import { getClientPredictionTargetPoolStats } from './ClientPredictionTargets';
import { getClientUnitPredictionPoolStats } from './ClientUnitPrediction';

export type ClientPredictionTargetAgeStats = {
  activeTargets: number;
  totalTargetAgeMs: number;
  maxTargetAgeMs: number;
};

export type ClientPredictionCorrectionStats = {
  count: number;
  totalDistance: number;
  maxDistance: number;
  velocityCount: number;
  totalVelocityDelta: number;
  maxVelocityDelta: number;
  targetAgeCount: number;
  totalTargetAgeMs: number;
  maxTargetAgeMs: number;
};

type ClientPredictionDiagnosticsReport = {
  frames: number;
  snapshotApplies: number;
  corrections: number;
  predictionMsAvg: number | string;
  predictionMsMax: number | string;
  targetAgeAvgMs: number | string;
  targetAgeMaxMs: number | string;
  targetAgeSamples: number;
  correctionDistanceAvg: number | string;
  correctionDistanceMax: number | string;
  correctionVelocityAvg: number | string;
  correctionVelocityMax: number | string;
  correctionVelocitySamples: number;
  correctionTargetAgeAvgMs: number | string;
  correctionTargetAgeMaxMs: number | string;
  correctionTargetAgeSamples: number;
  retainedPools: {
    unitMotionCapacity: number;
    unitOrientationCapacity: number;
    beamPointFreeList: number;
  };
};

type ClientPredictionDiagnosticsDebugApi = {
  reset(): void;
  stats(): ClientPredictionDiagnosticsReport;
};

type DiagnosticsStats = {
  predictionMs: RunningStats;
  targetAgeMs: RunningStats;
  correctionDistance: RunningStats;
  correctionVelocity: RunningStats;
  correctionTargetAgeMs: RunningStats;
};

declare global {
  interface Window {
    __BA_DP03_CLIENT_PREDICTION__: ClientPredictionDiagnosticsDebugApi | undefined;
  }
}

function addAggregateStat(
  stats: RunningStats,
  count: number,
  total: number,
  max: number,
): void {
  if (count <= 0 || !Number.isFinite(total) || !Number.isFinite(max)) return;
  stats.count += count;
  stats.total += total;
  if (max > stats.max) stats.max = max;
}

function addSingleStat(stats: RunningStats, value: number): void {
  if (!Number.isFinite(value)) return;
  stats.count++;
  stats.total += value;
  if (value > stats.max) stats.max = value;
}

class ClientPredictionDiagnostics {
  readonly enabled = GAME_DIAGNOSTICS.clientPredictionDiagnostics;

  private frames = 0;
  private snapshotApplies = 0;
  private corrections = 0;
  private readonly stats: DiagnosticsStats = {
    predictionMs: createRunningStats(),
    targetAgeMs: createRunningStats(),
    correctionDistance: createRunningStats(),
    correctionVelocity: createRunningStats(),
    correctionTargetAgeMs: createRunningStats(),
  };

  recordFrame(sample: {
    predictionMs: number;
    targetAge: ClientPredictionTargetAgeStats;
  }): void {
    if (!this.enabled) return;
    this.frames++;
    addSingleStat(this.stats.predictionMs, sample.predictionMs);
    addAggregateStat(
      this.stats.targetAgeMs,
      sample.targetAge.activeTargets,
      sample.targetAge.totalTargetAgeMs,
      sample.targetAge.maxTargetAgeMs,
    );
  }

  recordSnapshotApply(correction: ClientPredictionCorrectionStats): void {
    if (!this.enabled) return;
    this.snapshotApplies++;
    this.corrections += correction.count;
    addAggregateStat(
      this.stats.correctionDistance,
      correction.count,
      correction.totalDistance,
      correction.maxDistance,
    );
    addAggregateStat(
      this.stats.correctionVelocity,
      correction.velocityCount,
      correction.totalVelocityDelta,
      correction.maxVelocityDelta,
    );
    addAggregateStat(
      this.stats.correctionTargetAgeMs,
      correction.targetAgeCount,
      correction.totalTargetAgeMs,
      correction.maxTargetAgeMs,
    );
  }

  reset(): void {
    this.frames = 0;
    this.snapshotApplies = 0;
    this.corrections = 0;
    this.stats.predictionMs = createRunningStats();
    this.stats.targetAgeMs = createRunningStats();
    this.stats.correctionDistance = createRunningStats();
    this.stats.correctionVelocity = createRunningStats();
    this.stats.correctionTargetAgeMs = createRunningStats();
  }

  report(): ClientPredictionDiagnosticsReport {
    const unitPools = getClientUnitPredictionPoolStats();
    const targetPools = getClientPredictionTargetPoolStats();
    return {
      frames: this.frames,
      snapshotApplies: this.snapshotApplies,
      corrections: this.corrections,
      predictionMsAvg: formatRunningAverage(this.stats.predictionMs),
      predictionMsMax: formatRunningMax(this.stats.predictionMs),
      targetAgeAvgMs: formatRunningAverage(this.stats.targetAgeMs),
      targetAgeMaxMs: formatRunningMax(this.stats.targetAgeMs),
      targetAgeSamples: this.stats.targetAgeMs.count,
      correctionDistanceAvg: formatRunningAverage(this.stats.correctionDistance),
      correctionDistanceMax: formatRunningMax(this.stats.correctionDistance),
      correctionVelocityAvg: formatRunningAverage(this.stats.correctionVelocity),
      correctionVelocityMax: formatRunningMax(this.stats.correctionVelocity),
      correctionVelocitySamples: this.stats.correctionVelocity.count,
      correctionTargetAgeAvgMs: formatRunningAverage(this.stats.correctionTargetAgeMs),
      correctionTargetAgeMaxMs: formatRunningMax(this.stats.correctionTargetAgeMs),
      correctionTargetAgeSamples: this.stats.correctionTargetAgeMs.count,
      retainedPools: {
        unitMotionCapacity: unitPools.motionCapacity,
        unitOrientationCapacity: unitPools.orientationCapacity,
        beamPointFreeList: targetPools.freeBeamPoints,
      },
    };
  }
}

export const CLIENT_PREDICTION_DIAGNOSTICS = new ClientPredictionDiagnostics();

if (
  typeof window !== 'undefined' &&
  CLIENT_PREDICTION_DIAGNOSTICS.enabled
) {
  window.__BA_DP03_CLIENT_PREDICTION__ = {
    reset: () => CLIENT_PREDICTION_DIAGNOSTICS.reset(),
    stats: () => CLIENT_PREDICTION_DIAGNOSTICS.report(),
  };
}
