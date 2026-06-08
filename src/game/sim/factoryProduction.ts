import type { WorldState } from './WorldState';
import type { Entity } from './types';
import type { BuildingGrid } from './buildGrid';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import { COST_MULTIPLIER } from '../../config';
import { setUnitActions } from './unitActions';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_TURRETS,
} from '../../types/network';
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
import type { UnitAction } from './types';

const FACTORY_SELECTED_NONE = 0;
const FACTORY_SELECTED_VALID = 1;
const FACTORY_SELECTED_INVALID = 2;
const FACTORY_ACTION_NONE = 0;
const FACTORY_ACTION_RESET_SHELL = 1;
const FACTORY_ACTION_COMPLETE_SHELL = 2;
const FACTORY_ACTION_CLEAR_INVALID_SELECTION = 3;
const FACTORY_ACTION_STOP_PRODUCING = 4;
const FACTORY_ACTION_SPAWN_SHELL = 5;
const FACTORY_SHELL_AIR_SPAWN_HEIGHT = 160;

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

function directFactoryRallyActions(
  world: WorldState,
  route: ReadonlyArray<{ x: number; y: number; z?: number | null; type: UnitAction['type'] }>,
): { actions: UnitAction[]; patrolStartIndex: number | null } {
  const actions: UnitAction[] = [];
  let patrolStartIndex: number | null = null;
  for (let i = 0; i < route.length; i++) {
    const wp = route[i];
    if (wp.type === 'patrol' && patrolStartIndex === null) {
      patrolStartIndex = actions.length;
    }
    actions.push({
      type: wp.type,
      x: wp.x,
      y: wp.y,
      z: wp.z ?? world.sampleSupportSurface(wp.x, wp.y).groundZ,
    });
  }
  return { actions, patrolStartIndex };
}

function getFactoryShellSpawnZ(world: WorldState, factory: Entity): number {
  return world.sampleSupportSurface(factory.transform.x, factory.transform.y).groundZ
    + FACTORY_SHELL_AIR_SPAWN_HEIGHT;
}

// Factory production system
export class FactoryProductionSystem {
  // Update all factories. The factory's job is now (a) spawning a
  // shell of the selected repeat-build unit above its center bay when
  // work begins, and (b) detecting completion of the shell and finishing the
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

  // Spawn a construction shell of `unitBlueprintId` above the factory's center bay.
  // The shell starts at 0/0/0 paid; energyDistribution fills it. The
  // unit is fully constructed (renderer-ready), but its active build
  // state suppresses combat/orders until each resource bar tops up.
  private spawnUnitShell(world: WorldState, factory: Entity, unitBlueprintId: string): Entity | null {
    if (!factory.ownership) return null;
    const bp = getUnitBlueprint(unitBlueprintId);
    // Allocate the shell's sub-entity ids (locomotion + turrets) up
    // front, exactly like spawned commanders and pre-placed buildings.
    // Turrets with id === NO_ENTITY_ID are treated as visual-only and
    // never fire; the construction shell still cannot attack until it
    // completes because isEntityActive() gates the BUILDABLE_COMPLETE
    // flag in combat targeting, but on completion the turrets already
    // hold real ids and engage like initial units do.
    const unit = world.createUnitFromBlueprint(
      factory.transform.x,
      factory.transform.y,
      factory.ownership.playerId,
      unitBlueprintId,
    );
    // Factory shells are allowed to begin above occupied pads. Physics
    // owns the fall and final resting place instead of rejecting the job
    // when a unit or building currently overlaps the authored spot.
    unit.transform.z = getFactoryShellSpawnZ(world, factory);
    unit.buildable = createBuildable({
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    });
    initializeConstructionPieceHealth(unit, world);
    world.addEntity(unit);
    return unit;
  }

  // Called when a unit shell completes. Stamps the static factory rally
  // onto the unit and aims the turret.
  private activateShell(
    world: WorldState,
    factory: Entity,
    unit: Entity,
    _buildingGrid: BuildingGrid,
  ): void {
    if (!factory.factory) return;
    const factoryComp = factory.factory;
    if (unit.unit) {
      const route = factoryComp.defaultWaypoints !== null
        ? factoryComp.defaultWaypoints
        : [{
            x: factoryComp.rallyX,
            y: factoryComp.rallyY,
            z: factoryComp.rallyZ,
            type: factoryComp.rallyType,
          }];
      const { actions, patrolStartIndex } = directFactoryRallyActions(world, route);
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

  stopProduction(factory: Entity, world: WorldState): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    const factoryComp = factory.factory;
    const changed = factoryComp.selectedUnitBlueprintId !== null
      || factoryComp.currentShellId !== null
      || factoryComp.isProducing
      || factoryComp.currentBuildProgress !== 0;
    this.cancelActiveShell(world, factory);
    factoryComp.selectedUnitBlueprintId = null;
    factoryComp.isProducing = false;
    factoryComp.currentBuildProgress = 0;
    return changed;
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
