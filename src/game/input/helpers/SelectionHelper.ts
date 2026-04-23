// Selection helper functions for entity selection logic.
//
// Box-select hit testing is screen-space now (in SelectionController
// for 2D, Input3DManager for 3D), so this file only owns the
// click-to-select collider queries. No more world-axis-aligned rect
// tests here — camera rotation broke them, and projecting entities
// to screen pixels before the rect check is both simpler and
// matches the 3D renderer.

import type { EntityId, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';

export type { SelectionEntitySource } from '@/types/input';
import type { SelectionEntitySource } from '@/types/input';

// Find closest owned unit to a point (for single-click selection)
export function findClosestUnitToPoint(
  entitySource: SelectionEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): { id: EntityId; dist: number } | null {
  let closest: { id: EntityId; dist: number } | null = null;

  for (const entity of entitySource.getUnits()) {
    if (!entity.unit) continue;
    if (entity.ownership?.playerId !== playerId) continue;

    const dx = entity.transform.x - worldX;
    const dy = entity.transform.y - worldY;
    const dist = magnitude(dx, dy);

    // Must be within collision radius
    if (dist < entity.unit.unitRadiusCollider.scale) {
      if (!closest || dist < closest.dist) {
        closest = { id: entity.id, dist };
      }
    }
  }

  return closest;
}

// Find closest owned building to a point (for single-click selection)
export function findClosestBuildingToPoint(
  entitySource: SelectionEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): { id: EntityId; dist: number } | null {
  let closest: { id: EntityId; dist: number } | null = null;

  for (const entity of entitySource.getBuildings()) {
    if (!entity.building) continue;
    if (entity.ownership?.playerId !== playerId) continue;

    const { x, y } = entity.transform;
    const halfW = entity.building.width / 2;
    const halfH = entity.building.height / 2;

    // Check if point is inside building bounds
    if (worldX >= x - halfW && worldX <= x + halfW &&
        worldY >= y - halfH && worldY <= y + halfH) {
      const dx = x - worldX;
      const dy = y - worldY;
      const dist = magnitude(dx, dy);

      if (!closest || dist < closest.dist) {
        closest = { id: entity.id, dist };
      }
    }
  }

  return closest;
}

// (Drag-distance + world-rect helpers removed: box-select now runs in
// screen space inside SelectionController / Input3DManager.)
