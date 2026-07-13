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
import { measureWasmBoundary } from '../../perf/WasmBoundaryInstrumentation';
import {
  ENTITY_SLOT_FLAG_ACTIVE,
  ENTITY_SLOT_FLAG_HAS_COMBAT,
  entitySlotRegistry,
  type EntityStateViews,
} from '../EntitySlotRegistry';
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
import { getProjectileAirFrictionPer60HzFrame } from '../projectileMotion';
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
  CT_TURRET_CFG_RANGE_TOP_UNBOUNDED,
  CT_TURRET_CFG_RANGE_SPHERE,
  CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP,
  CT_TURRET_CFG_REQUIRES_FULL_SIGHT,
  CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION,
  CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY,
  CT_TURRET_STATE_IDLE,
  CT_TURRET_STATE_TRACKING,
  CT_TURRET_STATE_ENGAGED,
  ENTITY_STATE_KIND_UNIT,
  getSimWasm,
  type SimWasm,
} from '../../sim-wasm/init';
import {
  buildingBlueprintIdToCode,
  codeToUnitBlueprintId,
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
import { getBuildingConfig } from '../buildConfigs';
import { isBuildBlockingActivation, isEntityActive } from '../buildableHelpers';
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
const COMBAT_TARGETING_ENTITY_STAMP_ROW_STRIDE = 44;
const COMBAT_TARGETING_TURRET_STAMP_ROW_STRIDE = 45;
let _combatTargetingEntityStampSlots = new Uint32Array(0);
let _combatTargetingEntityStampRows = new Float64Array(0);
let _combatTargetingEntityStampCount = 0;
let _combatTargetingTurretStampEntitySlots = new Uint32Array(0);
let _combatTargetingTurretStampIndices = new Uint32Array(0);
let _combatTargetingTurretStampRows = new Float64Array(0);
let _combatTargetingTurretStampCount = 0;
let _combatTargetingSimpleUnitSlots = new Uint32Array(0);
let _combatTargetingSimpleUnitViewMasks = new Uint32Array(0);
let _combatTargetingSimpleUnitExtraFlags = new Uint8Array(0);
let _combatTargetingSimpleUnitSensorSlots = new Uint32Array(0);
let _combatTargetingSimpleUnitCount = 0;
const _stampViewMaskByPlayer = new Uint32Array(32);
let _stampViewMaskComputedBits = 0;
const _nativeObservationOnlyViewMasksByPlayer = new Uint32Array(32);
const _nativeObservationOnlyCounts = new Uint32Array(2);
const _nativeObservationOnlyExactTargets: Entity[] = [];
let _nativeObservationOnlyExactSlots = new Uint32Array(0);
let _nativeObservationOnlyExactSlotCount = 0;
const _mountReadContext: CombatTargetingEntityReadContext = {
  views: null as never,
  slot: -1,
  turretBase: -1,
  turretCount: 0,
};
let _mountReadEntity: Entity | null = null;
let _mountReadTick = -1;
let _mountReadSim: SimWasm | null = null;
type UnitTargetingBlueprintProfile = {
  blueprintCode: number;
  hostLockOn: LockOnMasks;
  preventLockOnIfTeamAbove: boolean;
};
type CombatTargetingTurretArrayProfile = {
  turretRowCapacity: number;
  hasSchedulerSource: boolean;
};
const EMPTY_TURRET_ARRAY_PROFILE: CombatTargetingTurretArrayProfile = {
  turretRowCapacity: 0,
  hasSchedulerSource: false,
};
const _unitTargetingBlueprintProfiles = new Map<string, UnitTargetingBlueprintProfile>();
const _combatTargetingTurretArrayProfiles =
  new WeakMap<readonly Turret[], CombatTargetingTurretArrayProfile>();
const COMBAT_TARGETING_UNIT_PROFILE_STRIDE = 11;
const CT_UNIT_PROFILE_FULL_VISION_RADIUS = 0;
const CT_UNIT_PROFILE_RADAR_RADIUS = 1;
const CT_UNIT_PROFILE_DETECTOR_RADIUS = 2;
const CT_UNIT_PROFILE_LOCKON_RELATIONSHIP = 3;
const CT_UNIT_PROFILE_LOCKON_ENTITY_FAMILY = 4;
const CT_UNIT_PROFILE_LOCKON_BUILDING = 5;
const CT_UNIT_PROFILE_LOCKON_TOWER = 6;
const CT_UNIT_PROFILE_LOCKON_UNIT = 7;
const CT_UNIT_PROFILE_LOCKON_TURRET = 8;
const CT_UNIT_PROFILE_LOCKON_SHOT = 9;
const CT_UNIT_PROFILE_FLAGS = 10;
const CT_UNIT_PROFILE_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE = 1 << 0;
let _combatTargetingUnitProfileUploaded = false;
let _combatTargetingUnitProfileCodeCount = 0;

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

function refreshNativeObservationOnlyViewMasks(world: WorldState): void {
  _nativeObservationOnlyViewMasksByPlayer.fill(0);
  _stampViewMaskComputedBits = 0;
  for (let playerId = 1; playerId < _nativeObservationOnlyViewMasksByPlayer.length; playerId++) {
    _nativeObservationOnlyViewMasksByPlayer[playerId] = getEntityViewMask(world, playerId);
  }
}

function resetCombatTargetingSources(): void {
  _combatTargetingSourceCount = 0;
  _combatTargetingSensorSourceCount = 0;
  _combatTargetingTargetCount = 0;
  _combatTargetingEntityStampCount = 0;
  _combatTargetingTurretStampCount = 0;
  _combatTargetingSimpleUnitCount = 0;
}

export function clearCombatTargetingStampQueues(): void {
  resetCombatTargetingSources();
  _stampViewMaskComputedBits = 0;
}

function getUnitTargetingBlueprintProfile(unitBlueprintId: string): UnitTargetingBlueprintProfile {
  let profile = _unitTargetingBlueprintProfiles.get(unitBlueprintId);
  if (profile !== undefined) return profile;
  profile = {
    blueprintCode: unitBlueprintIdToCode(unitBlueprintId),
    hostLockOn: getUnitHostLockOnMasks(unitBlueprintId),
    preventLockOnIfTeamAbove:
      getUnitBlueprint(unitBlueprintId).preventLockOnIfMyTeamIsAboveMe === true,
  };
  _unitTargetingBlueprintProfiles.set(unitBlueprintId, profile);
  return profile;
}

function bindCombatTargetingStampScratch(
  sim: SimWasm,
  entityCapacity: number,
  turretCapacity: number,
): void {
  const targeting = sim.combatTargeting;
  targeting.ensureStampScratchCapacity(entityCapacity, turretCapacity);
  const buffer = sim.memory.buffer;
  _combatTargetingEntityStampSlots = new Uint32Array(
    buffer,
    targeting.stampEntitySlotsPtr(),
    entityCapacity,
  );
  _combatTargetingEntityStampRows = new Float64Array(
    buffer,
    targeting.stampEntityRowsPtr(),
    entityCapacity * COMBAT_TARGETING_ENTITY_STAMP_ROW_STRIDE,
  );
  _combatTargetingTurretStampEntitySlots = new Uint32Array(
    buffer,
    targeting.stampTurretEntitySlotsPtr(),
    turretCapacity,
  );
  _combatTargetingTurretStampIndices = new Uint32Array(
    buffer,
    targeting.stampTurretIndicesPtr(),
    turretCapacity,
  );
  _combatTargetingTurretStampRows = new Float64Array(
    buffer,
    targeting.stampTurretRowsPtr(),
    turretCapacity * COMBAT_TARGETING_TURRET_STAMP_ROW_STRIDE,
  );
}

function ensureCombatTargetingTargetCapacity(count: number): void {
  if (count <= _combatTargetingTargetSlots.length) return;
  let next = Math.max(8, _combatTargetingTargetSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingTargetSlots.subarray(0, _combatTargetingTargetCount));
  _combatTargetingTargetSlots = slots;
}

function beginCombatTargetingEntityStampRow(slot: number): number {
  const idx = _combatTargetingEntityStampCount;
  _combatTargetingEntityStampSlots[idx] = slot;
  _combatTargetingEntityStampCount++;
  return idx * COMBAT_TARGETING_ENTITY_STAMP_ROW_STRIDE;
}

function beginCombatTargetingTurretStampRow(entitySlot: number, turretIndex: number): number {
  const idx = _combatTargetingTurretStampCount;
  _combatTargetingTurretStampEntitySlots[idx] = entitySlot;
  _combatTargetingTurretStampIndices[idx] = turretIndex;
  _combatTargetingTurretStampCount++;
  return idx * COMBAT_TARGETING_TURRET_STAMP_ROW_STRIDE;
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

function turretParticipatesInTargetingScheduler(turret: Turret): boolean {
  if (turret.id === NO_ENTITY_ID) return false;
  const config = turret.config;
  if (config.visualOnly || config.isManualFire) return false;
  return true;
}

function turretNeedsCombatTargetingSlabRow(turret: Turret): boolean {
  if (turret.id === NO_ENTITY_ID || turret.config.visualOnly) return false;
  if (
    turret.config.isManualFire &&
    turret.config.shot === null &&
    turret.config.passive !== true
  ) {
    return false;
  }
  return true;
}

function getCombatTargetingTurretArrayProfile(
  turrets: readonly Turret[] | null | undefined,
): CombatTargetingTurretArrayProfile {
  if (turrets === null || turrets === undefined || turrets.length === 0) {
    return EMPTY_TURRET_ARRAY_PROFILE;
  }

  const cached = _combatTargetingTurretArrayProfiles.get(turrets);
  if (cached !== undefined) return cached;

  let needsTurretRows = false;
  let hasSchedulerSource = false;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (!needsTurretRows && turretNeedsCombatTargetingSlabRow(turret)) {
      needsTurretRows = true;
    }
    if (!hasSchedulerSource && turretParticipatesInTargetingScheduler(turret)) {
      hasSchedulerSource = true;
    }
    if (needsTurretRows && hasSchedulerSource) break;
  }
  const profile = {
    turretRowCapacity: needsTurretRows ? turrets.length : 0,
    hasSchedulerSource,
  };
  _combatTargetingTurretArrayProfiles.set(turrets, profile);
  return profile;
}

function queueCombatTargetingSourceSlot(entity: Entity, slot: number): void {
  const combat = entity.combat;
  if (!entity.ownership || !combat || combat.turrets.length === 0) return;
  if (slot < 0) return;
  if (!getCombatTargetingTurretArrayProfile(combat.turrets).hasSchedulerSource) return;
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

function appendCombatTargetingSensorSourceSlots(slots: Uint32Array, count: number): void {
  if (count <= 0) return;
  const start = _combatTargetingSensorSourceCount;
  ensureCombatTargetingSensorSourceCapacity(start + count);
  _combatTargetingSensorSourceSlots.set(slots.subarray(0, count), start);
  _combatTargetingSensorSourceCount = start + count;
}

function ensureNativeObservationOnlyExactSlotCapacity(count: number): void {
  if (count <= _nativeObservationOnlyExactSlots.length) return;
  let next = Math.max(8, _nativeObservationOnlyExactSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_nativeObservationOnlyExactSlots.subarray(0, _nativeObservationOnlyExactSlotCount));
  _nativeObservationOnlyExactSlots = slots;
}

function queueNativeObservationOnlyExactTarget(entity: Entity, slot: number): void {
  const idx = _nativeObservationOnlyExactSlotCount;
  ensureNativeObservationOnlyExactSlotCapacity(idx + 1);
  _nativeObservationOnlyExactSlots[idx] = slot;
  _nativeObservationOnlyExactSlotCount = idx + 1;
  _nativeObservationOnlyExactTargets.push(entity);
}

function queueCombatTargetingSensorSourceSlot(slot: number): void {
  const idx = _combatTargetingSensorSourceCount;
  ensureCombatTargetingSensorSourceCapacity(idx + 1);
  _combatTargetingSensorSourceSlots[idx] = slot;
  _combatTargetingSensorSourceCount++;
}

function ensureCombatTargetingSimpleUnitCapacity(count: number): void {
  if (count <= _combatTargetingSimpleUnitSlots.length) return;
  let next = Math.max(8, _combatTargetingSimpleUnitSlots.length);
  while (next < count) next *= 2;
  const slots = new Uint32Array(next);
  slots.set(_combatTargetingSimpleUnitSlots.subarray(0, _combatTargetingSimpleUnitCount));
  _combatTargetingSimpleUnitSlots = slots;
  const viewMasks = new Uint32Array(next);
  viewMasks.set(_combatTargetingSimpleUnitViewMasks.subarray(0, _combatTargetingSimpleUnitCount));
  _combatTargetingSimpleUnitViewMasks = viewMasks;
  const extraFlags = new Uint8Array(next);
  extraFlags.set(_combatTargetingSimpleUnitExtraFlags.subarray(0, _combatTargetingSimpleUnitCount));
  _combatTargetingSimpleUnitExtraFlags = extraFlags;
  _combatTargetingSimpleUnitSensorSlots = new Uint32Array(next);
}

function ensureCombatTargetingUnitProfileTable(sim: SimWasm): void {
  if (_combatTargetingUnitProfileUploaded) return;

  let codeCount = 0;
  while (codeToUnitBlueprintId(codeCount) !== null) codeCount++;
  sim.combatTargeting.unitProfileEnsure(codeCount);
  const stride = sim.combatTargeting.unitProfileStride();
  if (stride !== COMBAT_TARGETING_UNIT_PROFILE_STRIDE) {
    throw new Error(
      `combat targeting unit profile stride mismatch: TS=${COMBAT_TARGETING_UNIT_PROFILE_STRIDE} WASM=${stride}`,
    );
  }
  const values = new Float64Array(
    sim.memory.buffer,
    sim.combatTargeting.unitProfileValuesPtr(),
    codeCount * COMBAT_TARGETING_UNIT_PROFILE_STRIDE,
  );
  values.fill(0);
  for (let code = 0; code < codeCount; code++) {
    const unitBlueprintId = codeToUnitBlueprintId(code);
    if (unitBlueprintId === null) continue;
    const bp = getUnitBlueprint(unitBlueprintId);
    const hostLockOn = getUnitHostLockOnMasks(unitBlueprintId);
    const base = code * COMBAT_TARGETING_UNIT_PROFILE_STRIDE;
    values[base + CT_UNIT_PROFILE_FULL_VISION_RADIUS] = bp.sensors.fullSightRadius;
    values[base + CT_UNIT_PROFILE_RADAR_RADIUS] = bp.sensors.radarRadius;
    values[base + CT_UNIT_PROFILE_DETECTOR_RADIUS] = bp.sensors.detectorRadius;
    values[base + CT_UNIT_PROFILE_LOCKON_RELATIONSHIP] = hostLockOn.relationship;
    values[base + CT_UNIT_PROFILE_LOCKON_ENTITY_FAMILY] = hostLockOn.entityFamily;
    values[base + CT_UNIT_PROFILE_LOCKON_BUILDING] = hostLockOn.building;
    values[base + CT_UNIT_PROFILE_LOCKON_TOWER] = hostLockOn.tower;
    values[base + CT_UNIT_PROFILE_LOCKON_UNIT] = hostLockOn.unit;
    values[base + CT_UNIT_PROFILE_LOCKON_TURRET] = hostLockOn.turret;
    values[base + CT_UNIT_PROFILE_LOCKON_SHOT] = hostLockOn.shot;
    values[base + CT_UNIT_PROFILE_FLAGS] =
      bp.preventLockOnIfMyTeamIsAboveMe === true
        ? CT_UNIT_PROFILE_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE
        : 0;
  }
  _combatTargetingUnitProfileCodeCount = codeCount;
  _combatTargetingUnitProfileUploaded = true;
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
  const rocketLikeShot =
    shot !== null &&
    isProjectileShot(shot) &&
    (shot.type === 'rocket' || shot.type === 'missile');
  if (
    rocketLikeShot ||
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
  if (shot !== null && shot.type === 'shield') {
    f |= CT_TURRET_CFG_SHOT_IS_FORCE;
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

function tryQueueSimpleUnitCombatTargetingStamp(
  world: WorldState,
  entity: Entity,
  entityViews: EntityStateViews | null,
): boolean {
  const unit = entity.unit;
  if (unit === null || entityViews === null) return false;
  const slot = entitySlotRegistry.getEntitySlot(entity);
  if (
    slot < 0 ||
    slot >= entityViews.capacity ||
    entityViews.entityId[slot] !== entity.id ||
    entityViews.kind[slot] !== ENTITY_STATE_KIND_UNIT
  ) {
    return false;
  }
  const profileCode = entityViews.unitBlueprintCode[slot];
  if (
    profileCode < 0 ||
    profileCode >= _combatTargetingUnitProfileCodeCount ||
    codeToUnitBlueprintId(profileCode) === null
  ) {
    return false;
  }

  // Entity-state currently owns the body pose, velocity, surface normal,
  // radii, hp, owner, and blueprint code. Suspension offsets and priority
  // commands are still JS-only, so keep those units on the legacy exact path.
  if (unit.suspension !== null) return false;
  const combat = entity.combat;
  if (
    combat !== null &&
    (
      combat.priorityTargetId !== null ||
      combat.priorityTargetPoint !== null ||
      combat.manualLaunchActive ||
      combat.nextCombatProbeTick >= 0
    )
  ) {
    return false;
  }
  const turrets = combat !== null ? combat.turrets : null;
  if (getCombatTargetingTurretArrayProfile(turrets).turretRowCapacity !== 0) return false;

  const idx = _combatTargetingSimpleUnitCount;
  ensureCombatTargetingSimpleUnitCapacity(idx + 1);
  _combatTargetingSimpleUnitSlots[idx] = slot;
  const playerId = entityViews.ownerPlayerId[slot];
  _combatTargetingSimpleUnitViewMasks[idx] = getEntityViewMask(world, playerId);
  let extraFlags = 0;
  if (combat !== null) {
    extraFlags |= CT_ENTITY_FLAG_HAS_COMBAT;
    if (combatCanFire(combat)) extraFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  }
  if (unit.cloaked === true) extraFlags |= CT_ENTITY_FLAG_CLOAKED;
  _combatTargetingSimpleUnitExtraFlags[idx] = extraFlags;
  _combatTargetingSimpleUnitCount = idx + 1;
  queueCombatTargetingTargetSlot(slot);
  return true;
}

function prepareNativeObservationOnlyExactTargets(
  world: WorldState,
  entityViews: EntityStateViews,
): boolean {
  _nativeObservationOnlyExactTargets.length = 0;
  _nativeObservationOnlyExactSlotCount = 0;
  if (world.getProjectiles().length > 0) return false;
  if (world.getBuildings().length > 0) return false;

  let nativeCandidateCount = 0;
  const units = world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const entity = units[i];
    const unit = entity.unit;
    if (unit === null) return false;
    const slot = entitySlotRegistry.getEntitySlot(entity);
    if (
      slot < 0 ||
      slot >= entityViews.capacity ||
      entityViews.entityId[slot] !== entity.id ||
      entityViews.kind[slot] !== ENTITY_STATE_KIND_UNIT
    ) {
      return false;
    }

    const entityStateHasCombat = (entityViews.flags[slot] & ENTITY_SLOT_FLAG_HAS_COMBAT) !== 0;
    const combat = entity.combat;
    if (unit.suspension !== null || unit.cloaked === true) {
      queueNativeObservationOnlyExactTarget(entity, slot);
      continue;
    }

    if (combat !== null) {
      const turretProfile = getCombatTargetingTurretArrayProfile(combat.turrets);
      if (
        !entityStateHasCombat ||
        turretProfile.turretRowCapacity !== 0 ||
        combat.priorityTargetId !== null ||
        combat.priorityTargetPoint !== null ||
        combat.manualLaunchActive ||
        combat.nextCombatProbeTick >= 0 ||
        !combatCanFire(combat)
      ) {
        queueNativeObservationOnlyExactTarget(entity, slot);
      } else {
        nativeCandidateCount++;
      }
      continue;
    }

    if (entityStateHasCombat) {
      queueNativeObservationOnlyExactTarget(entity, slot);
    } else {
      nativeCandidateCount++;
    }
  }
  _nativeObservationOnlyExactSlots
    .subarray(0, _nativeObservationOnlyExactSlotCount)
    .sort();
  return nativeCandidateCount > 0;
}

function tryStampNativeObservationOnlySimpleUnitsFromEntityState(
  world: WorldState,
  sim: SimWasm,
): readonly Entity[] | null {
  const entityViews = entitySlotRegistry.getViews();
  if (entityViews === null) return null;
  if (!prepareNativeObservationOnlyExactTargets(world, entityViews)) return null;

  const targeting = sim.combatTargeting;
  const capacity = Math.min(entityViews.capacity, targeting.entityCapacity());
  ensureCombatTargetingTargetCapacity(capacity);
  ensureCombatTargetingSimpleUnitCapacity(capacity);
  refreshNativeObservationOnlyViewMasks(world);
  _nativeObservationOnlyCounts[0] = 0;
  _nativeObservationOnlyCounts[1] = 0;

  let stampedCount = measureWasmBoundary(
    'combatTargeting.stampObservationOnlySimpleUnits',
    () => targeting.stampObservationOnlySimpleUnitsFromEntityState(
      _nativeObservationOnlyViewMasksByPlayer,
      _nativeObservationOnlyExactSlots.subarray(0, _nativeObservationOnlyExactSlotCount),
      _combatTargetingTargetSlots.subarray(0, capacity),
      _combatTargetingSimpleUnitSensorSlots.subarray(0, capacity),
      _nativeObservationOnlyCounts,
    ),
  );
  if (stampedCount < 0) {
    const required = -stampedCount;
    ensureCombatTargetingTargetCapacity(required);
    ensureCombatTargetingSimpleUnitCapacity(required);
    stampedCount = measureWasmBoundary(
      'combatTargeting.stampObservationOnlySimpleUnits',
      () => targeting.stampObservationOnlySimpleUnitsFromEntityState(
        _nativeObservationOnlyViewMasksByPlayer,
        _nativeObservationOnlyExactSlots.subarray(0, _nativeObservationOnlyExactSlotCount),
        _combatTargetingTargetSlots.subarray(0, required),
        _combatTargetingSimpleUnitSensorSlots.subarray(0, required),
        _nativeObservationOnlyCounts,
      ),
    );
  }
  if (stampedCount < 0) return null;

  _combatTargetingTargetCount = _nativeObservationOnlyCounts[0];
  _combatTargetingSensorSourceCount = 0;
  appendCombatTargetingSensorSourceSlots(
    _combatTargetingSimpleUnitSensorSlots,
    _nativeObservationOnlyCounts[1],
  );
  return _nativeObservationOnlyExactTargets;
}

function stampCombatTargetingEntityInto(
  world: WorldState,
  entity: Entity,
  entityViews: EntityStateViews | null,
): number {
  const combat = entity.combat;
  const slot = entitySlotRegistry.getEntitySlot(entity);
  // Entities without a spatial slot can't be addressed by the slab;
  // the eventual kernel walks the slab, not the JS list, so anything
  // off-grid would be invisible to it anyway.
  if (slot < 0) return -1;
  invalidateCombatTargetingStateViewsIfSlotWillGrow(slot);

  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const viewMask = getEntityViewMask(world, playerId);
  const transform = entity.transform;
  const unit = entity.unit;
  const building = entity.building;
  const projectile = entity.projectile;
  const hasEntityState =
    entityViews !== null &&
    slot < entityViews.capacity &&
    entityViews.entityId[slot] === entity.id;
  const posX = hasEntityState ? entityViews.posX[slot] : transform.x;
  const posY = hasEntityState ? entityViews.posY[slot] : transform.y;
  // Building combat boxes may be anchored away from transform.z (the fabricator
  // torus floats above its reserved build footprint).
  const posZ = building !== null
    ? getBuildingCombatCenterZ(entity)
    : hasEntityState ? entityViews.posZ[slot] : transform.z;
  let velX = 0;
  let velY = 0;
  let velZ = 0;
  let groundZ = hasEntityState ? entityViews.posZ[slot] : transform.z;
  if (unit !== null) {
    velX = hasEntityState ? entityViews.velX[slot] : unit.velocityX ?? 0;
    velY = hasEntityState ? entityViews.velY[slot] : unit.velocityY ?? 0;
    velZ = hasEntityState ? entityViews.velZ[slot] : unit.velocityZ ?? 0;
    groundZ = (hasEntityState ? entityViews.posZ[slot] : transform.z) - unit.bodyCenterHeight;
  } else if (projectile !== null) {
    velX = hasEntityState ? entityViews.velX[slot] : projectile.velocityX;
    velY = hasEntityState ? entityViews.velY[slot] : projectile.velocityY;
    velZ = hasEntityState ? entityViews.velZ[slot] : projectile.velocityZ;
  } else if (building !== null) {
    groundZ = (hasEntityState ? entityViews.posZ[slot] : transform.z) - building.depth * 0.5;
  }
  const rotation = hasEntityState ? entityViews.rotation[slot] : transform.rotation;
  const surfaceN = unit ? unit.surfaceNormal : undefined;
  const surfaceNx = hasEntityState ? entityViews.surfaceNormalX[slot] : surfaceN ? surfaceN.nx : 0;
  const surfaceNy = hasEntityState ? entityViews.surfaceNormalY[slot] : surfaceN ? surfaceN.ny : 0;
  const surfaceNz = hasEntityState ? entityViews.surfaceNormalZ[slot] : surfaceN ? surfaceN.nz : 1;
  const suspension = unit ? unit.suspension : undefined;
  const suspensionOffsetX = suspension ? suspension.offsetX : 0;
  const suspensionOffsetY = suspension ? suspension.offsetY : 0;
  const suspensionOffsetZ = suspension ? suspension.offsetZ : 0;
  const projectileShot = projectile !== null && isProjectileShot(projectile.config.shot)
    ? projectile.config.shot
    : null;
  const radiusHitbox = hasEntityState
    ? entityViews.radiusHitbox[slot]
    : unit
      ? unit.radius.hitbox
      : (building
        ? building.targetRadius
        : (projectileShot !== null
          ? projectileShot.radius.hitbox
          : 0));
  // AABB half-extents for AABB-shaped targets (buildings). Sphere
  // targets (units/projectiles) stamp zeros so the Rust aim-point
  // resolver collapses to entity-center without branching on shape.
  const aabbHalfX = building
    ? hasEntityState ? entityViews.aabbHx[slot] : building.width * 0.5
    : 0;
  const aabbHalfY = building
    ? hasEntityState ? entityViews.aabbHy[slot] : building.height * 0.5
    : 0;
  const aabbHalfZ = building
    ? hasEntityState ? entityViews.aabbHz[slot] : building.depth * 0.5
    : 0;
  const hp = hasEntityState
    ? entityViews.hp[slot]
    : unit
      ? unit.hp
      : (building
        ? building.hp
        : (projectile !== null && projectileShot !== null
          ? projectile.hp
          : 0));

  let entityFlags = 0;
  if (combat) entityFlags |= CT_ENTITY_FLAG_HAS_COMBAT;
  if (hp > 0) entityFlags |= CT_ENTITY_FLAG_ALIVE;
  if (combatCanFire(combat)) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (hasEntityState ? (entityViews.flags[slot] & ENTITY_SLOT_FLAG_ACTIVE) !== 0 : isEntityActive(entity)) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }

  // LOCK-ON-03 — Stamp the entity's family + blueprint id so the Rust
  // exclusion gate can reject candidates by family/name without
  // crossing back into JS. Projectile-style entities with neither
  // Rows without unit, building, or projectile data stamp NONE/sentinel; the
  // kernel reads these as "no family to match" and ignores level-0
  // family / level-1 named exclusions for that row.
  let entityFamily: number = CT_ENTITY_FAMILY_NONE;
  let entityBlueprintCode: number = CT_BLUEPRINT_CODE_NONE;
  let hostLockOn: LockOnMasks = EMPTY_LOCK_ON_MASKS;
  let fullVisionRadius = 0;
  let radarRadius = 0;
  let detectorRadius = 0;
  let visibilityPadding = 0;
  if (unit) {
    const unitBlueprintId = unit.unitBlueprintId;
    const unitProfile = getUnitTargetingBlueprintProfile(unitBlueprintId);
    entityFamily = CT_ENTITY_FAMILY_UNIT;
    entityBlueprintCode = hasEntityState ? entityViews.unitBlueprintCode[slot] : unitProfile.blueprintCode;
    hostLockOn = unitProfile.hostLockOn;
    if (unitProfile.preventLockOnIfTeamAbove) {
      entityFlags |= CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE;
    }
    if (unit.cloaked === true) {
      entityFlags |= CT_ENTITY_FLAG_CLOAKED;
    }
    if (unit.hp > 0) {
      const sensors = unit.sensors;
      fullVisionRadius = sensors.fullSightRadius > 0 ? sensors.fullSightRadius : 0;
      radarRadius = sensors.radarRadius > 0 ? sensors.radarRadius : 0;
      detectorRadius = sensors.detectorRadius > 0 ? sensors.detectorRadius : 0;
    }
    visibilityPadding = Math.max(
      hasEntityState ? entityViews.radiusOther[slot] : unit.radius.other,
      radiusHitbox,
      hasEntityState ? entityViews.radiusCollision[slot] : unit.radius.collision,
    );
  } else if (building) {
    entityFamily =
      entity.type === 'tower' ? CT_ENTITY_FAMILY_TOWER : CT_ENTITY_FAMILY_BUILDING;
    const buildingBlueprintId = entity.buildingBlueprintId;
    entityBlueprintCode = hasEntityState
      ? entityViews.buildingBlueprintCode[slot]
      : buildingBlueprintId !== null ? buildingBlueprintIdToCode(buildingBlueprintId) : CT_BLUEPRINT_CODE_NONE;
    if (entity.type === 'tower' && buildingBlueprintId !== null) {
      hostLockOn = getTowerHostLockOnMasks(buildingBlueprintId);
    }
    const activeState = building.activeState;
    if (
      buildingBlueprintId !== null &&
      building.hp > 0 &&
      !isBuildBlockingActivation(entity.buildable) &&
      (activeState === null || activeState.open !== false)
    ) {
      const sensors = getBuildingConfig(buildingBlueprintId).sensors;
      fullVisionRadius = sensors.fullSightRadius > 0 ? sensors.fullSightRadius : 0;
      radarRadius = sensors.radarRadius > 0 ? sensors.radarRadius : 0;
      detectorRadius = sensors.detectorRadius > 0 ? sensors.detectorRadius : 0;
    }
    visibilityPadding = hasEntityState
      ? entityViews.radiusOther[slot]
      : Math.max(building.width, building.height) * 0.5;
  } else if (projectile) {
    entityFamily = CT_ENTITY_FAMILY_SHOT;
    entityBlueprintCode = hasEntityState
      ? entityViews.shotBlueprintCode[slot]
      : shotBlueprintIdToCode(projectile.shotBlueprintId);
  }

  // Sight + radar radii and entity-size padding stamped per-entity so
  // the Rust observability helper can walk the slab itself. Padding is
  // the target's footprint, so a unit counts as observed when its edge
  // (not just its center) falls inside a vision/radar circle.
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
  const turretArrayProfile = getCombatTargetingTurretArrayProfile(turrets);
  const skipTurretRows = turretArrayProfile.turretRowCapacity === 0;
  // The slab-owned FSM tuple (state, target, cooldown, burstCooldown,
  // losBlockedTicks) is no longer an input to setTurret. Rust preserves
  // it across same-entity restamps (clear() never resets it; kernels
  // and direct slab writers own its evolution) and seeds fresh-turret
  // constants on slot reuse, keyed off setEntity's same-entity check.
  const entityRow = beginCombatTargetingEntityStampRow(slot);
  const entityRows = _combatTargetingEntityStampRows;
  entityRows[entityRow] = entity.id;
  entityRows[entityRow + 1] = playerId;
  entityRows[entityRow + 2] = viewMask;
  entityRows[entityRow + 3] = posX;
  entityRows[entityRow + 4] = posY;
  entityRows[entityRow + 5] = posZ;
  entityRows[entityRow + 6] = velX;
  entityRows[entityRow + 7] = velY;
  entityRows[entityRow + 8] = velZ;
  entityRows[entityRow + 9] = groundZ;
  // Rust derives deterministic sin/cos once inside setEntityRowsBatch.
  // Sending yaw avoids two scalar JS/WASM calls per targetable entity.
  entityRows[entityRow + 10] = rotation;
  entityRows[entityRow + 11] = 0;
  entityRows[entityRow + 12] = surfaceNx;
  entityRows[entityRow + 13] = surfaceNy;
  entityRows[entityRow + 14] = surfaceNz;
  entityRows[entityRow + 15] = suspensionOffsetX;
  entityRows[entityRow + 16] = suspensionOffsetY;
  entityRows[entityRow + 17] = suspensionOffsetZ;
  entityRows[entityRow + 18] = radiusHitbox;
  entityRows[entityRow + 19] = aabbHalfX;
  entityRows[entityRow + 20] = aabbHalfY;
  entityRows[entityRow + 21] = aabbHalfZ;
  entityRows[entityRow + 22] = hp;
  entityRows[entityRow + 23] = entityFlags;
  entityRows[entityRow + 24] = entityFamily;
  entityRows[entityRow + 25] = entityBlueprintCode;
  entityRows[entityRow + 26] = hostLockOn.relationship;
  entityRows[entityRow + 27] = hostLockOn.entityFamily;
  entityRows[entityRow + 28] = hostLockOn.building;
  entityRows[entityRow + 29] = hostLockOn.tower;
  entityRows[entityRow + 30] = hostLockOn.unit;
  entityRows[entityRow + 31] = hostLockOn.turret;
  entityRows[entityRow + 32] = hostLockOn.shot;
  entityRows[entityRow + 33] = fullVisionRadius;
  entityRows[entityRow + 34] = radarRadius;
  entityRows[entityRow + 35] = detectorRadius;
  entityRows[entityRow + 36] = visibilityPadding;
  entityRows[entityRow + 37] = priorityTargetId === null ? -1 : priorityTargetId;
  entityRows[entityRow + 38] = priorityPointPresent;
  entityRows[entityRow + 39] = priorityPointX;
  entityRows[entityRow + 40] = priorityPointY;
  entityRows[entityRow + 41] = priorityPointZ;
  entityRows[entityRow + 42] = scheduledProbeTick;
  entityRows[entityRow + 43] = turrets !== null && !skipTurretRows ? turrets.length : 0;

  if (turrets === null || skipTurretRows) return slot;
  const trajectoryMode = combat === null ? 'auto' : combat.trajectoryMode;
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
    const projectileAirFrictionPer60HzFrame = projectileShot
      ? getProjectileAirFrictionPer60HzFrame(projectileShot)
      : 0;
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
    const turretRow = beginCombatTargetingTurretStampRow(slot, i);
    const turretRows = _combatTargetingTurretStampRows;
    turretRows[turretRow] = t.id;
    turretRows[turretRow + 1] = t.parentId;
    turretRows[turretRow + 2] = t.rootHostId;
    turretRows[turretRow + 3] = t.mountIndex;
    turretRows[turretRow + 4] = t.worldPos.x;
    turretRows[turretRow + 5] = t.worldPos.y;
    turretRows[turretRow + 6] = t.worldPos.z;
    turretRows[turretRow + 7] = t.config.radius.hitbox;
    turretRows[turretRow + 8] = t.worldVelocity.x;
    turretRows[turretRow + 9] = t.worldVelocity.y;
    turretRows[turretRow + 10] = t.worldVelocity.z;
    turretRows[turretRow + 11] = t.rotation;
    turretRows[turretRow + 12] = t.pitch;
    turretRows[turretRow + 13] = t.angularVelocity;
    turretRows[turretRow + 14] = t.pitchVelocity;
    turretRows[turretRow + 15] = fireMaxAcq;
    turretRows[turretRow + 16] = fireMaxRel;
    turretRows[turretRow + 17] = fireMinAcq;
    turretRows[turretRow + 18] = fireMinRel;
    turretRows[turretRow + 19] = trackingAcq;
    turretRows[turretRow + 20] = trackingRel;
    turretRows[turretRow + 21] = outermostAcq;
    turretRows[turretRow + 22] = t.mountOffset2d;
    turretRows[turretRow + 23] = t.mount.x;
    turretRows[turretRow + 24] = t.mount.y;
    turretRows[turretRow + 25] = t.mount.z;
    turretRows[turretRow + 26] = t.worldPosTick;
    turretRows[turretRow + 27] = encodeTurretConfigFlags(t, ranges);
    turretRows[turretRow + 28] = t.sustainedDps;
    turretRows[turretRow + 29] = projectileSpeed;
    turretRows[turretRow + 30] = projectileMass;
    turretRows[turretRow + 31] = projectileAirFrictionPer60HzFrame;
    turretRows[turretRow + 32] = ballisticArcPreference;
    turretRows[turretRow + 33] = maxTimeSec;
    turretRows[turretRow + 34] = t.config.groundAimFraction ?? 0;
    turretRows[turretRow + 35] = angleType === 'ballisticArcLowOnlyUnder' ? 1 : 0;
    turretRows[turretRow + 36] = turretBlueprintIdToCode(t.config.turretBlueprintId);
    turretRows[turretRow + 37] = t.config.lockOnRelationshipIncludeMask;
    turretRows[turretRow + 38] = t.config.lockOnEntityFamilyIncludeMask;
    turretRows[turretRow + 39] = t.config.lockOnBuildingIncludeMask;
    turretRows[turretRow + 40] = t.config.lockOnTowerIncludeMask;
    turretRows[turretRow + 41] = t.config.lockOnUnitIncludeMask;
    turretRows[turretRow + 42] = t.config.lockOnTurretIncludeMask;
    turretRows[turretRow + 43] = t.config.lockOnShotIncludeMask;
    turretRows[turretRow + 44] = t.config.lockOnRequiresTargetLockedOntoSelfMode;
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
  _stampViewMaskComputedBits = 0;
  const sim = getSimWasm();
  if (sim === undefined) return;
  ensureCombatTargetingUnitProfileTable(sim);
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
  const nativeExactTargets = tryStampNativeObservationOnlySimpleUnitsFromEntityState(world, sim);
  const targets = nativeExactTargets ?? world.getCombatTargetEntities();
  let turretCapacity = 0;
  for (let i = 0; i < targets.length; i++) {
    const turrets = targets[i].combat?.turrets ?? null;
    turretCapacity += getCombatTargetingTurretArrayProfile(turrets).turretRowCapacity;
  }
  bindCombatTargetingStampScratch(sim, targets.length, turretCapacity);
  const entityViews = entitySlotRegistry.getViews();
  for (const entity of targets) {
    if (tryQueueSimpleUnitCombatTargetingStamp(world, entity, entityViews)) {
      continue;
    }
    const slot = stampCombatTargetingEntityInto(world, entity, entityViews);
    if (slot >= 0) {
      queueCombatTargetingTargetSlot(slot);
      queueCombatTargetingSourceSlot(entity, slot);
    }
  }
  if (_combatTargetingSimpleUnitCount > 0) {
    let simpleSensorCount = measureWasmBoundary('combatTargeting.stampSimpleUnitEntities', () =>
      targeting.stampSimpleUnitEntitiesFromEntityState(
        _combatTargetingSimpleUnitCount,
        _combatTargetingSimpleUnitSlots.subarray(0, _combatTargetingSimpleUnitCount),
        _combatTargetingSimpleUnitViewMasks.subarray(0, _combatTargetingSimpleUnitCount),
        _combatTargetingSimpleUnitExtraFlags.subarray(0, _combatTargetingSimpleUnitCount),
        _combatTargetingSimpleUnitSensorSlots.subarray(0, _combatTargetingSimpleUnitCount),
      )
    );
    if (simpleSensorCount < 0) {
      ensureCombatTargetingSimpleUnitCapacity(-simpleSensorCount);
      simpleSensorCount = measureWasmBoundary('combatTargeting.stampSimpleUnitEntities', () =>
        targeting.stampSimpleUnitEntitiesFromEntityState(
          _combatTargetingSimpleUnitCount,
          _combatTargetingSimpleUnitSlots.subarray(0, _combatTargetingSimpleUnitCount),
          _combatTargetingSimpleUnitViewMasks.subarray(0, _combatTargetingSimpleUnitCount),
          _combatTargetingSimpleUnitExtraFlags.subarray(0, _combatTargetingSimpleUnitCount),
          _combatTargetingSimpleUnitSensorSlots.subarray(0, _combatTargetingSimpleUnitCount),
        )
      );
    }
    appendCombatTargetingSensorSourceSlots(
      _combatTargetingSimpleUnitSensorSlots,
      Math.max(0, simpleSensorCount),
    );
  }
  measureWasmBoundary('combatTargeting.commitStampScratch', () => {
    targeting.commitStampScratch(
      _combatTargetingEntityStampCount,
      _combatTargetingTurretStampCount,
    );
  });

  measureWasmBoundary('combatTargeting.rebuildObservationMasks', () => {
    targeting.rebuildObservationMasksForSources(getCombatTargetingSensorSourceSlots());
  });
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
