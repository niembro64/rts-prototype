// Attack target detection helper — find enemy units/buildings under cursor

import type { Entity, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';

export type { AttackEntitySource } from '@/types/input';
import type { AttackEntitySource } from '@/types/input';

// Find an enemy unit at a world position
function findEnemyUnitAt(
  entitySource: AttackEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  let closest: Entity | null = null;
  let closestDist = Infinity;

  for (const unit of entitySource.getUnits()) {
    if (!unit.ownership || unit.ownership.playerId === playerId) continue;
    if (!unit.unit || unit.unit.hp <= 0) continue;

    const dx = unit.transform.x - worldX;
    const dy = unit.transform.y - worldY;
    const dist = magnitude(dx, dy);

    if (dist <= unit.unit.bodyRadius && dist < closestDist) {
      closest = unit;
      closestDist = dist;
    }
  }

  return closest;
}

// Find an enemy building at a world position
function findEnemyBuildingAt(
  entitySource: AttackEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  for (const building of entitySource.getBuildings()) {
    if (!building.ownership || building.ownership.playerId === playerId) continue;
    if (!building.building || building.building.hp <= 0) continue;

    const { x, y } = building.transform;
    const halfW = building.building.width / 2;
    const halfH = building.building.height / 2;

    if (worldX >= x - halfW && worldX <= x + halfW &&
        worldY >= y - halfH && worldY <= y + halfH) {
      return building;
    }
  }

  return null;
}

// Find an attackable enemy target at a world position
// Returns enemy units first (smaller targets), then buildings
export function findAttackTargetAt(
  entitySource: AttackEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  const unit = findEnemyUnitAt(entitySource, worldX, worldY, playerId);
  if (unit) return unit;

  return findEnemyBuildingAt(entitySource, worldX, worldY, playerId);
}
