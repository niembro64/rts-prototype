// Shared construction lifecycle for both building shells and factory
// unit shells. Resource distribution owns the paid counters; this pass
// owns HP growth, paid-full completion, completion effects, and dirty
// flags so buildings and units cannot drift into separate semantics.

import type { Entity } from './types';
import type { WorldState } from './WorldState';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { getBuildFraction, isBuildFullyPaid } from './buildableHelpers';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_HP } from '../../types/network';

export type ConstructionLifecycleResult = {
  completedUnits: Entity[];
  completedBuildings: Entity[];
};

function growConstructionHp(world: WorldState, entity: Entity, nextBuildFraction: number): void {
  const buildable = entity.buildable;
  if (!buildable) return;
  const prevFrac = Math.max(0, Math.min(1, buildable.healthBuildFraction ?? 0));
  const frac = Math.max(0, Math.min(1, nextBuildFraction));
  const deltaFrac = Math.max(0, frac - prevFrac);
  if (frac !== buildable.healthBuildFraction) {
    buildable.healthBuildFraction = frac;
  }
  if (deltaFrac <= 0) return;

  if (entity.unit && entity.unit.hp > 0) {
    const nextHp = Math.min(entity.unit.maxHp, entity.unit.hp + deltaFrac * entity.unit.maxHp);
    if (nextHp !== entity.unit.hp) {
      entity.unit.hp = nextHp;
      world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
    }
  } else if (entity.building && entity.building.hp > 0) {
    const nextHp = Math.min(entity.building.maxHp, entity.building.hp + deltaFrac * entity.building.maxHp);
    if (nextHp !== entity.building.hp) {
      entity.building.hp = nextHp;
      world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
    }
  }
}

function isConstructionAlive(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

function clearDirectBuilderTargets(world: WorldState, targetId: number): void {
  for (const builder of world.getBuilderUnits()) {
    if (builder.builder?.currentBuildTarget !== targetId) continue;
    builder.builder.currentBuildTarget = null;
    world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
  }
}

function completeConstruction(
  world: WorldState,
  entity: Entity,
  result: ConstructionLifecycleResult,
): void {
  const buildable = entity.buildable;
  if (!buildable || buildable.isComplete || buildable.isGhost) return;
  buildable.paid = { ...buildable.required };
  buildable.isComplete = true;
  buildable.healthBuildFraction = 1;

  if (entity.building) {
    applyCompletedBuildingEffects(world, entity);
    clearDirectBuilderTargets(world, entity.id);
    result.completedBuildings.push(entity);
  } else if (entity.unit) {
    result.completedUnits.push(entity);
  }

  // Buildable is the "currently under construction" component. Once
  // activation effects have run, remove it so completed entities do
  // not carry stale construction history through sim/render/network.
  delete entity.buildable;
  world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

export function updateConstructionLifecycle(world: WorldState): ConstructionLifecycleResult {
  const result: ConstructionLifecycleResult = {
    completedUnits: [],
    completedBuildings: [],
  };
  const sources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];

  for (const list of sources) {
    for (const entity of list) {
      const buildable = entity.buildable;
      if (!buildable || buildable.isComplete || buildable.isGhost) continue;
      const buildFraction = getBuildFraction(buildable);
      growConstructionHp(world, entity, buildFraction);
      if (isConstructionAlive(entity) && isBuildFullyPaid(buildable)) {
        completeConstruction(world, entity, result);
      }
    }
  }

  return result;
}
