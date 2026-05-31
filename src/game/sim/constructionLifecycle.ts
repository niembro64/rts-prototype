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
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export type ConstructionLifecycleResult = {
  completedUnits: Entity[];
  completedBuildings: Entity[];
};

export type InterruptedConstructionResult = {
  preserved: boolean;
  refund: ResourceCost;
};

type ConstructionPieceSpec = {
  getId: () => number;
  assignId: ((id: number) => void) | null;
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

let pieceRequiredEnergy = new Float64Array(16);
let pieceRequiredMetal = new Float64Array(16);
let pieceMaxHp = new Float64Array(16);
let pieceCurrentHp = new Float64Array(16);
let piecePreviousProgress = new Float64Array(16);
let pieceStartsAtFrameOne = new Uint8Array(16);
let pieceAlive = new Uint8Array(16);
let piecePaidEnergy = new Float64Array(16);
let piecePaidMetal = new Float64Array(16);
let pieceComplete = new Uint8Array(16);
let pieceActive = new Uint8Array(16);
let pieceHp = new Float64Array(16);
let pieceProgress = new Float64Array(16);

function ensurePieceKernelCapacity(required: number): void {
  if (required <= pieceRequiredEnergy.length) return;
  let nextCapacity = pieceRequiredEnergy.length;
  while (nextCapacity < required) nextCapacity *= 2;

  pieceRequiredEnergy = new Float64Array(nextCapacity);
  pieceRequiredMetal = new Float64Array(nextCapacity);
  pieceMaxHp = new Float64Array(nextCapacity);
  pieceCurrentHp = new Float64Array(nextCapacity);
  piecePreviousProgress = new Float64Array(nextCapacity);
  pieceStartsAtFrameOne = new Uint8Array(nextCapacity);
  pieceAlive = new Uint8Array(nextCapacity);
  piecePaidEnergy = new Float64Array(nextCapacity);
  piecePaidMetal = new Float64Array(nextCapacity);
  pieceComplete = new Uint8Array(nextCapacity);
  pieceActive = new Uint8Array(nextCapacity);
  pieceHp = new Float64Array(nextCapacity);
  pieceProgress = new Float64Array(nextCapacity);
}

function requireConstructionSim(): SimWasm {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('constructionLifecycle: sim-wasm is not initialized');
  }
  return sim;
}

function growConstructionHp(world: WorldState, entity: Entity, nextBuildFraction: number): void {
  const buildable = entity.buildable;
  if (!buildable) return;
  const frac = Math.max(0, Math.min(1, nextBuildFraction));
  if (frac !== buildable.healthBuildFraction) {
    buildable.healthBuildFraction = frac;
  }
  ensureConstructionPieceRecords(entity);
  reconcileAndGrowConstructionPieces(world, entity, 'current');
}

function isSubEntityStillAlive(world: WorldState, id: number): boolean {
  if (id === NO_ENTITY_ID) return true;
  const meta = world.getEntityMeta(id);
  return meta === undefined || meta.alive;
}

function resourceCostTotal(cost: ResourceCost): number {
  return Math.max(0, cost.energy) + Math.max(0, cost.metal);
}

function costHasAnyResource(cost: ResourceCost): boolean {
  return resourceCostTotal(cost) > 0;
}

function hasPaidProgress(piece: ConstructionPieceBuildRecord): boolean {
  return piece.paid.energy > 0 || piece.paid.metal > 0;
}

function assignConstructionPieceIdentity(
  world: WorldState,
  piece: ConstructionPieceBuildRecord,
  spec: ConstructionPieceSpec,
): boolean {
  if (!spec.isSubEntity || !piece.isActive) return false;
  let id = spec.getId();
  if (id === NO_ENTITY_ID && spec.assignId !== null) {
    id = world.generateEntityId();
    spec.assignId(id);
  }
  if (id === NO_ENTITY_ID || piece.id === id) return false;
  piece.id = id;
  return true;
}

function getUnitConstructionPieceSpecs(entity: Entity): ConstructionPieceSpec[] {
  const unit = entity.unit;
  if (unit === null) return [];

  const unitBlueprint = getUnitBlueprint(unit.unitBlueprintId);
  const locomotionBlueprint = UNIT_LOCOMOTION_BLUEPRINTS[unit.locomotion.blueprintId];
  if (locomotionBlueprint === undefined) return [];

  const specs: ConstructionPieceSpec[] = [
    {
      getId: () => unit.locomotion.id,
      assignId: (id) => {
        unit.locomotion.id = id;
        unit.locomotion.parentId = entity.id;
        unit.locomotion.rootHostId = entity.id;
        unit.locomotion.mountIndex = 0;
      },
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
      getId: () => entity.id,
      assignId: null,
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
        getId: () => turret.id,
        assignId: (id) => {
          turret.id = id;
          turret.parentId = entity.id;
          turret.rootHostId = entity.id;
          turret.mountIndex = i;
        },
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
      getId: () => entity.id,
      assignId: null,
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
        getId: () => turret.id,
        assignId: (id) => {
          turret.id = id;
          turret.parentId = entity.id;
          turret.rootHostId = entity.id;
          turret.mountIndex = i;
        },
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
      piece.id !== spec.getId() ||
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
    id: spec.getId(),
    kind: spec.kind,
    mountIndex: spec.mountIndex,
    required: cloneResourceCost(spec.required),
    paid: { energy: 0, metal: 0 },
    healthBuildFraction: 0,
    isActive: false,
    isComplete: !costHasAnyResource(spec.required),
  }));
}

function reconcileAndGrowConstructionPieces(
  world: WorldState | null,
  entity: Entity,
  hpInput: 'current' | 'zero',
): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.pieces.length === 0) return;
  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  const count = Math.min(specs.length, buildable.pieces.length);
  if (count <= 0) return;

  ensurePieceKernelCapacity(count);
  let changedFields = 0;

  for (let i = 0; i < count; i++) {
    const spec = specs[i];
    const piece = buildable.pieces[i];
    pieceRequiredEnergy[i] = spec.required.energy;
    pieceRequiredMetal[i] = spec.required.metal;
    pieceMaxHp[i] = spec.maxHp;
    pieceCurrentHp[i] = hpInput === 'zero' ? 0 : spec.getHp();
    piecePreviousProgress[i] = hpInput === 'zero'
      ? 0
      : Math.max(0, Math.min(1, piece.healthBuildFraction));
    pieceStartsAtFrameOne[i] = spec.startsAtFrameOne ? 1 : 0;
    pieceAlive[i] = spec.isSubEntity && world !== null
      ? (isSubEntityStillAlive(world, spec.getId()) ? 1 : 0)
      : 1;
  }

  const sim = requireConstructionSim();
  if (sim.constructionReconcileAndGrowPieces(
    buildable.paid.energy,
    buildable.paid.metal,
    pieceRequiredEnergy,
    pieceRequiredMetal,
    pieceMaxHp,
    pieceCurrentHp,
    piecePreviousProgress,
    pieceStartsAtFrameOne,
    pieceAlive,
    count,
    piecePaidEnergy,
    piecePaidMetal,
    pieceComplete,
    pieceActive,
    pieceHp,
    pieceProgress,
  ) === 0) {
    throw new Error('constructionLifecycle: construction_reconcile_and_grow_pieces rejected its buffers');
  }

  for (let i = 0; i < count; i++) {
    const spec = specs[i];
    const piece = buildable.pieces[i];
    piece.paid.energy = piecePaidEnergy[i];
    piece.paid.metal = piecePaidMetal[i];
    piece.isComplete = pieceComplete[i] !== 0;
    piece.isActive = pieceActive[i] !== 0;
    if (world !== null && assignConstructionPieceIdentity(world, piece, spec)) {
      changedFields |= spec.snapshotFields;
    }
    const hp = pieceHp[i];
    if (hp !== spec.getHp()) {
      spec.setHp(hp);
      changedFields |= spec.snapshotFields;
    }
    piece.healthBuildFraction = pieceProgress[i];
    const pieceId = spec.getId();
    if (world !== null && spec.isSubEntity && pieceId !== NO_ENTITY_ID) {
      world.setSubEntityMetadataTargetable(pieceId, hp > 0);
    }
  }

  if (world !== null) {
    world.refreshEntityMetadata(entity);

    if (changedFields !== 0) {
      world.markSnapshotDirty(entity.id, changedFields);
    }
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
  const pieceId = spec.getId();
  if (spec.isSubEntity && pieceId !== NO_ENTITY_ID) {
    world.markSubEntityMetadataDead(pieceId);
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
  reconcileAndGrowConstructionPieces(world, entity, 'current');

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
      const pieceId = spec.getId();
      if (spec.isSubEntity && pieceId !== NO_ENTITY_ID) {
        world.setSubEntityMetadataTargetable(pieceId, true);
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
  buildable.isInterrupted = true;
  world.markSnapshotDirty(entity.id, changedFields | ENTITY_CHANGED_BUILDING);
  return {
    preserved: true,
    refund: { energy: 0, metal: 0 },
  };
}

export function initializeConstructionPieceHealth(entity: Entity, world: WorldState | null = null): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return;
  ensureConstructionPieceRecords(entity);
  buildable.healthBuildFraction = getBuildFraction(buildable);
  reconcileAndGrowConstructionPieces(world, entity, 'zero');
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
      if (!buildable || buildable.isComplete || buildable.isGhost || buildable.isInterrupted) continue;
      const buildFraction = getBuildFraction(buildable);
      growConstructionHp(world, entity, buildFraction);
      if (isConstructionAlive(entity) && isBuildFullyPaid(buildable)) {
        completeConstruction(world, entity, result);
      }
    }
  }

  return result;
}
