// Energy distribution system - extracted from Simulation.ts
// Now distributes ALL THREE resources (energy / mana / metal)
// independently among each player's active consumers. Each in-progress
// Buildable carries its own `paid.{energy,mana,metal}` accumulator and
// fills toward `required.{energy,mana,metal}`; the bar that gets less
// stockpile fills slower than the others, exactly the user-facing
// "three independent bars" intent.

import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildTargetInRange } from './builderRange';
import { getRemainingResource } from './buildableHelpers';

export type { EnergyBuffers, EnergyConsumer } from '@/types/ui';
import type { EnergyBuffers } from '@/types/ui';

export function createEnergyBuffers(): EnergyBuffers {
  return {
    consumers: [],
    consumersByPlayer: new Map(),
    buildTargetSet: new Set(),
    maxEnergyUseRateByTarget: new Map(),
    buildingConsumerIds: new Set(),
  };
}

export function resetEnergyBuffers(buffers: EnergyBuffers): void {
  buffers.consumers.length = 0;
  buffers.consumersByPlayer.clear();
  buffers.buildTargetSet.clear();
  buffers.maxEnergyUseRateByTarget.clear();
  buffers.buildingConsumerIds.clear();
}

// Distribute resources to active consumers (one player at a time).
// Consumers come in two flavours:
//   • 'build' — an in-progress Buildable being funded by a builder unit,
//               a commander, or a factory's currentShellId. The
//               consumer.entity points at the SHELL/BUILDING entity
//               carrying the buildable.
//   • 'heal'  — a commander healing a damaged unit (energy only).
export function distributeEnergy(world: WorldState, dtMs: number, buffers: EnergyBuffers): void {
  const dtSec = dtMs / 1000;
  const consumers = buffers.consumers;
  consumers.length = 0;
  const byPlayer = buffers.consumersByPlayer;
  byPlayer.clear();
  const buildingConsumerIds = buffers.buildingConsumerIds;
  buildingConsumerIds.clear();

  const addConsumer = (
    playerId: PlayerId,
    entity: Entity,
    type: 'build' | 'heal',
    remainingCost: number,
    maxEnergyPerTick: number,
  ) => {
    const idx = consumers.length;
    consumers.push({ entity, type, remainingCost, playerId, maxEnergyPerTick });
    let arr = byPlayer.get(playerId);
    if (!arr) {
      arr = [];
      byPlayer.set(playerId, arr);
    }
    arr.push(idx);
    if (type === 'build') buildingConsumerIds.add(entity.id);
  };

  const buildTargets = buffers.buildTargetSet;
  buildTargets.clear();
  const maxEnergyUseRateByTarget = buffers.maxEnergyUseRateByTarget;
  maxEnergyUseRateByTarget.clear();

  // 1) Walk builder units. Aggregate their per-target rate caps so the
  //    pass below knows how fast a building can be funded.
  for (const entity of world.getBuilderUnits()) {
    const targetId = entity.builder?.currentBuildTarget;
    if (targetId == null) continue;
    buildTargets.add(targetId);
    const rate = entity.builder!.maxEnergyUseRate;
    maxEnergyUseRateByTarget.set(targetId, (maxEnergyUseRateByTarget.get(targetId) ?? 0) + rate);
  }

  // 2) Walk buildings:
  //    • Building shells under construction (funded by builders).
  //    • Factory unit shells (currentShellId points at a unit entity).
  for (const entity of world.getBuildings()) {
    // 2a) Factory currently funding a unit shell?
    if (entity.factory?.isProducing && entity.factory.currentShellId !== null
        && entity.ownership && entity.buildable?.isComplete) {
      if (world.canPlayerBuildUnit(entity.ownership.playerId)) {
        const shell = world.getEntity(entity.factory.currentShellId);
        if (shell?.buildable && !shell.buildable.isComplete && !shell.buildable.isGhost) {
          const remainingEnergy = getRemainingResource(shell.buildable, 'energy');
          if (remainingEnergy > 0 || getRemainingResource(shell.buildable, 'mana') > 0
              || getRemainingResource(shell.buildable, 'metal') > 0) {
            const config = getBuildingConfig(entity.buildingType!);
            const rateCap = (config.maxEnergyUseRate ?? Infinity) * dtSec;
            addConsumer(entity.ownership.playerId, shell, 'build', remainingEnergy, rateCap);
          }
        }
      }
    }

    // 2b) Building under construction, funded by builder units?
    if (
      entity.buildable
      && !entity.buildable.isComplete
      && !entity.buildable.isGhost
      && entity.ownership
      && buildTargets.has(entity.id)
    ) {
      const remainingEnergy = getRemainingResource(entity.buildable, 'energy');
      if (remainingEnergy > 0 || getRemainingResource(entity.buildable, 'mana') > 0
          || getRemainingResource(entity.buildable, 'metal') > 0) {
        const rateCap = (maxEnergyUseRateByTarget.get(entity.id) ?? Infinity) * dtSec;
        addConsumer(entity.ownership.playerId, entity, 'build', remainingEnergy, rateCap);
      }
    }
  }

  // 3) Commander consumers — building or healing targets.
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
    if (!isBuildTargetInRange(commander, target)) continue;
    const commanderRateCap = commander.builder.maxEnergyUseRate * dtSec;

    if (target.buildable && !target.buildable.isComplete && !target.buildable.isGhost) {
      if (!buildingConsumerIds.has(target.id)) {
        const remainingEnergy = getRemainingResource(target.buildable, 'energy');
        if (remainingEnergy > 0 || getRemainingResource(target.buildable, 'mana') > 0
            || getRemainingResource(target.buildable, 'metal') > 0) {
          addConsumer(commander.ownership.playerId, target, 'build', remainingEnergy, commanderRateCap);
        }
      }
    } else if (target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp) {
      const healCostPerHp = 0.5;
      const hpToHeal = target.unit.maxHp - target.unit.hp;
      const remaining = hpToHeal * healCostPerHp;
      if (remaining > 0) {
        addConsumer(commander.ownership.playerId, target, 'heal', remaining, commanderRateCap);
      }
    }
  }

  // ── Per-player resource distribution ──
  // Each of the three resources flows independently. A consumer with
  // remaining > 0 in resource X pulls a share of player.X.stockpile.
  // Energy is rate-capped per consumer; mana / metal are not (they
  // saturate at remaining). When stockpile of one resource runs dry,
  // that bar pauses while the others keep filling — exactly the
  // independent-bar UX.
  for (const [playerId, indices] of byPlayer) {
    const economy = economyManager.getEconomy(playerId);
    if (!economy || indices.length === 0) continue;

    // Healing is energy-only — bookkeep separately so it doesn't
    // block mana/metal flow to other consumers.
    let buildCount = 0;
    let healCount = 0;
    for (const idx of indices) {
      if (consumers[idx].type === 'build') buildCount++;
      else healCount++;
    }
    const totalEnergyConsumers = buildCount + healCount;
    const equalEnergyShare = totalEnergyConsumers > 0
      ? economy.stockpile.curr / totalEnergyConsumers
      : 0;
    const equalManaShare = buildCount > 0 ? economy.mana.stockpile.curr / buildCount : 0;
    const equalMetalShare = buildCount > 0 ? economy.metal.stockpile.curr / buildCount : 0;

    let totalEnergySpent = 0;
    let totalManaSpent = 0;
    let totalMetalSpent = 0;

    for (const idx of indices) {
      const c = consumers[idx];
      if (c.type === 'build') {
        const buildable = c.entity.buildable;
        if (!buildable) continue;
        const remE = getRemainingResource(buildable, 'energy');
        const remM = getRemainingResource(buildable, 'mana');
        const remT = getRemainingResource(buildable, 'metal');
        const spendE = Math.min(equalEnergyShare, remE, c.maxEnergyPerTick);
        const spendM = Math.min(equalManaShare, remM);
        const spendT = Math.min(equalMetalShare, remT);
        if (spendE > 0) buildable.paid.energy += spendE;
        if (spendM > 0) buildable.paid.mana += spendM;
        if (spendT > 0) buildable.paid.metal += spendT;
        if (spendE > 0 || spendM > 0 || spendT > 0) {
          world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_BUILDING);
        }
        totalEnergySpent += spendE;
        totalManaSpent += spendM;
        totalMetalSpent += spendT;
      } else {
        // Healing — energy only.
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

    economy.stockpile.curr = Math.max(0, economy.stockpile.curr - totalEnergySpent);
    economy.mana.stockpile.curr = Math.max(0, economy.mana.stockpile.curr - totalManaSpent);
    economy.metal.stockpile.curr = Math.max(0, economy.metal.stockpile.curr - totalMetalSpent);
    economyManager.recordExpenditure(playerId, totalEnergySpent / dtSec);
    economyManager.recordManaExpenditure(playerId, totalManaSpent / dtSec);
    economyManager.recordMetalExpenditure(playerId, totalMetalSpent / dtSec);
  }
}
