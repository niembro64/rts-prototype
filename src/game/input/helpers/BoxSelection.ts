// Shared screen-rect box-selection. Both the 2D (Pixi) and 3D
// (Three.js) input paths do the same thing: walk owned entities,
// project each world position to screen pixels, keep the ones that
// fall inside the drag rect, and prefer units over buildings. The
// only renderer-specific bit is the projection itself — abstracted
// here as a ProjectToScreen callback.

import type { Entity, EntityId, PlayerId } from '../../sim/types';
import type { SelectionEntitySource } from './SelectionHelper';

export type ScreenRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Project an entity's visual center to screen-pixel coords. Callers
 *  receive the full entity so the 3D path can pick an appropriate
 *  vertical height per entity kind (commanders are taller than
 *  regular units, buildings sit flat on the ground) instead of a
 *  single magic constant that's wrong for most of them.
 *
 *  The `behind` flag lets 3D callers reject points behind the
 *  camera (NDC z >= 1 after project()) — the 2D path never sets it.
 */
export type ProjectToScreen = (
  entity: Entity,
  out: { x: number; y: number; behind: boolean },
) => void;

/** Find owned entities whose screen-projected position falls inside
 *  the rect. Units take precedence: if any units hit, buildings
 *  aren't considered at all. This matches how the old world-rect
 *  performSelection worked, so drag semantics are unchanged. */
export function selectEntitiesInScreenRect(
  source: SelectionEntitySource,
  rect: ScreenRect,
  playerId: PlayerId,
  project: ProjectToScreen,
): EntityId[] {
  const ids: EntityId[] = [];
  // Reuse one out object to avoid per-entity allocations on a hot path.
  const out = { x: 0, y: 0, behind: false };

  const tryPush = (entity: Entity): void => {
    out.behind = false;
    project(entity, out);
    if (out.behind) return;
    if (
      out.x >= rect.minX && out.x <= rect.maxX &&
      out.y >= rect.minY && out.y <= rect.maxY
    ) {
      ids.push(entity.id);
    }
  };

  for (const u of source.getUnits()) {
    if (u.ownership?.playerId !== playerId) continue;
    tryPush(u);
  }
  if (ids.length > 0) return ids;

  for (const b of source.getBuildings()) {
    if (b.ownership?.playerId !== playerId) continue;
    tryPush(b);
  }
  return ids;
}
