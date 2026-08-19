import { onUnmounted, ref, type Ref } from 'vue';

/**
 * What happens to everyone else when the host leaves.
 *
 * A session has exactly one host: it seats the players, coordinates the
 * lockstep frames, and is the only peer the others are actually connected to.
 * When it goes, nothing is left to be in — the lobby cannot start, a running
 * battle cannot advance another frame, and the remaining players are not even
 * connected to each other. Sitting in that state looks like a freeze, so
 * clients are ejected back to the menu instead.
 *
 * The eject is announced and delayed rather than instant. A screen that
 * vanishes mid-battle reads as a crash; a few seconds of "the host left" is
 * the difference between the game telling you what happened and appearing to
 * break. Players who would rather not wait can leave immediately.
 */

/** Long enough to read the reason, short enough not to feel stuck. */
const HOST_LEFT_EXIT_SECONDS = 5;

export type GameCanvasHostEviction = {
  /** Seconds left before the automatic exit, or null when not evicting.
   *  Doubles as the "is this happening" flag the banner renders from. */
  readonly hostLeftSecondsRemaining: Ref<number | null>;
  /** The host is gone — start the countdown. Ignores repeat calls. */
  beginHostLeftEviction: () => void;
  /** Leave now instead of waiting out the countdown. */
  exitAfterHostLeft: () => void;
};

export function useGameCanvasHostEviction(options: {
  exitToMenu: () => void;
}): GameCanvasHostEviction {
  const hostLeftSecondsRemaining = ref<number | null>(null);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function clearCountdown(): void {
    if (countdownTimer === null) return;
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function exitAfterHostLeft(): void {
    clearCountdown();
    hostLeftSecondsRemaining.value = null;
    options.exitToMenu();
  }

  function beginHostLeftEviction(): void {
    // A graceful host sends a farewell AND drops its connection, so this can
    // be reached twice for one departure. The first call owns the countdown.
    if (hostLeftSecondsRemaining.value !== null) return;
    hostLeftSecondsRemaining.value = HOST_LEFT_EXIT_SECONDS;
    countdownTimer = setInterval(() => {
      const remaining = (hostLeftSecondsRemaining.value ?? 0) - 1;
      if (remaining > 0) {
        hostLeftSecondsRemaining.value = remaining;
        return;
      }
      exitAfterHostLeft();
    }, 1000);
  }

  onUnmounted(clearCountdown);

  return {
    hostLeftSecondsRemaining,
    beginHostLeftEviction,
    exitAfterHostLeft,
  };
}
