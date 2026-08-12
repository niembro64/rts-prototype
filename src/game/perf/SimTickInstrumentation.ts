import {
  instrumentationNowMs,
  LabeledDurationInstrumentation,
  type LabeledDurationReport,
} from './LabeledDurationInstrumentation';

export type SimTickInstrumentationReport = LabeledDurationReport;

/** Per-system attribution inside the fixed sim tick. The tick is
 *  straight-line code, so phases are timed with a single moving cursor:
 *  `tickBegin()` stamps it once per tick, and each `phase(label)` call
 *  records the time since the previous boundary and re-stamps. That is
 *  one `performance.now()` per boundary and zero per-tick allocation —
 *  cheap enough to wrap every system, but still disabled by default and
 *  only switched on by the performance bottleneck harness.
 *
 *  Rules for instrumentation sites:
 *  - `phase(label)` must run unconditionally after its region, even when
 *    the region conditionally did nothing (it records ~0 ms). A skipped
 *    boundary silently folds the region's time into the NEXT label.
 *  - Nested callees may emit their own phases (combat.* inside sim.*):
 *    the cursor is shared, so a callee's phases subdivide the caller's
 *    window and the caller simply does not re-label that span. */
class SimTickInstrumentation extends LabeledDurationInstrumentation {
  private cursorMs = 0;

  tickBegin(): void {
    if (!this.enabled) return;
    this.cursorMs = instrumentationNowMs();
  }

  phase(label: string): void {
    if (!this.enabled) return;
    const now = instrumentationNowMs();
    this.record(label, now - this.cursorMs);
    this.cursorMs = now;
  }
}

export const SIM_TICK_INSTRUMENTATION = new SimTickInstrumentation();
