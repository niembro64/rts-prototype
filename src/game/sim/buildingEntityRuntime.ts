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
    const buildingConfig = getBuildingConfig(buildingBlueprintId);
    entity.building.supportSurface = cloneBuildingSupportSurface(
      buildingConfig.supportSurface,
      entity.transform.rotation,
    );
    entity.building.hoveringType = buildingConfig.hoveringType;
    entity.building.hovering = buildingConfig.hovering;
    entity.building.targetRadius = buildingConfig.radius.hitbox;
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
