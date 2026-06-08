import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { BuildingBlueprintId, Entity } from '../sim/types';
import {
  generateMetalDeposits,
  type MetalDeposit,
} from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { normalizeAngle } from '../math';
import {
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
  type BuildPlacementDiagnostics,
} from '../input/helpers';

export type BuildAreaPlacementPlan = {
  gridX: number;
  gridY: number;
  x: number;
  y: number;
};

export type BuildLineSpacingInfo = {
  steps: number;
  multiplier: number;
};

export type BuildFacingInfo = {
  rotation: number;
  degrees: number;
};

type BuildPlacementEntitySource = {
  getBuildings: () => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

const BUILD_LINE_SPACING_STEP = 0.5;
const BUILD_LINE_SPACING_MIN_STEPS = 0;
const BUILD_LINE_SPACING_MAX_STEPS = 8;
const BUILD_FACING_STEP_RAD = Math.PI / 2;

export class Input3DBuildPlacementState {
  private mapWidth = Infinity;
  private mapHeight = Infinity;
  private metalDeposits: ReadonlyArray<MetalDeposit> = [];
  private validationKey = '';
  private occupancyVersion = '';
  private occupiedCells: ReadonlySet<string> | undefined;
  private buildLineSpacingSteps = 0;
  private buildFacingRotation = 0;

  canPlace = false;
  diagnostics: BuildPlacementDiagnostics | undefined;

  get width(): number {
    return this.mapWidth;
  }

  get height(): number {
    return this.mapHeight;
  }

  get spacingInfo(): BuildLineSpacingInfo {
    return {
      steps: this.buildLineSpacingSteps,
      multiplier: this.buildLineSpacingMultiplier,
    };
  }

  get facingInfo(): BuildFacingInfo {
    const degrees = Math.round((this.buildFacingRotation * 180) / Math.PI);
    return {
      rotation: this.buildFacingRotation,
      degrees: ((degrees % 360) + 360) % 360,
    };
  }

  increaseBuildLineSpacing(): BuildLineSpacingInfo {
    this.buildLineSpacingSteps = Math.min(
      BUILD_LINE_SPACING_MAX_STEPS,
      this.buildLineSpacingSteps + 1,
    );
    return this.spacingInfo;
  }

  decreaseBuildLineSpacing(): BuildLineSpacingInfo {
    this.buildLineSpacingSteps = Math.max(
      BUILD_LINE_SPACING_MIN_STEPS,
      this.buildLineSpacingSteps - 1,
    );
    return this.spacingInfo;
  }

  rotateBuildFacingClockwise(): BuildFacingInfo {
    this.buildFacingRotation = normalizeAngle(this.buildFacingRotation - BUILD_FACING_STEP_RAD);
    return this.facingInfo;
  }

  rotateBuildFacingCounterClockwise(): BuildFacingInfo {
    this.buildFacingRotation = normalizeAngle(this.buildFacingRotation + BUILD_FACING_STEP_RAD);
    return this.facingInfo;
  }

  setMapBounds(
    width: number,
    height: number,
    playerCount: number,
  ): void {
    this.mapWidth = width;
    this.mapHeight = height;
    this.metalDeposits = generateMetalDeposits(width, height, playerCount);
  }

  reset(): void {
    this.validationKey = '';
    this.canPlace = false;
    this.diagnostics = undefined;
  }

  clearDiagnostics(): void {
    this.diagnostics = undefined;
  }

  validate(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildPlacementDiagnostics {
    const snapped = getSnappedBuildPosition(worldX, worldY, buildingBlueprintId);
    const buildings = entitySource.getBuildings();
    const entitySetVersion = entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.occupancyVersion || !this.occupiedCells) {
      this.occupancyVersion = occupancyVersion;
      this.occupiedCells = getOccupiedBuildingCells(buildings);
    }

    const validationKey = [
      buildingBlueprintId,
      snapped.gridX,
      snapped.gridY,
      this.mapWidth,
      this.mapHeight,
      entitySetVersion,
      terrainBuildabilityGrid?.version ?? 0,
      terrainBuildabilityGrid?.configKey ?? '',
    ].join(':');
    if (validationKey !== this.validationKey || !this.diagnostics) {
      this.validationKey = validationKey;
      this.diagnostics = getBuildingPlacementDiagnostics(
        buildingBlueprintId, snapped.x, snapped.y,
        this.mapWidth, this.mapHeight,
        buildings,
        this.metalDeposits,
        this.occupiedCells,
        terrainBuildabilityGrid,
      );
      this.canPlace = this.diagnostics.canPlace;
    }
    return this.diagnostics;
  }

  planMetalExtractorPlacementsInArea(
    worldX: number,
    worldY: number,
    radius: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    const buildingBlueprintId: BuildingBlueprintId = 'buildingExtractor';
    const config = getBuildingConfig(buildingBlueprintId);
    const buildings = entitySource.getBuildings();
    const entitySetVersion = entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.occupancyVersion || !this.occupiedCells) {
      this.occupancyVersion = occupancyVersion;
      this.occupiedCells = getOccupiedBuildingCells(buildings);
    }
    const plannedOccupiedCells = new Set(this.occupiedCells);
    const planned = new Set<string>();
    const placements: BuildAreaPlacementPlan[] = [];
    const safeRadius = Math.max(1, radius);

    for (const deposit of this.metalDeposits) {
      const dx = deposit.x - worldX;
      const dy = deposit.y - worldY;
      if (Math.sqrt(dx * dx + dy * dy) > safeRadius + deposit.resourceRadius) continue;

      const snapped = getSnappedBuildPosition(deposit.x, deposit.y, buildingBlueprintId);
      const key = cellKey(snapped.gridX, snapped.gridY);
      if (planned.has(key)) continue;

      const diagnostics = getBuildingPlacementDiagnostics(
        buildingBlueprintId,
        snapped.x,
        snapped.y,
        this.mapWidth,
        this.mapHeight,
        buildings,
        this.metalDeposits,
        plannedOccupiedCells,
        terrainBuildabilityGrid,
      );
      if (!diagnostics.canPlace || (diagnostics.metalCoveredCells ?? 0) <= 0) continue;

      planned.add(key);
      placements.push({
        gridX: diagnostics.gridX,
        gridY: diagnostics.gridY,
        x: diagnostics.x,
        y: diagnostics.y,
      });
      for (let y = 0; y < config.gridHeight; y++) {
        for (let x = 0; x < config.gridWidth; x++) {
          plannedOccupiedCells.add(cellKey(diagnostics.gridX + x, diagnostics.gridY + y));
        }
      }
    }
    return placements;
  }

  planBuildLinePlacements(
    buildingBlueprintId: BuildingBlueprintId,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    const config = getBuildingConfig(buildingBlueprintId);
    const buildings = entitySource.getBuildings();
    const entitySetVersion = entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.occupancyVersion || !this.occupiedCells) {
      this.occupancyVersion = occupancyVersion;
      this.occupiedCells = getOccupiedBuildingCells(buildings);
    }
    const plannedOccupiedCells = new Set(this.occupiedCells);
    const planned = new Set<string>();
    const placements: BuildAreaPlacementPlan[] = [];
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);
    const spacing = Math.max(config.gridWidth, config.gridHeight, 1)
      * BUILD_GRID_CELL_SIZE
      * this.buildLineSpacingMultiplier;
    const placementCount = Math.max(1, Math.floor(distance / Math.max(1, spacing)) + 1);

    for (let i = 0; i < placementCount; i++) {
      const t = placementCount === 1 ? 0 : i / (placementCount - 1);
      const worldX = startX + dx * t;
      const worldY = startY + dy * t;
      const snapped = getSnappedBuildPosition(worldX, worldY, buildingBlueprintId);
      const key = cellKey(snapped.gridX, snapped.gridY);
      if (planned.has(key)) continue;

      const diagnostics = getBuildingPlacementDiagnostics(
        buildingBlueprintId,
        snapped.x,
        snapped.y,
        this.mapWidth,
        this.mapHeight,
        buildings,
        this.metalDeposits,
        plannedOccupiedCells,
        terrainBuildabilityGrid,
      );
      if (!diagnostics.canPlace) continue;

      planned.add(key);
      placements.push({
        gridX: diagnostics.gridX,
        gridY: diagnostics.gridY,
        x: diagnostics.x,
        y: diagnostics.y,
      });
      for (let y = 0; y < config.gridHeight; y++) {
        for (let x = 0; x < config.gridWidth; x++) {
          plannedOccupiedCells.add(cellKey(diagnostics.gridX + x, diagnostics.gridY + y));
        }
      }
    }

    return placements;
  }

  private get buildLineSpacingMultiplier(): number {
    return 1 + this.buildLineSpacingSteps * BUILD_LINE_SPACING_STEP;
  }
}

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}
