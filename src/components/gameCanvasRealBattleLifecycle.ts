export type GameCanvasRealBattleLifecycle = {
  beginStart(): number;
  clearTimers(): void;
  setStartTimeout(timeout: ReturnType<typeof setTimeout>): void;
  markStartTimeoutFired(): void;
  isCurrentStart(generation: number): boolean;
  /** Register the live battle backend's stop. Every teardown funnels through
   *  `clearTimers()` (exit home, return to lobby, a new start), and before
   *  this hook none of them stopped the backend once a start had COMPLETED —
   *  the lockstep pump interval outlived the battle it was pumping. */
  adoptBackendStop(stop: () => void): void;
};

export function useGameCanvasRealBattleLifecycle(): GameCanvasRealBattleLifecycle {
  let startGeneration = 0;
  let startTimeout: ReturnType<typeof setTimeout> | null = null;
  let backendStop: (() => void) | null = null;

  function clearTimers(): void {
    startGeneration++;
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
    const stop = backendStop;
    backendStop = null;
    if (stop !== null) stop();
  }

  function beginStart(): number {
    clearTimers();
    return startGeneration;
  }

  return {
    beginStart,
    clearTimers,
    setStartTimeout(timeout) {
      if (startTimeout) clearTimeout(startTimeout);
      startTimeout = timeout;
    },
    markStartTimeoutFired() {
      startTimeout = null;
    },
    isCurrentStart(generation) {
      return startGeneration === generation;
    },
    adoptBackendStop(stop) {
      // A previous battle's backend still registered here means no teardown
      // ran between two starts; stop it rather than orphan its pump.
      const previous = backendStop;
      backendStop = stop;
      if (previous !== null) previous();
    },
  };
}
