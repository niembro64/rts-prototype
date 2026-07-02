type ServerTickCallback = (nowMs: number, deltaMs: number) => boolean | void;

type ServerTickLoopFrameStats = {
  nowMs: number;
  elapsedMs: number;
  stepsRun: number;
  droppedMs: number;
  accumulatorMs: number;
  fixedDeltaMs: number;
};

type ServerTickLoopOptions = {
  nowMs?: number;
  onFrame?: (stats: ServerTickLoopFrameStats) => void;
};

const MAX_CATCH_UP_WINDOW_MS = 25;
// Do not force a large catch-up burst on the main thread. At 30Hz the
// 25ms window allows one fixed step; the old minimum of five could turn a
// brief stall into a 70ms+ render-blocking sim callback.
const MIN_CATCH_UP_STEPS = 1;
const MAX_CATCH_UP_STEPS = 24;
const ACCUMULATOR_EPSILON_MS = 0.0001;
const MIN_TIME_SCALE = 0.01;
const MAX_TIME_SCALE = 20;

function sanitizeTimeScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(MIN_TIME_SCALE, Math.min(MAX_TIME_SCALE, value));
}

function catchUpStepLimit(fixedDeltaMs: number, timeScale: number): number {
  if (!Number.isFinite(fixedDeltaMs) || fixedDeltaMs <= 0) return MIN_CATCH_UP_STEPS;
  const scaleMultiplier = Math.max(1, Math.ceil(sanitizeTimeScale(timeScale)));
  const baseLimit = Math.max(
    MIN_CATCH_UP_STEPS,
    Math.min(MAX_CATCH_UP_STEPS, Math.ceil(MAX_CATCH_UP_WINDOW_MS / fixedDeltaMs)),
  );
  return Math.max(
    MIN_CATCH_UP_STEPS,
    Math.min(MAX_CATCH_UP_STEPS, baseLimit * scaleMultiplier),
  );
}

/** Owns the host setInterval lifecycle and elapsed-time calculation.
 *  GameServer remains responsible for simulation work; this class keeps
 *  timer state and restart/stop behavior in one small place. */
export class ServerTickLoop {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;
  private accumulatorMs = 0;
  private timeScale = 1;

  start(rateHz: number, callback: ServerTickCallback, options: ServerTickLoopOptions = {}): void {
    this.stop();
    const fixedDeltaMs = 1000 / rateHz;
    this.lastTickTime = options.nowMs ?? performance.now();
    this.accumulatorMs = 0;
    this.interval = setInterval(() => {
      const frameNow = performance.now();
      const elapsedMs = frameNow - this.lastTickTime;
      this.lastTickTime = frameNow;

      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;

      this.accumulatorMs += elapsedMs * this.timeScale;
      let stepsRun = 0;
      let droppedMs = 0;
      const maxCatchUpSteps = catchUpStepLimit(fixedDeltaMs, this.timeScale);

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

  setTimeScale(scale: number): number {
    this.timeScale = sanitizeTimeScale(scale);
    return this.timeScale;
  }

  getTimeScale(): number {
    return this.timeScale;
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
