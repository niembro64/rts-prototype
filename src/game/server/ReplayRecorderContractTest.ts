import { ReplayRecorder } from './ReplayRecorder';
import type { Command } from '../sim/commands';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[replay recorder contract] ${message}`);
  }
}

export function runReplayRecorderContractTest(): void {
  const recorder = new ReplayRecorder({
    playerIds: [1, 2],
    initialAllowedUnitBlueprintIds: new Set(['unitJackal', 'unitTransport']),
  }, [1, 2]);
  const command: Command = {
    type: 'setPaused',
    tick: 0,
    paused: true,
  };
  recorder.recordAcceptedCommand(command, { mode: 'host-admin' }, 10, 123.5);
  command.paused = false;

  const replay = recorder.export(12, '2026-01-01T00:00:00.000Z');
  assertContract(replay.schema === 'budget-annihilation.replay.v1', 'schema should be stable');
  assertContract(replay.finalTick === 12, 'final tick should be exported');
  assertContract(replay.commands.length === 1, 'accepted commands should be recorded');
  assertContract(
    replay.commands[0].command.type === 'setPaused' &&
      replay.commands[0].command.paused === true,
    'recorded commands should be cloned at record time',
  );
  assertContract(
    JSON.stringify(replay.initialConfig).includes('unitTransport'),
    'initial config should JSON-normalize set values',
  );
}
