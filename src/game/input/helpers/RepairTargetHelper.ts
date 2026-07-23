// Repair target detection helper

import type { Entity, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';
import { isBuildInProgress } from '../../sim/buildableHelpers';

export type { RepairEntitySource } from '@/types/input';
import type { RepairEntitySource } from '@/types/input';

/** True iff `entity` is an allied target a builder/commander can pour
 *  build power into: an in-progress (incomplete) building/tower shell —
 *  i.e. construction assist — or a damaged allied unit/building/tower. Mirrors the
 *  ground-point find helpers below, but tests a concrete resolved entity
 *  (the canonical path for a 3D body pick). */
export function isRepairableFriendlyTarget(
  entity: Entity | null | undefined,
  playerId: PlayerId,
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean,
): entity is Entity {
  if (!entity?.ownership) return false;
  const targetPlayerId = entity.ownership.playerId;
  if (
    targetPlayerId !== playerId &&
    (arePlayersAllied === undefined || !arePlayersAllied(playerId, targetPlayerId))
  ) return false;
  if (entity.building !== null && isBuildInProgress(entity.buildable)) return true;
  const hpState = entity.unit ?? entity.building;
  return hpState !== null && hpState.hp > 0 && hpState.hp < hpState.maxHp;
}

// Find an incomplete or completed-damaged building at a world position.
function findRepairableBuildingAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  for (const building of entitySource.getBuildings()) {
    if (!isRepairableFriendlyTarget(building, playerId, entitySource.arePlayersAllied)) continue;
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

// Find a damaged allied unit at a world position.
function findDamagedUnitAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId,
): Entity | null {
  for (const unit of entitySource.getUnits()) {
    if (!isRepairableFriendlyTarget(unit, playerId, entitySource.arePlayersAllied)) continue;
    if (!unit.unit) continue;

    const dx = unit.transform.x - worldX;
    const dy = unit.transform.y - worldY;
    const dist = magnitude(dx, dy);

    if (dist <= unit.unit.radius.hitbox) {
      return unit;
    }
  }

  return null;
}

// Find a repairable target at a world position
// Returns repairable buildings first, then damaged allied units.
export function findRepairTargetAt(
  entitySource: RepairEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): Entity | null {
  // Check buildings first (nanoframes and completed damaged structures).
  const building = findRepairableBuildingAt(entitySource, worldX, worldY, playerId);
  if (building) return building;

  // Check units (damaged allied units).
  return findDamagedUnitAt(entitySource, worldX, worldY, playerId);
}
