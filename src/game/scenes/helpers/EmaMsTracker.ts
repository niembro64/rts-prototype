// EMA tracker for millisecond durations (frame/render/logic time).
// Tracks avg + high (spike) — inverse of EmaTracker which tracks avg + low (drop).

import type { EmaMsConfig } from '@/types/config';

export class EmaMsTracker {
  private avg = 0;
  private hi = 0;
  private initialized = false;

  constructor(private config: EmaMsConfig) {}

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
