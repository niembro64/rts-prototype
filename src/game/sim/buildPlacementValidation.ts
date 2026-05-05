import type { MetalDeposit } from '../../metalDepositConfig';
import type { Entity, BuildingType } from './types';
import { getBuildingConfig } from './buildConfigs';
import { GRID_CELL_SIZE, getBuildingCenterFromGrid, snapBuildingToGrid } from './grid';
import {
  findDepositContainingPoint,
  getMetalDepositGridCells,
  getMetalDepositFootprintCoverage,
} from './metalDeposits';
import { evaluateBuildabilityFootprint } from './Terrain';

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
  gridX: number;
  gridY: number;
  x: number;
  y: number;
  cells: BuildPlacementCellDiagnostic[];
  failureReason?: BuildPlacementFailureReason;
  metalFraction?: number;
  metalCoveredCells?: number;
  metalTotalCells?: number;
  metalDepositCells?: BuildPlacementCellDiagnostic[];
};

export type BuildPlacementOccupiedLookup = (gx: number, gy: number) => boolean;

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function emptyOccupiedLookup(): boolean {
  return false;
}

function occupiedSetLookup(cells: ReadonlySet<string>): BuildPlacementOccupiedLookup {
  return (gx, gy) => cells.has(cellKey(gx, gy));
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

function getBuildingPlacementDiagnosticsAtGrid(
  candidateType: BuildingType,
  gridX: number,
  gridY: number,
  mapWidth: number,
  mapHeight: number,
  metalDeposits: ReadonlyArray<MetalDeposit>,
  isCellOccupied: BuildPlacementOccupiedLookup,
): BuildPlacementDiagnostics {
  const config = getBuildingConfig(candidateType);
  const center = getBuildingCenterFromGrid(gridX, gridY, config.gridWidth, config.gridHeight);
  const halfWidth = (config.gridWidth * GRID_CELL_SIZE) / 2;
  const halfHeight = (config.gridHeight * GRID_CELL_SIZE) / 2;
  const mapCellsX = Math.ceil(mapWidth / GRID_CELL_SIZE);
  const mapCellsY = Math.ceil(mapHeight / GRID_CELL_SIZE);
  const cells: BuildPlacementCellDiagnostic[] = [];
  let hasBlockingCell = false;
  let failureReason: BuildPlacementFailureReason | undefined;
  let metalCoveredCells = 0;
  const terrainLevelCounts = new Map<number, number>();

  // Walk the whole-footprint perimeter once. Per-cell loop below also
  // walks each cell's perimeter ONCE and reads BOTH the buildable
  // boolean AND the plateau level off a single helper (the previous
  // code did separate isBuildableTerrainFootprint + getTerrainPlateauLevelAt
  // calls per cell, which re-sampled the same mesh points twice).
  const footprintTerrainOk = evaluateBuildabilityFootprint(
    center.x,
    center.y,
    halfWidth,
    halfHeight,
    mapWidth,
    mapHeight,
  ).buildable;

  for (let dy = 0; dy < config.gridHeight; dy++) {
    for (let dx = 0; dx < config.gridWidth; dx++) {
      const gx = gridX + dx;
      const gy = gridY + dy;
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
      } else if (isCellOccupied(gx, gy)) {
        reason = 'occupied';
        blocking = true;
      } else {
        const cellEval = evaluateBuildabilityFootprint(
          x,
          y,
          GRID_CELL_SIZE / 2,
          GRID_CELL_SIZE / 2,
          mapWidth,
          mapHeight,
        );
        if (!cellEval.buildable) {
          reason = 'terrain';
          blocking = true;
        } else if (cellEval.level !== null) {
          terrainLevel = cellEval.level;
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

  if (!footprintTerrainOk) {
    for (const cell of cells) {
      if (cell.blocking) continue;
      cell.reason = 'terrain';
      cell.blocking = true;
      hasBlockingCell = true;
    }
    failureReason ??= 'terrain';
  }

  let metalFraction: number | undefined;
  let metalTotalCells: number | undefined;
  let metalDepositCells: BuildPlacementCellDiagnostic[] | undefined;
  if (candidateType === 'extractor') {
    const coverage = getMetalDepositFootprintCoverage(
      metalDeposits,
      center.x,
      center.y,
      halfWidth,
      halfHeight,
      GRID_CELL_SIZE,
    );
    metalFraction = coverage.fraction;
    metalCoveredCells = coverage.coveredCells;
    metalTotalCells = coverage.totalCells;
    metalDepositCells = getMetalDepositGridCells(metalDeposits).map((cell) => ({
      gx: cell.gx,
      gy: cell.gy,
      x: cell.x,
      y: cell.y,
      reason: 'metal',
      blocking: false,
      metalCovered: true,
      depositId: cell.depositId,
    }));
  }

  return {
    canPlace: !hasBlockingCell,
    gridX,
    gridY,
    x: center.x,
    y: center.y,
    cells,
    failureReason,
    metalFraction,
    metalCoveredCells,
    metalTotalCells,
    metalDepositCells,
  };
}

export function getBuildingPlacementDiagnosticsForGrid(
  candidateType: BuildingType,
  gridX: number,
  gridY: number,
  mapWidth: number,
  mapHeight: number,
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
  isCellOccupied: BuildPlacementOccupiedLookup = emptyOccupiedLookup,
): BuildPlacementDiagnostics {
  return getBuildingPlacementDiagnosticsAtGrid(
    candidateType,
    gridX,
    gridY,
    mapWidth,
    mapHeight,
    metalDeposits,
    isCellOccupied,
  );
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
  return getBuildingPlacementDiagnosticsAtGrid(
    candidateType,
    snapped.gridX,
    snapped.gridY,
    mapWidth,
    mapHeight,
    metalDeposits,
    occupiedSetLookup(occupiedCells),
  );
}

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

export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingType: BuildingType,
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingType);
  return snapBuildingToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
}
