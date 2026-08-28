// Rolling per-window statistics for pathfinding telemetry (SERVER bar).
//
// Telemetry only: never hashed, never serialized as lockstep state, never
// read by the simulation to make a decision. A window closes every
// PATHFINDING_TELEMETRY_WINDOW_TICKS ticks; readers see the last CLOSED
// window (steady) merged with the current one when nothing has closed yet,
// so the bar shows numbers within the first second of a match.

const PATHFINDING_TELEMETRY_WINDOW_TICKS = 100;

export class RollingTickStat {
  private curSum = 0;
  private curCount = 0;
  private curMax = 0;
  private lastSum = 0;
  private lastCount = 0;
  private lastMax = 0;
  private windowStartTick = 0;

  record(value: number): void {
    if (!Number.isFinite(value)) return;
    this.curSum += value;
    this.curCount += 1;
    if (value > this.curMax) this.curMax = value;
  }

  /** Close the window when its span has elapsed. */
  endTick(tick: number): void {
    if (tick - this.windowStartTick < PATHFINDING_TELEMETRY_WINDOW_TICKS) return;
    this.lastSum = this.curSum;
    this.lastCount = this.curCount;
    this.lastMax = this.curMax;
    this.curSum = 0;
    this.curCount = 0;
    this.curMax = 0;
    this.windowStartTick = tick;
  }

  /** Mean over the last closed window, or the open one before any closed. */
  average(): number {
    if (this.lastCount > 0) return this.lastSum / this.lastCount;
    if (this.curCount > 0) return this.curSum / this.curCount;
    return 0;
  }

  /** Worst sample across the last closed window and the open one. */
  worst(): number {
    return Math.max(this.lastMax, this.curMax);
  }

  reset(): void {
    this.curSum = 0;
    this.curCount = 0;
    this.curMax = 0;
    this.lastSum = 0;
    this.lastCount = 0;
    this.lastMax = 0;
    this.windowStartTick = 0;
  }
}

/** Per-player queue depths plus the rolling scalars the SERVER bar shows.
 *  Parallel arrays (one entry per player with any queue) keep the wire
 *  flat. Ticks for the latency scalars; the client converts with the
 *  authoritative tick rate. */
export type PathfindingTelemetry = {
  players: number[];
  route: number[];
  refine: number[];
  refresh: number[];
  /** Ticks a refine request waited in its queue before its search began. */
  waitAvg: number;
  waitWorst: number;
  /** Ticks from a unit's request to its full (non-coarse) route installing. */
  routeAvg: number;
  routeWorst: number;
  /** Wall milliseconds the pathfinding phase took per fixed tick. */
  msAvg: number;
  msWorst: number;
};
