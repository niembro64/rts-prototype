import type { WorldState } from './WorldState';
import type { Entity, UnitAction, UnitWeapon } from './types';
import { economyManager } from './economy';
import { getUnitBuildConfig, getBuildingConfig } from './buildConfigs';
import { createWeaponsFromDefinition } from './unitDefinitions';

// Factory production result
export interface FactoryProductionResult {
  completedUnits: Entity[];
}

// Factory production system
export class FactoryProductionSystem {
  // Update all factories
  update(world: WorldState, dtMs: number): FactoryProductionResult {
    const dtSec = dtMs / 1000;
    const completedUnits: Entity[] = [];

    for (const factory of world.getAllEntities()) {
      // Skip if not a factory or not complete
      if (!factory.factory || !factory.buildable?.isComplete) continue;
      if (!factory.ownership) continue;

      const factoryComp = factory.factory;
      const playerId = factory.ownership.playerId;

      // Check if we have something to build
      if (factoryComp.buildQueue.length === 0) {
        factoryComp.isProducing = false;
        continue;
      }

      // Get current build item
      const currentWeaponId = factoryComp.buildQueue[0];
      const unitConfig = getUnitBuildConfig(currentWeaponId);

      if (!unitConfig) {
        // Invalid unit, remove from queue
        factoryComp.buildQueue.shift();
        continue;
      }

      // Initialize production if not started
      if (!factoryComp.isProducing) {
        factoryComp.isProducing = true;
        factoryComp.currentBuildProgress = 0;
        factoryComp.currentBuildCost = unitConfig.energyCost;
        factoryComp.currentBuildRate = unitConfig.maxBuildRate;
      }

      // Get factory's max build rate from config
      const factoryConfig = getBuildingConfig('factory');
      const factoryMaxRate = factoryConfig.unitBuildRate ?? 20;

      // Effective build rate is minimum of unit's max rate and factory's max rate
      const effectiveBuildRate = Math.min(factoryComp.currentBuildRate, factoryMaxRate);

      // Calculate energy needed this tick
      const energyNeeded = effectiveBuildRate * dtSec;

      // Try to spend energy
      const energySpent = economyManager.trySpendEnergy(playerId, energyNeeded);
      economyManager.recordExpenditure(playerId, energySpent / dtSec);

      // Calculate progress
      const progressGained = energySpent / factoryComp.currentBuildCost;
      factoryComp.currentBuildProgress += progressGained;

      // Check if unit is complete
      if (factoryComp.currentBuildProgress >= 1) {
        // Check unit cap before creating
        if (!world.canPlayerBuildUnit(playerId)) {
          // At unit cap - pause production (don't remove from queue)
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 1; // Keep at 100% ready
          continue;
        }

        // Create the unit
        const unit = this.createUnit(world, factory, unitConfig);
        if (unit) {
          completedUnits.push(unit);
        }

        // Remove from queue
        factoryComp.buildQueue.shift();
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
      }
    }

    return { completedUnits };
  }

  // Create a completed unit from factory
  private createUnit(world: WorldState, factory: Entity, config: ReturnType<typeof getUnitBuildConfig>): Entity | null {
    if (!factory.ownership || !factory.factory || !config) return null;

    const playerId = factory.ownership.playerId;
    const factoryComp = factory.factory;

    // Spawn position (center of factory)
    const spawnX = factory.transform.x;
    const spawnY = factory.transform.y;

    // Create base unit entity (weapons will be set below)
    const unit = world.createUnitBase(
      spawnX,
      spawnY,
      playerId,
      config.collisionRadius,
      config.moveSpeed,
      config.hp
    );

    // Create weapons for this unit type - all units go through the same path
    unit.weapons = this.createWeaponsForUnit(config);

    // Copy factory's waypoints to the new unit as actions
    if (unit.unit && factoryComp.waypoints.length > 0) {
      // Convert waypoints to actions
      unit.unit.actions = factoryComp.waypoints.map(wp => ({
        type: wp.type,  // WaypointType maps directly to ActionType
        x: wp.x,
        y: wp.y,
      } as UnitAction));

      // Find first patrol action to set patrolStartIndex
      const firstPatrolIndex = factoryComp.waypoints.findIndex(wp => wp.type === 'patrol');
      if (firstPatrolIndex !== -1) {
        unit.unit.patrolStartIndex = firstPatrolIndex;
      }
    }

    // Add to world
    world.addEntity(unit);

    return unit;
  }

  // Add a unit to factory's build queue
  queueUnit(factory: Entity, weaponId: string): boolean {
    if (!factory.factory || !factory.buildable?.isComplete) {
      return false;
    }

    const config = getUnitBuildConfig(weaponId);
    if (!config) {
      return false;
    }

    factory.factory.buildQueue.push(weaponId);
    return true;
  }

  // Remove a unit from factory's build queue
  dequeueUnit(factory: Entity, index: number): boolean {
    if (!factory.factory) return false;

    if (index < 0 || index >= factory.factory.buildQueue.length) {
      return false;
    }

    // Can't remove currently building item (index 0) if in progress
    if (index === 0 && factory.factory.isProducing) {
      return false;
    }

    factory.factory.buildQueue.splice(index, 1);
    return true;
  }

  // Cancel current production (loses progress)
  cancelCurrent(factory: Entity): boolean {
    if (!factory.factory || !factory.factory.isProducing) {
      return false;
    }

    factory.factory.buildQueue.shift();
    factory.factory.isProducing = false;
    factory.factory.currentBuildProgress = 0;
    return true;
  }

  // Get build queue for display
  getBuildQueue(factory: Entity): { weaponId: string; progress: number }[] {
    if (!factory.factory) return [];

    return factory.factory.buildQueue.map((weaponId, index) => ({
      weaponId,
      progress: index === 0 && factory.factory!.isProducing
        ? factory.factory!.currentBuildProgress
        : 0,
    }));
  }

  // Create weapons array for any unit type - uses centralized unit definitions
  private createWeaponsForUnit(config: ReturnType<typeof getUnitBuildConfig>): UnitWeapon[] {
    if (!config) return [];
    return createWeaponsFromDefinition(config.weaponId, config.collisionRadius);
  }
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
