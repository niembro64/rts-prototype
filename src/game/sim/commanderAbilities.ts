import type { WorldState } from './WorldState';
import { NO_ENTITY_ID, type Entity, type EntityId, type PlayerId } from './types';
import { isBuildTargetInRange } from './builderRange';
import { updateWeaponWorldKinematics } from './combat/combatUtils';
import { getUnitGroundZ } from './unitGeometry';
import { getTransformCosSin } from '../math';
import { economyManager } from './economy';
import { getReclaimResourceValue, isReclaimableTarget, RECLAIM_REFUND_FRACTION } from './reclaim';
import { ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildInProgress } from './buildableHelpers';
import { ballSpawnRateForResourceRate } from '@/resourceConfig';
import { getSimWasm } from '../sim-wasm/init';

export type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';
import type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';

const _constructionEmitterMount = { x: 0, y: 0, z: 0 };
const _reclaimTickOut = new Float64Array(5);
const REPAIR_RATE_PAIR_KEY_STRIDE = 67_108_864;

type CompletedBuilding = CommanderAbilitiesResult['completedBuildings'][number];

function repairRatePairKey(sourceId: EntityId, targetId: EntityId): number {
  return sourceId * REPAIR_RATE_PAIR_KEY_STRIDE + targetId;
}

// Commander abilities system - handles build queue (ONE target at a time)
export class CommanderAbilitiesSystem {
  private readonly sprayTargets: SprayTarget[] = [];
  private readonly sprayTargetPool: SprayTarget[] = [];
  private readonly completedBuildings: CompletedBuilding[] = [];
  private readonly completedBuildingPool: CompletedBuilding[] = [];
  private readonly result: CommanderAbilitiesResult = {
    sprayTargets: this.sprayTargets,
    completedBuildings: this.completedBuildings,
  };
  private readonly repairEnergyRates = new Map<number, number>();

  // Update all commanders' building and healing
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    this.sprayTargets.length = 0;
    this.completedBuildings.length = 0;
    this.rebuildRepairEnergyRateIndex(world);

    // Find all commanders
    for (const commander of world.getCommanderUnits()) {
      if (!commander.commander || !commander.builder || !commander.ownership) continue;
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

    return this.result;
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

    // Only process build/repair/reclaim actions
    if (
      currentAction.type !== 'build' &&
      currentAction.type !== 'repair' &&
      currentAction.type !== 'reclaim'
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
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
