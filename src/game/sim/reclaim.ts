import type { Entity, ResourceCost } from './types';
import { getBuildingConfig, getUnitBuildConfig } from './buildConfigs';
import { cloneResourceCost, makeZeroResourceCost } from './buildableHelpers';

export const RECLAIM_REFUND_FRACTION = 0.5;

export function isReclaimableTarget(target: Entity | null | undefined): target is Entity {
  if (!target || target.commander) return false;
  if (target.buildable?.isGhost) return false;
  if (target.unit) return target.unit.hp > 0;
  if (target.building) return target.building.hp > 0;
  return false;
}

export function getReclaimResourceValue(target: Entity): ResourceCost {
  if (target.buildable && !target.buildable.isGhost) {
    const hpState = target.unit ?? target.building;
    const hpFraction = hpState ? hpState.hp / Math.max(1, hpState.maxHp) : 0;
    const buildFraction = Math.max(
      0.0001,
      Math.min(1, Math.max(target.buildable.healthBuildFraction ?? 0, hpFraction)),
    );
    return {
      energy: target.buildable.paid.energy / buildFraction,
      mana: target.buildable.paid.mana / buildFraction,
      metal: target.buildable.paid.metal / buildFraction,
    };
  }

  if (target.buildingType) {
    return cloneResourceCost(getBuildingConfig(target.buildingType).cost);
  }

  if (target.unit?.unitType) {
    const config = getUnitBuildConfig(target.unit.unitType);
    if (config) return cloneResourceCost(config.cost);
  }

  return makeZeroResourceCost();
}
