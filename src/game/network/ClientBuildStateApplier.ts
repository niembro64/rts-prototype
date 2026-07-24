import type { Buildable, BuildingBlueprintId, Entity } from '../sim/types';
import { COST_MULTIPLIER } from '../../config';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getUnitBlueprint } from '../sim/blueprints';
import { createBuildable, getBuildFraction } from '../sim/buildableHelpers';
import { initializeConstructionPieceHealth } from '../sim/constructionLifecycle';

type NetworkBuildState = {
  complete: boolean;
  interrupted?: boolean;
  paid: Buildable['paid'];
};

// Build denominators are a content-version contract: snapshots ship
// dynamic paid counters, while host and client derive required cost
// from the same blueprint data (and COST_MULTIPLIER for units).
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
  return applyNetworkBuildStateFields(
    entity,
    build === undefined || build.complete,
    build?.interrupted === true,
    build?.paid.energy ?? 0,
    build?.paid.metal ?? 0,
    required,
  );
}

export function applyNetworkBuildStateFields(
  entity: Entity,
  complete: boolean,
  interrupted: boolean,
  paidEnergy: number,
  paidMetal: number,
  required: Buildable['required'] | undefined,
): boolean {
  if (complete) {
    if (!entity.buildable) return false;
    entity.buildable = null;
    return true;
  }

  if (!required) return false;
  let buildable = entity.buildable;
  if (!buildable) {
    buildable = createBuildable(required, {
      paid: { energy: paidEnergy, metal: paidMetal },
      isInterrupted: interrupted,
      healthBuildFraction: null,
    });
    buildable.healthBuildFraction = getBuildFraction(buildable);
    entity.buildable = buildable;
    initializeConstructionPieceHealth(entity);
    return true;
  }

  buildable.required.energy = required.energy;
  buildable.required.metal = required.metal;
  buildable.paid.energy = paidEnergy;
  buildable.paid.metal = paidMetal;
  buildable.isComplete = false;
  buildable.isInterrupted = interrupted;
  buildable.healthBuildFraction = getBuildFraction(buildable);
  initializeConstructionPieceHealth(entity);
  return true;
}
