import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { distance } from '../math';
import { economyManager } from './economy';
// Note: economyManager still used for onConstructionComplete (addProduction)

// Spray effect target info for rendering
export interface SprayTarget {
  sourceId: EntityId;       // Commander doing the building/healing
  targetId: EntityId;       // Entity being built/healed
  type: 'build' | 'heal';   // Type of spray effect
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  targetWidth?: number;     // For buildings
  targetHeight?: number;
  targetRadius?: number;    // For units
  intensity: number;        // 0-1 based on energy rate (affects particle count)
}

// Result of commander abilities update
export interface CommanderAbilitiesResult {
  sprayTargets: SprayTarget[];
  completedBuildings: { commanderId: EntityId; buildingId: EntityId }[];
}

// Commander abilities system - handles build queue (ONE target at a time)
export class CommanderAbilitiesSystem {
  // Update all commanders' building and healing
  update(world: WorldState, _dtMs: number): CommanderAbilitiesResult {
    const sprayTargets: SprayTarget[] = [];
    const completedBuildings: { commanderId: EntityId; buildingId: EntityId }[] = [];

    // Find all commanders
    for (const commander of world.getUnits()) {
      if (!commander.commander || !commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const buildRange = commander.builder.buildRange;
      const commanderX = commander.transform.x;
      const commanderY = commander.transform.y;

      // Get current target from queue (only work on ONE thing at a time)
      const currentTarget = this.getCurrentTarget(world, commander, buildRange);
      if (!currentTarget) continue;

      // Energy spending is handled by the shared energy distribution system.
      // Commander building progress is advanced there.

      // Check what type of target this is
      if (currentTarget.buildable && !currentTarget.buildable.isComplete) {
        // Building an incomplete building - check if complete (progress set by energy system)
        if (currentTarget.buildable.buildProgress >= 1) {
          currentTarget.buildable.buildProgress = 1;
          currentTarget.buildable.isComplete = true;
          this.onConstructionComplete(world, currentTarget, playerId);
          completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
        }

        // Spray effect - intensity based on whether we're actively building
        const intensity = currentTarget.buildable.buildProgress < 1 ? 1 : 0;
        sprayTargets.push({
          sourceId: commander.id,
          targetId: currentTarget.id,
          type: 'build',
          sourceX: commanderX,
          sourceY: commanderY,
          targetX: currentTarget.transform.x,
          targetY: currentTarget.transform.y,
          targetWidth: currentTarget.building?.width,
          targetHeight: currentTarget.building?.height,
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
          sourceId: commander.id,
          targetId: currentTarget.id,
          type: 'heal',
          sourceX: commanderX,
          sourceY: commanderY,
          targetX: currentTarget.transform.x,
          targetY: currentTarget.transform.y,
          targetRadius: currentTarget.unit.collisionRadius,
          intensity: Math.max(0.1, intensity),
        });
      }
    }

    return { sprayTargets, completedBuildings };
  }

  // Get the current build/repair target from commander's action queue
  private getCurrentTarget(
    world: WorldState,
    commander: Entity,
    buildRange: number
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

    // Check if in range
    const dist = distance(
      commander.transform.x,
      commander.transform.y,
      target.transform.x,
      target.transform.y
    );

    if (dist <= buildRange) {
      return target;
    }

    return null;
  }

  // Called when construction completes
  private onConstructionComplete(_world: WorldState, entity: Entity, playerId: PlayerId): void {
    // Handle building-specific completion
    if (entity.buildingType === 'solar' && entity.ownership) {
      // Solar panel - add production
      // Note: This is also handled in ConstructionSystem, but commander-built
      // buildings need it too. The ConstructionSystem checks isComplete before
      // adding production, so we need to handle it here.
      const config = this.getSolarConfig();
      if (config.energyProduction) {
        economyManager.addProduction(playerId, config.energyProduction);
      }
    }

    // Factory - waypoints are already set up during creation
  }

  // Get solar config (inline to avoid circular imports)
  private getSolarConfig() {
    return {
      energyProduction: 15,
    };
  }
}

// Singleton instance
export const commanderAbilitiesSystem = new CommanderAbilitiesSystem();
