// Terrain medium masks used by the path overlay. Authoritative waypoint and
// move masks (slope, medium, Euclidean clearance) come directly from the WASM
// pathfinder bake; this module only mirrors the binary water/edge cases the
// terrain tile renderer paints.
const PATHFINDER_MAP_EDGE_BUFFER_CELLS = 2;

export type PathfindingDebugGrid = {
  readonly waterBlocked: Uint8Array;
  readonly edgeBlocked: Uint8Array;
};

type PathfindingDebugGridInput = Readonly<{
  cellsX: number;
  cellsY: number;
  terrainWater: Uint8Array;
}>;

function safeCellCount(cellCount: number): number {
  return Math.max(1, Math.floor(cellCount));
}

export function createPathfindingDebugGrid(cellCount: number): PathfindingDebugGrid {
  const count = safeCellCount(cellCount);
  return {
    waterBlocked: new Uint8Array(count),
    edgeBlocked: new Uint8Array(count),
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

/**
 * Rebuild the binary medium masks used by the PATH overlay. `terrainWater`
 * means the cell contains water; the outer map guard band is blocked for
 * every terrain-bound body.
 */
export function rebuildPathfindingDebugGrid(
  grid: PathfindingDebugGrid,
  input: PathfindingDebugGridInput,
): void {
  const { cellsX, cellsY, terrainWater } = input;
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
}
