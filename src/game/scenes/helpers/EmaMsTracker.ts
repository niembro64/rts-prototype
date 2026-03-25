// EMA tracker for millisecond durations (frame/render/logic time).
// Tracks avg + high (spike) — inverse of EmaTracker which tracks avg + low (drop).
// Starts at an optimistic initial value so LOD begins at MAX quality.

import type { EmaMsConfig } from '@/types/config';

export class EmaMsTracker {
  private avg: number;
  private hi: number;
  private initialized: boolean;

  /**
   * @param config EMA alpha values
   * @param initialValue Optimistic starting value (e.g. 1 for ms timings).
   *   If provided, EMA starts "low" and real samples pull it up.
   *   If omitted, waits for first sample (legacy behavior).
   */
  constructor(private config: EmaMsConfig, initialValue?: number) {
    if (initialValue !== undefined) {
      this.avg = initialValue;
      this.hi = initialValue;
      this.initialized = true;
    } else {
      this.avg = 0;
      this.hi = 0;
      this.initialized = false;
    }
  }

  update(value: number): void {
    if (!this.initialized) {
      this.avg = value;
      this.hi = value;
      this.initialized = true;
    } else {
      this.avg = (1 - this.config.avg) * this.avg + this.config.avg * value;
      this.hi = value > this.hi
        ? (1 - this.config.hi.spike) * this.hi + this.config.hi.spike * value
        : (1 - this.config.hi.recovery) * this.hi + this.config.hi.recovery * value;
    }
  }

  getAvg(): number { return this.avg; }
  getHi(): number { return this.hi; }
}
