import { computed, onUnmounted, ref, type Ref } from 'vue';
import { createStateMachine } from '../game/state/StateMachine';

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
 *
 * Driven by an explicit machine because three independent signals report the
 * departure (farewell message, closing socket, heartbeat silence) and two more
 * things end it (the countdown expiring, the player clicking through). Every
 * one of those can arrive at any moment, including after the exit has already
 * begun. The transition table names the only three states that exist and
 * refuses everything else, so "the host left twice" and "the countdown fired
 * after we already left" are answered once, here, instead of by a latch at
 * each of the five call sites.
 */

/** Long enough to read the reason, short enough not to feel stuck. */
const HOST_LEFT_EXIT_SECONDS = 5;

type EvictionState =
  /** No departure known; the normal state for an entire session. */
  | 'present'
  /** The host is gone and the countdown to the menu is running. */
  | 'announced'
  /** The exit has been performed; nothing further may restart it. */
  | 'exited';

type EvictionEvent =
  /** Any of the three departure signals. */
  | 'hostLeft'
  /** Countdown expired, or the player asked to leave now. */
  | 'exit';

type GameCanvasHostEviction = {
  /** Seconds left before the automatic exit, or null when not evicting.
   *  Drives the banner. */
  readonly hostLeftSecondsRemaining: Ref<number | null>;
  /** The host is gone — start the countdown. Repeat calls are refused by the
   *  machine, so callers do not latch. */
  beginHostLeftEviction: () => void;
  /** Leave now instead of waiting out the countdown. */
  exitAfterHostLeft: () => void;
};

export function useGameCanvasHostEviction(options: {
  exitToMenu: () => void;
}): GameCanvasHostEviction {
  const secondsRemaining = ref(HOST_LEFT_EXIT_SECONDS);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function clearCountdown(): void {
    if (countdownTimer === null) return;
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  const machine = createStateMachine<EvictionState, EvictionEvent>({
    name: 'host-eviction',
    initial: 'present',
    transitions: {
      // Only the first departure signal starts anything.
      present: { hostLeft: 'announced' },
      // Once announced, the only way out is leaving — a second departure
      // report cannot restart the countdown.
      announced: { exit: 'exited' },
      // Terminal for this session. A countdown tick that lands after the
      // player already clicked through has nowhere to go, which is the whole
      // reason the timer does not need its own guard.
      exited: {},
    },
    onTransition: ({ to }) => {
      if (to === 'announced') {
        secondsRemaining.value = HOST_LEFT_EXIT_SECONDS;
        countdownTimer = setInterval(() => {
          const remaining = secondsRemaining.value - 1;
          if (remaining > 0) {
            secondsRemaining.value = remaining;
            return;
          }
          exitAfterHostLeft();
        }, 1000);
        return;
      }
      if (to === 'exited') {
        clearCountdown();
        options.exitToMenu();
      }
    },
  });

  const state = ref<EvictionState>(machine.state);

  function beginHostLeftEviction(): void {
    // 'exited' is terminal for the SESSION that lost its host, not for the
    // page. This composable outlives sessions, so a departure in a LATER
    // session finds the machine parked on the old terminal state — reset it
    // to the top or the second eviction is refused and the client freezes
    // in a dead room.
    if (machine.state === 'exited') {
      machine.reset();
      state.value = machine.state;
    }
    if (!machine.send('hostLeft')) return;
    state.value = machine.state;
  }

  function exitAfterHostLeft(): void {
    if (!machine.send('exit')) return;
    state.value = machine.state;
  }

  /** Null unless the countdown is actually running, so the banner's own
   *  visibility is derived from the machine rather than tracked separately. */
  const hostLeftSecondsRemaining = computed(() =>
    state.value === 'announced' ? secondsRemaining.value : null,
  );

  onUnmounted(clearCountdown);

  return {
    hostLeftSecondsRemaining,
    beginHostLeftEviction,
    exitAfterHostLeft,
  };
}
