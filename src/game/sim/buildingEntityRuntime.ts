import type { BuildingBlueprintId, Entity, EntityId } from './types';
import { createCombatComponent } from './types';
import { isTowerBuildingBlueprintId } from '../../types/buildingTypes';
import {
  buildingBlueprintHasActiveState,
  ensureBuildingActiveState,
} from './buildingActiveState';
import { createBuildingRuntimeTurrets } from './runtimeTurrets';

export type ApplyBuildingBlueprintRuntimeOptions = {
  allocateEntityId?: (() => EntityId) | null;
};

export function applyBuildingBlueprintRuntime(
  entity: Entity,
  buildingBlueprintId: BuildingBlueprintId,
  options: ApplyBuildingBlueprintRuntimeOptions = {},
): void {
  entity.buildingBlueprintId = buildingBlueprintId;
  entity.type = isTowerBuildingBlueprintId(buildingBlueprintId) ? 'tower' : 'building';

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
