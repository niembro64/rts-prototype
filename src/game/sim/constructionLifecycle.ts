// Shared construction lifecycle for both building shells and factory
// unit shells. Resource distribution owns the paid counters; this pass
// owns HP growth, paid-full completion, completion effects, and dirty
// flags so buildings and units cannot drift into separate semantics.

import type { ConstructionPieceBuildRecord, ConstructionPieceKind, Entity } from './types';
import { NO_ENTITY_ID } from './types';
import type { WorldState } from './WorldState';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import {
  cloneResourceCost,
  getBuildFraction,
  getInitialBuildHp,
  getPieceBuildFraction,
  isBuildFullyPaid,
} from './buildableHelpers';
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

export type InterruptedConstructionResult = {
  preserved: boolean;
  refund: ResourceCost;
};

type ConstructionPieceSpec = {
  id: number;
  kind: ConstructionPieceKind;
  mountIndex: number | null;
  required: ResourceCost;
  maxHp: number;
  startsAtFrameOne: boolean;
  getHp: () => number;
  setHp: (hp: number) => void;
  snapshotFields: number;
  isSubEntity: boolean;
};

function growConstructionHp(world: WorldState, entity: Entity, nextBuildFraction: number): void {
  const buildable = entity.buildable;
  if (!buildable) return;
  const frac = Math.max(0, Math.min(1, nextBuildFraction));
  if (frac !== buildable.healthBuildFraction) {
    buildable.healthBuildFraction = frac;
  }
  ensureConstructionPieceRecords(entity);
  reconcileConstructionPieceRecords(entity);
  growConstructionPieces(world, entity);
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

function resourceCostTotal(cost: ResourceCost): number {
  return Math.max(0, cost.energy) + Math.max(0, cost.metal);
}

function costHasAnyResource(cost: ResourceCost): boolean {
  return resourceCostTotal(cost) > 0;
}

function isPieceRecordComplete(piece: ConstructionPieceBuildRecord): boolean {
  return piece.paid.energy >= piece.required.energy && piece.paid.metal >= piece.required.metal;
}

function hasPaidProgress(piece: ConstructionPieceBuildRecord): boolean {
  return piece.paid.energy > 0 || piece.paid.metal > 0;
}

function getUnitConstructionPieceSpecs(entity: Entity): ConstructionPieceSpec[] {
  const unit = entity.unit;
  if (unit === null) return [];

  const unitBlueprint = getUnitBlueprint(unit.unitBlueprintId);
  const locomotionBlueprint = UNIT_LOCOMOTION_BLUEPRINTS[unit.locomotion.blueprintId];
  if (locomotionBlueprint === undefined) return [];

  const specs: ConstructionPieceSpec[] = [
    {
      id: unit.locomotion.id,
      kind: 'locomotion',
      mountIndex: 0,
      required: cloneResourceCost(locomotionBlueprint.base.cost),
      maxHp: unit.locomotion.maxHp,
      startsAtFrameOne: true,
      getHp: () => unit.locomotion.hp,
      setHp: (hp) => { unit.locomotion.hp = hp; },
      snapshotFields: ENTITY_CHANGED_ACTIONS,
      isSubEntity: true,
    },
    {
      id: entity.id,
      kind: 'body',
      mountIndex: null,
      required: cloneResourceCost(unitBlueprint.base.cost),
      maxHp: unit.maxHp,
      startsAtFrameOne: false,
      getHp: () => unit.hp,
      setHp: (hp) => { unit.hp = hp; },
      snapshotFields: ENTITY_CHANGED_HP,
      isSubEntity: false,
    },
  ];

  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      specs.push({
        id: turret.id,
        kind: 'turret',
        mountIndex: i,
        required: cloneResourceCost(getTurretBlueprint(turret.config.turretBlueprintId).base.cost),
        maxHp: turret.maxHp,
        startsAtFrameOne: false,
        getHp: () => turret.hp,
        setHp: (hp) => { turret.hp = hp; },
        snapshotFields: ENTITY_CHANGED_TURRETS,
        isSubEntity: true,
      });
    }
  }
  return specs;
}

function getStaticConstructionPieceSpecs(entity: Entity): ConstructionPieceSpec[] {
  const building = entity.building;
  if (building === null || entity.buildingBlueprintId === null) return [];

  const buildingBlueprint = getBuildingBlueprint(entity.buildingBlueprintId);
  const specs: ConstructionPieceSpec[] = [
    {
      id: entity.id,
      kind: 'body',
      mountIndex: null,
      required: cloneResourceCost(buildingBlueprint.base.cost),
      maxHp: building.maxHp,
      startsAtFrameOne: true,
      getHp: () => building.hp,
      setHp: (hp) => { building.hp = hp; },
      snapshotFields: ENTITY_CHANGED_HP,
      isSubEntity: false,
    },
  ];

  const combat = entity.combat;
  if (combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      specs.push({
        id: turret.id,
        kind: 'turret',
        mountIndex: i,
        required: cloneResourceCost(getTurretBlueprint(turret.config.turretBlueprintId).base.cost),
        maxHp: turret.maxHp,
        startsAtFrameOne: false,
        getHp: () => turret.hp,
        setHp: (hp) => { turret.hp = hp; },
        snapshotFields: ENTITY_CHANGED_TURRETS,
        isSubEntity: true,
      });
    }
  }
  return specs;
}

function getConstructionPieceSpecs(entity: Entity): ConstructionPieceSpec[] {
  if (entity.unit !== null) return getUnitConstructionPieceSpecs(entity);
  if (entity.building !== null) return getStaticConstructionPieceSpecs(entity);
  return [];
}

function scalePieceCostsToBuildableRequired(
  specs: ConstructionPieceSpec[],
  required: ResourceCost,
): ConstructionPieceSpec[] {
  let rawEnergy = 0;
  let rawMetal = 0;
  for (let i = 0; i < specs.length; i++) {
    rawEnergy += Math.max(0, specs[i].required.energy);
    rawMetal += Math.max(0, specs[i].required.metal);
  }
  const energyScale = rawEnergy > 0 ? required.energy / rawEnergy : 0;
  const metalScale = rawMetal > 0 ? required.metal / rawMetal : 0;
  return specs.map((spec) => ({
    ...spec,
    required: {
      energy: Math.max(0, spec.required.energy) * energyScale,
      metal: Math.max(0, spec.required.metal) * metalScale,
    },
  }));
}

function pieceRecordsMatchSpecs(
  pieces: ConstructionPieceBuildRecord[],
  specs: ConstructionPieceSpec[],
): boolean {
  if (pieces.length !== specs.length) return false;
  for (let i = 0; i < specs.length; i++) {
    const piece = pieces[i];
    const spec = specs[i];
    if (
      piece.id !== spec.id ||
      piece.kind !== spec.kind ||
      piece.mountIndex !== spec.mountIndex
    ) {
      return false;
    }
  }
  return true;
}

function ensureConstructionPieceRecords(entity: Entity): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return;
  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  if (pieceRecordsMatchSpecs(buildable.pieces, specs)) return;
  buildable.pieces = specs.map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    mountIndex: spec.mountIndex,
    required: cloneResourceCost(spec.required),
    paid: { energy: 0, metal: 0 },
    healthBuildFraction: 0,
    isActive: false,
    isComplete: !costHasAnyResource(spec.required),
  }));
}

function reconcileConstructionPieceRecords(entity: Entity): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.pieces.length === 0) return;
  const specs = getConstructionPieceSpecs(entity);

  let remainingEnergy = Math.max(0, buildable.paid.energy);
  let remainingMetal = Math.max(0, buildable.paid.metal);
  let dependencySatisfied = true;

  for (let i = 0; i < buildable.pieces.length; i++) {
    const piece = buildable.pieces[i];
    const paidEnergy = Math.min(piece.required.energy, remainingEnergy);
    const paidMetal = Math.min(piece.required.metal, remainingMetal);
    piece.paid.energy = paidEnergy;
    piece.paid.metal = paidMetal;
    remainingEnergy -= paidEnergy;
    remainingMetal -= paidMetal;

    piece.isComplete = isPieceRecordComplete(piece);
    const hasStarted = paidEnergy > 0 || paidMetal > 0;
    const spec = specs[i];
    piece.isActive = dependencySatisfied && (spec.startsAtFrameOne || hasStarted || piece.isComplete);
    dependencySatisfied = dependencySatisfied && piece.isComplete;
  }
}

function growConstructionPieces(world: WorldState, entity: Entity): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.pieces.length === 0) return;
  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  let changedFields = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const piece = buildable.pieces[i];
    const prevProgress = Math.max(0, Math.min(1, piece.healthBuildFraction));
    const nextProgress = piece.isActive ? getPieceBuildFraction(piece) : 0;
    const hp = advancePieceHp(
      spec.getHp(),
      spec.maxHp,
      prevProgress,
      nextProgress,
      spec.isSubEntity ? isSubEntityStillAlive(world, spec.id) : true,
      spec.startsAtFrameOne,
    );
    if (hp !== spec.getHp()) {
      spec.setHp(hp);
      changedFields |= spec.snapshotFields;
    }
    piece.healthBuildFraction = nextProgress;
    if (spec.isSubEntity) {
      world.setSubEntityMetadataTargetable(spec.id, hp > 0);
    }
  }

  world.refreshEntityMetadata(entity);

  if (changedFields !== 0) {
    world.markSnapshotDirty(entity.id, changedFields);
  }
}

function shouldPreserveInterruptedPiece(
  piece: ConstructionPieceBuildRecord,
  spec: ConstructionPieceSpec,
): boolean {
  return piece.isActive && spec.getHp() > 0 && (piece.isComplete || hasPaidProgress(piece));
}

function zeroInterruptedPiece(
  world: WorldState,
  spec: ConstructionPieceSpec,
): void {
  if (spec.getHp() !== 0) {
    spec.setHp(0);
  }
  if (spec.isSubEntity) {
    world.markSubEntityMetadataDead(spec.id);
  }
}

export function interruptConstructionPreservingBuiltPieces(
  world: WorldState,
  entity: Entity,
): InterruptedConstructionResult {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) {
    return {
      preserved: false,
      refund: { energy: 0, metal: 0 },
    };
  }

  ensureConstructionPieceRecords(entity);
  reconcileConstructionPieceRecords(entity);
  growConstructionPieces(world, entity);

  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  let preserved = false;
  let changedFields = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const piece = buildable.pieces[i];
    if (piece !== undefined && shouldPreserveInterruptedPiece(piece, spec)) {
      preserved = true;
      if (spec.isSubEntity) {
        world.setSubEntityMetadataTargetable(spec.id, true);
      }
      continue;
    }
    zeroInterruptedPiece(world, spec);
    changedFields |= spec.snapshotFields;
  }

  if (!preserved) {
    return {
      preserved: false,
      refund: cloneResourceCost(buildable.paid),
    };
  }

  world.refreshEntityMetadata(entity);
  world.markSnapshotDirty(entity.id, changedFields | ENTITY_CHANGED_BUILDING);
  return {
    preserved: true,
    refund: { energy: 0, metal: 0 },
  };
}

export function initializeConstructionPieceHealth(entity: Entity): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return;
  ensureConstructionPieceRecords(entity);
  reconcileConstructionPieceRecords(entity);
  buildable.healthBuildFraction = getBuildFraction(buildable);
  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const piece = buildable.pieces[i];
    const progress = piece.isActive ? getPieceBuildFraction(piece) : 0;
    const hp = setPieceHpForConstructionProgress(spec.maxHp, progress, spec.startsAtFrameOne);
    spec.setHp(hp);
    piece.healthBuildFraction = progress;
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
