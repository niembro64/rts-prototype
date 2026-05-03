import type { MetalDeposit } from '../../metalDepositConfig';

export type MetalDepositFootprintCell = {
  x: number;
  y: number;
  covered: boolean;
  depositId?: number;
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
  const dx = x - deposit.x;
  const dy = y - deposit.y;
  return dx * dx + dy * dy <= deposit.flatRadius * deposit.flatRadius;
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
      const deposit = findDepositContainingPoint(deposits, sampleX, sampleY);
      if (deposit) {
        coveredCells++;
        hitCounts.set(deposit.id, (hitCounts.get(deposit.id) ?? 0) + 1);
      }
      if (outCells) {
        outCells.push({
          x: sampleX,
          y: sampleY,
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
