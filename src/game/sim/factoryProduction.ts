import type { WorldState } from './WorldState';
import type { Entity } from './types';
import type { BuildingGrid } from './buildGrid';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import { COST_MULTIPLIER } from '../../config';
import {
  expandMultiLegPathActions,
  pathTerrainFilterForLocomotion,
  type PathTerrainFilter,
} from './Pathfinder';
import { setUnitActions } from './unitActions';
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
  isEntityActive,
} from './buildableHelpers';
import {
  initializeConstructionPieceHealth,
  interruptConstructionPreservingBuiltPieces,
} from './constructionLifecycle';

export type { FactoryProductionResult } from '@/types/ui';
import type { FactoryProductionResult } from '@/types/ui';

function pathTerrainFilterForUnit(unit: Entity): PathTerrainFilter | null {
  return unit.unit === null
    ? null
    : pathTerrainFilterForLocomotion(unit.unit.locomotion);
}

// Factory production system
export class FactoryProductionSystem {
  // Update all factories. The factory's job is now (a) spawning a
  // shell of the selected repeat-build unit at its build spot when work
  // begins, and (b) detecting completion of the shell and finishing the
  // activation (static rally + turret aim). Resource transfer into the
  // shell is handled by energyDistribution, the same path that funds
  // buildings.
  update(world: WorldState, _dtMs: number, buildingGrid: BuildingGrid): FactoryProductionResult {
    const spawnedUnits: Entity[] = [];
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
          // Activation: stamp the static rally, aim turrets, mark dirty.
          // The selected blueprint is intentionally NOT cleared: repeat-
          // build mode keeps producing it until the player toggles it off.
          this.activateShell(world, factory, shell, buildingGrid);
          completedUnits.push(shell);
          factoryComp.currentShellId = null;
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        } else if (shell.buildable.isInterrupted) {
          factoryComp.currentShellId = null;
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        // Otherwise the shell is still filling — energyDistribution
        // pours resources into it; nothing to do here.
        continue;
      }

      // (2) No shell in progress — try to spawn the selected unit.
      const currentUnitBlueprintId = factoryComp.selectedUnitBlueprintId;
      if (currentUnitBlueprintId === null) {
        if (factoryComp.isProducing) {
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        continue;
      }
      let bp;
      try {
        bp = getUnitBlueprint(currentUnitBlueprintId);
      } catch {
        bp = undefined;
      }
      if (!bp) {
        // Invalid selection, drop it.
        factoryComp.selectedUnitBlueprintId = null;
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
      const shell = this.spawnUnitShell(world, factory, currentUnitBlueprintId);
      if (!shell) continue;
      factoryComp.currentShellId = shell.id;
      factoryComp.isProducing = true;
      factoryComp.currentBuildProgress = 0;
      spawnedUnits.push(shell);
      world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
    }

    return { spawnedUnits, completedUnits };
  }

  // Spawn an inert shell of `unitBlueprintId` at the factory's build spot.
  // The shell starts at 0/0/0 paid; energyDistribution fills it. The
  // unit is fully constructed (renderer-ready), but its active build
  // state suppresses combat/movement until each resource bar tops up.
  private spawnUnitShell(world: WorldState, factory: Entity, unitBlueprintId: string): Entity | null {
    if (!factory.ownership) return null;
    const bp = getUnitBlueprint(unitBlueprintId);
    const spawn = getFactoryBuildSpot(factory, bp.radius.collision, {
      mapWidth: world.mapWidth,
      mapHeight: world.mapHeight,
      clampRadius: null,
    });
    if (this.isBuildSpotBlocked(world, spawn.x, spawn.y, bp.radius.collision)) {
      return null;
    }
    const unit = world.createUnitFromBlueprint(spawn.x, spawn.y, factory.ownership.playerId, unitBlueprintId);
    unit.buildable = createBuildable({
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    });
    initializeConstructionPieceHealth(unit);
    world.addEntity(unit);
    return unit;
  }

  private isBuildSpotBlocked(world: WorldState, x: number, y: number, radius: number): boolean {
    for (const unit of world.getUnits()) {
      if (unit.unit === null) continue;
      const minDist = radius + unit.unit.radius.collision;
      const dx = unit.transform.x - x;
      const dy = unit.transform.y - y;
      if ((dx * dx) + (dy * dy) < minDist * minDist) return true;
    }

    for (const building of world.getBuildings()) {
      if (building.building === null || building.building.hp <= 0) continue;
      const minDist = radius + building.building.targetRadius;
      const dx = building.transform.x - x;
      const dy = building.transform.y - y;
      if ((dx * dx) + (dy * dy) < minDist * minDist) return true;
    }

    return false;
  }

  // Called when a unit shell completes. Stamps the static factory rally
  // onto the unit and aims the turret.
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
    if (unit.unit) {
      const { actions, patrolStartIndex } = expandMultiLegPathActions(
        spawnX, spawnY,
        [{
          x: factoryComp.rallyX,
          y: factoryComp.rallyY,
          z: factoryComp.rallyZ ?? undefined,
          type: factoryComp.rallyType,
        }],
        world.mapWidth, world.mapHeight, buildingGrid,
        pathTerrainFilterForUnit(unit),
      );
      setUnitActions(unit.unit, actions);
      if (patrolStartIndex !== null) {
        unit.unit.patrolStartIndex = patrolStartIndex;
      }
    }
    aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);
    world.markSnapshotDirty(unit.id, ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS);
  }

  // Toggle the factory's repeat-build selection. Selecting the
  // currently-building blueprint clears the selection and cancels the
  // in-progress shell; selecting a different type cancels the current
  // shell (refunding paid resources) and replaces the selection. The
  // production loop keeps selectedUnitBlueprintId until the player toggles
  // it off, so the selected type repeats forever.
  selectUnit(factory: Entity, unitBlueprintId: string, world: WorldState): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    try {
      getUnitBlueprint(unitBlueprintId);
    } catch {
      return false;
    }
    const factoryComp = factory.factory;
    const current = factoryComp.selectedUnitBlueprintId;
    if (current === unitBlueprintId) {
      // Toggle off — cancel active shell, clear selection.
      this.cancelActiveShell(world, factory);
      factoryComp.selectedUnitBlueprintId = null;
      factoryComp.isProducing = false;
    } else {
      // Replace — cancel any active shell of the previous type, then
      // swap the selection. The production loop spawns a fresh shell
      // of the new type next tick.
      this.cancelActiveShell(world, factory);
      factoryComp.selectedUnitBlueprintId = unitBlueprintId;
    }
    return true;
  }

  // Interrupt the in-progress shell. If construction has not produced
  // a paid live piece yet, remove it and refund the paid counters. Once
  // any piece is live, the shell stays in the world with exactly those
  // materialized pieces instead of being deleted by the factory.
  cancelActiveShell(world: WorldState, factory: Entity): void {
    const factoryComp = factory.factory!;
    const shellId = factoryComp.currentShellId;
    if (shellId === null) return;
    const shell = world.getEntity(shellId);
    if (shell !== undefined && shell.buildable !== null && shell.ownership !== null) {
      const interrupted = interruptConstructionPreservingBuiltPieces(world, shell);
      if (!interrupted.preserved) {
        economyManager.addStockpile(
          world,
          shell.ownership.playerId,
          interrupted.refund,
          factory.id,
          shell.id,
          'refund',
        );
        world.removeEntity(shellId);
      }
    }
    factoryComp.currentShellId = null;
    factoryComp.currentBuildProgress = 0;
  }
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
