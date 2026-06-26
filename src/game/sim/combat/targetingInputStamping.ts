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
import { spatialGrid } from '../SpatialGrid';
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
  getEntityPosition3d,
  getEntityVelocity3d,
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
const _stampVel = { x: 0, y: 0, z: 0 };

function getHostLockOnMasks(entity: Entity): LockOnMasks {
  if (entity.unit !== null) return getUnitHostLockOnMasks(entity.unit.unitBlueprintId);
  if (entity.type === 'tower' && entity.buildingBlueprintId !== null) {
    return getTowerHostLockOnMasks(entity.buildingBlueprintId);
  }
  return EMPTY_LOCK_ON_MASKS;
}

type CombatTargetingStateViews = {
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
  aimHasSolution: Uint8Array;
  aimYaw: Float32Array;
  aimPitch: Float32Array;
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

function resetCombatTargetingSources(): void {
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
  if (count <= _combatTargetingSourceSlots.length) return;
  let next = Math.max(8, _combatTargetingSourceSlots.length);
  while (next < count) next *= 2;
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

export function getCombatTargetingSourceSlots(): Uint32Array {
  return _combatTargetingSourceSlots.subarray(0, _combatTargetingSourceCount);
}

export function getCombatTargetingSourceCount(): number {
  return _combatTargetingSourceCount;
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

function readCombatTargetingTurretFsmFromSimInto(
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
  const idx = getCombatTargetingTurretStateIndex(sim, entity, turretIndex);
  if (idx < 0) return false;
  const views = getCombatTargetingStateViews(sim);
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

function stampCombatTargetingEntityInto(
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
  // A hovering building's combat box is in the air (the fabricator torus), so
  // stamp its combat center z for the targeting/aim solver instead of the
  // ground-level transform.z. Non-hovering buildings are unaffected.
  if (entity.building !== null && entity.building.hovering) {
    pos.z = getBuildingCombatCenterZ(entity);
  }
  const vel = getEntityVelocity3d(entity, _stampVel);
  const groundZ = getUnitGroundZ(entity);
  const rotCos = DMath.cos(entity.transform.rotation);
  const rotSin = DMath.sin(entity.transform.rotation);
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
  if (
    entity.unit !== null &&
    getUnitBlueprint(entity.unit.unitBlueprintId).preventLockOnIfMyTeamIsAboveMe === true
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
  // The slab-owned FSM tuple (state, target, cooldown, burstCooldown,
  // losBlockedTicks) is no longer an input to setTurret. Rust preserves
  // it across same-entity restamps (clear() never resets it; kernels
  // and direct slab writers own its evolution) and seeds fresh-turret
  // constants on slot reuse, keyed off setEntity's same-entity check.
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
  return true;
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
  for (const entity of targets) {
    if (stampCombatTargetingEntityInto(targeting, world, entity)) {
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
