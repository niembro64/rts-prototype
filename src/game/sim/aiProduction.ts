// AI auto-production: selects repeat-build units at idle factories for AI players

import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { BUILDABLE_UNIT_BLUEPRINT_IDS, getNormalizedUnitCost, getUnitBlueprint } from './blueprints';
import { factoryProductionSystem } from './factoryProduction';
import { getFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import { isEntityActive } from './buildableHelpers';
import { BACKGROUND_UNIT_SPAWN_DISTRIBUTION } from '../../config';
import { ENTITY_CHANGED_FACTORY } from '../../types/network';

// Precomputed weights for the shared background unit-generation mode.
let weights: { id: string; weight: number }[] = [];
let totalWeight = 0;

function initWeights(): void {
  if (weights.length > 0) return;
  for (const id of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    const w = BACKGROUND_UNIT_SPAWN_DISTRIBUTION === 'inverse-cost'
      ? 1 / Math.max(getNormalizedUnitCost(getUnitBlueprint(id)), 0.01)
      : 1;
    weights.push({ id, weight: w });
    totalWeight += w;
  }
}

function pickRandomUnit(
  world: WorldState,
  playerId: PlayerId,
  allowedUnitBlueprintIds: ReadonlySet<string> | null,
): string {
  initWeights();

  if (allowedUnitBlueprintIds && allowedUnitBlueprintIds.size > 0) {
    // Filter to allowed types
    let filteredTotal = 0;
    for (const entry of weights) {
      if (allowedUnitBlueprintIds.has(entry.id)) filteredTotal += entry.weight;
    }
    if (filteredTotal <= 0) return weights[0].id;

    const r = world.nextRandom(playerId) * filteredTotal;
    let cumulative = 0;
    for (const entry of weights) {
      if (!allowedUnitBlueprintIds.has(entry.id)) continue;
      cumulative += entry.weight;
      if (r <= cumulative) return entry.id;
    }
  }

  const r = world.nextRandom(playerId) * totalWeight;
  let cumulative = 0;
  for (const entry of weights) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry.id;
  }
  return weights[weights.length - 1].id;
}

/** P1-06: the roster intersection is a pure function of the factory's
 *  authored roster and the global toggle set; cache it per entity against
 *  both identities so a tick recomputes nothing while neither changed. */
const factoryAllowedCache = new WeakMap<Entity, {
  roster: readonly string[];
  global: ReadonlySet<string> | null;
  allowed: ReadonlySet<string>;
}>();

function allowedUnitsForFactory(
  entity: Entity,
  globalAllowedUnitBlueprintIds: ReadonlySet<string> | null,
): ReadonlySet<string> {
  const factoryRoster = getFactoryAllowedUnitBlueprintIds(entity);
  const cached = factoryAllowedCache.get(entity);
  if (
    cached !== undefined &&
    cached.roster === factoryRoster &&
    cached.global === globalAllowedUnitBlueprintIds
  ) {
    return cached.allowed;
  }
  const allowed = new Set<string>();
  for (const unitBlueprintId of factoryRoster) {
    if (globalAllowedUnitBlueprintIds !== null && !globalAllowedUnitBlueprintIds.has(unitBlueprintId)) continue;
    allowed.add(unitBlueprintId);
  }
  factoryAllowedCache.set(entity, {
    roster: factoryRoster,
    global: globalAllowedUnitBlueprintIds,
    allowed,
  });
  return allowed;
}

function updateAiFactoryProduction(
  world: WorldState,
  entity: Entity,
  aiPlayerIds: ReadonlySet<PlayerId>,
  allowedUnitBlueprintIds: ReadonlySet<string> | null,
): void {
  if (!entity.factory || !entity.ownership) return;
  // P1-06: a factory already producing needs no roster work at all — the
  // cheap idle test runs before discovery instead of after it.
  if (entity.factory.selectedUnitBlueprintId !== null) return;
  if (!aiPlayerIds.has(entity.ownership.playerId)) return;
  if (!isEntityActive(entity)) return;
  if (!world.canPlayerQueueEntity(entity.ownership.playerId)) return;
  const factoryAllowedUnitBlueprintIds = allowedUnitsForFactory(entity, allowedUnitBlueprintIds);
  if (factoryAllowedUnitBlueprintIds.size === 0) return;

  if (factoryProductionSystem.selectUnit(
    entity,
    pickRandomUnit(world, entity.ownership.playerId, factoryAllowedUnitBlueprintIds),
    world,
  )) {
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_FACTORY);
  }
}

/**
 * For each AI player, find idle factories and select a random repeat-build unit.
 * Called once per tick from Simulation.update().
 *
 * Iterates the cached factory subset rather than every building. AI
 * production runs every sim tick, so the branchy "is this a factory?"
 * scan should happen once when the entity cache rebuilds, not on the
 * hot tick path.
 */
export function updateAiProduction(
  world: WorldState,
  aiPlayerIds: ReadonlySet<PlayerId>,
  allowedUnitBlueprintIds: ReadonlySet<string> | null,
): void {
  if (aiPlayerIds.size === 0) return;
  // Honour an explicit empty selection — when the user has every
  // unit blueprint disabled, the AI must not produce anything. Without
  // this guard pickRandomUnit fell through to the all-weights path
  // and queued a random allowed-by-blueprint type, defeating the
  // toggle.
  if (allowedUnitBlueprintIds && allowedUnitBlueprintIds.size === 0) return;

  for (const entity of world.getFactoryBuildings()) {
    updateAiFactoryProduction(world, entity, aiPlayerIds, allowedUnitBlueprintIds);
  }
  for (const entity of world.getFactoryUnits()) {
    updateAiFactoryProduction(world, entity, aiPlayerIds, allowedUnitBlueprintIds);
  }
}
