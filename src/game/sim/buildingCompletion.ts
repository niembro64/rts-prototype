import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { getBuildingConfig } from './buildConfigs';
import { economyManager } from './economy';
import { deactivateSolarCollector, startSolarCollectorClosed } from './solarCollector';
import { spatialGrid } from './SpatialGrid';

export function getExtractorMetalRate(entity: Entity): number {
  if (entity.buildingType !== 'extractor') return 0;
  const fallback = getBuildingConfig('extractor').metalProduction ?? 0;
  return entity.metalExtractionRate ?? fallback;
}

export function applyCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  spatialGrid.syncBuildingCapture(entity);

  if (entity.buildingType === 'solar' && entity.ownership) {
    startSolarCollectorClosed(world, entity);
  }

  if (entity.buildingType === 'extractor' && entity.ownership) {
    const amount = getExtractorMetalRate(entity);
    if (amount > 0) {
      economyManager.addMetalExtraction(entity.ownership.playerId, amount);
    }
  }
}

export function removeCompletedBuildingEffects(entity: Entity): void {
  if (entity.buildingType === 'solar' && entity.ownership && entity.buildable?.isComplete) {
    deactivateSolarCollector(entity);
  }

  if (entity.buildingType === 'extractor' && entity.ownership && entity.buildable?.isComplete) {
    const amount = getExtractorMetalRate(entity);
    if (amount > 0) {
      economyManager.removeMetalExtraction(entity.ownership.playerId, amount);
    }
  }
}
