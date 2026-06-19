import type { MetalDeposit } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';

export type MetalDepositFootprintCell = {
  x: number;
  y: number;
  gx: number;
  gy: number;
  covered: boolean;
  depositId: number | null;
};

type MetalDepositGridCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
  depositId: number;
};

type MetalDepositFootprintCoverage = {
  fraction: number;
  coveredCells: number;
  totalCells: number;
  primaryDepositId: number | null;
};

function metalDepositContainsPoint(
  deposit: MetalDeposit,
  x: number,
  y: number,
): boolean {
  const gx = Math.floor(x / BUILD_GRID_CELL_SIZE);
  const gy = Math.floor(y / BUILD_GRID_CELL_SIZE);
  return metalDepositContainsGridCell(deposit, gx, gy);
}

function metalDepositContainsGridCell(
  deposit: MetalDeposit,
  gx: number,
  gy: number,
): boolean {
  if (
    gx < deposit.boundsGridX ||
    gy < deposit.boundsGridY ||
    gx >= deposit.boundsGridX + deposit.boundsGridW ||
    gy >= deposit.boundsGridY + deposit.boundsGridH
  ) {
    return false;
  }
  for (const cell of deposit.cells) {
    if (cell.gx === gx && cell.gy === gy) return true;
  }
  return false;
}

export function findDepositContainingPoint(
  deposits: ReadonlyArray<MetalDeposit>,
  x: number,
  y: number,
): MetalDeposit | null {
  for (const deposit of deposits) {
    if (metalDepositContainsPoint(deposit, x, y)) return deposit;
  }
  return null;
}

/** True iff at least one generated metal-producing cell overlaps a
 *  building footprint anchored at (gridX, gridY) with (gridW × gridH)
 *  cells. */
function metalDepositOverlapsBuildingFootprint(
  deposit: MetalDeposit,
  gridX: number,
  gridY: number,
  gridW: number,
  gridH: number,
): boolean {
  const ax0 = deposit.boundsGridX;
  const ay0 = deposit.boundsGridY;
  const ax1 = deposit.boundsGridX + deposit.boundsGridW;
  const ay1 = deposit.boundsGridY + deposit.boundsGridH;
  const bx0 = gridX;
  const by0 = gridY;
  const bx1 = gridX + gridW;
  const by1 = gridY + gridH;
  if (!(ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0)) return false;
  return getMetalDepositCoveredCellCount(deposit, gridX, gridY, gridW, gridH) > 0;
}

export function getMetalDepositCoveredCellCount(
  deposit: MetalDeposit,
  gridX: number,
  gridY: number,
  gridW: number,
  gridH: number,
): number {
  const bx1 = gridX + gridW;
  const by1 = gridY + gridH;
  let count = 0;
  for (const cell of deposit.cells) {
    if (cell.gx >= gridX && cell.gx < bx1 && cell.gy >= gridY && cell.gy < by1) {
      count++;
    }
  }
  return count;
}

/** Every deposit whose resource cells overlap the building footprint
 *  anchored at (gridX, gridY) by ≥ 1 cell. */
export function getMetalDepositsOverlappingBuildingFootprint(
  deposits: ReadonlyArray<MetalDeposit>,
  gridX: number,
  gridY: number,
  gridW: number,
  gridH: number,
): MetalDeposit[] {
  const out: MetalDeposit[] = [];
  for (const deposit of deposits) {
    if (metalDepositOverlapsBuildingFootprint(deposit, gridX, gridY, gridW, gridH)) {
      out.push(deposit);
    }
  }
  return out;
}

export function getMetalDepositGridCells(
  deposits: ReadonlyArray<MetalDeposit>,
  out: MetalDepositGridCell[] = [],
): MetalDepositGridCell[] {
  out.length = 0;
  for (const deposit of deposits) {
    for (const cell of deposit.cells) {
      out.push({
        gx: cell.gx,
        gy: cell.gy,
        x: cell.x,
        y: cell.y,
        depositId: deposit.id,
      });
    }
  }
  return out;
}

export function getMetalDepositFootprintCoverage(
  deposits: ReadonlyArray<MetalDeposit>,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
  sampleSize: number,
  outCells: MetalDepositFootprintCell[] | null = null,
): MetalDepositFootprintCoverage {
  if (outCells !== null) outCells.length = 0;
  const width = Math.max(0, halfWidth * 2);
  const height = Math.max(0, halfHeight * 2);
  const cellsX = Math.max(1, Math.round(width / Math.max(1e-6, sampleSize)));
  const cellsY = Math.max(1, Math.round(height / Math.max(1e-6, sampleSize)));
  const stepX = width / cellsX;
  const stepY = height / cellsY;
  const minX = centerX - halfWidth;
  const minY = centerY - halfHeight;
  const hitCounts = new Map<number, number>();
  let coveredCells = 0;

  for (let y = 0; y < cellsY; y++) {
    const sampleY = minY + (y + 0.5) * stepY;
    for (let x = 0; x < cellsX; x++) {
      const sampleX = minX + (x + 0.5) * stepX;
      const gx = Math.floor(sampleX / BUILD_GRID_CELL_SIZE);
      const gy = Math.floor(sampleY / BUILD_GRID_CELL_SIZE);
      const deposit = findDepositContainingPoint(deposits, sampleX, sampleY);
      if (deposit) {
        coveredCells++;
        hitCounts.set(deposit.id, (hitCounts.get(deposit.id) ?? 0) + 1);
      }
      if (outCells !== null) {
        outCells.push({
          x: sampleX,
          y: sampleY,
          gx,
          gy,
          covered: deposit !== null,
          depositId: deposit === null ? null : deposit.id,
        });
      }
    }
  }

  let primaryDepositId: number | null = null;
  let primaryCount = 0;
  for (const [depositId, count] of hitCounts) {
    if (count > primaryCount) {
      primaryCount = count;
      primaryDepositId = depositId;
    }
  }

  const totalCells = cellsX * cellsY;
  return {
    fraction: totalCells > 0 ? coveredCells / totalCells : 0,
    coveredCells,
    totalCells,
    primaryDepositId,
  };
}
