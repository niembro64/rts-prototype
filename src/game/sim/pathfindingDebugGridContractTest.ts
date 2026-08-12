import {
  createPathfindingDebugGrid,
  rebuildPathfindingDebugGrid,
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

  assertContract(
    grid.waterBlocked[indexOf(cellsX, mixedX - 1, row)] === 0 &&
      grid.waterBlocked[indexOf(cellsX, mixedX, row)] === 1,
    'the water mask changes exactly at the first water-containing square',
  );
  assertContract(
    grid.groundClearance[indexOf(cellsX, mixedX - 1, row)] === 1 &&
      grid.groundClearance[indexOf(cellsX, mixedX, row)] === 0,
    'ground clearance stops at the first water-containing square',
  );
  assertContract(
    grid.waterClearance[indexOf(cellsX, mixedX, row)] === 0 &&
      grid.waterClearance[indexOf(cellsX, mixedX + 1, row)] === 1 &&
      grid.waterClearance[indexOf(cellsX, mixedX + 2, row)] === 2,
    'water clearance measures outward from the exposed shoreline',
  );
  assertContract(
    grid.mediumClearance[indexOf(cellsX, 1, row)] === 0 &&
      grid.mediumClearance[indexOf(cellsX, 2, row)] === 1 &&
      grid.mediumClearance[indexOf(cellsX, 7, row)] === 6,
    'medium clearance is bounded only by the canonical two-cell map edge',
  );
  assertContract(
    grid.edgeBlocked[indexOf(cellsX, 1, row)] === 1 &&
      grid.edgeBlocked[indexOf(cellsX, 2, row)] === 0,
    'the debug terrain mask preserves the pathfinder map-edge buffer',
  );
}
