
// Keep in sync with mapSizeConfig.ts. landGrid is imported by low-level sim
// chunks, so this constant stays local instead of reading through the broader
// config graph during production module initialization.
export const CANONICAL_LAND_CELL_SIZE = 200;

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

export function normalizeLandCellSize(cellSize: number = CANONICAL_LAND_CELL_SIZE): number {
  return Math.max(
    1,
    Math.floor(cellSize > 0 ? cellSize : CANONICAL_LAND_CELL_SIZE),
  );
}

export function assertCanonicalLandCellSize(label: string, cellSize: number): void {
  const normalized = normalizeLandCellSize(cellSize);
  if (normalized !== CANONICAL_LAND_CELL_SIZE) {
    throw new Error(
      `${label} (${normalized}) must equal canonical LAND_CELL_SIZE (${CANONICAL_LAND_CELL_SIZE})`,
    );
  }
}

function landCellCountForSpan(
  span: number,
  cellSize: number = CANONICAL_LAND_CELL_SIZE,
): number {
  return Math.max(1, Math.ceil(Math.max(0, span) / normalizeLandCellSize(cellSize)));
}

export function makeLandGridMetrics(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = CANONICAL_LAND_CELL_SIZE,
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

















