import type { MetalDeposit } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { metalDepositWorkableAtHeight } from './worldSurfaceState';

type MetalDepositGridCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
  depositId: number;
};

type MetalDepositGridLookup = {
  byGridCell: Map<string, MetalDeposit>;
  cells: MetalDepositGridCell[];
};

const metalDepositGridLookupCache = new WeakMap<ReadonlyArray<MetalDeposit>, MetalDepositGridLookup>();

function metalDepositGridCellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function getMetalDepositGridLookup(deposits: ReadonlyArray<MetalDeposit>): MetalDepositGridLookup {
  let cached = metalDepositGridLookupCache.get(deposits);
  if (cached !== undefined) return cached;

  const byGridCell = new Map<string, MetalDeposit>();
  const cells: MetalDepositGridCell[] = [];
  for (const deposit of deposits) {
    // A deposit drowned by lava resolves to nothing: no crown, no coverage,
    // no extractor income. It stays in the generated list because it already
    // shaped the terrain, and that shaping must not change with the liquid.
    if (!metalDepositWorkableAtHeight(deposit.height)) continue;
    for (const cell of deposit.cells) {
      byGridCell.set(metalDepositGridCellKey(cell.gx, cell.gy), deposit);
      cells.push({
        gx: cell.gx,
        gy: cell.gy,
        x: cell.x,
        y: cell.y,
        depositId: deposit.id,
      });
    }
  }
  cached = { byGridCell, cells };
  metalDepositGridLookupCache.set(deposits, cached);
  return cached;
}

export function findDepositContainingPoint(
  deposits: ReadonlyArray<MetalDeposit>,
  x: number,
  y: number,
): MetalDeposit | null {
  const gx = Math.floor(x / BUILD_GRID_CELL_SIZE);
  const gy = Math.floor(y / BUILD_GRID_CELL_SIZE);
  return getMetalDepositGridLookup(deposits).byGridCell.get(metalDepositGridCellKey(gx, gy)) ?? null;
}

/** Every workable deposit's build cells as a flat (gx, gy) pair list.
 *  One shared rasterization source: the terrain's metal overlay mask and
 *  the baked ore surface field must agree on which cells are ore,
 *  including the drowned-deposit filter above. */
export function packMetalDepositGridCellsXY(
  deposits: ReadonlyArray<MetalDeposit>,
): Int32Array {
  const cells = getMetalDepositGridLookup(deposits).cells;
  const packed = new Int32Array(cells.length * 2);
  for (let i = 0; i < cells.length; i++) {
    packed[i * 2] = cells[i].gx;
    packed[i * 2 + 1] = cells[i].gy;
  }
  return packed;
}

export function getMetalDepositGridCells(
  deposits: ReadonlyArray<MetalDeposit>,
  out: MetalDepositGridCell[] = [],
): MetalDepositGridCell[] {
  out.length = 0;
  const cells = getMetalDepositGridLookup(deposits).cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    out.push({
      gx: cell.gx,
      gy: cell.gy,
      x: cell.x,
      y: cell.y,
      depositId: cell.depositId,
    });
  }
  return out;
}
