export type ServerTickCallback = (nowMs: number, deltaMs: number) => boolean | void;

export type ServerTickLoopFrameStats = {
  nowMs: number;
  elapsedMs: number;
  stepsRun: number;
  droppedMs: number;
  accumulatorMs: number;
  fixedDeltaMs: number;
};

export type ServerTickLoopOptions = {
  nowMs?: number;
  onFrame?: (stats: ServerTickLoopFrameStats) => void;
};

const MAX_CATCH_UP_WINDOW_MS = 50;
const MIN_CATCH_UP_STEPS = 5;
const MAX_CATCH_UP_STEPS = 24;
const ACCUMULATOR_EPSILON_MS = 0.0001;

function catchUpStepLimit(fixedDeltaMs: number): number {
  if (!Number.isFinite(fixedDeltaMs) || fixedDeltaMs <= 0) return MIN_CATCH_UP_STEPS;
  return Math.max(
    MIN_CATCH_UP_STEPS,
    Math.min(MAX_CATCH_UP_STEPS, Math.ceil(MAX_CATCH_UP_WINDOW_MS / fixedDeltaMs)),
  );
}

/** Owns the host setInterval lifecycle and elapsed-time calculation.
 *  GameServer remains responsible for simulation work; this class keeps
 *  timer state and restart/stop behavior in one small place. */
export class ServerTickLoop {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;
  private accumulatorMs = 0;

  start(rateHz: number, callback: ServerTickCallback, options: ServerTickLoopOptions = {}): void {
    this.stop();
    const fixedDeltaMs = 1000 / rateHz;
    const maxCatchUpSteps = catchUpStepLimit(fixedDeltaMs);
    this.lastTickTime = options.nowMs ?? performance.now();
    this.accumulatorMs = 0;
    this.interval = setInterval(() => {
      const frameNow = performance.now();
      const elapsedMs = frameNow - this.lastTickTime;
      this.lastTickTime = frameNow;

      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;

      this.accumulatorMs += elapsedMs;
      let stepsRun = 0;
      let droppedMs = 0;

      while (
        this.accumulatorMs + ACCUMULATOR_EPSILON_MS >= fixedDeltaMs &&
        stepsRun < maxCatchUpSteps
      ) {
        const didRun = callback(frameNow, fixedDeltaMs);
        if (didRun === false) {
          this.accumulatorMs = 0;
          options.onFrame?.({
            nowMs: frameNow,
            elapsedMs,
            stepsRun: 0,
            droppedMs: 0,
            accumulatorMs: 0,
            fixedDeltaMs,
          });
          return;
        }
        this.accumulatorMs -= fixedDeltaMs;
        stepsRun++;
      }

      if (stepsRun >= maxCatchUpSteps && this.accumulatorMs >= fixedDeltaMs) {
        droppedMs = this.accumulatorMs;
        this.accumulatorMs = 0;
      }

      options.onFrame?.({
        nowMs: frameNow,
        elapsedMs,
        stepsRun,
        droppedMs,
        accumulatorMs: this.accumulatorMs,
        fixedDeltaMs,
      });
    }, fixedDeltaMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
    this.accumulatorMs = 0;
  }

  isRunning(): boolean {
    return this.interval !== null;
  }
}
