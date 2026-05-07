export type ServerTickCallback = (nowMs: number, deltaMs: number) => void;

/** Owns the host setInterval lifecycle and elapsed-time calculation.
 *  GameServer remains responsible for simulation work; this class keeps
 *  timer state and restart/stop behavior in one small place. */
export class ServerTickLoop {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;

  start(rateHz: number, callback: ServerTickCallback, nowMs = performance.now()): void {
    this.stop();
    this.lastTickTime = nowMs;
    this.interval = setInterval(() => {
      const tickNow = performance.now();
      const delta = tickNow - this.lastTickTime;
      this.lastTickTime = tickNow;
      callback(tickNow, delta);
    }, 1000 / rateHz);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  isRunning(): boolean {
    return this.interval !== null;
  }
}
