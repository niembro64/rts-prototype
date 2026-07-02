import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { BuildingBlueprintId, Entity } from '../sim/types';
import {
  generateMetalDeposits,
  type MetalDeposit,
} from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE, getRotatedGridFootprint } from '../sim/buildGrid';
import { normalizeAngle } from '../math';
import {
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
  type BuildPlacementDiagnostics,
} from '../input/helpers';

type BuildAreaPlacementPlan = {
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

type PlannedBuildPlacementContext = {
  buildingBlueprintId: BuildingBlueprintId;
  buildings: Entity[];
  terrainBuildabilityGrid: TerrainBuildabilityGrid | null;
  plannedOccupiedCells: Set<string>;
  planned: Set<string>;
  footprint: { gridWidth: number; gridHeight: number };
  placements: BuildAreaPlacementPlan[];
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
    metalDeposits: ReadonlyArray<MetalDeposit> | null = null,
  ): void {
    this.mapWidth = width;
    this.mapHeight = height;
    this.metalDeposits = metalDeposits ?? generateMetalDeposits(width, height, playerCount);
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
    const snapped = getSnappedBuildPosition(worldX, worldY, buildingBlueprintId, this.buildFacingRotation);
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
      this.buildFacingRotation,
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
        this.buildFacingRotation,
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
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const safeRadius = Math.max(1, radius);

    for (const deposit of this.metalDeposits) {
      const dx = deposit.x - worldX;
      const dy = deposit.y - worldY;
      if (Math.sqrt(dx * dx + dy * dy) > safeRadius + deposit.resourceRadius) continue;

      this.tryAddPlannedBuildPlacement(context, deposit.x, deposit.y, true);
    }
    return context.placements;
  }

  planBuildLinePlacements(
    buildingBlueprintId: BuildingBlueprintId,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);
    const spacing = Math.max(context.footprint.gridWidth, context.footprint.gridHeight, 1)
      * BUILD_GRID_CELL_SIZE
      * this.buildLineSpacingMultiplier;
    const placementCount = Math.max(1, Math.floor(distance / Math.max(1, spacing)) + 1);

    for (let i = 0; i < placementCount; i++) {
      const t = placementCount === 1 ? 0 : i / (placementCount - 1);
      const worldX = startX + dx * t;
      const worldY = startY + dy * t;
      this.tryAddPlannedBuildPlacement(context, worldX, worldY);
    }

    return context.placements;
  }

  planBuildBorderPlacements(
    buildingBlueprintId: BuildingBlueprintId,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    const spacing = Math.max(context.footprint.gridWidth, context.footprint.gridHeight, 1)
      * BUILD_GRID_CELL_SIZE
      * this.buildLineSpacingMultiplier;
    this.planBuildSegmentPlacements(context, minX, minY, maxX, minY, spacing);
    this.planBuildSegmentPlacements(context, maxX, minY, maxX, maxY, spacing);
    this.planBuildSegmentPlacements(context, maxX, maxY, minX, maxY, spacing);
    this.planBuildSegmentPlacements(context, minX, maxY, minX, minY, spacing);
    return context.placements;
  }

  planBuildGridPlacements(
    buildingBlueprintId: BuildingBlueprintId,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    const spacingX = Math.max(1, context.footprint.gridWidth)
      * BUILD_GRID_CELL_SIZE
      * this.buildLineSpacingMultiplier;
    const spacingY = Math.max(1, context.footprint.gridHeight)
      * BUILD_GRID_CELL_SIZE
      * this.buildLineSpacingMultiplier;
    const xCount = Math.max(1, Math.floor((maxX - minX) / Math.max(1, spacingX)) + 1);
    const yCount = Math.max(1, Math.floor((maxY - minY) / Math.max(1, spacingY)) + 1);

    // BAR's grid fill (gui_pregame_build.lua getBuildPositionsGrid,
    // mirroring the engine) walks rows serpentine — every other row is
    // filled right-to-left — so a single builder sweeps the rectangle
    // without doubling back across each row.
    for (let yi = 0; yi < yCount; yi++) {
      const ty = yCount === 1 ? 0 : yi / (yCount - 1);
      const y = minY + (maxY - minY) * ty;
      const reversed = yi % 2 === 1;
      for (let step = 0; step < xCount; step++) {
        const xi = reversed ? xCount - 1 - step : step;
        const tx = xCount === 1 ? 0 : xi / (xCount - 1);
        const x = minX + (maxX - minX) * tx;
        this.tryAddPlannedBuildPlacement(context, x, y);
      }
    }
    return context.placements;
  }

  private get buildLineSpacingMultiplier(): number {
    return 1 + this.buildLineSpacingSteps * BUILD_LINE_SPACING_STEP;
  }

  private createPlannedBuildPlacementContext(
    buildingBlueprintId: BuildingBlueprintId,
    entitySource: BuildPlacementEntitySource,
  ): PlannedBuildPlacementContext {
    const config = getBuildingConfig(buildingBlueprintId);
    const buildings = entitySource.getBuildings();
    const entitySetVersion = entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.occupancyVersion || !this.occupiedCells) {
      this.occupancyVersion = occupancyVersion;
      this.occupiedCells = getOccupiedBuildingCells(buildings);
    }
    return {
      buildingBlueprintId,
      buildings,
      terrainBuildabilityGrid,
      plannedOccupiedCells: new Set(this.occupiedCells),
      planned: new Set<string>(),
      footprint: getRotatedGridFootprint(
        config.placementGridWidth,
        config.placementGridHeight,
        this.buildFacingRotation,
      ),
      placements: [],
    };
  }

  private tryAddPlannedBuildPlacement(
    context: PlannedBuildPlacementContext,
    worldX: number,
    worldY: number,
    requireMetal = false,
  ): void {
    const snapped = getSnappedBuildPosition(
      worldX,
      worldY,
      context.buildingBlueprintId,
      this.buildFacingRotation,
    );
    const key = cellKey(snapped.gridX, snapped.gridY);
    if (context.planned.has(key)) return;

    const diagnostics = getBuildingPlacementDiagnostics(
      context.buildingBlueprintId,
      snapped.x,
      snapped.y,
      this.mapWidth,
      this.mapHeight,
      context.buildings,
      this.metalDeposits,
      context.plannedOccupiedCells,
      context.terrainBuildabilityGrid,
      this.buildFacingRotation,
    );
    if (!diagnostics.canPlace) return;
    if (requireMetal && (diagnostics.metalCoveredCells ?? 0) <= 0) return;

    context.planned.add(key);
    context.placements.push({
      gridX: diagnostics.gridX,
      gridY: diagnostics.gridY,
      x: diagnostics.x,
      y: diagnostics.y,
    });
    for (let y = 0; y < context.footprint.gridHeight; y++) {
      for (let x = 0; x < context.footprint.gridWidth; x++) {
        context.plannedOccupiedCells.add(cellKey(diagnostics.gridX + x, diagnostics.gridY + y));
      }
    }
  }

  private planBuildSegmentPlacements(
    context: PlannedBuildPlacementContext,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    spacing: number,
  ): void {
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);
    const placementCount = Math.max(1, Math.floor(distance / Math.max(1, spacing)) + 1);
    for (let i = 0; i < placementCount; i++) {
      const t = placementCount === 1 ? 0 : i / (placementCount - 1);
      this.tryAddPlannedBuildPlacement(context, startX + dx * t, startY + dy * t);
    }
  }
}

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}
