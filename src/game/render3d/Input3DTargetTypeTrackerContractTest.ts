import {
  createEmptyEntityComponentSlots,
  createTransform,
  type Entity,
} from '@/types/sim';
import type { Command } from '../sim/commands';
import { Input3DTargetTypeTracker } from './Input3DTargetTypeTracker';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input target-type tracker contract] ${message}`);
  }
}

function host(id: number, x: number, y: number, priorityTargetId: number | null = null): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(x, y, 0, 0),
    ownership: { playerId: 1 },
    unit: { unitBlueprintId: 'unitMongoose', hp: 100, maxHp: 100 } as Entity['unit'],
    combat: {
      fireEnabled: true,
      fireState: 'fireAtWill',
      trajectoryMode: 'auto',
      manualLaunchActive: false,
      nextCombatProbeTick: -1,
      priorityTargetId,
      priorityTargetPoint: null,
      turrets: [
        {
          config: {
            visualOnly: false,
            passive: false,
            range: 100,
            shot: { type: 'projectile' },
          },
        },
      ],
    } as unknown as Entity['combat'],
  };
}

function unit(id: number, playerId: number, unitBlueprintId: string, x: number, y: number): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(x, y, 0, 0),
    ownership: { playerId },
    unit: { unitBlueprintId, hp: 100, maxHp: 100 } as Entity['unit'],
  };
}

export function runInput3DTargetTypeTrackerContractTest(): void {
  const commands: Command[] = [];
  let tick = 14;
  const selectedHost = host(1, 0, 0);
  const target = unit(2, 2, 'unitJackal', 120, 0);
  const wrongType = unit(3, 2, 'unitLynx', 40, 0);
  const alliedSameType = unit(4, 3, 'unitJackal', 30, 0);
  const units = [selectedHost, target, wrongType, alliedSameType];
  const tracker = new Input3DTargetTypeTracker({
    getEntitySource: () => ({
      getUnits: () => units,
      getEntity: (id) => units.find((entity) => entity.id === id),
      arePlayersAllied: (a, b) => a === 1 && b === 3,
    }),
    commandQueue: { enqueue: (command) => commands.push(command) },
    getTick: () => tick,
    getActivePlayerId: () => 1,
    getSelectedTargetableEntities: () => [selectedHost],
  });

  assertContract(
    tracker.trackSelectedTargetType(target.id),
    'BAR Alt+SetTarget-by-type must remember the clicked enemy unit blueprint for selected weapon hosts',
  );
  tracker.tick();
  assertContract(commands.length === 0, 'BAR target-type tracker must wait for the 15-frame polling cadence');
  tick = 15;
  tracker.tick();
  const command = commands[0];
  assertContract(
    command?.type === 'setTowerTarget' &&
      command.entityIds.length === 1 &&
      command.entityIds[0] === selectedHost.id &&
      command.targetId === target.id,
    'BAR target-type tracker must emit ordinary Set Target orders for matching enemies within 1.5x weapon range',
  );
  assertContract(
    commands.length === 1,
    'BAR target-type tracker must ignore allied or wrong-blueprint units while matching the tracked type',
  );

  tracker.clearSelected();
  tick = 30;
  tracker.tick();
  assertContract(commands.length === 1, 'BAR Stop/Clear Target cleanup must remove selected units from type tracking');

  const snappedId = tracker.trackNearestEnemyTypeAt({ x: 118, y: 4 });
  assertContract(
    snappedId === target.id,
    'BAR Alt+SetTarget ground clicks must snap to the nearest enemy unit within 100 elmos',
  );
}
