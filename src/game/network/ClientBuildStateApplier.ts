import type { Buildable, BuildingBlueprintId, Entity } from '../sim/types';
import { COST_MULTIPLIER } from '../../config';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getUnitBlueprint } from '../sim/blueprints';
import { createBuildable, getBuildFraction } from '../sim/buildableHelpers';

export type NetworkBuildState = {
  complete: boolean;
  paid: Buildable['paid'];
};

export function getUnitBuildRequired(
  unitBlueprintId: string | undefined,
): Buildable['required'] | undefined {
  if (!unitBlueprintId) return undefined;
  try {
    const bp = getUnitBlueprint(unitBlueprintId);
    return {
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    };
  } catch {
    return undefined;
  }
}

export function getBuildingBuildRequired(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): Buildable['required'] | undefined {
  if (!buildingBlueprintId) return undefined;
  try {
    return { ...getBuildingConfig(buildingBlueprintId).cost };
  } catch {
    return undefined;
  }
}

export function applyNetworkBuildState(
  entity: Entity,
  build: NetworkBuildState | undefined,
  required: Buildable['required'] | undefined,
): boolean {
  if (!build || build.complete) {
    if (!entity.buildable) return false;
    entity.buildable = null;
    return true;
  }

  if (!required) return false;
  let buildable = entity.buildable;
  if (!buildable) {
    buildable = createBuildable(required, {
      paid: build.paid,
      isGhost: null,
      healthBuildFraction: null,
    });
    buildable.healthBuildFraction = getBuildFraction(buildable);
    entity.buildable = buildable;
    return true;
  }

  buildable.required.energy = required.energy;
  buildable.required.metal = required.metal;
  buildable.paid.energy = build.paid.energy;
  buildable.paid.metal = build.paid.metal;
  buildable.isComplete = false;
  buildable.isGhost = false;
  buildable.healthBuildFraction = getBuildFraction(buildable);
  return true;
}
