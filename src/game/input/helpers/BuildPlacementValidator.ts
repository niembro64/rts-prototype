// Client-side mirror of BuildingGrid.canPlace for the build ghost.
//
// The sim's construction system is server-authoritative and lives in
// the headless GameServer, so the client can't ask it directly. But
// the rules are simple enough that we can re-check them from entity
// state: the candidate footprint must be fully in-bounds and must not
// overlap an existing building's footprint. We use the entity's stored
// `building.width/height` (which construction.ts populates from the
// building config's gridWidth * GRID_CELL_SIZE) so this stays correct
// if building sizes change.
//
// This is a *preview* check, not authoritative — the server runs the
// real BuildingGrid.canPlace when the build command arrives. A race
// where two players build on overlapping cells in the same tick will
// still be resolved server-side. The point of this check is to color
// the ghost red so the user doesn't fire a command they know will
// fail, not to gate the command itself.

import type { Entity, BuildingType } from '../../sim/types';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../../sim/grid';

/** Returns true if a building of `candidateType` placed with its center
 *  at (centerX, centerY) would fit in the map and not overlap any
 *  existing building. `centerX/Y` should already be snapped (via
 *  getSnappedBuildPosition); passing raw mouse coords is fine but the
 *  result will be noisier at cell boundaries. */
export function canPlaceBuildingAt(
  candidateType: BuildingType,
  centerX: number,
  centerY: number,
  mapWidth: number,
  mapHeight: number,
  buildings: Entity[],
): boolean {
  const config = getBuildingConfig(candidateType);
  const w = config.gridWidth * GRID_CELL_SIZE;
  const h = config.gridHeight * GRID_CELL_SIZE;
  const candLeft = centerX - w / 2;
  const candTop = centerY - h / 2;
  const candRight = candLeft + w;
  const candBottom = candTop + h;

  if (
    candLeft < 0 || candTop < 0 ||
    candRight > mapWidth || candBottom > mapHeight
  ) {
    return false;
  }

  for (const b of buildings) {
    if (!b.building) continue;
    const bw = b.building.width;
    const bh = b.building.height;
    const bLeft = b.transform.x - bw / 2;
    const bTop = b.transform.y - bh / 2;
    const bRight = bLeft + bw;
    const bBottom = bTop + bh;
    // AABB overlap test — allow touching edges (strict <= comparisons
    // would reject a building placed flush against another's edge).
    if (candRight <= bLeft || candLeft >= bRight) continue;
    if (candBottom <= bTop || candTop >= bBottom) continue;
    return false;
  }

  return true;
}
