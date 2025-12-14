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

// Commander abilities system - handles build queue and auto-heal
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

      // Get current build target from queue (only build ONE thing at a time)
      const currentBuildTarget = this.getCurrentBuildTarget(world, commander, buildRange);

      // Find factories to assist and units to heal (these are secondary, only when not building)
      const factoryTargets = currentBuildTarget ? [] : this.findFactoryTargets(world, commander, playerId, buildRange);
      const healTargets = this.findHealTargets(world, commander, playerId, buildRange);

      // Calculate targets: 1 build target (if any) + factories + heal targets
      const hasBuildTarget = currentBuildTarget !== null;
      const totalTargets = (hasBuildTarget ? 1 : 0) + factoryTargets.length + healTargets.length;
      if (totalTargets === 0) continue;

      // Energy per target per second (split evenly)
      const energyPerTargetPerSec = buildRate / totalTargets;
      const energyNeededPerTarget = energyPerTargetPerSec * dtSec;

      // Process current build target (only one at a time from queue)
      const buildable = currentBuildTarget?.buildable;
      if (currentBuildTarget && buildable) {
        const target = currentBuildTarget;

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeededPerTarget);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Calculate progress from energy spent
          const progressGained = energySpent / buildable.energyCost;
          buildable.buildProgress += progressGained;

          // Check if complete
          if (buildable.buildProgress >= 1) {
            buildable.buildProgress = 1;
            buildable.isComplete = true;
            this.onConstructionComplete(world, target, playerId);
            completedBuildings.push({ commanderId: commander.id, buildingId: target.id });
          }
        }

        // Always add spray effect - intensity based on energy rate
        const intensity = energyNeededPerTarget > 0 ? energySpent / energyNeededPerTarget : 0;
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
          intensity: Math.max(0.1, intensity),
        });
      }

      // Process factory targets (only when not building from queue)
      for (const target of factoryTargets) {
        if (!target.factory) continue;

        // Try to spend energy
        const energySpent = economyManager.trySpendEnergy(playerId, energyNeededPerTarget);
        economyManager.recordExpenditure(playerId, energySpent / dtSec);

        if (energySpent > 0) {
          // Add progress to factory's current build
          const progressGained = energySpent / target.factory.currentBuildCost;
          target.factory.currentBuildProgress += progressGained;
        }

        // Always add spray effect - intensity based on energy rate
        const intensity = energyNeededPerTarget > 0 ? energySpent / energyNeededPerTarget : 0;
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
          intensity: Math.max(0.1, intensity),
        });
      }

      // Process heal targets (always heal units in range)
      for (const target of healTargets) {
        if (!target.unit) continue;

        // Calculate healing cost
        const hpToHeal = target.unit.maxHp - target.unit.hp;
        const healCostPerHp = 0.5;

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
        }

        // Always add spray effect - intensity based on energy rate
        const intensity = energyNeededPerTarget > 0 ? energySpent / energyNeededPerTarget : 0;
        sprayTargets.push({
          sourceId: commander.id,
          targetId: target.id,
          type: 'heal',
          sourceX: commanderX,
          sourceY: commanderY,
          targetX: target.transform.x,
          targetY: target.transform.y,
          targetRadius: target.unit.radius,
          intensity: Math.max(0.1, intensity),
        });
      }
    }

    return { sprayTargets, completedBuildings };
  }

  // Get the current build target from commander's queue (first incomplete building in range)
  private getCurrentBuildTarget(
    world: WorldState,
    commander: Entity,
    buildRange: number
  ): Entity | null {
    if (!commander.commander) return null;

    const queue = commander.commander.buildQueue;
    if (queue.length === 0) return null;

    // Get the first building in queue
    const targetId = queue[0];
    const target = world.getEntity(targetId);

    // Check if target is valid and in range
    if (!target || !target.buildable || target.buildable.isComplete || target.buildable.isGhost) {
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

  // Find factories that are producing units within range
  private findFactoryTargets(
    world: WorldState,
    commander: Entity,
    playerId: PlayerId,
    range: number
  ): Entity[] {
    const targets: Entity[] = [];

    for (const building of world.getBuildings()) {
      // Only our buildings
      if (building.ownership?.playerId !== playerId) continue;

      // Only completed factories that are actively producing
      if (!building.factory || !building.buildable?.isComplete) continue;
      if (!building.factory.isProducing) continue;

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
