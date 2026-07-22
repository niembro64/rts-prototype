import type { WorldState } from './WorldState';
import type { Entity } from './types';
import type { BuildingGrid } from './buildGrid';
import { getUnitBlueprint } from './blueprints';
import { aimTurretsToward } from './turretInit';
import {
  COST_MULTIPLIER,
} from '../../config';
import { setUnitActions } from './unitActions';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { economyManager } from './economy';
import {
  cloneResourceCost,
  createBuildable,
  getBuildFraction,
  isEntityActive,
} from './buildableHelpers';
import {
  initializeConstructionPieceHealth,
} from './constructionLifecycle';
import { getEntityTargetPoint } from './buildingAnchors';
import { getSimWasm } from '../sim-wasm/init';
import type { ForceAccumulator } from './ForceAccumulator';
import type { WindState } from './wind';

import type { FactoryProductionResult } from '@/types/ui';
import type { UnitAction } from './types';
import { factoryCanProduceUnit } from './factoryProductionRoster';
import {
  assignEmitterSpawnTask,
  completeEmitterSpawnTask,
  findSpawnEmitter,
} from './emitterTasks';
import { applyEntityHoldPose, holdEntity, releaseEntityHold } from './entityHolds';
import {
  createFactoryProductionHoldSpec,
} from './factoryProductionHold';
import {
  applyFactoryProductionLaunch,
  updateFactoryProductionHoldLaunchPose,
} from './factoryProductionLaunch';
export { getFactoryShellSpawnClearanceAboveSurface } from './factoryProductionHold';

const FACTORY_SELECTED_NONE = 0;
const FACTORY_SELECTED_VALID = 1;
const FACTORY_SELECTED_INVALID = 2;
const FACTORY_ACTION_NONE = 0;
const FACTORY_ACTION_RESET_SHELL = 1;
const FACTORY_ACTION_COMPLETE_SHELL = 2;
const FACTORY_ACTION_CLEAR_INVALID_SELECTION = 3;
const FACTORY_ACTION_STOP_PRODUCING = 4;
const FACTORY_ACTION_SPAWN_SHELL = 5;
const MAX_FACTORY_PRODUCTION_QUEUE_LENGTH = 64;
const BAR_QUOTA_REPLACE_MAX_BUILD_PROGRESS = 0.075;
const BAR_QUOTA_REPLACE_MAX_METAL = 500;
const STILL_AIR: WindState = { x: 0, y: 0, z: 0, speed: 0, angle: 0 };
const BAR_AIR_FACTORY_OUTPUT_UNIT_BLUEPRINT_IDS = new Set<string>([
  'unitConstructionDrone',
  'unitBee',
  'unitDragonfly',
  'unitEagle',
  'unitDuck',
  'unitAlbatros',
  'unitTransport',
]);

type SpawnedFactoryProduct = {
  entity: Entity;
  requiresConstruction: boolean;
};

function producedUnitInheritsBarFactoryMoveState(factory: Entity, unit: Entity): boolean {
  if (factory.buildingBlueprintId !== 'towerFabricator') return false;
  const unitBlueprintId = unit.unit?.unitBlueprintId;
  if (unitBlueprintId === undefined) return false;
  return !BAR_AIR_FACTORY_OUTPUT_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function shiftFactoryProductionQueue(queue: string[]): string | null {
  if (queue.length === 0) return null;
  const unitBlueprintId = queue[0];
  for (let i = 1; i < queue.length; i++) queue[i - 1] = queue[i];
  queue.length--;
  return unitBlueprintId;
}

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
  startX: number,
  startY: number,
): { actions: UnitAction[]; patrolStartIndex: number | null } {
  const actions: UnitAction[] = [];
  let patrolStartIndex: number | null = null;
  if (route.length === 1 && route[0].type === 'patrol') {
    patrolStartIndex = 0;
    actions.push({
      type: 'patrol',
      x: startX,
      y: startY,
      z: world.getTerrainBedZ(startX, startY),
    });
  }
  for (let i = 0; i < route.length; i++) {
    const wp = route[i];
    if (wp.type === 'patrol' && patrolStartIndex === null) {
      patrolStartIndex = actions.length;
    }
    actions.push({
      type: wp.type,
      x: wp.x,
      y: wp.y,
      z: wp.z ?? world.getTerrainBedZ(wp.x, wp.y),
    });
  }
  return { actions, patrolStartIndex };
}

// Factory production system
class FactoryProductionSystem {
  // Update all factories. The factory's job is now (a) spawning a
  // shell of the selected repeat-build unit on its center support when
  // work begins, and (b) detecting completion of the shell and finishing the
  // activation (static rally + turret aim). Resource transfer into the
  // shell is handled by energyDistribution, the same path that funds
  // buildings.
  update(
    world: WorldState,
    dtMs: number,
    buildingGrid: BuildingGrid,
    forceAccumulator: ForceAccumulator,
    wind: WindState = STILL_AIR,
  ): FactoryProductionResult {
    const spawnedUnits: Entity[] = [];
    const completedUnits: Entity[] = [];
    // Building factories (fabricator) then mobile unit factories (queens). The
    // per-factory logic below is host-type-agnostic; producer-specific bay
    // placement is delegated to EntityHold. Order is deterministic.
    const factories = world.getFactoryBuildings().concat(world.getFactoryUnits());
    ensureFactoryProductionCapacity(factories.length);
    factoryRows.length = 0;
    factoryRowShells.length = 0;
    factoryRowSelectedUnitBlueprintIds.length = 0;
    const remainingSpawnCapacityByPlayer = new Map<number, number>();

    for (const factory of factories) {
      // Factory itself must be complete and owned.
      if (!factory.factory || !isEntityActive(factory)) continue;
      if (!factory.ownership) continue;

      const factoryComp = factory.factory;
      if (factoryComp.paused) {
        if (
          factoryComp.isProducing ||
          factoryComp.energyRateFraction !== 0 ||
          factoryComp.metalRateFraction !== 0
        ) {
          factoryComp.isProducing = false;
          factoryComp.energyRateFraction = 0;
          factoryComp.metalRateFraction = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        }
        continue;
      }
      if (
        this.preemptLowProgressShellForQuota(world, factory) ||
        this.fillIdleQuotaSelection(world, factory)
      ) {
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      }
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
          updateFactoryProductionHoldLaunchPose(world, factory, shell);
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
      } else if (factory.unit !== null && factoryComp.carrierSpawnEnabled === false) {
        factorySelectedState[row] = FACTORY_SELECTED_NONE;
      } else {
        const selectedUnitBlueprintId = factoryComp.selectedUnitBlueprintId;
        if (selectedUnitBlueprintId === null) {
          factorySelectedState[row] = FACTORY_SELECTED_NONE;
        } else {
          try {
            getUnitBlueprint(selectedUnitBlueprintId);
            if (factoryCanProduceUnit(factory, selectedUnitBlueprintId)) {
              factorySelectedState[row] = FACTORY_SELECTED_VALID;
              // Reserve capacity while packing the complete deterministic
              // factory batch. Checking world.canPlayerBuildUnit separately
              // for every row lets every idle factory observe the same free
              // slot and overshoot the cap simultaneously.
              let remainingCapacity = remainingSpawnCapacityByPlayer.get(playerId);
              if (remainingCapacity === undefined) {
                remainingCapacity = world.getRemainingUnitCapacity(playerId);
              }
              if (remainingCapacity > 0) {
                factoryCanBuildUnit[row] = 1;
                remainingCapacity--;
              }
              remainingSpawnCapacityByPlayer.set(playerId, remainingCapacity);
            } else {
              factorySelectedState[row] = FACTORY_SELECTED_INVALID;
            }
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
          this.activateShell(world, factory, shell, buildingGrid, dtMs, forceAccumulator, wind);
          completedUnits.push(shell);
        }
        this.finishProductionWorkflow(world, factory);
      } else if (action === FACTORY_ACTION_CLEAR_INVALID_SELECTION) {
        factoryComp.selectedUnitBlueprintId = null;
        factoryComp.resumeRepeatUnitBlueprintId = null;
        factoryComp.productionQueue.length = 0;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_STOP_PRODUCING) {
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
        world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      } else if (action === FACTORY_ACTION_SPAWN_SHELL) {
        const selectedUnitBlueprintId = factoryRowSelectedUnitBlueprintIds[row];
        if (selectedUnitBlueprintId === null) continue;
        const product = this.spawnUnitProduct(world, factory, selectedUnitBlueprintId);
        if (product === null) continue;
        spawnedUnits.push(product.entity);
        if (product.requiresConstruction) {
          factoryComp.currentShellId = product.entity.id;
          factoryComp.isProducing = true;
          factoryComp.currentBuildProgress = 0;
          world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
        } else {
          this.activateShell(world, factory, product.entity, buildingGrid, dtMs, forceAccumulator, wind);
          completedUnits.push(product.entity);
          this.finishProductionWorkflow(world, factory);
        }
      } else if (action !== FACTORY_ACTION_NONE) {
        throw new Error(`FactoryProductionSystem.update: unknown factory action ${action}`);
      }
    }

    return { spawnedUnits, completedUnits };
  }

  // Spawn a construction shell of `unitBlueprintId` in the factory's hold bay.
  // The shell starts at 0/0/0 paid; energyDistribution fills it. The
  // unit is fully constructed (renderer-ready), but its active build
  // state suppresses combat/orders until each resource bar tops up.
  private spawnUnitProduct(
    world: WorldState,
    factory: Entity,
    unitBlueprintId: string,
  ): SpawnedFactoryProduct | null {
    if (!factory.ownership) return null;
    const spawnEmitter = findSpawnEmitter(factory, 'unit');
    if (spawnEmitter === null || spawnEmitter.config.controlMode !== 'host') return null;
    const producesNanoframe = spawnEmitter.config.spawn?.producesNanoframe === true;
    if (!assignEmitterSpawnTask(spawnEmitter, {
      blueprintKind: 'unit',
      blueprintId: unitBlueprintId,
      completion: producesNanoframe ? 'nanoframe' : 'complete',
      placement: { kind: 'hostHold' },
    })) {
      return null;
    }
    const bp = getUnitBlueprint(unitBlueprintId);
    // Allocate the shell's sub-entity ids (locomotion + turrets) up
    // front, exactly like spawned commanders and pre-placed buildings.
    // Emitters with id === NO_ENTITY_ID are not materialized and
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
    if (producesNanoframe) {
      unit.buildable = createBuildable({
        energy: bp.cost.energy * COST_MULTIPLIER,
        metal: bp.cost.metal * COST_MULTIPLIER,
      });
    }
    holdEntity(factory, unit, createFactoryProductionHoldSpec(factory, unitBlueprintId));
    applyEntityHoldPose(world, unit);
    updateFactoryProductionHoldLaunchPose(world, factory, unit);
    if (producesNanoframe) initializeConstructionPieceHealth(unit, world);
    world.addEntity(unit);
    completeEmitterSpawnTask(spawnEmitter, unit.id);
    world.recordFactoryProducedUnit(factory.id, unit);
    // The factory's spawn turret brought this shell into existence — flash a
    // brief init beam from the factory to it.
    world.registerSpawnBeam(unit.id, factory.id);
    return { entity: unit, requiresConstruction: producesNanoframe };
  }

  private finishProductionWorkflow(world: WorldState, factory: Entity): void {
    const factoryComp = factory.factory;
    if (factoryComp === null) return;
    factoryComp.currentShellId = null;
    factoryComp.isProducing = false;
    factoryComp.currentBuildProgress = 0;
    if (!factoryComp.repeatProduction) {
      factoryComp.selectedUnitBlueprintId = this.takeNextFiniteSelection(world, factory);
    }
    world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }

  private fillIdleQuotaSelection(world: WorldState, factory: Entity): boolean {
    const factoryComp = factory.factory;
    const ownership = factory.ownership;
    if (factoryComp === null || ownership === null) return false;
    if (factoryComp.currentShellId !== null || factoryComp.selectedUnitBlueprintId !== null) return false;
    const unitBlueprintId = this.takeNextFiniteSelection(world, factory);
    if (unitBlueprintId === null) return false;
    factoryComp.selectedUnitBlueprintId = unitBlueprintId;
    factoryComp.repeatProduction = false;
    return true;
  }

  private takeNextFiniteSelection(world: WorldState, factory: Entity): string | null {
    const quotaUnitBlueprintId = this.mostUnderQuotaUnitBlueprintId(world, factory);
    if (quotaUnitBlueprintId !== null) return quotaUnitBlueprintId;
    const factoryComp = factory.factory;
    if (factoryComp === null) return null;
    const queuedUnitBlueprintId = shiftFactoryProductionQueue(factoryComp.productionQueue);
    if (queuedUnitBlueprintId !== null) return queuedUnitBlueprintId;
    const resumeUnitBlueprintId = factoryComp.resumeRepeatUnitBlueprintId;
    if (resumeUnitBlueprintId === null) return null;
    factoryComp.resumeRepeatUnitBlueprintId = null;
    if (!factoryCanProduceUnit(factory, resumeUnitBlueprintId)) return null;
    factoryComp.repeatProduction = true;
    return resumeUnitBlueprintId;
  }

  private mostUnderQuotaUnitBlueprintId(world: WorldState, factory: Entity): string | null {
    const factoryComp = factory.factory;
    if (factoryComp === null || factory.ownership === null) return null;
    let bestUnitBlueprintId: string | null = null;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (const [unitBlueprintId, rawQuota] of Object.entries(factoryComp.productionQuotas)) {
      const quota = Math.floor(rawQuota);
      if (quota <= 0 || !factoryCanProduceUnit(factory, unitBlueprintId)) continue;
      const count = world.getFactoryProducedUnitCount(factory.id, unitBlueprintId);
      if (count >= quota) continue;
      const ratio = count / quota;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestUnitBlueprintId = unitBlueprintId;
      }
    }
    return bestUnitBlueprintId;
  }

  private preemptLowProgressShellForQuota(world: WorldState, factory: Entity): boolean {
    const factoryComp = factory.factory;
    if (factoryComp === null || factory.ownership === null) return false;
    const activeUnitBlueprintId = factoryComp.selectedUnitBlueprintId;
    if (activeUnitBlueprintId === null || factoryComp.currentShellId === null) return false;

    const quotaUnitBlueprintId = this.mostUnderQuotaUnitBlueprintId(world, factory);
    if (quotaUnitBlueprintId === null || quotaUnitBlueprintId === activeUnitBlueprintId) return false;

    const shell = world.getEntity(factoryComp.currentShellId);
    const buildable = shell?.buildable ?? null;
    if (buildable === null) return false;
    if (buildable.isComplete) return false;

    const progress = getBuildFraction(buildable);
    if (progress >= BAR_QUOTA_REPLACE_MAX_BUILD_PROGRESS) return false;

    let activeUnitMetalCost = 0;
    try {
      activeUnitMetalCost = getUnitBlueprint(activeUnitBlueprintId).cost.metal;
    } catch {
      return false;
    }
    if (progress * activeUnitMetalCost >= BAR_QUOTA_REPLACE_MAX_METAL) return false;

    this.cancelActiveShell(world, factory);
    if (factoryComp.repeatProduction) {
      factoryComp.resumeRepeatUnitBlueprintId = activeUnitBlueprintId;
    } else {
      factoryComp.productionQueue.unshift(activeUnitBlueprintId);
      if (factoryComp.productionQueue.length > MAX_FACTORY_PRODUCTION_QUEUE_LENGTH) {
        factoryComp.productionQueue.length = MAX_FACTORY_PRODUCTION_QUEUE_LENGTH;
      }
    }
    factoryComp.selectedUnitBlueprintId = quotaUnitBlueprintId;
    factoryComp.repeatProduction = false;
    factoryComp.isProducing = false;
    factoryComp.currentBuildProgress = 0;
    return true;
  }

  // Called when a unit shell completes. Releases the production hold, stamps
  // the static factory rally onto the unit, and aims the turret.
  private activateShell(
    world: WorldState,
    factory: Entity,
    unit: Entity,
    _buildingGrid: BuildingGrid,
    _dtMs: number,
    _forceAccumulator: ForceAccumulator,
    _wind: WindState,
  ): void {
    if (!factory.factory) return;
    const factoryComp = factory.factory;
    const launchPlan = updateFactoryProductionHoldLaunchPose(world, factory, unit);
    releaseEntityHold(unit);
    if (launchPlan !== null) applyFactoryProductionLaunch(unit, launchPlan);
    if (unit.unit) {
      // BAR units inherit their lab's MOVE_STATE. The prototype fabricator
      // combines land and air pages, so keep the BAR air-factory page at the
      // normal unit default while land-page outputs inherit the factory state.
      if (producedUnitInheritsBarFactoryMoveState(factory, unit)) {
        unit.unit.moveState = factoryComp.moveState;
      }

      const guardTarget = factoryComp.guardTargetId !== null
        ? world.getEntity(factoryComp.guardTargetId)
        : undefined;
      const isSelfFactoryGuard = guardTarget?.id === factory.id;
      if (
        guardTarget !== undefined &&
        (!isSelfFactoryGuard || unit.builder !== null) &&
        factory.ownership !== null &&
        guardTarget.ownership !== null &&
        world.arePlayersAllied(factory.ownership.playerId, guardTarget.ownership.playerId)
      ) {
        const targetPoint = getEntityTargetPoint(guardTarget);
        setUnitActions(unit.unit, [{
          type: 'guard',
          x: targetPoint.x,
          y: targetPoint.y,
          z: targetPoint.z,
          targetId: guardTarget.id,
        }]);
        unit.unit.patrolStartIndex = null;
      } else {
        const route = factoryComp.defaultWaypoints !== null
          ? factoryComp.defaultWaypoints
          : [{
              x: factoryComp.rallyX,
              y: factoryComp.rallyY,
              z: factoryComp.rallyZ,
              type: factoryComp.rallyType,
            }];
        const { actions, patrolStartIndex } = directFactoryRallyActions(
          world,
          route,
          factory.transform.x,
          factory.transform.y,
        );
        setUnitActions(unit.unit, actions);
        if (patrolStartIndex !== null) {
          unit.unit.patrolStartIndex = patrolStartIndex;
        }
      }
    }
    // The finished unit is released with its factory launch plan; fabricators
    // use a zero impulse so normal gravity takes over immediately.
    aimTurretsToward(unit, world.mapWidth / 2, world.mapHeight / 2);
    world.markSnapshotDirty(
      unit.id,
      ENTITY_CHANGED_ACTIONS |
        ENTITY_CHANGED_POS |
        ENTITY_CHANGED_ROT |
        ENTITY_CHANGED_TURRETS |
        ENTITY_CHANGED_VEL,
    );
  }

  // Toggle or queue factory production. Repeat mode keeps a single
  // infinite selection; finite mode appends one or more jobs behind the
  // active shell/selection without canceling already-paid work.
  selectUnit(
    factory: Entity,
    unitBlueprintId: string,
    world: WorldState,
    repeat = true,
    count = 1,
  ): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    if (!factoryCanProduceUnit(factory, unitBlueprintId)) {
      return false;
    }
    try {
      getUnitBlueprint(unitBlueprintId);
    } catch {
      return false;
    }
    const factoryComp = factory.factory;
    const requestedCount = Math.max(1, Math.min(MAX_FACTORY_PRODUCTION_QUEUE_LENGTH, Math.floor(count)));
    if (!repeat) {
      let changed = false;
      if (factoryComp.selectedUnitBlueprintId === null && factoryComp.currentShellId === null) {
        factoryComp.selectedUnitBlueprintId = unitBlueprintId;
        factoryComp.repeatProduction = false;
        changed = true;
      } else {
        factoryComp.repeatProduction = false;
      }
      while (
        factoryComp.productionQueue.length < MAX_FACTORY_PRODUCTION_QUEUE_LENGTH &&
        factoryComp.productionQueue.length + (changed ? 1 : 0) < requestedCount
      ) {
        factoryComp.productionQueue.push(unitBlueprintId);
        changed = true;
      }
      return changed;
    }

    const current = factoryComp.selectedUnitBlueprintId;
    if (
      current === unitBlueprintId &&
      factoryComp.repeatProduction &&
      factoryComp.productionQueue.length === 0
    ) {
      // Toggle off — cancel active shell, clear selection.
      this.cancelActiveShell(world, factory);
      factoryComp.selectedUnitBlueprintId = null;
      factoryComp.isProducing = false;
      factoryComp.repeatProduction = true;
      factoryComp.resumeRepeatUnitBlueprintId = null;
      factoryComp.productionQueue.length = 0;
    } else {
      // Replace — cancel any active shell of the previous type, then
      // swap the selection. The production loop spawns a fresh shell
      // of the new type next tick.
      this.cancelActiveShell(world, factory);
      factoryComp.selectedUnitBlueprintId = unitBlueprintId;
      factoryComp.repeatProduction = true;
      factoryComp.resumeRepeatUnitBlueprintId = null;
      factoryComp.productionQueue.length = 0;
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
      || factoryComp.currentBuildProgress !== 0
      || factoryComp.productionQueue.length > 0
      || Object.keys(factoryComp.productionQuotas).length > 0
      || Object.keys(factoryComp.productionQuotaCounts).length > 0;
    this.cancelActiveShell(world, factory);
    factoryComp.selectedUnitBlueprintId = null;
    factoryComp.resumeRepeatUnitBlueprintId = null;
    factoryComp.productionQueue.length = 0;
    for (const key of Object.keys(factoryComp.productionQuotas)) delete factoryComp.productionQuotas[key];
    for (const key of Object.keys(factoryComp.productionQuotaCounts)) delete factoryComp.productionQuotaCounts[key];
    factoryComp.isProducing = false;
    factoryComp.currentBuildProgress = 0;
    return changed;
  }

  editQueue(
    factory: Entity,
    operation: 'remove' | 'move' | 'setCount',
    index: number,
    length = 1,
    toIndex?: number,
    count?: number,
  ): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    const queue = factory.factory.productionQueue;
    if (queue.length === 0 || index < 0 || index >= queue.length) return false;
    const editLength = Math.max(1, Math.min(Math.floor(length), queue.length - index));

    if (operation === 'remove') {
      queue.splice(index, editLength);
      return true;
    }

    if (operation === 'move') {
      if (toIndex === undefined || toIndex < 0 || toIndex > queue.length) return false;
      const removed = queue.splice(index, editLength);
      let targetIndex = Math.min(Math.floor(toIndex), queue.length + removed.length);
      if (targetIndex > index) {
        targetIndex -= removed.length;
      }
      if (targetIndex < 0) targetIndex = 0;
      if (targetIndex > queue.length) targetIndex = queue.length;
      if (targetIndex === index) {
        queue.splice(index, 0, ...removed);
        return false;
      }
      queue.splice(targetIndex, 0, ...removed);
      return true;
    }

    if (operation === 'setCount') {
      if (count === undefined || count < 0) return false;
      const unitBlueprintId = queue[index];
      const nextCount = Math.max(0, Math.min(
        Math.floor(count),
        MAX_FACTORY_PRODUCTION_QUEUE_LENGTH - (queue.length - editLength),
      ));
      if (nextCount === editLength) return false;
      const replacements = new Array<string>(nextCount);
      for (let i = 0; i < nextCount; i++) replacements[i] = unitBlueprintId;
      queue.splice(index, editLength, ...replacements);
      return true;
    }

    return false;
  }

  removeUnitProduction(factory: Entity, world: WorldState, unitBlueprintId: string, count = 1): boolean {
    if (!factory.factory || !isEntityActive(factory)) {
      return false;
    }
    if (!factoryCanProduceUnit(factory, unitBlueprintId)) {
      return false;
    }
    try {
      getUnitBlueprint(unitBlueprintId);
    } catch {
      return false;
    }

    const factoryComp = factory.factory;
    let remaining = Math.max(1, Math.min(MAX_FACTORY_PRODUCTION_QUEUE_LENGTH, Math.floor(count)));
    let changed = false;

    for (let i = factoryComp.productionQueue.length - 1; i >= 0 && remaining > 0; i--) {
      if (factoryComp.productionQueue[i] !== unitBlueprintId) continue;
      factoryComp.productionQueue.splice(i, 1);
      remaining--;
      changed = true;
    }

    if (
      remaining > 0 &&
      factoryComp.selectedUnitBlueprintId === unitBlueprintId &&
      !factoryComp.repeatProduction
    ) {
      this.cancelActiveShell(world, factory);
      factoryComp.selectedUnitBlueprintId = null;
      factoryComp.isProducing = false;
      factoryComp.currentBuildProgress = 0;
      changed = true;
    }

    return changed;
  }

  // Cancel the in-progress shell. An unfinished factory unit is never
  // released as a real unit (BAR: only a finished unit is controllable;
  // the in-factory frame is destroyed if the factory dies, and cancelling
  // production removes the frame). So the shell is always removed — never
  // preserved as a half-built, controllable zombie. `refund` is true for
  // player-initiated cancels/replaces (return the metal/energy paid so
  // far) and false when the factory itself dies (the work is lost with it).
  cancelActiveShell(world: WorldState, factory: Entity, refund = true): void {
    const factoryComp = factory.factory!;
    const shellId = factoryComp.currentShellId;
    if (shellId === null) return;
    const shell = world.getEntity(shellId);
    if (shell !== undefined) {
      if (shell.buildable !== null && shell.ownership !== null && refund) {
        economyManager.addStockpile(
          world,
          shell.ownership.playerId,
          cloneResourceCost(shell.buildable.paid),
          factory.id,
          shell.id,
          'refund',
        );
      }
      releaseEntityHold(shell);
      world.removeEntity(shellId);
    }
    factoryComp.currentShellId = null;
    factoryComp.currentBuildProgress = 0;
  }
}

// Singleton instance
export const factoryProductionSystem = new FactoryProductionSystem();
