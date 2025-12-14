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
}

// Result of commander abilities update
export interface CommanderAbilitiesResult {
  sprayTargets: SprayTarget[];
}

// Distance between two points
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Commander abilities system - handles auto-build and auto-heal
export class CommanderAbilitiesSystem {
  // Update all commanders' auto-build and auto-heal
  update(world: WorldState, dtMs: number): CommanderAbilitiesResult {
    const dtSec = dtMs / 1000;
    const sprayTargets: SprayTarget[] = [];

    // Find all commanders
    for (const commander of world.getUnits()) {
      if (!commander.commander || !commander.builder || !commander.ownership) continue;
      if (!commander.unit || commander.unit.hp <= 0) continue;

      const playerId = commander.ownership.playerId;
      const buildRange = commander.builder.buildRange;
      const buildRate = commander.builder.buildRate;
      const commanderX = commander.transform.x;
      const commanderY = commander.transform.y;

      // Find targets to build/heal within range
      const buildTargets = this.findBuildTargets(world, commander, playerId, buildRange);
      const healTargets = this.findHealTargets(world, commander, playerId, buildRange);

      // Calculate total targets and split energy between them
      const totalTargets = buildTargets.length + healTargets.length;
      if (totalTargets === 0) continue;

      // Energy per target per second (split evenly)
      const energyPerTargetPerSec = buildRate / totalTargets;
      const energyNeededPerTarget = energyPerTargetPerSec * dtSec;

      // Process build targets
      for (const target of buildTargets) {
        if (!target.buildable) continue;

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeededPerTarget);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Calculate progress from energy spent
          const progressGained = energySpent / target.buildable.energyCost;
          target.buildable.buildProgress += progressGained;

          // Check if complete
          if (target.buildable.buildProgress >= 1) {
            target.buildable.buildProgress = 1;
            target.buildable.isComplete = true;
            this.onConstructionComplete(world, target, playerId);
          }

          // Add spray effect
          sprayTargets.push({
            sourceId: commander.id,
            targetId: target.id,
            type: 'build',
            sourceX: commanderX,
            sourceY: commanderY,
            targetX: target.transform.x,
            targetY: target.transform.y,
            targetWidth: target.building?.width,
            targetHeight: target.building?.height,
          });
        }
      }

      // Process heal targets
      for (const target of healTargets) {
        if (!target.unit) continue;

        // Calculate healing cost (same as build - energy per HP)
        const hpToHeal = target.unit.maxHp - target.unit.hp;
        const healCostPerHp = 0.5; // Cost 0.5 energy per HP healed

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeededPerTarget);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Calculate HP healed
          const hpHealed = Math.min(energySpent / healCostPerHp, hpToHeal);
          target.unit.hp += hpHealed;

          // Cap at max HP
          if (target.unit.hp > target.unit.maxHp) {
            target.unit.hp = target.unit.maxHp;
          }

          // Add spray effect
          sprayTargets.push({
            sourceId: commander.id,
            targetId: target.id,
            type: 'heal',
            sourceX: commanderX,
            sourceY: commanderY,
            targetX: target.transform.x,
            targetY: target.transform.y,
            targetRadius: target.unit.radius,
          });
        }
      }
    }

    return { sprayTargets };
  }

  // Find buildings under construction within range
  private findBuildTargets(
    world: WorldState,
    commander: Entity,
    playerId: PlayerId,
    range: number
  ): Entity[] {
    const targets: Entity[] = [];

    for (const building of world.getBuildings()) {
      // Only our buildings
      if (building.ownership?.playerId !== playerId) continue;

      // Only buildings under construction
      if (!building.buildable || building.buildable.isComplete || building.buildable.isGhost) continue;

      // Check range
      const dist = distance(
        commander.transform.x,
        commander.transform.y,
        building.transform.x,
        building.transform.y
      );

      if (dist <= range) {
        targets.push(building);
      }
    }

    return targets;
  }

  // Find damaged friendly units within range (excluding self)
  private findHealTargets(
    world: WorldState,
    commander: Entity,
    playerId: PlayerId,
    range: number
  ): Entity[] {
    const targets: Entity[] = [];

    for (const unit of world.getUnits()) {
      // Skip self
      if (unit.id === commander.id) continue;

      // Only our units
      if (unit.ownership?.playerId !== playerId) continue;

      // Only damaged units
      if (!unit.unit || unit.unit.hp >= unit.unit.maxHp || unit.unit.hp <= 0) continue;

      // Check range
      const dist = distance(
        commander.transform.x,
        commander.transform.y,
        unit.transform.x,
        unit.transform.y
      );

      if (dist <= range) {
        targets.push(unit);
      }
    }

    return targets;
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
