import { computed, ref, type Ref } from 'vue';
import type { PlayerId } from '../game/sim/types';

/**
 * Which players are falling behind the match, and by how much.
 *
 * Lockstep runs at the speed of its slowest participant: every peer must
 * have a frame's commands before anyone may execute it. So one player on a
 * bad connection does not lag alone — everybody stutters, and from the
 * inside it is indistinguishable from the game being broken. Naming who is
 * behind turns an unexplained freeze into something the table can act on.
 *
 * Progress comes from the frame coordinator, which is the only peer that
 * sees everyone's acks (see `RealBattlePeerFrameReport`).
 */

/** How far behind a peer must fall before it is called out. Below about a
 *  second, peers cross the line constantly on healthy connections and the
 *  indicator would flicker for no reason. */
const LAG_CALLOUT_SECONDS = 1;

/** Reports stop arriving when a battle ends or the coordinator goes away.
 *  Anything older than this is discarded rather than left on screen
 *  accusing a player who may already have gone. */
const REPORT_STALE_MS = 4000;

export type PeerFrameReport = {
  readonly coordinatorFrame: number;
  readonly tickRateHz: number;
  readonly peers: readonly { readonly playerId: PlayerId; readonly frame: number }[];
};

/** One player who is behind, with the gap already converted to seconds. */
export type LaggingPeer = {
  readonly playerId: PlayerId;
  readonly secondsBehind: number;
};

export type GameCanvasPeerLag = {
  /** Players currently behind, worst first. Empty when everyone is keeping
   *  up — the indicator is meant to be invisible in a healthy match. */
  readonly laggingPeers: Ref<readonly LaggingPeer[]>;
  recordPeerFrameReport: (report: PeerFrameReport) => void;
  /** Forget everything — a battle ended, so the last report means nothing. */
  clearPeerFrames: () => void;
};

export function useGameCanvasPeerLag(): GameCanvasPeerLag {
  const latestReport = ref<PeerFrameReport | null>(null);
  const latestReportAtMs = ref(0);
  /** Bumped on a timer so `laggingPeers` re-evaluates and can go stale even
   *  when no further reports arrive. */
  const staleTick = ref(0);
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  function stopStaleTimer(): void {
    if (staleTimer === null) return;
    clearInterval(staleTimer);
    staleTimer = null;
  }

  function recordPeerFrameReport(report: PeerFrameReport): void {
    latestReport.value = report;
    latestReportAtMs.value = Date.now();
    if (staleTimer === null) {
      staleTimer = setInterval(() => {
        staleTick.value++;
      }, 1000);
    }
  }

  function clearPeerFrames(): void {
    stopStaleTimer();
    latestReport.value = null;
    latestReportAtMs.value = 0;
  }

  const laggingPeers = computed<readonly LaggingPeer[]>(() => {
    // Read so the timer invalidates this even with no new report.
    void staleTick.value;
    const report = latestReport.value;
    if (report === null) return [];
    if (Date.now() - latestReportAtMs.value > REPORT_STALE_MS) return [];
    const tickRateHz = report.tickRateHz > 0 ? report.tickRateHz : 30;

    const behind: LaggingPeer[] = [];
    for (const peer of report.peers) {
      // A peer ahead of the coordinator is not a problem worth showing, and
      // rounding across a report boundary can briefly make one look ahead.
      const framesBehind = report.coordinatorFrame - peer.frame;
      if (framesBehind <= 0) continue;
      const secondsBehind = framesBehind / tickRateHz;
      if (secondsBehind < LAG_CALLOUT_SECONDS) continue;
      behind.push({ playerId: peer.playerId, secondsBehind });
    }
    behind.sort((a, b) => b.secondsBehind - a.secondsBehind);
    return behind;
  });

  return { laggingPeers, recordPeerFrameReport, clearPeerFrames };
}
