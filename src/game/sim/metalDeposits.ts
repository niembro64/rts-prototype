import type { MetalDeposit } from '../../metalDepositConfig';
import { GRID_CELL_SIZE } from './grid';

export type MetalDepositFootprintCell = {
  x: number;
  y: number;
  gx: number;
  gy: number;
  covered: boolean;
  depositId?: number;
};

export type MetalDepositGridCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
  depositId: number;
};

export type MetalDepositFootprintCoverage = {
  fraction: number;
  coveredCells: number;
  totalCells: number;
  primaryDepositId?: number;
};

export function metalDepositContainsPoint(
  deposit: MetalDeposit,
  x: number,
  y: number,
): boolean {
  const gx = Math.floor(x / GRID_CELL_SIZE);
  const gy = Math.floor(y / GRID_CELL_SIZE);
  return metalDepositContainsGridCell(deposit, gx, gy);
}

export function metalDepositContainsGridCell(
  deposit: MetalDeposit,
  gx: number,
  gy: number,
): boolean {
  return (
    gx >= deposit.gridX &&
    gy >= deposit.gridY &&
    gx < deposit.gridX + deposit.resourceCells &&
    gy < deposit.gridY + deposit.resourceCells
  );
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

/** True iff the deposit's resource grid square overlaps a building
 *  footprint anchored at (gridX, gridY) with (gridW × gridH) cells.
 *  Two axis-aligned grid rectangles intersect — the binary "extractor
 *  covers any cell of this deposit" test the claim system uses.
 *  No sample-cell sweep, no floating-point math: pure integer AABB. */
export function metalDepositOverlapsBuildingFootprint(
  deposit: MetalDeposit,
  gridX: number,
  gridY: number,
  gridW: number,
  gridH: number,
): boolean {
  const ax0 = deposit.gridX;
  const ay0 = deposit.gridY;
  const ax1 = deposit.gridX + deposit.resourceCells;
  const ay1 = deposit.gridY + deposit.resourceCells;
  const bx0 = gridX;
  const by0 = gridY;
  const bx1 = gridX + gridW;
  const by1 = gridY + gridH;
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}

/** Every deposit whose resource cells overlap the building footprint
 *  anchored at (gridX, gridY) by ≥ 1 cell. Each result is a CANDIDATE
 *  to be claimed by the new extractor — the deposit-ownership map
 *  decides which are actually free vs. already taken. */
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
    for (let dy = 0; dy < deposit.resourceCells; dy++) {
      for (let dx = 0; dx < deposit.resourceCells; dx++) {
        const gx = deposit.gridX + dx;
        const gy = deposit.gridY + dy;
        out.push({
          gx,
          gy,
          x: gx * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
          y: gy * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
          depositId: deposit.id,
        });
      }
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
  outCells?: MetalDepositFootprintCell[],
): MetalDepositFootprintCoverage {
  if (outCells) outCells.length = 0;
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
      const gx = Math.floor(sampleX / GRID_CELL_SIZE);
      const gy = Math.floor(sampleY / GRID_CELL_SIZE);
      const deposit = findDepositContainingPoint(deposits, sampleX, sampleY);
      if (deposit) {
        coveredCells++;
        hitCounts.set(deposit.id, (hitCounts.get(deposit.id) ?? 0) + 1);
      }
      if (outCells) {
        outCells.push({
          x: sampleX,
          y: sampleY,
          gx,
          gy,
          covered: deposit !== null,
          depositId: deposit?.id,
        });
      }
    }
  }

  let primaryDepositId: number | undefined;
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
