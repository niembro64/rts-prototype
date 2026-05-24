// Metal-deposit coverage bookkeeping. Extractor income is directly
// proportional to the number of generated metal-producing build cells
// under the extractor footprint at the position where it was built:
//
//   metalExtractionRate = coveredMetalCellCount × perMetalCellProduction
//
// There is intentionally no whole-deposit ownership gate here. Building
// footprints cannot overlap on the build grid, so two extractors cannot
// produce from the same metal cell at the same time, but they may split
// different cells from the same irregular deposit.
//
// Visual / wire-format consistency falls out automatically:
// `metalExtractionRate` is wire-serialized and the renderer's
// rotor-spin animator reads from it, so spin = "is there income"
// without any additional state.

import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import {
  getMetalDepositCoveredCellCount,
  getMetalDepositsOverlappingBuildingFootprint,
} from './metalDeposits';

/** Resolve an extractor's grid-aligned footprint AABB from its world
 *  transform + the extractor building config. The construction system
 *  snaps build positions to cell-aligned tops, so the integer grid
 *  index is `floor((center − halfSize) / cellSize + ε)`. */
function getExtractorFootprintGrid(entity: Entity): {
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
} | null {
  if (entity.buildingType !== 'extractor' || !entity.building) return null;
  const cfg = getBuildingConfig('extractor');
  const halfW = (cfg.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
  const halfH = (cfg.gridHeight * BUILD_GRID_CELL_SIZE) / 2;
  const gridX = Math.floor((entity.transform.x - halfW) / BUILD_GRID_CELL_SIZE + 1e-6);
  const gridY = Math.floor((entity.transform.y - halfH) / BUILD_GRID_CELL_SIZE + 1e-6);
  return { gridX, gridY, gridW: cfg.gridWidth, gridH: cfg.gridHeight };
}

function baseProduction(): number {
  return getBuildingConfig('extractor').metalProduction ?? 0;
}

function perMetalCellProduction(): number {
  const nominalCellCount = Math.max(
    1,
    METAL_DEPOSIT_CONFIG.resourceCells * METAL_DEPOSIT_CONFIG.resourceCells,
  );
  return baseProduction() / nominalCellCount;
}

/** Set the extractor's stored fields to match the metal cells covered
 *  by its current fixed grid footprint. */
function syncExtractorRateFromCoveredCells(world: WorldState, extractor: Entity): void {
  const footprint = getExtractorFootprintGrid(extractor);
  if (!footprint) {
    extractor.coveredDepositIds = [];
    extractor.metalExtractionRate = 0;
    return;
  }

  const touchedDepositIds: number[] = [];
  let coveredCellCount = 0;
  const candidates = getMetalDepositsOverlappingBuildingFootprint(
    world.metalDeposits,
    footprint.gridX,
    footprint.gridY,
    footprint.gridW,
    footprint.gridH,
  );
  for (const deposit of candidates) {
    const coveredCells = getMetalDepositCoveredCellCount(
      deposit,
      footprint.gridX,
      footprint.gridY,
      footprint.gridW,
      footprint.gridH,
    );
    if (coveredCells <= 0) continue;
    touchedDepositIds.push(deposit.id);
    coveredCellCount += coveredCells;
  }
  extractor.coveredDepositIds = touchedDepositIds;
  extractor.metalExtractionRate = coveredCellCount * perMetalCellProduction();
}

/** First-time coverage calculation, called from applyCompletedBuildingEffects.
 *  Records the deposit ids touched by the extractor footprint and
 *  stores metal/sec as a direct function of covered metal cells. */
export function computeExtractorMetalCoverage(
  world: WorldState,
  extractor: Entity,
): number {
  if (extractor.buildingType !== 'extractor' || !extractor.ownership) return 0;
  syncExtractorRateFromCoveredCells(world, extractor);
  return extractor.metalExtractionRate ?? 0;
}

/** Clear extractor coverage bookkeeping. There is no transfer step:
 *  another extractor could not have been over the same build cells
 *  while this extractor occupied them. */
export function clearExtractorMetalCoverage(
  world: WorldState,
  extractor: Entity,
): number {
  void world;
  if (extractor.buildingType !== 'extractor' || !extractor.ownership) return 0;
  const lostIncome = extractor.metalExtractionRate ?? 0;
  extractor.coveredDepositIds = [];
  extractor.metalExtractionRate = 0;
  return lostIncome;
}
