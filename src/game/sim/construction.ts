import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId, BuildingType } from './types';
import { magnitude } from '../math';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { BuildingGrid, GRID_CELL_SIZE } from './grid';

// Construction system - handles building progress and energy consumption
export class ConstructionSystem {
  private buildingGrid: BuildingGrid;

  // Reverse index: targetId → builders array, rebuilt once per tick
  private buildersByTarget: Map<EntityId, Entity[]> = new Map();

  constructor(mapWidth: number, mapHeight: number) {
    this.buildingGrid = new BuildingGrid(mapWidth, mapHeight);
  }

  // Get the building grid
  getGrid(): BuildingGrid {
    return this.buildingGrid;
  }

  // Update all construction in the world
  update(world: WorldState, _dtMs: number): void {

    // Build reverse index of builders → targets once per tick (O(n) instead of O(n²))
    this.buildersByTarget.clear();
    for (const entity of world.getAllEntities()) {
      const targetId = entity.builder?.currentBuildTarget;
      if (targetId == null) continue;
      let arr = this.buildersByTarget.get(targetId);
      if (!arr) {
        arr = [];
        this.buildersByTarget.set(targetId, arr);
      }
      arr.push(entity);
    }

    // Process all buildable entities
    for (const entity of world.getAllEntities()) {
      if (!entity.buildable || entity.buildable.isComplete || entity.buildable.isGhost) {
        continue;
      }

      const buildable = entity.buildable;
      const playerId = entity.ownership?.playerId;
      if (!playerId) continue;

      // Find all builders targeting this entity — O(1) lookup
      const builders = this.buildersByTarget.get(entity.id);
      if (!builders || builders.length === 0) continue;

      // Energy spending is handled by the shared energy distribution system.
      // Construction system just checks for completion here.

      // Check if complete
      if (buildable.buildProgress >= 1) {
        buildable.buildProgress = 1;
        buildable.isComplete = true;
        this.onConstructionComplete(world, entity);
      }
    }
  }

  // Called when construction completes
  private onConstructionComplete(_world: WorldState, entity: Entity): void {
    // Clear all builder targets for this entity using the reverse index (O(k) not O(n))
    const builders = this.buildersByTarget.get(entity.id);
    if (builders) {
      for (const builder of builders) {
        if (builder.builder) {
          builder.builder.currentBuildTarget = null;
        }
      }
    }

    // Handle building-specific completion
    if (entity.buildingType === 'solar' && entity.ownership) {
      const config = getBuildingConfig('solar');
      if (config.energyProduction) {
        economyManager.addProduction(entity.ownership.playerId, config.energyProduction);
      }
    }

    // Factory completion - set up rally point
    if (entity.buildingType === 'factory' && entity.factory) {
      // Rally point is set when factory is created
    }
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

    // Check if we can place
    if (!this.buildingGrid.canPlace(gridX, gridY, config.gridWidth, config.gridHeight)) {
      return null;
    }

    // Get world position for building center
    const worldPos = this.buildingGrid.getBuildingCenter(gridX, gridY, config.gridWidth, config.gridHeight);

    // Create the building entity
    const entity = world.createBuilding(
      worldPos.x,
      worldPos.y,
      config.gridWidth * GRID_CELL_SIZE,
      config.gridHeight * GRID_CELL_SIZE,
      playerId
    );

    // Add buildable component
    entity.buildable = {
      buildProgress: 0,
      energyCost: config.energyCost,
      isComplete: false,
      isGhost: false,
    };

    // Set building type
    entity.buildingType = buildingType;

    // Set max HP from config
    if (entity.building) {
      entity.building.hp = config.hp;
      entity.building.maxHp = config.hp;
    }

    // Add factory component if it's a factory
    if (buildingType === 'factory') {
      // Calculate rally point (50% toward map center)
      const mapCenterX = world.mapWidth / 2;
      const mapCenterY = world.mapHeight / 2;
      const rallyX = worldPos.x + (mapCenterX - worldPos.x) * 0.5;
      const rallyY = worldPos.y + (mapCenterY - worldPos.y) * 0.5;

      entity.factory = {
        buildQueue: [],
        currentBuildProgress: 0,
        currentBuildCost: 0,
        rallyX,
        rallyY,
        isProducing: false,
        waypoints: [{ x: rallyX, y: rallyY, type: 'move' }],
      };
    }

    // Register in grid
    this.buildingGrid.place(gridX, gridY, config.gridWidth, config.gridHeight, entity.id, playerId);

    // Add to world
    world.addEntity(entity);

    // Assign builder (only for non-commanders - commanders use their buildQueue instead)
    const builder = world.getEntity(builderId);
    if (builder?.builder && !builder.commander) {
      builder.builder.currentBuildTarget = entity.id;
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
      playerId
    );

    entity.buildable = {
      buildProgress: 0,
      energyCost: config.energyCost,
      isComplete: false,
      isGhost: true,
    };

    entity.buildingType = buildingType;

    return entity;
  }

  // Check if a building can be placed at world coordinates
  canPlaceAt(worldX: number, worldY: number, buildingType: BuildingType): boolean {
    const config = getBuildingConfig(buildingType);
    return this.buildingGrid.canPlaceAtWorld(worldX, worldY, config.gridWidth, config.gridHeight);
  }

  // Handle building destruction
  onBuildingDestroyed(entity: Entity): void {
    // Remove from grid
    this.buildingGrid.removeByEntityId(entity.id);

    // If it was a solar panel, remove production
    if (entity.buildingType === 'solar' && entity.ownership && entity.buildable?.isComplete) {
      const config = getBuildingConfig('solar');
      if (config.energyProduction) {
        economyManager.removeProduction(entity.ownership.playerId, config.energyProduction);
      }
    }
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

    // Check range
    const dx = target.transform.x - builder.transform.x;
    const dy = target.transform.y - builder.transform.y;
    const dist = magnitude(dx, dy);

    if (dist > builder.builder.buildRange) {
      return false;
    }

    builder.builder.currentBuildTarget = targetId;
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
