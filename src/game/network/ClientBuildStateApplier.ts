import type { Buildable, BuildingType, Entity } from '../sim/types';
import { COST_MULTIPLIER } from '../../config';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getUnitBlueprint } from '../sim/blueprints';
import { createBuildable, getBuildFraction } from '../sim/buildableHelpers';

export type NetworkBuildState = {
  complete: boolean;
  progress?: number;
  paid: Buildable['paid'];
};

export function getUnitBuildRequired(
  unitType: string | undefined,
): Buildable['required'] | undefined {
  if (!unitType) return undefined;
  try {
    const bp = getUnitBlueprint(unitType);
    return {
      energy: bp.cost.energy * COST_MULTIPLIER,
      mana: bp.cost.mana * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    };
  } catch {
    return undefined;
  }
}

export function getBuildingBuildRequired(
  buildingType: BuildingType | undefined,
): Buildable['required'] | undefined {
  if (!buildingType) return undefined;
  try {
    return { ...getBuildingConfig(buildingType).cost };
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
    delete entity.buildable;
    return true;
  }

  if (!required) return false;
  let buildable = entity.buildable;
  if (!buildable) {
    buildable = createBuildable(required, { paid: build.paid });
    buildable.healthBuildFraction = getBuildFraction(buildable);
    entity.buildable = buildable;
    return true;
  }

  buildable.required.energy = required.energy;
  buildable.required.mana = required.mana;
  buildable.required.metal = required.metal;
  buildable.paid.energy = build.paid.energy;
  buildable.paid.mana = build.paid.mana;
  buildable.paid.metal = build.paid.metal;
  buildable.isComplete = false;
  buildable.isGhost = false;
  buildable.healthBuildFraction = getBuildFraction(buildable);
  return true;
}
