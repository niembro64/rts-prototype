// Guard / assist target detection helper.

import type { Entity, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';

export type { GuardEntitySource } from '@/types/input';
import type { GuardEntitySource } from '@/types/input';

export function isGuardableFriendlyTarget(
  entity: Entity | null | undefined,
  playerId: PlayerId,
): entity is Entity {
  if (!entity?.ownership || entity.ownership.playerId !== playerId) return false;
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

function findFriendlyUnitAt(
  entitySource: GuardEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  let closest: Entity | null = null;
  let closestDist = Infinity;

  for (const unit of entitySource.getUnits()) {
    if (!isGuardableFriendlyTarget(unit, playerId) || !unit.unit) continue;
    const dx = unit.transform.x - worldX;
    const dy = unit.transform.y - worldY;
    const dist = magnitude(dx, dy);
    if (dist <= unit.unit.radius.body && dist < closestDist) {
      closest = unit;
      closestDist = dist;
    }
  }

  return closest;
}

function findFriendlyBuildingAt(
  entitySource: GuardEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  let closest: Entity | null = null;
  let closestDist = Infinity;

  for (const building of entitySource.getBuildings()) {
    if (!isGuardableFriendlyTarget(building, playerId) || !building.building) continue;
    const { x, y } = building.transform;
    const halfW = building.building.width / 2;
    const halfH = building.building.height / 2;

    if (worldX >= x - halfW && worldX <= x + halfW &&
        worldY >= y - halfH && worldY <= y + halfH) {
      const dx = x - worldX;
      const dy = y - worldY;
      const dist = magnitude(dx, dy);
      if (dist < closestDist) {
        closest = building;
        closestDist = dist;
      }
    }
  }

  return closest;
}

export function findGuardTargetAt(
  entitySource: GuardEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  const unit = findFriendlyUnitAt(entitySource, worldX, worldY, playerId);
  if (unit) return unit;
  return findFriendlyBuildingAt(entitySource, worldX, worldY, playerId);
}
