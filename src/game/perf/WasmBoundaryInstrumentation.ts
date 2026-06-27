type WasmBoundaryRow = {
  readonly label: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
};

export type WasmBoundaryInstrumentationReport = {
  readonly enabled: boolean;
  readonly calls: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly rows: readonly WasmBoundaryRow[];
};

type MutableWasmBoundaryBucket = {
  calls: number;
  totalMs: number;
  maxMs: number;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

class WasmBoundaryInstrumentation {
  private active = false;
  private readonly buckets = new Map<string, MutableWasmBoundaryBucket>();

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

  report(): WasmBoundaryInstrumentationReport {
    let calls = 0;
    let totalMs = 0;
    let maxMs = 0;
    const rows: WasmBoundaryRow[] = [];
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

export const WASM_BOUNDARY_INSTRUMENTATION = new WasmBoundaryInstrumentation();

export function measureWasmBoundary<T>(label: string, fn: () => T): T {
  if (!WASM_BOUNDARY_INSTRUMENTATION.enabled) return fn();
  const start = nowMs();
  try {
    return fn();
  } finally {
    WASM_BOUNDARY_INSTRUMENTATION.record(label, nowMs() - start);
  }
}
