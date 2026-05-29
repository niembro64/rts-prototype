import type { WorldState } from './WorldState';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from './types';
import { getBuildingConfig } from './buildConfigs';
import { getBuildingBlueprint } from './blueprints';
import { BuildingGrid, BUILD_GRID_CELL_SIZE } from './buildGrid';
import { computeFactoryWaypoint } from './spawn';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { ENTITY_CHANGED_ACTIONS } from '../../types/network';
import { buildingBlueprintHasActiveState, ensureBuildingActiveState } from './buildingActiveState';
import { removeCompletedBuildingEffects } from './buildingCompletion';
import { isBuildTargetInRange } from './builderRange';
import { createBuildable, getInitialBuildHp } from './buildableHelpers';
import { applyEntitySensorBlueprint } from './cloakDetection';
import { isTowerBuildingBlueprintId } from '../../types/buildingTypes';

// Construction system - authoritative building placement and footprint grid.
// Runtime resource/HP/completion semantics live in constructionLifecycle.ts.
export class ConstructionSystem {
  private buildingGrid: BuildingGrid;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly terrainBuildabilityGrid: TerrainBuildabilityGrid | null;

  constructor(
    mapWidth: number,
    mapHeight: number,
    terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null,
  ) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.terrainBuildabilityGrid = terrainBuildabilityGrid;
    this.buildingGrid = new BuildingGrid(mapWidth, mapHeight);
  }

  // Get the building grid
  getGrid(): BuildingGrid {
    return this.buildingGrid;
  }

  private isCellOccupied(gridX: number, gridY: number): boolean {
    const cell = this.buildingGrid.getCell(gridX, gridY);
    return cell !== undefined && cell.occupied === true;
  }

  // Start a new building construction
  startBuilding(
    world: WorldState,
    buildingBlueprintId: BuildingBlueprintId,
    gridX: number,
    gridY: number,
    playerId: PlayerId,
    builderId: EntityId
  ): Entity | null {
    const config = getBuildingConfig(buildingBlueprintId);

    const diagnostics = getBuildingPlacementDiagnosticsForGrid(
      buildingBlueprintId,
      gridX,
      gridY,
      world.mapWidth,
      world.mapHeight,
      world.metalDeposits,
      (gx, gy) => this.isCellOccupied(gx, gy),
      this.terrainBuildabilityGrid,
    );
    if (!diagnostics.canPlace) {
      return null;
    }

    // Get world position for building center
    const worldPos = { x: diagnostics.x, y: diagnostics.y };

    // Extractors can be placed ANYWHERE that satisfies the normal
    // building placement rules — there's no longer a "must overlap
    // a deposit" gate. When the extractor finishes building,
    // applyCompletedBuildingEffects computes metal/sec directly from
    // the number of generated metal cells under this fixed footprint.
    // No production work happens at startBuilding — those fields stay
    // zero / empty until completion.

    const physicalSize = {
      width: config.gridWidth * BUILD_GRID_CELL_SIZE,
      height: config.gridHeight * BUILD_GRID_CELL_SIZE,
      depth: config.gridDepth * BUILD_GRID_CELL_SIZE,
    };

    const entity = world.createBuilding(
      worldPos.x,
      worldPos.y,
      physicalSize.width,
      physicalSize.height,
      physicalSize.depth,
      playerId
    );

    // Add buildable component — paid starts at zero on every axis;
    // resources flow in from the player's stockpile until each axis
    // reaches required.
    entity.buildable = createBuildable(config.cost);

    // Set building blueprint
    entity.buildingBlueprintId = buildingBlueprintId;
    // Tower-class buildingTypes (fabricator + shooting towers) carry
    // the 'tower' EntityType discriminator. See design_philosophy.html
    // "Towers Are Static Hosts That Lock On And Fire".
    if (isTowerBuildingBlueprintId(buildingBlueprintId)) {
      entity.type = 'tower';
    }
    applyEntitySensorBlueprint(entity, getBuildingBlueprint(buildingBlueprintId));
    if (buildingBlueprintHasActiveState(buildingBlueprintId)) {
      ensureBuildingActiveState(entity);
    }
    if (buildingBlueprintId === 'extractor') {
      // Inactive at construction start. The completion handler runs
      // computeExtractorMetalCoverage fills `coveredDepositIds` and sets
      // `metalExtractionRate` from the number of metal cells under this
      // fixed build footprint.
      entity.coveredDepositIds = [];
      entity.metalExtractionRate = 0;
    }

    // Set max HP from config. Construction shells start barely alive
    // and gain HP only as resources are paid in; they do not start at
    // full durability.
    if (entity.building) {
      entity.building.hp = getInitialBuildHp(config.hp);
      entity.building.maxHp = config.hp;
    }

    // Add factory component if it's a factory
    if (buildingBlueprintId === 'factory') {
      const wp = computeFactoryWaypoint(
        worldPos.x,
        worldPos.y,
        world.mapWidth,
        world.mapHeight,
        REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
      );
      entity.factory = {
        buildQueue: [],
        currentShellId: null,
        currentBuildProgress: 0,
        rallyX: wp.x,
        rallyY: wp.y,
        isProducing: false,
        waypoints: [{ x: wp.x, y: wp.y, type: REAL_BATTLE_FACTORY_WAYPOINT_TYPE }],
        energyRateFraction: 0,
        metalRateFraction: 0,
      };
    }

    // Register the real blocking footprint. Factories no longer reserve
    // an invisible yard; only the tower cells are occupied.
    this.buildingGrid.place(gridX, gridY, config.gridWidth, config.gridHeight, entity.id, playerId);

    // Add to world
    world.addEntity(entity);

    // Assign builder (only for non-commanders - commanders use their buildQueue instead)
    const builder = world.getEntity(builderId);
    if (builder !== undefined && builder.builder !== null && builder.commander === null) {
      builder.builder.currentBuildTarget = entity.id;
      world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
    }

    return entity;
  }

  // Create a ghost preview for building placement
  createGhost(
    world: WorldState,
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
    playerId: PlayerId
  ): Entity {
    const config = getBuildingConfig(buildingBlueprintId);

    // Snap to grid
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    const centerX = snapped.x + (config.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
    const centerY = snapped.y + (config.gridHeight * BUILD_GRID_CELL_SIZE) / 2;

    // Create ghost entity
    const entity = world.createBuilding(
      centerX,
      centerY,
      config.gridWidth * BUILD_GRID_CELL_SIZE,
      config.gridHeight * BUILD_GRID_CELL_SIZE,
      config.gridDepth * BUILD_GRID_CELL_SIZE,
      playerId
    );

    entity.buildable = createBuildable(config.cost, {
      paid: null,
      isGhost: true,
      healthBuildFraction: null,
    });

    entity.buildingBlueprintId = buildingBlueprintId;
    if (isTowerBuildingBlueprintId(buildingBlueprintId)) {
      entity.type = 'tower';
    }
    applyEntitySensorBlueprint(entity, getBuildingBlueprint(buildingBlueprintId));
    if (buildingBlueprintHasActiveState(buildingBlueprintId)) {
      ensureBuildingActiveState(entity);
    }

    return entity;
  }

  // Check if a building can be placed at world coordinates
  canPlaceAt(worldX: number, worldY: number, buildingBlueprintId: BuildingBlueprintId): boolean {
    const config = getBuildingConfig(buildingBlueprintId);
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    const gridX = Math.floor(snapped.x / BUILD_GRID_CELL_SIZE);
    const gridY = Math.floor(snapped.y / BUILD_GRID_CELL_SIZE);
    return getBuildingPlacementDiagnosticsForGrid(
      buildingBlueprintId,
      gridX,
      gridY,
      this.mapWidth,
      this.mapHeight,
      [],
      (gx, gy) => this.isCellOccupied(gx, gy),
      this.terrainBuildabilityGrid,
    ).canPlace;
  }

  // Handle building destruction
  onBuildingDestroyed(world: WorldState, entity: Entity): void {
    // Remove from grid
    this.buildingGrid.removeByEntityId(entity.id);

    removeCompletedBuildingEffects(world, entity);
  }

  // Assign a builder to a construction site
  assignBuilder(world: WorldState, builderId: EntityId, targetId: EntityId): boolean {
    const builder = world.getEntity(builderId);
    const target = world.getEntity(targetId);

    if (
      builder === undefined ||
      builder.builder === null ||
      target === undefined ||
      target.buildable === null
    ) {
      return false;
    }

    // Check if target is not complete
    if (target.buildable.isComplete) {
      return false;
    }

    if (!isBuildTargetInRange(builder, target)) {
      return false;
    }

    builder.builder.currentBuildTarget = targetId;
    world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
    return true;
  }

  // Get snap position for building placement
  getSnapPosition(worldX: number, worldY: number, buildingBlueprintId: BuildingBlueprintId): { x: number; y: number } {
    const config = getBuildingConfig(buildingBlueprintId);
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    return {
      x: snapped.x + (config.gridWidth * BUILD_GRID_CELL_SIZE) / 2,
      y: snapped.y + (config.gridHeight * BUILD_GRID_CELL_SIZE) / 2,
    };
  }
}
