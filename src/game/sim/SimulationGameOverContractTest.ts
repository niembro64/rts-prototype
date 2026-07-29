import {
  markDefeatedPlayerEntitiesForDestruction,
  resolveCommanderGameOverWinner,
} from './SimulationGameOver';
import { WorldState } from './WorldState';
import { ENTITY_CHANGED_HP } from '@/types/network';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[game-over contract] ${message}`);
}

export function runSimulationGameOverContractTest(): void {
  const world = new WorldState(1, 512, 512);
  const winner = world.createUnitFromBlueprint(80, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const defeatedCommander = world.createUnitFromBlueprint(420, 420, 2, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const defeatedUnit = world.createUnitFromBlueprint(400, 420, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const defeatedBuilding = world.createBuilding(400, 390, 32, 32, 24, 2);
  const neutralBuilding = world.createBuilding(250, 250, 32, 32, 24);
  for (const entity of [
    winner,
    defeatedCommander,
    defeatedUnit,
    defeatedBuilding,
    neutralBuilding,
  ]) {
    world.addEntity(entity);
  }

  defeatedCommander.unit!.hp = 0;
  world.markSnapshotDirty(defeatedCommander.id, ENTITY_CHANGED_HP);
  assertContract(
    resolveCommanderGameOverWinner(world, [1, 2]) === 1,
    'the last living commander should win',
  );

  markDefeatedPlayerEntitiesForDestruction(world, 1);
  assertContract(winner.unit!.hp > 0, 'the winning commander must survive the wipeout');
  assertContract(defeatedUnit.unit!.hp === 0, 'defeated mobile units must be destroyed');
  assertContract(defeatedBuilding.building!.hp === 0, 'defeated buildings must be destroyed');
  assertContract(neutralBuilding.building!.hp > 0, 'neutral world entities must survive');

  const pendingDeathIds: number[] = [];
  world.drainPendingDeathCheckIds(pendingDeathIds);
  assertContract(
    pendingDeathIds.includes(defeatedUnit.id) &&
      pendingDeathIds.includes(defeatedBuilding.id),
    'defeated entities must use the normal explosive death-cleanup path',
  );
}
