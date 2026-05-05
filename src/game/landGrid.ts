import { LAND_CELL_SIZE } from '../config';

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

/** Round a land-cell axis count to the nearest positive odd integer.
 *  Map dimensions are required to be odd so every map has exactly
 *  one central land/mana cell — the `nearest-odd` rule keeps map-
 *  size option growth stable (15 → 23 → 35 → ...) without bias
 *  toward upward rounding. Used by `mapSizeConfig` to generate
 *  axis options.
 *
 *  Note: `config.normalizeMapLandCells` uses a different rule
 *  (always round UP to odd). Same goal, different policy. Kept
 *  separate intentionally for now — see issues.txt. */
export function nearestOddLandCellCount(value: number): number {
  const floor = Math.floor(value);
  const lowerOdd = floor % 2 === 1 ? floor : floor - 1;
  const ceil = Math.ceil(value);
  const upperOdd = ceil % 2 === 1 ? ceil : ceil + 1;
  const lowerDistance = Math.abs(value - lowerOdd);
  const upperDistance = Math.abs(value - upperOdd);
  return Math.max(1, lowerDistance <= upperDistance ? lowerOdd : upperOdd);
}

/** Hard-fail dev guard: a land-cell axis value must be a positive
 *  odd integer. Maps need exactly one central cell, which requires
 *  odd cell counts on both axes. Used at config-validation
 *  boundaries (mapSizeConfig defaults, axis option seeds, etc.) so
 *  drift fails loudly instead of producing maps with two or four
 *  centroid candidates. */
export function assertOddPositiveLandCellAxis(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value % 2 !== 1) {
    throw new Error(
      `${label} (${value}) must be a positive odd integer (one central land cell required)`,
    );
  }
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
