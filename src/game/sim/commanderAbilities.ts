import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { ENTITY_CHANGED_BUILDING } from '../../types/network';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { isBuildTargetInRange } from './builderRange';

export type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';
import type { SprayTarget, CommanderAbilitiesResult } from '@/types/ui';

// Commander abilities system - handles build queue (ONE target at a time)
export class CommanderAbilitiesSystem {
  // Update all commanders' building and healing
  update(world: WorldState, _dtMs: number): CommanderAbilitiesResult {
    const sprayTargets: SprayTarget[] = [];
    const completedBuildings: { commanderId: EntityId; buildingId: EntityId }[] = [];

    // Find all commanders
    for (const commander of world.getCommanderUnits()) {
      if (!commander.commander || !commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const commanderX = commander.transform.x;
      const commanderY = commander.transform.y;
      const constructionEmitterOffset = -commander.unit.bodyRadius * 0.42;
      const commanderSprayX = commanderX + Math.cos(commander.transform.rotation) * constructionEmitterOffset;
      const commanderSprayY = commanderY + Math.sin(commander.transform.rotation) * constructionEmitterOffset;
      const commanderSprayZ = commander.transform.z +
        (commander.unit.bodyRadius * 1.75);

      // Get current target from queue (only work on ONE thing at a time)
      const currentTarget = this.getCurrentTarget(world, commander);
      if (!currentTarget) continue;

      // Energy spending is handled by the shared energy distribution system.
      // Commander building progress is advanced there.

      // Check what type of target this is
      if (currentTarget.buildable && !currentTarget.buildable.isComplete) {
        // Building an incomplete building - check if complete (progress set by energy system)
        if (currentTarget.buildable.buildProgress >= 1) {
          currentTarget.buildable.buildProgress = 1;
          currentTarget.buildable.isComplete = true;
          world.markSnapshotDirty(currentTarget.id, ENTITY_CHANGED_BUILDING);
          this.onConstructionComplete(world, currentTarget, playerId);
          completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
        }

        // Spray effect - intensity based on whether we're actively building
        const intensity = currentTarget.buildable.buildProgress < 1 ? 1 : 0;
        const targetZ = currentTarget.building
          ? currentTarget.transform.z - currentTarget.building.depth / 2 +
            currentTarget.building.depth * Math.max(0.1, currentTarget.buildable.buildProgress)
          : currentTarget.transform.z;
        sprayTargets.push({
          source: { id: commander.id, pos: { x: commanderSprayX, y: commanderSprayY }, z: commanderSprayZ, playerId },
          target: {
            id: currentTarget.id,
            pos: { x: currentTarget.transform.x, y: currentTarget.transform.y },
            z: targetZ,
            dim: currentTarget.building ? { x: currentTarget.building.width, y: currentTarget.building.height } : undefined,
          },
          type: 'build',
          intensity: Math.max(0.1, intensity),
        });
      } else if (currentTarget.unit && currentTarget.unit.hp < currentTarget.unit.maxHp) {
        // Healing a damaged unit - energy/progress handled by shared system
        // Check if fully healed
        if (currentTarget.unit.hp >= currentTarget.unit.maxHp) {
          completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
        }

        // Spray effect
        const intensity = currentTarget.unit.hp < currentTarget.unit.maxHp ? 1 : 0;
        sprayTargets.push({
          source: { id: commander.id, pos: { x: commanderSprayX, y: commanderSprayY }, z: commanderSprayZ, playerId },
          target: {
            id: currentTarget.id,
            pos: { x: currentTarget.transform.x, y: currentTarget.transform.y },
            z: currentTarget.transform.z,
            radius: currentTarget.unit.unitRadiusCollider.shot,
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

  // Called when construction completes
  private onConstructionComplete(world: WorldState, entity: Entity, _playerId: PlayerId): void {
    applyCompletedBuildingEffects(world, entity);
    // Factory - waypoints are already set up during creation
  }
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
