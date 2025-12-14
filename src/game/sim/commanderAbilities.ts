import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { economyManager } from './economy';

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

// Distance between two points
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Commander abilities system - handles build queue (ONE target at a time)
export class CommanderAbilitiesSystem {
  // Update all commanders' building and healing
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    const dtSec = dtMs / 1000;
    const sprayTargets: SprayTarget[] = [];
    const completedBuildings: { commanderId: EntityId; buildingId: EntityId }[] = [];

    // Find all commanders
    for (const commander of world.getUnits()) {
      if (!commander.commander || !commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const buildRange = commander.builder.buildRange;
      const buildRate = commander.builder.buildRate;
      const commanderX = commander.transform.x;
      const commanderY = commander.transform.y;

      // Get current target from queue (only work on ONE thing at a time)
      const currentTarget = this.getCurrentTarget(world, commander, buildRange);
      if (!currentTarget) continue;

      // Full build rate goes to the single target
      const energyNeeded = buildRate * dtSec;

      // Check what type of target this is
      if (currentTarget.buildable && !currentTarget.buildable.isComplete) {
        // Building an incomplete building
        const buildable = currentTarget.buildable;

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeeded);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Calculate progress from energy spent
          const progressGained = energySpent / buildable.energyCost;
          buildable.buildProgress += progressGained;

          // Check if complete
          if (buildable.buildProgress >= 1) {
            buildable.buildProgress = 1;
            buildable.isComplete = true;
            this.onConstructionComplete(world, currentTarget, playerId);
            completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
          }
        }

        // Always add spray effect - intensity based on energy rate
        const intensity = energyNeeded > 0 ? energySpent / energyNeeded : 0;
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
        // Healing a damaged unit
        const unit = currentTarget.unit;
        const hpToHeal = unit.maxHp - unit.hp;
        const healCostPerHp = 0.5;

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeeded);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Calculate HP healed
          const hpHealed = Math.min(energySpent / healCostPerHp, hpToHeal);
          unit.hp += hpHealed;

          // Cap at max HP
          if (unit.hp > unit.maxHp) {
            unit.hp = unit.maxHp;
          }

          // If fully healed, mark as complete so it gets removed from queue
          if (unit.hp >= unit.maxHp) {
            completedBuildings.push({ commanderId: commander.id, buildingId: currentTarget.id });
          }
        }

        // Always add spray effect - intensity based on energy rate
        const intensity = energyNeeded > 0 ? energySpent / energyNeeded : 0;
        sprayTargets.push({
          sourceId: commander.id,
          targetId: currentTarget.id,
          type: 'heal',
          sourceX: commanderX,
          sourceY: commanderY,
          targetX: currentTarget.transform.x,
          targetY: currentTarget.transform.y,
          targetRadius: unit.radius,
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
