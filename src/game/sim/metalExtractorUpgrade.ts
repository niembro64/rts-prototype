import type { Entity, PlayerId } from './types';
import { isBuildInProgress } from './buildableHelpers';
import { entityCanBuild } from './builderBuildRoster';

export const METAL_EXTRACTOR_T1_BLUEPRINT_ID = 'buildingExtractor' as const;
export const METAL_EXTRACTOR_T2_BLUEPRINT_ID = 'buildingExtractorT2' as const;

export function canBuilderUpgradeMetalExtractor(builder: Entity | null | undefined): boolean {
  return entityCanBuild(builder, METAL_EXTRACTOR_T1_BLUEPRINT_ID);
}

export function isUpgradeableMetalExtractorTarget(
  entity: Entity | null | undefined,
  playerId?: PlayerId,
): entity is Entity {
  if (entity === null || entity === undefined) return false;
  if (entity.buildingBlueprintId !== METAL_EXTRACTOR_T1_BLUEPRINT_ID) return false;
  if (entity.building === null || entity.building.hp <= 0) return false;
  if (entity.buildable !== null && isBuildInProgress(entity.buildable)) return false;
  if (playerId !== undefined && entity.ownership?.playerId !== playerId) return false;
  return true;
}
