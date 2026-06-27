import {
  runPerformanceBottleneckHarness,
  runPerformanceBottleneckHarnessSuite,
  type PerformanceBottleneckHarnessOptions,
  type PerformanceBottleneckHarnessReport,
  type PerformanceBottleneckHarnessSuiteOptions,
  type PerformanceBottleneckHarnessSuiteReport,
} from './game/perf/PerformanceBottleneckHarness';

declare global {
  interface Window {
    __runPerformanceBottleneckHarness?: (
      options?: PerformanceBottleneckHarnessOptions,
    ) => Promise<PerformanceBottleneckHarnessReport>;
    __runPerformanceBottleneckHarnessSuite?: (
      options?: PerformanceBottleneckHarnessSuiteOptions,
    ) => Promise<PerformanceBottleneckHarnessSuiteReport>;
  }
}

window.__runPerformanceBottleneckHarness = runPerformanceBottleneckHarness;
window.__runPerformanceBottleneckHarnessSuite = runPerformanceBottleneckHarnessSuite;
