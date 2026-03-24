// Generic EMA (Exponential Moving Average) tracker for real-time metrics.
// Used for FPS and snapshot rate tracking with asymmetric drop/recovery.
// Starts at an optimistic initial value so LOD begins at MAX quality.

export type { EmaConfig } from '@/types/game';
import type { EmaConfig } from '@/types/game';

export class EmaTracker {
  private avg: number;
  private low: number;
  private initialized: boolean;

  /**
   * @param config EMA alpha values
   * @param initialValue Optimistic starting value (e.g. 60 for FPS).
   *   If provided, EMA starts "full" and real samples pull it down.
   *   If omitted, waits for first sample (legacy behavior).
   */
  constructor(private config: EmaConfig, initialValue?: number) {
    if (initialValue !== undefined) {
      this.avg = initialValue;
      this.low = initialValue;
      this.initialized = true;
    } else {
      this.avg = 0;
      this.low = 0;
      this.initialized = false;
    }
  }

  update(value: number): void {
    if (!this.initialized) {
      this.avg = value;
      this.low = value;
      this.initialized = true;
    } else {
      this.avg = (1 - this.config.avg) * this.avg + this.config.avg * value;
      this.low = value < this.low
        ? (1 - this.config.low.drop) * this.low + this.config.low.drop * value
        : (1 - this.config.low.recovery) * this.low + this.config.low.recovery * value;
    }
  }

  getAvg(): number { return this.avg; }
  getLow(): number { return this.low; }
}
