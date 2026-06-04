// Energy distribution system - extracted from Simulation.ts
// Distributes construction resources (energy / metal)
// independently among each player's active consumers. Each in-progress
// Buildable carries its own `paid` accumulator and
// fills toward `required`; the bar that gets less
// stockpile fills slower than the others, exactly the user-facing
// independent-bar intent.

import type { WorldState } from './WorldState';
import type { Entity, EntityId, PlayerId } from './types';
import { NO_ENTITY_ID } from './types';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildTargetInRange } from './builderRange';
import {
  getRemainingResource,
  getTotalRemainingCost,
  isEntityActive,
  isBuildInProgress,
} from './buildableHelpers';
import { resourceMovementSystem, type ResourceKind } from './resourceMovement';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export type { EnergyBuffers, EnergyConsumer } from '@/types/ui';
import type { EnergyBuffers, EnergyConsumer } from '@/types/ui';

export function createEnergyBuffers(): EnergyBuffers {
  return {
    consumers: [],
    consumersByPlayer: new Map(),
    buildTargetSet: new Set(),
    constructionRateByTarget: new Map(),
    constructionSourceHeadByTarget: new Map(),
    constructionSourceTailByTarget: new Map(),
    constructionSources: [],
    buildingConsumerIds: new Set(),
  };
}

export function resetEnergyBuffers(buffers: EnergyBuffers): void {
  buffers.consumers.length = 0;
  buffers.consumersByPlayer.clear();
  buffers.buildTargetSet.clear();
  buffers.constructionRateByTarget.clear();
  buffers.constructionSourceHeadByTarget.clear();
  buffers.constructionSourceTailByTarget.clear();
  buffers.constructionSources.length = 0;
  buffers.buildingConsumerIds.clear();
}

let consumerEnergyRemaining = new Float64Array(32);
let consumerMetalRemaining = new Float64Array(32);
let consumerCaps = new Float64Array(32);
let consumerEnergySpent = new Float64Array(32);
let consumerMetalSpent = new Float64Array(32);
let consumerTypeCodes = new Uint8Array(32);
let consumerPaidEnergy = new Float64Array(32);
let consumerPaidMetal = new Float64Array(32);
let consumerRequiredEnergy = new Float64Array(32);
let consumerRequiredMetal = new Float64Array(32);
let consumerHp = new Float64Array(32);
let consumerMaxHp = new Float64Array(32);
let consumerBuildProgress = new Float64Array(32);
let consumerEnergyRateFraction = new Float64Array(32);
let consumerMetalRateFraction = new Float64Array(32);
let consumerChangedMask = new Uint8Array(32);
const consumerDebitTotals = new Float64Array(2);
const CONSTRUCTION_CONSUMER_BUILD_CODE = 1;
const CONSTRUCTION_CONSUMER_HEAL_CODE = 2;
const CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE = 1;
const CONSTRUCTION_CONSUMER_CHANGED_HP_CODE = 2;
const HEAL_COST_PER_HP = 0.5;

function ensureConsumerDebitCapacity(count: number): void {
  if (count <= consumerEnergyRemaining.length) return;
  let nextCapacity = consumerEnergyRemaining.length;
  while (nextCapacity < count) nextCapacity *= 2;

  consumerEnergyRemaining = new Float64Array(nextCapacity);
  consumerMetalRemaining = new Float64Array(nextCapacity);
  consumerCaps = new Float64Array(nextCapacity);
  consumerEnergySpent = new Float64Array(nextCapacity);
  consumerMetalSpent = new Float64Array(nextCapacity);
  consumerTypeCodes = new Uint8Array(nextCapacity);
  consumerPaidEnergy = new Float64Array(nextCapacity);
  consumerPaidMetal = new Float64Array(nextCapacity);
  consumerRequiredEnergy = new Float64Array(nextCapacity);
  consumerRequiredMetal = new Float64Array(nextCapacity);
  consumerHp = new Float64Array(nextCapacity);
  consumerMaxHp = new Float64Array(nextCapacity);
  consumerBuildProgress = new Float64Array(nextCapacity);
  consumerEnergyRateFraction = new Float64Array(nextCapacity);
  consumerMetalRateFraction = new Float64Array(nextCapacity);
  consumerChangedMask = new Uint8Array(nextCapacity);
}

function addConstructionSource(
  buffers: EnergyBuffers,
  targetId: EntityId,
  sourceEntityId: EntityId,
  maxResourcePerTick: number,
): void {
  const sources = buffers.constructionSources;
  const index = sources.length;
  sources.push({ sourceEntityId, maxResourcePerTick, nextIndex: -1 });
  const tail = buffers.constructionSourceTailByTarget.get(targetId);
  if (tail === undefined) {
    buffers.constructionSourceHeadByTarget.set(targetId, index);
  } else {
    sources[tail].nextIndex = index;
  }
  buffers.constructionSourceTailByTarget.set(targetId, index);
}

function recordResourceSpendForConsumer(
  world: WorldState,
  buffers: EnergyBuffers,
  consumer: EnergyConsumer,
  resource: ResourceKind,
  spentAmount: number,
  dtSec: number,
): void {
  if (spentAmount <= 0) return;
  const amountPerSecond = dtSec > 0 ? spentAmount / dtSec : 0;
  const reason = consumer.type === 'heal' ? 'repair' : 'construction';
  if (consumer.sourceEntityId !== null) {
    resourceMovementSystem.recordAppliedDebit(world, {
      playerId: consumer.playerId,
      sourceEntityId: consumer.sourceEntityId,
      targetEntityId: consumer.entity.id,
      resource,
      amount: spentAmount,
      amountPerSecond,
      direction: 'outbound',
      reason,
    }, spentAmount);
    return;
  }

  const targetId = consumer.sourceBreakdownTargetId;
  if (targetId === null) {
    resourceMovementSystem.recordAppliedDebit(world, {
      playerId: consumer.playerId,
      sourceEntityId: null,
      targetEntityId: consumer.entity.id,
      resource,
      amount: spentAmount,
      amountPerSecond,
      direction: 'outbound',
      reason,
    }, spentAmount);
    return;
  }

  const head = buffers.constructionSourceHeadByTarget.get(targetId);
  const totalCap = consumer.maxResourcePerTick;
  if (head === undefined || totalCap <= 0) {
    resourceMovementSystem.recordAppliedDebit(world, {
      playerId: consumer.playerId,
      sourceEntityId: null,
      targetEntityId: consumer.entity.id,
      resource,
      amount: spentAmount,
      amountPerSecond,
      direction: 'outbound',
      reason,
    }, spentAmount);
    return;
  }

  let remaining = spentAmount;
  let index = head;
  while (index !== -1 && remaining > 0) {
    const source = buffers.constructionSources[index];
    const nextIndex = source.nextIndex;
    const share = nextIndex === -1
      ? remaining
      : Math.min(remaining, spentAmount * (source.maxResourcePerTick / totalCap));
    if (share > 0) {
      resourceMovementSystem.recordAppliedDebit(world, {
        playerId: consumer.playerId,
        sourceEntityId: source.sourceEntityId,
        targetEntityId: consumer.entity.id,
        resource,
        amount: share,
        amountPerSecond: dtSec > 0 ? share / dtSec : 0,
        direction: 'outbound',
        reason,
      }, share);
      remaining -= share;
    }
    index = nextIndex;
  }
}

function applyConsumerDebitLane(
  sim: SimWasm,
  remaining: Float64Array,
  caps: Float64Array,
  count: number,
  participantCount: number,
  stockpileCurr: number,
  outSpent: Float64Array,
): { totalSpent: number; nextStockpile: number } {
  if (sim.economyApplyEqualConsumerDebits(
    remaining,
    caps,
    count,
    participantCount,
    stockpileCurr,
    outSpent,
    consumerDebitTotals,
  ) === 0) {
    throw new Error('distributeEnergy: economy_apply_equal_consumer_debits rejected its buffers');
  }
  return {
    totalSpent: consumerDebitTotals[0],
    nextStockpile: consumerDebitTotals[1],
  };
}

function applyConsumerSpendResults(sim: SimWasm, count: number): void {
  if (sim.constructionApplyConsumerSpends(
    consumerTypeCodes,
    consumerPaidEnergy,
    consumerPaidMetal,
    consumerRequiredEnergy,
    consumerRequiredMetal,
    consumerHp,
    consumerMaxHp,
    consumerEnergySpent,
    consumerMetalSpent,
    consumerCaps,
    count,
    HEAL_COST_PER_HP,
    consumerBuildProgress,
    consumerEnergyRateFraction,
    consumerMetalRateFraction,
    consumerChangedMask,
  ) === 0) {
    throw new Error('distributeEnergy: construction_apply_consumer_spends rejected its buffers');
  }
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
  // so the 3D resource-ball flow correctly reads empty when a queue
  // stalls or completes between frames.
  for (const factoryEntity of world.getFactoryBuildings()) {
    const fc = factoryEntity.factory;
    if (!fc) continue;
    if (fc.energyRateFraction !== 0 || fc.metalRateFraction !== 0) {
      fc.energyRateFraction = 0;
      fc.metalRateFraction = 0;
    }
  }

  const addConsumer = (
    playerId: PlayerId,
    entity: Entity,
    type: 'build' | 'heal',
    remainingCost: number,
    maxResourcePerTick: number,
    sourceEntityId: EntityId | null,
    sourceBreakdownTargetId: EntityId | null,
  ) => {
    const idx = consumers.length;
    consumers.push({
      entity,
      type,
      sourceEntityId,
      sourceBreakdownTargetId,
      remainingCost,
      playerId,
      maxResourcePerTick,
    });
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
  buffers.constructionSourceHeadByTarget.clear();
  buffers.constructionSourceTailByTarget.clear();
  buffers.constructionSources.length = 0;

  // 1) Walk builder units. Aggregate their per-target rate caps so the
  //    pass below knows how fast a building can be funded.
  for (const entity of world.getBuilderUnits()) {
    const builder = entity.builder;
    if (builder === null) continue;
    const targetId = builder.currentBuildTarget;
    if (targetId === NO_ENTITY_ID) continue;
    const target = world.getEntity(targetId);
    if (!target || !isBuildTargetInRange(entity, target)) continue;
    buildTargets.add(targetId);
    const rate = builder.constructionRate;
    constructionRateByTarget.set(targetId, (constructionRateByTarget.get(targetId) ?? 0) + rate);
    addConstructionSource(buffers, targetId, entity.id, rate * dtSec);
  }

  // 2) Walk buildings:
  //    • Building shells under construction (funded by builders).
  //    • Factory unit shells (currentShellId points at a unit entity).
  for (const entity of world.getBuildings()) {
    // 2a) Factory currently funding a unit shell?
    const factory = entity.factory;
    const ownership = entity.ownership;
    if (factory !== null && factory.isProducing && factory.currentShellId !== null
        && ownership !== null && isEntityActive(entity)) {
      // currentShellId was admitted by factoryProduction at shell-spawn
      // time. Do not re-check the unit cap here: the incomplete shell
      // already counts as a unit, so a cap-1 spawn would otherwise starve.
      // Do not range-check the shell: factory shells drop through physics,
      // and the fabricator keeps funding its currentShellId wherever it lands.
      const shell = world.getEntity(factory.currentShellId);
      if (
        shell !== undefined &&
        shell.buildable !== null &&
        shell.ownership !== null &&
        shell.ownership.playerId === ownership.playerId &&
        isBuildInProgress(shell.buildable)
      ) {
        const remainingCost = getTotalRemainingCost(shell.buildable);
        if (remainingCost > 0) {
          const config = getBuildingConfig(entity.buildingBlueprintId!);
          const rateCap = (config.constructionRate ?? Infinity) * dtSec;
          addConsumer(
            ownership.playerId,
            shell,
            'build',
            remainingCost,
            rateCap,
            entity.id,
            null,
          );
        }
      }
    }

    // 2b) Building under construction, funded by builder units?
    if (
      isBuildInProgress(entity.buildable)
      && entity.ownership
      && buildTargets.has(entity.id)
    ) {
      const remainingCost = getTotalRemainingCost(entity.buildable);
      if (remainingCost > 0) {
        const rateCap = (constructionRateByTarget.get(entity.id) ?? Infinity) * dtSec;
        addConsumer(entity.ownership.playerId, entity, 'build', remainingCost, rateCap, null, entity.id);
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

    if (isBuildInProgress(target.buildable)) {
      if (!buildingConsumerIds.has(target.id)) {
        const remainingCost = getTotalRemainingCost(target.buildable);
        if (remainingCost > 0) {
          addConsumer(
            commander.ownership.playerId,
            target,
            'build',
            remainingCost,
            commanderRateCap,
            commander.id,
            null,
          );
        }
      }
    } else if (target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp) {
      const hpToHeal = target.unit.maxHp - target.unit.hp;
      const remaining = hpToHeal * HEAL_COST_PER_HP;
      if (remaining > 0) {
        addConsumer(
          commander.ownership.playerId,
          target,
          'heal',
          remaining,
          commanderRateCap,
          commander.id,
          null,
        );
      }
    }
  }

  // ── Per-player resource distribution ──
  // Each construction resource flows independently. A consumer with
  // remaining > 0 in resource X pulls a share of player.X.stockpile.
  // The same construction-rate cap applies to energy and metal
  // lanes, so no resource bar can burst to full just because it is not
  // energy. When stockpile of one resource runs dry, that bar pauses
  // while the others keep filling — exactly the independent-bar UX.
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('distributeEnergy: sim-wasm is not initialized');
  }

  for (const [playerId, indices] of byPlayer) {
    const economy = economyManager.getEconomy(playerId);
    if (!economy || indices.length === 0) continue;

    // Healing is energy-only — bookkeep separately so it doesn't
    // block metal flow to other consumers.
    let buildCount = 0;
    let healCount = 0;
    for (const idx of indices) {
      if (consumers[idx].type === 'build') buildCount++;
      else healCount++;
    }
    const totalEnergyConsumers = buildCount + healCount;

    ensureConsumerDebitCapacity(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const c = consumers[indices[i]];
      consumerCaps[i] = c.maxResourcePerTick;
      if (c.type === 'build') {
        const buildable = c.entity.buildable;
        consumerTypeCodes[i] = buildable === null ? 0 : CONSTRUCTION_CONSUMER_BUILD_CODE;
        consumerPaidEnergy[i] = buildable === null ? 0 : buildable.paid.energy;
        consumerPaidMetal[i] = buildable === null ? 0 : buildable.paid.metal;
        consumerRequiredEnergy[i] = buildable === null ? 0 : buildable.required.energy;
        consumerRequiredMetal[i] = buildable === null ? 0 : buildable.required.metal;
        consumerHp[i] = 0;
        consumerMaxHp[i] = 0;
        consumerEnergyRemaining[i] = buildable === null ? 0 : getRemainingResource(buildable, 'energy');
        consumerMetalRemaining[i] = buildable === null ? 0 : getRemainingResource(buildable, 'metal');
      } else {
        const unit = c.entity.unit;
        consumerTypeCodes[i] = unit === null ? 0 : CONSTRUCTION_CONSUMER_HEAL_CODE;
        consumerPaidEnergy[i] = 0;
        consumerPaidMetal[i] = 0;
        consumerRequiredEnergy[i] = 0;
        consumerRequiredMetal[i] = 0;
        consumerHp[i] = unit === null ? 0 : unit.hp;
        consumerMaxHp[i] = unit === null ? 0 : unit.maxHp;
        consumerEnergyRemaining[i] = c.remainingCost;
        consumerMetalRemaining[i] = 0;
      }
    }

    const energyDebit = applyConsumerDebitLane(
      sim,
      consumerEnergyRemaining,
      consumerCaps,
      indices.length,
      totalEnergyConsumers,
      economy.stockpile.curr,
      consumerEnergySpent,
    );
    economy.stockpile.curr = energyDebit.nextStockpile;

    const metalDebit = applyConsumerDebitLane(
      sim,
      consumerMetalRemaining,
      consumerCaps,
      indices.length,
      buildCount,
      economy.metal.stockpile.curr,
      consumerMetalSpent,
    );
    economy.metal.stockpile.curr = metalDebit.nextStockpile;

    applyConsumerSpendResults(sim, indices.length);

    for (let i = 0; i < indices.length; i++) {
      const c = consumers[indices[i]];
      if (c.type === 'build') {
        const buildable = c.entity.buildable;
        if (!buildable) continue;
        const spendE = consumerEnergySpent[i];
        const spendT = consumerMetalSpent[i];
        recordResourceSpendForConsumer(world, buffers, c, 'energy', spendE, dtSec);
        recordResourceSpendForConsumer(world, buffers, c, 'metal', spendT, dtSec);
        if ((consumerChangedMask[i] & CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE) !== 0) {
          buildable.paid.energy = consumerPaidEnergy[i];
          buildable.paid.metal = consumerPaidMetal[i];
          world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_BUILDING);
          if (c.sourceEntityId !== null) {
            const factory = world.getEntity(c.sourceEntityId);
            const factoryComp = factory === undefined ? null : factory.factory;
            if (factory !== undefined && factoryComp !== null && factoryComp.currentShellId === c.entity.id) {
              factoryComp.currentBuildProgress = consumerBuildProgress[i];
              factoryComp.energyRateFraction = consumerEnergyRateFraction[i];
              factoryComp.metalRateFraction = consumerMetalRateFraction[i];
              world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
            }
          }
        }
      } else {
        // Healing — energy only.
        const energyToSpend = consumerEnergySpent[i];
        recordResourceSpendForConsumer(world, buffers, c, 'energy', energyToSpend, dtSec);
        const unit = c.entity.unit!;
        if ((consumerChangedMask[i] & CONSTRUCTION_CONSUMER_CHANGED_HP_CODE) !== 0) {
          unit.hp = consumerHp[i];
          world.markSnapshotDirty(c.entity.id, ENTITY_CHANGED_HP);
        }
      }
    }

    if (dtSec > 0) {
      economyManager.recordExpenditure(playerId, energyDebit.totalSpent / dtSec);
      economyManager.recordMetalExpenditure(playerId, metalDebit.totalSpent / dtSec);
    }
  }
}
