import type { BuildingBlueprintId, Entity, EntityId } from './types';
import { createCombatComponent } from './types';
import { isTowerBuildingBlueprintId } from '../../types/buildingTypes';
import {
  buildingBlueprintHasActiveState,
  ensureBuildingActiveState,
} from './buildingActiveState';
import { cloneBuildingSupportSurface } from './buildingSupportSurface';
import { getBuildingConfig } from './buildConfigs';
import { createBuildingRuntimeTurrets } from './runtimeTurrets';

type ApplyBuildingBlueprintRuntimeOptions = {
  allocateEntityId?: (() => EntityId) | null;
};

export function applyBuildingBlueprintRuntime(
  entity: Entity,
  buildingBlueprintId: BuildingBlueprintId,
  options: ApplyBuildingBlueprintRuntimeOptions = {},
): void {
  entity.buildingBlueprintId = buildingBlueprintId;
  entity.type = isTowerBuildingBlueprintId(buildingBlueprintId) ? 'tower' : 'building';

  if (entity.building !== null) {
    entity.building.supportSurface = cloneBuildingSupportSurface(
      getBuildingConfig(buildingBlueprintId).supportSurface,
      entity.transform.rotation,
    );
  }

  if (buildingBlueprintHasActiveState(buildingBlueprintId)) {
    ensureBuildingActiveState(entity);
  }

  const buildingTurrets = createBuildingRuntimeTurrets(
    buildingBlueprintId,
    entity.id,
    entity.id,
    options.allocateEntityId ?? null,
  );
  entity.combat = buildingTurrets.length > 0
    ? createCombatComponent(buildingTurrets)
    : null;
}
