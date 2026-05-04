import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import { deactivateSolarCollector, startSolarCollectorClosed } from './solarCollector';
import { spatialGrid } from './SpatialGrid';
import { isEntityActive } from './buildableHelpers';
import {
  claimDepositsForExtractor,
  releaseDepositsForExtractor,
} from './metalDepositOwnership';

export function getExtractorMetalRate(entity: Entity): number {
  if (entity.buildingType !== 'extractor') return 0;
  return entity.metalExtractionRate ?? 0;
}

export function applyCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  spatialGrid.syncBuildingCapture(entity);

  if (entity.buildingType === 'solar' && entity.ownership) {
    startSolarCollectorClosed(world, entity);
  }

  if (entity.buildingType === 'extractor' && entity.ownership) {
    // Binary deposit-claim system. Walk every deposit the extractor
    // footprint overlaps; each currently-free deposit becomes owned
    // by this extractor. Already-owned deposits stay where they are.
    // The returned amount is the post-claim rate (extractor was
    // inactive before this call), which is what we add to the
    // player's income.
    const claimedRate = claimDepositsForExtractor(world, entity);
    if (claimedRate > 0) {
      economyManager.addMetalExtraction(entity.ownership.playerId, claimedRate);
    }
  }
}

export function removeCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  if (entity.factory) {
    factoryProductionSystem.cancelActiveShell(world, entity);
  }

  if (entity.buildingType === 'solar' && entity.ownership && isEntityActive(entity)) {
    deactivateSolarCollector(entity);
  }

  if (entity.buildingType === 'extractor' && entity.ownership && isEntityActive(entity)) {
    // Release every owned deposit. For each released deposit the
    // helper looks for a surviving completed extractor whose
    // footprint still covers it and promotes that extractor to the
    // new owner — adding ITS income delta to ITS player's tally
    // directly via economyManager (so the destroyed extractor's
    // player loses everything, but a successor's player may gain
    // back per-deposit income on the same tick).
    const lostIncome = releaseDepositsForExtractor(world, entity);
    if (lostIncome > 0) {
      economyManager.removeMetalExtraction(entity.ownership.playerId, lostIncome);
    }
  }
}
