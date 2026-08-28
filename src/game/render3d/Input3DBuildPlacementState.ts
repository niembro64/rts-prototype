import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type {
  BuildingBlueprintId,
  BuildingPlacementFootprint,
  Entity,
} from '../sim/types';
import {
  generateMetalDeposits,
  type MetalDeposit,
} from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { orderAreaTargetsByChainedNearest } from '../sim/areaTargetOrdering';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from '../sim/buildGrid';
import {
  BUILDING_ROTATION_STEP_RAD,
  snapBuildingRotation,
} from '../sim/buildingRotation';
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
  /** Per-placement facing is used by BAR's build-around grammar, whose four
   *  sides turn toward the surrounded structure. Ordinary drags omit it and
   *  inherit the active build facing. */
  rotation?: number;
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
  footprint: BuildingPlacementFootprint;
  placements: BuildAreaPlacementPlan[];
};

type BuildPlacementEntitySource = {
  getBuildings: () => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

const BUILD_LINE_SPACING_MIN_STEPS = 0;
// BAR's persistent/limit-build-spacing widgets remember at most 16 spacing
// steps for each selected building type.
const BUILD_LINE_SPACING_MAX_STEPS = 16;
const MAX_DRAG_BUILD_PLACEMENTS = 200;
const BUILDING_COUNT_FUDGE_FACTOR = 1.4;

export class Input3DBuildPlacementState {
  private mapWidth = Infinity;
  private mapHeight = Infinity;
  private metalDeposits: ReadonlyArray<MetalDeposit> = [];
  private validationKey = '';
  private occupancyVersion = '';
  private occupiedCells: ReadonlySet<string> | undefined;
  private buildLineSpacingSteps = 0;
  private activeBuildingBlueprintId: BuildingBlueprintId | null = null;
  private readonly buildLineSpacingStepsByBlueprint = new Map<BuildingBlueprintId, number>();
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

  /** BAR's cmd_persistent_build_spacing remembers the last gap independently
   *  for every structure during a match. Switching build choices therefore
   *  restores that structure's gap instead of leaking the previous choice's
   *  spacing into it. */
  setActiveBuildingBlueprintId(buildingBlueprintId: BuildingBlueprintId | null): void {
    if (this.activeBuildingBlueprintId === buildingBlueprintId) return;
    if (this.activeBuildingBlueprintId !== null) {
      this.buildLineSpacingStepsByBlueprint.set(
        this.activeBuildingBlueprintId,
        this.buildLineSpacingSteps,
      );
    }
    this.activeBuildingBlueprintId = buildingBlueprintId;
    this.buildLineSpacingSteps = buildingBlueprintId === null
      ? 0
      : this.buildLineSpacingStepsByBlueprint.get(buildingBlueprintId) ?? 0;
  }

  rotateBuildFacingClockwise(): BuildFacingInfo {
    this.buildFacingRotation = snapBuildingRotation(
      this.buildFacingRotation - BUILDING_ROTATION_STEP_RAD,
    );
    return this.facingInfo;
  }

  rotateBuildFacingCounterClockwise(): BuildFacingInfo {
    this.buildFacingRotation = snapBuildingRotation(
      this.buildFacingRotation + BUILDING_ROTATION_STEP_RAD,
    );
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

  /** BAR quick-build (cmd_quick_build_extractor): nearest deposit whose
   *  ORIGIN lies within `radius` of the point. Same membership rule as
   *  the area planner — never widened by placementRadius (see the
   *  warning on planMetalExtractorPlacementsInArea). */
  findNearestMetalDepositWithin(
    worldX: number,
    worldY: number,
    radius: number,
  ): MetalDeposit | null {
    let best: MetalDeposit | null = null;
    let bestSq = radius * radius;
    for (let i = 0; i < this.metalDeposits.length; i++) {
      const deposit = this.metalDeposits[i];
      const dx = deposit.x - worldX;
      const dy = deposit.y - worldY;
      const dSq = dx * dx + dy * dy;
      if (dSq <= bestSq) {
        bestSq = dSq;
        best = deposit;
      }
    }
    return best;
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
    orderSeedX: number,
    orderSeedY: number,
  ): BuildAreaPlacementPlan[] {
    const buildingBlueprintId: BuildingBlueprintId = 'buildingExtractor';
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const safeRadius = Math.max(1, radius);

    const depositsInArea: MetalDeposit[] = [];
    for (const deposit of this.metalDeposits) {
      const dx = deposit.x - worldX;
      const dy = deposit.y - worldY;
      // Membership is the deposit ORIGIN inside the dragged circle — BAR's
      // exact test. placementRadius must never widen this: it is the
      // connected-growth wander cap, not the ore's size, and the titanic
      // center deposit's cap exceeds the whole playable map, which made every
      // area-mex drag anywhere select the deposit at dead center.
      if (dx * dx + dy * dy > safeRadius * safeRadius) continue;
      depositsInArea.push(deposit);
    }

    // BAR cmd_area_mex ordering: chained nearest-neighbour path seeded from
    // the ordering builders, worth-weighted so a slightly farther deposit
    // with more metal cells outranks a near poor one. Without this the
    // placements ride raw generator order (ring/spot/player-major), which is
    // the "totally random" build sequence players see.
    orderAreaTargetsByChainedNearest(
      depositsInArea,
      orderSeedX,
      orderSeedY,
      (deposit) => deposit.x,
      (deposit) => deposit.y,
      (deposit) => deposit.id,
      (deposit) => deposit.metalCellCount,
    );

    for (let i = 0; i < depositsInArea.length; i++) {
      this.tryAddPlannedBuildPlacement(context, depositsInArea[i].x, depositsInArea[i].y, true);
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
    // Recoil/BAR grows the step along the dominant drag axis and projects the
    // other axis onto it. A spacing step adds one build cell on BOTH sides of
    // the footprint; it is additive, not a percentage of building size.
    const spacingX = this.buildAxisSpacing(context.footprint.gridWidth);
    const spacingY = this.buildAxisSpacing(context.footprint.gridHeight);
    const xDominant = Math.abs(dx) > Math.abs(dy);
    const majorSpacing = xDominant ? spacingX : spacingY;
    const majorDelta = xDominant ? dx : dy;
    const minorDelta = xDominant ? dy : dx;
    const placementCount = Math.max(
      1,
      Math.floor((Math.abs(majorDelta) + majorSpacing * BUILDING_COUNT_FUDGE_FACTOR) / majorSpacing),
    );
    const majorStep = (majorDelta > 0 ? 1 : -1) * majorSpacing;
    const minorStep = majorStep * minorDelta / (majorDelta !== 0 ? majorDelta : 1);

    for (let i = 0; i < placementCount; i++) {
      this.tryAddPlannedBuildPlacement(
        context,
        startX + (xDominant ? majorStep : minorStep) * i,
        startY + (xDominant ? minorStep : majorStep) * i,
      );
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
    const spacingX = this.buildAxisSpacing(context.footprint.gridWidth);
    const spacingY = this.buildAxisSpacing(context.footprint.gridHeight);
    const dx = endX - startX;
    const dy = endY - startY;
    const xCount = Math.max(
      1,
      Math.floor((Math.abs(dx) + spacingX * BUILDING_COUNT_FUDGE_FACTOR) / spacingX),
    );
    const yCount = Math.max(
      1,
      Math.floor((Math.abs(dy) + spacingY * BUILDING_COUNT_FUDGE_FACTOR) / spacingY),
    );
    const xStep = (dx >= 0 ? 1 : -1) * spacingX;
    const yStep = (dy >= 0 ? 1 : -1) * spacingY;

    // Recoil/BAR hollow-box ordering is directional: it starts from the
    // drag anchor corner and walks the signed rectangle perimeter instead
    // of normalizing to the north-west corner.
    if (xCount <= 1) {
      this.planBuildStepPlacements(context, startX, startY, 0, yStep, yCount);
    } else if (yCount <= 1) {
      this.planBuildStepPlacements(context, startX, startY, xStep, 0, xCount);
    } else {
      this.planBuildStepPlacements(context, startX, startY + yStep, 0, yStep, yCount - 1);
      this.planBuildStepPlacements(
        context,
        startX + xStep,
        startY + (yCount - 1) * yStep,
        xStep,
        0,
        xCount - 1,
      );
      this.planBuildStepPlacements(
        context,
        startX + (xCount - 1) * xStep,
        startY + (yCount - 2) * yStep,
        0,
        -yStep,
        yCount - 1,
      );
      this.planBuildStepPlacements(
        context,
        startX + (xCount - 2) * xStep,
        startY,
        -xStep,
        0,
        xCount - 1,
      );
    }
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
    const dx = endX - startX;
    const dy = endY - startY;
    const spacingX = this.buildAxisSpacing(context.footprint.gridWidth);
    const spacingY = this.buildAxisSpacing(context.footprint.gridHeight);
    const xCount = Math.max(
      1,
      Math.floor((Math.abs(dx) + spacingX * BUILDING_COUNT_FUDGE_FACTOR) / spacingX),
    );
    const yCount = Math.max(
      1,
      Math.floor((Math.abs(dy) + spacingY * BUILDING_COUNT_FUDGE_FACTOR) / spacingY),
    );
    const xStep = (dx >= 0 ? 1 : -1) * spacingX;
    const yStep = (dy >= 0 ? 1 : -1) * spacingY;

    // BAR's grid fill (gui_pregame_build.lua getBuildPositionsGrid,
    // mirroring the engine) starts from the drag anchor and walks signed
    // rows serpentine, so a single builder sweeps the rectangle without
    // doubling back across each row.
    for (let yi = 0; yi < yCount; yi++) {
      const y = startY + yStep * yi;
      const reversed = yi % 2 === 1;
      for (let step = 0; step < xCount; step++) {
        const xi = reversed ? xCount - 1 - step : step;
        const x = startX + xStep * xi;
        this.tryAddPlannedBuildPlacement(context, x, y);
      }
    }
    return context.placements;
  }

  /** Shift+Ctrl over a structure in BAR wraps the selected building around
   *  that target. The side order and fitted perimeter mirror
   *  gui_pregame_build.lua; each side receives its own inward facing. */
  planBuildAroundPlacements(
    buildingBlueprintId: BuildingBlueprintId,
    target: Entity,
    entitySource: BuildPlacementEntitySource,
  ): BuildAreaPlacementPlan[] {
    if (target.building === null || target.buildingBlueprintId === null) return [];
    const context = this.createPlannedBuildPlacementContext(buildingBlueprintId, entitySource);
    const targetConfig = getBuildingConfig(target.buildingBlueprintId);
    const targetFootprint = getRotatedBuildingPlacementFootprint(
      targetConfig.placementFootprint,
      target.transform.rotation,
    );
    const currentWidth = context.footprint.gridWidth * BUILD_GRID_CELL_SIZE;
    const currentHeight = context.footprint.gridHeight * BUILD_GRID_CELL_SIZE;
    const targetWidth = targetFootprint.gridWidth * BUILD_GRID_CELL_SIZE;
    const targetHeight = targetFootprint.gridHeight * BUILD_GRID_CELL_SIZE;
    const widthCount = Math.max(1, Math.ceil((targetWidth + 2 * currentWidth) / currentWidth));
    const heightCount = Math.max(1, Math.ceil((targetHeight + 2 * currentHeight) / currentHeight));
    const startX = target.transform.x - widthCount * currentWidth / 2 + currentWidth / 2;
    const startY = target.transform.y - heightCount * currentHeight / 2 + currentHeight / 2;

    // Local building forward is +X. Top/bottom and left/right therefore use
    // these exact quarter turns to face the target rather than all retaining
    // the currently selected direction.
    const topRotation = -BUILDING_ROTATION_STEP_RAD;
    const bottomRotation = BUILDING_ROTATION_STEP_RAD;
    const leftRotation = 0;
    const rightRotation = Math.PI;
    const topY = target.transform.y + targetHeight / 2 + currentHeight / 2;
    const bottomY = target.transform.y - targetHeight / 2 - currentHeight / 2;
    const leftX = target.transform.x - targetWidth / 2 - currentWidth / 2;
    const rightX = target.transform.x + targetWidth / 2 + currentWidth / 2;

    for (let i = 0; i < widthCount; i++) {
      const x = startX + i * currentWidth;
      this.tryAddPlannedBuildPlacement(context, x, topY, false, topRotation);
    }
    for (let i = 0; i < widthCount; i++) {
      const x = startX + i * currentWidth;
      this.tryAddPlannedBuildPlacement(context, x, bottomY, false, bottomRotation);
    }
    for (let i = 0; i < heightCount; i++) {
      const y = startY + i * currentHeight;
      this.tryAddPlannedBuildPlacement(context, leftX, y, false, leftRotation);
    }
    for (let i = 0; i < heightCount; i++) {
      const y = startY + i * currentHeight;
      this.tryAddPlannedBuildPlacement(context, rightX, y, false, rightRotation);
    }
    return context.placements;
  }

  private get buildLineSpacingMultiplier(): number {
    if (this.activeBuildingBlueprintId === null) {
      return 1 + this.buildLineSpacingSteps * 0.5;
    }
    const footprint = getBuildingConfig(this.activeBuildingBlueprintId).placementFootprint;
    const baseCells = Math.max(1, footprint.gridWidth, footprint.gridHeight);
    return (baseCells + this.buildLineSpacingSteps * 2) / baseCells;
  }

  private buildAxisSpacing(footprintCells: number): number {
    return Math.max(1, footprintCells + this.buildLineSpacingSteps * 2)
      * BUILD_GRID_CELL_SIZE;
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
      footprint: getRotatedBuildingPlacementFootprint(
        config.placementFootprint,
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
    rotation = this.buildFacingRotation,
  ): void {
    if (context.placements.length >= MAX_DRAG_BUILD_PLACEMENTS) return;
    const snapped = getSnappedBuildPosition(
      worldX,
      worldY,
      context.buildingBlueprintId,
      rotation,
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
      rotation,
    );
    if (!diagnostics.canPlace) return;
    if (requireMetal && (diagnostics.metalCoveredCells ?? 0) <= 0) return;

    context.planned.add(key);
    context.placements.push({
      gridX: diagnostics.gridX,
      gridY: diagnostics.gridY,
      x: diagnostics.x,
      y: diagnostics.y,
      rotation,
    });
    const footprint = rotation === this.buildFacingRotation
      ? context.footprint
      : getRotatedBuildingPlacementFootprint(
          getBuildingConfig(context.buildingBlueprintId).placementFootprint,
          rotation,
        );
    for (const cell of footprint.cells) {
      context.plannedOccupiedCells.add(
        cellKey(diagnostics.gridX + cell.dx, diagnostics.gridY + cell.dy),
      );
    }
  }

  private planBuildStepPlacements(
    context: PlannedBuildPlacementContext,
    startX: number,
    startY: number,
    stepX: number,
    stepY: number,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      this.tryAddPlannedBuildPlacement(
        context,
        startX + stepX * i,
        startY + stepY * i,
      );
    }
  }
}

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}
