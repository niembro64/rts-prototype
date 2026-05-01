export const MIN_LOD_CELL_SIZE = 16;

export function normalizeLodCellSize(cellSize: number): number {
  return Math.max(MIN_LOD_CELL_SIZE, Math.floor(cellSize));
}

export function lodCellIndex(coord: number, cellSize: number): number {
  return Math.floor(coord / cellSize);
}

export function lodCellMin(index: number, cellSize: number): number {
  return index * cellSize;
}

export function lodCellCenter(index: number, cellSize: number): number {
  return (index + 0.5) * cellSize;
}

export function lodCellBoundaryFloor(coord: number, cellSize: number): number {
  return lodCellMin(lodCellIndex(coord, cellSize), cellSize);
}

export function lodCellBoundaryCeil(coord: number, cellSize: number): number {
  return Math.ceil(coord / cellSize) * cellSize;
}
