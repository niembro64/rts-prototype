// Energy distribution system - extracted from Simulation.ts
// Distributes energy equally among all active consumers for each player.

import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { distance } from '../math';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';

export type { EnergyBuffers, EnergyConsumer } from '@/types/ui';
import type { EnergyBuffers } from '@/types/ui';

export function createEnergyBuffers(): EnergyBuffers {
  return {
    consumers: [],
    consumersByPlayer: new Map(),
    buildTargetSet: new Set(),
    maxEnergyUseRateByTarget: new Map(),
  };
}

export function resetEnergyBuffers(buffers: EnergyBuffers): void {
  buffers.consumers.length = 0;
  buffers.consumersByPlayer.clear();
  buffers.buildTargetSet.clear();
  buffers.maxEnergyUseRateByTarget.clear();
}

// Distribute energy equally among all active consumers for each player.
// Consumers: factories producing units, buildings under construction (with builders),
// and commanders building/healing.
export function distributeEnergy(world: WorldState, dtMs: number, buffers: EnergyBuffers): void {
  const dtSec = dtMs / 1000;
  const consumers = buffers.consumers;
  consumers.length = 0;
  const byPlayer = buffers.consumersByPlayer;
  byPlayer.clear();

  const addConsumer = (playerId: PlayerId, entity: Entity, type: 'factory' | 'building' | 'heal', remainingCost: number, maxEnergyPerTick: number) => {
    const idx = consumers.length;
    consumers.push({ entity, type, remainingCost, playerId, maxEnergyPerTick });
    let arr = byPlayer.get(playerId);
    if (!arr) {
      arr = [];
      byPlayer.set(playerId, arr);
    }
    arr.push(idx);
  };

  // Single pass over all entities: collect builder targets, factories, and buildables
  const buildTargets = buffers.buildTargetSet;
  buildTargets.clear();
  const maxEnergyUseRateByTarget = buffers.maxEnergyUseRateByTarget;
  maxEnergyUseRateByTarget.clear();
  const allEntities = world.getAllEntities();

  // First pass: collect builder targets + factory consumers + build rates per target
  for (const entity of allEntities) {
    const targetId = entity.builder?.currentBuildTarget;
    if (targetId != null) {
      buildTargets.add(targetId);
      // Accumulate builder maxEnergyUseRate for this target (for non-commander building consumers)
      const rate = entity.builder!.maxEnergyUseRate;
      maxEnergyUseRateByTarget.set(targetId, (maxEnergyUseRateByTarget.get(targetId) ?? 0) + rate);
    }

    if (entity.factory?.isProducing && entity.factory.buildQueue.length > 0 &&
        entity.ownership && entity.buildable?.isComplete) {
      const f = entity.factory;
      const remaining = f.currentBuildCost * (1 - f.currentBuildProgress);
      if (remaining > 0) {
        const config = getBuildingConfig(entity.buildingType!);
        const rateCap = (config.maxEnergyUseRate ?? Infinity) * dtSec;
        addConsumer(entity.ownership.playerId, entity, 'factory', remaining, rateCap);
      }
    }
  }

  // Second pass: find buildables with assigned builders
  for (const entity of allEntities) {
    if (!entity.buildable || entity.buildable.isComplete || entity.buildable.isGhost) continue;
    if (!entity.ownership) continue;
    if (!buildTargets.has(entity.id)) continue;
    const remaining = entity.buildable.energyCost * (1 - entity.buildable.buildProgress);
    if (remaining > 0) {
      const rateCap = (maxEnergyUseRateByTarget.get(entity.id) ?? Infinity) * dtSec;
      addConsumer(entity.ownership.playerId, entity, 'building', remaining, rateCap);
    }
  }

  // 3. Commander consumers — building or healing targets
  for (const commander of world.getUnits()) {
    if (!commander.commander || !commander.builder || !commander.ownership) continue;
    if (!commander.unit || commander.unit.hp <= 0) continue;
    const actions = commander.unit.actions;
    if (actions.length === 0) continue;
    const action = actions[0];
    if (action.type !== 'build' && action.type !== 'repair') continue;

    const targetId = action.type === 'build' ? action.buildingId : action.targetId;
    if (!targetId) continue;
    const target = world.getEntity(targetId);
    if (!target) continue;

    // Check range
    const dist = distance(commander.transform.x, commander.transform.y, target.transform.x, target.transform.y);
    if (dist > commander.builder.buildRange) continue;

    const commanderRateCap = commander.builder.maxEnergyUseRate * dtSec;

    if (target.buildable && !target.buildable.isComplete && !target.buildable.isGhost) {
      // Commander building — check if this building is already registered as a construction consumer
      // If so, it gets shared energy from both sources (builder + commander = 2 consumers)
      // Actually, commander building and builder building are the same consumer (the building itself).
      // We should not double-count. Check if already added.
      let alreadyAdded = false;
      const playerIndices = byPlayer.get(commander.ownership.playerId);
      if (playerIndices) {
        for (const idx of playerIndices) {
          if (consumers[idx].entity.id === target.id && consumers[idx].type === 'building') {
            alreadyAdded = true;
            break;
          }
        }
      }
      if (!alreadyAdded) {
        const remaining = target.buildable.energyCost * (1 - target.buildable.buildProgress);
        if (remaining > 0) {
          addConsumer(commander.ownership.playerId, target, 'building', remaining, commanderRateCap);
        }
      }
    } else if (target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp) {
      // Commander healing
      const healCostPerHp = 0.5;
      const hpToHeal = target.unit.maxHp - target.unit.hp;
      const remaining = hpToHeal * healCostPerHp;
      if (remaining > 0) {
        addConsumer(commander.ownership.playerId, target, 'heal', remaining, commanderRateCap);
      }
    }
  }

  // Distribute stockpile equally among consumers for each player
  for (const [playerId, indices] of byPlayer) {
    const economy = economyManager.getEconomy(playerId);
    if (!economy || indices.length === 0) continue;

    const equalShare = economy.stockpile / indices.length;
    let totalSpent = 0;

    for (const idx of indices) {
      const c = consumers[idx];
      const energyToSpend = Math.min(equalShare, c.remainingCost, c.maxEnergyPerTick);
      totalSpent += energyToSpend;

      if (c.type === 'factory') {
        c.entity.factory!.currentBuildProgress += energyToSpend / c.entity.factory!.currentBuildCost;
      } else if (c.type === 'building') {
        c.entity.buildable!.buildProgress += energyToSpend / c.entity.buildable!.energyCost;
      } else if (c.type === 'heal') {
        // Convert energy to HP (healCostPerHp = 0.5)
        const hpHealed = energyToSpend / 0.5;
        const unit = c.entity.unit!;
        unit.hp = Math.min(unit.hp + hpHealed, unit.maxHp);
      }
    }

    economy.stockpile -= totalSpent;
    economyManager.recordExpenditure(playerId, totalSpent / dtSec);
  }
}
