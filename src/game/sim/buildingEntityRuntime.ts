import type { BuildingBlueprintId, Entity, EntityId } from './types';
import { createCombatComponent } from './types';
import { isTowerBuildingBlueprintId } from '../../types/buildingTypes';
import { getBuildingBlueprint } from './blueprints';
import {
  buildingBlueprintHasActiveState,
  ensureBuildingActiveState,
} from './buildingActiveState';
import { applyEntitySensorBlueprint } from './cloakDetection';
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

  applyEntitySensorBlueprint(entity, getBuildingBlueprint(buildingBlueprintId));
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
