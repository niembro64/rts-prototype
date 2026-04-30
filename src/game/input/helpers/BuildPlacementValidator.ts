// Client-side mirror of BuildingGrid.canPlace for the build ghost.
//
// The sim's construction system is server-authoritative and lives in
// the headless GameServer, so the client can't ask it directly. But
// the rules are simple enough that we can re-check them from entity
// state: the candidate footprint must be fully in-bounds and must not
// overlap an existing building footprint. Existing dimensions are
// derived from the building config when possible so the preview mirrors
// server-side placement.
//
// This is a *preview* check, not authoritative — the server runs the
// real BuildingGrid.canPlace when the build command arrives. A race
// where two players build on overlapping cells in the same tick will
// still be resolved server-side. The point of this check is to color
// the ghost red so the user doesn't fire a command they know will
// fail, not to gate the command itself.

import type { Entity, BuildingType } from '../../sim/types';
import type { MetalDeposit } from '../../../metalDepositConfig';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../../sim/grid';
import { isWaterAt } from '../../sim/Terrain';

/** Returns true if a building of `candidateType` placed with its center
 *  at (centerX, centerY) would fit in the map and not overlap any
 *  existing building. `centerX/Y` should already be snapped (via
 *  getSnappedBuildPosition); passing raw mouse coords is fine but the
 *  result will be noisier at cell boundaries.
 *
 *  Extractors additionally require a metal deposit at the candidate
 *  position that isn't already occupied by another extractor. Pass
 *  the deposit list (deterministic per map) so this check matches the
 *  server-side validation in construction.startBuilding. */
export function canPlaceBuildingAt(
  candidateType: BuildingType,
  centerX: number,
  centerY: number,
  mapWidth: number,
  mapHeight: number,
  buildings: Entity[],
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
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

  // Buildings can't sit on water — sample the four corners and the
  // center; if any is over water, the cell is impassable.
  const samples: [number, number][] = [
    [candLeft + 1, candTop + 1],
    [candRight - 1, candTop + 1],
    [candLeft + 1, candBottom - 1],
    [candRight - 1, candBottom - 1],
    [centerX, centerY],
  ];
  for (const [sx, sy] of samples) {
    if (isWaterAt(sx, sy, mapWidth, mapHeight)) return false;
  }

  for (const b of buildings) {
    if (!b.building) continue;
    const existingConfig = b.buildingType ? getBuildingConfig(b.buildingType) : undefined;
    const bw = existingConfig ? existingConfig.gridWidth * GRID_CELL_SIZE : b.building.width;
    const bh = existingConfig ? existingConfig.gridHeight * GRID_CELL_SIZE : b.building.height;
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

  // Extractor-specific: must sit on an unclaimed deposit. Server runs
  // the same check in construction.startBuilding, so this stays an
  // accurate preview gate.
  if (candidateType === 'extractor') {
    let depositId = -1;
    for (const d of metalDeposits) {
      const dx = centerX - d.x;
      const dy = centerY - d.y;
      if (dx * dx + dy * dy <= d.flatRadius * d.flatRadius) {
        depositId = d.id;
        break;
      }
    }
    if (depositId < 0) return false;
    for (const b of buildings) {
      if (b.buildingType === 'extractor' && b.metalDepositId === depositId) return false;
    }
  }

  return true;
}

/** Snap a world-space cursor position to the canonical center of a
 *  building footprint of the given type. Building cells are aligned to
 *  the GRID_CELL_SIZE lattice; the building's center sits at the
 *  midpoint of its (gridWidth × gridHeight) footprint anchored at the
 *  cell containing the cursor. */
export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingType: BuildingType,
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingType);
  const gridX = Math.floor(worldX / GRID_CELL_SIZE);
  const gridY = Math.floor(worldY / GRID_CELL_SIZE);
  const x = gridX * GRID_CELL_SIZE + (config.gridWidth * GRID_CELL_SIZE) / 2;
  const y = gridY * GRID_CELL_SIZE + (config.gridHeight * GRID_CELL_SIZE) / 2;
  return { x, y, gridX, gridY };
}
