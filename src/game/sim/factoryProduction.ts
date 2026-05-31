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
  isEntityActive,
} from './buildableHelpers';
import {
  initializeConstructionPieceHealth,
  interruptConstructionPreservingBuiltPieces,
} from './constructionLifecycle';
import { getSimWasm } from '../sim-wasm/init';

export type { FactoryProductionResult } from '@/types/ui';
import type { FactoryProductionResult } from '@/types/ui';

let buildSpotObstacleX = new Float64Array(64);
let buildSpotObstacleY = new Float64Array(64);
let buildSpotObstacleRadius = new Float64Array(64);

const FACTORY_SELECTED_NONE = 0;
const FACTORY_SELECTED_VALID = 1;
const FACTORY_SELECTED_INVALID = 2;
const FACTORY_ACTION_NONE = 0;
const FACTORY_ACTION_RESET_SHELL = 1;
const FACTORY_ACTION_COMPLETE_SHELL = 2;
const FACTORY_ACTION_CLEAR_INVALID_SELECTION = 3;
const FACTORY_ACTION_STOP_PRODUCING = 4;
const FACTORY_ACTION_SPAWN_SHELL = 5;

let factoryRows: Entity[] = [];
let factoryRowShells: Array<Entity | null> = [];
let factoryRowSelectedUnitBlueprintIds: Array<string | null> = [];
let factoryHasShell = new Uint8Array(16);
let factoryShellExists = new Uint8Array(16);
let factoryShellHasBuildable = new Uint8Array(16);
let factoryShellBuildableComplete = new Uint8Array(16);
let factoryShellInterrupted = new Uint8Array(16);
let factoryShellPaidEnergy = new Float64Array(16);
let factoryShellPaidMetal = new Float64Array(16);
let factoryShellRequiredEnergy = new Float64Array(16);
let factoryShellRequiredMetal = new Float64Array(16);
let factorySelectedState = new Uint8Array(16);
let factoryCanBuildUnit = new Uint8Array(16);
let factoryIsProducing = new Uint8Array(16);
let factoryAction = new Uint8Array(16);
let factoryProgress = new Float64Array(16);

function ensureBuildSpotObstacleCapacity(required: number): void {
  if (required <= buildSpotObstacleX.length) return;
  let next = buildSpotObstacleX.length;
  while (next < required) next *= 2;
  buildSpotObstacleX = new Float64Array(next);
  buildSpotObstacleY = new Float64Array(next);
  buildSpotObstacleRadius = new Float64Array(next);
}

function ensureFactoryProductionCapacity(required: number): void {
  if (required <= factoryHasShell.length) return;
  let next = factoryHasShell.length;
  while (next < required) next *= 2;

  factoryHasShell = new Uint8Array(next);
  factoryShellExists = new Uint8Array(next);
  factoryShellHasBuildable = new Uint8Array(next);
  factoryShellBuildableComplete = new Uint8Array(next);
  factoryShellInterrupted = new Uint8Array(next);
  factoryShellPaidEnergy = new Float64Array(next);
  factoryShellPaidMetal = new Float64Array(next);
  factoryShellRequiredEnergy = new Float64Array(next);
  factoryShellRequiredMetal = new Float64Array(next);
  factorySelectedState = new Uint8Array(next);
  factoryCanBuildUnit = new Uint8Array(next);
  factoryIsProducing = new Uint8Array(next);
  factoryAction = new Uint8Array(next);
  factoryProgress = new Float64Array(next);
}

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
    const factories = world.getFactoryBuildings();
    ensureFactoryProductionCapacity(factories.length);
    factoryRows.length = 0;
    factoryRowShells.length = 0;
    factoryRowSelectedUnitBlueprintIds.length = 0;

    for (const factory of factories) {
      // Factory itself must be complete and owned.
      if (!factory.factory || !isEntityActive(factory)) continue;
      if (!factory.ownership) continue;

      const factoryComp = factory.factory;
      const playerId = factory.ownership.playerId;
      const row = factoryRows.length;
      factoryRows.push(factory);

      factoryHasShell[row] = factoryComp.currentShellId !== null ? 1 : 0;
      factoryShellExists[row] = 0;
      factoryShellHasBuildable[row] = 0;
      factoryShellBuildableComplete[row] = 0;
      factoryShellInterrupted[row] = 0;
      factoryShellPaidEnergy[row] = 0;
      factoryShellPaidMetal[row] = 0;
      factoryShellRequiredEnergy[row] = 0;
      factoryShellRequiredMetal[row] = 0;
      factorySelectedState[row] = FACTORY_SELECTED_NONE;
      factoryCanBuildUnit[row] = 0;
      factoryIsProducing[row] = factoryComp.isProducing ? 1 : 0;

      let shell: Entity | null = null;
      if (factoryComp.currentShellId !== null) {
        shell = world.getEntity(factoryComp.currentShellId) ?? null;
        if (shell !== null) {
          factoryShellExists[row] = 1;
          const buildable = shell.buildable;
          if (buildable !== null) {
            factoryShellHasBuildable[row] = 1;
            factoryShellBuildableComplete[row] = buildable.isComplete ? 1 : 0;
            factoryShellInterrupted[row] = buildable.isInterrupted ? 1 : 0;
            factoryShellPaidEnergy[row] = buildable.paid.energy;
            factoryShellPaidMetal[row] = buildable.paid.metal;
            factoryShellRequiredEnergy[row] = buildable.required.energy;
            factoryShellRequiredMetal[row] = buildable.required.metal;
          }
        }
      } else {
        const selectedUnitBlueprintId = factoryComp.selectedUnitBlueprintId;
        if (selectedUnitBlueprintId === null) {
          factorySelectedState[row] = FACTORY_SELECTED_NONE;
        } else {
          try {
            getUnitBlueprint(selectedUnitBlueprintId);
            factorySelectedState[row] = FACTORY_SELECTED_VALID;
            // Honour the unit cap at SHELL SPAWN time — once a shell is in
            // the world it counts toward the cap.
            factoryCanBuildUnit[row] = world.canPlayerBuildUnit(playerId) ? 1 : 0;
          } catch {
            factorySelectedState[row] = FACTORY_SELECTED_INVALID;
          }
        }
      }
      factoryRowShells[row] = shell;
      factoryRowSelectedUnitBlueprintIds[row] = factoryComp.selectedUnitBlueprintId;
    }

    const count = factoryRows.length;
    if (count <= 0) return { spawnedUnits, completedUnits };

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('FactoryProductionSystem.update: sim-wasm is not initialized');
    }
    if (sim.factoryPlanProductionActions(
      factoryHasShell,
      factoryShellExists,
      factoryShellHasBuildable,
      factoryShellBuildableComplete,
      factoryShellInterrupted,
      factoryShellPaidEnergy,
      factoryShellPaidMetal,
      factoryShellRequiredEnergy,
      factoryShellRequiredMetal,
      factorySelectedState,
      factoryCanBuildUnit,
      factoryIsProducing,
      count,
      factoryAction,
      factoryProgress,
    ) === 0) {
      throw new Error('FactoryProductionSystem.update: factory_plan_production_actions rejected its buffers');
    }

    for (let row = 0; row < count; row++) {
      const factory = factoryRows[row];
      const factoryComp = factory.factory!;
      const action = factoryAction[row];
      if (factoryHasShell[row] !== 0 && action === FACTORY_ACTION_NONE) {
        factoryComp.currentBuildProgress = factoryProgress[row];
      }

      if (action === FACTORY_ACTION_RESET_SHELL) {
        factoryComp.currentShellId = null;
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_COMPLETE_SHELL) {
        const shell = factoryRowShells[row];
        if (shell !== null) {
          // Activation: stamp the static rally, aim turrets, mark dirty.
          // The selected blueprint is intentionally NOT cleared: repeat-
          // build mode keeps producing it until the player toggles it off.
          this.activateShell(world, factory, shell, buildingGrid);
          completedUnits.push(shell);
        }
        factoryComp.currentShellId = null;
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_CLEAR_INVALID_SELECTION) {
        factoryComp.selectedUnitBlueprintId = null;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_STOP_PRODUCING) {
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_SPAWN_SHELL) {
        const selectedUnitBlueprintId = factoryRowSelectedUnitBlueprintIds[row];
        if (selectedUnitBlueprintId === null) continue;
        const shell = this.spawnUnitShell(world, factory, selectedUnitBlueprintId);
        if (!shell) continue;
        factoryComp.currentShellId = shell.id;
        factoryComp.isProducing = true;
        factoryComp.currentBuildProgress = 0;
        spawnedUnits.push(shell);
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action !== FACTORY_ACTION_NONE) {
        throw new Error(`FactoryProductionSystem.update: unknown factory action ${action}`);
      }
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
    const unit = world.createUnitFromBlueprint(spawn.x, spawn.y, factory.ownership.playerId, unitBlueprintId, {
      allocateSubEntityIds: false,
    });
    unit.buildable = createBuildable({
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    });
    initializeConstructionPieceHealth(unit, world);
    world.addEntity(unit);
    return unit;
  }

  private isBuildSpotBlocked(world: WorldState, x: number, y: number, radius: number): boolean {
    const units = world.getUnits();
    const buildings = world.getBuildings();
    ensureBuildSpotObstacleCapacity(units.length + buildings.length);

    let count = 0;
    for (const unit of units) {
      if (unit.unit === null) continue;
      buildSpotObstacleX[count] = unit.transform.x;
      buildSpotObstacleY[count] = unit.transform.y;
      buildSpotObstacleRadius[count] = unit.unit.radius.collision;
      count += 1;
    }

    for (const building of buildings) {
      if (building.building === null || building.building.hp <= 0) continue;
      buildSpotObstacleX[count] = building.transform.x;
      buildSpotObstacleY[count] = building.transform.y;
      buildSpotObstacleRadius[count] = building.building.targetRadius;
      count += 1;
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('FactoryProductionSystem.isBuildSpotBlocked: sim-wasm is not initialized');
    }
    const result = sim.factoryBuildSpotBlocked(
      x,
      y,
      radius,
      buildSpotObstacleX,
      buildSpotObstacleY,
      buildSpotObstacleRadius,
      count,
    );
    if (result > 1) {
      throw new Error('FactoryProductionSystem.isBuildSpotBlocked: factory_build_spot_blocked rejected its buffers');
    }
    return result === 1;
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
