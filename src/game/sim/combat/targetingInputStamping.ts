// AIM-08.1/.2 — Per-tick stamping of the SoA targeting input slabs.
//
// Split into two passes:
//
//   stampForceFieldPool — runs BEFORE updateTargetingAndFiringState.
//     The AIM-08.2 force-field clearance kernels read the FF slab
//     during the FSM, so the slab must be current-tick data on entry.
//     Respects world.forceFieldsObstructSight; when the feature is
//     disabled the slab is rebuilt at count=0 so the kernels return
//     "clear" without inspecting individual fields.
//
//   stampCombatTargetingPool — runs BEFORE updateTargetingAndFiringState.
//     Rebuilds current entity/turret input rows. AIM-08.5 writes FSM
//     transitions into this slab mid-pass and copies them back to JS
//     Turret objects until snapshots/rendering read the slab directly.
//     Also compacts the per-tick targeting source list while the
//     entities are already hot in this stamping pass.
//
// stampTargetingInputSlabs() is the convenience wrapper that runs
// both passes — kept for callers that don't care about the split.

import type { WorldState } from '../WorldState';
import { spatialGrid } from '../SpatialGrid';
import { encodeForceFieldReflectionMode, getActiveForceFields } from './forceFieldTurret';
import { REFLECTIVE_FORCE_FIELD_MATERIAL } from '../blueprints/forceFieldMaterials';
import {
  MIRROR_SIGHT_QUERY_PAD,
  weaponRequiresNonObstructedLineOfSight,
} from './lineOfSight';
import {
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { getUnitGroundZ } from '../unitGeometry';
import {
  CT_BLUEPRINT_CODE_NONE,
  CT_ENTITY_FAMILY_BUILDING,
  CT_ENTITY_FAMILY_LOCOMOTION,
  CT_ENTITY_FAMILY_NONE,
  CT_ENTITY_FAMILY_SHOT,
  CT_ENTITY_FAMILY_TOWER,
  CT_ENTITY_FAMILY_UNIT,
  CT_ENTITY_FLAG_ALIVE,
  CT_ENTITY_FLAG_HAS_COMBAT,
  CT_ENTITY_FLAG_FIRE_ENABLED,
  CT_ENTITY_FLAG_BUILDABLE_COMPLETE,
  CT_ENTITY_FLAG_CLOAKED,
  CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS,
  CT_TURRET_CFG_NEEDS_BALLISTIC,
  CT_TURRET_CFG_VERTICAL_LAUNCHER,
  CT_TURRET_CFG_IS_MANUAL_FIRE,
  CT_TURRET_CFG_PASSIVE,
  CT_TURRET_CFG_VISUAL_ONLY,
  CT_TURRET_CFG_SHOT_IS_FORCE,
  CT_TURRET_CFG_HAS_TRACKING_RANGE,
  CT_TURRET_CFG_HOST_DIRECTED,
  CT_TURRET_STATE_IDLE,
  CT_TURRET_STATE_TRACKING,
  CT_TURRET_STATE_ENGAGED,
  getSimWasm,
  type CombatTargetingApi,
  type SimWasm,
} from '../../sim-wasm/init';
import {
  buildingBlueprintIdToCode,
  locomotionBlueprintIdToCode,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../../types/network';
import {
  EMPTY_LOCK_ON_MASKS,
  getTowerHostLockOnMasks,
  getUnitHostLockOnMasks,
  type LockOnMasks,
} from '../blueprints';
import {
  getEntityDetectionPadding,
  getEntityDetectorRadius,
  isEntityCloaked,
} from '../cloakDetection';
import {
  getEntityFullVisionRadius,
  getEntityRadarRadius,
} from '../sensorCoverage';
import {
  getShotMaxLifespan,
  isProjectileShot,
  type Entity,
  type EntityId,
  type HysteresisRange,
  type PlayerId,
  type ProjectileShot,
  type Turret,
  type TurretRanges,
  type TurretState,
} from '../types';

const _stampPos = { x: 0, y: 0, z: 0 };
const _stampVel = { x: 0, y: 0, z: 0 };
let _stampPrevFsmState = new Uint8Array(0);
let _stampPrevFsmTarget = new Int32Array(0);
let _stampPrevLosBlockedTicks = new Uint16Array(0);
let _stampPrevCooldown = new Float64Array(0);
let _stampPrevBurstCooldown = new Float64Array(0);

function getHostLockOnMasks(entity: Entity): LockOnMasks {
  if (entity.unit !== null) return getUnitHostLockOnMasks(entity.unit.unitBlueprintId);
  if (entity.type === 'tower' && entity.buildingBlueprintId !== null) {
    return getTowerHostLockOnMasks(entity.buildingBlueprintId);
  }
  return EMPTY_LOCK_ON_MASKS;
}

export type CombatTargetingStateViews = {
  buffer: ArrayBuffer;
  length: number;
  entityCapacity: number;
  entityId: Int32Array;
  entityFlags: Uint8Array;
  turretCountPerEntity: Uint8Array;
  state: Uint8Array;
  targetId: Int32Array;
  mountX: Float64Array;
  mountY: Float64Array;
  mountZ: Float64Array;
  mountVx: Float64Array;
  mountVy: Float64Array;
  mountVz: Float64Array;
  worldPosTick: Int32Array;
  losBlockedTicks: Uint16Array;
  cooldown: Float64Array;
  burstCooldown: Float64Array;
  angularVelocity: Float32Array;
  pitchVelocity: Float32Array;
  activeTurretMask: Uint32Array;
  firingTurretMask: Uint32Array;
};

export type CombatTargetingTurretStateCode =
  | typeof CT_TURRET_STATE_IDLE
  | typeof CT_TURRET_STATE_TRACKING
  | typeof CT_TURRET_STATE_ENGAGED;

export type CombatTargetingTurretFsmOut = {
  stateCode: CombatTargetingTurretStateCode;
  /** Numeric sentinel: -1 when the turret has no lock-on target this
   *  tick. Pooled DTO read per turret per frame, so the uniform shape
   *  keeps V8 hidden classes stable and avoids the boxed-null check. */
  targetId: EntityId;
};

export type CombatTargetingTurretMountOut = {
  x: number;
  y: number;
  z: number;
};

export type CombatTargetingTurretKinematicsOut = {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
};

let _stateViews: CombatTargetingStateViews | null = null;
const _combatTargetingSourceEntities: Entity[] = [];
let _combatTargetingSourceIds = new Int32Array(0);
let _combatTargetingSourceCount = 0;
let _combatTargetingSensorSourceSlots = new Uint32Array(0);
let _combatTargetingSensorSourceCount = 0;
const _stampViewMaskByPlayer = new Uint32Array(32);
let _stampViewMaskComputedBits = 0;
let _stampSlotUsed = new Uint8Array(0);
let _stampSlotCursor = 0;

function playerMaskBit(playerId: number): number {
  if (playerId < 1 || playerId > 31) return 0;
  return 1 << (playerId - 1);
}

function getEntityViewMask(world: WorldState, playerId: number): number {
  let mask = playerMaskBit(playerId);
  if (mask === 0) return 0;
  if ((_stampViewMaskComputedBits & mask) !== 0) return _stampViewMaskByPlayer[playerId];
  for (const allyId of world.getAllies(playerId as PlayerId)) {
    mask |= playerMaskBit(allyId);
  }
  mask >>>= 0;
  _stampViewMaskByPlayer[playerId] = mask;
  _stampViewMaskComputedBits |= playerMaskBit(playerId);
  return mask;
}

function ensureStampPrevFsmCapacity(count: number): void {
  if (count <= _stampPrevFsmState.length) return;
  let next = Math.max(8, _stampPrevFsmState.length);
  while (next < count) next *= 2;
  _stampPrevFsmState = new Uint8Array(next);
  _stampPrevFsmTarget = new Int32Array(next);
  _stampPrevLosBlockedTicks = new Uint16Array(next);
  _stampPrevCooldown = new Float64Array(next);
  _stampPrevBurstCooldown = new Float64Array(next);
}

function resetCombatTargetingSources(): void {
  _combatTargetingSourceEntities.length = 0;
  _combatTargetingSourceCount = 0;
  _combatTargetingSensorSourceCount = 0;
}

function resetCombatTargetingSlotUse(): void {
  _stampSlotUsed.fill(0);
  _stampSlotCursor = 0;
}

function ensureCombatTargetingSlotUseCapacity(slot: number): void {
  if (slot < _stampSlotUsed.length) return;
  let next = Math.max(64, _stampSlotUsed.length);
  while (next <= slot) next *= 2;
  const slots = new Uint8Array(next);
  slots.set(_stampSlotUsed);
  _stampSlotUsed = slots;
}

function reserveCombatTargetingSlot(slot: number): void {
  if (slot < 0) return;
  ensureCombatTargetingSlotUseCapacity(slot);
  _stampSlotUsed[slot] = 1;
}

function allocCombatTargetingOnlySlot(): number {
  while (_stampSlotCursor < _stampSlotUsed.length && _stampSlotUsed[_stampSlotCursor] !== 0) {
    _stampSlotCursor++;
  }
  reserveCombatTargetingSlot(_stampSlotCursor);
  return _stampSlotCursor++;
}

function ensureCombatTargetingSourceCapacity(count: number): void {
  if (count <= _combatTargetingSourceIds.length) return;
  let next = Math.max(8, _combatTargetingSourceIds.length);
  while (next < count) next *= 2;
  const ids = new Int32Array(next);
  ids.set(_combatTargetingSourceIds.subarray(0, _combatTargetingSourceCount));
  _combatTargetingSourceIds = ids;
}

function queueCombatTargetingSource(entity: Entity): void {
  const combat = entity.combat;
  if (!entity.ownership || !combat || combat.turrets.length === 0) return;
  const idx = _combatTargetingSourceCount;
  ensureCombatTargetingSourceCapacity(idx + 1);
  _combatTargetingSourceEntities.push(entity);
  _combatTargetingSourceIds[idx] = entity.id;
  _combatTargetingSourceCount++;
}

function ensureCombatTargetingSensorSourceCapacity(count: number): void {
  if (count <= _combatTargetingSensorSourceSlots.length) return;
  let next = Math.max(8, _combatTargetingSensorSourceSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingSensorSourceSlots.subarray(0, _combatTargetingSensorSourceCount));
  _combatTargetingSensorSourceSlots = slots;
}

function queueCombatTargetingSensorSourceSlot(slot: number): void {
  const idx = _combatTargetingSensorSourceCount;
  ensureCombatTargetingSensorSourceCapacity(idx + 1);
  _combatTargetingSensorSourceSlots[idx] = slot;
  _combatTargetingSensorSourceCount++;
}

function getCombatTargetingSensorSourceSlots(): Uint32Array {
  return _combatTargetingSensorSourceSlots.subarray(0, _combatTargetingSensorSourceCount);
}

export function getCombatTargetingSourceEntities(): readonly Entity[] {
  return _combatTargetingSourceEntities;
}

export function getCombatTargetingSourceIds(): Int32Array {
  return _combatTargetingSourceIds.subarray(0, _combatTargetingSourceCount);
}

export function getCombatTargetingSourceCount(): number {
  return _combatTargetingSourceCount;
}

export function encodeCombatTargetingTurretState(state: TurretState): CombatTargetingTurretStateCode {
  switch (state) {
    case 'engaged': return CT_TURRET_STATE_ENGAGED;
    case 'tracking': return CT_TURRET_STATE_TRACKING;
    case 'idle': return CT_TURRET_STATE_IDLE;
  }
}

export function getCombatTargetingStateViews(sim: SimWasm): CombatTargetingStateViews {
  const targeting = sim.combatTargeting;
  const entityCapacity = targeting.entityCapacity();
  const length = entityCapacity * targeting.maxTurretsPerEntity();
  const buffer = sim.memory.buffer;
  const cached = _stateViews;
  if (
    cached &&
    cached.buffer === buffer &&
    cached.length === length &&
    cached.entityCapacity === entityCapacity &&
    cached.state.byteLength > 0
  ) {
    return cached;
  }

  _stateViews = {
    buffer,
    length,
    entityCapacity,
    entityId: new Int32Array(buffer, targeting.entityIdPtr(), entityCapacity),
    entityFlags: new Uint8Array(buffer, targeting.entityFlagsPtr(), entityCapacity),
    turretCountPerEntity: new Uint8Array(
      buffer,
      targeting.turretCountPerEntityPtr(),
      entityCapacity,
    ),
    state: new Uint8Array(buffer, targeting.turretStatePtr(), length),
    targetId: new Int32Array(buffer, targeting.turretTargetIdPtr(), length),
    mountX: new Float64Array(buffer, targeting.turretMountXPtr(), length),
    mountY: new Float64Array(buffer, targeting.turretMountYPtr(), length),
    mountZ: new Float64Array(buffer, targeting.turretMountZPtr(), length),
    mountVx: new Float64Array(buffer, targeting.turretMountVxPtr(), length),
    mountVy: new Float64Array(buffer, targeting.turretMountVyPtr(), length),
    mountVz: new Float64Array(buffer, targeting.turretMountVzPtr(), length),
    worldPosTick: new Int32Array(buffer, targeting.turretWorldPosTickPtr(), length),
    losBlockedTicks: new Uint16Array(buffer, targeting.turretLosBlockedTicksPtr(), length),
    cooldown: new Float64Array(buffer, targeting.turretCooldownPtr(), length),
    burstCooldown: new Float64Array(buffer, targeting.turretBurstCooldownPtr(), length),
    angularVelocity: new Float32Array(buffer, targeting.turretAngularVelocityPtr(), length),
    pitchVelocity: new Float32Array(buffer, targeting.turretPitchVelocityPtr(), length),
    activeTurretMask: new Uint32Array(
      buffer,
      targeting.entityActiveTurretMaskPtr(),
      entityCapacity,
    ),
    firingTurretMask: new Uint32Array(
      buffer,
      targeting.entityFiringTurretMaskPtr(),
      entityCapacity,
    ),
  };
  return _stateViews;
}

function getCombatTargetingTurretStateIndex(
  sim: SimWasm,
  entity: Entity,
  turretIndex: number,
): number {
  if (turretIndex < 0) return -1;
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return -1;
  const targeting = sim.combatTargeting;
  if (turretIndex >= targeting.turretCount(slot)) return -1;
  return slot * targeting.maxTurretsPerEntity() + turretIndex;
}

/** Read the Rust-owned target/state tuple for one turret into `out`.
 *  Returns false when the entity has no stamped targeting slab row
 *  (for example on a non-sim client path), so callers can fall back
 *  to the transitional JS Turret object. */
export function readCombatTargetingTurretFsmInto(
  entity: Entity,
  turretIndex: number,
  out: CombatTargetingTurretFsmOut,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  return readCombatTargetingTurretFsmFromSimInto(sim, entity, turretIndex, out);
}

export function readCombatTargetingTurretFsmFromSimInto(
  sim: SimWasm,
  entity: Entity,
  turretIndex: number,
  out: CombatTargetingTurretFsmOut,
): boolean {
  const idx = getCombatTargetingTurretStateIndex(sim, entity, turretIndex);
  if (idx < 0) return false;
  const views = getCombatTargetingStateViews(sim);
  out.stateCode = views.state[idx] as CombatTargetingTurretStateCode;
  const targetId = views.targetId[idx];
  out.targetId = targetId < 0 ? -1 : targetId;
  return true;
}

/** Read the Rust-updated turret mount for this tick. Returns false
 *  when the row is missing or when the scheduler skipped mount
 *  kinematics for that entity this tick; callers should then use the
 *  JS resolver, which can compute a fresh pose from live entity state. */
export function readCombatTargetingTurretMountInto(
  entity: Entity,
  turretIndex: number,
  currentTick: number,
  out: CombatTargetingTurretMountOut,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  const idx = getCombatTargetingTurretStateIndex(sim, entity, turretIndex);
  if (idx < 0) return false;
  const views = getCombatTargetingStateViews(sim);
  if (views.worldPosTick[idx] !== currentTick) return false;
  out.x = views.mountX[idx];
  out.y = views.mountY[idx];
  out.z = views.mountZ[idx];
  return true;
}

/** Read the Rust-updated turret mount position AND world velocity for
 *  this tick. Returns false when the slab row is missing or the
 *  scheduler skipped mount kinematics for that entity. Callers that
 *  need just one of the two should still use this — the read is the
 *  same cost as reading position alone and avoids a divergence between
 *  "I got fresh position" and "I got fresh velocity". */
export function readCombatTargetingTurretMountKinematicsInto(
  entity: Entity,
  turretIndex: number,
  currentTick: number,
  outPos: { x: number; y: number; z: number },
  outVel: { x: number; y: number; z: number },
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  const idx = getCombatTargetingTurretStateIndex(sim, entity, turretIndex);
  if (idx < 0) return false;
  const views = getCombatTargetingStateViews(sim);
  if (views.worldPosTick[idx] !== currentTick) return false;
  outPos.x = views.mountX[idx];
  outPos.y = views.mountY[idx];
  outPos.z = views.mountZ[idx];
  outVel.x = views.mountVx[idx];
  outVel.y = views.mountVy[idx];
  outVel.z = views.mountVz[idx];
  return true;
}

function rangeEdgeSq(range: HysteresisRange, edge: 'acquire' | 'release'): number {
  const cached = edge === 'acquire' ? range.acquireSq : range.releaseSq;
  if (cached !== undefined) return cached;
  const v = edge === 'acquire' ? range.acquire : range.release;
  return v * v;
}

function encodeTurretConfigFlags(turret: Turret, ranges: TurretRanges): number {
  let f = 0;
  if (weaponRequiresNonObstructedLineOfSight(turret)) f |= CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS;
  const angle = turret.config.aimStyle.angleType;
  if (
    angle === 'ballisticArcLow' ||
    angle === 'ballisticArcLowOnlyUnder' ||
    angle === 'ballisticArcHigh'
  ) {
    f |= CT_TURRET_CFG_NEEDS_BALLISTIC;
  }
  if (turret.config.verticalLauncher === true) f |= CT_TURRET_CFG_VERTICAL_LAUNCHER;
  if (turret.config.isManualFire === true) f |= CT_TURRET_CFG_IS_MANUAL_FIRE;
  if (turret.config.passive === true) f |= CT_TURRET_CFG_PASSIVE;
  if (turret.config.visualOnly === true) f |= CT_TURRET_CFG_VISUAL_ONLY;
  if (turret.config.shot && turret.config.shot.type === 'forceField') {
    f |= CT_TURRET_CFG_SHOT_IS_FORCE;
  }
  if (ranges.tracking) f |= CT_TURRET_CFG_HAS_TRACKING_RANGE;
  if (turret.config.hostDirected) f |= CT_TURRET_CFG_HOST_DIRECTED;
  return f;
}

const BALLISTIC_ARC_LOW = 0;
const BALLISTIC_ARC_HIGH = 1;

type ForceFieldPoolStampOptions = {
  /** Projectile collision needs the physical shield slab even when
   *  force-fields are not configured to obstruct targeting sightlines. */
  includeWhenSightDisabled: boolean | undefined;
};

function stampCombatTargetingEntityInto(
  sim: SimWasm,
  targeting: CombatTargetingApi,
  world: WorldState,
  entity: Entity,
): boolean {
  const combat = entity.combat;
  const slot = spatialGrid.getSlot(entity.id);
  // Entities without a spatial slot can't be addressed by the slab;
  // the eventual kernel walks the slab, not the JS list, so anything
  // off-grid would be invisible to it anyway.
  if (slot < 0) return false;
  reserveCombatTargetingSlot(slot);

  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const viewMask = getEntityViewMask(world, playerId);
  const pos = getEntityPosition3d(entity, _stampPos);
  const vel = getEntityVelocity3d(entity, _stampVel);
  const groundZ = getUnitGroundZ(entity);
  const rotCos = Math.cos(entity.transform.rotation);
  const rotSin = Math.sin(entity.transform.rotation);
  entity.transform.rotCos = rotCos;
  entity.transform.rotSin = rotSin;
  const surfaceN = entity.unit ? entity.unit.surfaceNormal : undefined;
  const surfaceNx = surfaceN ? surfaceN.nx : 0;
  const surfaceNy = surfaceN ? surfaceN.ny : 0;
  const surfaceNz = surfaceN ? surfaceN.nz : 1;
  const suspension = entity.unit ? entity.unit.suspension : undefined;
  const suspensionOffsetX = suspension ? suspension.offsetX : 0;
  const suspensionOffsetY = suspension ? suspension.offsetY : 0;
  const suspensionOffsetZ = suspension ? suspension.offsetZ : 0;
  const radiusHitbox = entity.unit
    ? entity.unit.radius.hitbox
    : (entity.building
      ? entity.building.targetRadius
      : (entity.projectile && isProjectileShot(entity.projectile.config.shot)
        ? entity.projectile.config.shot.collision.radius
        : 0));
  // AABB half-extents for AABB-shaped targets (buildings). Sphere
  // targets (units/projectiles) stamp zeros so the Rust aim-point
  // resolver collapses to entity-center without branching on shape.
  const aabbHalfX = entity.building ? entity.building.width * 0.5 : 0;
  const aabbHalfY = entity.building ? entity.building.height * 0.5 : 0;
  const aabbHalfZ = entity.building ? entity.building.depth * 0.5 : 0;
  const hp = entity.unit
    ? entity.unit.hp
    : (entity.building
      ? entity.building.hp
      : (entity.projectile && isProjectileShot(entity.projectile.config.shot)
        ? entity.projectile.hp
        : 0));

  let entityFlags = 0;
  if (combat) entityFlags |= CT_ENTITY_FLAG_HAS_COMBAT;
  if (hp > 0) entityFlags |= CT_ENTITY_FLAG_ALIVE;
  if (combat && combat.fireEnabled !== false) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (!entity.buildable || entity.buildable.isComplete) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }
  if (isEntityCloaked(entity)) entityFlags |= CT_ENTITY_FLAG_CLOAKED;

  // LOCK-ON-03 — Stamp the entity's family + blueprint id so the Rust
  // exclusion gate can reject candidates by family/name without
  // crossing back into JS. Projectile-style entities with neither
  // Rows without unit, building, or projectile data stamp NONE/sentinel; the
  // kernel reads these as "no family to match" and ignores level-0
  // family / level-1 named exclusions for that row.
  let entityFamily: number = CT_ENTITY_FAMILY_NONE;
  let entityBlueprintCode: number = CT_BLUEPRINT_CODE_NONE;
  if (entity.unit) {
    entityFamily = CT_ENTITY_FAMILY_UNIT;
    entityBlueprintCode = unitBlueprintIdToCode(entity.unit.unitBlueprintId);
  } else if (entity.building) {
    entityFamily =
      entity.type === 'tower' ? CT_ENTITY_FAMILY_TOWER : CT_ENTITY_FAMILY_BUILDING;
    const buildingBlueprintId = entity.buildingBlueprintId;
    entityBlueprintCode =
      buildingBlueprintId !== null ? buildingBlueprintIdToCode(buildingBlueprintId) : CT_BLUEPRINT_CODE_NONE;
  } else if (entity.projectile) {
    entityFamily = CT_ENTITY_FAMILY_SHOT;
    entityBlueprintCode = shotBlueprintIdToCode(entity.projectile.shotBlueprintId);
  }
  const hostLockOn = getHostLockOnMasks(entity);

  // Detector + padding stamped per-entity so the Rust observability
  // helper can walk the slab itself (replaces the per-player
  // detector list TS used to maintain). Padding is what the cloak
  // check adds when this entity is the *target*.
  const detectorRadius = getEntityDetectorRadius(entity);
  const fullVisionRadius = getEntityFullVisionRadius(entity);
  const radarRadius = getEntityRadarRadius(entity);
  const detectionPadding = getEntityDetectionPadding(entity);
  if (
    playerMaskBit(playerId) !== 0 &&
    hp > 0 &&
    (entityFlags & CT_ENTITY_FLAG_BUILDABLE_COMPLETE) !== 0 &&
    (fullVisionRadius > 0 || radarRadius > 0 || detectorRadius > 0)
  ) {
    queueCombatTargetingSensorSourceSlot(slot);
  }

  // Per-entity targeting inputs that used to be JS scratch arrays
  // shipped to the scheduler. The Rust scheduler now reads them from
  // the slab so updateTargetingAndFiringState can shrink to a queue +
  // kernel call + writeback path without per-entity prep.
  const priorityTargetId = combat !== null ? combat.priorityTargetId : null;
  const priorityPoint = combat !== null ? combat.priorityTargetPoint : null;
  const priorityPointPresent = priorityPoint === null ? 0 : 1;
  const priorityPointX = priorityPoint !== null ? priorityPoint.x : 0;
  const priorityPointY = priorityPoint !== null ? priorityPoint.y : 0;
  const priorityPointZ = priorityPoint !== null ? priorityPoint.z : 0;
  const scheduledProbeTick = combat !== null ? combat.nextCombatProbeTick : -1;

  const turrets = combat !== null ? combat.turrets : null;
  const views = getCombatTargetingStateViews(sim);
  const maxTurrets = targeting.maxTurretsPerEntity();
  // Keep the Rust-owned FSM tuple authoritative across input stamping.
  // clear() drops liveness/counts but intentionally leaves turret rows
  // intact, so same-entity slots can seed target/state from the slab.
  // losBlockedTicks is also slab-owned now (the Rust kernel resets it
  // on target change inside combat_targeting_set_target_state and
  // increments it during LOS grace counting), so we preserve the slab
  // value for same-entity slots and pass 0 for slot reuse.
  // cooldown / burstCooldown are likewise slab-owned: the scheduled
  // batch decrements them every tick and the firing pass writes
  // post-fire values back into the slab via writeTurretCooldownToSlab.
  // The JS Turret no longer carries a cooldown field — for same-entity
  // slots we preserve the slab value so the kernel's decrement
  // survives across ticks, and for slot reuse the slab gets a fresh 0
  // because a newly-constructed turret is by definition off cooldown.
  const preservePreviousFsm = views.entityId[slot] === entity.id;
  if (turrets && preservePreviousFsm) {
    ensureStampPrevFsmCapacity(turrets.length);
    const base = slot * maxTurrets;
    for (let i = 0; i < turrets.length; i++) {
      const idx = base + i;
      _stampPrevFsmState[i] = views.state[idx];
      _stampPrevFsmTarget[i] = views.targetId[idx];
      _stampPrevLosBlockedTicks[i] = views.losBlockedTicks[idx];
      _stampPrevCooldown[i] = views.cooldown[idx];
      _stampPrevBurstCooldown[i] = views.burstCooldown[idx];
    }
  }
  targeting.setEntity(
    slot, entity.id, playerId, viewMask,
    pos.x, pos.y, pos.z,
    vel.x, vel.y, vel.z,
    groundZ,
    rotCos, rotSin,
    surfaceNx, surfaceNy, surfaceNz,
    suspensionOffsetX, suspensionOffsetY, suspensionOffsetZ,
    radiusHitbox,
    aabbHalfX, aabbHalfY, aabbHalfZ,
    hp, entityFlags,
    entityFamily, entityBlueprintCode,
    hostLockOn.relationship, hostLockOn.entityFamily,
    hostLockOn.building, hostLockOn.tower,
    hostLockOn.unit, hostLockOn.turret,
    hostLockOn.locomotion, hostLockOn.shot,
    detectorRadius, fullVisionRadius, radarRadius, detectionPadding,
    priorityTargetId === null ? -1 : priorityTargetId,
    priorityPointPresent,
    priorityPointX, priorityPointY, priorityPointZ,
    scheduledProbeTick,
    turrets !== null ? turrets.length : 0,
  );

  if (turrets === null) return true;
  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    const stateCode = preservePreviousFsm
      ? _stampPrevFsmState[i]
      : encodeCombatTargetingTurretState(t.state);
    const targetId = preservePreviousFsm
      ? _stampPrevFsmTarget[i]
      : (t.target === null ? -1 : t.target);
    const ranges = t.ranges;
    const shot = t.config.shot;
    const projectileShot: ProjectileShot | undefined =
      shot !== undefined && isProjectileShot(shot) ? shot : undefined;
    const angleType = t.config.aimStyle.angleType;
    const projectileSpeed = projectileShot ? getProjectileLaunchSpeed(projectileShot) : 0;
    let maxTimeSec = 0;
    if (projectileShot) {
      const lifeMs = getShotMaxLifespan(projectileShot);
      maxTimeSec = Number.isFinite(lifeMs) ? lifeMs / 1000 : 0;
    }
    const fireMaxAcq = rangeEdgeSq(ranges.fire.max, 'acquire');
    const fireMaxRel = rangeEdgeSq(ranges.fire.max, 'release');
    const fireMinAcq = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'acquire') : 0;
    const fireMinRel = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'release') : 0;
    const trackingAcq = ranges.tracking ? rangeEdgeSq(ranges.tracking, 'acquire') : 0;
    const trackingRel = ranges.tracking ? rangeEdgeSq(ranges.tracking, 'release') : 0;
    const outermostAcq = ranges.tracking ? ranges.tracking.acquire : ranges.fire.max.acquire;

    targeting.setTurret(
      slot, i,
      t.id,
      t.parentId,
      t.rootHostId,
      t.mountIndex,
      t.worldPos.x, t.worldPos.y, t.worldPos.z,
      t.worldVelocity.x, t.worldVelocity.y, t.worldVelocity.z,
      t.rotation, t.pitch,
      t.angularVelocity, t.pitchVelocity,
      stateCode,
      targetId,
      // Cooldown / burstCooldown are slab-owned now. On slot reuse
      // (preservePreviousFsm is false) the slab gets a fresh 0 — the
      // JS Turret no longer carries a cooldown field, and burst is
      // populated lazily by the firing pass, so neither has a useful
      // seed value here.
      preservePreviousFsm ? _stampPrevCooldown[i] : 0,
      preservePreviousFsm ? _stampPrevBurstCooldown[i] : 0,
      fireMaxAcq, fireMaxRel,
      fireMinAcq, fireMinRel,
      trackingAcq, trackingRel,
      outermostAcq,
      t.mountOffset2d,
      t.mount.x, t.mount.y, t.mount.z,
      t.worldPosTick,
      preservePreviousFsm ? _stampPrevLosBlockedTicks[i] : 0,
      encodeTurretConfigFlags(t, ranges),
      t.sustainedDps,
      projectileSpeed,
      angleType === 'ballisticArcHigh' ? BALLISTIC_ARC_HIGH : BALLISTIC_ARC_LOW,
      maxTimeSec,
      t.config.groundAimFraction ?? 0,
      angleType === 'ballisticArcLowOnlyUnder' ? 1 : 0,
      t.config.aimStyle.lockOnType === 'lockOnToTurret' ? 1 : 0,
      turretBlueprintIdToCode(t.config.turretBlueprintId),
      t.config.lockOnRelationshipExcludeMask,
      t.config.lockOnEntityFamilyExcludeMask,
      t.config.lockOnBuildingExcludeMask,
      t.config.lockOnTowerExcludeMask,
      t.config.lockOnUnitExcludeMask,
      t.config.lockOnTurretExcludeMask,
      t.config.lockOnLocomotionExcludeMask,
      t.config.lockOnShotExcludeMask,
    );
  }
  return true;
}

function stampUnitLocomotionTargetInto(
  targeting: CombatTargetingApi,
  world: WorldState,
  entity: Entity,
): void {
  const unit = entity.unit;
  if (unit === null || unit.locomotion.id < 0) return;
  const slot = allocCombatTargetingOnlySlot();
  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const viewMask = getEntityViewMask(world, playerId);
  const pos = getEntityPosition3d(entity, _stampPos);
  const vel = getEntityVelocity3d(entity, _stampVel);
  const groundZ = getUnitGroundZ(entity);
  const rotCos = Math.cos(entity.transform.rotation);
  const rotSin = Math.sin(entity.transform.rotation);
  const surfaceN = unit.surfaceNormal;
  const suspension = unit.suspension;
  const buildComplete = !entity.buildable || entity.buildable.isComplete;
  let entityFlags = unit.hp > 0 ? CT_ENTITY_FLAG_ALIVE : 0;
  if (buildComplete) entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  if (isEntityCloaked(entity)) entityFlags |= CT_ENTITY_FLAG_CLOAKED;

  targeting.setEntity(
    slot,
    unit.locomotion.id,
    playerId,
    viewMask,
    pos.x,
    pos.y,
    groundZ,
    vel.x,
    vel.y,
    vel.z,
    groundZ,
    rotCos,
    rotSin,
    surfaceN.nx,
    surfaceN.ny,
    surfaceN.nz,
    suspension ? suspension.offsetX : 0,
    suspension ? suspension.offsetY : 0,
    suspension ? suspension.offsetZ : 0,
    unit.radius.collision,
    0,
    0,
    0,
    unit.hp,
    entityFlags,
    CT_ENTITY_FAMILY_LOCOMOTION,
    locomotionBlueprintIdToCode(unit.locomotion.blueprintId),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    -1,
    0,
  );
}

function reserveCombatTargetingSpatialSlots(entities: readonly Entity[]): void {
  for (let i = 0; i < entities.length; i++) {
    reserveCombatTargetingSlot(spatialGrid.getSlot(entities[i].id));
  }
}

/** Rebuild every targetable entity row before the FSM runs. Turret rows
 *  are written for combat entities, but target lookup also needs
 *  unarmed buildings, traveling shots, and locomotion sub-entities. The
 *  same walk compacts the source-id queue consumed by the scheduled
 *  Rust targeting batch, so the scheduler bridge does not need its own
 *  armed-entity traversal. */
export function stampCombatTargetingPool(world: WorldState): void {
  resetCombatTargetingSources();
  resetCombatTargetingSlotUse();
  _stampViewMaskComputedBits = 0;
  const sim = getSimWasm();
  if (sim === undefined) return;
  const targeting = sim.combatTargeting;

  // Drop every slot's ALIVE flag and turret count so dead entities and
  // shrunk turret arrays naturally disappear; kernels gate on those
  // two and treat unmarked slots as empty.
  targeting.clear();

  const units = world.getUnits();
  const buildings = world.getBuildings();
  const projectiles = world.getTravelingProjectiles();
  reserveCombatTargetingSpatialSlots(units);
  reserveCombatTargetingSpatialSlots(buildings);
  reserveCombatTargetingSpatialSlots(projectiles);

  for (const entity of units) {
    if (stampCombatTargetingEntityInto(sim, targeting, world, entity)) {
      queueCombatTargetingSource(entity);
      stampUnitLocomotionTargetInto(targeting, world, entity);
    }
  }
  for (const entity of buildings) {
    if (stampCombatTargetingEntityInto(sim, targeting, world, entity)) {
      queueCombatTargetingSource(entity);
    }
  }
  for (const entity of projectiles) {
    stampCombatTargetingEntityInto(sim, targeting, world, entity);
  }

  targeting.rebuildObservationMasksForSources(getCombatTargetingSensorSourceSlots());
  const scanPulses = world.scanPulses;
  for (let i = 0; i < scanPulses.length; i++) {
    const pulse = scanPulses[i];
    targeting.addSensorObservationCircle(pulse.playerId, pulse.x, pulse.y, pulse.radius);
  }
}

const _mirrorStampPivot = { x: 0, y: 0, z: 0 };

/** Rebuild the single force-field surface pool. Runs BEFORE
 *  updateTargetingAndFiringState so the AIM-08.2 clearance kernels and the
 *  projectile-reflection batch read current-tick surface data.
 *
 *  Materials Are Independent Of Shape: one pool holds both shapes.
 *   - Sphere surfaces come from getActiveForceFields(). When
 *     world.forceFieldsObstructSight is false the sphere group is rebuilt at
 *     count=0 (kernels short-circuit on empty and return "clear"). Projectile
 *     collision can opt into stamping the physical shields even when sight
 *     obstruction is disabled via `includeWhenSightDisabled`.
 *   - Flat-panel surfaces come from world.getForceFieldPanelUnits(), gated by
 *     world.turretForceFieldPanelsEnabled. Inactive / dead mirror units are
 *     skipped; panel rows pack contiguously by unit. The slope-aware turret
 *     pivot is resolved fresh via resolveWeaponWorldMount — the same input the
 *     beam tracer / live aim solver uses — so the gate and the authoritative
 *     bounce path agree on where each panel sits. */
export function stampForceFieldSurfacePool(
  world: WorldState,
  options: ForceFieldPoolStampOptions = { includeWhenSightDisabled: undefined },
): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const pool = sim.forceFieldSurfacePool;

  // ── Sphere surfaces ──
  if (!options.includeWhenSightDisabled && !world.forceFieldsObstructSight) {
    pool.setFieldCount(0);
  } else {
    const active = getActiveForceFields();
    pool.setFieldCount(active.length);
    for (let i = 0; i < active.length; i++) {
      const f = active[i];
      pool.setField(
        i,
        f.entityId,
        f.entityId,
        f.centerX, f.centerY, f.centerZ,
        f.radius,
        encodeForceFieldReflectionMode(f.reflectionMode),
      );
    }
  }

  // ── Flat-panel surfaces ──
  if (!world.turretForceFieldPanelsEnabled) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }
  const forceFieldPanelUnits = world.getForceFieldPanelUnits();
  if (forceFieldPanelUnits.length === 0) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }

  const currentTick = world.getTick();
  let panelReflectionMode = encodeForceFieldReflectionMode(
    REFLECTIVE_FORCE_FIELD_MATERIAL.reflection.mode,
  );
  let unitIdx = 0;
  let panelIdx = 0;
  for (const unit of forceFieldPanelUnits) {
    if (!unit.unit || unit.unit.hp <= 0) continue;
    const panels = unit.unit.forceFieldPanels;
    if (!panels || panels.length === 0) continue;
    const unitCombat = unit.combat;
    const unitTurrets = unitCombat !== null ? unitCombat.turrets : null;
    if (unitTurrets === null || unitTurrets.length === 0) continue;

    const broadRadius = Math.max(unit.unit.forceFieldBoundRadius, unit.unit.radius.hitbox)
      + MIRROR_SIGHT_QUERY_PAD;
    const forceFieldPanelTurret = unitTurrets[0];
    const panelShot = forceFieldPanelTurret.config.shot;
    if (panelShot !== undefined && panelShot.type === 'forceField') {
      panelReflectionMode = encodeForceFieldReflectionMode(panelShot.material.reflection.mode);
    }
    const forceFieldPanelRot = forceFieldPanelTurret.rotation;
    const forceFieldPanelPitch = forceFieldPanelTurret.pitch;
    const unitGroundZ = getUnitGroundZ(unit);
    const unitCS = {
      cos: Math.cos(unit.transform.rotation),
      sin: Math.sin(unit.transform.rotation),
    };
    unit.transform.rotCos = unitCS.cos;
    unit.transform.rotSin = unitCS.sin;
    resolveWeaponWorldMount(
      unit, forceFieldPanelTurret, 0,
      unitCS.cos, unitCS.sin,
      {
        currentTick,
        unitGroundZ,
        surfaceN: unit.unit.surfaceNormal,
      },
      _mirrorStampPivot,
    );

    const panelStart = panelIdx;
    for (let pi = 0; pi < panels.length; pi++) {
      const panel = panels[pi];
      pool.setPanel(
        panelIdx,
        panel.offsetX,
        panel.offsetY,
        panel.angle,
        panel.baseY,
        panel.topY,
        panel.halfWidth,
      );
      panelIdx++;
    }

    pool.setUnit(
      unitIdx,
      unit.id,
      unit.transform.x, unit.transform.y, unit.transform.z,
      unitGroundZ,
      broadRadius,
      forceFieldPanelRot, forceFieldPanelPitch,
      _mirrorStampPivot.x, _mirrorStampPivot.y, _mirrorStampPivot.z,
      panelStart,
      panels.length,
    );
    unitIdx++;
  }

  pool.setUnitCount(unitIdx);
  pool.setPanelCount(panelIdx);
  pool.setPanelMaterialMode(panelReflectionMode);
}

/** Convenience wrapper that runs all input-slab stamping passes
 *  back-to-back. Used by callers that don't need to interleave the
 *  FSM between them. */
export function stampTargetingInputSlabs(world: WorldState): void {
  stampForceFieldSurfacePool(world);
  stampCombatTargetingPool(world);
}
