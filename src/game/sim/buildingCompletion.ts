import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { factoryProductionSystem } from './factoryProduction';
import {
  deactivateBuildingActiveState,
  initializeBuildingActiveState,
  buildingTypeHasActiveState,
} from './buildingActiveState';
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
  if (entity.buildingType === 'extractor' && entity.ownership) {
    // Binary deposit-claim system with covered-cell output. Walk every
    // deposit the extractor footprint overlaps; each currently-free
    // deposit becomes owned by this extractor. Already-owned deposits
    // stay where they are; the stored extractor rate is the owned
    // deposits' covered-cell fraction.
    // We DON'T credit income here — initializeBuildingActiveState
    // below starts the extractor CLOSED, and the per-tick driver only
    // calls setBuildingProducing(open=true) once the activation
    // debounce elapses; that's the single source of truth for "is
    // this extractor's rate currently in the player's tally."
    claimDepositsForExtractor(world, entity);
  }

  // Every on/off producer (solar, wind, extractor) goes through the
  // same activation policy: start CLOSED / not-producing, debounce to
  // OPEN after BUILDING_REOPEN_DELAY_MS.
  if (buildingTypeHasActiveState(entity.buildingType) && entity.ownership) {
    initializeBuildingActiveState(world, entity);
  }
}

export function removeCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  if (entity.factory) {
    factoryProductionSystem.cancelActiveShell(world, entity);
  }

  // Deactivate runs setBuildingProducing(false), which removes the
  // building's current production (energy for solar, metal-rate for an
  // open extractor) from its owner's tally. A fortified (closed)
  // building was already not producing, so this is a no-op for it.
  if (
    buildingTypeHasActiveState(entity.buildingType)
    && entity.ownership
    && isEntityActive(entity)
  ) {
    deactivateBuildingActiveState(entity);
  }

  if (entity.buildingType === 'extractor' && entity.ownership && isEntityActive(entity)) {
    // Release every owned deposit. For each released deposit the
    // helper looks for a surviving completed extractor whose
    // footprint still covers it and promotes that extractor to the
    // new owner — adding ITS income delta to ITS player's tally only
    // if the successor is currently OPEN. The destroyed extractor's
    // own income was already removed by deactivateBuildingActiveState
    // above, so we ignore the helper's lostIncome return.
    releaseDepositsForExtractor(world, entity);
  }
}
