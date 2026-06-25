import type { WorldState } from './WorldState';
import { NO_ENTITY_ID, type Entity, type EntityId, type PlayerId } from './types';
import { isBuildTargetInRange } from './builderRange';
import { updateWeaponWorldKinematics } from './combat/combatUtils';
import { getUnitGroundZ } from './unitGeometry';
import { getTransformCosSin } from '../math';
import { economyManager } from './economy';
import { isCapturableTarget } from './capture';
import { getReclaimResourceValue, isReclaimableTarget, RECLAIM_REFUND_FRACTION } from './reclaim';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildInProgress } from './buildableHelpers';
import { setUnitActions } from './unitActions';
import { ballSpawnRateForResourceRate } from '@/resourceConfig';
import { getSimWasm } from '../sim-wasm/init';
import { isResurrectableWreck, restoreUnitFromWreck } from './wrecks';

export type { SprayTarget,  } from '@/types/ui';
import type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';

const _constructionEmitterMount = { x: 0, y: 0, z: 0 };
const _reclaimTickOut = new Float64Array(5);
const REPAIR_RATE_PAIR_KEY_STRIDE = 67_108_864;

// Init "spawn beam": a brief, fast, dense team-colored zap from a spawn
// turret's host to the entity it just brought into existence. Reads as a laser
// (fast + dense particles) vs the lazier continuous construction balls.
// NOTE: the spray wire format carries only speed/particleRadius/ballSpawnRate/
// intensity (+ heal flag); colorRGB/flow/fade do not survive serialization, so
// the zap renders in the source player's team color (resolveSprayColor).
const SPAWN_BEAM_SOURCE_Z_BUMP = 8;
const SPAWN_BEAM_PARTICLE_SPEED = 700;
const SPAWN_BEAM_PARTICLE_RADIUS = 1.3;
const SPAWN_BEAM_BALL_SPAWN_RATE = 80;

type CompletedBuilding = CommanderAbilitiesResult['completedBuildings'][number];

function repairRatePairKey(sourceId: EntityId, targetId: EntityId): number {
  return sourceId * REPAIR_RATE_PAIR_KEY_STRIDE + targetId;
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
  private readonly repairEnergyRates = new Map<number, number>();
  private readonly captureProgressByPair = new Map<number, { playerId: PlayerId; progress: number }>();
  private readonly activeCaptureKeys = new Set<number>();

  // Update all commanders' building and healing
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    this.sprayTargets.length = 0;
    this.completedBuildings.length = 0;
    this.resurrectedUnits.length = 0;
    this.resurrectedBuildings.length = 0;
    this.activeCaptureKeys.clear();
    this.rebuildRepairEnergyRateIndex(world);

    // Walk every builder (commanders + plain construction units). `commander`
    // below is "the acting builder"; reclaim + build/heal sprays apply to all
    // of them, while capture/resurrect stay gated to commander-class units.
    for (const commander of world.getBuilderUnits()) {
      if (!commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const commanderX = commander.transform.x;
      const commanderY = commander.transform.y;
      let commanderSprayX = commanderX;
      let commanderSprayY = commanderY;
      let commanderSprayZ = commander.transform.z;
      const commanderTurrets = commander.combat !== null ? commander.combat.turrets : null;
      let turretConstructionIndex = -1;
      if (commanderTurrets !== null) {
        for (let i = 0; i < commanderTurrets.length; i++) {
          if (commanderTurrets[i].config.turretBlueprintId === 'turretConstruction') {
            turretConstructionIndex = i;
            break;
          }
        }
      }
      if (turretConstructionIndex >= 0 && commanderTurrets !== null) {
        const { cos, sin } = getTransformCosSin(commander.transform);
        const mount = updateWeaponWorldKinematics(
          commander,
          commanderTurrets[turretConstructionIndex],
          turretConstructionIndex,
          cos,
          sin,
          {
            currentTick: world.getTick(),
            dtMs,
            unitGroundZ: getUnitGroundZ(commander),
            // Read the smoothed normal off the commander unit instead
            // of the position cache; updateUnitGroundNormal EMAs raw → smoothed
            // each tick so the construction emitter mount doesn't snap
            // on triangle crossings.
            surfaceN: commander.unit.surfaceNormal,
          },
          _constructionEmitterMount,
        );
        commanderSprayX = mount.x;
        commanderSprayY = mount.y;
        commanderSprayZ = mount.z;
      }

      // Get current target from queue (only work on ONE thing at a time)
      const currentTarget = this.getCurrentTarget(world, commander);
      if (!currentTarget) continue;
      const currentAction = commander.unit.actions[0];

      // Energy spending is handled by the shared energy distribution system.
      // Commander building progress is advanced there.

      if (currentAction !== undefined && currentAction.type === 'reclaim') {
        if (this.reclaimTarget(world, playerId, commander, currentTarget, dtMs)) {
          this.pushCompletedBuilding(commander.id, currentTarget.id);
        }
        continue;
      }

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

      if (currentAction !== undefined && currentAction.type === 'resurrect' && commander.commander !== null) {
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

      // Build sprays for buildables are emitted render-side (per-pylon
      // colored sprays driven by buildable.paid deltas in
      // updateBuilderConstructionEmitter), so the sim only ships heal
      // sprays — there is no renderer counterpart for those.
      if (currentTarget.unit && currentTarget.unit.hp < currentTarget.unit.maxHp) {
        // Healing a damaged unit - energy/progress handled by shared system
        // Check if fully healed
        if (currentTarget.unit.hp >= currentTarget.unit.maxHp) {
          this.pushCompletedBuilding(commander.id, currentTarget.id);
        }

        const intensity = currentTarget.unit.hp < currentTarget.unit.maxHp ? 1 : 0;
        const repairEnergyRatePerSecond =
          this.repairEnergyRates.get(repairRatePairKey(commander.id, currentTarget.id)) ?? 0;
        const spray = this.acquireSprayTarget();
        spray.source.id = commander.id;
        spray.source.pos.x = commanderSprayX;
        spray.source.pos.y = commanderSprayY;
        spray.source.z = commanderSprayZ;
        spray.source.playerId = playerId;
        spray.target.id = currentTarget.id;
        spray.target.pos.x = currentTarget.transform.x;
        spray.target.pos.y = currentTarget.transform.y;
        spray.target.z = currentTarget.transform.z;
        spray.target.radius = currentTarget.unit.radius.hitbox;
        spray.type = 'heal';
        spray.intensity = Math.max(0.1, intensity);
        spray.channel = 0;
        spray.flow = 'direct';
        spray.flowRadius = 0;
        spray.ballSpawnRate = ballSpawnRateForResourceRate(repairEnergyRatePerSecond);
      }
    }

    for (const key of this.captureProgressByPair.keys()) {
      if (!this.activeCaptureKeys.has(key)) this.captureProgressByPair.delete(key);
    }

    this.emitSpawnBeamSprays(world);

    return this.result;
  }

  // Emit the brief init beam for each freshly-created entity (registered via
  // world.registerSpawnBeam at the build/produce/launch creation sites). The
  // beam zaps from the spawning host to the new shell for a handful of ticks.
  private emitSpawnBeamSprays(world: WorldState): void {
    const beams = world.spawnBeams;
    if (beams.length === 0) return;
    const tick = world.getTick();
    for (let i = 0; i < beams.length; i++) {
      const beam = beams[i];
      if (beam.untilTick <= tick) continue;
      const source = world.getEntity(beam.sourceId);
      const target = world.getEntity(beam.targetId);
      if (source === undefined || target === undefined || source.ownership === null) continue;
      const spray = this.acquireSprayTarget();
      spray.source.id = source.id;
      spray.source.pos.x = source.transform.x;
      spray.source.pos.y = source.transform.y;
      spray.source.z = source.transform.z + SPAWN_BEAM_SOURCE_Z_BUMP;
      spray.source.playerId = source.ownership.playerId;
      spray.target.id = target.id;
      spray.target.pos.x = target.transform.x;
      spray.target.pos.y = target.transform.y;
      spray.target.z = target.transform.z;
      spray.type = 'build';
      spray.intensity = 1;
      spray.channel = 0;
      spray.flow = 'direct';
      spray.flowRadius = 0;
      spray.speed = SPAWN_BEAM_PARTICLE_SPEED;
      spray.particleRadius = SPAWN_BEAM_PARTICLE_RADIUS;
      spray.ballSpawnRate = SPAWN_BEAM_BALL_SPAWN_RATE;
    }
  }

  private rebuildRepairEnergyRateIndex(world: WorldState): void {
    this.repairEnergyRates.clear();
    const movements = world.resourceMovements;
    for (let i = 0; i < movements.length; i++) {
      const movement = movements[i];
      const sourceId = movement.sourceEntityId;
      const targetId = movement.targetEntityId;
      if (
        sourceId === null ||
        targetId === null ||
        movement.resource !== 'energy' ||
        movement.direction !== 'outbound' ||
        movement.reason !== 'repair'
      ) {
        continue;
      }
      const key = repairRatePairKey(sourceId, targetId);
      this.repairEnergyRates.set(key, (this.repairEnergyRates.get(key) ?? 0) + movement.amountPerSecond);
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

    // Only process build/repair/reclaim/resurrection actions
    if (
      currentAction.type !== 'build' &&
      currentAction.type !== 'repair' &&
      currentAction.type !== 'reclaim' &&
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

    if (currentAction.type === 'reclaim') {
      return isReclaimableTarget(target) && isBuildTargetInRange(commander, target)
        ? target
        : null;
    }

    if (currentAction.type === 'capture') {
      const playerId = commander.ownership?.playerId;
      return playerId !== undefined && isCapturableTarget(target, playerId) && isBuildTargetInRange(commander, target)
        ? target
        : null;
    }

    if (currentAction.type === 'resurrect') {
      return isResurrectableWreck(target) && isBuildTargetInRange(commander, target)
        ? target
        : null;
    }

    // Check if target is valid (incomplete building or damaged unit)
    const isValidBuilding = isBuildInProgress(target.buildable);
    const isValidUnit = target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp;

    if (!isValidBuilding && !isValidUnit) {
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
    target: Entity,
    dtMs: number,
  ): boolean {
    if (!commander.builder || !isReclaimableTarget(target)) return false;
    const hpState = target.unit ?? target.building;
    if (!hpState || hpState.hp <= 0) return false;

    const value = getReclaimResourceValue(target);
    const dtSec = dtMs / 1000;
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('CommanderAbilitiesSystem.reclaimTarget: sim-wasm is not initialized');
    }
    if (sim.commanderApplyReclaimTick(
      hpState.hp,
      hpState.maxHp,
      commander.builder.constructionRate,
      dtSec,
      value.energy,
      value.metal,
      RECLAIM_REFUND_FRACTION,
      _reclaimTickOut,
    ) === 0) {
      throw new Error('CommanderAbilitiesSystem.reclaimTarget: commander_apply_reclaim_tick rejected its output buffer');
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
    if (!commander.builder || !isCapturableTarget(target, playerId)) return false;
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
    state.progress = Math.min(1, state.progress + (commander.builder.constructionRate * dtSec) / hpState.maxHp);

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
    spray.type = 'heal';
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
    if (!commander.builder || !isResurrectableWreck(target)) return false;
    const wreck = target.wreck;
    if (wreck === null || wreck.resurrectRequiredMs <= 0) return false;

    wreck.resurrectProgressMs = Math.min(
      wreck.resurrectRequiredMs,
      wreck.resurrectProgressMs + dtMs * Math.max(0.1, commander.builder.constructionRate / 100),
    );
    const progress = wreck.resurrectProgressMs / wreck.resurrectRequiredMs;

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
    spray.type = 'heal';
    spray.intensity = Math.max(0.2, progress);
    spray.channel = 2;
    spray.flow = 'direct';
    spray.flowRadius = 0;
    spray.ballSpawnRate = 10;

    if (wreck.resurrectProgressMs < wreck.resurrectRequiredMs) return false;

    const restored = restoreUnitFromWreck(world, target, playerId);
    if (restored !== null) this.resurrectedUnits.push(restored);
    return restored !== null;
  }
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
