import type { Entity } from '../../sim/types';
import { LinePathAccumulator } from './LinePathAccumulator';
import {
  buildFormationPreservingMoveTargets,
  buildLinePathMoveCommand,
} from './RightClickCommands';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[right-click commands contract] ${message}`);
  }
}

function unit(id: number, x: number, y: number, collisionRadius = 10): Entity {
  return {
    id,
    type: 'unit',
    transform: { x, y, z: 0, rotation: 0 },
    unit: { radius: { collision: collisionRadius } },
  } as Entity;
}

function targetDistance(
  targets: ReturnType<typeof buildFormationPreservingMoveTargets>,
  a: number,
  b: number,
): number {
  const first = targets.individualTargets[a];
  const second = targets.individualTargets[b];
  return Math.hypot(first.x - second.x, first.y - second.y);
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

  const tightTargets = buildFormationPreservingMoveTargets(
    [unit(10, -5, 0, 20), unit(11, 5, 0, 20)],
    200,
    200,
  );
  assertContract(
    targetDistance(tightTargets, 0, 1) >= 49,
    'preserved formation targets must expand tight collision-radius spacing',
  );
  assertContract(
    Math.abs((tightTargets.individualTargets[0].x + tightTargets.individualTargets[1].x) / 2 - 200) < 1e-6,
    'expanded preserved formation targets must stay centered on the command target',
  );

  const wideTargets = buildFormationPreservingMoveTargets(
    [unit(20, -80, 0, 20), unit(21, 80, 0, 20)],
    200,
    200,
  );
  assertContract(
    Math.abs(targetDistance(wideTargets, 0, 1) - 160) < 1e-6,
    'preserved formation targets must leave already-wide spacing unchanged',
  );
}
