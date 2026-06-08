import type { Entity } from '../../sim/types';
import { LinePathAccumulator } from './LinePathAccumulator';
import { buildLinePathMoveCommand } from './RightClickCommands';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[right-click commands contract] ${message}`);
  }
}

function unit(id: number, x: number, y: number): Entity {
  return {
    id,
    type: 'unit',
    transform: { x, y, z: 0, rotation: 0 },
    unit: {},
  } as Entity;
}

export function runRightClickCommandsContractTest(): void {
  const units = [unit(1, 0, 0), unit(2, 20, 0)];

  const ownSpeedPath = new LinePathAccumulator();
  ownSpeedPath.start(100, 100, units.length, 5);
  const ownSpeedMove = buildLinePathMoveCommand(
    ownSpeedPath,
    units,
    'move',
    1,
    false,
    false,
    true,
    undefined,
  );
  assertContract(ownSpeedMove !== null, 'own-speed formation move must build');
  assertContract(
    ownSpeedMove.formationSpeed === undefined,
    'own-speed formation move must omit formationSpeed',
  );
  assertContract(
    ownSpeedMove.individualTargets?.length === units.length,
    'own-speed formation move must preserve per-unit targets',
  );

  const slowPath = new LinePathAccumulator();
  slowPath.start(100, 100, units.length, 5);
  const slowMove = buildLinePathMoveCommand(
    slowPath,
    units,
    'move',
    2,
    false,
    false,
    true,
    'slowest',
  );
  assertContract(slowMove !== null, 'slow formation move must build');
  assertContract(
    slowMove.formationSpeed === 'slowest',
    'slow formation move must carry formationSpeed=slowest',
  );
}
