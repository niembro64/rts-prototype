/**
 * Joining a match already in progress.
 *
 * Two pieces, tested together because neither means anything alone: the
 * archive the coordinator keeps, and the replay the joiner runs against it.
 *
 * The rule that matters most is the LAST one here: a replay that cannot beat
 * real time never arrives, and must say so with the measured number rather
 * than spinning forever. Replay speed is bounded by simulation step cost —
 * roughly 18 ms/tick at an entity cap of 1000 against a 50 ms real-time frame
 * at 20 Hz, and about 50 ms at 2500 — so this is a real limit, not a
 * hypothetical one.
 */

import { MatchCommandArchive } from './MatchCommandArchive';
import { LockstepCatchUp } from './LockstepCatchUp';
import type { LockstepCommandEnvelope } from './LockstepCommandProtocol';
import type { PlayerId } from '../sim/types';

const TICK_RATE_HZ = 20;

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[match catch-up contract] ${message}`);
}

function envelope(frame: number, sequence: number): LockstepCommandEnvelope {
  return {
    gameId: 'catch-up-test',
    executeFrame: frame,
    playerId: 1 as PlayerId,
    playerSequence: sequence,
    commandIndex: 0,
    command: { type: 'stop', tick: frame, entityIds: [] },
  };
}

function createClock(): { now: () => number; advance: (ms: number) => void } {
  let ms = 0;
  return { now: () => ms, advance: (delta) => { ms += delta; } };
}

export function runMatchCatchUpContractTest(): void {
  // --- the archive keeps commands, not silence -----------------------------
  {
    const archive = new MatchCommandArchive();
    for (let frame = 0; frame < 1000; frame++) {
      archive.append(frame, frame, frame % 100 === 0 ? [envelope(frame, frame)] : []);
    }
    const diagnostics = archive.getDiagnostics();
    assertContract(
      diagnostics.throughFrame === 999,
      'every frame moves the high-water mark, empty or not',
    );
    assertContract(
      diagnostics.storedFrameCount === 10,
      'only frames that carried a command are stored — the rest are reconstructible',
    );
    assertContract(
      diagnostics.commandCount === 10,
      'the archive counts what it holds so the cost is visible',
    );

    // The range is what makes an unlisted frame "empty" rather than "lost".
    const slice = archive.slice(0, 250);
    assertContract(
      slice.length === 3 && slice[0].frame === 0 && slice[2].frame === 200,
      'a slice returns exactly the stored frames inside its range',
    );
    assertContract(
      archive.slice(1000, 2000).length === 0,
      'a range past the end is empty, not an error',
    );
  }

  // --- the replay reaches a moving target ----------------------------------
  {
    const clock = createClock();
    const catchUp = new LockstepCatchUp({ tickRateHz: TICK_RATE_HZ, nowMs: clock.now });
    assertContract(catchUp.state === 'requesting', 'a joiner starts by asking to be let in');
    assertContract(catchUp.grant(600, 0), 'the grant starts the replay');
    assertContract(catchUp.state === 'replaying', 'a granted joiner replays');

    // Replaying at 4x real time: 2s of wall clock covers 160 frames of match.
    let frame = 0;
    for (let step = 0; step < 4; step++) {
      clock.advance(2000);
      frame += 160;
      // The match keeps being played while we replay, so the finish line moves.
      catchUp.setTargetFrame(600 + step * 40);
      catchUp.report(frame);
    }
    const progress = catchUp.getProgress();
    assertContract(
      progress.rateRealtime > 3.5 && progress.rateRealtime < 4.5,
      `replay rate must be measured against real time, got ${progress.rateRealtime}`,
    );
    assertContract(
      progress.etaSeconds !== null,
      'a converging replay can be projected, so the player is told how long',
    );

    clock.advance(2000);
    catchUp.report(1000);
    assertContract(
      catchUp.state === 'verifying',
      'reaching the target moves to verification, not straight to live',
    );
    assertContract(catchUp.verified(), 'a matching state hash lets the joiner in');
    assertContract(catchUp.state === 'live', 'a verified joiner is part of the match');
  }

  // --- a replay that cannot beat real time is refused, with the number ------
  {
    const clock = createClock();
    const catchUp = new LockstepCatchUp({
      tickRateHz: TICK_RATE_HZ,
      nowMs: clock.now,
      convergenceGraceMs: 1000,
    });
    catchUp.grant(100000, 0);

    // Replaying at 1x: every second of wall clock covers one second of match,
    // so the gap never closes.
    let frame = 0;
    for (let step = 0; step < 4; step++) {
      clock.advance(2000);
      frame += TICK_RATE_HZ * 2;
      catchUp.report(frame);
    }
    const progress = catchUp.getProgress();
    assertContract(
      catchUp.state === 'failed',
      'a replay running at real time never arrives and must give up',
    );
    assertContract(
      progress.failure === 'cannot-converge',
      'the refusal must say why, so a player is not left guessing',
    );
    assertContract(
      progress.rateRealtime > 0.9 && progress.rateRealtime < 1.1,
      'the measured rate is the explanation and must be reported',
    );
  }

  // --- a state mismatch is a hard stop, never a silent join ------------------
  {
    const clock = createClock();
    const catchUp = new LockstepCatchUp({ tickRateHz: TICK_RATE_HZ, nowMs: clock.now });
    catchUp.grant(100, 0);
    clock.advance(2000);
    catchUp.report(100);
    assertContract(catchUp.state === 'verifying', 'the target is reached');
    assertContract(catchUp.fail('state-mismatch'), 'a disagreeing replay is refused');
    assertContract(catchUp.state === 'failed', 'a refused joiner does not become live');
    assertContract(
      !catchUp.verified(),
      'a failed catch-up is terminal — nothing may talk it back into the match',
    );
  }

  console.log('[contract] match catch-up OK');
}
