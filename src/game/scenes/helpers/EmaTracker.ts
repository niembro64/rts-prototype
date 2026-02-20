// Generic EMA (Exponential Moving Average) tracker for real-time metrics.
// Used for FPS and snapshot rate tracking with asymmetric drop/recovery.

export interface EmaConfig {
  avg: number;
  low: { drop: number; recovery: number };
}

export class EmaTracker {
  private avg = 0;
  private low = 0;
  private initialized = false;

  constructor(private config: EmaConfig) {}

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
