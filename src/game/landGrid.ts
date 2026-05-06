import { LAND_CELL_SIZE } from '../mapSizeConfig';

export {
  assertOddPositiveLandCellAxis,
  nearestOddLandCellCount,
} from '../mapSizeConfig';

export const LAND_CELL_AXIS_BIAS = 32768;
export const LAND_CELL_AXIS_MASK = 0xffff;
export const LAND_CELL_KEY_MULT = 0x10000;
export const CANONICAL_LAND_CELL_SIZE = normalizeLandCellSize(LAND_CELL_SIZE);

export type LandGridMetrics = {
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
};

export type LandCellBounds = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export function normalizeLandCellSize(cellSize: number = LAND_CELL_SIZE): number {
  return Math.max(1, Math.floor(cellSize > 0 ? cellSize : LAND_CELL_SIZE));
}

export function assertCanonicalLandCellSize(label: string, cellSize: number): void {
  const normalized = normalizeLandCellSize(cellSize);
  if (normalized !== CANONICAL_LAND_CELL_SIZE) {
    throw new Error(
      `${label} (${normalized}) must equal canonical LAND_CELL_SIZE (${CANONICAL_LAND_CELL_SIZE})`,
    );
  }
}

export function assertCanonicalLandGridSymmetry(
  objectLodCellSize: number = CANONICAL_LAND_CELL_SIZE,
): void {
  assertCanonicalLandCellSize('PLAYER_CLIENT objectLodCellSize', objectLodCellSize);
}

export function landCellCountForSpan(span: number, cellSize: number = LAND_CELL_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, span) / normalizeLandCellSize(cellSize)));
}

export function makeLandGridMetrics(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): LandGridMetrics {
  const normalizedCellSize = normalizeLandCellSize(cellSize);
  return {
    mapWidth,
    mapHeight,
    cellSize: normalizedCellSize,
    cellsX: landCellCountForSpan(mapWidth, normalizedCellSize),
    cellsY: landCellCountForSpan(mapHeight, normalizedCellSize),
  };
}

export function landCellIndex(coord: number, cellSize: number = LAND_CELL_SIZE): number {
  return Math.floor(coord / normalizeLandCellSize(cellSize));
}

export function landCellMinForSize(index: number, normalizedCellSize: number): number {
  return index * normalizedCellSize;
}

export function landCellMaxForSize(
  index: number,
  worldSpan: number,
  normalizedCellSize: number,
): number {
  return Math.min(worldSpan, landCellMinForSize(index, normalizedCellSize) + normalizedCellSize);
}

export function landCellCenter(index: number, cellSize: number = LAND_CELL_SIZE): number {
  return (index + 0.5) * normalizeLandCellSize(cellSize);
}

export function landCellIndexForSize(coord: number, normalizedCellSize: number): number {
  return Math.floor(coord / normalizedCellSize);
}

export function landCellCenterForSize(index: number, normalizedCellSize: number): number {
  return (index + 0.5) * normalizedCellSize;
}

export function landCellBoundaryFloor(coord: number, normalizedCellSize: number): number {
  return landCellMinForSize(landCellIndexForSize(coord, normalizedCellSize), normalizedCellSize);
}

export function landCellBoundaryCeil(coord: number, normalizedCellSize: number): number {
  return Math.ceil(coord / normalizedCellSize) * normalizedCellSize;
}

export function landCellKeyForIndex(cx: number, cy: number): number {
  return packLandCellKey(cx, cy);
}

export function landCellKeyForWorld(
  x: number,
  y: number,
  normalizedCellSize: number = CANONICAL_LAND_CELL_SIZE,
): number {
  return packLandCellKey(
    landCellIndexForSize(x, normalizedCellSize),
    landCellIndexForSize(y, normalizedCellSize),
  );
}

export function writeLandCellBounds(
  grid: LandGridMetrics,
  cx: number,
  cy: number,
  out: LandCellBounds,
): LandCellBounds {
  out.x0 = landCellMinForSize(cx, grid.cellSize);
  out.y0 = landCellMinForSize(cy, grid.cellSize);
  out.x1 = Math.min(grid.mapWidth, out.x0 + grid.cellSize);
  out.y1 = Math.min(grid.mapHeight, out.y0 + grid.cellSize);
  return out;
}

export function landCellCenterXForMetrics(grid: LandGridMetrics, cx: number): number {
  return landCellCenterForSize(cx, grid.cellSize);
}

export function landCellCenterYForMetrics(grid: LandGridMetrics, cy: number): number {
  return landCellCenterForSize(cy, grid.cellSize);
}

export function packLandCellKey(cx: number, cy: number): number {
  return (
    (((cx + LAND_CELL_AXIS_BIAS) & LAND_CELL_AXIS_MASK) << 16) |
    ((cy + LAND_CELL_AXIS_BIAS) & LAND_CELL_AXIS_MASK)
  );
}

export function unpackLandCellX(key: number): number {
  return ((key >> 16) & LAND_CELL_AXIS_MASK) - LAND_CELL_AXIS_BIAS;
}

export function unpackLandCellY(key: number): number {
  return (key & LAND_CELL_AXIS_MASK) - LAND_CELL_AXIS_BIAS;
}

export function spatialCubeKeyToLandCellKey(cubeKey: number): number {
  return Math.floor(cubeKey / LAND_CELL_KEY_MULT) | 0;
}
