/**
 * The match runs at the speed of its slowest SEATED player, and stops for one
 * who is gone — but never for a watcher.
 *
 * These are the rules that make "WAITING FOR" honest. Before flow control the
 * coordinator minted frames off a wall clock and never read an ack for
 * anything but resends, so the indicator named who was behind while nobody
 * waited.
 */

import { LockstepFlowControl, type SeatedPeerProgress } from './LockstepFlowControl';
import type { LockstepFlowControlConfig } from '@/architectureConfig';
import type { PlayerId } from '../sim/types';

const TICK_RATE_HZ = 20;

const CONFIG: LockstepFlowControlConfig = {
  lagWindowTicks: 30,
  pauseAfterSeconds: 5,
  resumeWithinSeconds: 1,
  pauseGraceMs: 750,
  dropAfterSeconds: 90,
};

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[lockstep flow control contract] ${message}`);
}

/** A clock the test drives, so grace windows are exercised rather than waited
 *  out. Flow control measures time rather than counting pumps precisely
 *  because pump cadence varies under the load it is watching for. */
function createClock(): { now: () => number; advance: (ms: number) => void } {
  let ms = 0;
  return { now: () => ms, advance: (delta) => { ms += delta; } };
}

function peer(playerId: number, ackFrame: number | null, connected = true): SeatedPeerProgress {
  return { playerId: playerId as PlayerId, ackFrame, connected };
}

export function runLockstepFlowControlContractTest(): void {
  // --- everyone keeping up: the wall clock is the only limit ----------------
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    const decision = flow.report(100, [peer(2, 99), peer(3, 100)], 4);
    assertContract(decision.state === 'running', 'peers inside the window keep the match running');
    assertContract(decision.allowedFrames === 4, 'a healthy match is limited only by real time');
    assertContract(decision.subjectPlayerId === null, 'nobody is named while everyone keeps up');
  }

  // --- a peer that has not acked yet is unknown, not maximally behind -------
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    const decision = flow.report(200, [peer(2, null)], 3);
    assertContract(
      decision.state === 'running' && decision.allowedFrames === 3,
      'a peer that has never acked must not be counted as behind at match start',
    );
  }

  // --- past the window, the coordinator throttles to the slowest ------------
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    const decision = flow.report(100, [peer(2, 60)], 8);
    assertContract(decision.state === 'throttled', '40 frames behind a 30-frame window must throttle');
    assertContract(
      decision.allowedFrames === 0,
      'past the window the coordinator must mint nothing until the peer catches up',
    );
    assertContract(decision.subjectPlayerId === 2, 'the throttle must name who it is waiting on');

    // Inside the window again, but not all the way caught up. Ask for more
    // frames than the remaining headroom so the clamp is what is measured.
    const recovering = flow.report(100, [peer(2, 80)], 25);
    assertContract(
      recovering.state === 'running',
      'back inside the window is back to running',
    );
    assertContract(
      recovering.allowedFrames === 10,
      'headroom is what is left of the window, so the gap cannot grow again',
    );
  }

  // --- a spike is not a lagging player -------------------------------------
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    // 200 frames = 10s behind at 20Hz, well past the pause threshold.
    const first = flow.report(300, [peer(2, 100)], 4);
    assertContract(
      first.state !== 'paused',
      'one bad reading must not stop the match — that is what the grace window is for',
    );
    clock.advance(CONFIG.pauseGraceMs + 1);
    const sustained = flow.report(300, [peer(2, 100)], 4);
    assertContract(sustained.state === 'paused', 'a sustained gap must stop the match');
    assertContract(sustained.allowedFrames === 0, 'a paused match mints no frames');
    assertContract(sustained.subjectPlayerId === 2, 'a pause must name its subject');
    assertContract(sustained.reason === 'far-behind', 'a connected straggler is not a disconnect');
    assertContract(sustained.pauseChanged, 'the pause edge must be reported once so it broadcasts once');

    const stillPaused = flow.report(300, [peer(2, 100)], 4);
    assertContract(
      !stillPaused.pauseChanged,
      'holding a pause must not re-broadcast it every pump',
    );

    // Hysteresis: back inside the window is not enough, it has to be clearly
    // good. 25 frames = 1.25s, above resumeWithinSeconds.
    const halfway = flow.report(300, [peer(2, 275)], 4);
    assertContract(halfway.state === 'paused', 'a merely-less-bad reading must not resume');
    const recovered = flow.report(300, [peer(2, 295)], 4);
    assertContract(recovered.state === 'running', 'a clearly good reading resumes the match');
    assertContract(recovered.pauseChanged, 'the resume edge must be reported once');
  }

  // --- a silent peer is a subject however good its last ack looked ----------
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    flow.report(100, [peer(2, 100, false)], 4);
    clock.advance(CONFIG.pauseGraceMs + 1);
    const decision = flow.report(100, [peer(2, 100, false)], 4);
    assertContract(
      decision.state === 'paused' && decision.reason === 'disconnected',
      'a peer whose socket died a frame after acking must still stop the match',
    );

    // ...and the wait is bounded. One closed laptop must not end the evening.
    clock.advance(CONFIG.dropAfterSeconds * 1000 + 1);
    const dropping = flow.report(100, [peer(2, 100, false)], 4);
    assertContract(
      dropping.dropPlayerIds.length === 1 && dropping.dropPlayerIds[0] === 2,
      'a subject past the drop timeout must be resigned',
    );
    const afterDrop = flow.report(100, [peer(2, 100, false)], 4);
    assertContract(
      afterDrop.dropPlayerIds.length === 0,
      'a resign is a gameplay command and must be issued once, not every pump',
    );
  }

  // --- the drop clock measures silence, not wall time held ------------------
  //
  // A rejoiner replays a long match back from frame 0, which can take far
  // longer than `dropAfterSeconds`. Its acks move the whole time — and they
  // move through values BELOW its old ones, so change is the signal, not
  // increase. Resigning a seat whose owner is actively replaying would remove
  // an army seconds from being commanded again.
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });

    // Socket dies at frame 400 with a healthy last ack; the pause latches.
    flow.report(400, [peer(2, 399, false)], 4);
    clock.advance(CONFIG.pauseGraceMs + 1);
    const paused = flow.report(400, [peer(2, 399, false)], 4);
    assertContract(paused.state === 'paused' && paused.reason === 'disconnected',
      'a dead socket must pause the match');

    // Back on a socket, replaying from frame 0. Wall time spent replaying
    // exceeds the drop timeout, but every reading shows a new ack.
    const dropMs = CONFIG.dropAfterSeconds * 1000;
    let replayFrame = 0;
    for (let i = 0; i < 8; i++) {
      clock.advance(dropMs / 4);
      replayFrame += 40;
      const replaying = flow.report(400, [peer(2, replayFrame)], 4);
      assertContract(
        replaying.dropPlayerIds.length === 0,
        'a subject whose acks are moving must never be resigned, however long the replay',
      );
      assertContract(replaying.state === 'paused', 'the match stays held while the replay runs');
    }

    // The replay wedges: acks stop moving. NOW the clock runs out.
    clock.advance(dropMs + 1);
    const wedged = flow.report(400, [peer(2, replayFrame)], 4);
    assertContract(
      wedged.dropPlayerIds.length === 1 && wedged.dropPlayerIds[0] === 2,
      'a subject whose acks have stopped must be resigned once the clock runs out',
    );
  }

  // --- an empty completion set never holds anything -------------------------
  //
  // This is the watcher case: a spectator holds no seat, so it never appears
  // in what flow control is given. A solo host with only watchers attached
  // must therefore run at full speed.
  {
    const clock = createClock();
    const flow = new LockstepFlowControl({ tickRateHz: TICK_RATE_HZ, config: CONFIG, nowMs: clock.now });
    clock.advance(CONFIG.pauseGraceMs * 10);
    const decision = flow.report(5000, [], 6);
    assertContract(
      decision.state === 'running' && decision.allowedFrames === 6,
      'watchers hold no seat, so no number of them can slow or stop a match',
    );
    assertContract(decision.subjectPlayerId === null, 'nobody can be named when nobody is seated');
  }

  console.log('[contract] lockstep flow control OK');
}
