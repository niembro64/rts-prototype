// Combat utility functions

import type { Entity, ProjectileShot, Turret } from '../types';
import { isProjectileShot, NO_ENTITY_ID } from '../types';
import { getTransformCosSin } from '../../math';
import { getTurretWorldMount } from '../../math';
import type { MountBodyOrientation } from '../../math/MountGeometry';
import type { Vec3 } from '@/types/vec2';
import { getUnitGroundZ } from '../unitGeometry';
import { getBuildingCombatCenterZ } from '../buildingAnchors';
import {
  ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION,
  entitySlotRegistry,
} from '../EntitySlotRegistry';
import { getRuntimeTurretMount } from '../turretMounts';
import { getUnitBlueprint } from '../blueprints';
import { deterministicMath as DMath } from '../deterministicMath';
import {
  getBotArmConfig,
  resolveBotWeaponArmSocketPose,
  selectBotTorsoTurretIndex,
  shortestBotSocketAngleDelta,
  type BotArmSocketPose,
} from '../../math/BotHostSocketGeometry';
import {
  buildingHostPieceAttachmentsMatch,
  isBuildingAimPieceAttachment,
  isBuildingHostPieceAttachment,
  selectBuildingHostPieceTurretIndex,
} from '../../math/BuildingHostSocketGeometry';
import { GRAVITY } from '../../../config';
import { getSimWasm } from '../../sim-wasm/init';
import { beamIndex } from '../BeamIndex';
import { readTurretCooldownForFire } from './combatActivitySlab';
import {
  readCombatTargetingTurretMountKinematicsFromContextInto,
  readCombatTargetingTurretMountKinematicsInto,
  readCombatTargetingTurretAimInto,
  readCombatTargetingTurretFsmInto,
  writeCombatTargetingTurretHostPiecePoseInto,
  writeCombatTargetingTurretMountKinematicsInto,
  type CombatTargetingEntityReadContext,
  type CombatTargetingTurretAimOut,
} from './targetingInputStamping';
import {
  CT_TURRET_STATE_ENGAGED,
  CT_TURRET_STATE_TRACKING,
} from '../../sim-wasm/init';

/** True iff the entity carries the optional `commander` block — i.e.
 *  it's the player's commander unit. Centralized so a future tweak to
 *  the predicate (e.g. `commander && !isDying`) can't get applied to
 *  some sites and missed at others. */
export function isCommander(entity: { commander: unknown | null }): boolean {
  return entity.commander !== null;
}

/** Bit-mask of which turrets are engaged/firing. Indices >= this can't
 *  fit in a 32-bit mask, so the helpers below treat them as always
 *  included (the rare unit with 31+ turrets falls back to "permissive"
 *  semantics rather than silently dropping out of the mask). */
const TURRET_MASK_MAX_INDEX = 30;

export function turretMaskIncludes(mask: number | undefined, index: number): boolean {
  if (mask === undefined) return true;
  if (mask < 0) return true;
  if (mask === 0) return false;
  if (index > TURRET_MASK_MAX_INDEX) return true;
  return (mask & (1 << index)) !== 0;
}

// Get target radius for range calculations.
// Buildings precompute targetRadius at construction (dimensions never
// change), so this is a property read, not a per-call sqrt.
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.radius.hitbox;
  } else if (target.building) {
    return target.building.targetRadius;
  }
  return 0;
}

export function getProjectileLaunchSpeed(shot: Pick<ProjectileShot, 'launchForce' | 'mass'>): number {
  if (shot.mass <= 1e-6) return 0;
  return shot.launchForce / shot.mass;
}

const FIRE_YAW_TOLERANCE = 0.16;
const FIRE_PITCH_TOLERANCE = 0.16;
const FIRE_BALLISTIC_PITCH_TOLERANCE = 0.025;

export function isBallisticArcWeapon(weapon: Turret): boolean {
  const angleType = weapon.config.aimStyle.angleType;
  return (
    angleType === 'ballisticArcLow' ||
    angleType === 'ballisticArcLowOnlyUnder' ||
    angleType === 'ballisticArcHigh'
  );
}

export function isWeaponAimedForFire(weapon: Turret): boolean {
  if (weapon.config.verticalLauncher) return true;
  const pitchTolerance = isBallisticArcWeapon(weapon)
    ? FIRE_BALLISTIC_PITCH_TOLERANCE
    : FIRE_PITCH_TOLERANCE;
  // aimErrorYaw/Pitch default to 0, which is trivially within
  // tolerance. This preserves the previous "no aim computed yet means
  // trivially aimed" semantic.
  return (
    Math.abs(weapon.aimErrorYaw) <= FIRE_YAW_TOLERANCE &&
    Math.abs(weapon.aimErrorPitch) <= pitchTolerance
  );
}

export function isShieldSubmunitionTurret(weapon: Turret): boolean {
  return weapon.config.shot?.type === 'shield' && weapon.config.submunitions !== null;
}

export function isLiveHomingTarget(entity: Entity): boolean {
  if (entity.unit !== null) return entity.unit.hp > 0;
  if (entity.building !== null) return entity.building.hp > 0;
  const projectile = entity.projectile;
  return (
    projectile !== null &&
    projectile.hp > 0 &&
    isProjectileShot(projectile.config.shot)
  );
}

const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const _bodyOrientationScratch: MountBodyOrientation = { x: 0, y: 0, z: 0, w: 1 };
const _rwmOut: Vec3 = { x: 0, y: 0, z: 0 };
const _entityPositionScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _entityVelocityScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _mountKinematicsVelScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _sourceTurretMountScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _weaponMountScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _hostAttachmentLocalScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _hostAttachmentWorldScratch: Vec3 = { x: 0, y: 0, z: 0 };
const ZERO_EMISSION_SOCKET: Vec3 = { x: 0, y: 0, z: 0 };
const _botArmPoseScratch: BotArmSocketPose = {
  elbowX: 0,
  elbowY: 0,
  elbowZ: 0,
  handX: 0,
  handY: 0,
  handZ: 0,
  aimX: 1,
  aimY: 0,
  aimZ: 0,
};
const _botTorsoFsmScratch = { stateCode: 0, targetId: -1 };
const _botTorsoAimScratch: CombatTargetingTurretAimOut = {
  hasSolution: false,
  yaw: 0,
  pitch: 0,
};
const _botUpperBodyHosts: Entity[] = [];
const _botUpperBodyOwners: Turret[] = [];
const _botUpperBodyOwnerIndexes: number[] = [];
let _botUpperBodyCurrentYaw = new Float64Array(0);
let _botUpperBodyVelocity = new Float64Array(0);
let _botUpperBodyTargetYaw = new Float64Array(0);
let _botUpperBodyMaxSpeed = new Float64Array(0);
let _botUpperBodyMaxAcceleration = new Float64Array(0);
let _botUpperBodyOutYaw = new Float64Array(0);
let _botUpperBodyOutVelocity = new Float64Array(0);
let _botUpperBodyOutAcceleration = new Float64Array(0);
let _botUpperBodyOutError = new Float64Array(0);
let _hostPieceYawContinuous = new Uint8Array(0);
let _hostPieceYawMin = new Float64Array(0);
let _hostPieceYawMax = new Float64Array(0);
let _hostPieceCurrentPitch = new Float64Array(0);
let _hostPiecePitchVelocity = new Float64Array(0);
let _hostPieceTargetPitch = new Float64Array(0);
let _hostPiecePitchMin = new Float64Array(0);
let _hostPiecePitchMax = new Float64Array(0);
let _hostPiecePitchMaxSpeed = new Float64Array(0);
let _hostPiecePitchMaxAcceleration = new Float64Array(0);
let _hostPieceOutPitch = new Float64Array(0);
let _hostPieceOutPitchVelocity = new Float64Array(0);
let _hostPieceOutPitchAcceleration = new Float64Array(0);
let _hostPieceOutPitchError = new Float64Array(0);

const SHARED_AIM_PIECE_MIN_CLAIM_TIMEOUT_MS = 3000;

export type TurretArticulationParentYaw = { yaw: number; velocity: number };

function sharedAimStationStateCode(
  host: Entity,
  turretIndex: number,
  turret: Turret,
): number {
  if (readCombatTargetingTurretFsmInto(host, turretIndex, _botTorsoFsmScratch)) {
    return _botTorsoFsmScratch.stateCode;
  }
  return turret.state === 'engaged'
    ? CT_TURRET_STATE_ENGAGED
    : turret.state === 'tracking'
      ? CT_TURRET_STATE_TRACKING
      : 0;
}

function sharedAimStationIsReady(
  host: Entity,
  turretIndex: number,
  turret: Turret,
): boolean {
  if (beamIndex.hasActiveBeam(host.id, turretIndex)) return true;
  return sharedAimStationStateCode(host, turretIndex, turret) === CT_TURRET_STATE_ENGAGED &&
    readTurretCooldownForFire(host, turretIndex) <= 0;
}

function findSharedAimClaimantIndex(
  host: Entity,
  owner: Turret,
  ownerAttachment: NonNullable<Turret['config']['hostAttachment']> & {
    kind: 'buildingAimPiece';
  },
  excludedMountIndex: number,
): number {
  const turrets = host.combat?.turrets ?? [];
  let hasActiveBeamCandidate = false;
  let highestPriority = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < turrets.length; index++) {
    const candidate = turrets[index];
    if (
      candidate.mountIndex === excludedMountIndex ||
      !buildingHostPieceAttachmentsMatch(ownerAttachment, candidate.config.hostAttachment) ||
      !sharedAimStationIsReady(host, index, candidate)
    ) continue;
    const activeBeam = beamIndex.hasActiveBeam(host.id, index);
    if (activeBeam && !hasActiveBeamCandidate) {
      hasActiveBeamCandidate = true;
      highestPriority = Number.NEGATIVE_INFINITY;
    }
    if (activeBeam !== hasActiveBeamCandidate) continue;
    highestPriority = Math.max(highestPriority, candidate.config.articulation.claimPriority);
  }
  if (highestPriority === Number.NEGATIVE_INFINITY) return -1;

  let afterLastIndex = -1;
  let afterLastMount = Number.MAX_SAFE_INTEGER;
  let wrappedIndex = -1;
  let wrappedMount = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < turrets.length; index++) {
    const candidate = turrets[index];
    if (
      candidate.mountIndex === excludedMountIndex ||
      candidate.config.articulation.claimPriority !== highestPriority ||
      !buildingHostPieceAttachmentsMatch(ownerAttachment, candidate.config.hostAttachment) ||
      beamIndex.hasActiveBeam(host.id, index) !== hasActiveBeamCandidate ||
      !sharedAimStationIsReady(host, index, candidate)
    ) continue;
    if (candidate.mountIndex > owner.hostPieceLastClaimMountIndex) {
      if (candidate.mountIndex < afterLastMount) {
        afterLastIndex = index;
        afterLastMount = candidate.mountIndex;
      }
    } else if (candidate.mountIndex < wrappedMount) {
      wrappedIndex = index;
      wrappedMount = candidate.mountIndex;
    }
  }
  return afterLastIndex >= 0 ? afterLastIndex : wrappedIndex;
}

function selectSharedAimPieceClaimant(
  host: Entity,
  owner: Turret,
  ownerAttachment: NonNullable<Turret['config']['hostAttachment']> & {
    kind: 'buildingAimPiece';
  },
  dtMs: number,
): number {
  const turrets = host.combat?.turrets ?? [];
  let currentIndex = -1;
  for (let index = 0; index < turrets.length; index++) {
    if (
      turrets[index].mountIndex === owner.hostPieceClaimMountIndex &&
      buildingHostPieceAttachmentsMatch(ownerAttachment, turrets[index].config.hostAttachment)
    ) {
      currentIndex = index;
      break;
    }
  }

  if (currentIndex >= 0) {
    const claimant = turrets[currentIndex];
    const activeBeam = beamIndex.hasActiveBeam(host.id, currentIndex);
    if (activeBeam) owner.hostPieceClaimSawActiveBeam = true;
    owner.hostPieceClaimAgeMs += dtMs;
    const completedPulse = owner.hostPieceClaimSawActiveBeam && !activeBeam;
    const noLongerReady = !activeBeam && !sharedAimStationIsReady(host, currentIndex, claimant);
    const timedOut = !owner.hostPieceClaimSawActiveBeam &&
      owner.hostPieceClaimAgeMs >= Math.max(
        SHARED_AIM_PIECE_MIN_CLAIM_TIMEOUT_MS,
        claimant.config.articulation.restoreDelayMs * 2,
      ) &&
      findSharedAimClaimantIndex(
        host,
        owner,
        ownerAttachment,
        claimant.mountIndex,
      ) >= 0;
    if (!completedPulse && !noLongerReady && !timedOut) return currentIndex;
    owner.hostPieceLastClaimMountIndex = claimant.mountIndex;
    owner.hostPieceClaimMountIndex = -1;
    owner.hostPieceClaimAgeMs = 0;
    owner.hostPieceClaimSawActiveBeam = false;
  }

  const nextIndex = findSharedAimClaimantIndex(host, owner, ownerAttachment, -1);
  if (nextIndex < 0) return -1;
  owner.hostPieceClaimMountIndex = turrets[nextIndex].mountIndex;
  owner.hostPieceClaimAgeMs = 0;
  owner.hostPieceClaimSawActiveBeam = beamIndex.hasActiveBeam(host.id, nextIndex);
  return nextIndex;
}

/** Attack emission gate for a shared two-axis building head. Only the station
 * currently granted the parent claim may begin or continue a pulse. */
export function turretOwnsSharedAimPieceClaim(
  host: Entity,
  turretIndex: number,
): boolean {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return false;
  const turret = turrets[turretIndex];
  if (turret === undefined) return false;
  const attachment = turret.config.hostAttachment;
  if (!isBuildingAimPieceAttachment(attachment)) return true;
  const ownerIndex = selectBuildingHostPieceTurretIndex(turrets, attachment.piece);
  const owner = ownerIndex >= 0 ? turrets[ownerIndex] : undefined;
  return owner?.hostPieceClaimMountIndex === turret.mountIndex;
}

function selectAttachedHostPieceOwnerIndex(
  turrets: readonly Turret[],
  turret: Turret,
): number {
  const attachment = turret.config.hostAttachment;
  return isBuildingHostPieceAttachment(attachment)
    ? selectBuildingHostPieceTurretIndex(turrets, attachment.piece)
    : selectBotTorsoTurretIndex(turrets);
}

/** Resolve the moving parent frame for a station's local yaw joint. Rigid
 * mounts inherit chassis yaw; attached stations inherit their authoritative
 * bot or building host piece. Callers provide scratch storage so the
 * per-turret path allocates nothing. */
export function writeTurretArticulationParentYaw(
  host: Entity,
  turret: Turret,
  out: TurretArticulationParentYaw,
): TurretArticulationParentYaw {
  const combat = host.combat;
  if (turret.config.hostAttachment !== null && combat !== null) {
    const ownerIndex = selectAttachedHostPieceOwnerIndex(combat.turrets, turret);
    const owner = ownerIndex >= 0 ? combat.turrets[ownerIndex] : undefined;
    if (owner !== undefined && Number.isFinite(owner.hostPieceYaw)) {
      out.yaw = owner.hostPieceYaw;
      out.velocity = owner.hostPieceYawVelocity;
      return out;
    }
  }
  out.yaw = host.transform.rotation;
  out.velocity = host.unit?.angularVelocity3?.z ?? 0;
  return out;
}

type SurfaceNormal = { nx: number; ny: number; nz: number };

/** Full authoritative body orientation for a live entity, read from the
 *  canonical entity_state slab (written by the Rust unit-force attitude
 *  step). Returns null for hosts without one (buildings, yaw+tilt units,
 *  paths where the slab is unavailable) — callers then keep the legacy
 *  yaw + surface-tilt mount math. The returned object is a shared
 *  scratch; consume it before the next call. */
export function getEntityBodyOrientation(entity: Entity): MountBodyOrientation | null {
  const views = entitySlotRegistry.getViews();
  if (views === null) return null;
  const slot = entity.entitySlotId;
  if (slot < 0 || slot >= views.capacity) return null;
  if (views.entityId[slot] !== entity.id) return null;
  if ((views.unitMotionFlags[slot] & ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION) === 0) return null;
  _bodyOrientationScratch.x = views.orientationX[slot];
  _bodyOrientationScratch.y = views.orientationY[slot];
  _bodyOrientationScratch.z = views.orientationZ[slot];
  _bodyOrientationScratch.w = views.orientationW[slot];
  return _bodyOrientationScratch;
}

type WeaponKinematicsOptions = {
  currentTick: number | undefined;
  dtMs: number | undefined;
  unitGroundZ: number | undefined;
  surfaceN: SurfaceNormal | undefined;
  targetingContext?: CombatTargetingEntityReadContext | null;
};

type WeaponWorldMountOptions = {
  currentTick: number | undefined;
  unitGroundZ: number | undefined;
  surfaceN: SurfaceNormal | undefined;
  targetingContext?: CombatTargetingEntityReadContext | null;
};

function resolveAuthoritativeHostAttachmentLocal(
  host: Entity,
  turret: Turret,
  out: Vec3,
): Vec3 | null {
  const attachment = turret.config.hostAttachment;
  const combat = host.combat;
  if (attachment === null || combat === null) return null;

  if (isBuildingHostPieceAttachment(attachment)) {
    if (host.building === null) return null;
    const ownerIndex = selectBuildingHostPieceTurretIndex(
      combat.turrets,
      attachment.piece,
    );
    const owner = ownerIndex >= 0 ? combat.turrets[ownerIndex] : undefined;
    const pieceWorldYaw = owner !== undefined && Number.isFinite(owner.hostPieceYaw)
      ? owner.hostPieceYaw
      : host.transform.rotation;
    const pieceFromHost = shortestBotSocketAngleDelta(
      host.transform.rotation,
      pieceWorldYaw,
    );
    const pieceCos = DMath.cos(pieceFromHost);
    const pieceSin = DMath.sin(pieceFromHost);
    const piecePitch = isBuildingAimPieceAttachment(attachment) && owner !== undefined
      ? owner.pitch
      : 0;
    const pitchCos = DMath.cos(piecePitch);
    const pitchSin = DMath.sin(piecePitch);
    const mount = getRuntimeTurretMount(turret);
    const socket = attachment.socketOffset;
    const pitchedForwardX = pitchCos * socket.x - pitchSin * socket.z;
    const pitchedUpZ = pitchSin * socket.x + pitchCos * socket.z;
    out.x = mount.x + pieceCos * pitchedForwardX - pieceSin * socket.y;
    out.y = mount.y + pieceSin * pitchedForwardX + pieceCos * socket.y;
    out.z = mount.z + pitchedUpZ;
    return out;
  }

  const sourceUnit = host.unit;
  if (sourceUnit === null) return null;
  const blueprint = getUnitBlueprint(sourceUnit.unitBlueprintId);
  if (blueprint.unitLocomotion.type !== 'bot') return null;

  const torsoTurretIndex = selectBotTorsoTurretIndex(combat.turrets);
  const torsoOwner = torsoTurretIndex >= 0
    ? combat.turrets[torsoTurretIndex]
    : undefined;
  const torsoWorldYaw = torsoOwner !== undefined && Number.isFinite(torsoOwner.hostPieceYaw)
    ? torsoOwner.hostPieceYaw
    : host.transform.rotation;
  const torsoFromHost = shortestBotSocketAngleDelta(
    host.transform.rotation,
    torsoWorldYaw,
  );
  const torsoCos = DMath.cos(torsoFromHost);
  const torsoSin = DMath.sin(torsoFromHost);
  let localX: number;
  let localY: number;
  let localZ: number;

  if (attachment.kind === 'botArm') {
    const radius = sourceUnit.radius.other;
    const arms = getBotArmConfig(blueprint.unitLocomotion.config, attachment.arm);
    if (arms === null) return null;
    const shoulderZ = radius * arms.shoulder.zUnitRadiusRatio;
    resolveBotWeaponArmSocketPose(
      arms,
      radius,
      attachment.arm,
      shoulderZ,
      turret.pitch,
      shortestBotSocketAngleDelta(torsoWorldYaw, turret.rotation),
      DMath,
      _botArmPoseScratch,
    );
    localX = _botArmPoseScratch.handX + attachment.socketOffset.x * radius;
    localY = _botArmPoseScratch.handY + attachment.socketOffset.y * radius;
    localZ = _botArmPoseScratch.handZ + attachment.socketOffset.z * radius;
  } else {
    const mount = getRuntimeTurretMount(turret);
    const radius = sourceUnit.radius.other;
    const socketOffset = attachment.kind === 'botPiece'
      ? attachment.socketOffset
      : ZERO_EMISSION_SOCKET;
    localX = mount.x + socketOffset.x * radius;
    localY = mount.y + socketOffset.y * radius;
    localZ = mount.z + socketOffset.z * radius;
  }

  out.x = torsoCos * localX - torsoSin * localY;
  out.y = torsoSin * localX + torsoCos * localY;
  out.z = localZ;
  return out;
}

function resolveAuthoritativeHostAttachmentWorld(
  host: Entity,
  turret: Turret,
  cos: number,
  sin: number,
  unitGroundZ: number,
  surfaceN: SurfaceNormal,
  orientation: MountBodyOrientation | null,
  out: Vec3,
): Vec3 | null {
  const local = resolveAuthoritativeHostAttachmentLocal(
    host,
    turret,
    _hostAttachmentLocalScratch,
  );
  if (local === null) return null;
  const suspension = host.unit?.suspension ?? null;
  return getTurretWorldMount(
    host.transform.x,
    host.transform.y,
    unitGroundZ,
    cos,
    sin,
    local.x + (suspension?.offsetX ?? 0),
    local.y + (suspension?.offsetY ?? 0),
    local.z + (suspension?.offsetZ ?? 0),
    surfaceN,
    orientation,
    out,
  );
}

export function resolveWeaponWorldMount(
  unit: Entity,
  turret: {
    worldPos: Vec3;
    worldPosTick: number;
    mount: Vec3;
  },
  turretIndex: number,
  cos: number,
  sin: number,
  options: WeaponWorldMountOptions | undefined = undefined,
  out: Vec3 = _rwmOut,
): Vec3 {
  const currentTick = options === undefined ? undefined : options.currentTick;
  const optionUnitGroundZ = options === undefined ? undefined : options.unitGroundZ;
  const optionSurfaceN = options === undefined ? undefined : options.surfaceN;

  // Prefer the Rust combat-targeting slab when the scheduler updated
  // mount kinematics for this entity this tick — the slab is the
  // source of truth and saves a chassis-tilt recompute.
  if (
    currentTick !== undefined &&
    (
      options?.targetingContext !== undefined && options.targetingContext !== null
        ? readCombatTargetingTurretMountKinematicsFromContextInto(
          options.targetingContext,
          turretIndex,
          currentTick,
          out,
          _mountKinematicsVelScratch,
        )
        : readCombatTargetingTurretMountKinematicsInto(
          unit,
          turretIndex,
          currentTick,
          out,
          _mountKinematicsVelScratch,
        )
    )
  ) {
    return out;
  }

  // Client/presentation queries intentionally omit a simulation tick. For an
  // articulated host, derive from its current interpolated turret rows instead
  // of accepting a fixed-tick JS cache as if the hand had not moved.
  if (currentTick === undefined && 'config' in turret) {
    const attachedMount = resolveAuthoritativeHostAttachmentWorld(
      unit,
      turret as Turret,
      cos,
      sin,
      optionUnitGroundZ ?? getUnitGroundZ(unit),
      optionSurfaceN ?? FLAT_SURFACE_NORMAL,
      getEntityBodyOrientation(unit),
      out,
    );
    if (attachedMount !== null) return attachedMount;
  }

  // JS Turret cache: valid only after at least one
  // updateWeaponWorldKinematics pass (worldPosTick >= 0). When a
  // currentTick is supplied we also require it to match — otherwise
  // the cache may be a tick stale.
  if (
    turret.worldPosTick >= 0 &&
    (currentTick === undefined || turret.worldPosTick === currentTick)
  ) {
    out.x = turret.worldPos.x;
    out.y = turret.worldPos.y;
    out.z = turret.worldPos.z;
    return out;
  }

  const unitGroundZ = optionUnitGroundZ ?? getUnitGroundZ(unit);
  if ('config' in turret) {
    const attachedMount = resolveAuthoritativeHostAttachmentWorld(
      unit,
      turret as Turret,
      cos,
      sin,
      unitGroundZ,
      optionSurfaceN ?? FLAT_SURFACE_NORMAL,
      getEntityBodyOrientation(unit),
      out,
    );
    if (attachedMount !== null) return attachedMount;
  }
  const localMount = getRuntimeTurretMount(turret);
  const sourceUnit = unit.unit;
  const suspension = sourceUnit !== null ? sourceUnit.suspension : null;
  const unitPosition = getEntityPosition3d(unit, _entityPositionScratch);
  return getTurretWorldMount(
    unitPosition.x, unitPosition.y, unitGroundZ,
    cos, sin,
    localMount.x + (suspension !== null ? suspension.offsetX : 0),
    localMount.y + (suspension !== null ? suspension.offsetY : 0),
    localMount.z + (suspension !== null ? suspension.offsetZ : 0),
    optionSurfaceN ?? FLAT_SURFACE_NORMAL,
    getEntityBodyOrientation(unit),
    out,
  );
}

/** Authoritative per-turret mount kinematics.
 *
 *  Prefers the Rust combat-targeting slab when it has fresh mount
 *  kinematics for this tick (the scheduler's Pass 0 already wrote
 *  them). Otherwise computes from the chassis pose and caches the
 *  result on the JS Turret so subsequent same-tick reads of
 *  `turret.worldPos` / `worldVelocity` see a current value when the
 *  slab path was unavailable (probe-skipped entities, visual-only
 *  turrets, non-sim client paths).
 */
export function updateWeaponWorldKinematics(
  unit: Entity,
  turret: Turret,
  turretIndex: number,
  cos: number,
  sin: number,
  options: WeaponKinematicsOptions,
  out: Vec3 = _rwmOut,
): Vec3 {
  const worldPos = turret.worldPos;
  const worldVel = turret.worldVelocity;
  const currentTick = options.currentTick;

  // Slab-first: when the scheduler updated this turret's mount for
  // the current tick, that value is the source of truth. Mirror it
  // into the JS Turret cache so callers that read `worldPos` /
  // `worldVelocity` directly (e.g., dgun launch, projectile launch
  // velocity inheritance) see the same numbers.
  if (
    currentTick !== undefined &&
    (
      options.targetingContext !== undefined && options.targetingContext !== null
        ? readCombatTargetingTurretMountKinematicsFromContextInto(
          options.targetingContext,
          turretIndex,
          currentTick,
          out,
          _mountKinematicsVelScratch,
        )
        : readCombatTargetingTurretMountKinematicsInto(
          unit,
          turretIndex,
          currentTick,
          out,
          _mountKinematicsVelScratch,
        )
    )
  ) {
    worldPos.x = out.x;
    worldPos.y = out.y;
    worldPos.z = out.z;
    worldVel.x = _mountKinematicsVelScratch.x;
    worldVel.y = _mountKinematicsVelScratch.y;
    worldVel.z = _mountKinematicsVelScratch.z;
    turret.worldPosTick = currentTick;
    return out;
  }

  if (currentTick !== undefined && turret.worldPosTick === currentTick) {
    out.x = worldPos.x;
    out.y = worldPos.y;
    out.z = worldPos.z;
    return out;
  }

  const unitGroundZ = options.unitGroundZ ?? getUnitGroundZ(unit);
  const sourceUnit = unit.unit;
  const suspension = sourceUnit !== null ? sourceUnit.suspension : null;
  const unitPosition = getEntityPosition3d(unit, _entityPositionScratch);
  const attachedMount = resolveAuthoritativeHostAttachmentWorld(
    unit,
    turret,
    cos,
    sin,
    unitGroundZ,
    options.surfaceN ?? FLAT_SURFACE_NORMAL,
    getEntityBodyOrientation(unit),
    _weaponMountScratch,
  );
  let mount = attachedMount;
  if (mount === null) {
    const localMount = getRuntimeTurretMount(turret);
    mount = getTurretWorldMount(
      unitPosition.x, unitPosition.y, unitGroundZ,
      cos, sin,
      localMount.x + (suspension !== null ? suspension.offsetX : 0),
      localMount.y + (suspension !== null ? suspension.offsetY : 0),
      localMount.z + (suspension !== null ? suspension.offsetZ : 0),
      options.surfaceN ?? FLAT_SURFACE_NORMAL,
      getEntityBodyOrientation(unit),
      _weaponMountScratch,
    );
  }

  const prevTick = turret.worldPosTick;
  const ticksElapsed = currentTick !== undefined && prevTick >= 0
    ? currentTick - prevTick
    : 0;

  if (ticksElapsed === 1 && options.dtMs !== undefined && options.dtMs > 0) {
    const invElapsedSec = 1000 / options.dtMs;
    worldVel.x = (mount.x - worldPos.x) * invElapsedSec;
    worldVel.y = (mount.y - worldPos.y) * invElapsedSec;
    worldVel.z = (mount.z - worldPos.z) * invElapsedSec;
  } else if (unit.unit) {
    const unitVelocity = getEntityVelocity3d(unit, _entityVelocityScratch);
    worldVel.x = unitVelocity.x;
    worldVel.y = unitVelocity.y;
    worldVel.z = unitVelocity.z;
  } else {
    worldVel.x = 0;
    worldVel.y = 0;
    worldVel.z = 0;
  }

  worldPos.x = mount.x;
  worldPos.y = mount.y;
  worldPos.z = mount.z;
  if (currentTick !== undefined) turret.worldPosTick = currentTick;

  out.x = mount.x;
  out.y = mount.y;
  out.z = mount.z;
  return out;
}

/** BAR-style QueryWeapon result for one authoritative emission lane. */
type WeaponEmissionSocketWorldPose = {
  position: Vec3;
  velocity: Vec3;
  forward: Vec3;
};

/** Resolve an emission socket from the current AimFrom pivot and turret aim.
 * Socket offsets live in the turret frame: +X forward, +Y left, +Z up. */
export function resolveWeaponEmissionSocket(
  unit: Entity,
  turret: Turret,
  turretIndex: number,
  laneIndex: number,
  cos: number,
  sin: number,
  options: WeaponKinematicsOptions,
  out: WeaponEmissionSocketWorldPose,
): WeaponEmissionSocketWorldPose {
  const pivot = updateWeaponWorldKinematics(
    unit,
    turret,
    turretIndex,
    cos,
    sin,
    options,
    _hostAttachmentWorldScratch,
  );
  const sockets = turret.emissionSockets;
  const lane = sockets.length > 0
    ? ((laneIndex % sockets.length) + sockets.length) % sockets.length
    : 0;
  const socket = sockets[lane] ?? ZERO_EMISSION_SOCKET;
  const yawCos = DMath.cos(turret.rotation);
  const yawSin = DMath.sin(turret.rotation);
  const pitchCos = DMath.cos(turret.pitch);
  const pitchSin = DMath.sin(turret.pitch);
  const forwardX = yawCos * pitchCos;
  const forwardY = yawSin * pitchCos;
  const forwardZ = pitchSin;
  const leftX = -yawSin;
  const leftY = yawCos;
  const upX = -yawCos * pitchSin;
  const upY = -yawSin * pitchSin;
  const upZ = pitchCos;
  const offsetX = forwardX * socket.x + leftX * socket.y + upX * socket.z;
  const offsetY = forwardY * socket.x + leftY * socket.y + upY * socket.z;
  const offsetZ = forwardZ * socket.x + upZ * socket.z;

  out.position.x = pivot.x + offsetX;
  out.position.y = pivot.y + offsetY;
  out.position.z = pivot.z + offsetZ;
  out.forward.x = forwardX;
  out.forward.y = forwardY;
  out.forward.z = forwardZ;

  // Angular contribution at the socket: omega = yawRate*worldUp +
  // pitchRate*turretLeft, then v_socket = v_pivot + omega × offset.
  const omegaX = leftX * turret.pitchVelocity;
  const omegaY = leftY * turret.pitchVelocity;
  const omegaZ = turret.angularVelocity;
  out.velocity.x = turret.worldVelocity.x + omegaY * offsetZ - omegaZ * offsetY;
  out.velocity.y = turret.worldVelocity.y + omegaZ * offsetX - omegaX * offsetZ;
  out.velocity.z = turret.worldVelocity.z + omegaX * offsetY - omegaY * offsetX;
  return out;
}

function ensureBotUpperBodyCapacity(required: number): void {
  if (_botUpperBodyCurrentYaw.length >= required) return;
  const next = Math.max(16, required, _botUpperBodyCurrentYaw.length * 2);
  _botUpperBodyCurrentYaw = new Float64Array(next);
  _botUpperBodyVelocity = new Float64Array(next);
  _botUpperBodyTargetYaw = new Float64Array(next);
  _botUpperBodyMaxSpeed = new Float64Array(next);
  _botUpperBodyMaxAcceleration = new Float64Array(next);
  _botUpperBodyOutYaw = new Float64Array(next);
  _botUpperBodyOutVelocity = new Float64Array(next);
  _botUpperBodyOutAcceleration = new Float64Array(next);
  _botUpperBodyOutError = new Float64Array(next);
  _hostPieceYawContinuous = new Uint8Array(next);
  _hostPieceYawMin = new Float64Array(next);
  _hostPieceYawMax = new Float64Array(next);
  _hostPieceCurrentPitch = new Float64Array(next);
  _hostPiecePitchVelocity = new Float64Array(next);
  _hostPieceTargetPitch = new Float64Array(next);
  _hostPiecePitchMin = new Float64Array(next);
  _hostPiecePitchMax = new Float64Array(next);
  _hostPiecePitchMaxSpeed = new Float64Array(next);
  _hostPiecePitchMaxAcceleration = new Float64Array(next);
  _hostPieceOutPitch = new Float64Array(next);
  _hostPieceOutPitchVelocity = new Float64Array(next);
  _hostPieceOutPitchAcceleration = new Float64Array(next);
  _hostPieceOutPitchError = new Float64Array(next);
}

/** One shared joint chain per articulated host piece. A stable turret row
 * carries the joint state for snapshots, while the highest-priority active
 * station attached to that exact piece proposes its target for this tick.
 * Bot upper bodies and yaw-only building torsos use only the yaw joint. A
 * building aim piece additionally owns pitch, leaving its weapon children
 * with no residual local traverse. */
function updateSharedHostPieceArticulation(
  hosts: readonly Entity[],
  currentTick: number,
  dtMs: number,
): void {
  _botUpperBodyHosts.length = 0;
  _botUpperBodyOwners.length = 0;
  _botUpperBodyOwnerIndexes.length = 0;
  for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
    const host = hosts[hostIndex];
    const combat = host.combat;
    if (combat === null) continue;
    const sourceUnit = host.unit;
    if (sourceUnit !== null) {
      const blueprint = getUnitBlueprint(sourceUnit.unitBlueprintId);
      if (blueprint.unitLocomotion.type !== 'bot') continue;
      const ownerIndex = selectBotTorsoTurretIndex(combat.turrets);
      if (ownerIndex < 0) continue;
      const owner = combat.turrets[ownerIndex];
      if (!Number.isFinite(owner.hostPieceYaw)) {
        owner.hostPieceYaw = host.transform.rotation;
        owner.hostPieceYawVelocity = 0;
      }
      let claimPriority = Number.NEGATIVE_INFINITY;
      let claimOrder = Number.MAX_SAFE_INTEGER;
      let claimedYaw = host.transform.rotation;
      for (let turretIndex = 0; turretIndex < combat.turrets.length; turretIndex++) {
        const claimant = combat.turrets[turretIndex];
        const station = claimant.config.articulation;
        if (station.claimGroup !== 'botUpperBody') continue;
        const hasFsm = readCombatTargetingTurretFsmInto(
          host,
          turretIndex,
          _botTorsoFsmScratch,
        );
        const active = hasFsm
          ? _botTorsoFsmScratch.stateCode === CT_TURRET_STATE_ENGAGED ||
            _botTorsoFsmScratch.stateCode === CT_TURRET_STATE_TRACKING
          : claimant.state === 'engaged' || claimant.state === 'tracking';
        if (!active || !Number.isFinite(claimant.aimTargetYaw)) continue;
        if (
          station.claimPriority < claimPriority ||
          (station.claimPriority === claimPriority && claimant.mountIndex >= claimOrder)
        ) continue;
        claimPriority = station.claimPriority;
        claimOrder = claimant.mountIndex;
        claimedYaw = readCombatTargetingTurretAimInto(
          host,
          turretIndex,
          _botTorsoAimScratch,
        ) && _botTorsoAimScratch.hasSolution
          ? _botTorsoAimScratch.yaw
          : claimant.aimTargetYaw;
      }
      const workStation = host.builder?.workStation ?? null;
      const workEmitter = blueprint.workEmitter ?? null;
      const workClaim = workEmitter?.articulation ?? null;
      if (
        workStation !== null &&
        workClaim?.claimGroup === 'botUpperBody' &&
        workStation.targetEntityId !== NO_ENTITY_ID &&
        Number.isFinite(workStation.targetWorldYaw) &&
        workClaim.claimPriority > claimPriority
      ) {
        claimPriority = workClaim.claimPriority;
        claimedYaw = workStation.targetWorldYaw;
      }
      if (claimPriority > Number.NEGATIVE_INFINITY) {
        owner.hostPieceIdleMs = 0;
      } else {
        owner.hostPieceIdleMs += dtMs;
        if (owner.hostPieceIdleMs < blueprint.unitLocomotion.config.upperBodyRestoreDelayMs) {
          claimedYaw = owner.hostPieceYaw;
        }
      }
      const index = _botUpperBodyHosts.length;
      ensureBotUpperBodyCapacity(index + 1);
      _botUpperBodyHosts.push(host);
      _botUpperBodyOwners.push(owner);
      _botUpperBodyOwnerIndexes.push(ownerIndex);
      _botUpperBodyCurrentYaw[index] = owner.hostPieceYaw;
      _botUpperBodyVelocity[index] = owner.hostPieceYawVelocity;
      _botUpperBodyTargetYaw[index] = claimedYaw;
      _botUpperBodyMaxSpeed[index] = blueprint.unitLocomotion.config.upperBodyActuator.maxSpeed;
      _botUpperBodyMaxAcceleration[index] =
        blueprint.unitLocomotion.config.upperBodyActuator.maxAcceleration;
      _hostPieceYawContinuous[index] = 1;
      _hostPieceYawMin[index] = -Math.PI;
      _hostPieceYawMax[index] = Math.PI;
      _hostPieceCurrentPitch[index] = 0;
      _hostPiecePitchVelocity[index] = 0;
      _hostPieceTargetPitch[index] = 0;
      _hostPiecePitchMin[index] = 0;
      _hostPiecePitchMax[index] = 0;
      _hostPiecePitchMaxSpeed[index] = 1;
      _hostPiecePitchMaxAcceleration[index] = 1;
      continue;
    }

    if (host.building === null) continue;
    for (let ownerIndex = 0; ownerIndex < combat.turrets.length; ownerIndex++) {
      const owner = combat.turrets[ownerIndex];
      const ownerAttachment = owner.config.hostAttachment;
      if (!isBuildingHostPieceAttachment(ownerAttachment)) continue;
      if (
        selectBuildingHostPieceTurretIndex(combat.turrets, ownerAttachment.piece) !== ownerIndex
      ) continue;
      if (!Number.isFinite(owner.hostPieceYaw)) {
        owner.hostPieceYaw = host.transform.rotation;
        owner.hostPieceYawVelocity = 0;
      }
      let claimPriority = Number.NEGATIVE_INFINITY;
      let claimOrder = Number.MAX_SAFE_INTEGER;
      let claimedYaw = host.transform.rotation;
      let claimedPitch = owner.pitch;
      if (isBuildingAimPieceAttachment(ownerAttachment)) {
        const claimantIndex = selectSharedAimPieceClaimant(
          host,
          owner,
          ownerAttachment,
          dtMs,
        );
        if (claimantIndex >= 0) {
          const claimant = combat.turrets[claimantIndex];
          claimPriority = claimant.config.articulation.claimPriority;
          claimOrder = claimant.mountIndex;
          const hasActiveBeam = beamIndex.hasActiveBeam(host.id, claimantIndex);
          const hasAim = !hasActiveBeam && readCombatTargetingTurretAimInto(
            host,
            claimantIndex,
            _botTorsoAimScratch,
          ) && _botTorsoAimScratch.hasSolution;
          // A committed pulse follows its frozen beam plan through the turret's
          // authoritative aim target. Live targeting may already be asking the
          // sibling station to take the head next.
          claimedYaw = hasAim ? _botTorsoAimScratch.yaw : claimant.aimTargetYaw;
          claimedPitch = hasAim ? _botTorsoAimScratch.pitch : claimant.aimTargetPitch;
        }
      } else {
        for (let turretIndex = 0; turretIndex < combat.turrets.length; turretIndex++) {
          const claimant = combat.turrets[turretIndex];
          if (!buildingHostPieceAttachmentsMatch(
            ownerAttachment,
            claimant.config.hostAttachment,
          )) continue;
          const station = claimant.config.articulation;
          if (station.claimGroup !== owner.config.articulation.claimGroup) continue;
          const hasFsm = readCombatTargetingTurretFsmInto(
            host,
            turretIndex,
            _botTorsoFsmScratch,
          );
          const active = hasFsm
            ? _botTorsoFsmScratch.stateCode === CT_TURRET_STATE_ENGAGED ||
              _botTorsoFsmScratch.stateCode === CT_TURRET_STATE_TRACKING
            : claimant.state === 'engaged' || claimant.state === 'tracking';
          if (!active || !Number.isFinite(claimant.aimTargetYaw)) continue;
          if (
            station.claimPriority < claimPriority ||
            (station.claimPriority === claimPriority && claimant.mountIndex >= claimOrder)
          ) continue;
          claimPriority = station.claimPriority;
          claimOrder = claimant.mountIndex;
          const hasAim = readCombatTargetingTurretAimInto(
            host,
            turretIndex,
            _botTorsoAimScratch,
          ) && _botTorsoAimScratch.hasSolution;
          claimedYaw = hasAim ? _botTorsoAimScratch.yaw : claimant.aimTargetYaw;
          claimedPitch = hasAim ? _botTorsoAimScratch.pitch : claimant.aimTargetPitch;
        }
      }
      if (claimPriority > Number.NEGATIVE_INFINITY) {
        owner.hostPieceIdleMs = 0;
      } else {
        owner.hostPieceIdleMs += dtMs;
        // A structure's rotating piece keeps the bearing its last engagement
        // left it on. It has no chassis forward to return to, so there is no
        // rest angle and no restore delay to wait out — see
        // budget_design_philosophy.html, "A building turret has no rest angle".
        claimedYaw = owner.hostPieceYaw;
        claimedPitch = owner.pitch;
      }
      const index = _botUpperBodyHosts.length;
      ensureBotUpperBodyCapacity(index + 1);
      _botUpperBodyHosts.push(host);
      _botUpperBodyOwners.push(owner);
      _botUpperBodyOwnerIndexes.push(ownerIndex);
      _botUpperBodyCurrentYaw[index] = owner.hostPieceYaw;
      _botUpperBodyVelocity[index] = owner.hostPieceYawVelocity;
      _botUpperBodyTargetYaw[index] = claimedYaw;
      _botUpperBodyMaxSpeed[index] = owner.config.angular.yaw.maxSpeed;
      _botUpperBodyMaxAcceleration[index] = owner.config.angular.yaw.maxAcceleration;
      _hostPieceYawContinuous[index] = 1;
      _hostPieceYawMin[index] = -Math.PI;
      _hostPieceYawMax[index] = Math.PI;
      if (isBuildingAimPieceAttachment(ownerAttachment)) {
        _hostPieceCurrentPitch[index] = owner.pitch;
        _hostPiecePitchVelocity[index] = owner.pitchVelocity;
        _hostPieceTargetPitch[index] = claimedPitch;
        _hostPiecePitchMin[index] = owner.config.articulation.pitch.minAngle;
        _hostPiecePitchMax[index] = owner.config.articulation.pitch.maxAngle;
        _hostPiecePitchMaxSpeed[index] = owner.config.angular.pitch.maxSpeed;
        _hostPiecePitchMaxAcceleration[index] = owner.config.angular.pitch.maxAcceleration;
      } else {
        _hostPieceCurrentPitch[index] = 0;
        _hostPiecePitchVelocity[index] = 0;
        _hostPieceTargetPitch[index] = 0;
        _hostPiecePitchMin[index] = 0;
        _hostPiecePitchMax[index] = 0;
        _hostPiecePitchMaxSpeed[index] = 1;
        _hostPiecePitchMaxAcceleration[index] = 1;
      }
    }
  }

  const count = _botUpperBodyHosts.length;
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('updateSharedHostPieceArticulation: sim-wasm is not initialized');
  }
  const updated = sim.articulationJointStepBatch(
    _botUpperBodyCurrentYaw,
    _botUpperBodyVelocity,
    _botUpperBodyTargetYaw,
    _hostPieceYawContinuous,
    _hostPieceYawMin,
    _hostPieceYawMax,
    _botUpperBodyMaxSpeed,
    _botUpperBodyMaxAcceleration,
    _hostPieceCurrentPitch,
    _hostPiecePitchVelocity,
    _hostPieceTargetPitch,
    _hostPiecePitchMin,
    _hostPiecePitchMax,
    _hostPiecePitchMaxSpeed,
    _hostPiecePitchMaxAcceleration,
    _botUpperBodyOutYaw,
    _botUpperBodyOutVelocity,
    _botUpperBodyOutAcceleration,
    _hostPieceOutPitch,
    _hostPieceOutPitchVelocity,
    _hostPieceOutPitchAcceleration,
    _botUpperBodyOutError,
    _hostPieceOutPitchError,
    count,
    dtMs / 1000,
  );
  if (updated !== count) {
    throw new Error(
      `updateSharedHostPieceArticulation: articulation_joint_step_batch updated ${updated} of ${count} rows`,
    );
  }
  for (let i = 0; i < count; i++) {
    const host = _botUpperBodyHosts[i];
    const owner = _botUpperBodyOwners[i];
    owner.hostPieceYaw = _botUpperBodyOutYaw[i];
    owner.hostPieceYawVelocity = _botUpperBodyOutVelocity[i];
    const attachment = owner.config.hostAttachment;
    if (isBuildingAimPieceAttachment(attachment)) {
      owner.angularAcceleration = _botUpperBodyOutAcceleration[i];
      owner.pitch = _hostPieceOutPitch[i];
      owner.pitchVelocity = _hostPieceOutPitchVelocity[i];
      owner.pitchAcceleration = _hostPieceOutPitchAcceleration[i];
      const turrets = host.combat?.turrets ?? [];
      for (const child of turrets) {
        if (!buildingHostPieceAttachmentsMatch(attachment, child.config.hostAttachment)) continue;
        child.localYaw = 0;
        child.localYawVelocity = 0;
        child.localPitch = 0;
        child.localPitchVelocity = 0;
        child.rotation = owner.hostPieceYaw;
        child.angularVelocity = owner.hostPieceYawVelocity;
        child.pitch = owner.pitch;
        child.pitchVelocity = owner.pitchVelocity;
      }
    }
    writeCombatTargetingTurretHostPiecePoseInto(
      host,
      _botUpperBodyOwnerIndexes[i],
      currentTick,
      owner.hostPieceYaw,
      owner.hostPieceYawVelocity,
    );
  }
}

/**
 * Resolve moving host pieces in three ordered phases. `tickStart` publishes
 * AimFrom pivots for targeting, `hostAim` steps the shared parent, and
 * `postAim` folds final child rotation into socket velocity and overwrites the
 * targeting slab before firing.
 */
export function updateAuthoritativeHostAttachmentKinematics(
  hosts: readonly Entity[],
  currentTick: number,
  dtMs: number,
  phase: 'tickStart' | 'hostAim' | 'postAim',
): void {
  const invDtSec = dtMs > 0 ? 1000 / dtMs : 0;
  if (phase === 'hostAim') {
    updateSharedHostPieceArticulation(hosts, currentTick, dtMs);
    return;
  }
  for (const host of hosts) {
    const combat = host.combat;
    if (combat === null) continue;
    const sourceUnit = host.unit;
    if (sourceUnit !== null) {
      const blueprint = getUnitBlueprint(sourceUnit.unitBlueprintId);
      if (blueprint.unitLocomotion.type !== 'bot') continue;
    } else if (host.building === null) {
      continue;
    }
    const { cos, sin } = getTransformCosSin(host.transform);
    const unitGroundZ = getUnitGroundZ(host);
    const surfaceN = sourceUnit?.surfaceNormal ?? FLAT_SURFACE_NORMAL;
    const orientation = getEntityBodyOrientation(host);
    for (let turretIndex = 0; turretIndex < combat.turrets.length; turretIndex++) {
      const turret = combat.turrets[turretIndex];
      if (turret.config.hostAttachment === null) continue;
      const ownerIndex = selectAttachedHostPieceOwnerIndex(combat.turrets, turret);
      const owner = ownerIndex >= 0 ? combat.turrets[ownerIndex] : undefined;
      if (owner !== undefined && !Number.isFinite(owner.hostPieceYaw)) {
        owner.hostPieceYaw = host.transform.rotation;
        owner.hostPieceYawVelocity = 0;
      }
      const resolved = resolveAuthoritativeHostAttachmentWorld(
        host,
        turret,
        cos,
        sin,
        unitGroundZ,
        surfaceN,
        orientation,
        _hostAttachmentWorldScratch,
      );
      if (resolved === null) continue;

      const oldX = turret.worldPos.x;
      const oldY = turret.worldPos.y;
      const oldZ = turret.worldPos.z;
      if (phase === 'postAim' && turret.worldPosTick === currentTick) {
        if (invDtSec > 0) {
          turret.worldVelocity.x += (resolved.x - oldX) * invDtSec;
          turret.worldVelocity.y += (resolved.y - oldY) * invDtSec;
          turret.worldVelocity.z += (resolved.z - oldZ) * invDtSec;
        }
      } else if (
        turret.worldPosTick === currentTick - 1 &&
        invDtSec > 0
      ) {
        turret.worldVelocity.x = (resolved.x - oldX) * invDtSec;
        turret.worldVelocity.y = (resolved.y - oldY) * invDtSec;
        turret.worldVelocity.z = (resolved.z - oldZ) * invDtSec;
      } else {
        const velocity = getEntityVelocity3d(host, _entityVelocityScratch);
        turret.worldVelocity.x = velocity.x;
        turret.worldVelocity.y = velocity.y;
        turret.worldVelocity.z = velocity.z;
      }
      turret.worldPos.x = resolved.x;
      turret.worldPos.y = resolved.y;
      turret.worldPos.z = resolved.z;
      turret.worldPosTick = currentTick;

      if (phase === 'postAim') {
        writeCombatTargetingTurretMountKinematicsInto(
          host,
          turretIndex,
          currentTick,
          turret.worldPos,
          turret.worldVelocity,
        );
      }
    }
  }
}

export function getEntityPosition3d(entity: Entity, out: Vec3): Vec3 {
  out.x = entity.transform.x;
  out.y = entity.transform.y;
  out.z = entity.transform.z;
  return out;
}

export function getEntityVelocity3d(entity: Entity, out: Vec3): Vec3 {
  if (entity.unit) {
    out.x = entity.unit.velocityX ?? 0;
    out.y = entity.unit.velocityY ?? 0;
    out.z = entity.unit.velocityZ ?? 0;
  } else if (entity.projectile) {
    out.x = entity.projectile.velocityX;
    out.y = entity.projectile.velocityY;
    out.z = entity.projectile.velocityZ;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

export function getEntityAcceleration3d(
  entity: Entity,
  out: Vec3,
): Vec3 {
  if (entity.unit) {
    // Units report zero acceleration to the constant-acceleration
    // ballistic / intercept solver — i.e. lead is velocity-only.
    //
    // We do not track the unit's authoritative body acceleration
    // (true derivative of velocity). The `movementAccel` field that
    // used to live here is only the per-tick thrust intent and
    // excludes the rest of the force budget the body actually feels
    // — terrain spring, ground / air damping, recoil, collision
    // response, blast impulses, drag — so feeding it into a
    // `p + v·t + ½·a·t²` predictor produced "exact" intercepts
    // against an acceleration vector that wasn't the derivative of
    // the authoritative velocity. The client never received
    // movementAccel on the wire either, so server-side lead with
    // intent acceleration also disagreed with client-side lead with
    // zero acceleration, drifting predicted intercepts between the
    // two simulations.
    //
    // Returning zero here makes both sides agree: the solver leads a
    // straight extrapolation of the last-seen velocity. When we one
    // day track real body acceleration (finite-diff of velocity, or
    // a published acceleration channel) this is the single place to
    // wire it in.
    out.x = 0;
    out.y = 0;
    out.z = 0;
  } else if (entity.projectile) {
    const projShot = entity.projectile.config.shot;
    const gravMul =
      isProjectileShot(projShot)
        ? projShot.shotLocomotion.gravityForceMultiplier
        : 'gravityForceMultiplier' in projShot
          ? projShot.gravityForceMultiplier
        : 1;
    out.x = 0;
    out.y = 0;
    out.z = -GRAVITY * gravMul;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

export function updateProjectileSourceClearance(
  source: Entity | undefined,
  projectile: { hasLeftSource: boolean; shotSource: { sourceTurretEntityId: number | null | undefined } },
  pointX: number,
  pointY: number,
  pointZ: number,
  pointRadius: number,
): boolean {
  if (projectile.hasLeftSource) return true;
  if (source === undefined) {
    projectile.hasLeftSource = true;
    return true;
  }

  const clearancePad = Math.max(0, pointRadius) + 2;
  let clearOfHost = true;

  const sourcePosition = getEntityPosition3d(source, _entityPositionScratch);
  if (source.unit !== null) {
    const dx = pointX - sourcePosition.x;
    const dy = pointY - sourcePosition.y;
    const dz = pointZ - sourcePosition.z;
    const clearance = source.unit.radius.collision + clearancePad;
    clearOfHost = dx * dx + dy * dy + dz * dz > clearance * clearance;
  } else if (source.building !== null) {
    const b = source.building;
    // Clearance is measured against the combat box: a hovering
    // building's box floats at its body, not at transform.z's
    // ground-centered span.
    const centerZ = getBuildingCombatCenterZ(source);
    const minX = source.transform.x - b.width / 2 - clearancePad;
    const maxX = source.transform.x + b.width / 2 + clearancePad;
    const minY = source.transform.y - b.height / 2 - clearancePad;
    const maxY = source.transform.y + b.height / 2 + clearancePad;
    const minZ = centerZ - b.depth / 2 - clearancePad;
    const maxZ = centerZ + b.depth / 2 + clearancePad;
    clearOfHost =
      pointX < minX || pointX > maxX ||
      pointY < minY || pointY > maxY ||
      pointZ < minZ || pointZ > maxZ;
  }

  let clearOfTurret = true;
  const sourceTurretEntityId = projectile.shotSource.sourceTurretEntityId ?? null;
  const combat = source.combat;
  if (sourceTurretEntityId !== null && combat !== null) {
    for (let i = 0; i < combat.turrets.length; i++) {
      const turret = combat.turrets[i];
      if (turret.id !== sourceTurretEntityId) continue;
      const cs = getTransformCosSin(source.transform);
      const mount = resolveWeaponWorldMount(
        source,
        turret,
        i,
        cs.cos,
        cs.sin,
        {
          currentTick: undefined,
          unitGroundZ: undefined,
          surfaceN: source.unit === null ? undefined : source.unit.surfaceNormal,
        },
        _sourceTurretMountScratch,
      );
      const dx = pointX - mount.x;
      const dy = pointY - mount.y;
      const dz = pointZ - mount.z;
      // Turret presentation never expands the authoritative host collider.
      const clearance = clearancePad;
      clearOfTurret = dx * dx + dy * dy + dz * dz > clearance * clearance;
      break;
    }
  }

  if (clearOfHost && clearOfTurret) {
    projectile.hasLeftSource = true;
    return true;
  }
  return false;
}
