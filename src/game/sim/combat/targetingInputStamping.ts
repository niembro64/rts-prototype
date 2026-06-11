// AIM-08.1/.2 — Per-tick stamping of the SoA targeting input slabs.
//
// Split into two passes:
//
//   stampShieldPool — runs BEFORE updateTargetingAndFiringState.
//     The AIM-08.2 shield clearance kernels read the FF slab
//     during the FSM, so the slab must be current-tick data on entry.
//     Respects world.shieldsObstructSight; when the feature is
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
import { encodeShieldBarrierShape, encodeShieldReflectionMode, getActiveShields } from './shieldTurret';
import { REFLECTIVE_SHIELD_MATERIAL } from '../blueprints/shieldMaterials';
import {
  MIRROR_SIGHT_QUERY_PAD,
  turretIgnoresForceMaterialSightObstruction,
  weaponRequiresNonObstructedLineOfSight,
} from './lineOfSight';
import {
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { getUnitGroundZ } from '../unitGeometry';
import { getActiveShieldPanelTurret } from '../shieldPanelRuntime';
import {
  CT_BLUEPRINT_CODE_NONE,
  CT_ENTITY_FAMILY_BUILDING,
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
  CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED,
  CT_TURRET_CFG_RANGE_TOP_UNBOUNDED,
  CT_TURRET_CFG_RANGE_SPHERE,
  CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
  CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION,
  CT_TURRET_STATE_IDLE,
  CT_TURRET_STATE_TRACKING,
  CT_TURRET_STATE_ENGAGED,
  getSimWasm,
  type CombatTargetingApi,
  type SimWasm,
} from '../../sim-wasm/init';
import {
  buildingBlueprintIdToCode,
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
  getEntityFullVisionRadius,
  getEntityCloakDetectionRadius,
  getEntityRadarRadius,
  getEntityVisibilityPadding,
  isEntityCloaked,
} from '../sensorCoverage';
import { isEntityActive } from '../buildableHelpers';
import {
  getShotMaxLifespan,
  isProjectileShot,
  NO_ENTITY_ID,
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
let _combatTargetingSourceSlots = new Uint32Array(0);
let _combatTargetingSourceCount = 0;
let _combatTargetingSensorSourceSlots = new Uint32Array(0);
let _combatTargetingSensorSourceCount = 0;
const _stampViewMaskByPlayer = new Uint32Array(32);
let _stampViewMaskComputedBits = 0;
let _stampSlotUsed = new Uint8Array(0);

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

function ensureCombatTargetingSourceCapacity(count: number): void {
  if (count <= _combatTargetingSourceIds.length) return;
  let next = Math.max(8, _combatTargetingSourceIds.length);
  while (next < count) next *= 2;
  const ids = new Int32Array(next);
  ids.set(_combatTargetingSourceIds.subarray(0, _combatTargetingSourceCount));
  _combatTargetingSourceIds = ids;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingSourceSlots.subarray(0, _combatTargetingSourceCount));
  _combatTargetingSourceSlots = slots;
}

function queueCombatTargetingSource(entity: Entity): void {
  const combat = entity.combat;
  if (!entity.ownership || !combat || combat.turrets.length === 0) return;
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return;
  const idx = _combatTargetingSourceCount;
  ensureCombatTargetingSourceCapacity(idx + 1);
  _combatTargetingSourceEntities.push(entity);
  _combatTargetingSourceIds[idx] = entity.id;
  _combatTargetingSourceSlots[idx] = slot;
  _combatTargetingSourceCount++;
}

function combatCanFire(combat: Entity['combat']): boolean {
  if (combat === null) return false;
  const fireState = combat.fireState ?? (combat.fireEnabled === false ? 'holdFire' : 'fireAtWill');
  if (fireState === 'fireAtWill') return true;
  if (fireState === 'returnFire') {
    return combat.priorityTargetId !== null || combat.priorityTargetPoint !== null;
  }
  return false;
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

export function getCombatTargetingSourceSlots(): Uint32Array {
  return _combatTargetingSourceSlots.subarray(0, _combatTargetingSourceCount);
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
  if (turret.id === NO_ENTITY_ID || turret.config.visualOnly === true) {
    f |= CT_TURRET_CFG_VISUAL_ONLY;
  }
  if (turret.config.shot && turret.config.shot.type === 'shield') {
    f |= CT_TURRET_CFG_SHOT_IS_FORCE;
  }
  if (turretIgnoresForceMaterialSightObstruction(turret)) {
    f |= CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION;
  }
  if (ranges.tracking) f |= CT_TURRET_CFG_HAS_TRACKING_RANGE;
  if (turret.config.hostDirected) f |= CT_TURRET_CFG_HOST_DIRECTED;
  if (turret.config.requiredEngagedForFightStop) {
    f |= CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP;
  }
  switch (turret.config.rangeVolume) {
    case 'turret-range-bottom-unbounded':
      f |= CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED;
      break;
    case 'turret-range-top-and-bottom-unbounded':
      f |= CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED | CT_TURRET_CFG_RANGE_TOP_UNBOUNDED;
      break;
    case 'turret-range-sphere':
      f |= CT_TURRET_CFG_RANGE_SPHERE;
      break;
    case 'turret-range-cylinder-normal':
      break;
  }
  return f;
}

const BALLISTIC_ARC_LOW = 0;
const BALLISTIC_ARC_HIGH = 1;

type ShieldPoolStampOptions = {
  /** Projectile collision needs the physical shield slab even when
   *  shields are not configured to obstruct targeting sightlines. */
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
        ? entity.projectile.config.shot.radius.hitbox
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
  if (combatCanFire(combat)) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (isEntityActive(entity)) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }
  if (isEntityCloaked(entity)) {
    entityFlags |= CT_ENTITY_FLAG_CLOAKED;
  }

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

  // Sight + radar radii and entity-size padding stamped per-entity so
  // the Rust observability helper can walk the slab itself. Padding is
  // the target's footprint, so a unit counts as observed when its edge
  // (not just its center) falls inside a vision/radar circle.
  const fullVisionRadius = getEntityFullVisionRadius(entity);
  const radarRadius = getEntityRadarRadius(entity);
  const detectorRadius = getEntityCloakDetectionRadius(entity);
  const visibilityPadding = getEntityVisibilityPadding(entity);
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
    hostLockOn.shot,
    fullVisionRadius, radarRadius, detectorRadius, visibilityPadding,
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
      shot !== null && isProjectileShot(shot) ? shot : undefined;
    const angleType = t.config.aimStyle.angleType;
    const entityCombat = entity.combat;
    const trajectoryMode = entityCombat === null ? 'auto' : entityCombat.trajectoryMode;
    const ballisticArcPreference = trajectoryMode === 'high'
      ? BALLISTIC_ARC_HIGH
      : trajectoryMode === 'low'
        ? BALLISTIC_ARC_LOW
        : angleType === 'ballisticArcHigh' ? BALLISTIC_ARC_HIGH : BALLISTIC_ARC_LOW;
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
      t.config.radius.hitbox,
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
      ballisticArcPreference,
      maxTimeSec,
      t.config.groundAimFraction ?? 0,
      angleType === 'ballisticArcLowOnlyUnder' ? 1 : 0,
      turretBlueprintIdToCode(t.config.turretBlueprintId),
      t.config.lockOnRelationshipIncludeMask,
      t.config.lockOnEntityFamilyIncludeMask,
      t.config.lockOnBuildingIncludeMask,
      t.config.lockOnTowerIncludeMask,
      t.config.lockOnUnitIncludeMask,
      t.config.lockOnTurretIncludeMask,
      t.config.lockOnShotIncludeMask,
      t.config.lockOnRequiresTargetLockedOntoSelfMode,
    );
  }
  return true;
}

/** Rebuild every targetable entity row before the FSM runs. Turret rows
 *  are written for combat entities, but target lookup also needs
 *  unarmed buildings and traveling shots. The
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

  const targets = world.getCombatTargetEntities();
  for (const entity of targets) {
    if (stampCombatTargetingEntityInto(sim, targeting, world, entity)) {
      queueCombatTargetingSource(entity);
    }
  }

  targeting.rebuildObservationMasksForSources(getCombatTargetingSensorSourceSlots());
  const scanPulses = world.scanPulses;
  for (let i = 0; i < scanPulses.length; i++) {
    const pulse = scanPulses[i];
    targeting.addSensorObservationCircle(pulse.playerId, pulse.x, pulse.y, pulse.radius);
  }
}

const _mirrorStampPivot = { x: 0, y: 0, z: 0 };

/** Rebuild the single shield surface pool. Runs BEFORE
 *  updateTargetingAndFiringState so the AIM-08.2 clearance kernels and the
 *  projectile-reflection batch read current-tick surface data.
 *
 *  Materials Are Independent Of Shape: one pool holds both shapes.
 *   - Field surfaces come from getActiveShields(). When sphere shields are
 *     disabled, or when world.shieldsObstructSight is false for a
 *     targeting-only stamp, the field group is rebuilt at count=0 (kernels
 *     short-circuit on empty and return "clear"). Projectile collision can
 *     opt into stamping the physical shields even when sight obstruction is
 *     disabled via `includeWhenSightDisabled`.
 *   - Flat-panel surfaces come from world.getShieldPanelUnits(), gated by
 *     world.turretShieldPanelsEnabled. Inactive / dead mirror turrets are
 *     skipped; panel rows pack contiguously by unit. The slope-aware turret
 *     pivot is resolved fresh via resolveWeaponWorldMount — the same input the
 *     beam tracer / live aim solver uses — so the gate and the authoritative
 *     bounce path agree on where each panel sits. */
export function stampShieldSurfacePool(
  world: WorldState,
  options: ShieldPoolStampOptions = { includeWhenSightDisabled: undefined },
): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const pool = sim.shieldSurfacePool;

  // ── Spherical / infinite-cylinder field surfaces ──
  if (
    !world.turretShieldSpheresEnabled ||
    (!options.includeWhenSightDisabled && !world.shieldsObstructSight)
  ) {
    pool.setFieldCount(0);
  } else {
    const active = getActiveShields();
    pool.setFieldCount(active.length);
    for (let i = 0; i < active.length; i++) {
      const f = active[i];
      pool.setField(
        i,
        f.entityId,
        f.entityId,
        f.centerX, f.centerY, f.centerZ,
        f.axisEndX, f.axisEndY, f.axisEndZ,
        f.radius,
        encodeShieldBarrierShape(f.shape),
        encodeShieldReflectionMode(f.reflectionMode),
      );
    }
  }

  // ── Flat-panel surfaces ──
  if (!world.turretShieldPanelsEnabled) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }
  const shieldPanelUnits = world.getShieldPanelUnits();
  if (shieldPanelUnits.length === 0) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }

  const currentTick = world.getTick();
  let panelReflectionMode = encodeShieldReflectionMode(
    REFLECTIVE_SHIELD_MATERIAL.reflection.mode,
  );
  let unitIdx = 0;
  let panelIdx = 0;
  for (const unit of shieldPanelUnits) {
    const activeShieldPanel = getActiveShieldPanelTurret(unit);
    if (activeShieldPanel === null || unit.unit === null) continue;
    const panels = unit.unit.shieldPanels;
    if (!panels || panels.length === 0) continue;

    const broadRadius = Math.max(unit.unit.shieldBoundRadius, unit.unit.radius.hitbox)
      + MIRROR_SIGHT_QUERY_PAD;
    const {
      turret: shieldPanelTurret,
      turretIndex: shieldPanelTurretIndex,
      emissionRotation,
      emissionPitch,
    } = activeShieldPanel;
    const panelShot = shieldPanelTurret.config.shot;
    if (panelShot !== null && panelShot.type === 'shield') {
      panelReflectionMode = encodeShieldReflectionMode(panelShot.material.reflection.mode);
    }
    const shieldPanelRot = emissionRotation ?? shieldPanelTurret.rotation;
    const shieldPanelPitch = emissionPitch ?? shieldPanelTurret.pitch;
    const unitGroundZ = getUnitGroundZ(unit);
    const unitCS = {
      cos: Math.cos(unit.transform.rotation),
      sin: Math.sin(unit.transform.rotation),
    };
    unit.transform.rotCos = unitCS.cos;
    unit.transform.rotSin = unitCS.sin;
    resolveWeaponWorldMount(
      unit, shieldPanelTurret, shieldPanelTurretIndex,
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
      shieldPanelRot, shieldPanelPitch,
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
  stampShieldSurfacePool(world);
  stampCombatTargetingPool(world);
}
