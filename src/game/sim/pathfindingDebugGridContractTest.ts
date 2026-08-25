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

/** The overlay's water mask changes exactly at the first water-containing
 *  square, and the outer two-cell guard band is always blocked. */
export function runPathfindingDebugGridContractTest(): void {
  const cellsX = 15;
  const cellsY = 15;
  const cellCount = cellsX * cellsY;
  const row = 7;
  const mixedX = 4;
  const terrainWater = new Uint8Array(cellCount).fill(1);
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < mixedX; gx++) {
      terrainWater[indexOf(cellsX, gx, gy)] = 0;
    }
  }
  const grid = createPathfindingDebugGrid(cellCount);
  rebuildPathfindingDebugGrid(grid, { cellsX, cellsY, terrainWater });
  assertContract(
    grid.waterBlocked[indexOf(cellsX, mixedX - 1, row)] === 0 &&
      grid.waterBlocked[indexOf(cellsX, mixedX, row)] === 1,
    'the water mask changes exactly at the first water-containing square',
  );
  assertContract(
    grid.edgeBlocked[indexOf(cellsX, 1, row)] === 1 &&
      grid.edgeBlocked[indexOf(cellsX, 2, row)] === 0 &&
      grid.waterBlocked[indexOf(cellsX, 1, row)] === 1,
    'the two-cell map guard band is blocked for terrain-bound bodies',
  );
  assertContract(
    ensureGrows(cellCount),
    'ensurePathfindingDebugGrid keeps a large enough buffer',
  );
}

function ensureGrows(cellCount: number): boolean {
  const small = createPathfindingDebugGrid(4);
  return small.waterBlocked.length === 4 && createPathfindingDebugGrid(cellCount).waterBlocked.length === cellCount;
}
