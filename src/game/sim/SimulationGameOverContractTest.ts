import {
  resolveCommanderGameOverWinner,
} from './SimulationGameOver';
import { WorldState } from './WorldState';
import { ENTITY_CHANGED_HP } from '@/types/network';
import { buildTeamRosterFromAssignment } from './teamRoster';
import type { PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[game-over contract] ${message}`);
}

export function runSimulationGameOverContractTest(): void {
  const world = new WorldState(1, 512, 512);
  const playerIds = [1, 2, 3] as PlayerId[];
  world.setTeamRoster(buildTeamRosterFromAssignment(
    playerIds,
    new Map<PlayerId, number>([[1, 1], [2, 1], [3, 2]]),
  ));
  const alliedCommanderA = world.createUnitFromBlueprint(80, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const alliedCommanderB = world.createUnitFromBlueprint(105, 80, 2, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const defeatedCommander = world.createUnitFromBlueprint(420, 420, 3, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  for (const entity of [
    alliedCommanderA,
    alliedCommanderB,
    defeatedCommander,
  ]) {
    world.addEntity(entity);
  }

  assertContract(
    resolveCommanderGameOverWinner(world, playerIds) === null,
    'two living enemy sides must keep the match running',
  );

  defeatedCommander.unit!.hp = 0;
  world.markSnapshotDirty(defeatedCommander.id, ENTITY_CHANGED_HP);
  assertContract(
    resolveCommanderGameOverWinner(world, playerIds) === 1,
    'multiple living allied commanders should win as one side',
  );

  alliedCommanderA.unit!.hp = 0;
  world.markSnapshotDirty(alliedCommanderA.id, ENTITY_CHANGED_HP);
  assertContract(
    resolveCommanderGameOverWinner(world, playerIds) === 2,
    'the winner field should identify a living member of the surviving side',
  );

  alliedCommanderB.unit!.hp = 0;
  world.markSnapshotDirty(alliedCommanderB.id, ENTITY_CHANGED_HP);
  assertContract(
    resolveCommanderGameOverWinner(world, playerIds) === null,
    'zero surviving commanders must not award an arbitrary winner',
  );
}
