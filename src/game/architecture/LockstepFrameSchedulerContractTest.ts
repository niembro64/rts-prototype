import type { Command, MoveCommand } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import {
  LOCKSTEP_FIXED_DT_MS,
  LockstepFrameScheduler,
  type LockstepCompleteCommandFrame,
  type LockstepFrameSchedulerDiagnostics,
  type LockstepFrameSchedulerOptions,
} from './LockstepFrameScheduler';
import type { LockstepCommandEnvelope } from './LockstepCommandProtocol';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[lockstep frame scheduler contract] ${message}`);
  }
}

export function runLockstepFrameSchedulerContractTest(): void {
  let nowMs = 100;
  const core = createCore();
  const materializedOrders: string[] = [];
  const advancedFrames: number[] = [];
  const checksumFrames: number[] = [];
  const diagnostics: LockstepFrameSchedulerDiagnostics[] = [];
  const scheduler = new LockstepFrameScheduler({
    core,
    expectedPlayerIds: [1 as PlayerId, 2 as PlayerId],
    checksumIntervalTicks: 2,
    requirePeerReady: true,
    nowMs: () => nowMs,
    materializeCommandFrame: (frame) => {
      materializedOrders.push(frame.commands.map((envelope) => envelope.playerId).join(','));
      return frame.commands.map((envelope) => envelope.command);
    },
    onFrameAdvanced: (event) => advancedFrames.push(event.frame),
    onChecksum: (event) => checksumFrames.push(event.frame),
    onDiagnostics: (next) => diagnostics.push(next),
  });

  scheduler.receiveCommandFrame(createFrame(0, [
    createEnvelope(2 as PlayerId, 1, 0),
    createEnvelope(1 as PlayerId, 1, 0),
  ]));
  let result = scheduler.advanceReadyFrames();
  assertContract(result.advancedFrames === 0, 'scheduler must wait until required peers are ready');
  assertContract(
    scheduler.getDiagnostics().missingReadyPeerIds.join(',') === '1,2',
    'diagnostics must identify missing ready peers',
  );

  scheduler.markPeerReady(1 as PlayerId);
  scheduler.markPeerReady(2 as PlayerId);
  result = scheduler.advanceReadyFrames();
  assertContract(result.advancedFrames === 1, 'ready scheduler must advance the queued frame');
  assertContract(core.steps.length === 1, 'scheduler must step the core exactly once per frame');
  assertContract(core.steps[0].dtMs === LOCKSTEP_FIXED_DT_MS, 'scheduler must use fixed 60 Hz dt');
  assertContract(
    materializedOrders[0] === '1,2',
    'scheduler must present command frames to materialization in canonical order',
  );
  assertContract(advancedFrames.join(',') === '0', 'frame-advanced callback must report frame 0');

  nowMs = 250;
  result = scheduler.advanceReadyFrames();
  assertContract(result.advancedFrames === 0 && result.stalled, 'missing command frame must stall');
  assertContract(
    scheduler.getDiagnostics().missingFrame === 1 &&
      scheduler.getDiagnostics().stalledSinceMs === 250,
    'stall diagnostics must include missing frame and stall start time',
  );

  scheduler.receiveCommandFrame(createFrame(2, [createEnvelope(1 as PlayerId, 2, 2)]));
  result = scheduler.advanceReadyFrames(4);
  assertContract(result.advancedFrames === 0, 'out-of-order future frame must not advance past a gap');

  scheduler.receiveCommandFrame(createFrame(1, [createEnvelope(2 as PlayerId, 2, 1)]));
  result = scheduler.advanceReadyFrames(4);
  assertContract(result.advancedFrames === 2, 'scheduler must catch up only through ready frames');
  assertContract(
    core.steps.map((step) => step.frame).join(',') === '0,1,2',
    'catch-up must process frames in frame order',
  );
  assertContract(checksumFrames.join(',') === '2', 'checksum must emit at configured frame interval');

  scheduler.receiveCommandFrame(createFrame(3, [createEnvelope(1 as PlayerId, 3, 3)]));
  scheduler.pause(3, 'contract pause');
  result = scheduler.advanceReadyFrames();
  assertContract(result.advancedFrames === 0, 'protocol pause must stop advancement');
  assertContract(
    scheduler.getDiagnostics().status === 'protocol-paused' &&
      scheduler.getDiagnostics().pauseReason === 'contract pause',
    'pause diagnostics must be user-facing',
  );
  scheduler.resume(3);
  result = scheduler.advanceReadyFrames();
  assertContract(result.advancedFrames === 1, 'resume must allow ready frames to advance again');

  scheduler.receiveCommandFrame(createFrame(4, [createEnvelope(1 as PlayerId, 4, 4)]));
  scheduler.receiveCommandFrame(createFrame(5, [createEnvelope(1 as PlayerId, 5, 5)]));
  scheduler.receiveCommandFrame(createFrame(6, [createEnvelope(1 as PlayerId, 6, 6)]));
  result = scheduler.advanceReadyFrames(2);
  assertContract(result.advancedFrames === 2, 'catch-up must respect caller frame budget');
  assertContract(result.nextFrame === 6, 'bounded catch-up must leave later ready frames queued');
  result = scheduler.advanceReadyFrames(2);
  assertContract(result.advancedFrames === 1, 'remaining queued frame should advance on the next pump');

  assertContract(
    scheduler.getDiagnostics().tabThrottlingPolicy ===
      'stall-on-missing-frames-catch-up-ready-frames',
    'diagnostics must document the browser throttling policy',
  );
  assertContract(
    scheduler.getDiagnostics().performance.framesAdvancedTotal >= 7 &&
      scheduler.getDiagnostics().performance.simStepMsAvg >= 0 &&
      scheduler.getDiagnostics().performance.pumpMsAvg >= 0,
    'diagnostics must expose lockstep-specific performance telemetry',
  );
  assertContract(
    diagnostics.length > 0,
    'scheduler must publish diagnostics for UI/status surfaces',
  );
}

function createCore(): LockstepFrameSchedulerOptions['core'] & {
  readonly steps: Array<{ readonly frame: number; readonly dtMs: number; readonly commands: readonly Command[] }>;
} {
  let tick = 0;
  const steps: Array<{ frame: number; dtMs: number; commands: readonly Command[] }> = [];
  return {
    steps,
    world: {
      getTick: () => tick,
    } as LockstepFrameSchedulerOptions['core']['world'],
    stepFixedTick: (dtMs, commands = []) => {
      steps.push({ frame: tick, dtMs, commands });
      tick++;
    },
    getCanonicalStateHash: () => ({
      hash: `hash-${tick}`,
      sections: {
        world: `world-${tick}`,
        simulation: `simulation-${tick}`,
        economy: `economy-${tick}`,
        commands: `commands-${tick}`,
        entities: `entities-${tick}`,
      },
    }),
  };
}

function createFrame(
  frame: number,
  commands: readonly LockstepCommandEnvelope[],
): LockstepCompleteCommandFrame {
  return {
    frame,
    frameSequence: frame,
    commands,
  };
}

function createEnvelope(
  playerId: PlayerId,
  playerSequence: number,
  executeFrame: number,
): LockstepCommandEnvelope {
  return {
    gameId: 'contract-game',
    executeFrame,
    playerId,
    playerSequence,
    commandIndex: 0,
    command: createMoveCommand(executeFrame),
  };
}

function createMoveCommand(tick: number): MoveCommand {
  return {
    type: 'move',
    tick,
    entityIds: [7],
    targetX: 42,
    targetY: 84,
    waypointType: 'move',
    queue: false,
  };
}
