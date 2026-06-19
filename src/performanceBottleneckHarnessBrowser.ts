import {
  runPerformanceBottleneckHarness,
  type PerformanceBottleneckHarnessOptions,
  type PerformanceBottleneckHarnessReport,
} from './game/perf/PerformanceBottleneckHarness';

declare global {
  interface Window {
    __runPerformanceBottleneckHarness?: (
      options?: PerformanceBottleneckHarnessOptions,
    ) => Promise<PerformanceBottleneckHarnessReport>;
  }
}

window.__runPerformanceBottleneckHarness = runPerformanceBottleneckHarness;

