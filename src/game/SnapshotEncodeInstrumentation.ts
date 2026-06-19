import { GAME_DIAGNOSTICS } from './diagnostics';
import {
  addRunningStat,
  createRunningStats,
  formatRunningAverage,
  formatRunningMax,
  type RunningStats,
} from './diagnosticStats';
import type { SnapshotWireBreakdown } from './network/snapshotWireCodec';
import type {
  SnapshotWireEncoderKind,
  SnapshotWireMaterializationKind,
} from './network/SnapshotWirePayload';
import type { SnapshotRate } from '../types/server';

const REPORT_INTERVAL_MS = 10_000;

type SnapshotEncodeInstrumentationSource = 'local';

type EncodeBucket = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate: string;
  unitBand: string;
  startedAt: number;
  lastAt: number;
  samples: number;
  rustSamples: number;
  jsSamples: number;
  dtoMaterializedSamples: number;
  directMaterializedSamples: number;
  rawTopLevelKeys: Record<string, number>;
  stats: {
    units: RunningStats;
    bytes: RunningStats;
    encodeMs: RunningStats;
    rustEntities: RunningStats;
    rawEntities: RunningStats;
  };
  latestBreakdown?: SnapshotWireBreakdown;
};

type SnapshotEncodeInstrumentationReportRow = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate: string;
  unitBand: string;
  seconds: number;
  samples: number;
  encodedSps: number;
  encoder: string;
  materialization: string;
  unitsAvg: number | string;
  unitsMax: number | string;
  bytesAvg: number | string;
  bytesMax: number | string;
  encodeMs: number | string;
  encodeMsMax: number | string;
  rustEntitiesAvg: number | string;
  rawEntitiesAvg: number | string;
  rawKeys: string;
};

type SnapshotEncodeInstrumentationBreakdownRow = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate: string;
  unitBand: string;
  kind: 'SNAPSHOT';
  totalBytes: number;
  top1: string;
  top1Bytes: number;
  top1Pct: number;
  top2: string;
  top2Bytes: number;
  top2Pct: number;
  top3: string;
  top3Bytes: number;
  top3Pct: number;
  entityTop: string;
  projectileTop: string;
};

type SnapshotEncodeInstrumentationSample = {
  source: SnapshotEncodeInstrumentationSource;
  listener: string;
  rate?: SnapshotRate;
  unitCount?: number;
  bytes: number;
  encodeMs: number;
  encoderKind?: SnapshotWireEncoderKind;
  materializationKind?: SnapshotWireMaterializationKind;
  rustEntityCount?: number;
  rawEntityCount?: number;
  rawTopLevelKeys?: readonly string[];
  breakdown?: SnapshotWireBreakdown;
  now?: number;
};

type SnapshotEncodeInstrumentationDebugApi = {
  reset(): void;
  report(): void;
  rows(): SnapshotEncodeInstrumentationReportRow[];
  breakdowns(): SnapshotEncodeInstrumentationBreakdownRow[];
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
    rustSamples: 0,
    jsSamples: 0,
    dtoMaterializedSamples: 0,
    directMaterializedSamples: 0,
    rawTopLevelKeys: {},
    stats: {
      units: createRunningStats(),
      bytes: createRunningStats(),
      encodeMs: createRunningStats(),
      rustEntities: createRunningStats(),
      rawEntities: createRunningStats(),
    },
  };
}

class SnapshotEncodeInstrumentation {
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
    if (sample.encoderKind === 'rust') bucket.rustSamples++;
    else if (sample.encoderKind === 'js') bucket.jsSamples++;
    if (sample.materializationKind === 'dto') bucket.dtoMaterializedSamples++;
    else if (sample.materializationKind === 'direct') bucket.directMaterializedSamples++;
    if (sample.unitCount !== undefined) addRunningStat(bucket.stats.units, sample.unitCount);
    addRunningStat(bucket.stats.bytes, sample.bytes);
    addRunningStat(bucket.stats.encodeMs, sample.encodeMs);
    if (sample.rustEntityCount !== undefined) {
      addRunningStat(bucket.stats.rustEntities, sample.rustEntityCount);
    }
    if (sample.rawEntityCount !== undefined) {
      addRunningStat(bucket.stats.rawEntities, sample.rawEntityCount);
    }
    if (sample.rawTopLevelKeys !== undefined) {
      for (const key of sample.rawTopLevelKeys) {
        bucket.rawTopLevelKeys[key] = (bucket.rawTopLevelKeys[key] ?? 0) + 1;
      }
    }
    if (sample.breakdown !== undefined) {
      bucket.latestBreakdown = sample.breakdown;
    }
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

  reset(): void {
    this.buckets.clear();
    this.lastReportAt = nowMs();
  }

  rows(): SnapshotEncodeInstrumentationReportRow[] {
    if (!this.enabled) return [];
    return this.buildRows();
  }

  breakdowns(): SnapshotEncodeInstrumentationBreakdownRow[] {
    if (!this.enabled) return [];
    return this.buildBreakdownRows();
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
        encoder: formatEncoderMix(bucket),
        materialization: formatMaterializationMix(bucket),
        unitsAvg: formatRunningAverage(bucket.stats.units, 0),
        unitsMax: formatRunningMax(bucket.stats.units, 0),
        bytesAvg: formatRunningAverage(bucket.stats.bytes, 0),
        bytesMax: formatRunningMax(bucket.stats.bytes, 0),
        encodeMs: formatRunningAverage(bucket.stats.encodeMs),
        encodeMsMax: formatRunningMax(bucket.stats.encodeMs),
        rustEntitiesAvg: formatRunningAverage(bucket.stats.rustEntities, 0),
        rawEntitiesAvg: formatRunningAverage(bucket.stats.rawEntities, 0),
        rawKeys: formatRawTopLevelKeys(bucket.rawTopLevelKeys),
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

  private buildBreakdownRows(): SnapshotEncodeInstrumentationBreakdownRow[] {
    const rows: SnapshotEncodeInstrumentationBreakdownRow[] = [];
    for (const bucket of this.buckets.values()) {
      this.appendBreakdownRow(rows, bucket, 'SNAPSHOT', bucket.latestBreakdown);
    }
    rows.sort((a, b) =>
      a.source.localeCompare(b.source) ||
      a.listener.localeCompare(b.listener) ||
      a.rate.localeCompare(b.rate) ||
      a.unitBand.localeCompare(b.unitBand) ||
      a.kind.localeCompare(b.kind)
    );
    return rows;
  }

  private appendBreakdownRow(
    rows: SnapshotEncodeInstrumentationBreakdownRow[],
    bucket: EncodeBucket,
    kind: 'SNAPSHOT',
    breakdown: SnapshotWireBreakdown | undefined,
  ): void {
    if (breakdown === undefined) return;
    const top = breakdown.topLevelTop;
    rows.push({
      source: bucket.source,
      listener: bucket.listener,
      rate: bucket.rate,
      unitBand: bucket.unitBand,
      kind,
      totalBytes: breakdown.totalBytes,
      top1: top[0]?.section ?? '',
      top1Bytes: top[0]?.bytes ?? 0,
      top1Pct: top[0]?.pct ?? 0,
      top2: top[1]?.section ?? '',
      top2Bytes: top[1]?.bytes ?? 0,
      top2Pct: top[1]?.pct ?? 0,
      top3: top[2]?.section ?? '',
      top3Bytes: top[2]?.bytes ?? 0,
      top3Pct: top[2]?.pct ?? 0,
      entityTop: formatDetailTop(breakdown.entityTop),
      projectileTop: formatDetailTop(breakdown.projectileTop),
    });
  }

  private printReport(now: number): void {
    const rows = this.buildRows();
    if (rows.length === 0) return;
    console.info(`[DP-02] Snapshot wire encode report @ ${Math.round(now)}ms`);
    console.table(rows);
    const breakdownRows = this.buildBreakdownRows();
    if (breakdownRows.length > 0) {
      console.info('[DP-02] Snapshot wire section breakdown (latest per bucket/kind)');
      console.table(breakdownRows);
    }
  }
}

function formatDetailTop(entries: SnapshotWireBreakdown['entityTop']): string {
  if (entries.length === 0) return '';
  const parts: string[] = [];
  const count = Math.min(3, entries.length);
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    parts.push(`${entry.section} ${entry.bytes}B/${entry.pct}%`);
  }
  return parts.join(', ');
}

function formatEncoderMix(bucket: EncodeBucket): string {
  if (bucket.rustSamples > 0 && bucket.jsSamples > 0) {
    return `mixed r${bucket.rustSamples}/j${bucket.jsSamples}`;
  }
  if (bucket.rustSamples > 0) return 'rust';
  if (bucket.jsSamples > 0) return 'js';
  return 'unknown';
}

function formatMaterializationMix(bucket: EncodeBucket): string {
  if (bucket.dtoMaterializedSamples > 0 && bucket.directMaterializedSamples > 0) {
    return `mixed dto${bucket.dtoMaterializedSamples}/direct${bucket.directMaterializedSamples}`;
  }
  if (bucket.directMaterializedSamples > 0) return 'direct';
  if (bucket.dtoMaterializedSamples > 0) return 'dto';
  return 'unknown';
}

function formatRawTopLevelKeys(keys: Record<string, number>): string {
  const top: Array<{ key: string; count: number }> = [];
  for (const key in keys) {
    const count = keys[key];
    let insertAt = top.length;
    while (
      insertAt > 0 &&
      (count > top[insertAt - 1].count ||
        (count === top[insertAt - 1].count && key.localeCompare(top[insertAt - 1].key) < 0))
    ) {
      insertAt--;
    }
    if (insertAt >= 4) continue;
    top.splice(insertAt, 0, { key, count });
    if (top.length > 4) top.length = 4;
  }
  if (top.length === 0) return '';
  let formatted = `${top[0].key}:${top[0].count}`;
  for (let i = 1; i < top.length; i++) {
    formatted += `, ${top[i].key}:${top[i].count}`;
  }
  return formatted;
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
    breakdowns: () => SNAPSHOT_ENCODE_INSTRUMENTATION.breakdowns(),
  };
}
