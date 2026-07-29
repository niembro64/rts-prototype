import type { Entity, EntityId, ResourceCost } from './types';
import type { WorldState } from './WorldState';
import { getBuildingConfig, getUnitBuildConfig } from './buildConfigs';
import { makeZeroResourceCost } from './buildableHelpers';
import { isBuildRadiusTargetInRange, isBuildTargetInRange } from './builderRange';
import {
  getLiveVegetationPropByTargetId,
  isVegetationTargetId,
  type VegetationProp,
} from './vegetation';

export const RECLAIM_REFUND_FRACTION = 0.5;

export function isReclaimableTarget(target: Entity | null | undefined): target is Entity {
  if (!target || target.commander) return false;
  if (target.unit) return target.unit.hp > 0;
  if (target.building) return target.building.hp > 0;
  return false;
}

export function getReclaimResourceValue(target: Entity): ResourceCost {
  if (target.buildable) {
    const hpState = target.unit ?? target.building;
    const hpFraction = hpState ? hpState.hp / Math.max(1, hpState.maxHp) : 0;
    const buildFraction = Math.max(
      0.0001,
      Math.min(1, Math.max(target.buildable.healthBuildFraction, hpFraction)),
    );
    return {
      energy: target.buildable.paid.energy / buildFraction,
      metal: target.buildable.paid.metal / buildFraction,
    };
  }

  if (target.buildingBlueprintId) {
    const cost = getBuildingConfig(target.buildingBlueprintId).cost;
    return { energy: 0, metal: cost.metal };
  }

  if (target.unit !== null) {
    const config = getUnitBuildConfig(target.unit.unitBlueprintId);
    if (config) return { energy: 0, metal: config.cost.metal };
  }

  return makeZeroResourceCost();
}

/**
 * What a reclaim command or `reclaim` action is pointed at. BAR gives
 * constructors one Reclaim command that works on both units/buildings
 * and world features; the two live in different stores, so this union
 * is where the reclaim path stops caring which. Every reclaim call site
 * resolves a target id through `resolveReclaimTarget` and then works
 * against the common `id` / world-position fields.
 */
export type ReclaimTarget =
  | { kind: 'entity'; id: EntityId; entity: Entity; x: number; y: number; z: number; radius: number }
  | { kind: 'vegetation'; id: EntityId; prop: VegetationProp; x: number; y: number; z: number; radius: number };

export function makeEntityReclaimTarget(entity: Entity): ReclaimTarget {
  return {
    kind: 'entity',
    id: entity.id,
    entity,
    x: entity.transform.x,
    y: entity.transform.y,
    z: entity.transform.z,
    radius: entity.unit?.radius.collision ?? 0,
  };
}

export function makeVegetationReclaimTarget(prop: VegetationProp): ReclaimTarget {
  return {
    kind: 'vegetation',
    id: prop.targetId,
    prop,
    x: prop.x,
    y: prop.y,
    // Aim at the prop's mid-height so the work spray meets the trunk
    // rather than the ground under it.
    z: prop.z + prop.height * 0.5,
    radius: prop.radius,
  };
}

/**
 * Resolve a reclaim target id against both stores. Vegetation ids sit
 * above `VEGETATION_TARGET_ID_BASE` (BAR's `featureID + Game.maxUnits`
 * convention), so the check is a range test rather than a failed entity
 * lookup. Returns null for anything that is no longer reclaimable.
 */
export function resolveReclaimTarget(
  world: WorldState,
  targetId: number | null | undefined,
): ReclaimTarget | null {
  if (targetId === null || targetId === undefined) return null;
  if (isVegetationTargetId(targetId)) {
    const prop = getLiveVegetationPropByTargetId(targetId);
    return prop === undefined ? null : makeVegetationReclaimTarget(prop);
  }
  const entity = world.getEntity(targetId);
  return isReclaimableTarget(entity) ? makeEntityReclaimTarget(entity) : null;
}

/** True while the target id still names something worth reclaiming. */
export function isReclaimTargetIdAlive(
  world: WorldState,
  targetId: number | null | undefined,
): boolean {
  return resolveReclaimTarget(world, targetId) !== null;
}

export function isReclaimTargetInBuildRange(
  builder: Entity,
  target: ReclaimTarget,
): boolean {
  return target.kind === 'entity'
    ? isBuildTargetInRange(builder, target.entity)
    : isBuildRadiusTargetInRange(builder, target.x, target.y, target.radius);
}
