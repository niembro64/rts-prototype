import { GAME_DIAGNOSTICS } from './diagnostics';
import type { Command } from './sim/commands';
import type { PlayerId } from './sim/types';
import type { NetworkServerSnapshotMeta } from './network/NetworkTypes';
import type { SnapshotRate } from '../types/server';

const SCENARIO_RATES = [5, 8, 10] as const;
const SCENARIO_TICK_RATE = 60;
const PHASE_MS = 30_000;
const PHASE_WARMUP_MS = 3_000;
const PROBE_INTERVAL_MS = 2_000;
const REPORT_INTERVAL_MS = 10_000;
const MAX_PENDING_COMMANDS = 64;

type StatKey = 'bytes' | 'encodeMs' | 'decodeMs' | 'applyMs' | 'correctionAvgDistance' | 'correctionMaxDistance' |
  'renderFps' | 'frameMs' | 'serverTpsAvg' | 'serverTpsLow' | 'commandResponseMs';

type RunningStats = {
  count: number;
  total: number;
  max: number;
};

type RateBucket = {
  rate: string;
  startedAt: number;
  lastAt: number;
  activeMs: number;
  snapshots: number;
  fullSnapshots: number;
  correctionSamples: number;
  stats: Record<StatKey, RunningStats>;
};

type PendingCommandProbe = {
  type: Command['type'];
  tick: number;
  sentAt: number;
};

type SnapshotCorrectionStats = {
  count: number;
  totalDistance: number;
  maxDistance: number;
};

export type SnapshotCadenceRegressionReportRow = {
  rate: string;
  seconds: number;
  snapshots: number;
  sps: number;
  full: number;
  bytesAvg: number | string;
  bytesMax: number | string;
  encodeMs: number | string;
  decodeMs: number | string;
  applyMs: number | string;
  correctionAvg: number | string;
  correctionMax: number | string;
  correctionSamples: number;
  renderFps: number | string;
  renderFpsWorst: number | string;
  serverTps: number | string;
  serverTpsLow: number | string;
  commandMs: number | string;
  commandMsMax: number | string;
  commands: number;
};

export type SnapshotCadenceRegressionDebugApi = {
  reset(): void;
  report(): void;
  rows(): SnapshotCadenceRegressionReportRow[];
};

declare global {
  interface Window {
    __BA_DP01_REGRESSION__?: SnapshotCadenceRegressionDebugApi;
  }
}

function createStats(): RunningStats {
  return { count: 0, total: 0, max: 0 };
}

function addStat(stats: RunningStats, value: number): void {
  if (!Number.isFinite(value)) return;
  stats.count++;
  stats.total += value;
  if (value > stats.max) stats.max = value;
}

function avg(stats: RunningStats): number | null {
  return stats.count > 0 ? stats.total / stats.count : null;
}

function value(stats: RunningStats, digits = 2): number | string {
  const average = avg(stats);
  return average === null ? 'n/a' : Number(average.toFixed(digits));
}

function maxValue(stats: RunningStats, digits = 2): number | string {
  return stats.count > 0 ? Number(stats.max.toFixed(digits)) : 'n/a';
}

function makeBucket(rate: string, now: number): RateBucket {
  return {
    rate,
    startedAt: now,
    lastAt: now,
    activeMs: 0,
    snapshots: 0,
    fullSnapshots: 0,
    correctionSamples: 0,
    stats: {
      bytes: createStats(),
      encodeMs: createStats(),
      decodeMs: createStats(),
      applyMs: createStats(),
      correctionAvgDistance: createStats(),
      correctionMaxDistance: createStats(),
      renderFps: createStats(),
      frameMs: createStats(),
      serverTpsAvg: createStats(),
      serverTpsLow: createStats(),
      commandResponseMs: createStats(),
    },
  };
}

function rateKey(rate: SnapshotRate | undefined): string {
  return rate === undefined ? 'unknown' : String(rate);
}

function isGameplayResponseCommand(command: Command): boolean {
  switch (command.type) {
    case 'select':
    case 'clearSelection':
    case 'setSnapshotRate':
    case 'setKeyframeRatio':
    case 'setTickRate':
    case 'setTiltEmaMode':
    case 'setSendGridInfo':
    case 'setBackgroundUnitType':
    case 'setMaxTotalUnits':
    case 'setMirrorsEnabled':
    case 'setForceFieldsEnabled':
    case 'setForceFieldsBlockTargeting':
    case 'setForceFieldReflectionMode':
    case 'setFogOfWarEnabled':
    case 'setSimQuality':
    case 'setSimSignalStates':
    case 'setCameraAoi':
      return false;
    default:
      return true;
  }
}

export type SnapshotCadenceRegressionApplySample = {
  tick: number;
  isDelta: boolean;
  meta?: NetworkServerSnapshotMeta;
  applyMs: number;
  correction: SnapshotCorrectionStats;
  now?: number;
};

export class SnapshotCadenceRegression {
  readonly enabled = GAME_DIAGNOSTICS.snapshotCadenceRegression;

  private readonly buckets = new Map<string, RateBucket>();
  private readonly pendingCommands: PendingCommandProbe[] = [];
  private currentRate = 'unknown';
  private lastRecordKey = 'unknown';
  private lastRecordAt = 0;
  private phaseIndex = -1;
  private phaseStartedAt = 0;
  private lastProbeAt = 0;
  private lastReportAt = 0;
  private scenarioAnnounced = false;

  recordSnapshotEncode(sample: {
    rate?: SnapshotRate;
    bytes: number;
    encodeMs: number;
    now?: number;
  }): void {
    if (!this.enabled) return;
    const bucket = this.bucket(sample.rate, sample.now);
    addStat(bucket.stats.bytes, sample.bytes);
    addStat(bucket.stats.encodeMs, sample.encodeMs);
  }

  recordSnapshotDecode(sample: {
    rate?: SnapshotRate;
    bytes?: number;
    decodeMs: number;
    now?: number;
  }): void {
    if (!this.enabled) return;
    const bucket = this.bucket(sample.rate, sample.now);
    if (sample.bytes !== undefined) addStat(bucket.stats.bytes, sample.bytes);
    addStat(bucket.stats.decodeMs, sample.decodeMs);
  }

  recordSnapshotApply(sample: SnapshotCadenceRegressionApplySample): void {
    if (!this.enabled) return;
    const now = sample.now ?? performance.now();
    const meta = sample.meta;
    if (meta?.snaps.rate !== undefined) this.currentRate = rateKey(meta.snaps.rate);
    const bucket = this.bucket(meta?.snaps.rate, now);
    bucket.snapshots++;
    if (!sample.isDelta) bucket.fullSnapshots++;
    addStat(bucket.stats.applyMs, sample.applyMs);
    if (sample.correction.count > 0) {
      bucket.correctionSamples += sample.correction.count;
      addStat(
        bucket.stats.correctionAvgDistance,
        sample.correction.totalDistance / sample.correction.count,
      );
      addStat(bucket.stats.correctionMaxDistance, sample.correction.maxDistance);
    }
    if (meta) {
      addStat(bucket.stats.serverTpsAvg, meta.ticks.avg);
      addStat(bucket.stats.serverTpsLow, meta.ticks.low);
    }
    this.resolveCommandResponses(sample.tick, now, bucket);
    this.maybeReport(now);
  }

  recordFrame(sample: {
    frameMs: number;
    now?: number;
  }): void {
    if (!this.enabled) return;
    const now = sample.now ?? performance.now();
    const bucket = this.bucket(undefined, now);
    addStat(bucket.stats.frameMs, sample.frameMs);
    if (sample.frameMs > 0) addStat(bucket.stats.renderFps, 1000 / sample.frameMs);
  }

  recordCommandIssued(command: Command, currentTick: number, now = performance.now()): void {
    if (!this.enabled || !isGameplayResponseCommand(command)) return;
    const tick = Number.isFinite(command.tick) ? command.tick : currentTick;
    this.pendingCommands.push({ type: command.type, tick, sentAt: now });
    if (this.pendingCommands.length > MAX_PENDING_COMMANDS) this.pendingCommands.shift();
  }

  tickHostScenario(options: {
    now: number;
    currentTick: number;
    localPlayerId: PlayerId;
    hostPlayerId: PlayerId | undefined;
    mapWidth: number;
    mapHeight: number;
    backgroundMode: boolean;
    lobbyPreview: boolean;
    sendCommand(command: Command): void;
  }): void {
    if (!this.enabled) return;
    if (options.backgroundMode || options.lobbyPreview) return;
    if (options.hostPlayerId === undefined || options.localPlayerId !== options.hostPlayerId) return;

    if (!this.scenarioAnnounced) {
      this.reset(options.now);
      this.scenarioAnnounced = true;
      console.info(
        '[DP-01] Snapshot cadence regression enabled. Cycling 5/8/10 SPS at 60 TPS; console tables report snapshots, bytes, encode/decode/apply time, correction distance, render FPS, and ping command response.',
      );
    }

    if (
      this.phaseIndex < 0 ||
      options.now - this.phaseStartedAt >= PHASE_MS
    ) {
      this.advancePhase(options);
    }

    if (
      options.now - this.phaseStartedAt >= PHASE_WARMUP_MS &&
      options.now - this.lastProbeAt >= PROBE_INTERVAL_MS
    ) {
      this.lastProbeAt = options.now;
      const command: Command = {
        type: 'ping',
        tick: options.currentTick,
        targetX: options.mapWidth * 0.5,
        targetY: options.mapHeight * 0.5,
        playerId: options.localPlayerId,
      };
      this.recordCommandIssued(command, options.currentTick, options.now);
      options.sendCommand(command);
    }
  }

  report(): void {
    if (!this.enabled) return;
    this.printReport(performance.now());
  }

  reset(now = performance.now()): void {
    this.buckets.clear();
    this.pendingCommands.length = 0;
    this.currentRate = 'unknown';
    this.lastRecordKey = 'unknown';
    this.lastRecordAt = 0;
    this.lastReportAt = now;
  }

  rows(now = performance.now()): SnapshotCadenceRegressionReportRow[] {
    if (!this.enabled) return [];
    return this.buildReportRows(now);
  }

  private advancePhase(options: {
    now: number;
    currentTick: number;
    sendCommand(command: Command): void;
  }): void {
    this.phaseIndex = (this.phaseIndex + 1) % SCENARIO_RATES.length;
    const rate = SCENARIO_RATES[this.phaseIndex];
    this.currentRate = String(rate);
    this.phaseStartedAt = options.now;
    this.lastProbeAt = options.now;
    this.lastReportAt = options.now;
    options.sendCommand({
      type: 'setTickRate',
      tick: options.currentTick,
      rate: SCENARIO_TICK_RATE,
    });
    options.sendCommand({
      type: 'setSnapshotRate',
      tick: options.currentTick,
      rate,
    });
    console.info(`[DP-01] Regression phase: ${rate} SPS, ${SCENARIO_TICK_RATE} TPS target.`);
  }

  private bucket(rate: SnapshotRate | undefined, now = performance.now()): RateBucket {
    const key = rate === undefined ? this.currentRate : rateKey(rate);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = makeBucket(key, now);
      this.buckets.set(key, bucket);
    }
    if (this.lastRecordAt > 0 && this.lastRecordKey === key) {
      bucket.activeMs += Math.max(0, now - this.lastRecordAt);
    }
    this.lastRecordKey = key;
    this.lastRecordAt = now;
    bucket.lastAt = now;
    return bucket;
  }

  private resolveCommandResponses(tick: number, now: number, bucket: RateBucket): void {
    for (let i = 0; i < this.pendingCommands.length;) {
      const pending = this.pendingCommands[i];
      if (tick <= pending.tick) {
        i++;
        continue;
      }
      addStat(bucket.stats.commandResponseMs, now - pending.sentAt);
      this.pendingCommands.splice(i, 1);
    }
  }

  private maybeReport(now: number): void {
    if (now - this.lastReportAt < REPORT_INTERVAL_MS) return;
    this.lastReportAt = now;
    this.printReport(now);
  }

  private buildReportRows(_now: number): SnapshotCadenceRegressionReportRow[] {
    const rows: SnapshotCadenceRegressionReportRow[] = [];
    const orderedRates = [...SCENARIO_RATES.map(String), 'unknown'];
    for (const key of orderedRates) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      const durationSec = Math.max(0.001, bucket.activeMs / 1000);
      rows.push({
        rate: bucket.rate,
        seconds: Number(durationSec.toFixed(1)),
        snapshots: bucket.snapshots,
        sps: Number((bucket.snapshots / durationSec).toFixed(2)),
        full: bucket.fullSnapshots,
        bytesAvg: value(bucket.stats.bytes, 0),
        bytesMax: maxValue(bucket.stats.bytes, 0),
        encodeMs: value(bucket.stats.encodeMs),
        decodeMs: value(bucket.stats.decodeMs),
        applyMs: value(bucket.stats.applyMs),
        correctionAvg: value(bucket.stats.correctionAvgDistance),
        correctionMax: maxValue(bucket.stats.correctionMaxDistance),
        correctionSamples: bucket.correctionSamples,
        renderFps: value(bucket.stats.renderFps, 1),
        renderFpsWorst: bucket.stats.frameMs.count > 0
          ? Number((1000 / Math.max(bucket.stats.frameMs.max, 0.001)).toFixed(1))
          : 'n/a',
        serverTps: value(bucket.stats.serverTpsAvg, 1),
        serverTpsLow: value(bucket.stats.serverTpsLow, 1),
        commandMs: value(bucket.stats.commandResponseMs),
        commandMsMax: maxValue(bucket.stats.commandResponseMs),
        commands: bucket.stats.commandResponseMs.count,
      });
    }
    return rows;
  }

  private printReport(now: number): void {
    const rows = this.buildReportRows(now);
    if (rows.length === 0) return;
    console.info(`[DP-01] Snapshot cadence regression report @ ${Math.round(now)}ms`);
    console.table(rows);
  }
}

export const SNAPSHOT_CADENCE_REGRESSION = new SnapshotCadenceRegression();

if (
  typeof window !== 'undefined' &&
  SNAPSHOT_CADENCE_REGRESSION.enabled
) {
  window.__BA_DP01_REGRESSION__ = {
    reset: () => SNAPSHOT_CADENCE_REGRESSION.reset(),
    report: () => SNAPSHOT_CADENCE_REGRESSION.report(),
    rows: () => SNAPSHOT_CADENCE_REGRESSION.rows(),
  };
}
