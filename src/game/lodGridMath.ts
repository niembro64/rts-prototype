import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
  landCellBoundaryCeil,
  landCellBoundaryFloor,
  landCellCenterForSize,
  landCellIndexForSize,
  landCellMinForSize,
} from './landGrid';

export const MIN_LOD_CELL_SIZE = CANONICAL_LAND_CELL_SIZE;

export function normalizeLodCellSize(cellSize: number): number {
  assertCanonicalLandCellSize('object LOD cell size', cellSize);
  return CANONICAL_LAND_CELL_SIZE;
}

export function lodCellIndex(coord: number, cellSize: number): number {
  return landCellIndexForSize(coord, normalizeLodCellSize(cellSize));
}

export function lodCellMin(index: number, cellSize: number): number {
  return landCellMinForSize(index, normalizeLodCellSize(cellSize));
}

export function lodCellCenter(index: number, cellSize: number): number {
  return landCellCenterForSize(index, normalizeLodCellSize(cellSize));
}

export function lodCellBoundaryFloor(coord: number, cellSize: number): number {
  return landCellBoundaryFloor(coord, normalizeLodCellSize(cellSize));
}

export function lodCellBoundaryCeil(coord: number, cellSize: number): number {
  return landCellBoundaryCeil(coord, normalizeLodCellSize(cellSize));
}
