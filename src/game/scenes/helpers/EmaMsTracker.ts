// EMA tracker for millisecond durations (frame/render/logic time).
// Tracks:
//   - avg : exponential moving average
//   - hi  : spike tracker — fast climb on jumps, slow decay down (for
//           detecting worst-case frame spikes)
//   - lo  : floor tracker — fast adopt on a new minimum, slow drift up
//           (for "best frame we've ever hit" as a self-calibrating
//           frame-budget on displays of any refresh rate)
// Starts at an optimistic initial value so LOD begins at MAX quality.

import type { EmaMsConfig } from '@/types/config';

export class EmaMsTracker {
  private avg: number;
  private hi: number;
  private lo: number;
  private initialized: boolean;

  /**
   * @param config EMA alpha values — `hi.spike`/`hi.recovery` drive both
   *   the `hi` tracker (high new value → spike, otherwise → slow decay)
   *   and the `lo` tracker in reverse (low new value → fast drop,
   *   otherwise → slow rise).
   * @param initialValue Optimistic starting value (e.g. 1 for ms timings).
   *   If provided, EMA starts "low" and real samples pull it up.
   *   If omitted, waits for first sample (legacy behavior).
   */
  constructor(private config: EmaMsConfig, initialValue?: number) {
    if (initialValue !== undefined) {
      this.avg = initialValue;
      this.hi = initialValue;
      this.lo = initialValue;
      this.initialized = true;
    } else {
      this.avg = 0;
      this.hi = 0;
      this.lo = 0;
      this.initialized = false;
    }
  }

  update(value: number): void {
    if (!this.initialized) {
      this.avg = value;
      this.hi = value;
      this.lo = value;
      this.initialized = true;
    } else {
      this.avg = (1 - this.config.avg) * this.avg + this.config.avg * value;
      this.hi = value > this.hi
        ? (1 - this.config.hi.spike) * this.hi + this.config.hi.spike * value
        : (1 - this.config.hi.recovery) * this.hi + this.config.hi.recovery * value;
      // Symmetric to `hi`: a new minimum is adopted fast (spike coefficient
      // reused), any larger value lets `lo` drift upward slowly. This turns
      // a raw Math.min — which one outlier can lock forever — into a stable
      // self-calibrating "best-observed" baseline.
      this.lo = value < this.lo
        ? (1 - this.config.hi.spike) * this.lo + this.config.hi.spike * value
        : (1 - this.config.hi.recovery) * this.lo + this.config.hi.recovery * value;
    }
  }

  getAvg(): number { return this.avg; }
  getHi(): number { return this.hi; }
  getLo(): number { return this.lo; }
}
