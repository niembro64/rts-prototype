// AI auto-production: selects repeat-build units at idle factories for AI players

import type { WorldState } from './WorldState';
import type { PlayerId } from './types';
import { BUILDABLE_UNIT_BLUEPRINT_IDS, getNormalizedUnitCost, getUnitBlueprint } from './blueprints';
import { factoryProductionSystem } from './factoryProduction';
import { getFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import { isEntityActive } from './buildableHelpers';
import { DEMO_CONFIG } from '../../demoConfig';
import { ENTITY_CHANGED_FACTORY } from '../../types/network';

// Precomputed inverse-cost weights (cheaper units queued more often)
let weights: { id: string; weight: number }[] = [];
let totalWeight = 0;

function initWeights(): void {
  if (weights.length > 0) return;
  for (const id of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    const w = DEMO_CONFIG.aiInverseCostWeighting
      ? 1 / Math.max(getNormalizedUnitCost(getUnitBlueprint(id)), 0.01)
      : 1;
    weights.push({ id, weight: w });
    totalWeight += w;
  }
}

function pickRandomUnit(world: WorldState, allowedUnitBlueprintIds: ReadonlySet<string> | null): string {
  initWeights();

  if (allowedUnitBlueprintIds && allowedUnitBlueprintIds.size > 0) {
    // Filter to allowed types
    let filteredTotal = 0;
    for (const entry of weights) {
      if (allowedUnitBlueprintIds.has(entry.id)) filteredTotal += entry.weight;
    }
    if (filteredTotal <= 0) return weights[0].id;

    const r = world.rng.next() * filteredTotal;
    let cumulative = 0;
    for (const entry of weights) {
      if (!allowedUnitBlueprintIds.has(entry.id)) continue;
      cumulative += entry.weight;
      if (r <= cumulative) return entry.id;
    }
  }

  const r = world.rng.next() * totalWeight;
  let cumulative = 0;
  for (const entry of weights) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry.id;
  }
  return weights[weights.length - 1].id;
}

function allowedUnitsForFactory(
  factory: Parameters<typeof getFactoryAllowedUnitBlueprintIds>[0],
  globalAllowedUnitBlueprintIds: ReadonlySet<string> | null,
): ReadonlySet<string> {
  const factoryRoster = getFactoryAllowedUnitBlueprintIds(factory);
  const allowed = new Set<string>();
  for (const unitBlueprintId of factoryRoster) {
    if (globalAllowedUnitBlueprintIds !== null && !globalAllowedUnitBlueprintIds.has(unitBlueprintId)) continue;
    allowed.add(unitBlueprintId);
  }
  return allowed;
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
    if (!entity.factory || !isEntityActive(entity)) continue;
    if (!entity.ownership) continue;
    if (!aiPlayerIds.has(entity.ownership.playerId)) continue;
    const factoryAllowedUnitBlueprintIds = allowedUnitsForFactory(entity, allowedUnitBlueprintIds);
    if (factoryAllowedUnitBlueprintIds.size === 0) continue;

    // Pick a repeat-build type for the factory if it has none set.
    if (entity.factory.selectedUnitBlueprintId === null && world.canPlayerQueueUnit(entity.ownership.playerId)) {
      if (factoryProductionSystem.selectUnit(entity, pickRandomUnit(world, factoryAllowedUnitBlueprintIds), world)) {
        world.markSnapshotDirty(entity.id, ENTITY_CHANGED_FACTORY);
      }
    }
  }
}
