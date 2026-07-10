import type { MetalDeposit } from '../../metalDepositConfig';
import {
  createMetalDepositSurfaceIndex,
  METAL_DEPOSIT_COIN_TOP_LIFT,
  metalDepositCellKey,
} from './MetalDepositVisualClusters';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[metal deposit visual clusters contract] ${message}`);
  }
}

function assertNear(actual: number | undefined, expected: number, message: string): void {
  if (actual === undefined || Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[metal deposit visual clusters contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function makeDeposit(id: number, gx: number, gy: number, height: number): MetalDeposit {
  const x = gx * 20 + 10;
  const y = gy * 20 + 10;
  return {
    id,
    x,
    y,
    gridX: gx,
    gridY: gy,
    demoAutoExtractor: true,
    originGx: gx,
    originGy: gy,
    resourceCells: 1,
    cells: [{ gx, gy, x, y }],
    resourceCellCount: 1,
    resourceRadiusCells: 1,
    boundsGridX: gx,
    boundsGridY: gy,
    boundsGridW: 1,
    boundsGridH: 1,
    resourceHalfSize: 10,
    resourceRadius: 10,
    flatPadRadius: 10,
    dTerrainLevels: null,
    height,
    blendRadius: 0,
  };
}

export function runMetalDepositVisualClustersContractTest(): void {
  const low = makeDeposit(10, 3, 4, 100);
  const high = makeDeposit(11, 4, 4, 200);
  const surfaceIndex = createMetalDepositSurfaceIndex([low, high]);
  const mergedSurfaceY = 150 + METAL_DEPOSIT_COIN_TOP_LIFT;

  assertNear(
    surfaceIndex.surfaceYByCell.get(metalDepositCellKey(low.originGx, low.originGy)),
    mergedSurfaceY,
    'low adjacent cell must use merged visual cluster surface',
  );
  assertNear(
    surfaceIndex.surfaceYByCell.get(metalDepositCellKey(high.originGx, high.originGy)),
    mergedSurfaceY,
    'high adjacent cell must use merged visual cluster surface',
  );
  assertNear(
    surfaceIndex.surfaceYById.get(low.id),
    mergedSurfaceY,
    'low deposit id must use merged visual cluster surface',
  );
  assertNear(
    surfaceIndex.surfaceYById.get(high.id),
    mergedSurfaceY,
    'high deposit id must use merged visual cluster surface',
  );

  const distant = makeDeposit(12, 20, 20, 300);
  const separateIndex = createMetalDepositSurfaceIndex([low, distant]);
  assertContract(
    separateIndex.surfaceYById.get(low.id) !== separateIndex.surfaceYById.get(distant.id),
    'non-adjacent deposits must keep separate visual surfaces',
  );
}
