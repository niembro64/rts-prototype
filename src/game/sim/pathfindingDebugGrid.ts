// Terrain/clearance fields used by the path overlay while authoritative
// waypoint and move masks come directly from the WASM pathfinder.

const CLEARANCE_UNREACHABLE = 0xffff;
const PATHFINDER_MAP_EDGE_BUFFER_CELLS = 2;

export type PathfindingDebugGrid = {
  readonly waterBlocked: Uint8Array;
  readonly edgeBlocked: Uint8Array;
  readonly groundClearance: Uint16Array;
  readonly mediumClearance: Uint16Array;
  readonly waterClearance: Uint16Array;
};

export type PathfindingDebugGridInput = Readonly<{
  cellsX: number;
  cellsY: number;
  terrainWater: Uint8Array;
  terrainSubmerged: Uint8Array;
}>;

function safeCellCount(cellCount: number): number {
  return Math.max(1, Math.floor(cellCount));
}

export function createPathfindingDebugGrid(cellCount: number): PathfindingDebugGrid {
  const count = safeCellCount(cellCount);
  return {
    waterBlocked: new Uint8Array(count),
    edgeBlocked: new Uint8Array(count),
    groundClearance: new Uint16Array(count),
    mediumClearance: new Uint16Array(count),
    waterClearance: new Uint16Array(count),
  };
}

export function ensurePathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  cellCount: number,
): PathfindingDebugGrid {
  return grid.waterBlocked.length >= safeCellCount(cellCount)
    ? grid
    : createPathfindingDebugGrid(cellCount);
}

function rebuildClearanceDistance(clearance: Uint16Array, cellsX: number, cellsY: number): void {
  // Chebyshev cell distance: this is the same two-pass transform the
  // authoritative pathfinder uses for collision clearance.
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      if (clearance[index] === 0) continue;
      let nearest = clearance[index];
      if (gx > 0) nearest = Math.min(nearest, clearance[index - 1] + 1);
      if (gy > 0) {
        const north = index - cellsX;
        nearest = Math.min(nearest, clearance[north] + 1);
        if (gx > 0) nearest = Math.min(nearest, clearance[north - 1] + 1);
        if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[north + 1] + 1);
      }
      clearance[index] = Math.min(CLEARANCE_UNREACHABLE, nearest);
    }
  }
  for (let gy = cellsY - 1; gy >= 0; gy--) {
    for (let gx = cellsX - 1; gx >= 0; gx--) {
      const index = gy * cellsX + gx;
      if (clearance[index] === 0) continue;
      let nearest = clearance[index];
      if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[index + 1] + 1);
      if (gy < cellsY - 1) {
        const south = index + cellsX;
        nearest = Math.min(nearest, clearance[south] + 1);
        if (gx < cellsX - 1) nearest = Math.min(nearest, clearance[south + 1] + 1);
        if (gx > 0) nearest = Math.min(nearest, clearance[south - 1] + 1);
      }
      clearance[index] = Math.min(CLEARANCE_UNREACHABLE, nearest);
    }
  }
}

/**
 * Rebuild the terrain configuration-space fields used by the PATH overlay.
 * `terrainWater` means the cell contains water; `terrainSubmerged` means it
 * contains no exposed terrain. A mixed cell has `terrainWater=1` and
 * `terrainSubmerged=0` and therefore exercises both medium cases.
 */
export function rebuildPathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  input: PathfindingDebugGridInput,
): void {
  const { cellsX, cellsY, terrainWater, terrainSubmerged } = input;
  const cellCount = cellsX * cellsY;

  grid.waterBlocked.fill(0, 0, cellCount);
  grid.edgeBlocked.fill(0, 0, cellCount);
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      const edgeBlocked =
        gx < PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gy < PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gx >= cellsX - PATHFINDER_MAP_EDGE_BUFFER_CELLS ||
        gy >= cellsY - PATHFINDER_MAP_EDGE_BUFFER_CELLS;
      grid.edgeBlocked[index] = edgeBlocked ? 1 : 0;
      grid.waterBlocked[index] =
        edgeBlocked || terrainWater[index] !== 0 ? 1 : 0;
    }
  }

  for (let index = 0; index < cellCount; index++) {
    grid.groundClearance[index] = grid.waterBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
    grid.mediumClearance[index] = grid.edgeBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
    grid.waterClearance[index] = terrainSubmerged[index] === 0 ||
      grid.edgeBlocked[index] !== 0
      ? 0
      : CLEARANCE_UNREACHABLE;
  }
  rebuildClearanceDistance(grid.groundClearance, cellsX, cellsY);
  rebuildClearanceDistance(grid.mediumClearance, cellsX, cellsY);
  rebuildClearanceDistance(grid.waterClearance, cellsX, cellsY);
  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const index = gy * cellsX + gx;
      const edgeClearance = Math.max(
        0,
        Math.min(gx + 1, gy + 1, cellsX - gx, cellsY - gy),
      );
      grid.groundClearance[index] = Math.min(
        grid.groundClearance[index],
        edgeClearance,
      );
      grid.mediumClearance[index] = Math.min(
        grid.mediumClearance[index],
        edgeClearance,
      );
      grid.waterClearance[index] = Math.min(
        grid.waterClearance[index],
        edgeClearance,
      );
    }
  }
}
