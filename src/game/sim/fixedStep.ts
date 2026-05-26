export const SIM_TICK_RATE_HZ = 60;
export const SIM_STEP_MS = 1000 / SIM_TICK_RATE_HZ;
export const SIM_STEP_SEC = 1 / SIM_TICK_RATE_HZ;

const STEP_EPSILON_MS = 1e-7;

export class FixedStepAccumulator {
  private accumulatedMs = 0;

  consumeDeltaMs(deltaMs: number): number {
    if (Number.isFinite(deltaMs) && deltaMs > 0) {
      this.accumulatedMs += deltaMs;
    }

    let steps = 0;
    while (this.accumulatedMs + STEP_EPSILON_MS >= SIM_STEP_MS) {
      this.accumulatedMs -= SIM_STEP_MS;
      steps++;
    }
    if (Math.abs(this.accumulatedMs) < STEP_EPSILON_MS) this.accumulatedMs = 0;
    return steps;
  }

  getRemainderMs(): number {
    return this.accumulatedMs;
  }

  reset(): void {
    this.accumulatedMs = 0;
  }
}
