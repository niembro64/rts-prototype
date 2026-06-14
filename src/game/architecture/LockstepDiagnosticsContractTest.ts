import type { CanonicalServerStateHash } from './CanonicalStateHash';
import {
  buildDeterministicLockstepReplayFile,
  exportDeterministicLockstepReplayFile,
  exportLockstepCommandFrameLog,
  exportLockstepInitializationHash,
  exportLockstepStateHashDump,
} from './LockstepDiagnostics';
import {
  LOCKSTEP_FIXED_DT_MS,
  type LockstepCompleteCommandFrame,
} from './LockstepFrameScheduler';
import type { PlayerId } from '../sim/types';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[lockstep diagnostics contract] ${message}`);
  }
}

export function runLockstepDiagnosticsContractTest(): void {
  const frames: LockstepCompleteCommandFrame[] = [
    { frame: 2, frameSequence: 2, commands: [] },
    { frame: 1, frameSequence: 1, commands: [] },
  ];
  const frameLog = JSON.parse(exportLockstepCommandFrameLog(frames)) as {
    schema?: string;
    commandFrames?: Array<{ frame: number }>;
  };
  assertContract(
    frameLog.schema === 'budget-annihilation.lockstep-command-frame-log.v1' &&
      frameLog.commandFrames?.[0]?.frame === 1,
    'command-frame log export must be versioned and sorted',
  );

  const stateDump = JSON.parse(exportLockstepStateHashDump(12, hash('abc'))) as {
    schema?: string;
    frame?: number;
    stateHash?: { hash?: string };
  };
  assertContract(
    stateDump.schema === 'budget-annihilation.lockstep-state-hash-dump.v1' &&
      stateDump.frame === 12 &&
      stateDump.stateHash?.hash === 'abc',
    'state hash dump export must include frame and sections',
  );

  const initDump = JSON.parse(exportLockstepInitializationHash('init')) as {
    schema?: string;
    initializationHash?: string;
  };
  assertContract(
    initDump.schema === 'budget-annihilation.lockstep-initialization-hash.v1' &&
      initDump.initializationHash === 'init',
    'initialization hash export must be versioned',
  );

  const replay = buildDeterministicLockstepReplayFile({
    initializationHash: 'init',
    fixedDtMs: LOCKSTEP_FIXED_DT_MS,
    playerIds: [2 as PlayerId, 1 as PlayerId],
    commandFrames: frames,
  });
  const replayJson = JSON.parse(exportDeterministicLockstepReplayFile(replay)) as {
    schema?: string;
    playerIds?: number[];
    commandFrames?: Array<{ frame: number }>;
  };
  assertContract(
    replayJson.schema === 'budget-annihilation.lockstep-replay.v1' &&
      replayJson.playerIds?.join(',') === '1,2' &&
      replayJson.commandFrames?.[0]?.frame === 1,
    'lockstep replay export must include sorted players and frames',
  );
}

function hash(value: string): CanonicalServerStateHash {
  return {
    hash: value,
    sections: {
      world: `${value}:world`,
      simulation: `${value}:simulation`,
      economy: `${value}:economy`,
      commands: `${value}:commands`,
      entities: `${value}:entities`,
    },
  };
}
