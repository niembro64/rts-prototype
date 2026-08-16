import type { Entity, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';
import type { PointTargetEntitySource } from '@/types/input';

type PointTargetRelationship = 'friendly' | 'enemy';

export function isLivingPointTargetForPlayer(
  entity: Entity | null | undefined,
  playerId: PlayerId,
  relationship: PointTargetRelationship,
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined,
): entity is Entity {
  if (entity === null || entity === undefined || entity.ownership === null) {
    return false;
  }
  const targetPlayerId = entity.ownership.playerId;
  if (arePlayersAllied !== undefined) {
    const allied = arePlayersAllied(playerId, targetPlayerId);
    if (
      (relationship === 'friendly' && !allied) ||
      (relationship === 'enemy' && allied)
    ) {
      return false;
    }
  } else if (
    (relationship === 'friendly' && targetPlayerId !== playerId) ||
    (relationship === 'enemy' && targetPlayerId === playerId)
  ) {
    return false;
  }
  if (entity.unit !== null) return entity.unit.hp > 0;
  if (entity.building !== null) return entity.building.hp > 0;
  return false;
}

/**
 * Find the closest unit under a point, falling back to the closest building.
 * Units retain priority over buildings, matching command-surface behavior.
 */
export function findPointTargetAt(
  source: PointTargetEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
  relationship: PointTargetRelationship,
): Entity | null {
  const arePlayersAllied = source.arePlayersAllied;
  const units = source.getUnits();
  let closest: Entity | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (
      !isLivingPointTargetForPlayer(
        unit,
        playerId,
        relationship,
        arePlayersAllied,
      ) ||
      unit.unit === null
    ) {
      continue;
    }
    const dx = unit.transform.x - worldX;
    const dy = unit.transform.y - worldY;
    const distance = magnitude(dx, dy);
    if (
      distance <= unit.unit.radius.hitbox &&
      distance < closestDistance
    ) {
      closest = unit;
      closestDistance = distance;
    }
  }
  if (closest !== null) return closest;

  const buildings = source.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i];
    if (
      !isLivingPointTargetForPlayer(
        building,
        playerId,
        relationship,
        arePlayersAllied,
      ) ||
      building.building === null
    ) {
      continue;
    }
    const x = building.transform.x;
    const y = building.transform.y;
    const halfWidth = building.building.width / 2;
    const halfHeight = building.building.height / 2;
    if (
      worldX < x - halfWidth ||
      worldX > x + halfWidth ||
      worldY < y - halfHeight ||
      worldY > y + halfHeight
    ) {
      continue;
    }
    const dx = x - worldX;
    const dy = y - worldY;
    const distance = magnitude(dx, dy);
    if (distance < closestDistance) {
      closest = building;
      closestDistance = distance;
    }
  }
  return closest;
}
