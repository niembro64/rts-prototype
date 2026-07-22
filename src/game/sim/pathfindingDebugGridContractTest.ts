import { getUnitBlueprint } from './blueprints';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { WATER_LEVEL } from './terrain/terrainConfig';
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
  const terrainMaxHeight = new Float32Array(cellCount).fill(-100);
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
      minGroundNormalZ: 0,
      waterSurfaceSupported: true,
      supportPointOffsetZ: 0,
      waypoint: { allowOnGround: false, allowInWater: true, allowInAir: false },
      move: { allowOnGround: false, allowInWater: true, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 0,
      flatWaterContactAccel: 0,
      safeWaterDriveAccel: 0,
      staticFrictionCoefficient: 0,
    },
    requiredGroundNormalZ: 0,
    bodyRadius: orca.radius.collision,
    hardClearanceCells: orcaHardClearance,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    terrainMaxHeight,
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
      minGroundNormalZ: 0,
      waterSurfaceSupported: false,
      supportPointOffsetZ: 0,
      waypoint: { allowOnGround: true, allowInWater: false, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 0,
      flatWaterContactAccel: 0,
      safeWaterDriveAccel: 0,
      staticFrictionCoefficient: 0,
    },
    requiredGroundNormalZ: 0,
    bodyRadius: 0.5,
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
    terrainMaxHeight,
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

  const wetSlopeSplit: PathfindingDebugTraversal = {
    traversal: {
      minGroundNormalZ: 0.8,
      waterSurfaceSupported: false,
      supportPointOffsetZ: 0,
      waypoint: { allowOnGround: true, allowInWater: true, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 100,
      flatWaterContactAccel: 0,
      safeWaterDriveAccel: 300,
      staticFrictionCoefficient: 1,
    },
    requiredGroundNormalZ: 0.8,
    bodyRadius: 20,
    hardClearanceCells: 0,
  };
  terrainNormalZ[indexOf(cellsX, shoreX, shoreY)] = 0.6;
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    terrainMaxHeight,
    traversal: wetSlopeSplit,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, shoreX, shoreY)] === 0 &&
      grid.movePassable[indexOf(cellsX, shoreX, shoreY)] === 1,
    'wet MOVE exposes a powered recovery slope that WAYPOINT rejects as an unstable destination',
  );
  terrainMaxHeight[indexOf(cellsX, shoreX, shoreY)] = WATER_LEVEL + 25;
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    terrainMaxHeight,
    traversal: wetSlopeSplit,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.movePassable[indexOf(cellsX, shoreX, shoreY)] === 0,
    'a nominally wet but body-dry shoreline cell cannot borrow full-water propulsion',
  );
}
