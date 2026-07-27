import type { FootprintBounds } from '../ViewportFootprint';

export const CLIENT_RENDER_SPATIAL_CELL_SIZE = 512;
export const CLIENT_RENDER_SPATIAL_KEY_OFFSET = 1 << 20;
const CLIENT_RENDER_SPATIAL_KEY_STRIDE =
  CLIENT_RENDER_SPATIAL_KEY_OFFSET * 2 + 1;

export function clientRenderCellCoord(value: number): number {
  return Math.floor(value / CLIENT_RENDER_SPATIAL_CELL_SIZE);
}

export type ClientRenderCellBounds = {
  minCellX: number;
  maxCellX: number;
  minCellY: number;
  maxCellY: number;
};

export function createClientRenderCellBounds(): ClientRenderCellBounds {
  return { minCellX: 0, maxCellX: 0, minCellY: 0, maxCellY: 0 };
}

export function writeClientRenderCellBounds(
  output: ClientRenderCellBounds,
  bounds: FootprintBounds,
): ClientRenderCellBounds {
  output.minCellX = clientRenderCellCoord(bounds.minX);
  output.maxCellX = clientRenderCellCoord(bounds.maxX);
  output.minCellY = clientRenderCellCoord(bounds.minY);
  output.maxCellY = clientRenderCellCoord(bounds.maxY);
  return output;
}

export function numericClientRenderCellKey(
  cellX: number,
  cellY: number,
): number {
  return (
    (cellX + CLIENT_RENDER_SPATIAL_KEY_OFFSET) *
    CLIENT_RENDER_SPATIAL_KEY_STRIDE
  ) + cellY + CLIENT_RENDER_SPATIAL_KEY_OFFSET;
}

export function clientRenderCellKey(
  cellX: number,
  cellY: number,
): number | string {
  if (
    cellX < -CLIENT_RENDER_SPATIAL_KEY_OFFSET ||
    cellX > CLIENT_RENDER_SPATIAL_KEY_OFFSET ||
    cellY < -CLIENT_RENDER_SPATIAL_KEY_OFFSET ||
    cellY > CLIENT_RENDER_SPATIAL_KEY_OFFSET
  ) {
    return `${cellX},${cellY}`;
  }
  return numericClientRenderCellKey(cellX, cellY);
}

export function cellBoundsIntersect(
  minAX: number,
  maxAX: number,
  minAY: number,
  maxAY: number,
  minBX: number,
  maxBX: number,
  minBY: number,
  maxBY: number,
): boolean {
  return !(
    maxAX < minBX ||
    minAX > maxBX ||
    maxAY < minBY ||
    minAY > maxBY
  );
}

export function shouldQuerySparseGridDirectly(
  minCellX: number,
  maxCellX: number,
  minCellY: number,
  maxCellY: number,
  occupiedCellCount: number,
): boolean {
  const width = maxCellX - minCellX + 1;
  const height = maxCellY - minCellY + 1;
  if (!(width > 0) || !(height > 0)) return true;
  const queriedCells = width * height;
  return !Number.isFinite(queriedCells) || queriedCells > occupiedCellCount;
}
