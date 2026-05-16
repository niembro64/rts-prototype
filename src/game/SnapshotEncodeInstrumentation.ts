import { GAME_DIAGNOSTICS } from './diagnostics';
import {
  addRunningStat,
  createRunningStats,
  formatRunningAverage,
  formatRunningMax,
  type RunningStats,
} from './diagnosticStats';
import type { SnapshotRate } from '../types/server';

const REPORT_INTERVAL_MS = 10_000;

export type SnapshotEncodeInstrumentationSource = 'local' | 'remote';

type EncodeBucket = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate: string;
  unitBand: string;
  startedAt: number;
  lastAt: number;
  samples: number;
  fullSnapshots: number;
  deltaSnapshots: number;
  stats: {
    units: RunningStats;
    bytes: RunningStats;
    encodeMs: RunningStats;
  };
};

export type SnapshotEncodeInstrumentationReportRow = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate: string;
  unitBand: string;
  seconds: number;
  samples: number;
  encodedSps: number;
  full: number;
  delta: number;
  unitsAvg: number | string;
  unitsMax: number | string;
  bytesAvg: number | string;
  bytesMax: number | string;
  encodeMs: number | string;
  encodeMsMax: number | string;
};

export type SnapshotEncodeInstrumentationSample = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate?: SnapshotRate;
  unitCount?: number;
  bytes: number;
  encodeMs: number;
  isDelta: boolean;
  now?: number;
};

export type SnapshotEncodeInstrumentationDebugApi = {
  reset(): void;
  report(): void;
  rows(): SnapshotEncodeInstrumentationReportRow[];
};

declare global {
  interface Window {
    __BA_DP02_SNAPSHOT_WIRE__?: SnapshotEncodeInstrumentationDebugApi;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function rateKey(rate: SnapshotRate | undefined): string {
  return rate === undefined ? 'unknown' : String(rate);
}

function unitBandFor(unitCount: number | undefined): string {
  if (unitCount === undefined || !Number.isFinite(unitCount)) return 'unknown';
  if (unitCount < 750) return '<1k';
  if (unitCount < 2000) return '1k';
  if (unitCount < 4000) return '3k';
  if (unitCount < 7000) return '5k';
  return '5k+';
}

function createBucket(
  source: SnapshotEncodeInstrumentationSource,
  listener: string,
  rate: string,
  unitBand: string,
  now: number,
): EncodeBucket {
  return {
    source,
    listener,
    rate,
    unitBand,
    startedAt: now,
    lastAt: now,
    samples: 0,
    fullSnapshots: 0,
    deltaSnapshots: 0,
    stats: {
      units: createRunningStats(),
      bytes: createRunningStats(),
      encodeMs: createRunningStats(),
    },
  };
}

export class SnapshotEncodeInstrumentation {
  readonly enabled = GAME_DIAGNOSTICS.snapshotEncodeInstrumentation;

  private readonly buckets = new Map<string, EncodeBucket>();
  private lastReportAt = 0;

  record(sample: SnapshotEncodeInstrumentationSample): void {
    if (!this.enabled) return;
    const now = sample.now ?? nowMs();
    const rate = rateKey(sample.rate);
    const unitBand = unitBandFor(sample.unitCount);
    const key = `${sample.source}|${sample.listener}|${rate}|${unitBand}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = createBucket(sample.source, sample.listener, rate, unitBand, now);
      this.buckets.set(key, bucket);
    }

    bucket.lastAt = now;
    bucket.samples++;
    if (sample.isDelta) bucket.deltaSnapshots++;
    else bucket.fullSnapshots++;
    if (sample.unitCount !== undefined) addRunningStat(bucket.stats.units, sample.unitCount);
    addRunningStat(bucket.stats.bytes, sample.bytes);
    addRunningStat(bucket.stats.encodeMs, sample.encodeMs);
    this.maybeReport(now);
  }

  clearListener(listener: string, source?: SnapshotEncodeInstrumentationSource): void {
    if (!this.enabled) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.listener !== listener) continue;
      if (source !== undefined && bucket.source !== source) continue;
      this.buckets.delete(key);
    }
  }

  clearSource(source: SnapshotEncodeInstrumentationSource): void {
    if (!this.enabled) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.source === source) this.buckets.delete(key);
    }
  }

  reset(): void {
    this.buckets.clear();
    this.lastReportAt = nowMs();
  }

  rows(): SnapshotEncodeInstrumentationReportRow[] {
    if (!this.enabled) return [];
    return this.buildRows();
  }

  report(): void {
    if (!this.enabled) return;
    this.printReport(nowMs());
  }

  private maybeReport(now: number): void {
    if (this.lastReportAt === 0) this.lastReportAt = now;
    if (now - this.lastReportAt < REPORT_INTERVAL_MS) return;
    this.lastReportAt = now;
    this.printReport(now);
  }

  private buildRows(): SnapshotEncodeInstrumentationReportRow[] {
    const rows: SnapshotEncodeInstrumentationReportRow[] = [];
    for (const bucket of this.buckets.values()) {
      const durationSec = Math.max(0.001, (bucket.lastAt - bucket.startedAt) / 1000);
      rows.push({
        source: bucket.source,
        listener: bucket.listener,
        rate: bucket.rate,
        unitBand: bucket.unitBand,
        seconds: Number(durationSec.toFixed(1)),
        samples: bucket.samples,
        encodedSps: Number((bucket.samples / durationSec).toFixed(2)),
        full: bucket.fullSnapshots,
        delta: bucket.deltaSnapshots,
        unitsAvg: formatRunningAverage(bucket.stats.units, 0),
        unitsMax: formatRunningMax(bucket.stats.units, 0),
        bytesAvg: formatRunningAverage(bucket.stats.bytes, 0),
        bytesMax: formatRunningMax(bucket.stats.bytes, 0),
        encodeMs: formatRunningAverage(bucket.stats.encodeMs),
        encodeMsMax: formatRunningMax(bucket.stats.encodeMs),
      });
    }
    rows.sort((a, b) =>
      a.source.localeCompare(b.source) ||
      a.listener.localeCompare(b.listener) ||
      a.rate.localeCompare(b.rate) ||
      a.unitBand.localeCompare(b.unitBand)
    );
    return rows;
  }

  private printReport(now: number): void {
    const rows = this.buildRows();
    if (rows.length === 0) return;
    console.info(`[DP-02] Snapshot JS MessagePack encode report @ ${Math.round(now)}ms`);
    console.table(rows);
  }
}

export const SNAPSHOT_ENCODE_INSTRUMENTATION = new SnapshotEncodeInstrumentation();

if (
  typeof window !== 'undefined' &&
  SNAPSHOT_ENCODE_INSTRUMENTATION.enabled
) {
  window.__BA_DP02_SNAPSHOT_WIRE__ = {
    reset: () => SNAPSHOT_ENCODE_INSTRUMENTATION.reset(),
    report: () => SNAPSHOT_ENCODE_INSTRUMENTATION.report(),
    rows: () => SNAPSHOT_ENCODE_INSTRUMENTATION.rows(),
  };
}
