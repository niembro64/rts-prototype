// Reclaim target detection helper.

import type { Entity } from '../../sim/types';
import { magnitude } from '../../math';
import { isReclaimableTarget } from '../../sim/reclaim';

export type { ReclaimEntitySource } from '@/types/input';
import type { ReclaimEntitySource } from '@/types/input';

function findReclaimableUnitAt(
  entitySource: ReclaimEntitySource,
  worldX: number,
  worldY: number,
): Entity | null {
  let closest: Entity | null = null;
  let closestDist = Infinity;

  for (const unit of entitySource.getUnits()) {
    if (!isReclaimableTarget(unit) || !unit.unit) continue;
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

function findReclaimableBuildingAt(
  entitySource: ReclaimEntitySource,
  worldX: number,
  worldY: number,
): Entity | null {
  let closest: Entity | null = null;
  let closestDist = Infinity;

  for (const building of entitySource.getBuildings()) {
    if (!isReclaimableTarget(building) || !building.building) continue;
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

export function findReclaimTargetAt(
  entitySource: ReclaimEntitySource,
  worldX: number,
  worldY: number,
): Entity | null {
  const unit = findReclaimableUnitAt(entitySource, worldX, worldY);
  if (unit) return unit;
  return findReclaimableBuildingAt(entitySource, worldX, worldY);
}
