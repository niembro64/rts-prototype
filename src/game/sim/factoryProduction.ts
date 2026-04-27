import type { WorldState } from './WorldState';
import type { Entity, UnitAction } from './types';
import type { BuildingGrid } from './grid';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import { COST_MULTIPLIER } from '../../config';
import { expandPathActions } from './Pathfinder';

export type { FactoryProductionResult } from '@/types/ui';
import type { FactoryProductionResult } from '@/types/ui';

// Factory production system
export class FactoryProductionSystem {
  // Update all factories. Iterates getBuildings() instead of
  // getAllEntities() — factories only exist on buildings, never on
  // units or projectiles, so the smaller cached subset filters out
  // 80%+ of irrelevant entities every tick.
  update(world: WorldState, _dtMs: number, buildingGrid: BuildingGrid): FactoryProductionResult {
    const completedUnits: Entity[] = [];

    for (const factory of world.getBuildings()) {
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
        factoryComp.currentBuildCost = bp.energyCost * COST_MULTIPLIER;
        factoryComp.currentBuildManaCost = bp.manaCost * COST_MULTIPLIER;
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
        const unit = this.createUnit(world, factory, currentUnitType, buildingGrid);
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
  private createUnit(
    world: WorldState, factory: Entity, unitType: string,
    buildingGrid: BuildingGrid,
  ): Entity | null {
    if (!factory.ownership || !factory.factory) return null;

    const factoryComp = factory.factory;

    // Spawn position (center of factory)
    const spawnX = factory.transform.x;
    const spawnY = factory.transform.y;

    // Create unit from blueprint
    const unit = world.createUnitFromBlueprint(spawnX, spawnY, factory.ownership.playerId, unitType);

    // Copy factory's waypoints to the new unit, but with each leg
    // expanded into a multi-waypoint path that routes around water /
    // mountains / building lines. Anchor for the first leg is the
    // factory's spawn position; each successive leg's anchor is the
    // previous waypoint (so the unit's intent stays "go from W[i] to
    // W[i+1]" but the path it takes between them avoids obstacles).
    if (unit.unit && factoryComp.waypoints.length > 0) {
      const actions: UnitAction[] = [];
      let anchorX = spawnX;
      let anchorY = spawnY;
      // Patrol-loop start needs to point at the first action that
      // came from a patrol-typed factory waypoint, even though each
      // factory waypoint may now expand to multiple actions.
      let patrolStartActionIndex = -1;
      for (let w = 0; w < factoryComp.waypoints.length; w++) {
        const wp = factoryComp.waypoints[w];
        const leg = expandPathActions(
          anchorX, anchorY, wp.x, wp.y, wp.type,
          world.mapWidth, world.mapHeight, buildingGrid,
        );
        if (wp.type === 'patrol' && patrolStartActionIndex === -1) {
          patrolStartActionIndex = actions.length;
        }
        for (let i = 0; i < leg.length; i++) actions.push(leg[i]);
        anchorX = wp.x;
        anchorY = wp.y;
      }
      unit.unit.actions = actions;
      if (patrolStartActionIndex !== -1) {
        unit.unit.patrolStartIndex = patrolStartActionIndex;
      }
    }

    // Aim turrets toward map center
    aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);

    // Add to world
    world.addEntity(unit);

    return unit;
  }

  // Add a unit to factory's build queue (cap-checked externally via canPlayerQueueUnit)
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
  getBuildQueue(factory: Entity): { unitId: string; progress: number }[] {
    if (!factory.factory) return [];

    return factory.factory.buildQueue.map((unitId, index) => ({
      unitId,
      progress: index === 0 && factory.factory!.isProducing
        ? factory.factory!.currentBuildProgress
        : 0,
    }));
  }
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
