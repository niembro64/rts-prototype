import { computed, ref, type Ref } from 'vue';
import { createStateMachine, type StateMachine } from '../game/state/StateMachine';
import type { PlayerId } from '../game/sim/types';

/**
 * Which players are falling behind the match, and by how much.
 *
 * Lockstep runs at the speed of its slowest SEATED player: the coordinator
 * will not mint a frame more than a window ahead of them (see
 * LockstepFlowControl). So one player on a bad connection does not lag alone —
 * everybody slows, and from the inside that is indistinguishable from the game
 * being broken. Naming who is behind turns an unexplained stutter into
 * something the table can act on.
 *
 * Informational only, and distinct from the match-hold banner: this names who
 * is BEHIND while everyone is still playing. When nothing is advancing at all,
 * the banner takes over and says who the match is being HELD for.
 *
 * Watchers never appear here. They hold no seat, so the coordinator never
 * waits on them and they are absent from what it reports.
 *
 * Progress comes from the frame coordinator, which is the only peer that sees
 * everyone's acks (see `RealBattlePeerFrameReport`).
 *
 * Each peer gets its own explicit machine rather than a recomputed boolean,
 * because "is this player behind" is a latched, deliberately asymmetric
 * condition. Measured healthy peers sit within a frame or two of the
 * coordinator but drift close to a second under load and spike past that, so
 * a plain threshold both blinks and accuses people for momentary hitches. The
 * machine therefore needs a reading to be bad twice running before it names
 * anyone, and needs a clearly good one to stop — and both rules are readable
 * as edges of the table rather than buried in comparisons.
 */

/** Gap at which a peer is called out. Above the drift healthy peers show
 *  under load, so ordinary stutter does not accuse anyone. */
const LAG_ENTER_SECONDS = 1.5;

/** Gap at which the callout is withdrawn. Lower than the entry threshold on
 *  purpose: without the gap, a peer hovering at the line flickers. */
const LAG_EXIT_SECONDS = 0.75;

/** Reports stop arriving when a battle ends or the coordinator goes away.
 *  Anything older than this is discarded rather than left on screen accusing
 *  a player who may already have gone. */
const REPORT_STALE_MS = 4000;

type PeerLagState =
  /** Within tolerance; nothing shown. */
  | 'keepingUp'
  /** Over the line once. Not yet accused — a single slow report is a spike,
   *  not a lagging player, and naming someone for it is worse than waiting. */
  | 'slipping'
  /** Over the line on consecutive reports; shown to everyone. */
  | 'behind';

type PeerLagEvent = 'overThreshold' | 'recovered';

type PeerFrameReport = {
  readonly coordinatorFrame: number;
  readonly tickRateHz: number;
  readonly peers: readonly { readonly playerId: PlayerId; readonly frame: number }[];
};

/** One player who is behind, with the gap already converted to seconds. */
export type LaggingPeer = {
  readonly playerId: PlayerId;
  readonly secondsBehind: number;
};

type GameCanvasPeerLag = {
  /** Players currently behind, worst first. Empty when everyone is keeping
   *  up — the indicator is meant to be invisible in a healthy match. */
  readonly laggingPeers: Ref<readonly LaggingPeer[]>;
  recordPeerFrameReport: (report: PeerFrameReport) => void;
  /** Forget everything — a battle ended, so the last report means nothing. */
  clearPeerFrames: () => void;
};

function createPeerMachine(): StateMachine<PeerLagState, PeerLagEvent> {
  return createStateMachine<PeerLagState, PeerLagEvent>({
    name: 'peer-lag',
    initial: 'keepingUp',
    transitions: {
      // Two consecutive over-threshold reports (about a second) before
      // anyone is named, so a momentary hitch never accuses a player.
      keepingUp: { overThreshold: 'slipping' },
      slipping: { overThreshold: 'behind', recovered: 'keepingUp' },
      // Leaving needs a clearly better reading, not merely a less bad one —
      // that asymmetry is the hysteresis, and it is why a peer hovering
      // around the entry threshold does not blink on and off.
      behind: { recovered: 'keepingUp' },
    },
  });
}

export function useGameCanvasPeerLag(): GameCanvasPeerLag {
  const machines = new Map<PlayerId, StateMachine<PeerLagState, PeerLagEvent>>();
  const secondsBehindByPeer = new Map<PlayerId, number>();
  /** Bumped on every accepted change so the computed re-evaluates; the
   *  machines themselves are deliberately not reactive. */
  const revision = ref(0);
  const lastReportAtMs = ref(0);
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  function stopStaleTimer(): void {
    if (staleTimer === null) return;
    clearInterval(staleTimer);
    staleTimer = null;
  }

  function machineFor(playerId: PlayerId): StateMachine<PeerLagState, PeerLagEvent> {
    const existing = machines.get(playerId);
    if (existing !== undefined) return existing;
    const created = createPeerMachine();
    machines.set(playerId, created);
    return created;
  }

  function recordPeerFrameReport(report: PeerFrameReport): void {
    lastReportAtMs.value = Date.now();
    const tickRateHz = report.tickRateHz > 0 ? report.tickRateHz : 30;
    let changed = false;

    for (const peer of report.peers) {
      // A peer ahead of the coordinator is not a problem worth showing, and
      // rounding across a report boundary can briefly make one look ahead.
      const framesBehind = Math.max(0, report.coordinatorFrame - peer.frame);
      const secondsBehind = framesBehind / tickRateHz;
      secondsBehindByPeer.set(peer.playerId, secondsBehind);
      const machine = machineFor(peer.playerId);
      if (secondsBehind >= LAG_ENTER_SECONDS) {
        if (machine.send('overThreshold')) changed = true;
      } else if (secondsBehind <= LAG_EXIT_SECONDS) {
        if (machine.send('recovered')) changed = true;
      }
      // Between the two thresholds every event is refused by the table, which
      // is exactly the hysteresis: the peer stays where it is.
    }

    // Always bump: the displayed gap moves even when the state does not.
    revision.value++;
    if (changed) revision.value++;

    if (staleTimer === null) {
      staleTimer = setInterval(() => {
        if (Date.now() - lastReportAtMs.value <= REPORT_STALE_MS) return;
        clearPeerFrames();
      }, 1000);
    }
  }

  function clearPeerFrames(): void {
    stopStaleTimer();
    machines.clear();
    secondsBehindByPeer.clear();
    lastReportAtMs.value = 0;
    revision.value++;
  }

  const laggingPeers = computed<readonly LaggingPeer[]>(() => {
    void revision.value;
    if (lastReportAtMs.value === 0) return [];
    if (Date.now() - lastReportAtMs.value > REPORT_STALE_MS) return [];
    const behind: LaggingPeer[] = [];
    for (const [playerId, machine] of machines) {
      if (!machine.is('behind')) continue;
      behind.push({ playerId, secondsBehind: secondsBehindByPeer.get(playerId) ?? 0 });
    }
    behind.sort((a, b) => b.secondsBehind - a.secondsBehind);
    return behind;
  });

  return { laggingPeers, recordPeerFrameReport, clearPeerFrames };
}
