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
// the ghost red and stop the client from firing commands it already
// knows will fail. The server remains authoritative for race cases.

import type { Entity, BuildingType } from '../../sim/types';
import type { MetalDeposit } from '../../../metalDepositConfig';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { GRID_CELL_SIZE, snapBuildingToGrid } from '../../sim/grid';
import {
  findDepositContainingPoint,
  getMetalDepositFootprintCoverage,
} from '../../sim/metalDeposits';
import { getTerrainPlateauLevelAt, isBuildableTerrainFootprint } from '../../sim/Terrain';

export type BuildPlacementCellReason =
  | 'ok'
  | 'metal'
  | 'empty'
  | 'outOfBounds'
  | 'occupied'
  | 'terrain';

export type BuildPlacementFailureReason = BuildPlacementCellReason | 'noMetal';

export type BuildPlacementCellDiagnostic = {
  gx: number;
  gy: number;
  x: number;
  y: number;
  reason: BuildPlacementCellReason;
  blocking: boolean;
  terrainLevel?: number;
  metalCovered?: boolean;
  depositId?: number;
};

export type BuildPlacementDiagnostics = {
  canPlace: boolean;
  cells: BuildPlacementCellDiagnostic[];
  failureReason?: BuildPlacementFailureReason;
  metalFraction?: number;
  metalCoveredCells?: number;
  metalTotalCells?: number;
};

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export function getOccupiedBuildingCells(buildings: Entity[]): ReadonlySet<string> {
  const occupied = new Set<string>();
  for (const b of buildings) {
    if (!b.building) continue;
    const existingConfig = b.buildingType ? getBuildingConfig(b.buildingType) : undefined;
    const bw = existingConfig ? existingConfig.gridWidth : Math.max(1, Math.ceil(b.building.width / GRID_CELL_SIZE));
    const bh = existingConfig ? existingConfig.gridHeight : Math.max(1, Math.ceil(b.building.height / GRID_CELL_SIZE));
    const left = Math.floor((b.transform.x - (bw * GRID_CELL_SIZE) / 2) / GRID_CELL_SIZE + 1e-6);
    const top = Math.floor((b.transform.y - (bh * GRID_CELL_SIZE) / 2) / GRID_CELL_SIZE + 1e-6);
    for (let dx = 0; dx < bw; dx++) {
      for (let dy = 0; dy < bh; dy++) {
        occupied.add(cellKey(left + dx, top + dy));
      }
    }
  }
  return occupied;
}

/** Returns true if a building of `candidateType` placed with its center
 *  at (centerX, centerY) would fit in the map and not overlap any
 *  existing building. `centerX/Y` should already be snapped (via
 *  getSnappedBuildPosition); passing raw mouse coords is fine but the
 *  result will be noisier at cell boundaries.
 *
 *  Extractors additionally require at least one footprint cell whose
 *  center overlaps a metal deposit. Pass the deposit list
 *  (deterministic per map) so this check matches the server-side
 *  validation in construction.startBuilding. */
export function canPlaceBuildingAt(
  candidateType: BuildingType,
  centerX: number,
  centerY: number,
  mapWidth: number,
  mapHeight: number,
  buildings: Entity[],
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
): boolean {
  return getBuildingPlacementDiagnostics(
    candidateType,
    centerX,
    centerY,
    mapWidth,
    mapHeight,
    buildings,
    metalDeposits,
  ).canPlace;
}

export function getBuildingPlacementDiagnostics(
  candidateType: BuildingType,
  centerX: number,
  centerY: number,
  mapWidth: number,
  mapHeight: number,
  buildings: Entity[],
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
  occupiedCells: ReadonlySet<string> = getOccupiedBuildingCells(buildings),
): BuildPlacementDiagnostics {
  const config = getBuildingConfig(candidateType);
  const snapped = snapBuildingToGrid(centerX, centerY, config.gridWidth, config.gridHeight);
  const halfWidth = (config.gridWidth * GRID_CELL_SIZE) / 2;
  const halfHeight = (config.gridHeight * GRID_CELL_SIZE) / 2;
  const mapCellsX = Math.ceil(mapWidth / GRID_CELL_SIZE);
  const mapCellsY = Math.ceil(mapHeight / GRID_CELL_SIZE);
  const cells: BuildPlacementCellDiagnostic[] = [];
  let hasBlockingCell = false;
  let failureReason: BuildPlacementFailureReason | undefined;
  let missingRequiredMetal = false;
  let metalCoveredCells = 0;
  const terrainLevelCounts = new Map<number, number>();

  for (let dy = 0; dy < config.gridHeight; dy++) {
    for (let dx = 0; dx < config.gridWidth; dx++) {
      const gx = snapped.gridX + dx;
      const gy = snapped.gridY + dy;
      const x = gx * GRID_CELL_SIZE + GRID_CELL_SIZE / 2;
      const y = gy * GRID_CELL_SIZE + GRID_CELL_SIZE / 2;
      let reason: BuildPlacementCellReason = 'ok';
      let blocking = false;
      let metalCovered = false;
      let depositId: number | undefined;
      let terrainLevel: number | undefined;

      if (gx < 0 || gy < 0 || gx >= mapCellsX || gy >= mapCellsY) {
        reason = 'outOfBounds';
        blocking = true;
      } else if (occupiedCells.has(cellKey(gx, gy))) {
        reason = 'occupied';
        blocking = true;
      } else if (!isBuildableTerrainFootprint(
        x,
        y,
        GRID_CELL_SIZE / 2,
        GRID_CELL_SIZE / 2,
        mapWidth,
        mapHeight,
      )) {
        reason = 'terrain';
        blocking = true;
      } else {
        terrainLevel = getTerrainPlateauLevelAt(x, y, mapWidth, mapHeight) ?? undefined;
        if (terrainLevel !== undefined) {
          terrainLevelCounts.set(terrainLevel, (terrainLevelCounts.get(terrainLevel) ?? 0) + 1);
        }
      }

      if (!blocking && candidateType === 'extractor') {
        const deposit = findDepositContainingPoint(metalDeposits, x, y);
        metalCovered = deposit !== null;
        depositId = deposit?.id;
        if (metalCovered) {
          reason = 'metal';
          metalCoveredCells++;
        } else {
          reason = 'empty';
        }
      }

      if (blocking) {
        hasBlockingCell = true;
        failureReason ??= reason;
      }
      cells.push({ gx, gy, x, y, reason, blocking, terrainLevel, metalCovered, depositId });
    }
  }

  let expectedTerrainLevel: number | undefined;
  let expectedTerrainCount = -1;
  for (const [level, count] of terrainLevelCounts) {
    if (count > expectedTerrainCount) {
      expectedTerrainLevel = level;
      expectedTerrainCount = count;
    }
  }

  if (expectedTerrainLevel !== undefined) {
    for (const cell of cells) {
      if (!cell.blocking && cell.terrainLevel !== expectedTerrainLevel) {
        cell.reason = 'terrain';
        cell.blocking = true;
        hasBlockingCell = true;
        failureReason ??= 'terrain';
      }
    }
  }

  let metalFraction: number | undefined;
  let metalTotalCells: number | undefined;
  if (candidateType === 'extractor') {
    const coverage = getMetalDepositFootprintCoverage(
      metalDeposits,
      snapped.x,
      snapped.y,
      halfWidth,
      halfHeight,
      GRID_CELL_SIZE,
    );
    metalFraction = coverage.fraction;
    metalCoveredCells = coverage.coveredCells;
    metalTotalCells = coverage.totalCells;
    if (coverage.coveredCells <= 0) {
      missingRequiredMetal = true;
      failureReason ??= 'noMetal';
    }
  }

  return {
    canPlace: !hasBlockingCell && !missingRequiredMetal,
    cells,
    failureReason,
    metalFraction,
    metalCoveredCells,
    metalTotalCells,
  };
}

/** Snap a world-space cursor position to the canonical center of a
 *  building footprint of the given type. Building cells are aligned to
 *  the GRID_CELL_SIZE lattice; the building's center sits at the
 *  midpoint of its (gridWidth × gridHeight) footprint using the same
 *  top-left-cell convention as the authoritative BuildingGrid. */
export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingType: BuildingType,
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingType);
  return snapBuildingToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
}
