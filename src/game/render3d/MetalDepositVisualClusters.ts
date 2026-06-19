import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';

export const METAL_DEPOSIT_COIN_TOP_LIFT = METAL_DEPOSIT_CONFIG.coinHeight * 0.5 + 0.04;

export type DepositVisualCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
};

export type MetalDepositVisualCluster = {
  id: number;
  seed: number;
  x: number;
  y: number;
  height: number;
  cells: readonly DepositVisualCell[];
  resourceHalfSize: number;
  depositIds: number[];
};

type MetalDepositSurfaceIndex = {
  surfaceYByCell: Map<string, number>;
  surfaceYById: Map<number, number>;
};

export function metalDepositCellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export function makeMetalDepositVisualClusters(
  deposits: ReadonlyArray<MetalDeposit>,
): MetalDepositVisualCluster[] {
  if (deposits.length === 0) return [];

  const parents = new Array<number>(deposits.length);
  for (let i = 0; i < deposits.length; i++) parents[i] = i;
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parents[rootB] = rootA;
  };

  const cellOwners = new Map<string, number[]>();
  for (let depositIndex = 0; depositIndex < deposits.length; depositIndex++) {
    for (const cell of deposits[depositIndex].cells) {
      const key = metalDepositCellKey(cell.gx, cell.gy);
      const owners = cellOwners.get(key);
      if (owners) owners.push(depositIndex);
      else cellOwners.set(key, [depositIndex]);
    }
  }

  for (const owners of cellOwners.values()) {
    for (let i = 1; i < owners.length; i++) union(owners[0], owners[i]);
  }

  const neighborOffsets: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let depositIndex = 0; depositIndex < deposits.length; depositIndex++) {
    for (const cell of deposits[depositIndex].cells) {
      for (const [dx, dy] of neighborOffsets) {
        const owners = cellOwners.get(metalDepositCellKey(cell.gx + dx, cell.gy + dy));
        if (!owners) continue;
        for (const owner of owners) union(depositIndex, owner);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < deposits.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }

  const clusters: MetalDepositVisualCluster[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => deposits[a].id - deposits[b].id);
    clusters.push(makeMetalDepositVisualCluster(group, deposits));
  }
  clusters.sort((a, b) => a.id - b.id);
  return clusters;
}

export function createMetalDepositSurfaceIndex(
  deposits: ReadonlyArray<MetalDeposit>,
): MetalDepositSurfaceIndex {
  const surfaceYByCell = new Map<string, number>();
  const surfaceYById = new Map<number, number>();
  const clusters = makeMetalDepositVisualClusters(deposits);
  for (const cluster of clusters) {
    const surfaceY = cluster.height + METAL_DEPOSIT_COIN_TOP_LIFT;
    for (const depositId of cluster.depositIds) {
      const current = surfaceYById.get(depositId);
      if (current === undefined || surfaceY > current) surfaceYById.set(depositId, surfaceY);
    }
    for (const cell of cluster.cells) {
      const key = metalDepositCellKey(cell.gx, cell.gy);
      const current = surfaceYByCell.get(key);
      if (current === undefined || surfaceY > current) surfaceYByCell.set(key, surfaceY);
    }
  }
  return { surfaceYByCell, surfaceYById };
}

function makeMetalDepositVisualCluster(
  depositIndices: readonly number[],
  deposits: ReadonlyArray<MetalDeposit>,
): MetalDepositVisualCluster {
  const cellsByKey = new Map<string, DepositVisualCell>();
  let heightSum = 0;
  let heightCount = 0;

  for (const depositIndex of depositIndices) {
    const deposit = deposits[depositIndex];
    for (const cell of deposit.cells) {
      const key = metalDepositCellKey(cell.gx, cell.gy);
      if (cellsByKey.has(key)) continue;
      cellsByKey.set(key, { gx: cell.gx, gy: cell.gy, x: cell.x, y: cell.y });
      heightSum += deposit.height;
      heightCount++;
    }
  }

  const cells: DepositVisualCell[] = [];
  for (const cell of cellsByKey.values()) cells.push(cell);
  cells.sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx));
  const depositIds = new Array<number>(depositIndices.length);
  let id = Infinity;
  let maxDepositResourceHalfSize = BUILD_GRID_CELL_SIZE * 0.5;
  for (let i = 0; i < depositIndices.length; i++) {
    const deposit = deposits[depositIndices[i]];
    depositIds[i] = deposit.id;
    if (deposit.id < id) id = deposit.id;
    if (deposit.resourceHalfSize > maxDepositResourceHalfSize) {
      maxDepositResourceHalfSize = deposit.resourceHalfSize;
    }
  }
  const seed = hashMetalDepositVisualClusterSeed(depositIds);
  const height = heightCount > 0
    ? heightSum / heightCount
    : averageDeposits(depositIndices, deposits, 'height');

  if (cells.length === 0) {
    const x = averageDeposits(depositIndices, deposits, 'x');
    const y = averageDeposits(depositIndices, deposits, 'y');
    const resourceHalfSize = maxDepositResourceHalfSize;
    return { id, seed, x, y, height, cells, resourceHalfSize, depositIds };
  }

  let sumX = 0;
  let sumY = 0;
  let minGx = Infinity;
  let minGy = Infinity;
  let maxGx = -Infinity;
  let maxGy = -Infinity;
  for (const cell of cells) {
    sumX += cell.x;
    sumY += cell.y;
    minGx = Math.min(minGx, cell.gx);
    minGy = Math.min(minGy, cell.gy);
    maxGx = Math.max(maxGx, cell.gx);
    maxGy = Math.max(maxGy, cell.gy);
  }

  const resourceHalfSize = Math.max(
    BUILD_GRID_CELL_SIZE * 0.5,
    ((maxGx - minGx + 1) * BUILD_GRID_CELL_SIZE) / 2,
    ((maxGy - minGy + 1) * BUILD_GRID_CELL_SIZE) / 2,
  );
  return {
    id,
    seed,
    x: sumX / cells.length,
    y: sumY / cells.length,
    height,
    cells,
    resourceHalfSize,
    depositIds,
  };
}

function averageDeposits(
  depositIndices: readonly number[],
  deposits: ReadonlyArray<MetalDeposit>,
  field: 'height' | 'x' | 'y',
): number {
  if (depositIndices.length === 0) return 0;
  let sum = 0;
  for (const index of depositIndices) sum += deposits[index][field];
  return sum / depositIndices.length;
}

function hashMetalDepositVisualClusterSeed(depositIds: readonly number[]): number {
  let h = 2166136261 >>> 0;
  for (const id of depositIds) h = Math.imul(h ^ id, 16777619);
  return h >>> 0;
}
