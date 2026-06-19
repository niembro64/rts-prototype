import type { MetalDeposit } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { Entity, BuildingBlueprintId } from './types';
import { getBuildingConfig } from './buildConfigs';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  BUILD_GRID_CELL_SIZE,
  getBuildingCenterFromGrid,
  getRotatedGridFootprint,
  snapBuildingToGrid,
} from './buildGrid';
import {
  findDepositContainingPoint,
  getMetalDepositGridCells,
  getMetalDepositFootprintCoverage,
} from './metalDeposits';
import { evaluateBuildabilityFootprint, getTerrainBuildabilityGridCell } from './Terrain';

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
  terrainLevel: number | null;
  metalCovered: boolean;
  depositId: number | null;
};

export type BuildPlacementDiagnostics = {
  canPlace: boolean;
  gridX: number;
  gridY: number;
  x: number;
  y: number;
  cells: BuildPlacementCellDiagnostic[];
  failureReason: BuildPlacementFailureReason | null;
  metalFraction: number | null;
  metalCoveredCells: number | null;
  metalTotalCells: number | null;
  metalDepositCells: BuildPlacementCellDiagnostic[] | null;
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
    const existingConfig = b.buildingBlueprintId ? getBuildingConfig(b.buildingBlueprintId) : undefined;
    const footprint = existingConfig
      ? getRotatedGridFootprint(existingConfig.placementGridWidth, existingConfig.placementGridHeight, b.transform.rotation)
      : getRotatedGridFootprint(
        Math.max(1, Math.ceil(b.building.width / BUILD_GRID_CELL_SIZE)),
        Math.max(1, Math.ceil(b.building.height / BUILD_GRID_CELL_SIZE)),
        0,
      );
    const bw = footprint.gridWidth;
    const bh = footprint.gridHeight;
    const left = Math.floor((b.transform.x - (bw * BUILD_GRID_CELL_SIZE) / 2) / BUILD_GRID_CELL_SIZE + 1e-6);
    const top = Math.floor((b.transform.y - (bh * BUILD_GRID_CELL_SIZE) / 2) / BUILD_GRID_CELL_SIZE + 1e-6);
    for (let dx = 0; dx < bw; dx++) {
      for (let dy = 0; dy < bh; dy++) {
        occupied.add(cellKey(left + dx, top + dy));
      }
    }
  }
  return occupied;
}

function getBuildingPlacementDiagnosticsAtGrid(
  candidateType: BuildingBlueprintId,
  gridX: number,
  gridY: number,
  mapWidth: number,
  mapHeight: number,
  metalDeposits: ReadonlyArray<MetalDeposit>,
  isCellOccupied: BuildPlacementOccupiedLookup,
  terrainBuildabilityGrid: TerrainBuildabilityGrid | null,
  rotation = 0,
): BuildPlacementDiagnostics {
  const config = getBuildingConfig(candidateType);
  // Validate and reserve the full placement footprint. It shares its
  // center with the physical rect (parity is loader-enforced), so the
  // candidate center below is also the building center.
  const footprint = getRotatedGridFootprint(config.placementGridWidth, config.placementGridHeight, rotation);
  const center = getBuildingCenterFromGrid(gridX, gridY, footprint.gridWidth, footprint.gridHeight);
  const halfWidth = (footprint.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
  const halfHeight = (footprint.gridHeight * BUILD_GRID_CELL_SIZE) / 2;
  const mapCellsX = Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE);
  const mapCellsY = Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE);
  const cells: BuildPlacementCellDiagnostic[] = [];
  let hasBlockingCell = false;
  let failureReason: BuildPlacementFailureReason | null = null;
  let metalCoveredCells = 0;
  const terrainLevelCounts = new Map<number, number>();

  // Walk the whole-footprint perimeter once. Per-cell loop below also
  // walks each cell's perimeter ONCE and reads BOTH the buildable
  // boolean AND the plateau level off a single helper (the previous
  // code did separate isBuildableTerrainFootprint + getTerrainPlateauLevelAt
  // calls per cell, which re-sampled the same mesh points twice).
  const useAuthoritativeBuildability =
    terrainBuildabilityGrid !== null &&
    terrainBuildabilityGrid.cellSize === BUILD_GRID_CELL_SIZE &&
    terrainBuildabilityGrid.mapWidth === mapWidth &&
    terrainBuildabilityGrid.mapHeight === mapHeight;
  const footprintTerrainOk = useAuthoritativeBuildability
    ? true
    : evaluateBuildabilityFootprint(
      center.x,
      center.y,
      halfWidth,
      halfHeight,
      mapWidth,
      mapHeight,
    ).buildable;

  for (let dy = 0; dy < footprint.gridHeight; dy++) {
    for (let dx = 0; dx < footprint.gridWidth; dx++) {
      const gx = gridX + dx;
      const gy = gridY + dy;
      const x = gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2;
      const y = gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2;
      let reason: BuildPlacementCellReason = 'ok';
      let blocking = false;
      let metalCovered = false;
      let depositId: number | null = null;
      let terrainLevel: number | null = null;

      if (gx < 0 || gy < 0 || gx >= mapCellsX || gy >= mapCellsY) {
        reason = 'outOfBounds';
        blocking = true;
      } else if (isCellOccupied(gx, gy)) {
        reason = 'occupied';
        blocking = true;
      } else {
        const cellEval = useAuthoritativeBuildability
          ? getTerrainBuildabilityGridCell(terrainBuildabilityGrid, gx, gy)
          : evaluateBuildabilityFootprint(
            x,
            y,
            BUILD_GRID_CELL_SIZE / 2,
            BUILD_GRID_CELL_SIZE / 2,
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

      if (!blocking) {
        const deposit = findDepositContainingPoint(metalDeposits, x, y);
        metalCovered = deposit !== null;
        depositId = deposit === null ? null : deposit.id;
        if (isMetalExtractorBlueprintId(candidateType)) {
          if (metalCovered) {
            reason = 'metal';
            metalCoveredCells++;
          } else {
            reason = 'empty';
          }
        }
      }

      if (blocking) {
        hasBlockingCell = true;
        failureReason ??= reason;
      }
      cells.push({ gx, gy, x, y, reason, blocking, terrainLevel, metalCovered, depositId });
    }
  }

  let expectedTerrainLevel: number | null = null;
  let expectedTerrainCount = -1;
  for (const [level, count] of terrainLevelCounts) {
    if (count > expectedTerrainCount) {
      expectedTerrainLevel = level;
      expectedTerrainCount = count;
    }
  }

  if (expectedTerrainLevel !== null) {
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

  // Diagnostic-only field for callers that want to know which deposit
  // cells are still uncovered by this candidate footprint. The build
  // ghost no longer reads it (deposit markers come from a persistent
  // overlay built once from the deposit list); kept here so the rest of
  // the diagnostic surface remains intact for any other consumer.
  const footprintCellKeys = new Set<string>();
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    footprintCellKeys.add(cellKey(cell.gx, cell.gy));
  }
  const metalDepositCells: BuildPlacementCellDiagnostic[] = [];
  const depositCells = getMetalDepositGridCells(metalDeposits);
  for (let i = 0; i < depositCells.length; i++) {
    const cell = depositCells[i];
    if (footprintCellKeys.has(cellKey(cell.gx, cell.gy))) continue;
    metalDepositCells.push({
      gx: cell.gx,
      gy: cell.gy,
      x: cell.x,
      y: cell.y,
      reason: 'metal',
      blocking: false,
      terrainLevel: null,
      metalCovered: true,
      depositId: cell.depositId,
    });
  }
  let metalFraction: number | null = null;
  let metalTotalCells: number | null = null;
  if (isMetalExtractorBlueprintId(candidateType)) {
    const coverage = getMetalDepositFootprintCoverage(
      metalDeposits,
      center.x,
      center.y,
      halfWidth,
      halfHeight,
      BUILD_GRID_CELL_SIZE,
    );
    metalFraction = coverage.fraction;
    metalCoveredCells = coverage.coveredCells;
    metalTotalCells = coverage.totalCells;
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
    metalCoveredCells: isMetalExtractorBlueprintId(candidateType) ? metalCoveredCells : null,
    metalTotalCells,
    metalDepositCells,
  };
}

export function getBuildingPlacementDiagnosticsForGrid(
  candidateType: BuildingBlueprintId,
  gridX: number,
  gridY: number,
  mapWidth: number,
  mapHeight: number,
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
  isCellOccupied: BuildPlacementOccupiedLookup = emptyOccupiedLookup,
  terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null,
  rotation = 0,
): BuildPlacementDiagnostics {
  return getBuildingPlacementDiagnosticsAtGrid(
    candidateType,
    gridX,
    gridY,
    mapWidth,
    mapHeight,
    metalDeposits,
    isCellOccupied,
    terrainBuildabilityGrid,
    rotation,
  );
}

export function getBuildingPlacementDiagnostics(
  candidateType: BuildingBlueprintId,
  centerX: number,
  centerY: number,
  mapWidth: number,
  mapHeight: number,
  buildings: Entity[],
  metalDeposits: ReadonlyArray<MetalDeposit> = [],
  occupiedCells: ReadonlySet<string> = getOccupiedBuildingCells(buildings),
  terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null,
  rotation = 0,
): BuildPlacementDiagnostics {
  const config = getBuildingConfig(candidateType);
  const footprint = getRotatedGridFootprint(config.placementGridWidth, config.placementGridHeight, rotation);
  const snapped = snapBuildingToGrid(centerX, centerY, footprint.gridWidth, footprint.gridHeight);
  return getBuildingPlacementDiagnosticsAtGrid(
    candidateType,
    snapped.gridX,
    snapped.gridY,
    mapWidth,
    mapHeight,
    metalDeposits,
    occupiedSetLookup(occupiedCells),
    terrainBuildabilityGrid,
    rotation,
  );
}


export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingBlueprintId: BuildingBlueprintId,
  rotation = 0,
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingBlueprintId);
  const footprint = getRotatedGridFootprint(config.placementGridWidth, config.placementGridHeight, rotation);
  return snapBuildingToGrid(worldX, worldY, footprint.gridWidth, footprint.gridHeight);
}
