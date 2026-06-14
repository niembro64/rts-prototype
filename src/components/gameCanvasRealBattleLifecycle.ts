export type GameCanvasRealBattleLifecycle = {
  beginStart(): number;
  clearTimers(): void;
  setStartTimeout(timeout: ReturnType<typeof setTimeout>): void;
  markStartTimeoutFired(): void;
  isCurrentStart(generation: number): boolean;
};

export function useGameCanvasRealBattleLifecycle(): GameCanvasRealBattleLifecycle {
  let startGeneration = 0;
  let startTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    startGeneration++;
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
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
  };
}
