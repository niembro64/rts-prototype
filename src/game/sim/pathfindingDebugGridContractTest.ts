import { getUnitBlueprint } from './blueprints';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import {
  createPathfindingDebugGrid,
  pathfinderHardClearanceCellsForRadius,
  pathfinderRequiredWaterClearanceCells,
  rebuildPathfindingDebugGrid,
  rebuildPathfindingDebugPassability,
  type PathfindingDebugTraversal,
} from './pathfindingDebugGrid';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[pathfinding debug grid contract] ${message}`);
}

function indexOf(cellsX: number, gx: number, gy: number): number {
  return gy * cellsX + gx;
}

/**
 * The PATH overlay must show the same shoreline configuration space as the
 * planner. In particular, a pure-water unit may not treat a beach-touching
 * cell as navigable merely because some of that cell is wet.
 */
export function runPathfindingDebugGridContractTest(): void {
  const cellsX = 25;
  const cellsY = 25;
  const cellCount = cellsX * cellsY;
  const shoreX = 12;
  const shoreY = 12;
  const terrainWater = new Uint8Array(cellCount).fill(1);
  const terrainSubmerged = new Uint8Array(cellCount).fill(1);
  const terrainNormalZ = new Float32Array(cellCount).fill(1);
  // This represents a sloping beach cell: it touches water, but is not a
  // wholly submerged volume that an Orca can occupy.
  terrainSubmerged[indexOf(cellsX, shoreX, shoreY)] = 0;

  const grid = createPathfindingDebugGrid(cellCount);
  rebuildPathfindingDebugGrid(grid, {
    cellsX,
    cellsY,
    terrainWater,
    terrainSubmerged,
  });

  const orca = getUnitBlueprint('unitOrca');
  const orcaHardClearance = pathfinderHardClearanceCellsForRadius(
    orca.radius.collision,
    BUILD_GRID_CELL_SIZE,
  );
  assertContract(orcaHardClearance === 3, 'Orca collision radius occupies three path cells');
  assertContract(
    pathfinderRequiredWaterClearanceCells(orcaHardClearance) === 5,
    'Orca preserves the two-cell shore buffer in addition to body clearance',
  );

  const waterOnly: PathfindingDebugTraversal = {
    traversal: {
      minStandstillNormalZ: 0,
      minClimbNormalZ: 0,
      waypoint: { allowOnGround: false, allowInWater: true, allowInAir: false },
      move: { allowOnGround: false, allowInWater: true, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 0,
      staticFrictionCoefficient: 0,
    },
    requiredNormalZ: 0,
    hardClearanceCells: orcaHardClearance,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: waterOnly,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX, shoreY)] === 0,
    'a cell that only touches water is blocked for Orca',
  );
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX + 4, shoreY)] === 0,
    'Orca body clearance cannot replace the shore buffer',
  );
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX + 5, shoreY)] === 1,
    'the first cell beyond shore and body clearance is navigable for Orca',
  );

  const landPoint: PathfindingDebugTraversal = {
    traversal: {
      minStandstillNormalZ: 0,
      minClimbNormalZ: 0,
      waypoint: { allowOnGround: true, allowInWater: false, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 0,
      staticFrictionCoefficient: 0,
    },
    requiredNormalZ: 0,
    hardClearanceCells: 0,
  };
  // The opposite side uses the same two-cell shore buffer: neither a land
  // point nor a water point can occupy the matching buffer cells.
  terrainWater.fill(0);
  terrainWater[indexOf(cellsX, shoreX, shoreY)] = 1;
  rebuildPathfindingDebugGrid(grid, {
    cellsX,
    cellsY,
    terrainWater,
    terrainSubmerged,
  });
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: landPoint,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX + 2, shoreY)] === 0,
    'land remains blocked inside the shared two-cell water buffer',
  );
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX + 3, shoreY)] === 1,
    'land is released immediately beyond the shared water buffer',
  );
  assertContract(
    grid.movePassable[indexOf(cellsX, shoreX, shoreY)] === 1,
    'the same land unit visibly exposes wet cells as physically move-valid',
  );
}
