import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// AIM-08.1/.2 — Per-tick stamping of the SoA targeting input slabs.
//
// Split into two passes:
//
//   stampShieldSurfacePool — runs once per tick, right after
//     updateShieldState. It always stamps the physical surfaces; the
//     sight-obstruction toggle gates the CONSUMERS (the scheduler's
//     shield_obstruction_active flag, the fog sightline's TS gate),
//     never the stamp. Same-tick readers (beam tracing, projectile
//     reflection, fog serialization) see current surfaces; the next
//     tick's FSM clearance gates read it one tick stale by design.
//
//   stampCombatTargetingPool — runs BEFORE updateTargetingAndFiringState.
//     Rebuilds current entity/turret input rows. The slab-owned FSM
//     tuple (state/target/cooldowns/losBlockedTicks) is not an input:
//     Rust preserves it across same-entity restamps and snapshots,
//     rendering, prediction, and combat read the slab directly.
//     Also compacts the per-tick targeting source list while the
//     entities are already hot in this stamping pass.

import type { WorldState } from '../WorldState';
import type { WindState } from '../wind';
import { entitySlotRegistry } from '../EntitySlotRegistry';
import {
  encodeShieldBarrierShape,
  encodeShieldReflectionPolicy,
  encodeShieldRocketLikeReflectionPolicy,
  getActiveShields,
} from './shieldTurret';
import {
  MIRROR_SIGHT_QUERY_PAD,
  turretIgnoresForceMaterialSightObstruction,
  weaponRequiresNonObstructedLineOfSight,
} from './lineOfSight';
import {
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { getProjectileMediumFrictionPer60HzFrame } from '../shotLocomotionMotion';
import {
  getPoweredShotReachabilityDistance,
  getShotLocomotionMediumAtHeight,
  shotLocomotionUsesBallisticFeasibility,
} from '../shotLocomotion';
import { WATER_LEVEL } from '../Terrain';
import { getUnitGroundZ } from '../unitGeometry';
import { getBuildingCombatCenterZ } from '../buildingAnchors';
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
  CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE,
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
  CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED,
  CT_TURRET_CFG_RANGE_TOP_UNBOUNDED,
  CT_TURRET_CFG_RANGE_SPHERE,
  CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
  CT_TURRET_CFG_REQUIRES_FULL_SIGHT,
  CT_TURRET_CFG_REQUIRES_AIR_TARGET,
  CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION,
  CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY,
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
  getUnitBlueprint,
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
} from '../types';

const _stampPos = { x: 0, y: 0, z: 0 };

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
  maxTurretsPerEntity: number;
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
  rotation: Float32Array;
  pitch: Float32Array;
  angularVelocity: Float32Array;
  pitchVelocity: Float32Array;
  aimHasSolution: Uint8Array;
  aimYaw: Float32Array;
  aimPitch: Float32Array;
  activeTurretMask: Uint32Array;
  firingTurretMask: Uint32Array;
  sensorCoverageMask: Uint32Array;
  fullSightCoverageMask: Uint32Array;
  detectorCoverageMask: Uint32Array;
};

export type CombatTargetingEntityReadContext = {
  views: CombatTargetingStateViews;
  slot: number;
  turretBase: number;
  turretCount: number;
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

type CombatTargetingTurretMountOut = {
  x: number;
  y: number;
  z: number;
};

export type CombatTargetingTurretAimOut = {
  hasSolution: boolean;
  yaw: number;
  pitch: number;
};

let _stateViews: CombatTargetingStateViews | null = null;
let _stateViewsSim: SimWasm | null = null;
let _combatTargetingSourceSlots = new Uint32Array(0);
let _combatTargetingSourceCount = 0;
let _combatTargetingSensorSourceSlots = new Uint32Array(0);
let _combatTargetingSensorSourceCount = 0;
let _combatTargetingTargetSlots = new Uint32Array(0);
let _combatTargetingTargetCount = 0;
const _stampViewMaskByPlayer = new Uint32Array(32);
let _stampViewMaskComputedBits = 0;
let _stampSlotUsed = new Uint8Array(0);
const _mountReadContext: CombatTargetingEntityReadContext = {
  views: null as never,
  slot: -1,
  turretBase: -1,
  turretCount: 0,
};
let _mountReadEntity: Entity | null = null;
let _mountReadTick = -1;
let _mountReadSim: SimWasm | null = null;

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

function resetCombatTargetingSources(): void {
  _combatTargetingSourceCount = 0;
  _combatTargetingSensorSourceCount = 0;
  _combatTargetingTargetCount = 0;
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

function ensureCombatTargetingTargetCapacity(count: number): void {
  if (count <= _combatTargetingTargetSlots.length) return;
  let next = Math.max(8, _combatTargetingTargetSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingTargetSlots.subarray(0, _combatTargetingTargetCount));
  _combatTargetingTargetSlots = slots;
}

function queueCombatTargetingTargetSlot(slot: number): void {
  const idx = _combatTargetingTargetCount;
  ensureCombatTargetingTargetCapacity(idx + 1);
  _combatTargetingTargetSlots[idx] = slot;
  _combatTargetingTargetCount++;
}

function ensureCombatTargetingSourceCapacity(count: number): void {
  if (count <= _combatTargetingSourceSlots.length) return;
  let next = Math.max(8, _combatTargetingSourceSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingSourceSlots.subarray(0, _combatTargetingSourceCount));
  _combatTargetingSourceSlots = slots;
}

function queueCombatTargetingSourceSlot(entity: Entity, slot: number): void {
  const combat = entity.combat;
  if (!entity.ownership || !combat || combat.turrets.length === 0) return;
  if (slot < 0) return;
  const idx = _combatTargetingSourceCount;
  ensureCombatTargetingSourceCapacity(idx + 1);
  _combatTargetingSourceSlots[idx] = slot;
  _combatTargetingSourceCount++;
}

function combatCanFire(combat: Entity['combat']): boolean {
  if (combat === null) return false;
  const fireState = combat.fireState ?? (combat.fireEnabled === false ? 'holdFire' : 'fireAtWill');
  if (fireState === 'fireAtWill' || fireState === 'defend' || fireState === 'fireAtAll') return true;
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

export function getCombatTargetingSourceSlots(): Uint32Array {
  return _combatTargetingSourceSlots.subarray(0, _combatTargetingSourceCount);
}

export function getCombatTargetingSourceCount(): number {
  return _combatTargetingSourceCount;
}

export function getCombatTargetingTargetSlots(): Uint32Array {
  return _combatTargetingTargetSlots.subarray(0, _combatTargetingTargetCount);
}

export function getCombatTargetingStateViews(sim: SimWasm): CombatTargetingStateViews {
  const cached = _stateViews;
  if (
    cached !== null &&
    _stateViewsSim === sim &&
    cached.state.byteLength > 0
  ) {
    return cached;
  }
  const targeting = sim.combatTargeting;
  const entityCapacity = targeting.entityCapacity();
  const maxTurretsPerEntity = targeting.maxTurretsPerEntity();
  const length = entityCapacity * maxTurretsPerEntity;
  const buffer = sim.memory.buffer;
  if (
    cached &&
    _stateViewsSim === sim &&
    cached.buffer === buffer &&
    cached.length === length &&
    cached.entityCapacity === entityCapacity &&
    cached.maxTurretsPerEntity === maxTurretsPerEntity &&
    cached.state.byteLength > 0
  ) {
    return cached;
  }

  _stateViewsSim = sim;
  _stateViews = {
    buffer,
    length,
    entityCapacity,
    maxTurretsPerEntity,
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
    rotation: new Float32Array(buffer, targeting.turretRotationPtr(), length),
    pitch: new Float32Array(buffer, targeting.turretPitchPtr(), length),
    angularVelocity: new Float32Array(buffer, targeting.turretAngularVelocityPtr(), length),
    pitchVelocity: new Float32Array(buffer, targeting.turretPitchVelocityPtr(), length),
    aimHasSolution: new Uint8Array(buffer, targeting.turretBallisticHasSolutionPtr(), length),
    aimYaw: new Float32Array(buffer, targeting.turretBallisticYawPtr(), length),
    aimPitch: new Float32Array(buffer, targeting.turretBallisticPitchPtr(), length),
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
    sensorCoverageMask: new Uint32Array(
      buffer,
      targeting.entitySensorCoverageMaskPtr(),
      entityCapacity,
    ),
    fullSightCoverageMask: new Uint32Array(
      buffer,
      targeting.entityFullSightCoverageMaskPtr(),
      entityCapacity,
    ),
    detectorCoverageMask: new Uint32Array(
      buffer,
      targeting.entityDetectorCoverageMaskPtr(),
      entityCapacity,
    ),
  };
  return _stateViews;
}

function invalidateCombatTargetingStateViews(): void {
  _stateViews = null;
  _stateViewsSim = null;
}

function invalidateCombatTargetingStateViewsIfSlotWillGrow(slot: number): void {
  const cached = _stateViews;
  if (cached !== null && slot >= cached.entityCapacity) {
    invalidateCombatTargetingStateViews();
  }
}

function getCombatTargetingTurretStateIndexFromViews(
  views: CombatTargetingStateViews,
  entity: Entity,
  turretIndex: number,
): number {
  if (turretIndex < 0) return -1;
  const slot = entitySlotRegistry.getEntitySlot(entity);
  if (slot < 0) return -1;
  if (slot >= views.entityCapacity) return -1;
  if (turretIndex >= views.turretCountPerEntity[slot]) return -1;
  return slot * views.maxTurretsPerEntity + turretIndex;
}

export function getCombatTargetingEntityReadContext(
  entity: Entity,
  out: CombatTargetingEntityReadContext,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  const views = getCombatTargetingStateViews(sim);
  const slot = entitySlotRegistry.getEntitySlot(entity);
  if (slot < 0 || slot >= views.entityCapacity) return false;
  out.views = views;
  out.slot = slot;
  out.turretBase = slot * views.maxTurretsPerEntity;
  out.turretCount = views.turretCountPerEntity[slot];
  return true;
}

function getCombatTargetingMountReadContext(
  entity: Entity,
  currentTick: number,
): CombatTargetingEntityReadContext | null {
  const sim = getSimWasm();
  if (sim === undefined) return null;
  if (
    _mountReadEntity === entity &&
    _mountReadTick === currentTick &&
    _mountReadSim === sim &&
    _mountReadContext.views.state.byteLength > 0
  ) {
    return _mountReadContext;
  }
  const views = getCombatTargetingStateViews(sim);
  const slot = entitySlotRegistry.getEntitySlot(entity);
  if (slot < 0 || slot >= views.entityCapacity) return null;
  _mountReadContext.views = views;
  _mountReadContext.slot = slot;
  _mountReadContext.turretBase = slot * views.maxTurretsPerEntity;
  _mountReadContext.turretCount = views.turretCountPerEntity[slot];
  _mountReadEntity = entity;
  _mountReadTick = currentTick;
  _mountReadSim = sim;
  return _mountReadContext;
}

export function readCombatTargetingTurretFsmFromContextInto(
  context: CombatTargetingEntityReadContext,
  turretIndex: number,
  out: CombatTargetingTurretFsmOut,
): boolean {
  if (turretIndex < 0 || turretIndex >= context.turretCount) return false;
  const idx = context.turretBase + turretIndex;
  const views = context.views;
  out.stateCode = views.state[idx] as CombatTargetingTurretStateCode;
  const targetId = views.targetId[idx];
  out.targetId = targetId < 0 ? -1 : targetId;
  return true;
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

function readCombatTargetingTurretFsmFromSimInto(
  sim: SimWasm,
  entity: Entity,
  turretIndex: number,
  out: CombatTargetingTurretFsmOut,
): boolean {
  const views = getCombatTargetingStateViews(sim);
  const idx = getCombatTargetingTurretStateIndexFromViews(views, entity, turretIndex);
  if (idx < 0) return false;
  out.stateCode = views.state[idx] as CombatTargetingTurretStateCode;
  const targetId = views.targetId[idx];
  out.targetId = targetId < 0 ? -1 : targetId;
  return true;
}

export function readCombatTargetingTurretAimFromContextInto(
  context: CombatTargetingEntityReadContext,
  turretIndex: number,
  out: CombatTargetingTurretAimOut,
): boolean {
  if (turretIndex < 0 || turretIndex >= context.turretCount) return false;
  const idx = context.turretBase + turretIndex;
  const views = context.views;
  out.hasSolution = views.aimHasSolution[idx] !== 0;
  out.yaw = views.aimYaw[idx];
  out.pitch = views.aimPitch[idx];
  return true;
}

/** Read the Rust-computed aim pose for one turret. The targeting scheduler
 *  writes this during LOS/ballistic/shield gate evaluation; direct-fire
 *  weapons use the same slab fields as ballistic weapons, with
 *  `hasSolution=true` and zero flight time. */
export function readCombatTargetingTurretAimInto(
  entity: Entity,
  turretIndex: number,
  out: CombatTargetingTurretAimOut,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  const views = getCombatTargetingStateViews(sim);
  const idx = getCombatTargetingTurretStateIndexFromViews(views, entity, turretIndex);
  if (idx < 0) return false;
  out.hasSolution = views.aimHasSolution[idx] !== 0;
  out.yaw = views.aimYaw[idx];
  out.pitch = views.aimPitch[idx];
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
  const context = getCombatTargetingMountReadContext(entity, currentTick);
  if (context === null) return false;
  if (turretIndex < 0 || turretIndex >= context.turretCount) return false;
  const views = context.views;
  const idx = context.turretBase + turretIndex;
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
  const context = getCombatTargetingMountReadContext(entity, currentTick);
  if (context === null) return false;
  return readCombatTargetingTurretMountKinematicsFromContextInto(
    context,
    turretIndex,
    currentTick,
    outPos,
    outVel,
  );
}

export function readCombatTargetingTurretMountKinematicsFromContextInto(
  context: CombatTargetingEntityReadContext,
  turretIndex: number,
  currentTick: number,
  outPos: { x: number; y: number; z: number },
  outVel: { x: number; y: number; z: number },
): boolean {
  if (turretIndex < 0 || turretIndex >= context.turretCount) return false;
  const views = context.views;
  const idx = context.turretBase + turretIndex;
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
  const shot = turret.config.shot;
  const ballisticShot =
    shot !== null &&
    isProjectileShot(shot) &&
    shotLocomotionUsesBallisticFeasibility(shot.shotLocomotion);
  if (
    ballisticShot && (
      angle === 'ballisticArcLow' ||
      angle === 'ballisticArcLowOnlyUnder' ||
      angle === 'ballisticArcHigh'
    )
  ) {
    f |= CT_TURRET_CFG_NEEDS_BALLISTIC;
  }
  if (turret.config.verticalLauncher === true) f |= CT_TURRET_CFG_VERTICAL_LAUNCHER;
  if (turret.config.isManualFire === true) f |= CT_TURRET_CFG_IS_MANUAL_FIRE;
  if (turret.config.passive === true) f |= CT_TURRET_CFG_PASSIVE;
  if (turret.id === NO_ENTITY_ID || turret.config.visualOnly === true) {
    f |= CT_TURRET_CFG_VISUAL_ONLY;
  }
  if (shot !== null && shot.type === 'shield') {
    f |= CT_TURRET_CFG_SHOT_IS_FORCE;
  }
  if (
    shot !== null &&
    isProjectileShot(shot) &&
    shot.shotLocomotion.media.air.operational &&
    !shot.shotLocomotion.media.water.operational
  ) {
    f |= CT_TURRET_CFG_REQUIRES_AIR_TARGET;
  }
  if (turretIgnoresForceMaterialSightObstruction(turret)) {
    f |= CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION;
  }
  if (turret.config.aimStyle.angleType === 'rayBisectTurretAndBody') {
    f |= CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY;
  }
  if (ranges.tracking) f |= CT_TURRET_CFG_HAS_TRACKING_RANGE;
  if (turret.config.hostDirected) f |= CT_TURRET_CFG_HOST_DIRECTED;
  if (turret.config.requiredEngagedForFightStop) {
    f |= CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP;
  }
  if (turret.config.requiresFullSight === true) {
    f |= CT_TURRET_CFG_REQUIRES_FULL_SIGHT;
  }
  switch (turret.config.rangeVolume) {
    case 'turret-range-bottom-unbounded':
      f |= CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED;
      break;
    case 'turret-range-top-water-and-bottom-unbounded':
      f |= CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED;
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
const _shotLaunchMediumMount = { x: 0, y: 0, z: 0 };
// Reused for every projectile turret stamped in a tick. The values are
// overwritten before each entity's turret loop, so this removes one short-
// lived options DTO per turret without sharing state across computations.
const _shotLaunchMediumContext: {
  currentTick: number | undefined;
  unitGroundZ: number | undefined;
  surfaceN: { nx: number; ny: number; nz: number } | undefined;
} = {
  currentTick: undefined,
  unitGroundZ: undefined,
  surfaceN: undefined,
};

function stampCombatTargetingEntityInto(
  targeting: CombatTargetingApi,
  world: WorldState,
  entity: Entity,
): number {
  const combat = entity.combat;
  const slot = entitySlotRegistry.getEntitySlot(entity);
  // Entities without a spatial slot can't be addressed by the slab;
  // the eventual kernel walks the slab, not the JS list, so anything
  // off-grid would be invisible to it anyway.
  if (slot < 0) return -1;
  reserveCombatTargetingSlot(slot);
  invalidateCombatTargetingStateViewsIfSlotWillGrow(slot);

  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const viewMask = getEntityViewMask(world, playerId);
  _stampPos.x = entity.transform.x;
  _stampPos.y = entity.transform.y;
  _stampPos.z = entity.transform.z;
  // Building combat boxes may be anchored away from transform.z (the fabricator
  // torus floats above its reserved build footprint).
  if (entity.building !== null) {
    _stampPos.z = getBuildingCombatCenterZ(entity);
  }
  const unit = entity.unit;
  const building = entity.building;
  const projectile = entity.projectile;
  let velX = 0;
  let velY = 0;
  let velZ = 0;
  if (unit !== null) {
    velX = unit.velocityX ?? 0;
    velY = unit.velocityY ?? 0;
    velZ = unit.velocityZ ?? 0;
  } else if (projectile !== null) {
    velX = projectile.velocityX;
    velY = projectile.velocityY;
    velZ = projectile.velocityZ;
  }
  const groundZ = getUnitGroundZ(entity);
  const rotCos = DMath.cos(entity.transform.rotation);
  const rotSin = DMath.sin(entity.transform.rotation);
  entity.transform.rotCos = rotCos;
  entity.transform.rotSin = rotSin;
  const surfaceN = unit ? unit.surfaceNormal : undefined;
  const surfaceNx = surfaceN ? surfaceN.nx : 0;
  const surfaceNy = surfaceN ? surfaceN.ny : 0;
  const surfaceNz = surfaceN ? surfaceN.nz : 1;
  const suspension = unit ? unit.suspension : undefined;
  const suspensionOffsetX = suspension ? suspension.offsetX : 0;
  const suspensionOffsetY = suspension ? suspension.offsetY : 0;
  const suspensionOffsetZ = suspension ? suspension.offsetZ : 0;
  const radiusHitbox = unit
    ? unit.radius.hitbox
    : (building
      ? building.targetRadius
      : (projectile && isProjectileShot(projectile.config.shot)
        ? projectile.config.shot.radius.hitbox
        : 0));
  // AABB half-extents for AABB-shaped targets (buildings). Sphere
  // targets (units/projectiles) stamp zeros so the Rust aim-point
  // resolver collapses to entity-center without branching on shape.
  const aabbHalfX = building ? building.width * 0.5 : 0;
  const aabbHalfY = building ? building.height * 0.5 : 0;
  const aabbHalfZ = building ? building.depth * 0.5 : 0;
  const hp = unit
    ? unit.hp
    : (building
      ? building.hp
      : (projectile && isProjectileShot(projectile.config.shot)
        ? projectile.hp
        : 0));

  let entityFlags = 0;
  if (combat) entityFlags |= CT_ENTITY_FLAG_HAS_COMBAT;
  if (hp > 0) entityFlags |= CT_ENTITY_FLAG_ALIVE;
  if (combatCanFire(combat)) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (isEntityActive(entity)) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }
  if (
    unit !== null &&
    getUnitBlueprint(unit.unitBlueprintId).preventLockOnIfMyTeamIsAboveMe === true
  ) {
    entityFlags |= CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE;
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
  if (unit) {
    entityFamily = CT_ENTITY_FAMILY_UNIT;
    entityBlueprintCode = unitBlueprintIdToCode(unit.unitBlueprintId);
  } else if (building) {
    entityFamily =
      entity.type === 'tower' ? CT_ENTITY_FAMILY_TOWER : CT_ENTITY_FAMILY_BUILDING;
    const buildingBlueprintId = entity.buildingBlueprintId;
    entityBlueprintCode =
      buildingBlueprintId !== null ? buildingBlueprintIdToCode(buildingBlueprintId) : CT_BLUEPRINT_CODE_NONE;
  } else if (projectile) {
    entityFamily = CT_ENTITY_FAMILY_SHOT;
    entityBlueprintCode = shotBlueprintIdToCode(projectile.shotBlueprintId);
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
  // The slab-owned FSM tuple (state, target, cooldown, burstCooldown,
  // losBlockedTicks) is no longer an input to setTurret. Rust preserves
  // it across same-entity restamps (clear() never resets it; kernels
  // and direct slab writers own its evolution) and seeds fresh-turret
  // constants on slot reuse, keyed off setEntity's same-entity check.
  targeting.setEntity(
    slot, entity.id, playerId, viewMask,
    _stampPos.x, _stampPos.y, _stampPos.z,
    velX, velY, velZ,
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

  if (turrets === null) return slot;
  const currentTick = world.getTick();
  _shotLaunchMediumContext.currentTick = currentTick;
  _shotLaunchMediumContext.unitGroundZ = groundZ;
  _shotLaunchMediumContext.surfaceN = surfaceN;
  const trajectoryMode = combat?.trajectoryMode ?? 'auto';
  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    const ranges = t.ranges;
    const shot = t.config.shot;
    const projectileShot: ProjectileShot | undefined =
      shot !== null && isProjectileShot(shot) ? shot : undefined;
    const angleType = t.config.aimStyle.angleType;
    const ballisticArcPreference = trajectoryMode === 'high'
      ? BALLISTIC_ARC_HIGH
      : trajectoryMode === 'low'
        ? BALLISTIC_ARC_LOW
        : angleType === 'ballisticArcHigh' ? BALLISTIC_ARC_HIGH : BALLISTIC_ARC_LOW;
    const projectileSpeed = projectileShot ? getProjectileLaunchSpeed(projectileShot) : 0;
    const projectileMass = projectileShot ? projectileShot.mass : 0;
    // worldPos is a downstream cache and is still unset on a freshly spawned
    // host. Resolve the current authoritative mount before choosing the shot's
    // launch medium, otherwise an underwater first tick looks like air and a
    // torpedo's powered-reach cap collapses to zero.
    const launchMount = projectileShot
      ? resolveWeaponWorldMount(
          entity,
          t,
          i,
          rotCos,
          rotSin,
          _shotLaunchMediumContext,
          _shotLaunchMediumMount,
        )
      : undefined;
    const launchMedium = projectileShot
      ? getShotLocomotionMediumAtHeight(
          projectileShot.shotLocomotion,
          launchMount!.z,
          WATER_LEVEL,
        )
      : undefined;
    const projectileAirFrictionPer60HzFrame = launchMedium
      ? getProjectileMediumFrictionPer60HzFrame(launchMedium)
      : 0;
    let maxTimeSec = 0;
    if (projectileShot) {
      const lifeMs = getShotMaxLifespan(projectileShot);
      maxTimeSec = Number.isFinite(lifeMs) ? lifeMs / 1000 : 0;
    }
    const poweredReach = projectileShot === undefined
      ? Infinity
      : getPoweredShotReachabilityDistance(
          projectileShot.shotLocomotion,
          launchMedium!,
          projectileSpeed,
          projectileMass,
        );
    const poweredReachSq = poweredReach * poweredReach;
    const fireMaxAcq = Math.min(rangeEdgeSq(ranges.fire.max, 'acquire'), poweredReachSq);
    const fireMaxRel = Math.min(rangeEdgeSq(ranges.fire.max, 'release'), poweredReachSq);
    const fireMinAcq = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'acquire') : 0;
    const fireMinRel = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'release') : 0;
    const trackingAcq = ranges.tracking
      ? Math.min(rangeEdgeSq(ranges.tracking, 'acquire'), poweredReachSq)
      : 0;
    const trackingRel = ranges.tracking
      ? Math.min(rangeEdgeSq(ranges.tracking, 'release'), poweredReachSq)
      : 0;
    const outermostAcq = Math.min(
      ranges.tracking ? ranges.tracking.acquire : ranges.fire.max.acquire,
      poweredReach,
    );

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
      fireMaxAcq, fireMaxRel,
      fireMinAcq, fireMinRel,
      trackingAcq, trackingRel,
      outermostAcq,
      t.mountOffset2d,
      t.mount.x, t.mount.y, t.mount.z,
      t.worldPosTick,
      encodeTurretConfigFlags(t, ranges),
      t.sustainedDps,
      projectileSpeed,
      projectileMass,
      projectileAirFrictionPer60HzFrame,
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
  return slot;
}

/** Rebuild every targetable entity row before the FSM runs. Turret rows
 *  are written for combat entities, but target lookup also needs
 *  unarmed buildings and traveling shots. The
 *  same walk compacts the source-id queue consumed by the scheduled
 *  Rust targeting batch, so the scheduler bridge does not need its own
 *  armed-entity traversal. */
export function stampCombatTargetingPool(world: WorldState, wind: WindState | null = null): void {
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
  if (wind !== null) {
    targeting.setWind(wind.x, wind.y, wind.z);
  } else {
    targeting.setWind(0, 0, 0);
  }

  const targets = world.getCombatTargetEntities();
  for (let i = 0; i < targets.length; i++) {
    const entity = targets[i];
    const slot = stampCombatTargetingEntityInto(targeting, world, entity);
    if (slot >= 0) {
      queueCombatTargetingTargetSlot(slot);
      queueCombatTargetingSourceSlot(entity, slot);
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

/** Rebuild the single shield surface pool. Runs once per tick, right
 *  after updateShieldState: beam tracing, projectile reflection, and
 *  fog sightlines read current-tick surfaces later the same tick, and
 *  the next tick's FSM clearance gates read it one tick stale.
 *
 *  The pool always carries the PHYSICAL surfaces. Whether they
 *  obstruct targeting/fog sightlines is decided by the consumers
 *  (shield_obstruction_active flag in the scheduler, the
 *  world.shieldsObstructSight gate in fog checks), never by stamping
 *  an emptied pool.
 *
 *  Materials Are Independent Of Shape: one pool holds both shapes.
 *   - Field surfaces come from getActiveShields(), gated by
 *     world.turretShieldSpheresEnabled (kernels short-circuit on empty).
 *   - Flat-panel surfaces come from world.getShieldPanelUnits(), gated by
 *     world.turretShieldPanelsEnabled. Inactive / dead mirror turrets are
 *     skipped; panel rows pack contiguously by unit. The slope-aware turret
 *     pivot is resolved fresh via resolveWeaponWorldMount — the same input the
 *     beam tracer / live aim solver uses — so the gate and the authoritative
 *     bounce path agree on where each panel sits. */
export function stampShieldSurfacePool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const pool = sim.shieldSurfacePool;

  // ── Spherical / infinite-cylinder field surfaces ──
  if (!world.turretShieldSpheresEnabled) {
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
        f.prevCenterX, f.prevCenterY, f.prevCenterZ,
        f.prevAxisEndX, f.prevAxisEndY, f.prevAxisEndZ,
        f.centerX, f.centerY, f.centerZ,
        f.axisEndX, f.axisEndY, f.axisEndZ,
        f.radius,
        encodeShieldBarrierShape(f.shape),
        encodeShieldReflectionPolicy(f.reflection, 'plasma'),
        encodeShieldRocketLikeReflectionPolicy(f.reflection),
        encodeShieldReflectionPolicy(f.reflection, 'beam'),
        encodeShieldReflectionPolicy(f.reflection, 'laser'),
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

  // setPanelCount starts a fresh panel stamp and clears the per-family
  // reflection mask. Do it before setPanel rows; calling it after the
  // rows would erase the mask that beam/projectile reflection queries use.
  let declaredPanelCount = 0;
  for (const unit of shieldPanelUnits) {
    declaredPanelCount += unit.unit?.shieldPanels.length ?? 0;
  }
  pool.setUnitCount(shieldPanelUnits.length);
  pool.setPanelCount(declaredPanelCount);

  const currentTick = world.getTick();
  let unitIdx = 0;
  let panelIdx = 0;
  for (const unit of shieldPanelUnits) {
    const activeShieldPanel = getActiveShieldPanelTurret(unit);
    if (activeShieldPanel === null || unit.unit === null) continue;
    const panels = unit.unit.shieldPanels;
    if (!panels || panels.length === 0) continue;

    const broadRadius = Math.max(unit.unit.shieldBoundRadius, unit.unit.radius.hitbox)
      + MIRROR_SIGHT_QUERY_PAD;
    const { turret: shieldPanelTurret, turretIndex: shieldPanelTurretIndex } = activeShieldPanel;
    const panelShot = shieldPanelTurret.config.shot;
    if (panelShot === null || panelShot.type !== 'shield') continue;
    const plasmaReflection = encodeShieldReflectionPolicy(panelShot.reflection, 'plasma');
    const rocketReflection = encodeShieldRocketLikeReflectionPolicy(panelShot.reflection);
    const beamReflection = encodeShieldReflectionPolicy(panelShot.reflection, 'beam');
    const laserReflection = encodeShieldReflectionPolicy(panelShot.reflection, 'laser');
    const shieldPanelRot = shieldPanelTurret.rotation;
    const shieldPanelPitch = shieldPanelTurret.pitch;
    const unitGroundZ = getUnitGroundZ(unit);
    const unitCS = {
      cos: DMath.cos(unit.transform.rotation),
      sin: DMath.sin(unit.transform.rotation),
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
        plasmaReflection,
        rocketReflection,
        beamReflection,
        laserReflection,
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
}
