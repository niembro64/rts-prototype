import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { factoryProductionSystem } from './factoryProduction';
import {
  deactivateBuildingActiveState,
  initializeBuildingActiveState,
  buildingBlueprintHasActiveState,
} from './buildingActiveState';
import { isEntityActive } from './buildableHelpers';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  clearExtractorMetalCoverage,
  computeExtractorMetalCoverage,
} from './metalDepositOwnership';

export function getExtractorMetalRate(entity: Entity): number {
  if (!isMetalExtractorBlueprintId(entity.buildingBlueprintId)) return 0;
  return entity.metalExtractionRate ?? 0;
}

export function applyCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  if (isMetalExtractorBlueprintId(entity.buildingBlueprintId) && entity.ownership) {
    // Covered-cell extraction. Walk every deposit the extractor
    // footprint overlaps and store metal/sec as a direct function of
    // how many generated metal cells are under this built footprint.
    // We DON'T credit income here — initializeBuildingActiveState
    // below starts the extractor CLOSED, and the per-tick driver only
    // flips it open (applying the rate delta) once the activation
    // debounce elapses; `open` is the single source of truth for "is
    // this extractor's rate currently in the player's tally."
    computeExtractorMetalCoverage(world, entity);
  }

  // Every on/off producer (solar, wind, extractor) goes through the
  // same activation policy: start CLOSED / not-producing, debounce to
  // OPEN after BUILDING_REOPEN_DELAY_MS.
  if (buildingBlueprintHasActiveState(entity.buildingBlueprintId) && entity.ownership) {
    initializeBuildingActiveState(world, entity);
  }
}

export function removeCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  if (entity.factory) {
    factoryProductionSystem.cancelActiveShell(world, entity);
  }

  // Deactivate forces the building closed, releasing its current
  // production (energy for solar, metal-rate for an open extractor) from
  // its owner's tally. A fortified (closed) building was already not
  // producing, so this is a no-op for it.
  if (
    buildingBlueprintHasActiveState(entity.buildingBlueprintId)
    && entity.ownership
    && isEntityActive(entity)
  ) {
    deactivateBuildingActiveState(entity);
  }

  if (isMetalExtractorBlueprintId(entity.buildingBlueprintId) && entity.ownership && isEntityActive(entity)) {
    // Clear covered-cell bookkeeping. The destroyed extractor's own
    // income was already removed by deactivateBuildingActiveState above,
    // so we ignore the helper's lostIncome return.
    clearExtractorMetalCoverage(world, entity);
  }
}
