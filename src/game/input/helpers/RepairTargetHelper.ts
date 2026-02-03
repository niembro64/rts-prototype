// Repair target detection helper

import type { Entity, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';

// Entity source interface for queries
export interface RepairEntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
}

// Find an incomplete building at a world position
export function findIncompleteBuildingAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  for (const building of entitySource.getBuildings()) {
    if (building.ownership?.playerId !== playerId) continue;
    if (!building.buildable || building.buildable.isComplete || building.buildable.isGhost) continue;
    if (!building.building) continue;

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

// Find a damaged friendly unit at a world position
export function findDamagedUnitAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  for (const unit of entitySource.getUnits()) {
    if (unit.ownership?.playerId !== playerId) continue;
    if (!unit.unit || unit.unit.hp >= unit.unit.maxHp || unit.unit.hp <= 0) continue;

    const dx = unit.transform.x - worldX;
    const dy = unit.transform.y - worldY;
    const dist = magnitude(dx, dy);

    if (dist <= unit.unit.collisionRadius) {
      return unit;
    }
  }

  return null;
}

// Find a repairable target at a world position
// Returns incomplete buildings first, then damaged friendly units
export function findRepairTargetAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  // Check buildings first (incomplete ones)
  const building = findIncompleteBuildingAt(entitySource, worldX, worldY, playerId);
  if (building) return building;

  // Check units (damaged friendly units)
  return findDamagedUnitAt(entitySource, worldX, worldY, playerId);
}
