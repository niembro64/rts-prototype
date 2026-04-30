// Energy distribution system - extracted from Simulation.ts
// Distributes energy equally among all active consumers for each player.

import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { distance3 } from '../math';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_HP } from '../../types/network';

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

  // Builder/buildable bookkeeping is split across the cached entity
  // subsets — three passes total, but each touches only the relevant
  // class of entity instead of the full getAllEntities() (which
  // includes thousands of in-flight projectiles every battle).
  const buildTargets = buffers.buildTargetSet;
  buildTargets.clear();
  const maxEnergyUseRateByTarget = buffers.maxEnergyUseRateByTarget;
  maxEnergyUseRateByTarget.clear();

  // 1) Walk builder units once. Builds the buildTargets set + rate
  //    index that pass 2 reads.
  for (const entity of world.getBuilderUnits()) {
    const targetId = entity.builder?.currentBuildTarget;
    if (targetId == null) continue;
    buildTargets.add(targetId);
    const rate = entity.builder!.maxEnergyUseRate;
    maxEnergyUseRateByTarget.set(targetId, (maxEnergyUseRateByTarget.get(targetId) ?? 0) + rate);
  }

  // 2) Walk buildings once: both factory consumers (buildings that
  //    are producing units) AND buildable consumers (buildings under
  //    construction) live on getBuildings(). One iteration handles
  //    both checks per entity.
  for (const entity of world.getBuildings()) {
    // 2a) Factory producing a unit?
    if (entity.factory?.isProducing && entity.factory.buildQueue.length > 0 &&
        entity.ownership && entity.buildable?.isComplete) {
      // Don't spend energy if player is already at or over the unit cap
      if (world.canPlayerBuildUnit(entity.ownership.playerId)) {
        const f = entity.factory;
        const remaining = f.currentBuildResourceCost * (1 - f.currentBuildProgress);
        if (remaining > 0) {
          const config = getBuildingConfig(entity.buildingType!);
          const rateCap = (config.maxEnergyUseRate ?? Infinity) * dtSec;
          addConsumer(entity.ownership.playerId, entity, 'factory', remaining, rateCap);
        }
      }
    }

    // 2b) Buildable being built by some commander?
    if (
      entity.buildable
      && !entity.buildable.isComplete
      && !entity.buildable.isGhost
      && entity.ownership
      && buildTargets.has(entity.id)
    ) {
      const remaining = entity.buildable.resourceCost * (1 - entity.buildable.buildProgress);
      if (remaining > 0) {
        const rateCap = (maxEnergyUseRateByTarget.get(entity.id) ?? Infinity) * dtSec;
        addConsumer(entity.ownership.playerId, entity, 'building', remaining, rateCap);
      }
    }
  }

  // 3. Commander consumers — building or healing targets
  for (const commander of world.getCommanderUnits()) {
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

    // Check range (3D — same altitude-aware check construction uses).
    const dist = distance3(
      commander.transform.x, commander.transform.y, commander.transform.z,
      target.transform.x, target.transform.y, target.transform.z,
    );
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
        const remaining = target.buildable.resourceCost * (1 - target.buildable.buildProgress);
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

  // Distribute stockpile equally among consumers for each player.
  // All three resources (energy, mana, metal) are spent proportionally —
  // build progress is limited by whichever resource is most scarce.
  // Each consumer's `remainingCost` is the unified resourceCost remaining
  // (same number drawn from each pool per unit of progress).
  for (const [playerId, indices] of byPlayer) {
    const economy = economyManager.getEconomy(playerId);
    if (!economy || indices.length === 0) continue;

    const equalEnergyShare = economy.stockpile.curr / indices.length;
    const equalManaShare = economy.mana.stockpile.curr / indices.length;
    const equalMetalShare = economy.metal.stockpile.curr / indices.length;
    let totalEnergySpent = 0;
    let totalManaSpent = 0;
    let totalMetalSpent = 0;

    for (const idx of indices) {
      const c = consumers[idx];

      if (c.type === 'factory' || c.type === 'building') {
        const totalCost = c.type === 'factory'
          ? c.entity.factory!.currentBuildResourceCost
          : c.entity.buildable!.resourceCost;
        const currentProgress = c.type === 'factory'
          ? c.entity.factory!.currentBuildProgress
          : c.entity.buildable!.buildProgress;
        const remaining = 1 - currentProgress;

        // Each resource pool can afford `share / cost` progress this tick.
        // The energy budget also has a per-tick rate cap and a per-consumer
        // remaining-cost cap; mana and metal share the same ticket.
        const energyAffordableSpend = Math.min(equalEnergyShare, c.remainingCost, c.maxEnergyPerTick);
        const energyProgress = totalCost > 0 ? energyAffordableSpend / totalCost : remaining;
        const manaProgress = totalCost > 0 ? equalManaShare / totalCost : remaining;
        const metalProgress = totalCost > 0 ? equalMetalShare / totalCost : remaining;
        const progress = Math.min(energyProgress, manaProgress, metalProgress, remaining);

        if (progress > 0) {
          if (c.type === 'factory') {
            c.entity.factory!.currentBuildProgress += progress;
            world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_FACTORY);
          } else {
            c.entity.buildable!.buildProgress += progress;
            world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_BUILDING);
          }
        }
        const spent = progress * totalCost;
        totalEnergySpent += spent;
        totalManaSpent += spent;
        totalMetalSpent += spent;
      } else if (c.type === 'heal') {
        // Healing only costs energy — no mana, no metal.
        const energyToSpend = Math.min(equalEnergyShare, c.remainingCost, c.maxEnergyPerTick);
        totalEnergySpent += energyToSpend;
        const hpHealed = energyToSpend / 0.5;
        const unit = c.entity.unit!;
        const nextHp = Math.min(unit.hp + hpHealed, unit.maxHp);
        if (nextHp !== unit.hp) {
          unit.hp = nextHp;
          world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_HP);
        }
      }
    }

    economy.stockpile.curr -= totalEnergySpent;
    economy.mana.stockpile.curr -= totalManaSpent;
    economy.metal.stockpile.curr -= totalMetalSpent;
    economyManager.recordExpenditure(playerId, totalEnergySpent / dtSec);
    economyManager.recordManaExpenditure(playerId, totalManaSpent / dtSec);
    economyManager.recordMetalExpenditure(playerId, totalMetalSpent / dtSec);
  }
}
