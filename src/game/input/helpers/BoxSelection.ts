// Shared screen-rect box-selection. Both the 2D (Pixi) and 3D
// (Three.js) input paths do the same thing: walk owned entities,
// project each world position to screen pixels, keep the ones that
// fall inside the drag rect, and prefer units over buildings. The
// only renderer-specific bit is the projection itself — abstracted
// here as a ProjectToScreen callback.

import type { EntityId, PlayerId } from '../../sim/types';
import type { SelectionEntitySource } from './SelectionHelper';

export type ScreenRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Project a world-space (x, z on the ground plane, == sim x / y) to
 *  screen-pixel coords. The `behind` flag lets 3D callers reject
 *  points behind the camera (NDC z >= 1 after project()) — the 2D
 *  path never sets it. */
export type ProjectToScreen = (
  worldX: number,
  worldY: number,
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

  const tryPush = (worldX: number, worldY: number, id: EntityId): void => {
    out.behind = false;
    project(worldX, worldY, out);
    if (out.behind) return;
    if (
      out.x >= rect.minX && out.x <= rect.maxX &&
      out.y >= rect.minY && out.y <= rect.maxY
    ) {
      ids.push(id);
    }
  };

  for (const u of source.getUnits()) {
    if (u.ownership?.playerId !== playerId) continue;
    tryPush(u.transform.x, u.transform.y, u.id);
  }
  if (ids.length > 0) return ids;

  for (const b of source.getBuildings()) {
    if (b.ownership?.playerId !== playerId) continue;
    tryPush(b.transform.x, b.transform.y, b.id);
  }
  return ids;
}
