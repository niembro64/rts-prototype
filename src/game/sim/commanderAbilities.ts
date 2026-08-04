import type { WorldState } from './WorldState';
import { NO_ENTITY_ID, type Entity, type EntityId, type PlayerId } from './types';
import { isBuildTargetInRange } from './builderRange';
import { getBuilderConstructionRate } from './hostCapabilities';
import { getTransformCosSin } from '../math';
import { getBuildingBlueprint, getUnitBlueprint } from './blueprints';
import { economyManager } from './economy';
import { isCapturableTarget } from './capture';
import {
  getReclaimResourceValue,
  isReclaimableTarget,
  isReclaimTargetInBuildRange,
  resolveReclaimTarget,
  RECLAIM_REFUND_FRACTION,
  type ReclaimTarget,
} from './reclaim';
import { applyVegetationReclaimTick } from './vegetation';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildInProgress } from './buildableHelpers';
import { setUnitActions } from './unitActions';
import { ballSpawnRateForWorkRate } from '@/resourceConfig';
import { getSimWasm } from '../sim-wasm/init';
import { isResurrectableWreck, restoreUnitFromWreck } from './wrecks';
import { entityCanIssueResurrectCommand } from './unitCommandCapabilities';
import { writeFabricatorProductionSprayOrigin } from './factoryProductionHold';

export type { SprayTarget,  } from '@/types/ui';
import type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';

const _workEmitterWorld = { x: 0, y: 0, z: 0 };
const _reclaimTickOut = new Float64Array(5);
const REPAIR_RATE_PAIR_KEY_STRIDE = 67_108_864;

type CompletedBuilding = CommanderAbilitiesResult['completedBuildings'][number];

function repairRatePairKey(sourceId: EntityId, targetId: EntityId): number {
  return sourceId * REPAIR_RATE_PAIR_KEY_STRIDE + targetId;
}

function getWorkEmitterSpec(entity: Entity) {
  if (entity.unit !== null) {
    return getUnitBlueprint(entity.unit.unitBlueprintId).workEmitter ?? null;
  }
  if (entity.buildingBlueprintId !== null) {
    return getBuildingBlueprint(entity.buildingBlueprintId).workEmitter ?? null;
  }
  return null;
}

function writeWorkEmitterWorldPosition(
  source: Entity,
  pointIndex: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const spec = getWorkEmitterSpec(source);
  const point = spec?.points[pointIndex] ?? spec?.points[0];
  if (point === undefined) {
    out.x = source.transform.x;
    out.y = source.transform.y;
    out.z = source.transform.z;
    return out;
  }
  const scale = source.unit?.radius.other ?? 1;
  const localX = point.x * scale;
  const localY = point.y * scale;
  const { cos, sin } = getTransformCosSin(source.transform);
  out.x = source.transform.x + localX * cos - localY * sin;
  out.y = source.transform.y + localX * sin + localY * cos;
  out.z = source.transform.z + point.z * scale;
  return out;
}

// Commander abilities system - handles build queue (ONE target at a time)
class CommanderAbilitiesSystem {
  private readonly sprayTargets: SprayTarget[] = [];
  private readonly sprayTargetPool: SprayTarget[] = [];
  private readonly completedBuildings: CompletedBuilding[] = [];
  private readonly completedBuildingPool: CompletedBuilding[] = [];
  private readonly resurrectedUnits: Entity[] = [];
  private readonly resurrectedBuildings: Entity[] = [];
  private readonly result: CommanderAbilitiesResult = {
    sprayTargets: this.sprayTargets,
    completedBuildings: this.completedBuildings,
    resurrectedUnits: this.resurrectedUnits,
    resurrectedBuildings: this.resurrectedBuildings,
  };
  private readonly captureProgressByPair = new Map<number, { playerId: PlayerId; progress: number }>();
  private readonly activeCaptureKeys = new Set<number>();

  // Update all commanders' building and healing
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    this.sprayTargets.length = 0;
    this.completedBuildings.length = 0;
    this.resurrectedUnits.length = 0;
    this.resurrectedBuildings.length = 0;
    this.activeCaptureKeys.clear();

    // Walk every builder (commanders + plain construction units). `commander`
    // below is "the acting builder"; reclaim + build/heal sprays apply to all
    // of them, while capture and resurrect have narrower command capabilities.
    for (const commander of world.getBuilderUnits()) {
      if (!commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const workOrigin = writeWorkEmitterWorldPosition(commander, 0, _workEmitterWorld);
      const commanderSprayX = workOrigin.x;
      const commanderSprayY = workOrigin.y;
      const commanderSprayZ = workOrigin.z;

      const queuedAction = commander.unit.actions[0];

      // Reclaim resolves its own target: BAR's one Reclaim command spans
      // units, buildings, and world features, and features live outside
      // the entity map.
      if (queuedAction !== undefined && queuedAction.type === 'reclaim') {
        const reclaimTarget = resolveReclaimTarget(world, queuedAction.targetId);
        if (
          reclaimTarget !== null &&
          isReclaimTargetInBuildRange(commander, reclaimTarget) &&
          this.reclaimTarget(world, playerId, commander, reclaimTarget, dtMs)
        ) {
          this.pushCompletedBuilding(commander.id, reclaimTarget.id);
        }
        continue;
      }

      // Get current target from queue (only work on ONE thing at a time)
      const currentTarget = this.getCurrentTarget(world, commander);
      if (!currentTarget) continue;
      const currentAction = queuedAction;

      // Energy spending is handled by the shared energy distribution system.
      // Commander building progress is advanced there.

      if (currentAction !== undefined && currentAction.type === 'capture' && commander.commander !== null) {
        if (
          this.captureTarget(
            world,
            playerId,
            commander,
            currentTarget,
            dtMs,
            commanderSprayX,
            commanderSprayY,
            commanderSprayZ,
          )
        ) {
          this.pushCompletedBuilding(commander.id, currentTarget.id);
        }
        continue;
      }

      if (currentAction !== undefined && currentAction.type === 'resurrect' && entityCanIssueResurrectCommand(commander)) {
        if (
          this.resurrectTarget(
            world,
            playerId,
            commander,
            currentTarget,
            dtMs,
            commanderSprayX,
            commanderSprayY,
            commanderSprayZ,
          )
        ) {
          this.pushCompletedBuilding(commander.id, currentTarget.id);
        }
        continue;
      }

    }

    for (const key of this.captureProgressByPair.keys()) {
      if (!this.activeCaptureKeys.has(key)) this.captureProgressByPair.delete(key);
    }

    this.emitWorkSprays(world);

    return this.result;
  }

  private emitWorkSprays(world: WorldState): void {
    const movements = world.workMovements;
    for (let i = 0; i < movements.length; i++) {
      const movement = movements[i];
      const source = world.getEntity(movement.sourceEntityId);
      if (source === undefined || source.ownership === null) continue;
      // A movement either names an entity (read its live transform, so
      // the spray tracks a target that is still moving) or carries its
      // own world point for work targets outside the entity map.
      const point = movement.targetPoint;
      const target = point === null ? world.getEntity(movement.targetEntityId) : undefined;
      if (point === null && target === undefined) continue;
      const spec = getWorkEmitterSpec(source);
      const pointCount = Math.max(1, spec?.points.length ?? 0);
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const fabricatorProductionWork =
          movement.operation === 'construct' &&
          source.buildingBlueprintId === 'towerFabricator' &&
          source.factory?.currentShellId === movement.targetEntityId;
        const origin = fabricatorProductionWork
          ? writeFabricatorProductionSprayOrigin(
              source,
              world.getTick(),
              movement.targetEntityId,
              pointIndex,
              _workEmitterWorld,
            )
          : writeWorkEmitterWorldPosition(source, pointIndex, _workEmitterWorld);
        const spray = this.acquireSprayTarget();
        spray.source.id = source.id;
        spray.source.pos.x = origin.x;
        spray.source.pos.y = origin.y;
        spray.source.z = origin.z;
        spray.source.playerId = source.ownership.playerId;
        spray.target.id = movement.targetEntityId;
        spray.target.pos.x = point !== null ? point.x : target!.transform.x;
        spray.target.pos.y = point !== null ? point.y : target!.transform.y;
        spray.target.z = point !== null ? point.z : target!.transform.z;
        spray.target.radius = point !== null
          ? point.radius
          : target!.unit !== null
            ? target!.unit.radius.hitbox
            : target!.building?.targetRadius ?? 20;
        // Construction and repair deliberately share one outward, team-color
        // visual vocabulary. Operation remains in the work ledger for debug.
        spray.type = 'build';
        spray.intensity = 1;
        spray.channel = pointIndex;
        spray.flow = 'direct';
        spray.inverse = movement.operation === 'reclaim';
        spray.flowRadius = 0;
        spray.speed = spec?.particleTravelSpeed;
        spray.particleRadius = spec?.particleRadius;
        spray.ballSpawnRate = ballSpawnRateForWorkRate(
          movement.amountPerSecond / pointCount,
        );
      }
    }
  }

  private acquireSprayTarget(): SprayTarget {
    const index = this.sprayTargets.length;
    let spray = this.sprayTargetPool[index];
    if (spray === undefined) {
      spray = {
        source: { id: NO_ENTITY_ID, pos: { x: 0, y: 0 }, z: 0, playerId: 0 },
        target: { id: NO_ENTITY_ID, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        waypoint: undefined,
        waypoint2: undefined,
        type: 'heal',
        intensity: 0,
        channel: 0,
        flow: 'direct',
        inverse: undefined,
        flowRadius: 0,
        coneAxis: undefined,
        coneAngle: undefined,
        speed: undefined,
        particleRadius: undefined,
        colorRGB: undefined,
        endColorRGB: undefined,
        endpointFade: undefined,
        pylonTubeHandoffKey: undefined,
        ballSpawnRate: undefined,
      };
      this.sprayTargetPool[index] = spray;
    }
    spray.target.dim = undefined;
    spray.target.radius = undefined;
    spray.inverse = undefined;
    spray.waypoint = undefined;
    spray.waypoint2 = undefined;
    spray.coneAxis = undefined;
    spray.coneAngle = undefined;
    spray.speed = undefined;
    spray.particleRadius = undefined;
    spray.colorRGB = undefined;
    spray.endColorRGB = undefined;
    spray.endpointFade = undefined;
    spray.pylonTubeHandoffKey = undefined;
    spray.ballSpawnRate = undefined;
    this.sprayTargets.push(spray);
    return spray;
  }

  private pushCompletedBuilding(commanderId: EntityId, buildingId: EntityId): void {
    const index = this.completedBuildings.length;
    let completed = this.completedBuildingPool[index];
    if (completed === undefined) {
      completed = { commanderId: NO_ENTITY_ID, buildingId: NO_ENTITY_ID };
      this.completedBuildingPool[index] = completed;
    }
    completed.commanderId = commanderId;
    completed.buildingId = buildingId;
    this.completedBuildings.push(completed);
  }

  // Get the current build/repair/reclaim target from commander's action queue
  private getCurrentTarget(
    world: WorldState,
    commander: Entity
  ): Entity | null {
    if (!commander.unit) return null;

    const actions = commander.unit.actions;
    if (actions.length === 0) return null;

    // Get the first action
    const currentAction = actions[0];

    // Only process build/repair/capture/resurrection actions. Reclaim is
    // resolved by the caller because its targets span two stores.
    if (
      currentAction.type !== 'build' &&
      currentAction.type !== 'repair' &&
      currentAction.type !== 'capture' &&
      currentAction.type !== 'resurrect'
    ) {
      return null;
    }

    // Get the target entity
    const targetId = currentAction.type === 'build' ? currentAction.buildingId : currentAction.targetId;
    if (!targetId) return null;

    const target = world.getEntity(targetId);
    if (!target) return null;

    if (currentAction.type === 'capture') {
      const playerId = commander.ownership?.playerId;
      return playerId !== undefined &&
        isCapturableTarget(target, playerId, (a, b) => world.arePlayersAllied(a, b)) &&
        isBuildTargetInRange(commander, target)
        ? target
        : null;
    }

    if (currentAction.type === 'resurrect') {
      return entityCanIssueResurrectCommand(commander) && isResurrectableWreck(target) && isBuildTargetInRange(commander, target)
        ? target
        : null;
    }

    if (currentAction.type === 'repair') {
      const playerId = commander.ownership?.playerId;
      const targetPlayerId = target.ownership?.playerId;
      if (
        playerId === undefined ||
        targetPlayerId === undefined ||
        !world.arePlayersAllied(playerId, targetPlayerId)
      ) return null;
    }

    // Check if target is valid (incomplete building or damaged entity).
    const isValidBuilding = isBuildInProgress(target.buildable);
    const hpState = target.unit ?? target.building;
    const isValidRepair = hpState !== null && hpState.hp > 0 && hpState.hp < hpState.maxHp;

    if (!isValidBuilding && !isValidRepair) {
      return null;
    }

    if (isBuildTargetInRange(commander, target)) {
      return target;
    }

    return null;
  }

  private reclaimTarget(
    world: WorldState,
    playerId: PlayerId,
    commander: Entity,
    target: ReclaimTarget,
    dtMs: number,
  ): boolean {
    if (!commander.builder) return false;
    return target.kind === 'vegetation'
      ? this.reclaimVegetation(world, playerId, commander, target, dtMs)
      : this.reclaimEntity(world, playerId, commander, target.entity, dtMs);
  }

  /**
   * BAR gradual feature reclaim. The prop's work pool drains at
   * `maxHp * buildPower / reclaimTime` per second and pays out energy
   * strictly in proportion, so a builder consumes a tree in
   * `reclaimTime / buildPower` seconds and banks its full authored
   * yield. Several builders may work one prop at once — BAR's
   * `multiReclaim` — because each tick only claims its own share.
   */
  private reclaimVegetation(
    world: WorldState,
    playerId: PlayerId,
    commander: Entity,
    target: Extract<ReclaimTarget, { kind: 'vegetation' }>,
    dtMs: number,
  ): boolean {
    const dtSec = dtMs / 1000;
    const buildPower = getBuilderConstructionRate(commander);
    const tick = applyVegetationReclaimTick(target.prop.index, buildPower, dtSec);
    if (tick === null) return false;

    const refund = { energy: tick.energy, metal: tick.metal };
    economyManager.addStockpile(
      world,
      playerId,
      refund,
      commander.id,
      target.id,
      'reclaim',
      dtSec > 0 ? { energy: refund.energy / dtSec, metal: refund.metal / dtSec } : null,
    );
    // The prop is not an entity, so the movement carries its own point.
    // emitWorkSprays applies BAR's inverse nano direction to reclaim.
    world.recordWorkMovement(commander.id, target.id, 'reclaim', buildPower, {
      x: target.x,
      y: target.y,
      z: target.z,
      radius: target.radius,
    });
    return tick.completed;
  }

  private reclaimEntity(
    world: WorldState,
    playerId: PlayerId,
    commander: Entity,
    target: Entity,
    dtMs: number,
  ): boolean {
    if (!isReclaimableTarget(target)) return false;
    const hpState = target.unit ?? target.building;
    if (!hpState || hpState.hp <= 0) return false;

    const value = getReclaimResourceValue(target);
    const dtSec = dtMs / 1000;
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('CommanderAbilitiesSystem.reclaimEntity: sim-wasm is not initialized');
    }
    if (sim.commanderApplyReclaimTick(
      hpState.hp,
      hpState.maxHp,
      getBuilderConstructionRate(commander),
      dtSec,
      value.energy,
      value.metal,
      RECLAIM_REFUND_FRACTION,
      _reclaimTickOut,
    ) === 0) {
      throw new Error('CommanderAbilitiesSystem.reclaimEntity: commander_apply_reclaim_tick rejected its output buffer');
    }

    const hpRemoved = _reclaimTickOut[1];
    if (hpRemoved <= 0) return false;

    const refund = {
      energy: _reclaimTickOut[2],
      metal: _reclaimTickOut[3],
    };
    const refundRate = dtSec > 0
      ? {
        energy: refund.energy / dtSec,
        metal: refund.metal / dtSec,
      }
      : null;
    economyManager.addStockpile(
      world,
      playerId,
      refund,
      commander.id,
      target.id,
      'reclaim',
      refundRate,
    );

    hpState.hp = _reclaimTickOut[0];
    world.markSnapshotDirty(target.id, ENTITY_CHANGED_HP);
    world.recordWorkMovement(
      commander.id,
      target.id,
      'reclaim',
      getBuilderConstructionRate(commander),
    );
    return _reclaimTickOut[4] !== 0;
  }

  private captureTarget(
    world: WorldState,
    playerId: PlayerId,
    commander: Entity,
    target: Entity,
    dtMs: number,
    sourceX: number,
    sourceY: number,
    sourceZ: number,
  ): boolean {
    if (
      !commander.builder ||
      !isCapturableTarget(target, playerId, (a, b) => world.arePlayersAllied(a, b))
    ) return false;
    const hpState = target.unit ?? target.building;
    if (hpState === null || hpState.hp <= 0 || hpState.maxHp <= 0) return false;

    const key = repairRatePairKey(commander.id, target.id);
    this.activeCaptureKeys.add(key);
    let state = this.captureProgressByPair.get(key);
    if (state === undefined || state.playerId !== playerId) {
      state = { playerId, progress: 0 };
      this.captureProgressByPair.set(key, state);
    }

    const dtSec = dtMs / 1000;
    state.progress = Math.min(1, state.progress + (getBuilderConstructionRate(commander) * dtSec) / hpState.maxHp);

    const spray = this.acquireSprayTarget();
    spray.source.id = commander.id;
    spray.source.pos.x = sourceX;
    spray.source.pos.y = sourceY;
    spray.source.z = sourceZ;
    spray.source.playerId = playerId;
    spray.target.id = target.id;
    spray.target.pos.x = target.transform.x;
    spray.target.pos.y = target.transform.y;
    spray.target.z = target.transform.z;
    spray.target.radius = target.unit !== null ? target.unit.radius.hitbox : target.building?.targetRadius ?? 0;
    // BAR capture nano is builder -> target and uses the builder's team
    // color, the same visual family as construction rather than repair's
    // legacy white/wobbling stream.
    spray.type = 'build';
    spray.intensity = Math.max(0.2, state.progress);
    spray.channel = 1;
    spray.flow = 'direct';
    spray.flowRadius = 0;
    spray.ballSpawnRate = 8;

    if (state.progress < 1) return false;

    this.captureProgressByPair.delete(key);
    world.setEntityOwner(target, playerId);
    if (target.unit !== null) {
      setUnitActions(target.unit, []);
      world.markSnapshotDirty(target.id, ENTITY_CHANGED_ACTIONS);
    }
    if (target.combat !== null) {
      target.combat.priorityTargetId = null;
      target.combat.priorityTargetPoint = null;
      target.combat.manualLaunchActive = false;
    }
    if (target.factory !== null) {
      target.factory.selectedUnitBlueprintId = null;
      target.factory.productionQueue.length = 0;
      target.factory.currentShellId = null;
      target.factory.currentBuildProgress = 0;
      target.factory.isProducing = false;
      target.factory.guardTargetId = null;
    }
    return true;
  }

  private resurrectTarget(
    world: WorldState,
    playerId: PlayerId,
    commander: Entity,
    target: Entity,
    dtMs: number,
    sourceX: number,
    sourceY: number,
    sourceZ: number,
  ): boolean {
    if (!entityCanIssueResurrectCommand(commander) || !isResurrectableWreck(target)) return false;
    const wreck = target.wreck;
    if (wreck === null || wreck.resurrectRequiredMs <= 0) return false;

    wreck.resurrectProgressMs = Math.min(
      wreck.resurrectRequiredMs,
      wreck.resurrectProgressMs + dtMs * Math.max(0.1, getBuilderConstructionRate(commander) / 100),
    );
    const progress = wreck.resurrectProgressMs / wreck.resurrectRequiredMs;

    const emitResurrectionLeg = (inverse: boolean, channel: number): void => {
      const spray = this.acquireSprayTarget();
      spray.source.id = commander.id;
      spray.source.pos.x = sourceX;
      spray.source.pos.y = sourceY;
      spray.source.z = sourceZ;
      spray.source.playerId = playerId;
      spray.target.id = target.id;
      spray.target.pos.x = target.transform.x;
      spray.target.pos.y = target.transform.y;
      spray.target.z = target.transform.z;
      spray.target.radius = target.building?.targetRadius ?? 20;
      spray.type = 'build';
      spray.intensity = Math.max(0.2, progress);
      spray.channel = channel;
      spray.flow = 'direct';
      spray.inverse = inverse;
      spray.flowRadius = 0;
      spray.ballSpawnRate = 10;
    };
    // BAR resurrection emits both the ordinary builder -> wreck stream
    // and the inverse wreck-volume -> builder return stream.
    emitResurrectionLeg(false, 2);
    emitResurrectionLeg(true, 3);

    if (wreck.resurrectProgressMs < wreck.resurrectRequiredMs) return false;

    const restored = restoreUnitFromWreck(world, target, playerId);
    if (restored !== null) this.resurrectedUnits.push(restored);
    return restored !== null;
  }
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
