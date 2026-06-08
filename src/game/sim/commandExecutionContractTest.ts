import { ConstructionSystem } from './construction';
import { resolvePathableFormationTarget } from './commandExecution';
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
