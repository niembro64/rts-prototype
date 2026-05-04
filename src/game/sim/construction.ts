import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId, BuildingType } from './types';
import { getBuildingConfig } from './buildConfigs';
import { BuildingGrid, GRID_CELL_SIZE } from './grid';
import { computeFactoryWaypoint } from './spawn';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { ENTITY_CHANGED_ACTIONS } from '../../types/network';
import { ensureSolarCollectorState } from './solarCollector';
import { removeCompletedBuildingEffects } from './buildingCompletion';
import { isBuildTargetInRange } from './builderRange';
import { createBuildable, getInitialBuildHp } from './buildableHelpers';

// Construction system - authoritative building placement and footprint grid.
// Runtime resource/HP/completion semantics live in constructionLifecycle.ts.
export class ConstructionSystem {
  private buildingGrid: BuildingGrid;
  private readonly mapWidth: number;
  private readonly mapHeight: number;

  constructor(mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.buildingGrid = new BuildingGrid(mapWidth, mapHeight);
  }

  // Get the building grid
  getGrid(): BuildingGrid {
    return this.buildingGrid;
  }


  // Start a new building construction
  startBuilding(
    world: WorldState,
    buildingType: BuildingType,
    gridX: number,
    gridY: number,
    playerId: PlayerId,
    builderId: EntityId
  ): Entity | null {
    const config = getBuildingConfig(buildingType);

    const diagnostics = getBuildingPlacementDiagnosticsForGrid(
      buildingType,
      gridX,
      gridY,
      world.mapWidth,
      world.mapHeight,
      world.metalDeposits,
      (gx, gy) => this.buildingGrid.getCell(gx, gy)?.occupied === true,
    );
    if (!diagnostics.canPlace) {
      return null;
    }

    // Get world position for building center
    const worldPos = { x: diagnostics.x, y: diagnostics.y };

    // Extractors can be placed ANYWHERE that satisfies the normal
    // building placement rules — there's no longer a "must overlap
    // a deposit" gate. Production is BINARY per deposit: when the
    // extractor finishes building, applyCompletedBuildingEffects
    // tries to claim every deposit its footprint overlaps. Each
    // deposit can be owned by at most one extractor at a time, so
    // a second extractor on the same deposit just sits inert until
    // the first is destroyed (then it inherits ownership). No
    // production / claim work happens at startBuilding — those
    // fields stay zero / empty until completion.

    const physicalSize = {
      width: config.gridWidth * GRID_CELL_SIZE,
      height: config.gridHeight * GRID_CELL_SIZE,
      depth: config.gridDepth * GRID_CELL_SIZE,
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

    // Set building type
    entity.buildingType = buildingType;
    if (buildingType === 'solar') {
      ensureSolarCollectorState(entity);
    }
    if (buildingType === 'extractor') {
      // Inactive at construction start. The completion handler runs
      // claimDepositsForExtractor, which fills `ownedDepositIds` and
      // sets `metalExtractionRate` based on which deposits are still
      // free at that moment.
      entity.ownedDepositIds = [];
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
    if (buildingType === 'factory') {
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
        manaRateFraction: 0,
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
    if (builder?.builder && !builder.commander) {
      builder.builder.currentBuildTarget = entity.id;
      world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
    }

    return entity;
  }

  // Create a ghost preview for building placement
  createGhost(
    world: WorldState,
    buildingType: BuildingType,
    worldX: number,
    worldY: number,
    playerId: PlayerId
  ): Entity {
    const config = getBuildingConfig(buildingType);

    // Snap to grid
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    const centerX = snapped.x + (config.gridWidth * GRID_CELL_SIZE) / 2;
    const centerY = snapped.y + (config.gridHeight * GRID_CELL_SIZE) / 2;

    // Create ghost entity
    const entity = world.createBuilding(
      centerX,
      centerY,
      config.gridWidth * GRID_CELL_SIZE,
      config.gridHeight * GRID_CELL_SIZE,
      config.gridDepth * GRID_CELL_SIZE,
      playerId
    );

    entity.buildable = createBuildable(config.cost, { isGhost: true });

    entity.buildingType = buildingType;
    if (buildingType === 'solar') {
      ensureSolarCollectorState(entity);
    }

    return entity;
  }

  // Check if a building can be placed at world coordinates
  canPlaceAt(worldX: number, worldY: number, buildingType: BuildingType): boolean {
    const config = getBuildingConfig(buildingType);
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    const gridX = Math.floor(snapped.x / GRID_CELL_SIZE);
    const gridY = Math.floor(snapped.y / GRID_CELL_SIZE);
    return getBuildingPlacementDiagnosticsForGrid(
      buildingType,
      gridX,
      gridY,
      this.mapWidth,
      this.mapHeight,
      [],
      (gx, gy) => this.buildingGrid.getCell(gx, gy)?.occupied === true,
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

    if (!builder?.builder || !target?.buildable) {
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
  getSnapPosition(worldX: number, worldY: number, buildingType: BuildingType): { x: number; y: number } {
    const config = getBuildingConfig(buildingType);
    const snapped = this.buildingGrid.snapToGrid(worldX, worldY, config.gridWidth, config.gridHeight);
    return {
      x: snapped.x + (config.gridWidth * GRID_CELL_SIZE) / 2,
      y: snapped.y + (config.gridHeight * GRID_CELL_SIZE) / 2,
    };
  }
}
