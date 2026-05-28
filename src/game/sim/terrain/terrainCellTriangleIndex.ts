export type TerrainCellTriangleIndexInput = {
  cellsX: number;
  cellsY: number;
  cellSize: number;
  vertexCoords: readonly number[];
  triangleIndices: readonly number[];
};

export type TerrainCellTriangleIndex = {
  cellTriangleOffsets: number[];
  cellTriangleIndices: number[];
};

export function buildTerrainCellTriangleIndex(
  input: TerrainCellTriangleIndexInput,
): TerrainCellTriangleIndex {
  const { cellsX, cellsY, cellSize, vertexCoords, triangleIndices } = input;
  const cellCount = Math.max(0, Math.floor(cellsX * cellsY));
  const cellTriangleCounts = new Array<number>(cellCount).fill(0);

  for (let tri = 0; tri < triangleIndices.length / 3; tri++) {
    const ia = triangleIndices[tri * 3];
    const ib = triangleIndices[tri * 3 + 1];
    const ic = triangleIndices[tri * 3 + 2];
    const ax = vertexCoords[ia * 2];
    const az = vertexCoords[ia * 2 + 1];
    const bx = vertexCoords[ib * 2];
    const bz = vertexCoords[ib * 2 + 1];
    const cx = vertexCoords[ic * 2];
    const cz = vertexCoords[ic * 2 + 1];
    const minCellX = clampCell(Math.floor(Math.min(ax, bx, cx) / cellSize), cellsX);
    const maxCellX = clampCell(Math.floor(Math.max(ax, bx, cx) / cellSize), cellsX);
    const minCellY = clampCell(Math.floor(Math.min(az, bz, cz) / cellSize), cellsY);
    const maxCellY = clampCell(Math.floor(Math.max(az, bz, cz) / cellSize), cellsY);
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        cellTriangleCounts[cy * cellsX + cellX]++;
      }
    }
  }

  const cellTriangleOffsets = new Array<number>(cellCount + 1);
  let totalRefs = 0;
  for (let i = 0; i < cellCount; i++) {
    cellTriangleOffsets[i] = totalRefs;
    totalRefs += cellTriangleCounts[i];
  }
  cellTriangleOffsets[cellCount] = totalRefs;

  const cellTriangleIndices = new Array<number>(totalRefs);
  const writeOffsets = cellTriangleOffsets.slice(0, cellCount);
  for (let tri = 0; tri < triangleIndices.length / 3; tri++) {
    const ia = triangleIndices[tri * 3];
    const ib = triangleIndices[tri * 3 + 1];
    const ic = triangleIndices[tri * 3 + 2];
    const ax = vertexCoords[ia * 2];
    const az = vertexCoords[ia * 2 + 1];
    const bx = vertexCoords[ib * 2];
    const bz = vertexCoords[ib * 2 + 1];
    const cx = vertexCoords[ic * 2];
    const cz = vertexCoords[ic * 2 + 1];
    const minCellX = clampCell(Math.floor(Math.min(ax, bx, cx) / cellSize), cellsX);
    const maxCellX = clampCell(Math.floor(Math.max(ax, bx, cx) / cellSize), cellsX);
    const minCellY = clampCell(Math.floor(Math.min(az, bz, cz) / cellSize), cellsY);
    const maxCellY = clampCell(Math.floor(Math.max(az, bz, cz) / cellSize), cellsY);
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const cellIndex = cy * cellsX + cellX;
        cellTriangleIndices[writeOffsets[cellIndex]++] = tri;
      }
    }
  }
  return { cellTriangleOffsets, cellTriangleIndices };
}

function clampCell(value: number, count: number): number {
  return count <= 1 ? 0 : Math.max(0, Math.min(count - 1, value));
}
