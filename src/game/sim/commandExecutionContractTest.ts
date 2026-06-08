import { ConstructionSystem } from './construction';
import {
  buildMassAwareGroupFormationSlots,
  resolvePathableFormationTarget,
} from './commandExecution';
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
}
