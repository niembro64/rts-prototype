// Shared construction lifecycle for both building shells and factory
// unit shells. Resource distribution owns the paid counters; this pass
// owns HP growth, paid-full completion, completion effects, and dirty
// flags so buildings and units cannot drift into separate semantics.

import type { Entity } from './types';
import { NO_ENTITY_ID } from './types';
import type { WorldState } from './WorldState';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { getBuildFraction, getInitialBuildHp, isBuildFullyPaid } from './buildableHelpers';
import {
  getBuildingBlueprint,
  getTurretBlueprint,
  getUnitBlueprint,
  UNIT_LOCOMOTION_BLUEPRINTS,
} from './blueprints';
import type { ResourceCost } from '../../types/economyTypes';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_HP, ENTITY_CHANGED_TURRETS } from '../../types/network';

export type ConstructionLifecycleResult = {
  completedUnits: Entity[];
  completedBuildings: Entity[];
};

function growConstructionHp(world: WorldState, entity: Entity, nextBuildFraction: number): void {
  const buildable = entity.buildable;
  if (!buildable) return;
  const prevFrac = Math.max(0, Math.min(1, buildable.healthBuildFraction));
  const frac = Math.max(0, Math.min(1, nextBuildFraction));
  const deltaFrac = Math.max(0, frac - prevFrac);
  if (frac !== buildable.healthBuildFraction) {
    buildable.healthBuildFraction = frac;
  }
  if (deltaFrac <= 0) return;

  if (entity.unit) {
    growUnitConstructionPieces(world, entity, prevFrac, frac);
  } else if (entity.building) {
    growStaticConstructionPieces(world, entity, prevFrac, frac);
  }
}

function resourceCostWeight(cost: ResourceCost): number {
  return Math.max(0, cost.energy) + Math.max(0, cost.metal);
}

function pieceProgress(globalFraction: number, prefixWeight: number, pieceWeight: number, totalWeight: number): number {
  if (totalWeight <= 0) return 1;
  if (pieceWeight <= 0) {
    return globalFraction * totalWeight >= prefixWeight ? 1 : 0;
  }
  return Math.max(0, Math.min(1, (globalFraction * totalWeight - prefixWeight) / pieceWeight));
}

function isSubEntityStillAlive(world: WorldState, id: number): boolean {
  const meta = world.getEntityMeta(id);
  return meta === undefined || meta.alive;
}

function advancePieceHp(
  currentHp: number,
  maxHp: number,
  prevProgress: number,
  nextProgress: number,
  alive: boolean,
  startsAtFrameOne: boolean,
): number {
  if (!alive) return currentHp;
  const initialHp = getInitialBuildHp(maxHp);
  const progressDelta = Math.max(0, nextProgress - prevProgress);
  if (currentHp <= 0) {
    if (startsAtFrameOne || nextProgress > 0) {
      return Math.min(maxHp, Math.max(initialHp, nextProgress * maxHp));
    }
    return 0;
  }
  if (progressDelta <= 0) return currentHp;
  return Math.min(maxHp, currentHp + progressDelta * maxHp);
}

function setPieceHpForConstructionProgress(
  maxHp: number,
  progress: number,
  startsAtFrameOne: boolean,
): number {
  if (progress <= 0 && !startsAtFrameOne) return 0;
  return Math.min(maxHp, Math.max(getInitialBuildHp(maxHp), progress * maxHp));
}

function growUnitConstructionPieces(
  world: WorldState,
  entity: Entity,
  prevFrac: number,
  frac: number,
): void {
  const unit = entity.unit;
  if (unit === null || unit.hp <= 0) return;

  const unitBlueprint = getUnitBlueprint(unit.unitBlueprintId);
  const locomotionBlueprint = UNIT_LOCOMOTION_BLUEPRINTS[unit.locomotion.blueprintId];
  if (locomotionBlueprint === undefined) return;

  const locomotionWeight = resourceCostWeight(locomotionBlueprint.base.cost);
  const bodyWeight = resourceCostWeight(unitBlueprint.base.cost);
  let totalWeight = locomotionWeight + bodyWeight;
  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      totalWeight += resourceCostWeight(getTurretBlueprint(combat.turrets[i].config.turretBlueprintId).base.cost);
    }
  }

  let prefix = 0;
  const prevLocomotion = pieceProgress(prevFrac, prefix, locomotionWeight, totalWeight);
  const nextLocomotion = pieceProgress(frac, prefix, locomotionWeight, totalWeight);
  const locomotionHp = advancePieceHp(
    unit.locomotion.hp,
    unit.locomotion.maxHp,
    prevLocomotion,
    nextLocomotion,
    isSubEntityStillAlive(world, unit.locomotion.id),
    true,
  );
  if (locomotionHp !== unit.locomotion.hp) {
    unit.locomotion.hp = locomotionHp;
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }

  prefix += locomotionWeight;
  const prevBody = pieceProgress(prevFrac, prefix, bodyWeight, totalWeight);
  const nextBody = pieceProgress(frac, prefix, bodyWeight, totalWeight);
  const bodyHp = advancePieceHp(unit.hp, unit.maxHp, prevBody, nextBody, true, true);
  if (bodyHp !== unit.hp) {
    unit.hp = bodyHp;
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }

  prefix += bodyWeight;
  if (combat !== null) {
    let turretsChanged = false;
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      const turretWeight = resourceCostWeight(getTurretBlueprint(turret.config.turretBlueprintId).base.cost);
      const prevTurret = pieceProgress(prevFrac, prefix, turretWeight, totalWeight);
      const nextTurret = pieceProgress(frac, prefix, turretWeight, totalWeight);
      const turretHp = advancePieceHp(
        turret.hp,
        turret.maxHp,
        prevTurret,
        nextTurret,
        isSubEntityStillAlive(world, turret.id),
        false,
      );
      if (turretHp !== turret.hp) {
        turret.hp = turretHp;
        turretsChanged = true;
      }
      prefix += turretWeight;
    }
    if (turretsChanged) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_TURRETS);
  }
}

function growStaticConstructionPieces(
  world: WorldState,
  entity: Entity,
  prevFrac: number,
  frac: number,
): void {
  const building = entity.building;
  if (building === null || building.hp <= 0 || entity.buildingBlueprintId === null) return;

  const buildingBlueprint = getBuildingBlueprint(entity.buildingBlueprintId);
  const bodyWeight = resourceCostWeight(buildingBlueprint.base.cost);
  let totalWeight = bodyWeight;
  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      totalWeight += resourceCostWeight(getTurretBlueprint(combat.turrets[i].config.turretBlueprintId).base.cost);
    }
  }

  let prefix = 0;
  const prevBody = pieceProgress(prevFrac, prefix, bodyWeight, totalWeight);
  const nextBody = pieceProgress(frac, prefix, bodyWeight, totalWeight);
  const bodyHp = advancePieceHp(building.hp, building.maxHp, prevBody, nextBody, true, true);
  if (bodyHp !== building.hp) {
    building.hp = bodyHp;
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }

  prefix += bodyWeight;
  if (combat !== null) {
    let turretsChanged = false;
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      const turretWeight = resourceCostWeight(getTurretBlueprint(turret.config.turretBlueprintId).base.cost);
      const prevTurret = pieceProgress(prevFrac, prefix, turretWeight, totalWeight);
      const nextTurret = pieceProgress(frac, prefix, turretWeight, totalWeight);
      const turretHp = advancePieceHp(
        turret.hp,
        turret.maxHp,
        prevTurret,
        nextTurret,
        isSubEntityStillAlive(world, turret.id),
        false,
      );
      if (turretHp !== turret.hp) {
        turret.hp = turretHp;
        turretsChanged = true;
      }
      prefix += turretWeight;
    }
    if (turretsChanged) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_TURRETS);
  }
}

function setUnitConstructionPiecesToProgress(entity: Entity, progress: number): void {
  const unit = entity.unit;
  if (unit === null) return;

  const unitBlueprint = getUnitBlueprint(unit.unitBlueprintId);
  const locomotionBlueprint = UNIT_LOCOMOTION_BLUEPRINTS[unit.locomotion.blueprintId];
  if (locomotionBlueprint === undefined) return;

  const locomotionWeight = resourceCostWeight(locomotionBlueprint.base.cost);
  const bodyWeight = resourceCostWeight(unitBlueprint.base.cost);
  let totalWeight = locomotionWeight + bodyWeight;
  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      totalWeight += resourceCostWeight(getTurretBlueprint(combat.turrets[i].config.turretBlueprintId).base.cost);
    }
  }

  let prefix = 0;
  unit.locomotion.hp = setPieceHpForConstructionProgress(
    unit.locomotion.maxHp,
    pieceProgress(progress, prefix, locomotionWeight, totalWeight),
    true,
  );

  prefix += locomotionWeight;
  unit.hp = setPieceHpForConstructionProgress(
    unit.maxHp,
    pieceProgress(progress, prefix, bodyWeight, totalWeight),
    true,
  );

  prefix += bodyWeight;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      const turretWeight = resourceCostWeight(getTurretBlueprint(turret.config.turretBlueprintId).base.cost);
      turret.hp = setPieceHpForConstructionProgress(
        turret.maxHp,
        pieceProgress(progress, prefix, turretWeight, totalWeight),
        false,
      );
      prefix += turretWeight;
    }
  }
}

function setStaticConstructionPiecesToProgress(entity: Entity, progress: number): void {
  const building = entity.building;
  if (building === null || entity.buildingBlueprintId === null) return;

  const buildingBlueprint = getBuildingBlueprint(entity.buildingBlueprintId);
  const bodyWeight = resourceCostWeight(buildingBlueprint.base.cost);
  let totalWeight = bodyWeight;
  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      totalWeight += resourceCostWeight(getTurretBlueprint(combat.turrets[i].config.turretBlueprintId).base.cost);
    }
  }

  let prefix = 0;
  building.hp = setPieceHpForConstructionProgress(
    building.maxHp,
    pieceProgress(progress, prefix, bodyWeight, totalWeight),
    true,
  );

  prefix += bodyWeight;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      const turretWeight = resourceCostWeight(getTurretBlueprint(turret.config.turretBlueprintId).base.cost);
      turret.hp = setPieceHpForConstructionProgress(
        turret.maxHp,
        pieceProgress(progress, prefix, turretWeight, totalWeight),
        false,
      );
      prefix += turretWeight;
    }
  }
}

export function initializeConstructionPieceHealth(entity: Entity): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return;
  const progress = getBuildFraction(buildable);
  buildable.healthBuildFraction = progress;
  if (entity.unit !== null) {
    setUnitConstructionPiecesToProgress(entity, progress);
  } else if (entity.building !== null) {
    setStaticConstructionPiecesToProgress(entity, progress);
  }
}

function finishConstructionPieceHealth(entity: Entity): void {
  if (entity.unit !== null) {
    const unit = entity.unit;
    if (unit.hp > 0) unit.hp = unit.maxHp;
    if (isSubEntityHpLive(unit.locomotion.hp)) unit.locomotion.hp = unit.locomotion.maxHp;
    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        if (isSubEntityHpLive(combat.turrets[i].hp)) combat.turrets[i].hp = combat.turrets[i].maxHp;
      }
    }
  } else if (entity.building !== null) {
    const building = entity.building;
    if (building.hp > 0) building.hp = building.maxHp;
    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        if (isSubEntityHpLive(combat.turrets[i].hp)) combat.turrets[i].hp = combat.turrets[i].maxHp;
      }
    }
  }
}

function isSubEntityHpLive(hp: number): boolean {
  return hp > 0;
}

function isConstructionAlive(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

function clearDirectBuilderTargets(world: WorldState, targetId: number): void {
  for (const builder of world.getBuilderUnits()) {
    if (builder.builder === null || builder.builder.currentBuildTarget !== targetId) continue;
    builder.builder.currentBuildTarget = NO_ENTITY_ID;
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
  finishConstructionPieceHealth(entity);

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
  entity.buildable = null;
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
