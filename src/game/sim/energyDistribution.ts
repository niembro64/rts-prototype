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
import { getUnitBlueprint } from './blueprints';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_HP } from '../../types/network';
import { isBuildTargetInRange } from './builderRange';
import { getBuilderConstructionRate } from './builderBuildRoster';
import { resolveGuardServiceTarget } from './guard';
import {
  getRemainingResource,
  getTotalRemainingCost,
  isEntityActive,
  isBuildInProgress,
  isBuildBlockingActivation,
} from './buildableHelpers';
import { resourceMovementSystem, type ResourceKind } from './resourceMovement';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export type { EnergyBuffers,  } from '@/types/ui';
import type { EnergyBuffers, EnergyConsumer } from '@/types/ui';

// Construction-pylon auto-assist: pick the nearest friendly nanoframe that an
// idle builder can already reach (never move to it). Pure read — mutates no
// builder state, so it can't disturb a real build order. Deterministic:
// nearest by squared distance, ties broken by ascending entity id.
// Per-tick scratch for idle-builder auto-assist candidates (module-scoped to
// avoid per-tick allocation; distributeEnergy runs single-threaded).
const _autoAssistCandidates: Entity[] = [];

// A mobile unit factory (queen) has no building config; its per-tick build
// rate is the value authored on its construction-pylon mount, read fresh each
// tick so nothing is stored on the hashed/wired Factory component.
function factoryUnitConstructionRate(entity: Entity): number {
  if (entity.unit === null) return Infinity;
  const bp = getUnitBlueprint(entity.unit.unitBlueprintId);
  const pylon = bp.turrets.find((m) => m.constructionRate != null);
  return pylon?.constructionRate ?? Infinity;
}

function findAutoAssistTarget(builder: Entity, candidates: readonly Entity[]): Entity | null {
  const ownership = builder.ownership;
  if (ownership === null) return null;
  const ownerId = ownership.playerId;
  const bx = builder.transform.x;
  const by = builder.transform.y;
  let best: Entity | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.id === builder.id) continue;
    if (candidate.ownership === null || candidate.ownership.playerId !== ownerId) continue;
    if (!isBuildTargetInRange(builder, candidate)) continue;
    const dx = candidate.transform.x - bx;
    const dy = candidate.transform.y - by;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && candidate.id < best.id)) {
      bestDistSq = distSq;
      best = candidate;
    }
  }
  return best;
}

// Idle-builder auto-repair counterpart: nearest damaged, COMPLETE friendly unit
// already in build range, skipping any already claimed by another healer this
// tick. Same determinism rule (nearest sq dist, id tiebreak); pure read.
function findNearestDamagedUnit(
  builder: Entity,
  candidates: readonly Entity[],
  excluded: ReadonlySet<EntityId>,
): Entity | null {
  const ownership = builder.ownership;
  if (ownership === null) return null;
  const ownerId = ownership.playerId;
  const bx = builder.transform.x;
  const by = builder.transform.y;
  let best: Entity | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.id === builder.id || candidate.unit === null) continue;
    if (candidate.unit.hp <= 0 || candidate.unit.hp >= candidate.unit.maxHp) continue;
    if (isBuildInProgress(candidate.buildable)) continue; // shells fund via build, not repair
    if (candidate.ownership === null || candidate.ownership.playerId !== ownerId) continue;
    if (excluded.has(candidate.id)) continue;
    if (!isBuildTargetInRange(builder, candidate)) continue;
    const dx = candidate.transform.x - bx;
    const dy = candidate.transform.y - by;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && candidate.id < best.id)) {
      bestDistSq = distSq;
      best = candidate;
    }
  }
  return best;
}

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
    sweepServicingBuilderIds: new Set(),
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
  buffers.sweepServicingBuilderIds.clear();
}

const DEFAULT_CONSUMER_DEBIT_CAPACITY = 32;
let consumerEnergyRemaining = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerMetalRemaining = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerCaps = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerEnergySpent = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerMetalSpent = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerTypeCodes = new Uint8Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerPaidEnergy = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerPaidMetal = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerRequiredEnergy = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerRequiredMetal = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerHp = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerMaxHp = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerBuildProgress = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerEnergyRateFraction = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerMetalRateFraction = new Float64Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
let consumerChangedMask = new Uint8Array(DEFAULT_CONSUMER_DEBIT_CAPACITY);
const consumerDebitTotals = new Float64Array(2);
const CONSTRUCTION_CONSUMER_BUILD_CODE = 1;
const CONSTRUCTION_CONSUMER_HEAL_CODE = 2;
const CONSTRUCTION_CONSUMER_CHANGED_BUILD_CODE = 1;
const CONSTRUCTION_CONSUMER_CHANGED_HP_CODE = 2;
const HEAL_COST_PER_HP = 0.5;

export function trimEnergyDistributionBuffers(
  maxRetained = DEFAULT_CONSUMER_DEBIT_CAPACITY,
): void {
  if (consumerEnergyRemaining.length <= maxRetained) return;
  consumerEnergyRemaining = new Float64Array(maxRetained);
  consumerMetalRemaining = new Float64Array(maxRetained);
  consumerCaps = new Float64Array(maxRetained);
  consumerEnergySpent = new Float64Array(maxRetained);
  consumerMetalSpent = new Float64Array(maxRetained);
  consumerTypeCodes = new Uint8Array(maxRetained);
  consumerPaidEnergy = new Float64Array(maxRetained);
  consumerPaidMetal = new Float64Array(maxRetained);
  consumerRequiredEnergy = new Float64Array(maxRetained);
  consumerRequiredMetal = new Float64Array(maxRetained);
  consumerHp = new Float64Array(maxRetained);
  consumerMaxHp = new Float64Array(maxRetained);
  consumerBuildProgress = new Float64Array(maxRetained);
  consumerEnergyRateFraction = new Float64Array(maxRetained);
  consumerMetalRateFraction = new Float64Array(maxRetained);
  consumerChangedMask = new Uint8Array(maxRetained);
}

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
  const sweepServicingBuilderIds = buffers.sweepServicingBuilderIds;
  sweepServicingBuilderIds.clear();

  // Zero every factory's per-resource rate fractions up front. The
  // build-consumer loop below sets them on the factories that actually
  // funded a transfer this tick; any factory not touched stays at 0,
  // so the 3D resource-ball flow correctly reads empty when a queue
  // stalls or completes between frames.
  for (const factoryEntity of world.getFactoryBuildings().concat(world.getFactoryUnits())) {
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
  //    pass below knows how fast a building can be funded. A builder's
  //    effective build target is its direct currentBuildTarget, or — when
  //    it is GUARDING a builder/factory/nanoframe — the thing that guard
  //    target is building (BAR: guard a builder == assist its build). Both
  //    feed the same per-target accumulator, so any number of direct
  //    builders + guard-assisters sum their build power onto one nanoframe.
  // Guard-assisted factory production: builders guarding a producing factory
  // add their build power to that factory's current unit shell (keyed by
  // factory id; read by pass 2a below).
  const factoryAssistRateById = new Map<EntityId, number>();
  // Shell entity id -> the factory producing it, so the per-source build
  // breakdown can still update the factory's progress/rate fractions.
  const factoryByShellId = new Map<EntityId, EntityId>();
  // Candidate nanoframes for idle-builder auto-assist (structures only; unit
  // shells are funded by their factory + explicit guard-assist). Collected
  // once per tick; the fast path below skips the scan entirely when empty.
  const autoAssistCandidates = _autoAssistCandidates;
  autoAssistCandidates.length = 0;
  for (const structure of world.getHealthBarBuildings()) {
    if (structure.ownership !== null && isBuildInProgress(structure.buildable)) {
      autoAssistCandidates.push(structure);
    }
  }
  // Builders that auto-assisted a build this tick — excluded from auto-repair
  // so one idle builder does not split its pylons across two jobs.
  const autoAssistedBuilderIds = new Set<EntityId>();
  for (const entity of world.getBuilderUnits()) {
    const builder = entity.builder;
    if (builder === null) continue;
    const builderRate = getBuilderConstructionRate(entity);
    // While actively guarding, a builder services its guard target (BAR
    // assist) — not any stale direct build target; otherwise it funds its
    // own currentBuildTarget.
    let targetId = NO_ENTITY_ID;
    if (entity.unit !== null && entity.unit.actions[0]?.type === 'guard') {
      const svc = resolveGuardServiceTarget(world, entity);
      if (svc === null) continue;
      if (svc.kind === 'build') {
        targetId = svc.target.id;
      } else if (svc.kind === 'factory') {
        // Assist the guarded factory's current unit production.
        const factory = svc.target.factory;
        if (factory !== null && factory.currentShellId !== null && isBuildTargetInRange(entity, svc.target)) {
          factoryAssistRateById.set(
            svc.target.id,
            (factoryAssistRateById.get(svc.target.id) ?? 0) + builderRate,
          );
          addConstructionSource(buffers, factory.currentShellId, entity.id, builderRate * dtSec);
        }
        continue;
      } else {
        continue; // 'heal' is handled by the heal pass below
      }
    } else {
      targetId = builder.currentBuildTarget;
    }
    let sweepAssist = false;
    if (targetId === NO_ENTITY_ID) {
      // Idle builder with no order: its construction pylons auto-continue the
      // nearest friendly nanoframe already in build range (no movement). A
      // builder whose head order is fight/patrol services the same way as it
      // sweeps past (BAR patrol-assist); updateUnits holds it in place while
      // it funds. Builders traveling to a real build site or doing anything
      // else are never diverted.
      const head = entity.unit !== null ? entity.unit.actions[0] : undefined;
      const idle = entity.unit !== null && entity.unit.actions.length === 0;
      sweepAssist = head !== undefined && (head.type === 'fight' || head.type === 'patrol');
      if ((!idle && !sweepAssist) || autoAssistCandidates.length === 0) continue;
      const assist = findAutoAssistTarget(entity, autoAssistCandidates);
      if (assist === null) continue;
      targetId = assist.id;
      autoAssistedBuilderIds.add(entity.id);
    }
    const target = world.getEntity(targetId);
    if (!target || !isBuildTargetInRange(entity, target)) continue;
    if (sweepAssist) sweepServicingBuilderIds.add(entity.id);
    buildTargets.add(targetId);
    const rate = builderRate;
    constructionRateByTarget.set(targetId, (constructionRateByTarget.get(targetId) ?? 0) + rate);
    addConstructionSource(buffers, targetId, entity.id, rate * dtSec);
  }

  // 2a) Factories currently funding unit shells (building factories then
  //     mobile unit factories / queens).
  for (const entity of world.getFactoryBuildings().concat(world.getFactoryUnits())) {
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
          // Building factory (fabricator): rate from its building config —
          // verbatim original. Mobile unit factory (queen): rate authored on its
          // construction-pylon mount, read on the fly so the Factory component
          // (hashed + wired) is left untouched. assistRate adds guarding builders.
          const assistRate = factoryAssistRateById.get(entity.id) ?? 0;
          let capRate: number;
          let sourceRate: number;
          if (entity.buildingBlueprintId !== null) {
            const config = getBuildingConfig(entity.buildingBlueprintId);
            capRate = config.constructionRate ?? Infinity;
            sourceRate = config.constructionRate ?? 0;
          } else {
            const rate = factoryUnitConstructionRate(entity);
            capRate = rate;
            sourceRate = rate;
          }
          const rateCap = (capRate + assistRate) * dtSec;
          // Register the factory itself as a build source on the shell so the
          // shell's per-source breakdown attributes flow to the factory AND to
          // every guarding builder (added above) — each gets its own resource
          // movement, which lights up its construction emitter. Route through
          // the breakdown channel (null sourceEntityId, shell as breakdown key).
          addConstructionSource(buffers, shell.id, entity.id, sourceRate * dtSec);
          factoryByShellId.set(shell.id, entity.id);
          addConsumer(
            ownership.playerId,
            shell,
            'build',
            remainingCost,
            rateCap,
            null,
            shell.id,
          );
        }
      }
    }
  }

  // 2b) Building shells under construction, funded by builder units.
  // Use the health/build HUD cache instead of scanning every static
  // entity; construction shells are already included there.
  for (const entity of world.getHealthBarBuildings()) {
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
    const commanderRateCap = getBuilderConstructionRate(commander) * dtSec;

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

  // 4) Guarding builders heal a damaged guarded ally (BAR: a guarding
  //    builder repairs the unit it guards). Only when there is no
  //    construction to assist (that goes through the build pass above) and
  //    the target is a damaged, completed unit. One healer funds a given
  //    target per tick; HP is capped at maxHp so it never overshoots.
  const guardHealedTargetIds = new Set<EntityId>();
  for (const entity of world.getBuilderUnits()) {
    const builder = entity.builder;
    if (builder === null || entity.unit === null || entity.ownership === null) continue;
    if (entity.unit.hp <= 0 || isBuildBlockingActivation(entity.buildable)) continue;
    const svc = resolveGuardServiceTarget(world, entity);
    if (svc === null || svc.kind !== 'heal') continue; // build/factory assist handled above
    const target = svc.target;
    if (target.unit === null) continue;
    if (guardHealedTargetIds.has(target.id)) continue;
    if (!isBuildTargetInRange(entity, target)) continue;
    const remaining = (target.unit.maxHp - target.unit.hp) * HEAL_COST_PER_HP;
    if (remaining <= 0) continue;
    guardHealedTargetIds.add(target.id);
    addConsumer(
      entity.ownership.playerId,
      target,
      'heal',
      remaining,
      getBuilderConstructionRate(entity) * dtSec,
      entity.id,
      null,
    );
  }

  // 5) Idle-builder auto-repair. A builder with no order and no guard that
  //    isn't already auto-assisting a build repairs the nearest damaged,
  //    complete friendly unit already in range (BAR idle-assist; never
  //    moves). Builders whose head order is fight/patrol repair the same
  //    way as they sweep past (BAR patrol-service); updateUnits holds them
  //    while they fund. Shares guardHealedTargetIds so one target gets one
  //    healer per tick.
  const damagedUnits = world.getDamagedUnits();
  if (damagedUnits.length > 0) {
    for (const entity of world.getBuilderUnits()) {
      const builder = entity.builder;
      if (builder === null || entity.unit === null || entity.ownership === null) continue;
      if (entity.unit.hp <= 0 || isBuildBlockingActivation(entity.buildable)) continue;
      const head = entity.unit.actions[0];
      const sweepHeal = head !== undefined && (head.type === 'fight' || head.type === 'patrol');
      if (entity.unit.actions.length !== 0 && !sweepHeal) continue;
      if (builder.currentBuildTarget !== NO_ENTITY_ID) continue;
      if (autoAssistedBuilderIds.has(entity.id)) continue; // already assisting a build
      const target = findNearestDamagedUnit(entity, damagedUnits, guardHealedTargetIds);
      if (target === null || target.unit === null) continue;
      const remaining = (target.unit.maxHp - target.unit.hp) * HEAL_COST_PER_HP;
      if (remaining <= 0) continue;
      guardHealedTargetIds.add(target.id);
      if (sweepHeal) sweepServicingBuilderIds.add(entity.id);
      addConsumer(
        entity.ownership.playerId,
        target,
        'heal',
        remaining,
        getBuilderConstructionRate(entity) * dtSec,
        entity.id,
        null,
      );
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
          // Factory shells now fund through the per-source breakdown channel
          // (sourceEntityId null), so recover the producing factory from the
          // shell to keep its progress/rate fractions updated.
          const factoryId = c.sourceEntityId ?? factoryByShellId.get(c.entity.id) ?? null;
          if (factoryId !== null) {
            const factory = world.getEntity(factoryId);
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
