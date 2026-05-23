import type { Entity, PlayerId } from './types';

const GUARD_FOLLOW_PADDING = 80;

export function isAliveGuardTarget(target: Entity | undefined): target is Entity {
  if (!target) return false;
  if (target.unit) return target.unit.hp > 0;
  if (target.building) return target.building.hp > 0;
  return false;
}

export function isFriendlyGuardTarget(
  target: Entity | undefined,
  playerId: PlayerId,
): target is Entity {
  return isAliveGuardTarget(target) &&
    target.ownership !== null &&
    target.ownership.playerId === playerId;
}

export function getGuardFollowRadius(entity: Entity, target: Entity): number {
  const unit = entity.unit;
  const targetUnit = target.unit;
  const targetBuilding = target.building;
  const unitRadius = unit === null ? 0 : unit.radius.body;
  let targetRadius = 0;
  if (targetUnit !== null) {
    targetRadius = targetUnit.radius.body;
  } else if (targetBuilding !== null) {
    targetRadius = targetBuilding.targetRadius ??
      Math.max(targetBuilding.width, targetBuilding.height) / 2;
  }
  return unitRadius + targetRadius + GUARD_FOLLOW_PADDING;
}
