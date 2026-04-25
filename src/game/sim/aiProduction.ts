// AI auto-production: queues random units at idle factories for AI players

import type { WorldState } from './WorldState';
import type { PlayerId } from './types';
import { BUILDABLE_UNIT_IDS, getNormalizedUnitCost, getUnitBlueprint } from './blueprints';
import { factoryProductionSystem } from './factoryProduction';
import { DEMO_CONFIG } from '../../demoConfig';

// Precomputed inverse-cost weights (cheaper units queued more often)
let weights: { id: string; weight: number }[] = [];
let totalWeight = 0;

function initWeights(): void {
  if (weights.length > 0) return;
  for (const id of BUILDABLE_UNIT_IDS) {
    const w = DEMO_CONFIG.aiInverseCostWeighting
      ? 1 / Math.max(getNormalizedUnitCost(getUnitBlueprint(id)), 0.01)
      : 1;
    weights.push({ id, weight: w });
    totalWeight += w;
  }
}

function pickRandomUnit(allowedTypes?: ReadonlySet<string>): string {
  initWeights();

  if (allowedTypes && allowedTypes.size > 0) {
    // Filter to allowed types
    let filteredTotal = 0;
    for (const entry of weights) {
      if (allowedTypes.has(entry.id)) filteredTotal += entry.weight;
    }
    if (filteredTotal <= 0) return weights[0].id;

    const r = Math.random() * filteredTotal;
    let cumulative = 0;
    for (const entry of weights) {
      if (!allowedTypes.has(entry.id)) continue;
      cumulative += entry.weight;
      if (r <= cumulative) return entry.id;
    }
  }

  const r = Math.random() * totalWeight;
  let cumulative = 0;
  for (const entry of weights) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry.id;
  }
  return weights[weights.length - 1].id;
}

/**
 * For each AI player, find idle factories and queue a random unit.
 * Called once per tick from Simulation.update().
 *
 * Iterates `getBuildings()` rather than `getAllEntities()` — factories
 * live on buildings, not units or projectiles, so the smaller cached
 * subset already filters out 90%+ of irrelevant entities. With a
 * thousand active projectiles in a battle, the old all-entities scan
 * paid for thousands of skip-on-`!entity.factory` iterations every
 * tick.
 */
export function updateAiProduction(
  world: WorldState,
  aiPlayerIds: ReadonlySet<PlayerId>,
  allowedTypes?: ReadonlySet<string>,
): void {
  if (aiPlayerIds.size === 0) return;

  for (const entity of world.getBuildings()) {
    if (!entity.factory || !entity.buildable?.isComplete) continue;
    if (!entity.ownership) continue;
    if (!aiPlayerIds.has(entity.ownership.playerId)) continue;

    // Queue a unit if the factory is idle and player is under cap
    if (entity.factory.buildQueue.length === 0 && world.canPlayerQueueUnit(entity.ownership.playerId)) {
      factoryProductionSystem.queueUnit(entity, pickRandomUnit(allowedTypes));
    }
  }
}
