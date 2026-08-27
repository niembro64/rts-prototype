import type { MetalDeposit } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  DEFAULT_METAL_COVERAGE,
  metalCoverageIsWholeMap,
  type MetalCoverage,
} from '../../types/worldSurfaceMode';
import type { Entity, BuildingBlueprintId } from './types';
import type { BuildingPlacementSet } from '../../types/buildingTypes';
import {
  getBuildingPlacementAnchor,
  getBuildingPlacementSetSquareType,
} from '../../types/buildingTypes';
import { getBuildingConfig } from './buildConfigs';
import { getBuildingBlueprint } from './blueprints/buildings';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  BUILD_GRID_CELL_SIZE,
  getBuildingCenterFromGrid,
  getRotatedBuildingPlacementFootprint,
  snapBuildingToGrid,
} from './buildGrid';
import {
  findDepositContainingPoint,
  getMetalDepositGridCells,
} from './metalDeposits';
import type { BuildingPlacementFootprint } from './types';
import {
  evaluateBuildabilityFootprint,
  getBuildSquareTerrainHeightRange,
  getTerrainBedHeight,
  getTerrainBuildabilityGridCell,
  getSurfaceHeight,
  WATER_LEVEL,
} from './Terrain';
import {
  getBuildingPlacementBaseZ,
  getSeaOnSurfaceSubmergedDepth,
  getBuildingRequiredSensorSourceMedium,
} from './buildingPlacementPolicy';

type BuildPlacementCellReason =
  | 'ok'
  | 'metal'
  | 'empty'
  | 'outOfBounds'
  | 'occupied'
  | 'terrain';

type BuildPlacementFailureReason = BuildPlacementCellReason | 'noMetal';

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
  /** Placement sets actually exercised by a valid footprint. Null when the
   *  candidate is invalid. A shoreline-spanning hover footprint can use one
   *  ground set and one water set because loader validation guarantees that
   *  both share the same physical anchor. */
  placementSets: readonly BuildingPlacementSet[] | null;
};

type BuildPlacementOccupiedLookup = (gx: number, gy: number) => boolean;

type BuildPlacementDiagnosticsOptions = {
  includeMetalDiagnostics: boolean;
  ignoreTerrain: boolean;
  /** Ground material policy. `metal` makes every in-map build cell count as a
   *  metal cell, so extractors are placeable anywhere and earn their full
   *  nominal rate. Optional so the many callers that predate the WORLD
   *  toggles keep the authored behaviour. */
  metalCoverage?: MetalCoverage;
};

const DEFAULT_BUILD_PLACEMENT_DIAGNOSTICS_OPTIONS: BuildPlacementDiagnosticsOptions = {
  includeMetalDiagnostics: true,
  ignoreTerrain: false,
  metalCoverage: DEFAULT_METAL_COVERAGE,
};

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
      ? getRotatedBuildingPlacementFootprint(
        existingConfig.placementFootprint,
        b.transform.rotation,
      )
      : rectangularFootprint(
        Math.max(1, Math.ceil(b.building.width / BUILD_GRID_CELL_SIZE)),
        Math.max(1, Math.ceil(b.building.height / BUILD_GRID_CELL_SIZE)),
      );
    const bw = footprint.gridWidth;
    const bh = footprint.gridHeight;
    const left = Math.floor((b.transform.x - (bw * BUILD_GRID_CELL_SIZE) / 2) / BUILD_GRID_CELL_SIZE + 1e-6);
    const top = Math.floor((b.transform.y - (bh * BUILD_GRID_CELL_SIZE) / 2) / BUILD_GRID_CELL_SIZE + 1e-6);
    for (const cell of footprint.cells) {
      occupied.add(cellKey(left + cell.dx, top + cell.dy));
    }
  }
  return occupied;
}

function rectangularFootprint(
  gridWidth: number,
  gridHeight: number,
): BuildingPlacementFootprint {
  const cells = [];
  for (let dy = 0; dy < gridHeight; dy++) {
    for (let dx = 0; dx < gridWidth; dx++) {
      cells.push({ dx, dy, kind: 'structure' as const });
    }
  }
  return { gridWidth, gridHeight, cells };
}

function evaluateFootprintMetalCoverage(
  deposits: ReadonlyArray<MetalDeposit>,
  gridX: number,
  gridY: number,
  footprint: BuildingPlacementFootprint,
  wholeMapIsMetal: boolean,
): {
  fraction: number;
  coveredCells: number;
  totalCells: number;
  primaryDepositId: number | null;
} {
  const hitCounts = new Map<number, number>();
  let coveredCells = 0;
  for (const cell of footprint.cells) {
    if (wholeMapIsMetal) {
      coveredCells++;
      continue;
    }
    const x = (gridX + cell.dx + 0.5) * BUILD_GRID_CELL_SIZE;
    const y = (gridY + cell.dy + 0.5) * BUILD_GRID_CELL_SIZE;
    const deposit = findDepositContainingPoint(deposits, x, y);
    if (deposit === null) continue;
    coveredCells++;
    hitCounts.set(deposit.id, (hitCounts.get(deposit.id) ?? 0) + 1);
  }
  let primaryDepositId: number | null = null;
  let primaryCount = 0;
  for (const [depositId, count] of hitCounts) {
    if (count <= primaryCount) continue;
    primaryCount = count;
    primaryDepositId = depositId;
  }
  const totalCells = footprint.cells.length;
  return {
    fraction: totalCells > 0 ? coveredCells / totalCells : 0,
    coveredCells,
    totalCells,
    primaryDepositId,
  };
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
  options: BuildPlacementDiagnosticsOptions = DEFAULT_BUILD_PLACEMENT_DIAGNOSTICS_OPTIONS,
): BuildPlacementDiagnostics {
  const includeMetalDiagnostics = options.includeMetalDiagnostics;
  const config = getBuildingConfig(candidateType);
  // Validate and reserve the full placement footprint. It shares its
  // center with the physical rect (parity is loader-enforced), so the
  // candidate center below is also the building center.
  const footprint = getRotatedBuildingPlacementFootprint(
    config.placementFootprint,
    rotation,
  );
  const center = getBuildingCenterFromGrid(gridX, gridY, footprint.gridWidth, footprint.gridHeight);
  const requiredSensorSourceMedium =
    getBuildingRequiredSensorSourceMedium(candidateType);
  const centerPlacementBaseZ = getBuildingPlacementBaseZ(
    getBuildingPlacementAnchor(config.placementSets),
    config.gridDepth * BUILD_GRID_CELL_SIZE,
    center.x,
    center.y,
    (x, y) => getSurfaceHeight(x, y, mapWidth, mapHeight),
    (x, y) => getTerrainBedHeight(x, y, mapWidth, mapHeight),
  );
  const sensorMountZ = getBuildingBlueprint(candidateType).turrets.find(
    (mount) => mount.mountId === requiredSensorSourceMedium?.mountId,
  )?.mount.z ?? 0;
  const centerSensorSourceMedium =
    centerPlacementBaseZ + sensorMountZ < WATER_LEVEL
      ? 'underwater'
      : 'aboveWater';
  const sensorSourceMediumMismatch =
    requiredSensorSourceMedium !== null &&
    centerSensorSourceMedium !== requiredSensorSourceMedium.medium;
  const wholeMapIsMetal = metalCoverageIsWholeMap(
    options.metalCoverage ?? DEFAULT_METAL_COVERAGE,
  );
  const extractorCoverage = !isMetalExtractorBlueprintId(candidateType)
    ? null
    : wholeMapIsMetal
      // Every sampled cell is ore, so synthesize full coverage rather than
      // walking a deposit list that no longer describes where the metal is.
      ? evaluateFootprintMetalCoverage(metalDeposits, gridX, gridY, footprint, true)
      : evaluateFootprintMetalCoverage(metalDeposits, gridX, gridY, footprint, false);
  const mapCellsX = Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE);
  const mapCellsY = Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE);
  const cells: BuildPlacementCellDiagnostic[] = [];
  let hasBlockingCell = false;
  let failureReason: BuildPlacementFailureReason | null = null;
  let metalCoveredCells = 0;
  const terrainLevelCounts = new Map<number, number>();
  const exercisedPlacementSets = new Set<BuildingPlacementSet>();
  const ignoreTerrain = options.ignoreTerrain;
  const waterSurfaceMinimumDepth = getSeaOnSurfaceSubmergedDepth(
    config.gridDepth * BUILD_GRID_CELL_SIZE,
  );

  // Each authored mask cell owns one terrain read. Empty bounding-box corners
  // are intentionally ignored, so a circular or concave reservation can hug
  // a shoreline/plateau without silently reverting to rectangle semantics.
  const useAuthoritativeBuildability =
    terrainBuildabilityGrid !== null &&
    terrainBuildabilityGrid.cellSize === BUILD_GRID_CELL_SIZE &&
    terrainBuildabilityGrid.mapWidth === mapWidth &&
    terrainBuildabilityGrid.mapHeight === mapHeight;
  for (const footprintCell of footprint.cells) {
      const gx = gridX + footprintCell.dx;
      const gy = gridY + footprintCell.dy;
      const x = gx * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2;
      const y = gy * BUILD_GRID_CELL_SIZE + BUILD_GRID_CELL_SIZE / 2;
      let reason: BuildPlacementCellReason = 'ok';
      let blocking = false;
      let metalCovered = false;
      let depositId: number | null = null;
      let terrainLevel: number | null = null;
      let placementSet: BuildingPlacementSet | null = null;

      if (gx < 0 || gy < 0 || gx >= mapCellsX || gy >= mapCellsY) {
        reason = 'outOfBounds';
        blocking = true;
      } else if (isCellOccupied(gx, gy)) {
        reason = 'occupied';
        blocking = true;
      } else if (sensorSourceMediumMismatch) {
        reason = 'terrain';
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
        placementSet = cellEval.squareType === null
          ? null
          : config.placementSets.find(
            (candidate) => getBuildingPlacementSetSquareType(candidate) === cellEval.squareType,
          ) ?? null;
        if (placementSet === null) {
          reason = 'terrain';
          blocking = true;
        } else if (
          placementSet === 'water-build-squares-sea-on-surface' &&
          !waterSurfaceBuildCellHasClearance(
            x,
            y,
            BUILD_GRID_CELL_SIZE * 0.5,
            waterSurfaceMinimumDepth,
            mapWidth,
            mapHeight,
          )
        ) {
          reason = 'terrain';
          blocking = true;
        } else {
          const requiresFlatTerrain =
            placementSet === 'ground-build-squares-surface' ||
            placementSet === 'water-build-squares-sea-bed';
          if (requiresFlatTerrain && !ignoreTerrain && !cellEval.terrainBuildable) {
            reason = 'terrain';
            blocking = true;
          } else if (requiresFlatTerrain && !ignoreTerrain && cellEval.level !== null) {
            terrainLevel = cellEval.level;
            terrainLevelCounts.set(terrainLevel, (terrainLevelCounts.get(terrainLevel) ?? 0) + 1);
          }
        }
      }

      if (!blocking && placementSet !== null) exercisedPlacementSets.add(placementSet);

      if (!blocking && includeMetalDiagnostics) {
        const deposit = wholeMapIsMetal ? null : findDepositContainingPoint(metalDeposits, x, y);
        metalCovered = wholeMapIsMetal || deposit !== null;
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

  let expectedTerrainLevel: number | null = null;
  let expectedTerrainCount = -1;
  for (const [level, count] of terrainLevelCounts) {
    if (count > expectedTerrainCount) {
      expectedTerrainLevel = level;
      expectedTerrainCount = count;
    }
  }

  if (!ignoreTerrain && expectedTerrainLevel !== null) {
    for (const cell of cells) {
      if (!cell.blocking && cell.terrainLevel !== expectedTerrainLevel) {
        cell.reason = 'terrain';
        cell.blocking = true;
        hasBlockingCell = true;
        failureReason ??= 'terrain';
      }
    }
  }

  // Diagnostic-only field for callers that want to know which deposit
  // cells are still uncovered by this candidate footprint. The build
  // ghost no longer reads it (deposit markers come from a persistent
  // overlay built once from the deposit list); kept here so the rest of
  // the diagnostic surface remains intact for any other consumer.
  let metalDepositCells: BuildPlacementCellDiagnostic[] | null = null;
  let metalFraction: number | null = null;
  let metalTotalCells: number | null = null;
  if (includeMetalDiagnostics) {
    metalDepositCells = [];
    const depositCells = getMetalDepositGridCells(metalDeposits);
    const reservedCellKeys = new Set(
      footprint.cells.map((cell) => cellKey(gridX + cell.dx, gridY + cell.dy)),
    );
    for (let i = 0; i < depositCells.length; i++) {
      const cell = depositCells[i];
      if (reservedCellKeys.has(cellKey(cell.gx, cell.gy))) continue;
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
  }
  if (includeMetalDiagnostics && isMetalExtractorBlueprintId(candidateType)) {
    metalFraction = extractorCoverage!.fraction;
    metalCoveredCells = extractorCoverage!.coveredCells;
    metalTotalCells = extractorCoverage!.totalCells;
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
    metalCoveredCells: includeMetalDiagnostics && isMetalExtractorBlueprintId(candidateType) ? metalCoveredCells : null,
    metalTotalCells,
    metalDepositCells,
    placementSets: hasBlockingCell
      ? null
      : config.placementSets.filter((placementSet) => exercisedPlacementSets.has(placementSet)),
  };
}

/**
 * A sea-on-surface structure is anchored independently from the terrain, but
 * the entire terrain-mesh area beneath each reserved physical cell must
 * contain enough water for the submerged part of its cuboid (its lower half
 * plus the draft that keeps its origin off the waterline). This rejects
 * shoreline straddling and seabed clipping without requiring a flat
 * underwater plateau.
 */
export function waterSurfaceBuildCellHasClearance(
  centerX: number,
  centerY: number,
  halfCell: number,
  minimumDepth: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const maxBedZ = WATER_LEVEL - minimumDepth;
  const exactRange = getBuildSquareTerrainHeightRange(
    centerX,
    centerY,
    halfCell,
    halfCell,
    mapWidth,
    mapHeight,
  );
  if (exactRange !== null) return exactRange.maxHeight <= maxBedZ;
  if (getTerrainBedHeight(centerX, centerY, mapWidth, mapHeight) > maxBedZ) return false;
  const minX = centerX - halfCell;
  const maxX = centerX + halfCell;
  const minY = centerY - halfCell;
  const maxY = centerY + halfCell;
  return (
    getTerrainBedHeight(minX, minY, mapWidth, mapHeight) <= maxBedZ &&
    getTerrainBedHeight(maxX, minY, mapWidth, mapHeight) <= maxBedZ &&
    getTerrainBedHeight(minX, maxY, mapWidth, mapHeight) <= maxBedZ &&
    getTerrainBedHeight(maxX, maxY, mapWidth, mapHeight) <= maxBedZ
  );
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
  options: BuildPlacementDiagnosticsOptions = DEFAULT_BUILD_PLACEMENT_DIAGNOSTICS_OPTIONS,
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
    options,
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
  options: BuildPlacementDiagnosticsOptions = DEFAULT_BUILD_PLACEMENT_DIAGNOSTICS_OPTIONS,
): BuildPlacementDiagnostics {
  const config = getBuildingConfig(candidateType);
  const footprint = getRotatedBuildingPlacementFootprint(config.placementFootprint, rotation);
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
    options,
  );
}

export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingBlueprintId: BuildingBlueprintId,
  rotation = 0,
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingBlueprintId);
  const footprint = getRotatedBuildingPlacementFootprint(config.placementFootprint, rotation);
  return snapBuildingToGrid(worldX, worldY, footprint.gridWidth, footprint.gridHeight);
}
