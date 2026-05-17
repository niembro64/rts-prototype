import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { factoryProductionSystem } from './factoryProduction';
import {
  activateBuildingActiveState,
  deactivateBuildingActiveState,
  startBuildingActiveStateClosed,
  buildingTypeHasActiveState,
} from './buildingActiveState';
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

  if (entity.buildingType === 'extractor' && entity.ownership) {
    // Binary deposit-claim system. Walk every deposit the extractor
    // footprint overlaps; each currently-free deposit becomes owned
    // by this extractor. Already-owned deposits stay where they are.
    // We DON'T credit income here — activateBuildingActiveState below
    // calls setBuildingProducing(open=true) which adds the just-claimed
    // rate to the player's tally, so the two paths share one source of
    // truth ("am I currently open?") rather than racing.
    claimDepositsForExtractor(world, entity);
  }

  // Solar starts closed (visual + production matches the rest of the
  // close-on-damage flow); wind + extractor start open and producing,
  // which is also where extractor's metal income kicks in.
  if (entity.buildingType === 'solar' && entity.ownership) {
    startBuildingActiveStateClosed(world, entity);
  } else if (
    buildingTypeHasActiveState(entity.buildingType) && entity.ownership
  ) {
    activateBuildingActiveState(world, entity);
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
