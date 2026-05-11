// Energy distribution system - extracted from Simulation.ts
// Now distributes ALL THREE resources (energy / mana / metal)
// independently among each player's active consumers. Each in-progress
// Buildable carries its own `paid.{energy,mana,metal}` accumulator and
// fills toward `required.{energy,mana,metal}`; the bar that gets less
// stockpile fills slower than the others, exactly the user-facing
// "three independent bars" intent.

import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildTargetInRange } from './builderRange';
import {
  getBuildFraction,
  getRemainingResource,
  getTotalRemainingCost,
  isEntityActive,
} from './buildableHelpers';

export type { EnergyBuffers, EnergyConsumer } from '@/types/ui';
import type { EnergyBuffers } from '@/types/ui';

export function createEnergyBuffers(): EnergyBuffers {
  return {
    consumers: [],
    consumersByPlayer: new Map(),
    buildTargetSet: new Set(),
    constructionRateByTarget: new Map(),
    buildingConsumerIds: new Set(),
  };
}

export function resetEnergyBuffers(buffers: EnergyBuffers): void {
  buffers.consumers.length = 0;
  buffers.consumersByPlayer.clear();
  buffers.buildTargetSet.clear();
  buffers.constructionRateByTarget.clear();
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

  // Zero every factory's per-resource rate fractions up front. The
  // build-consumer loop below sets them on the factories that actually
  // funded a transfer this tick; any factory not touched stays at 0,
  // so the 3D shower cylinders correctly read empty when a queue
  // stalls or completes between frames.
  for (const factoryEntity of world.getFactoryBuildings()) {
    const fc = factoryEntity.factory;
    if (!fc) continue;
    if (fc.energyRateFraction !== 0 || fc.manaRateFraction !== 0 || fc.metalRateFraction !== 0) {
      fc.energyRateFraction = 0;
      fc.manaRateFraction = 0;
      fc.metalRateFraction = 0;
    }
  }

  const addConsumer = (
    playerId: PlayerId,
    entity: Entity,
    type: 'build' | 'heal',
    remainingCost: number,
    maxResourcePerTick: number,
    sourceFactoryId?: EntityId,
  ) => {
    const idx = consumers.length;
    consumers.push({ entity, type, sourceFactoryId, remainingCost, playerId, maxResourcePerTick });
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
  const constructionRateByTarget = buffers.constructionRateByTarget;
  constructionRateByTarget.clear();

  // 1) Walk builder units. Aggregate their per-target rate caps so the
  //    pass below knows how fast a building can be funded.
  for (const entity of world.getBuilderUnits()) {
    const targetId = entity.builder?.currentBuildTarget;
    if (targetId == null) continue;
    buildTargets.add(targetId);
    const rate = entity.builder!.constructionRate;
    constructionRateByTarget.set(targetId, (constructionRateByTarget.get(targetId) ?? 0) + rate);
  }

  // 2) Walk buildings:
  //    • Building shells under construction (funded by builders).
  //    • Factory unit shells (currentShellId points at a unit entity).
  for (const entity of world.getBuildings()) {
    // 2a) Factory currently funding a unit shell?
    if (entity.factory?.isProducing && entity.factory.currentShellId !== null
        && entity.ownership && isEntityActive(entity)) {
      // currentShellId was admitted by factoryProduction at shell-spawn
      // time. Do not re-check the unit cap here: the incomplete shell
      // already counts as a unit, so a cap-1 spawn would otherwise starve.
      const shell = world.getEntity(entity.factory.currentShellId);
      if (
        shell?.buildable &&
        shell.ownership?.playerId === entity.ownership.playerId &&
        !shell.buildable.isComplete &&
        !shell.buildable.isGhost
      ) {
        const remainingCost = getTotalRemainingCost(shell.buildable);
        if (remainingCost > 0) {
          const config = getBuildingConfig(entity.buildingType!);
          const rateCap = (config.constructionRate ?? Infinity) * dtSec;
          addConsumer(
            entity.ownership.playerId,
            shell,
            'build',
            remainingCost,
            rateCap,
            entity.id,
          );
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
      const remainingCost = getTotalRemainingCost(entity.buildable);
      if (remainingCost > 0) {
        const rateCap = (constructionRateByTarget.get(entity.id) ?? Infinity) * dtSec;
        addConsumer(entity.ownership.playerId, entity, 'build', remainingCost, rateCap);
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
    const commanderRateCap = commander.builder.constructionRate * dtSec;

    if (target.buildable && !target.buildable.isComplete && !target.buildable.isGhost) {
      if (!buildingConsumerIds.has(target.id)) {
        const remainingCost = getTotalRemainingCost(target.buildable);
        if (remainingCost > 0) {
          addConsumer(
            commander.ownership.playerId,
            target,
            'build',
            remainingCost,
            commanderRateCap,
          );
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
  // The same construction-rate cap applies to energy, mana, and metal
  // lanes, so no resource bar can burst to full just because it is not
  // energy. When stockpile of one resource runs dry, that bar pauses
  // while the others keep filling — exactly the independent-bar UX.
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
        const spendE = Math.min(equalEnergyShare, remE, c.maxResourcePerTick);
        const spendM = Math.min(equalManaShare, remM, c.maxResourcePerTick);
        const spendT = Math.min(equalMetalShare, remT, c.maxResourcePerTick);
        if (spendE > 0) buildable.paid.energy += spendE;
        if (spendM > 0) buildable.paid.mana += spendM;
        if (spendT > 0) buildable.paid.metal += spendT;
        if (spendE > 0 || spendM > 0 || spendT > 0) {
          world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_BUILDING);
          if (c.sourceFactoryId !== undefined) {
            const factory = world.getEntity(c.sourceFactoryId);
            if (factory?.factory?.currentShellId === c.entity.id) {
              factory.factory.currentBuildProgress = getBuildFraction(buildable);
              // Per-resource transfer-rate fractions for the 3D
              // "shower" cylinders. spendX <= maxResourcePerTick by
              // construction so the divide is always 0..1.
              const cap = c.maxResourcePerTick;
              if (cap > 0) {
                factory.factory.energyRateFraction = spendE / cap;
                factory.factory.manaRateFraction = spendM / cap;
                factory.factory.metalRateFraction = spendT / cap;
              } else {
                factory.factory.energyRateFraction = 0;
                factory.factory.manaRateFraction = 0;
                factory.factory.metalRateFraction = 0;
              }
              world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
            }
          }
        }
        totalEnergySpent += spendE;
        totalManaSpent += spendM;
        totalMetalSpent += spendT;
      } else {
        // Healing — energy only.
        const energyToSpend = Math.min(equalEnergyShare, c.remainingCost, c.maxResourcePerTick);
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
