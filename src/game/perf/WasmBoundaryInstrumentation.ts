import {
  instrumentationNowMs,
  LabeledDurationInstrumentation,
  type LabeledDurationReport,
} from './LabeledDurationInstrumentation';

export type WasmBoundaryInstrumentationReport = LabeledDurationReport;

export const WASM_BOUNDARY_INSTRUMENTATION = new LabeledDurationInstrumentation();

export function measureWasmBoundary<T>(label: string, fn: () => T): T {
  if (!WASM_BOUNDARY_INSTRUMENTATION.enabled) return fn();
  const start = instrumentationNowMs();
  try {
    return fn();
  } finally {
    WASM_BOUNDARY_INSTRUMENTATION.record(label, instrumentationNowMs() - start);
  }
}
