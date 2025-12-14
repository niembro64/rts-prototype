import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId, BuildingType } from './types';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { BuildingGrid, GRID_CELL_SIZE } from './grid';

// Construction system - handles building progress and energy consumption
export class ConstructionSystem {
  private buildingGrid: BuildingGrid;

  constructor(mapWidth: number, mapHeight: number) {
    this.buildingGrid = new BuildingGrid(mapWidth, mapHeight);
  }

  // Get the building grid
  getGrid(): BuildingGrid {
    return this.buildingGrid;
  }

  // Update all construction in the world
  update(world: WorldState, dtMs: number): void {
    const dtSec = dtMs / 1000;

    // Process all buildable entities
    for (const entity of world.getAllEntities()) {
      if (!entity.buildable || entity.buildable.isComplete || entity.buildable.isGhost) {
        continue;
      }

      const buildable = entity.buildable;
      const playerId = entity.ownership?.playerId;
      if (!playerId) continue;

      // Find all builders targeting this entity
      const builders = this.findBuildersFor(world, entity.id);
      if (builders.length === 0) continue;

      // Calculate total build rate from all builders
      let totalBuildRate = 0;
      for (const builder of builders) {
        if (builder.builder) {
          totalBuildRate += builder.builder.buildRate;
        }
      }

      // Cap at the entity's max build rate
      const effectiveBuildRate = Math.min(totalBuildRate, buildable.maxBuildRate);

      // Calculate energy needed this tick
      const energyNeeded = effectiveBuildRate * dtSec;

      // Try to spend energy
      const energySpent = economyManager.trySpendEnergy(playerId, energyNeeded);
      economyManager.recordExpenditure(playerId, energySpent / dtSec); // Record as rate

      // Calculate progress from energy spent
      const progressGained = energySpent / buildable.energyCost;
      buildable.buildProgress += progressGained;

      // Check if complete
      if (buildable.buildProgress >= 1) {
        buildable.buildProgress = 1;
        buildable.isComplete = true;
        this.onConstructionComplete(world, entity);
      }
    }
  }

  // Find all builders targeting an entity
  private findBuildersFor(world: WorldState, targetId: EntityId): Entity[] {
    const builders: Entity[] = [];
    for (const entity of world.getAllEntities()) {
      if (entity.builder?.currentBuildTarget === targetId) {
        builders.push(entity);
      }
    }
    return builders;
  }

  // Called when construction completes
  private onConstructionComplete(world: WorldState, entity: Entity): void {
    // Clear all builder targets for this entity
    for (const builder of world.getAllEntities()) {
      if (builder.builder?.currentBuildTarget === entity.id) {
        builder.builder.currentBuildTarget = null;
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
      maxBuildRate: config.maxBuildRate,
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
      // Calculate rally point (10% toward map center)
      const mapCenterX = world.mapWidth / 2;
      const mapCenterY = world.mapHeight / 2;
      const rallyX = worldPos.x + (mapCenterX - worldPos.x) * 0.1;
      const rallyY = worldPos.y + (mapCenterY - worldPos.y) * 0.1;

      entity.factory = {
        buildQueue: [],
        currentBuildProgress: 0,
        currentBuildCost: 0,
        currentBuildRate: 0,
        rallyX,
        rallyY,
        isProducing: false,
      };
    }

    // Register in grid
    this.buildingGrid.place(gridX, gridY, config.gridWidth, config.gridHeight, entity.id, playerId);

    // Add to world
    world.addEntity(entity);

    // Assign builder
    const builder = world.getEntity(builderId);
    if (builder?.builder) {
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
      maxBuildRate: config.maxBuildRate,
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
    const dist = Math.sqrt(dx * dx + dy * dy);

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
