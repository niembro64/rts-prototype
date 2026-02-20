import type { WorldState } from './WorldState';
import type { Entity, UnitAction } from './types';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import { COST_MULTIPLIER } from '../../config';

// Factory production result
export interface FactoryProductionResult {
  completedUnits: Entity[];
}

// Factory production system
export class FactoryProductionSystem {
  // Update all factories
  update(world: WorldState, _dtMs: number): FactoryProductionResult {
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

      // Get current build item (unit type ID)
      const currentUnitType = factoryComp.buildQueue[0];
      const bp = getUnitBlueprint(currentUnitType);

      if (!bp) {
        // Invalid unit, remove from queue
        factoryComp.buildQueue.shift();
        continue;
      }

      // Initialize production if not started
      if (!factoryComp.isProducing) {
        factoryComp.isProducing = true;
        factoryComp.currentBuildProgress = 0;
        factoryComp.currentBuildCost = bp.baseCost * COST_MULTIPLIER;
      }

      // Energy spending is handled by the shared energy distribution system.
      // Factory progress is advanced there; we just check for completion here.

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
        const unit = this.createUnit(world, factory, currentUnitType);
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

  // Create a completed unit from factory using blueprints
  private createUnit(world: WorldState, factory: Entity, unitType: string): Entity | null {
    if (!factory.ownership || !factory.factory) return null;

    const factoryComp = factory.factory;

    // Spawn position (center of factory)
    const spawnX = factory.transform.x;
    const spawnY = factory.transform.y;

    // Create unit from blueprint
    const unit = world.createUnitFromBlueprint(spawnX, spawnY, factory.ownership.playerId, unitType);

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

    // Aim turrets toward map center
    aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);

    // Add to world
    world.addEntity(unit);

    return unit;
  }

  // Add a unit to factory's build queue
  queueUnit(factory: Entity, unitTypeId: string): boolean {
    if (!factory.factory || !factory.buildable?.isComplete) {
      return false;
    }

    // Validate unit type exists in blueprints
    try {
      getUnitBlueprint(unitTypeId);
    } catch {
      return false;
    }

    factory.factory.buildQueue.push(unitTypeId);
    return true;
  }

  // Remove a unit from factory's build queue
  dequeueUnit(factory: Entity, index: number): boolean {
    if (!factory.factory) return false;

    if (index < 0 || index >= factory.factory.buildQueue.length) {
      return false;
    }

    factory.factory.buildQueue.splice(index, 1);

    // If we removed the first item (currently building), reset production
    if (index === 0) {
      factory.factory.currentBuildProgress = 0;
      factory.factory.isProducing = factory.factory.buildQueue.length > 0;
    }

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
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
