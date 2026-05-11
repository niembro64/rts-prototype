import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { isBuildTargetInRange } from './builderRange';
import { updateWeaponWorldKinematics } from './combat/combatUtils';
import { getUnitGroundZ } from './unitGeometry';
import { getTransformCosSin } from '../math';
import { economyManager } from './economy';
import { getReclaimResourceValue, isReclaimableTarget, RECLAIM_REFUND_FRACTION } from './reclaim';
import { ENTITY_CHANGED_HP } from '../../types/network';

export type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';
import type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';

const _constructionEmitterMount = { x: 0, y: 0, z: 0 };

// Commander abilities system - handles build queue (ONE target at a time)
export class CommanderAbilitiesSystem {
  // Update all commanders' building and healing
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    const sprayTargets: SprayTarget[] = [];
    const completedBuildings: { commanderId: EntityId; buildingId: EntityId }[] = [];

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
      const commanderTurrets = commander.combat?.turrets;
      const constructionTurretIndex = commanderTurrets?.findIndex(
        (turret) => turret.config.id === 'constructionTurret',
      ) ?? -1;
      if (constructionTurretIndex >= 0 && commanderTurrets) {
        const { cos, sin } = getTransformCosSin(commander.transform);
        const mount = updateWeaponWorldKinematics(
          commander,
          commanderTurrets[constructionTurretIndex],
          constructionTurretIndex,
          cos,
          sin,
          {
            currentTick: world.getTick(),
            dtMs,
            unitGroundZ: getUnitGroundZ(commander),
            // Read the smoothed normal off the commander unit instead
            // of the position cache; updateUnitTilt EMAs raw → smoothed
            // each tick so the construction emitter mount doesn't snap
            // on triangle crossings.
            surfaceN: commander.unit?.surfaceNormal,
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

      if (currentAction?.type === 'reclaim') {
        if (this.reclaimTarget(world, playerId, commander, currentTarget, dtMs)) {
          completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
        }
        continue;
      }

      // Build sprays for buildables are emitted render-side (per-pylon
      // colored sprays driven by buildable.paid deltas in
      // updateCommanderEmitter), so the sim only ships heal sprays —
      // there is no renderer counterpart for those.
      if (currentTarget.unit && currentTarget.unit.hp < currentTarget.unit.maxHp) {
        // Healing a damaged unit - energy/progress handled by shared system
        // Check if fully healed
        if (currentTarget.unit.hp >= currentTarget.unit.maxHp) {
          completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
        }

        const intensity = currentTarget.unit.hp < currentTarget.unit.maxHp ? 1 : 0;
        sprayTargets.push({
          source: { id: commander.id, pos: { x: commanderSprayX, y: commanderSprayY }, z: commanderSprayZ, playerId },
          target: {
            id: currentTarget.id,
            pos: { x: currentTarget.transform.x, y: currentTarget.transform.y },
            z: currentTarget.transform.z,
            radius: currentTarget.unit.radius.shot,
          },
          type: 'heal',
          intensity: Math.max(0.1, intensity),
        });
      }
    }

    return { sprayTargets, completedBuildings };
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
    const isValidBuilding = target.buildable && !target.buildable.isComplete && !target.buildable.isGhost;
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

    const hpBefore = hpState.hp;
    const maxHp = Math.max(1, hpState.maxHp);
    const hpRemoved = Math.min(hpBefore, commander.builder.constructionRate * dtMs / 1000);
    if (hpRemoved <= 0) return false;

    const value = getReclaimResourceValue(target);
    const refundScale = RECLAIM_REFUND_FRACTION * (hpRemoved / maxHp);
    economyManager.addStockpile(playerId, {
      energy: value.energy * refundScale,
      mana: value.mana * refundScale,
      metal: value.metal * refundScale,
    });

    hpState.hp = Math.max(0, hpBefore - hpRemoved);
    world.markSnapshotDirty(target.id, ENTITY_CHANGED_HP);
    return hpState.hp <= 0;
  }
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
