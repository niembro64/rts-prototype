/**
 * A joiner replaying the archive must land on the coordinator's exact state.
 *
 * This is the claim the whole join-in-progress feature rests on, and it is not
 * provable by inspection: it says that a simulation booted from the same
 * initialization and fed the same command frames reaches a bit-identical
 * world, including for the frames the archive deliberately did NOT store.
 *
 * That last part is the subtle one. Only frames carrying commands are kept, so
 * a replay reconstructs the empty ones from the range. If the reconstruction
 * were off by a single frame — one extra step, or one missed — the replayed
 * world would drift silently, and the checksum gate would refuse every join
 * with a mismatch nobody could explain. So the test replays through a real
 * archive rather than through a hand-written list of frames.
 */

import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import { disposeCheckpointCore } from './CanonicalCheckpoint';
import { LOCKSTEP_FIXED_DT_MS } from './LockstepFrameScheduler';
import { MatchCommandArchive } from './MatchCommandArchive';
import type { LockstepCommandEnvelope } from './LockstepCommandProtocol';
import { resetReusableSimulationStateForDeterministicReplay } from './DeterministicReplayHarness';
import {
  getAuthoritativeTerrainTileMap,
  setAuthoritativeTerrainTileMap,
} from '../sim/terrain/terrainState';

const REPLAY_TO_FRAME = 40;

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[match archive replay contract] ${message}`);
}

/** Same terrain discipline as the checkpoint contract test: the reset used by
 *  a from-scratch replay tears down the SHARED terrain mesh, which is right
 *  for a clean world and wrong inside a live page. Put it back. */
export function runMatchArchiveReplayContractTest(): void {
  const installedTerrain = getAuthoritativeTerrainTileMap();
  try {
    runMatchArchiveReplay();
  } finally {
    setAuthoritativeTerrainTileMap(installedTerrain);
  }
}

function runMatchArchiveReplay(): void {
  const config: GameServerConfig = {
    playerIds: [1 as PlayerId, 2 as PlayerId],
    centerMagnitude: 0,
    dividersMagnitude: 0,
    perimeterMagnitude: -800,
    terrainDTerrain: 0,
    plateauWallSlopeDegrees: 89,
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: 9,
    mapLengthLandCells: 9,
    converterTax: 0,
  };

  const archive = new MatchCommandArchive();
  let coordinatorHash = '';

  resetReusableSimulationStateForDeterministicReplay();
  const coordinator = new ServerSimulationCore(ServerBootstrap.bootstrap(config));
  try {
    // Play a match, archiving exactly the way the coordinator's pump does:
    // every frame moves the high-water mark, only some carry commands.
    for (let frame = 0; frame < REPLAY_TO_FRAME; frame++) {
      const commands = commandsForFrame(coordinator, frame);
      archive.append(frame, frame, commands);
      coordinator.stepFixedTick(
        LOCKSTEP_FIXED_DT_MS,
        commands.map((envelope) => envelope.command),
      );
    }
    coordinatorHash = coordinator.getCanonicalStateHash().hash;
  } finally {
    disposeCheckpointCore(coordinator);
  }

  const diagnostics = archive.getDiagnostics();
  assertContract(
    diagnostics.throughFrame === REPLAY_TO_FRAME - 1,
    'the archive must know how far the match got, empty frames included',
  );
  assertContract(
    diagnostics.storedFrameCount < REPLAY_TO_FRAME,
    'the archive must NOT be storing the empty frames — that is the point of it',
  );
  assertContract(diagnostics.storedFrameCount > 0, 'the fixture must issue some commands');

  // Now the joiner: a fresh world, fed the archive through the same
  // reconstruct-the-empties path a history chunk goes through.
  resetReusableSimulationStateForDeterministicReplay();
  const joiner = new ServerSimulationCore(ServerBootstrap.bootstrap(config));
  try {
    const byFrame = new Map<number, readonly LockstepCommandEnvelope[]>();
    for (const entry of archive.slice(0, archive.getThroughFrame())) {
      byFrame.set(entry.frame, entry.commands);
    }
    for (let frame = 0; frame <= archive.getThroughFrame(); frame++) {
      const commands = byFrame.get(frame) ?? [];
      joiner.stepFixedTick(
        LOCKSTEP_FIXED_DT_MS,
        commands.map((envelope) => envelope.command),
      );
    }

    assertContract(
      joiner.world.getTick() === REPLAY_TO_FRAME,
      `a replay must land on the coordinator's frame, got ${joiner.world.getTick()}`,
    );
    assertContract(
      joiner.getCanonicalStateHash().hash === coordinatorHash,
      'a replayed world must be bit-identical to the coordinator\'s — this is the ' +
        'claim the checksum gate refuses a join on',
    );
  } finally {
    disposeCheckpointCore(joiner);
  }

  console.log('[contract] match archive replay OK');
}

/** A handful of real orders spread across the match, so most frames are empty
 *  and the reconstruction is actually exercised. */
function commandsForFrame(
  core: ServerSimulationCore,
  frame: number,
): readonly LockstepCommandEnvelope[] {
  if (frame !== 0 && frame !== 12 && frame !== 25) return [];
  const playerId = (frame === 12 ? 2 : 1) as PlayerId;
  const commander = core.world.getCommander(playerId);
  if (commander === undefined) {
    throw new Error('[match archive replay contract] missing commander fixture');
  }
  const command: Command = {
    type: 'move',
    tick: frame,
    entityIds: [commander.id],
    targetX: commander.transform.x + 80 + frame,
    targetY: commander.transform.y + (frame === 25 ? 60 : 0),
    targetZ: commander.transform.z,
    waypointType: 'move',
    queue: false,
  };
  return [
    {
      gameId: 'archive-replay-contract',
      executeFrame: frame,
      playerId,
      playerSequence: frame,
      commandIndex: 0,
      command,
    },
  ];
}
