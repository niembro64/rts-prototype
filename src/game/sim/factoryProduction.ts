import type { WorldState } from './WorldState';
import type { Entity, UnitAction } from './types';
import type { BuildingGrid } from './grid';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import { COST_MULTIPLIER } from '../../config';
import { expandPathActions } from './Pathfinder';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_TURRETS,
} from '../../types/network';
import { getFactoryBuildSpot } from './factoryConstructionSite';
import { economyManager } from './economy';
import {
  createBuildable,
  getBuildFraction,
  getInitialBuildHp,
  isEntityActive,
} from './buildableHelpers';

export type { FactoryProductionResult } from '@/types/ui';
import type { FactoryProductionResult } from '@/types/ui';

// Factory production system
export class FactoryProductionSystem {
  // Update all factories. The factory's job is now (a) spawning a
  // shell of the queued unit at its build spot when work begins, and
  // (b) detecting completion of the shell and finishing the activation
  // (waypoints + turret aim). Resource transfer into the shell is
  // handled by energyDistribution, the same path that funds buildings.
  update(world: WorldState, _dtMs: number, buildingGrid: BuildingGrid): FactoryProductionResult {
    const completedUnits: Entity[] = [];

    for (const factory of world.getFactoryBuildings()) {
      // Factory itself must be complete and owned.
      if (!factory.factory || !isEntityActive(factory)) continue;
      if (!factory.ownership) continue;

      const factoryComp = factory.factory;
      const playerId = factory.ownership.playerId;

      // (1) If we already have a shell in progress, check if it's done.
      if (factoryComp.currentShellId !== null) {
        const shell = world.getEntity(factoryComp.currentShellId);
        if (!shell) {
          // Shell vanished (destroyed mid-build). Reset and try next tick.
          factoryComp.currentShellId = null;
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
          continue;
        }
        factoryComp.currentBuildProgress = shell.buildable ? getBuildFraction(shell.buildable) : 1;
        if (!shell.buildable || shell.buildable.isComplete) {
          // Activation: copy waypoints, aim turrets, mark dirty.
          // The queue head is intentionally NOT popped — repeat-build
          // mode keeps the selected unit type until the player toggles
          // it off, so the next tick will spawn another shell from
          // queue[0].
          this.activateShell(world, factory, shell, buildingGrid);
          completedUnits.push(shell);
          factoryComp.currentShellId = null;
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        // Otherwise the shell is still filling — energyDistribution
        // pours resources into it; nothing to do here.
        continue;
      }

      // (2) No shell in progress — try to spawn the head of the queue.
      if (factoryComp.buildQueue.length === 0) {
        if (factoryComp.isProducing) {
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        continue;
      }
      const currentUnitType = factoryComp.buildQueue[0];
      let bp;
      try {
        bp = getUnitBlueprint(currentUnitType);
      } catch {
        bp = undefined;
      }
      if (!bp) {
        // Invalid unit, drop it.
        factoryComp.buildQueue.shift();
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        continue;
      }
      // Honour the unit cap at SHELL SPAWN time — once a shell is in
      // the world it counts toward the cap.
      if (!world.canPlayerBuildUnit(playerId)) {
        if (factoryComp.isProducing) {
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        continue;
      }
      const shell = this.spawnUnitShell(world, factory, currentUnitType);
      if (!shell) continue;
      factoryComp.currentShellId = shell.id;
      factoryComp.isProducing = true;
      factoryComp.currentBuildProgress = 0;
      world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
    }

    return { completedUnits };
  }

  // Spawn an inert shell of `unitType` at the factory's build spot.
  // The shell starts at 0/0/0 paid; energyDistribution fills it. The
  // unit is fully constructed (renderer-ready), but its
  // buildable.isComplete=false flag suppresses combat/movement until
  // each resource bar tops up.
  private spawnUnitShell(world: WorldState, factory: Entity, unitType: string): Entity | null {
    if (!factory.ownership) return null;
    const bp = getUnitBlueprint(unitType);
    const spawn = getFactoryBuildSpot(factory, bp.radius.push, {
      mapWidth: world.mapWidth,
      mapHeight: world.mapHeight,
    });
    const unit = world.createUnitFromBlueprint(spawn.x, spawn.y, factory.ownership.playerId, unitType);
    unit.buildable = createBuildable({
      energy: bp.cost.energy * COST_MULTIPLIER,
      mana: bp.cost.mana * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    });
    // Start the shell barely alive — it grows toward maxHp as the avg
    // fill ratio climbs. Using 1 HP instead of 0 lets enemies damage
    // / kill the shell and prevents the safety cleanup from treating a
    // brand-new shell as already dead before its first resource tick.
    if (unit.unit) {
      unit.unit.hp = getInitialBuildHp(unit.unit.maxHp);
    }
    world.addEntity(unit);
    return unit;
  }

  // Called when a unit shell completes. Stamps the rally waypoints
  // onto the unit (expanded into pathfinder legs) and aims the turret.
  private activateShell(
    world: WorldState,
    factory: Entity,
    unit: Entity,
    buildingGrid: BuildingGrid,
  ): void {
    if (!factory.factory) return;
    const factoryComp = factory.factory;
    const spawnX = unit.transform.x;
    const spawnY = unit.transform.y;
    if (unit.unit && factoryComp.waypoints.length > 0) {
      const actions: UnitAction[] = [];
      let anchorX = spawnX;
      let anchorY = spawnY;
      let patrolStartActionIndex = -1;
      for (let w = 0; w < factoryComp.waypoints.length; w++) {
        const wp = factoryComp.waypoints[w];
        const leg = expandPathActions(
          anchorX, anchorY, wp.x, wp.y, wp.type,
          world.mapWidth, world.mapHeight, buildingGrid,
          wp.z,
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
    aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);
    world.markSnapshotDirty(unit.id, ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS);
  }

  // Toggle the factory's repeat-build selection. Selecting the
  // currently-building type clears the selection and cancels the
  // in-progress shell; selecting a different type cancels the current
  // shell (refunding paid resources) and replaces the selection. The
  // production loop never pops queue[0], so the selected type is rebuilt
  // forever until the player toggles it off.
  selectUnit(factory: Entity, unitTypeId: string, world: WorldState): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    try {
      getUnitBlueprint(unitTypeId);
    } catch {
      return false;
    }
    const factoryComp = factory.factory;
    const current = factoryComp.buildQueue[0] ?? null;
    if (current === unitTypeId) {
      // Toggle off — cancel active shell, clear selection.
      this.cancelActiveShell(world, factory);
      factoryComp.buildQueue.length = 0;
      factoryComp.isProducing = false;
    } else {
      // Replace — cancel any active shell of the previous type, then
      // swap the selection. The production loop spawns a fresh shell
      // of the new type next tick.
      this.cancelActiveShell(world, factory);
      factoryComp.buildQueue.length = 0;
      factoryComp.buildQueue.push(unitTypeId);
    }
    return true;
  }

  // Remove a unit from factory's build queue. Removing the head
  // (index 0) when a shell is already spawned destroys the shell and
  // refunds the resources already paid into it.
  dequeueUnit(factory: Entity, index: number, world?: WorldState): boolean {
    if (!factory.factory) return false;
    const factoryComp = factory.factory;
    if (index < 0 || index >= factoryComp.buildQueue.length) {
      return false;
    }
    if (index === 0 && factoryComp.currentShellId !== null && world) {
      this.cancelCurrentShell(world, factory);
    }
    factoryComp.buildQueue.splice(index, 1);
    if (index === 0) {
      factoryComp.isProducing = factoryComp.buildQueue.length > 0;
      if (!factoryComp.isProducing) factoryComp.currentBuildProgress = 0;
    }
    return true;
  }

  // Cancel current production (destroys the shell, refunds paid).
  cancelCurrent(factory: Entity, world?: WorldState): boolean {
    if (!factory.factory || !factory.factory.isProducing) return false;
    if (factory.factory.currentShellId !== null && world) {
      this.cancelCurrentShell(world, factory);
    }
    factory.factory.buildQueue.shift();
    factory.factory.isProducing = false;
    factory.factory.currentShellId = null;
    factory.factory.currentBuildProgress = 0;
    return true;
  }

  // Tear down the in-progress shell and refund 100% of paid resources
  // back to the player's stockpiles. Used by queue cancellation and
  // factory destruction so shell cleanup has a single owner.
  cancelActiveShell(world: WorldState, factory: Entity): void {
    const factoryComp = factory.factory!;
    const shellId = factoryComp.currentShellId;
    if (shellId === null) return;
    const shell = world.getEntity(shellId);
    if (shell?.buildable && shell.ownership) {
      const economy = economyManager.getEconomy(shell.ownership.playerId);
      if (economy) {
        economy.stockpile.curr = Math.min(
          economy.stockpile.max,
          economy.stockpile.curr + shell.buildable.paid.energy,
        );
        economy.mana.stockpile.curr = Math.min(
          economy.mana.stockpile.max,
          economy.mana.stockpile.curr + shell.buildable.paid.mana,
        );
        economy.metal.stockpile.curr = Math.min(
          economy.metal.stockpile.max,
          economy.metal.stockpile.curr + shell.buildable.paid.metal,
        );
      }
      world.removeEntity(shellId);
    }
    factoryComp.currentShellId = null;
    factoryComp.currentBuildProgress = 0;
  }

  private cancelCurrentShell(world: WorldState, factory: Entity): void {
    this.cancelActiveShell(world, factory);
  }

  // Get build queue for display. The head's progress comes from the
  // shell entity (avg of the three resource bars).
  getBuildQueue(factory: Entity, world?: WorldState): { unitId: string; progress: number }[] {
    if (!factory.factory) return [];
    return factory.factory.buildQueue.map((unitId, index) => {
      if (index !== 0 || factory.factory!.currentShellId === null || !world) {
        return { unitId, progress: 0 };
      }
      const shell = world.getEntity(factory.factory!.currentShellId);
      const progress = shell?.buildable ? getBuildFraction(shell.buildable) : 0;
      return { unitId, progress };
    });
  }
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
