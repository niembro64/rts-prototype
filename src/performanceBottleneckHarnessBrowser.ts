import {
  runPerformanceBottleneckHarness,
  runPerformanceBottleneckHarnessSuite,
  runPerformanceSimulationHarness,
  type PerformanceBottleneckHarnessOptions,
  type PerformanceBottleneckHarnessReport,
  type PerformanceBottleneckHarnessSuiteOptions,
  type PerformanceBottleneckHarnessSuiteReport,
  type SimOnlyReport,
} from './game/perf/PerformanceBottleneckHarness';

declare global {
  interface Window {
    __runPerformanceBottleneckHarness?: (
      options?: PerformanceBottleneckHarnessOptions,
    ) => Promise<PerformanceBottleneckHarnessReport>;
    __runPerformanceBottleneckHarnessSuite?: (
      options?: PerformanceBottleneckHarnessSuiteOptions,
    ) => Promise<PerformanceBottleneckHarnessSuiteReport>;
    __runPerformanceSimulationHarness?: (
      options?: PerformanceBottleneckHarnessOptions,
    ) => Promise<SimOnlyReport>;
  }
}

window.__runPerformanceBottleneckHarness = runPerformanceBottleneckHarness;
window.__runPerformanceBottleneckHarnessSuite = runPerformanceBottleneckHarnessSuite;
window.__runPerformanceSimulationHarness = runPerformanceSimulationHarness;
