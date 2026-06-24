import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import {
  disposeCheckpointCore,
  exportCanonicalCheckpoint,
  importCanonicalCheckpoint,
  type CanonicalCheckpoint,
  type CanonicalCheckpointCommandFrame,
} from './CanonicalCheckpoint';
import { LOCKSTEP_FIXED_DT_MS } from './LockstepFrameScheduler';
import { resetReusableSimulationStateForDeterministicReplay } from './DeterministicReplayHarness';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[canonical checkpoint contract] ${message}`);
  }
}

export function runCanonicalCheckpointContractTest(): void {
  const config: GameServerConfig = {
    playerIds: [1 as PlayerId, 2 as PlayerId],
    centerMagnitude: 0,
    dividersMagnitude: 0,
    perimeterMagnitude: -800,
    terrainDTerrain: 0,
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: 9,
    mapLengthLandCells: 9,
    converterTax: 0,
  };

  resetReusableSimulationStateForDeterministicReplay();
  const baseline = new ServerSimulationCore(ServerBootstrap.bootstrap(config));
  let checkpoint: CanonicalCheckpoint;
  let baselineFrame30Hash: string;
  try {
    const commandFrames = createCommandFrames(baseline);
    stepCoreToFrame(baseline, 20, commandFrames);
    checkpoint = exportCanonicalCheckpoint({
      core: baseline,
      config,
      commandFrames,
      initializationHash: 'checkpoint-contract-init',
    });
    assertContract(
      checkpoint.schema === 'budget-annihilation.canonical-checkpoint.v1',
      'checkpoint schema must be versioned',
    );
    assertContract(
      checkpoint.format === 'deterministic-command-log.v1',
      'checkpoint format must be explicit',
    );
    assertContract(
      checkpoint.stateHash.hash === baseline.getCanonicalStateHash().hash,
      'checkpoint must carry the frame-N state hash',
    );
    stepCoreToFrame(baseline, 30, []);
    baselineFrame30Hash = baseline.getCanonicalStateHash().hash;
  } finally {
    disposeCheckpointCore(baseline);
  }

  const imported = importCanonicalCheckpoint(checkpoint);
  try {
    assertContract(
      imported.verifiedHash.hash === checkpoint.stateHash.hash,
      'import must reproduce the exported frame hash',
    );
    stepCoreToFrame(imported.core, 30, []);
    assertContract(
      imported.core.getCanonicalStateHash().hash === baselineFrame30Hash,
      'imported checkpoint must continue deterministically after frame N',
    );
  } finally {
    disposeCheckpointCore(imported.core);
  }
}

function createCommandFrames(core: ServerSimulationCore): CanonicalCheckpointCommandFrame[] {
  const commander = core.world.getCommander(1 as PlayerId);
  if (commander === undefined) {
    throw new Error('[canonical checkpoint contract] missing commander fixture');
  }
  const command: Command = {
    type: 'move',
    tick: 0,
    entityIds: [commander.id],
    targetX: commander.transform.x + 120,
    targetY: commander.transform.y,
    targetZ: commander.transform.z,
    waypointType: 'move',
    queue: false,
  };
  return [{ frame: 0, frameSequence: 0, commands: [command] }];
}

function stepCoreToFrame(
  core: ServerSimulationCore,
  targetFrame: number,
  commandFrames: readonly CanonicalCheckpointCommandFrame[],
): void {
  const commandsByFrame = new Map<number, readonly Command[]>();
  for (const frame of commandFrames) commandsByFrame.set(frame.frame, frame.commands);
  while (core.world.getTick() < targetFrame) {
    const frame = core.world.getTick();
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, commandsByFrame.get(frame) ?? []);
  }
}
