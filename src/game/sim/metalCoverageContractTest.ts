// Contract: the METAL setting moves ORE, never LAND.
//
// NONE / SOME / MORE / ALL all run the identical deposit pipeline — same
// placements, same pad radii, same resolved heights, same installed flat
// zones — so a player switching rungs gets the exact same world to fight
// over and only the metal on it changes. That is the whole promise of the
// setting, and it is the kind of thing that breaks silently: give ore size
// any say in a pad radius or a plateau radius and the terrain quietly
// deforms one rung at a time.
//
// What each rung owes on top of that identical land:
//   NONE - no deposits at all (the pads they shaped stay behind).
//   SOME - one default-size ore body per spot.
//   MORE - the authored per-ring sizes, which must actually be bigger.
//   ALL  - the same ore bodies as MORE; the whole-map metal read lives in
//          worldSurfaceState, not in the generated bodies.

import { LAND_CELL_SIZE } from '../../config';
import {
  METAL_DEPOSIT_CONFIG,
  generateMetalDeposits,
  getMetalDepositSize,
  type MetalDeposit,
} from '../../metalDepositConfig';
import { METAL_COVERAGES, type MetalCoverage } from '../../types/worldSurfaceMode';
import { getModeDefaultPreset } from '../../components/battlePresets';
import { getMetalDepositFlatZones } from './terrain/terrainFlatZones';
import {
  getTerrainRuntimeConfig,
  setTerrainRuntimeConfig,
} from './terrain/terrainState';

const CONTRACT_PLAYER_COUNT = 3;

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[metal coverage contract] ${message}`);
  }
}

/** Everything the terrain pipeline consumes, and nothing the ore decides.
 *  Serialized so a single deep comparison covers every zone field. */
function terrainSignature(): string {
  return JSON.stringify(getMetalDepositFlatZones());
}

/** The deposit fields that describe WHERE a deposit is and how it shaped the
 *  land — as opposed to how much ore ended up on it. */
function placementSignature(deposits: readonly MetalDeposit[]): string {
  return JSON.stringify(deposits.map((deposit) => [
    deposit.id,
    deposit.x,
    deposit.y,
    deposit.height,
    deposit.dTerrainLevels,
    deposit.flatPadRadius,
    deposit.placementRadius,
    deposit.blendRadius,
    deposit.groupId,
  ]));
}

function oreSignature(deposits: readonly MetalDeposit[]): string {
  return JSON.stringify(deposits.map((deposit) => deposit.cells.map((c) => [c.gx, c.gy])));
}

export function runMetalCoverageContractTest(): void {
  const preset = getModeDefaultPreset('demo');
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    perimeterMagnitude: preset.perimeterMagnitude,
    terrainPrecedence: preset.terrainPrecedence,
    terrainDTerrain: preset.terrainDTerrain,
    plateauWallSlopeDegrees: preset.plateauWallSlopeDegrees,
    metalDepositStep: preset.metalDepositStep,
    terrainDetail: preset.terrainDetail,
  });
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;

  try {
    const byCoverage = new Map<MetalCoverage, {
      deposits: readonly MetalDeposit[];
      terrain: string;
    }>();
    for (const coverage of METAL_COVERAGES) {
      const deposits = generateMetalDeposits(
        mapWidth,
        mapHeight,
        CONTRACT_PLAYER_COUNT,
        coverage,
      );
      byCoverage.set(coverage, { deposits, terrain: terrainSignature() });
    }

    const reference = byCoverage.get('more');
    assertContract(reference !== undefined, 'MORE must generate a deposit set');
    assertContract(
      reference.terrain.length > 2 && reference.deposits.length > 0,
      'the reference rung must actually produce deposits and flat zones',
    );

    // 1. Identical land on every rung — the setting's entire promise.
    for (const coverage of METAL_COVERAGES) {
      const run = byCoverage.get(coverage)!;
      assertContract(
        run.terrain === reference.terrain,
        `METAL ${coverage.toUpperCase()} must install the exact same terrain flat zones as MORE`,
      );
    }

    // 2. Identical deposit placement wherever deposits exist at all.
    for (const coverage of ['some', 'all'] as const) {
      const run = byCoverage.get(coverage)!;
      assertContract(
        placementSignature(run.deposits) === placementSignature(reference.deposits),
        `METAL ${coverage.toUpperCase()} must place the same deposits, at the same pads, as MORE`,
      );
    }

    // 3. Per-rung ore.
    const defaultSize = getMetalDepositSize(METAL_DEPOSIT_CONFIG.defaultSize);
    const defaultCellCount = defaultSize.metalCellCount;

    assertContract(
      byCoverage.get('none')!.deposits.length === 0,
      'METAL NONE must leave no deposits to mine',
    );

    const some = byCoverage.get('some')!.deposits;
    assertContract(
      some.every((deposit) => deposit.metalCellCount === defaultCellCount),
      `METAL SOME must grow one ${METAL_DEPOSIT_CONFIG.defaultSize} body per spot`,
    );

    assertContract(
      reference.deposits.every((deposit) => deposit.metalCellCount >= defaultCellCount) &&
        reference.deposits.some((deposit) => deposit.metalCellCount > defaultCellCount),
      'METAL MORE must scatter the authored oversized ore bodies',
    );

    assertContract(
      oreSignature(byCoverage.get('all')!.deposits) === oreSignature(reference.deposits),
      'METAL ALL must keep the authored ore bodies under its all-metal map',
    );
  } finally {
    setTerrainRuntimeConfig(previousRuntimeConfig);
    // Leave the module-level flat zones matching the restored terrain config,
    // the same courtesy every other deposit-generating contract test pays.
    generateMetalDeposits(mapWidth, mapHeight, CONTRACT_PLAYER_COUNT, 'more');
  }
}
