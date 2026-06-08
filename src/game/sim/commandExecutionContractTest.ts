import { ConstructionSystem } from './construction';
import {
  buildMassAwareGroupFormationSlots,
  executeCommand,
  resolvePathableFormationTarget,
  type CommandContext,
} from './commandExecution';
import type { Entity } from './types';
import { setUnitActions } from './unitActions';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[command execution contract] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[command execution contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function damageUnit(entity: Entity, damage = 10): Entity {
  assertContract(entity.unit !== null, 'test target must be a unit');
  entity.unit.hp = Math.max(1, entity.unit.maxHp - damage);
  return entity;
}

function assertActionTargetIds(actions: readonly { targetId?: number }[], expected: readonly number[], message: string): void {
  assertContract(actions.length === expected.length, `${message}: expected ${expected.length} action(s), got ${actions.length}`);
  for (let i = 0; i < expected.length; i++) {
    assertContract(
      actions[i].targetId === expected[i],
      `${message}: action ${i} expected target ${expected[i]}, got ${actions[i].targetId ?? 'none'}`,
    );
  }
}

export function runCommandExecutionContractTest(): void {
  const layoutWorld = new WorldState(1, 512, 512);
  const sameRadiusUnits = [
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
  ];
  const heaviest = sameRadiusUnits[3];
  heaviest.unit!.mass = 10000;
  const massSlots = buildMassAwareGroupFormationSlots(sameRadiusUnits);
  const heaviestSlot = massSlots.find((slot) => slot.unit.id === heaviest.id);
  assertContract(heaviestSlot !== undefined, 'mass-aware formation slots must include every unit');
  assertNear(heaviestSlot.offsetX, 0, 'heaviest same-radius unit should receive a central column');

  const bigUnit = layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitFormik', {
    allocateSubEntityIds: false,
  });
  const mixedSlots = buildMassAwareGroupFormationSlots([
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    bigUnit,
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
  ]);
  const bigSlot = mixedSlots.find((slot) => slot.unit.id === bigUnit.id);
  assertContract(bigSlot !== undefined, 'collision-aware formation slots must include the large unit');
  assertNear(bigSlot.offsetX, 0, 'large collision unit should receive a central column');
  assertContract(
    Math.max(...mixedSlots.map((slot) => Math.abs(slot.offsetX))) > 80,
    'large collision unit must widen neighboring formation columns',
  );

  const world = new WorldState(1, 512, 512);
  const construction = new ConstructionSystem(world.mapWidth, world.mapHeight);
  const grid = construction.getGrid();
  const unit = world.createUnitFromBlueprint(80, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(unit);

  const open = resolvePathableFormationTarget(world, grid, unit, 180, 240);
  assertNear(open.x, 180, 'open formation target x should remain exact');
  assertNear(open.y, 240, 'open formation target y should remain exact');
  assertNear(open.z, world.getGroundZ(180, 240), 'open formation target z should use terrain');

  const blockedTarget = { x: 260, y: 240 };
  const blockedCell = grid.worldToGrid(blockedTarget.x, blockedTarget.y);
  const blockGridX = blockedCell.gx - 4;
  const blockGridY = blockedCell.gy - 4;
  grid.place(blockGridX, blockGridY, 9, 9, 9001, 2, true);

  const snapped = resolvePathableFormationTarget(
    world,
    grid,
    unit,
    blockedTarget.x,
    blockedTarget.y,
  );
  const snappedCell = grid.worldToGrid(snapped.x, snapped.y);
  const insideBlockedFootprint =
    snappedCell.gx >= blockGridX &&
    snappedCell.gx < blockGridX + 9 &&
    snappedCell.gy >= blockGridY &&
    snappedCell.gy < blockGridY + 9;

  assertContract(
    !insideBlockedFootprint,
    'blocked formation target must snap outside occupied movement footprint',
  );
  assertNear(
    snapped.z,
    world.getGroundZ(snapped.x, snapped.y),
    'snapped formation target z should follow snapped terrain',
  );

  const queueWorld = new WorldState(1, 512, 512);
  const queueConstruction = new ConstructionSystem(queueWorld.mapWidth, queueWorld.mapHeight);
  const queueCtx: CommandContext = {
    world: queueWorld,
    constructionSystem: queueConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const commander = queueWorld.createUnitFromBlueprint(60, 100, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const near = damageUnit(queueWorld.createUnitFromBlueprint(104, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const mid = damageUnit(queueWorld.createUnitFromBlueprint(122, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const far = damageUnit(queueWorld.createUnitFromBlueprint(141, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const healthyInside = queueWorld.createUnitFromBlueprint(110, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const outside = damageUnit(queueWorld.createUnitFromBlueprint(170, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  queueWorld.addEntity(commander);
  queueWorld.addEntity(far);
  queueWorld.addEntity(healthyInside);
  queueWorld.addEntity(mid);
  queueWorld.addEntity(outside);
  queueWorld.addEntity(near);

  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 1,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
  });
  assertContract(commander.unit !== null, 'commander must have a unit component');
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, mid.id, far.id],
    'repair-area command should enqueue all damaged targets by distance',
  );

  setUnitActions(commander.unit, [
    { type: 'move', x: 80, y: 100 },
    { type: 'wait', x: 82, y: 100 },
  ]);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 2,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: true,
    queueFront: true,
  });
  assertActionTargetIds(
    commander.unit.actions.slice(1, 4),
    [near.id, mid.id, far.id],
    'front-queued repair area should preserve nearest-to-farthest order',
  );
  assertContract(
    commander.unit.actions[4].type === 'wait',
    'front-queued repair area should preserve existing queued orders behind inserted targets',
  );

  setUnitActions(commander.unit, [
    { type: 'move', x: 70, y: 100 },
    { type: 'wait', x: 72, y: 100 },
  ]);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 3,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: true,
    queueInsertIndex: 1,
  });
  assertActionTargetIds(
    commander.unit.actions.slice(1, 4),
    [near.id, mid.id, far.id],
    'inserted repair area should preserve nearest-to-farthest order at the requested index',
  );
  assertContract(
    commander.unit.actions[4].type === 'wait',
    'inserted repair area should preserve existing orders after the requested index',
  );
}
