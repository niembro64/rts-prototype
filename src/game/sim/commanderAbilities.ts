import type { WorldState } from './WorldState';
import type { Entity, EntityId } from './types';
import { isBuildTargetInRange } from './builderRange';
import { updateWeaponWorldKinematics } from './combat/combatUtils';
import { getUnitGroundZ } from './unitGeometry';

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
      const constructionTurretIndex = commander.turrets?.findIndex(
        (turret) => turret.config.id === 'constructionTurret',
      ) ?? -1;
      if (constructionTurretIndex >= 0 && commander.turrets) {
        const cos = Math.cos(commander.transform.rotation);
        const sin = Math.sin(commander.transform.rotation);
        const mount = updateWeaponWorldKinematics(
          commander,
          commander.turrets[constructionTurretIndex],
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

      // Energy spending is handled by the shared energy distribution system.
      // Commander building progress is advanced there.

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

  // Get the current build/repair target from commander's action queue
  private getCurrentTarget(
    world: WorldState,
    commander: Entity
  ): Entity | null {
    if (!commander.unit) return null;

    const actions = commander.unit.actions;
    if (actions.length === 0) return null;

    // Get the first action
    const currentAction = actions[0];

    // Only process build/repair actions
    if (currentAction.type !== 'build' && currentAction.type !== 'repair') {
      return null;
    }

    // Get the target entity
    const targetId = currentAction.type === 'build' ? currentAction.buildingId : currentAction.targetId;
    if (!targetId) return null;

    const target = world.getEntity(targetId);
    if (!target) return null;

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
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
