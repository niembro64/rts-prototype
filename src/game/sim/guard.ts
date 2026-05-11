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
    target.ownership !== undefined &&
    target.ownership.playerId === playerId;
}

export function getGuardFollowRadius(entity: Entity, target: Entity): number {
  const unitRadius = entity.unit?.radius.body ?? 0;
  const targetRadius = target.unit?.radius.body ??
    target.building?.targetRadius ??
    (target.building ? Math.max(target.building.width, target.building.height) / 2 : 0);
  return unitRadius + targetRadius + GUARD_FOLLOW_PADDING;
}
