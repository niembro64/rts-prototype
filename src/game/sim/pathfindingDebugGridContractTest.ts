import { getUnitBlueprint } from './blueprints';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import {
  createPathfindingDebugGrid,
  pathfinderHardClearanceCellsForRadius,
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
 * Medium membership is binary and compositional. Any water-containing square
 * exercises the water case, any square containing exposed terrain exercises
 * the ground/air case, and a mixed square must pass both.
 */
export function runPathfindingDebugGridContractTest(): void {
  const cellsX = 15;
  const cellsY = 15;
  const cellCount = cellsX * cellsY;
  const row = 7;
  const mixedX = 4;
  const terrainWater = new Uint8Array(cellCount).fill(1);
  const terrainSubmerged = new Uint8Array(cellCount).fill(1);
  const terrainNormalZ = new Float32Array(cellCount).fill(1);
  // x < mixedX is dry, x === mixedX is mixed, and x > mixedX is fully wet.
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < mixedX; gx++) {
      const index = indexOf(cellsX, gx, gy);
      terrainWater[index] = 0;
      terrainSubmerged[index] = 0;
    }
    terrainSubmerged[indexOf(cellsX, mixedX, gy)] = 0;
  }

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
    grid.waypointPassable[indexOf(cellsX, mixedX, row)] === 0,
    'water-only navigation rejects a mixed square because its exposed case is invalid',
  );
  assertContract(
    grid.waypointPassable[indexOf(cellsX, mixedX + 2, row)] === 0 &&
      grid.waypointPassable[indexOf(cellsX, mixedX + 3, row)] === 1,
    'water-only clearance uses only physical body radius, with no extra shoreline band',
  );

  const dryPoint: PathfindingDebugTraversal = {
    traversal: {
      minGroundNormalZ: 0,
      waterSurfaceSupported: false,
      supportPointOffsetZ: 0,
      waypoint: { allowOnGround: true, allowInWater: false, allowInAir: false },
      move: { allowOnGround: true, allowInWater: false, allowInAir: false },
      flatDriveAccel: 0,
      safeDriveAccel: 0,
      flatWaterContactAccel: 0,
      safeWaterDriveAccel: 0,
      staticFrictionCoefficient: 0,
    },
    requiredGroundNormalZ: 0,
    hardClearanceCells: 0,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: dryPoint,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, mixedX - 1, row)] === 1 &&
      grid.waypointPassable[indexOf(cellsX, mixedX, row)] === 0,
    'dry validity changes exactly at the first water-containing square',
  );

  const airOnly: PathfindingDebugTraversal = {
    traversal: {
      ...dryPoint.traversal,
      waypoint: { allowOnGround: false, allowInWater: false, allowInAir: true },
      move: { allowOnGround: false, allowInWater: false, allowInAir: true },
    },
    requiredGroundNormalZ: 0,
    hardClearanceCells: 0,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: airOnly,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, mixedX - 1, row)] === 1 &&
      grid.waypointPassable[indexOf(cellsX, mixedX, row)] === 0 &&
      grid.waypointPassable[indexOf(cellsX, mixedX + 1, row)] === 0,
    'air permission no longer bypasses an invalid water case',
  );

  const airAndWater: PathfindingDebugTraversal = {
    traversal: {
      ...airOnly.traversal,
      waypoint: { allowOnGround: false, allowInWater: true, allowInAir: true },
      move: { allowOnGround: false, allowInWater: true, allowInAir: true },
    },
    requiredGroundNormalZ: 0,
    hardClearanceCells: 0,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: airAndWater,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.waypointPassable[indexOf(cellsX, mixedX - 1, row)] === 1 &&
      grid.waypointPassable[indexOf(cellsX, mixedX, row)] === 1 &&
      grid.waypointPassable[indexOf(cellsX, mixedX + 1, row)] === 1,
    'a dual air/water unit accepts dry, mixed, and fully wet squares',
  );

  const mixedSlope = indexOf(cellsX, mixedX, row);
  const submergedSlope = indexOf(cellsX, mixedX + 1, row);
  terrainNormalZ[mixedSlope] = 0.8;
  terrainNormalZ[submergedSlope] = 0.8;
  const poweredAmphibious: PathfindingDebugTraversal = {
    traversal: {
      minGroundNormalZ: 0.5,
      waterSurfaceSupported: false,
      supportPointOffsetZ: 0,
      waypoint: { allowOnGround: true, allowInWater: true, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
      flatDriveAccel: 100,
      safeDriveAccel: 100,
      flatWaterContactAccel: 300,
      safeWaterDriveAccel: 300,
      staticFrictionCoefficient: 0.2,
    },
    requiredGroundNormalZ: 0.5,
    hardClearanceCells: 0,
  };
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: poweredAmphibious,
    cellsX,
    cellsY,
  });
  assertContract(
    grid.movePassable[mixedSlope] === 1 &&
      grid.movePassable[submergedSlope] === 1 &&
      grid.waypointPassable[mixedSlope] === 0 &&
      grid.waypointPassable[submergedSlope] === 0,
    'partial and full water apply the same powered MOVE and passive WAYPOINT water cases',
  );

  terrainNormalZ[mixedSlope] = 0.4;
  rebuildPathfindingDebugPassability({
    grid,
    terrainWater,
    terrainSubmerged,
    terrainNormalZ,
    traversal: poweredAmphibious,
    cellsX,
    cellsY,
  });
  assertContract(
    Number(grid.movePassable[mixedSlope]) === 0,
    'a mixed square takes the worse dry result when its water MOVE case passes',
  );
}
