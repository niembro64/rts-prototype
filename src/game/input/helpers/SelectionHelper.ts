// Selection helper functions for entity selection logic.
//
// Box-select hit testing is screen-space now (in SelectionController
// for 2D, Input3DManager for 3D), so this file only owns the
// click-to-select collider queries. No more world-axis-aligned rect
// tests here — camera rotation broke them, and projecting entities
// to screen pixels before the rect check is both simpler and
// matches the 3D renderer.

import type { EntityId, PlayerId } from '../../sim/types';

export type { SelectionEntitySource } from '@/types/input';
import type { SelectionEntitySource } from '@/types/input';

type ClosestEntityOptions = {
  /** Optional owner filter. Omit for hover affordances that should
   *  recognize any live unit/building under the cursor. */
  playerId?: PlayerId;
  /** Small floor for very small units. The actual selectable footprint
   *  is the unit's collision radius (scaled by SEL_SCALE_MOBILE) so
   *  click-selection matches spacing and collision expectations, not
   *  cosmetic body art. */
  minUnitRadius?: number;
};

// BAR/Spring style: the click/hover hit volume is the collision volume
// enlarged slightly so units are forgiving to grab without bleeding into
// neighbors. Spring's unitdefs_post.lua uses these same factors when it
// derives a default selectionVolume from the collision volume:
//   mobile units 1.22x, static (buildings/towers) 1.15x.
// Drag-box select is unaffected — that's center-point only, matching
// Spring's GetUnitsInScreenRectangle.
const SEL_SCALE_MOBILE = 1.22;
const SEL_SCALE_STATIC = 1.15;

function canUseUnit(entity: ReturnType<SelectionEntitySource['getUnits']>[number], playerId?: PlayerId): boolean {
  if (!entity.unit) return false;
  if (entity.unit.hp <= 0) return false;
  if (playerId !== undefined && entity.ownership?.playerId !== playerId) return false;
  return true;
}

function canUseBuilding(entity: ReturnType<SelectionEntitySource['getBuildings']>[number], playerId?: PlayerId): boolean {
  if (!entity.building) return false;
  if (entity.building.hp <= 0) return false;
  if (playerId !== undefined && entity.ownership?.playerId !== playerId) return false;
  return true;
}

export function findClosestSelectableEntityToPoint(
  entitySource: SelectionEntitySource,
  worldX: number,
  worldY: number,
  options: ClosestEntityOptions = {},
): { id: EntityId; dist: number } | null {
  let closest: { id: EntityId; distSq: number } | null = null;
  const { playerId, minUnitRadius = 0 } = options;

  for (const entity of entitySource.getUnits()) {
    if (!canUseUnit(entity, playerId)) continue;
    const dx = entity.transform.x - worldX;
    const dy = entity.transform.y - worldY;
    const radius = Math.max(minUnitRadius, entity.unit!.radius.collision * SEL_SCALE_MOBILE);
    const distSq = dx * dx + dy * dy;
    if (distSq <= radius * radius && (!closest || distSq < closest.distSq)) {
      closest = { id: entity.id, distSq };
    }
  }

  for (const entity of entitySource.getBuildings()) {
    if (!canUseBuilding(entity, playerId)) continue;
    const dx = Math.abs(worldX - entity.transform.x);
    const dy = Math.abs(worldY - entity.transform.y);
    const halfW = (entity.building!.width / 2) * SEL_SCALE_STATIC;
    const halfH = (entity.building!.height / 2) * SEL_SCALE_STATIC;
    if (dx > halfW || dy > halfH) continue;
    const distSq = dx * dx + dy * dy;
    if (!closest || distSq < closest.distSq) {
      closest = { id: entity.id, distSq };
    }
  }

  return closest ? { id: closest.id, dist: Math.sqrt(closest.distSq) } : null;
}

// (Drag-distance + world-rect helpers removed: box-select now runs in
// screen space inside SelectionController / Input3DManager.)
