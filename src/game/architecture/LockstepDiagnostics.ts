import type { CanonicalServerStateHash } from './CanonicalStateHash';
import type { LockstepCompleteCommandFrame } from './LockstepFrameScheduler';
import type { PlayerId } from '../sim/types';

export type DeterministicLockstepReplayFile = {
  readonly schema: 'budget-annihilation.lockstep-replay.v1';
  readonly initializationHash: string;
  readonly fixedDtMs: number;
  readonly playerIds: readonly PlayerId[];
  readonly commandFrames: readonly LockstepCompleteCommandFrame[];
};

export function buildDeterministicLockstepReplayFile(options: {
  readonly initializationHash: string;
  readonly fixedDtMs: number;
  readonly playerIds: readonly PlayerId[];
  readonly commandFrames: readonly LockstepCompleteCommandFrame[];
}): DeterministicLockstepReplayFile {
  return {
    schema: 'budget-annihilation.lockstep-replay.v1',
    initializationHash: options.initializationHash,
    fixedDtMs: options.fixedDtMs,
    playerIds: [...options.playerIds].sort((a, b) => a - b),
    commandFrames: normalizeFrames(options.commandFrames),
  };
}

export function exportLockstepCommandFrameLog(
  commandFrames: readonly LockstepCompleteCommandFrame[],
): string {
  return JSON.stringify({
    schema: 'budget-annihilation.lockstep-command-frame-log.v1',
    commandFrames: normalizeFrames(commandFrames),
  }, null, 2);
}

export function exportLockstepStateHashDump(
  frame: number,
  stateHash: CanonicalServerStateHash,
): string {
  return JSON.stringify({
    schema: 'budget-annihilation.lockstep-state-hash-dump.v1',
    frame,
    stateHash,
  }, null, 2);
}

export function exportLockstepInitializationHash(initializationHash: string): string {
  return JSON.stringify({
    schema: 'budget-annihilation.lockstep-initialization-hash.v1',
    initializationHash,
  }, null, 2);
}

export function exportDeterministicLockstepReplayFile(
  replay: DeterministicLockstepReplayFile,
): string {
  return JSON.stringify(replay, null, 2);
}

function normalizeFrames(
  commandFrames: readonly LockstepCompleteCommandFrame[],
): LockstepCompleteCommandFrame[] {
  return commandFrames
    .map((frame) => ({
      frame: frame.frame,
      frameSequence: frame.frameSequence,
      commands: JSON.parse(JSON.stringify(frame.commands)) as LockstepCompleteCommandFrame['commands'],
    }))
    .sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence);
}
