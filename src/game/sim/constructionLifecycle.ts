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
  getUnitBlueprint,
} from './blueprints';
import type { ResourceCost } from '../../types/economyTypes';
import { ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_HP } from '../../types/network';
import { BUILD_CONFIG } from '../../buildConfig';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

type ConstructionLifecycleResult = {
  completedUnits: Entity[];
  completedBuildings: Entity[];
  /** Shells that rotted all the way back to zero progress this tick. The
   *  caller removes them; a decayed frame is not a death, so it produces no
   *  explosion, wreck, or death event. */
  decayedBuildings: Entity[];
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

  const specs: ConstructionPieceSpec[] = [
    {
      getId: () => entity.id,
      assignId: null,
      kind: 'body',
      mountIndex: null,
      required: cloneResourceCost(unitBlueprint.base.cost),
      maxHp: unit.maxHp,
      startsAtFrameOne: true,
      getHp: () => unit.hp,
      setHp: (hp) => { unit.hp = hp; },
      snapshotFields: ENTITY_CHANGED_HP,
      isSubEntity: false,
    },
  ];

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
  const scaled = new Array<ConstructionPieceSpec>(specs.length);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    scaled[i] = {
      ...spec,
      required: {
        energy: Math.max(0, spec.required.energy) * energyScale,
        metal: Math.max(0, spec.required.metal) * metalScale,
      },
    };
  }
  return scaled;
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
  if (buildable === null || buildable.isComplete) return;
  const specs = scalePieceCostsToBuildableRequired(
    getConstructionPieceSpecs(entity),
    buildable.required,
  );
  if (pieceRecordsMatchSpecs(buildable.pieces, specs)) return;
  const pieces = new Array<ConstructionPieceBuildRecord>(specs.length);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    pieces[i] = {
      id: spec.getId(),
      kind: spec.kind,
      mountIndex: spec.mountIndex,
      required: cloneResourceCost(spec.required),
      paid: { energy: 0, metal: 0 },
      healthBuildFraction: 0,
      isActive: false,
      isComplete: !costHasAnyResource(spec.required),
    };
  }
  buildable.pieces = pieces;
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
      // Pieces grew this tick (a locomotion/turret came alive), so the
      // host's effective mass changed — recompute it for the physics body.
      world.onHostMassChanged?.(entity);
    }
  }
}

export function initializeConstructionPieceHealth(entity: Entity, world: WorldState | null = null): void {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isComplete) return;
  ensureConstructionPieceRecords(entity);
  buildable.healthBuildFraction = getBuildFraction(buildable);
  reconcileAndGrowConstructionPieces(world, entity, 'zero');
}

function finishConstructionPieceHealth(entity: Entity): void {
  if (entity.unit !== null) {
    const unit = entity.unit;
    if (unit.hp > 0) unit.hp = unit.maxHp;
  } else if (entity.building !== null) {
    const building = entity.building;
    if (building.hp > 0) building.hp = building.maxHp;
  }
}

function isConstructionAlive(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

function completeConstruction(
  world: WorldState,
  entity: Entity,
  result: ConstructionLifecycleResult,
): void {
  const buildable = entity.buildable;
  if (!buildable || buildable.isComplete) return;
  buildable.paid = { ...buildable.required };
  buildable.isComplete = true;
  buildable.healthBuildFraction = 1;
  finishConstructionPieceHealth(entity);

  if (entity.building) {
    applyCompletedBuildingEffects(world, entity);
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

const _attendedConstructionTargets = new Set<number>();
const _decayOut = new Float64Array(4);

/** Every shell somebody is still answering for this tick: one that received
 *  construction work during resource distribution, plus one that any living
 *  builder still carries in its order queue.
 *
 *  `distributeEnergy` clears and refills `workMovements` immediately before
 *  this pass, so it is the authoritative "somebody is paying for this frame"
 *  record. The queue scan covers the gap the work ledger cannot see: a
 *  shift-queued site is placed the moment the order is issued and stands there
 *  unfunded while the builder finishes the sites ahead of it. Intent counts as
 *  attendance; only an abandoned or cancelled frame rots. */
function collectAttendedConstructionTargets(world: WorldState): ReadonlySet<number> {
  const attended = _attendedConstructionTargets;
  attended.clear();
  const movements = world.workMovements;
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (movement.operation === 'construct') attended.add(movement.targetEntityId);
  }
  const builders = world.getBuilderUnits();
  for (let i = 0; i < builders.length; i++) {
    const unit = builders[i].unit;
    if (unit === null || unit.hp <= 0) continue;
    const actions = unit.actions;
    for (let a = 0; a < actions.length; a++) {
      const action = actions[a];
      if (action.type !== 'build') continue;
      const buildingId = action.buildingId;
      if (buildingId !== undefined) attended.add(buildingId);
    }
  }
  return attended;
}

/** Decay one unfunded shell. Returns true once the frame has rotted back to
 *  zero progress and must leave the world. */
function decayUnfundedConstruction(
  world: WorldState,
  entity: Entity,
  dtSec: number,
): boolean {
  const buildable = entity.buildable;
  if (buildable === null) return false;
  const elapsed = (world.unfundedBuildSeconds.get(entity.id) ?? 0) + dtSec;
  world.unfundedBuildSeconds.set(entity.id, elapsed);
  const decay = BUILD_CONFIG.unfinishedBuildDecay;
  const decaySeconds = Math.min(dtSec, elapsed - decay.unfundedDelaySeconds);
  if (decaySeconds <= 0) return false;

  const hpState = entity.building ?? entity.unit;
  if (hpState === null) return false;
  const sim = requireConstructionSim();
  if (sim.constructionDecayStep(
    buildable.paid.energy,
    buildable.paid.metal,
    buildable.required.energy,
    buildable.required.metal,
    buildable.healthBuildFraction,
    hpState.hp,
    hpState.maxHp,
    decay.fractionPerSecond,
    decaySeconds,
    _decayOut,
  ) === 0) {
    throw new Error('constructionLifecycle: construction_decay_step rejected its buffer');
  }
  buildable.paid.energy = _decayOut[0];
  buildable.paid.metal = _decayOut[1];
  buildable.healthBuildFraction = _decayOut[2];
  ensureConstructionPieceRecords(entity);
  reconcileAndGrowConstructionPieces(world, entity, 'current');
  // Decay owns health on the way down. The growth kernel only ever raises hp
  // (and floors a live piece at 1), so the decayed value is written after it.
  hpState.hp = _decayOut[3];
  world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING | ENTITY_CHANGED_HP);
  return _decayOut[2] <= 0;
}

export function updateConstructionLifecycle(
  world: WorldState,
  dtMs: number,
): ConstructionLifecycleResult {
  const result: ConstructionLifecycleResult = {
    completedUnits: [],
    completedBuildings: [],
    decayedBuildings: [],
  };
  const sources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];
  const attended = collectAttendedConstructionTargets(world);
  const dtSec = dtMs / 1000;

  for (const list of sources) {
    for (const entity of list) {
      const buildable = entity.buildable;
      if (!buildable || buildable.isComplete) continue;
      // An unfinished building nobody is answering for rots at a constant rate
      // and is gone at zero. Cancelled (interrupted) frames rot too — that is
      // the only way a partial assembly ever leaves the map on its own.
      // Factory unit shells are exempt: their factory owns their lifecycle.
      if (entity.building !== null && !attended.has(entity.id)) {
        if (decayUnfundedConstruction(world, entity, dtSec)) {
          result.decayedBuildings.push(entity);
        }
        continue;
      }
      world.unfundedBuildSeconds.delete(entity.id);
      if (buildable.isInterrupted) continue;
      const buildFraction = getBuildFraction(buildable);
      growConstructionHp(world, entity, buildFraction);
      if (isConstructionAlive(entity) && isBuildFullyPaid(buildable)) {
        completeConstruction(world, entity, result);
      }
    }
  }

  return result;
}
