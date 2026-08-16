/** Shared labeled-bucket stopwatch core for opt-in perf instrumentation.
 *  WasmBoundaryInstrumentation (JS→WASM crossings) and
 *  SimTickInstrumentation (per-system tick phases) both accumulate into
 *  this shape; the performance bottleneck harness enables an instance
 *  for a run and attaches `report()` to its JSON output. Disabled
 *  instances cost one boolean check per record site. */

export { monotonicNowMs as instrumentationNowMs } from '../time';

type LabeledDurationRow = {
  readonly label: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
};

export type LabeledDurationReport = {
  readonly enabled: boolean;
  readonly calls: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly rows: readonly LabeledDurationRow[];
};

type MutableBucket = {
  calls: number;
  totalMs: number;
  maxMs: number;
};

export class LabeledDurationInstrumentation {
  private active = false;
  private readonly buckets = new Map<string, MutableBucket>();

  setEnabled(enabled: boolean): void {
    this.active = enabled;
  }

  get enabled(): boolean {
    return this.active;
  }

  reset(): void {
    this.buckets.clear();
  }

  record(label: string, ms: number): void {
    if (!this.active || !Number.isFinite(ms) || ms < 0) return;
    let bucket = this.buckets.get(label);
    if (bucket === undefined) {
      bucket = { calls: 0, totalMs: 0, maxMs: 0 };
      this.buckets.set(label, bucket);
    }
    bucket.calls++;
    bucket.totalMs += ms;
    if (ms > bucket.maxMs) bucket.maxMs = ms;
  }

  report(): LabeledDurationReport {
    let calls = 0;
    let totalMs = 0;
    let maxMs = 0;
    const rows: LabeledDurationRow[] = [];
    for (const [label, bucket] of this.buckets) {
      calls += bucket.calls;
      totalMs += bucket.totalMs;
      if (bucket.maxMs > maxMs) maxMs = bucket.maxMs;
      rows.push({
        label,
        calls: bucket.calls,
        totalMs: bucket.totalMs,
        avgMs: bucket.calls > 0 ? bucket.totalMs / bucket.calls : 0,
        maxMs: bucket.maxMs,
      });
    }
    rows.sort((a, b) => b.totalMs - a.totalMs || a.label.localeCompare(b.label));
    return {
      enabled: this.active,
      calls,
      totalMs,
      avgMs: calls > 0 ? totalMs / calls : 0,
      maxMs,
      rows,
    };
  }
}
