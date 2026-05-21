import type { Vec3 } from '@/types/vec2';
import type { TurretAimLockOnType } from '@/types/blueprints';
import type { Entity, ProjectileShot, Turret, TurretConfig } from '../types';
import { getShotMaxLifespan, isProjectileShot } from '../types';
import { clamp, getTransformCosSin } from '../../math';
import { GRAVITY } from '../../../config';
import { getSimWasm, type SimWasm } from '../../sim-wasm/init';
import {
  getEntityAcceleration3d,
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { pickTargetAimTurret } from './mirrorTargetPriority';
import {
  readCombatTargetingTurretMountInto,
  readCombatTargetingTurretMountKinematicsInto,
} from './targetingInputStamping';
import { spatialGrid } from '../SpatialGrid';
import { getUnitGroundZ } from '../unitGeometry';

type GroundHeightLookup = (x: number, y: number) => number;

type ResolveTargetAimPointOptions = {
  lockOnType?: TurretAimLockOnType;
  source?: Entity;
  currentTick?: number;
};

const _mirrorEnemyTurretMount = { x: 0, y: 0, z: 0 };
const _bisectEnemyTurretPoint: Vec3 = { x: 0, y: 0, z: 0 };
const _bisectEnemyBodyPoint: Vec3 = { x: 0, y: 0, z: 0 };
const _targetAimPosition: Vec3 = { x: 0, y: 0, z: 0 };
const BISECT_EPSILON = 1e-6;
const BALLISTIC_ARC_LOW = 0;
const BALLISTIC_ARC_HIGH = 1;

export type DirectTurretAim = {
  aim: Vec3;
  origin: TurretAimOrigin;
  yaw: number;
  pitch: number;
};

export type ProjectileTurretAim = DirectTurretAim & {
  targetVelocity: Vec3;
  targetAcceleration: Vec3;
  originVelocity: Vec3;
  originAcceleration: Vec3;
  hasBallisticSolution: boolean;
  /** Flight time from mount to predicted intercept, seconds. Zero when
   *  `hasBallisticSolution` is false. Consumers (force-field clearance,
   *  trajectory sampling) read this to walk the actual parabolic path
   *  the shell will fly instead of approximating with a straight chord. */
  flightTime: number;
  /** Initial 3D launch velocity from the mount. Zero vector when
   *  `hasBallisticSolution` is false. Paired with `flightTime` to
   *  reconstruct the projectile's parabolic envelope under universal
   *  gravity. */
  launchVelocity: Vec3;
};

export type TurretAimSolution = ProjectileTurretAim;

type TurretAimOrigin = Vec3 & {
  dirX: number;
  dirY: number;
  dirZ: number;
};

export function createDirectTurretAimScratch(): DirectTurretAim {
  return {
    aim: { x: 0, y: 0, z: 0 },
    origin: { x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0 },
    yaw: 0,
    pitch: 0,
  };
}

export function createProjectileTurretAimScratch(): ProjectileTurretAim {
  return {
    ...createDirectTurretAimScratch(),
    targetVelocity: { x: 0, y: 0, z: 0 },
    targetAcceleration: { x: 0, y: 0, z: 0 },
    originVelocity: { x: 0, y: 0, z: 0 },
    originAcceleration: { x: 0, y: 0, z: 0 },
    hasBallisticSolution: true,
    flightTime: 0,
    launchVelocity: { x: 0, y: 0, z: 0 },
  };
}

export function createTurretAimScratch(): TurretAimSolution {
  return createProjectileTurretAimScratch();
}

type BallisticSlabViews = {
  buffer: ArrayBuffer;
  length: number;
  hasSolution: Uint8Array;
  flightTime: Float64Array;
  launchVx: Float64Array;
  launchVy: Float64Array;
  launchVz: Float64Array;
  yaw: Float32Array;
  pitch: Float32Array;
  aimX: Float64Array;
  aimY: Float64Array;
  aimZ: Float64Array;
};

let _ballisticSlabViews: BallisticSlabViews | null = null;

function getBallisticSlabViews(sim: SimWasm): BallisticSlabViews {
  const ct = sim.combatTargeting;
  const length = ct.entityCapacity() * ct.maxTurretsPerEntity();
  const buffer = sim.memory.buffer;
  const cached = _ballisticSlabViews;
  if (
    cached &&
    cached.buffer === buffer &&
    cached.length === length &&
    cached.hasSolution.byteLength > 0
  ) {
    return cached;
  }

  _ballisticSlabViews = {
    buffer,
    length,
    hasSolution: new Uint8Array(buffer, ct.turretBallisticHasSolutionPtr(), length),
    flightTime: new Float64Array(buffer, ct.turretBallisticFlightTimePtr(), length),
    launchVx: new Float64Array(buffer, ct.turretBallisticLaunchVxPtr(), length),
    launchVy: new Float64Array(buffer, ct.turretBallisticLaunchVyPtr(), length),
    launchVz: new Float64Array(buffer, ct.turretBallisticLaunchVzPtr(), length),
    yaw: new Float32Array(buffer, ct.turretBallisticYawPtr(), length),
    pitch: new Float32Array(buffer, ct.turretBallisticPitchPtr(), length),
    aimX: new Float64Array(buffer, ct.turretBallisticAimXPtr(), length),
    aimY: new Float64Array(buffer, ct.turretBallisticAimYPtr(), length),
    aimZ: new Float64Array(buffer, ct.turretBallisticAimZPtr(), length),
  };
  return _ballisticSlabViews;
}

function resolveTargetTurretAimPoint(
  target: Entity,
  source: Entity | undefined,
  currentTick: number | undefined,
  out: Vec3,
): boolean {
  const sourceEntityId = source === undefined ? undefined : source.id;
  const surfaceN = target.unit === undefined ? undefined : target.unit.surfaceNormal;
  const picked = pickTargetAimTurret(target, sourceEntityId);
  if (!picked) return false;
  if (
    currentTick !== undefined &&
    readCombatTargetingTurretMountInto(target, picked.index, currentTick, out)
  ) {
    return true;
  }
  const tCS = getTransformCosSin(target.transform);
  const targetMount = resolveWeaponWorldMount(
    target, picked.turret, picked.index,
    tCS.cos, tCS.sin,
    {
      currentTick,
      unitGroundZ: getUnitGroundZ(target),
      surfaceN,
    },
    _mirrorEnemyTurretMount,
  );
  out.x = targetMount.x;
  out.y = targetMount.y;
  out.z = targetMount.z;
  return true;
}

/**
 * Resolve the point a turret should aim at on a target. Most weapons
 * lock onto the gameplay collider; lockOnToTurret instead resolves the
 * target's most relevant damaging turret mount. Buildings are AABBs, so
 * body lock-on uses the closest point on that box from the launch origin,
 * not always the building center. This is what keeps weapons from visually
 * shooting over a building sitting at a different terrain height.
 */
export function resolveTargetAimPoint(
  target: Entity,
  originX: number,
  originY: number,
  originZ: number,
  out: Vec3,
  options?: ResolveTargetAimPointOptions,
): Vec3 {
  if (
    options?.lockOnType === 'lockOnToTurret' &&
    resolveTargetTurretAimPoint(target, options.source, options.currentTick, out)
  ) {
    return out;
  }

  const targetPos = getEntityPosition3d(target, _targetAimPosition);
  if (target.building) {
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const halfD = target.building.depth / 2;
    const minX = targetPos.x - halfW;
    const maxX = targetPos.x + halfW;
    const minY = targetPos.y - halfH;
    const maxY = targetPos.y + halfH;
    const minZ = targetPos.z - halfD;
    const maxZ = targetPos.z + halfD;

    out.x = clamp(originX, minX, maxX);
    out.y = clamp(originY, minY, maxY);
    out.z = clamp(originZ, minZ, maxZ);

    // If the origin is inside the collider, the closest point is the
    // origin itself. Aim through the center instead of producing a
    // zero-length direction.
    if (out.x === originX && out.y === originY && out.z === originZ) {
      out.x = targetPos.x;
      out.y = targetPos.y;
      out.z = targetPos.z;
    }
    return out;
  }

  // Units and projectiles use their transform as the center of their
  // 3D gameplay collider. For spheres this is the stable aim point.
  return getEntityPosition3d(target, out);
}

function writeTurretAimOrigin(
  out: TurretAimOrigin,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
): TurretAimOrigin {
  const cosPitch = Math.cos(pitch);
  out.x = x;
  out.y = y;
  out.z = z;
  out.dirX = Math.cos(yaw) * cosPitch;
  out.dirY = Math.sin(yaw) * cosPitch;
  out.dirZ = Math.sin(pitch);
  return out;
}

function writeZeroVec3(out: Vec3): Vec3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  return out;
}

function writeDirectAimSolutionFields(out: TurretAimSolution): void {
  out.hasBallisticSolution = true;
  writeZeroVec3(out.targetVelocity);
  writeZeroVec3(out.targetAcceleration);
  writeZeroVec3(out.originVelocity);
  writeZeroVec3(out.originAcceleration);
  out.flightTime = 0;
  writeZeroVec3(out.launchVelocity);
}

const _mountVelocityPosScratch: Vec3 = { x: 0, y: 0, z: 0 };

function writeTurretMountVelocity(
  weapon: Turret,
  source: Entity,
  turretIndex: number,
  currentTick: number | undefined,
  inheritVelocity: boolean,
  out: Vec3,
): Vec3 {
  if (!inheritVelocity) return writeZeroVec3(out);

  // Slab-first: when the scheduler updated mount kinematics for this
  // turret this tick, the slab velocity is the source of truth (and
  // is one tick fresher than the JS Turret cache, which previously
  // got mirrored here by the targeting writeback).
  if (
    currentTick !== undefined &&
    readCombatTargetingTurretMountKinematicsInto(
      source, turretIndex, currentTick, _mountVelocityPosScratch, out,
    )
  ) {
    return out;
  }

  // JS Turret cache: meaningful once updateWeaponWorldKinematics has
  // populated it (`worldPosTick >= 0`). Before that, fall back to the
  // carrier's velocity so the first pre-tick aim solve gets a
  // reasonable lead instead of zeroes.
  if (weapon.worldPosTick >= 0) {
    out.x = weapon.worldVelocity.x;
    out.y = weapon.worldVelocity.y;
    out.z = weapon.worldVelocity.z;
    return out;
  }
  return getEntityVelocity3d(source, out);
}

function writeFallbackDirectionAimPoint(
  mountX: number,
  mountY: number,
  mountZ: number,
  fallbackYaw: number,
  fallbackPitch: number,
  out: Vec3,
): Vec3 {
  const cosYaw = Math.cos(fallbackYaw);
  const sinYaw = Math.sin(fallbackYaw);
  const cosPitch = Math.cos(fallbackPitch);
  out.x = mountX + cosYaw * cosPitch;
  out.y = mountY + sinYaw * cosPitch;
  out.z = mountZ + Math.sin(fallbackPitch);
  return out;
}

function writeDirectTurretAimAtPoint(
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  out: DirectTurretAim,
): DirectTurretAim {
  out.aim.x = aimPoint.x;
  out.aim.y = aimPoint.y;
  out.aim.z = aimPoint.z;

  const yaw = Math.atan2(aimPoint.y - mountY, aimPoint.x - mountX);
  const horizDist = Math.hypot(aimPoint.x - mountX, aimPoint.y - mountY);
  const heightDiff = aimPoint.z - mountZ;
  const pitch = Math.atan2(heightDiff, horizDist);
  out.yaw = yaw;
  out.pitch = pitch;
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, yaw, pitch);
  return out;
}

export function solveTurretAimAtPoint(
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  _currentPitch: number,
  _config: TurretConfig,
  out: TurretAimSolution,
): TurretAimSolution {
  writeDirectTurretAimAtPoint(aimPoint, mountX, mountY, mountZ, out);
  writeDirectAimSolutionFields(out);
  return out;
}

export function solveDirectTurretAim(
  source: Entity,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  _currentPitch: number,
  config: TurretConfig,
  out: DirectTurretAim,
  currentTick?: number,
): DirectTurretAim {
  resolveTargetAimPoint(
    target,
    mountX, mountY, mountZ,
    out.aim,
    {
      lockOnType: config.aimStyle.lockOnType,
      source,
      currentTick,
    },
  );

  const horizDist = Math.hypot(out.aim.x - mountX, out.aim.y - mountY);
  const heightDiff = out.aim.z - mountZ;
  out.yaw = Math.atan2(out.aim.y - mountY, out.aim.x - mountX);
  out.pitch = Math.atan2(heightDiff, horizDist);
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
  return out;
}

function solveRayBisectTurretAndBodyAim(
  source: Entity,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  out: DirectTurretAim,
  currentTick?: number,
): DirectTurretAim {
  const hasTurretPoint = resolveTargetTurretAimPoint(
    target,
    source,
    currentTick,
    _bisectEnemyTurretPoint,
  );
  if (!hasTurretPoint) {
    return solveDirectTurretAim(
      source,
      target,
      mountX, mountY, mountZ,
      currentPitch,
      config,
      out,
      currentTick,
    );
  }

  resolveTargetAimPoint(
    target,
    mountX, mountY, mountZ,
    _bisectEnemyBodyPoint,
    {
      lockOnType: 'lockOnToBody',
      source,
      currentTick,
    },
  );

  const turretDx = _bisectEnemyTurretPoint.x - mountX;
  const turretDy = _bisectEnemyTurretPoint.y - mountY;
  const turretDz = _bisectEnemyTurretPoint.z - mountZ;
  const bodyDx = _bisectEnemyBodyPoint.x - mountX;
  const bodyDy = _bisectEnemyBodyPoint.y - mountY;
  const bodyDz = _bisectEnemyBodyPoint.z - mountZ;
  const turretLen = Math.hypot(turretDx, turretDy, turretDz);
  const bodyLen = Math.hypot(bodyDx, bodyDy, bodyDz);

  if (turretLen <= BISECT_EPSILON) {
    return writeDirectTurretAimAtPoint(
      _bisectEnemyBodyPoint,
      mountX, mountY, mountZ,
      out,
    );
  }
  if (bodyLen <= BISECT_EPSILON) {
    return writeDirectTurretAimAtPoint(
      _bisectEnemyTurretPoint,
      mountX, mountY, mountZ,
      out,
    );
  }

  let dirX = turretDx / turretLen + bodyDx / bodyLen;
  let dirY = turretDy / turretLen + bodyDy / bodyLen;
  let dirZ = turretDz / turretLen + bodyDz / bodyLen;
  let dirLen = Math.hypot(dirX, dirY, dirZ);
  if (dirLen <= BISECT_EPSILON) {
    dirX = turretDx / turretLen;
    dirY = turretDy / turretLen;
    dirZ = turretDz / turretLen;
    dirLen = 1;
  }
  dirX /= dirLen;
  dirY /= dirLen;
  dirZ /= dirLen;

  const aimDistance = Math.max(1, Math.min(turretLen, bodyLen));
  out.aim.x = mountX + dirX * aimDistance;
  out.aim.y = mountY + dirY * aimDistance;
  out.aim.z = mountZ + dirZ * aimDistance;
  out.yaw = Math.atan2(dirY, dirX);
  out.pitch = Math.atan2(dirZ, Math.hypot(dirX, dirY));
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
  return out;
}

function solveRayTurretAim(
  source: Entity,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  out: DirectTurretAim,
  currentTick?: number,
): DirectTurretAim {
  if (config.aimStyle.angleType === 'rayBisectTurretAndBody') {
    return solveRayBisectTurretAndBodyAim(
      source,
      target,
      mountX, mountY, mountZ,
      currentPitch,
      config,
      out,
      currentTick,
    );
  }

  return solveDirectTurretAim(
    source,
    target,
    mountX, mountY, mountZ,
    currentPitch,
    config,
    out,
    currentTick,
  );
}

function getProjectileMaxTimeSec(shot: ProjectileShot): number {
  const lifeMs = getShotMaxLifespan(shot);
  return Number.isFinite(lifeMs) ? lifeMs / 1000 : 0;
}

function getBallisticArcPreference(config: TurretConfig): number {
  return config.aimStyle.angleType === 'ballisticArcHigh'
    ? BALLISTIC_ARC_HIGH
    : BALLISTIC_ARC_LOW;
}

function usesBallisticAim(config: TurretConfig): boolean {
  return (
    config.aimStyle.angleType === 'ballisticArcLow' ||
    config.aimStyle.angleType === 'ballisticArcLowOnlyUnder' ||
    config.aimStyle.angleType === 'ballisticArcHigh'
  );
}

function weaponUsesNormalAim(weapon: Turret): boolean {
  const config = weapon.config;
  if (config.visualOnly) return false;
  if (config.verticalLauncher) return false;
  if (config.isManualFire) return false;
  if (config.shot?.type === 'force') return false;
  return true;
}

function writeNoBallisticSolutionAim(
  weapon: Turret,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  out: ProjectileTurretAim,
): void {
  out.yaw = weapon.rotation;
  out.pitch = currentPitch;
  out.hasBallisticSolution = false;
  out.flightTime = 0;
  writeZeroVec3(out.launchVelocity);
  writeFallbackDirectionAimPoint(
    mountX, mountY, mountZ,
    out.yaw, out.pitch,
    out.aim,
  );
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
}

function copyBallisticSlabSolution(
  sim: SimWasm,
  entitySlot: number,
  turretIndex: number,
  mountX: number,
  mountY: number,
  mountZ: number,
  out: ProjectileTurretAim,
): void {
  const maxTurrets = sim.combatTargeting.maxTurretsPerEntity();
  const idx = entitySlot * maxTurrets + turretIndex;
  const views = getBallisticSlabViews(sim);
  out.hasBallisticSolution = views.hasSolution[idx] !== 0;
  out.flightTime = views.flightTime[idx];
  out.launchVelocity.x = views.launchVx[idx];
  out.launchVelocity.y = views.launchVy[idx];
  out.launchVelocity.z = views.launchVz[idx];
  out.yaw = views.yaw[idx];
  out.pitch = views.pitch[idx];
  out.aim.x = views.aimX[idx];
  out.aim.y = views.aimY[idx];
  out.aim.z = views.aimZ[idx];
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
}

function solveProjectileBallisticAim(
  source: Entity,
  weapon: Turret,
  turretIndex: number,
  shot: ProjectileShot,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  out: ProjectileTurretAim,
): ProjectileTurretAim {
  const sim = getSimWasm();
  const entitySlot = spatialGrid.getSlot(source.id);
  if (sim === undefined || entitySlot < 0 || turretIndex < 0) {
    writeNoBallisticSolutionAim(weapon, mountX, mountY, mountZ, currentPitch, out);
    return out;
  }

  const targeting = sim.combatTargeting;
  if (turretIndex >= targeting.turretCount(entitySlot)) {
    writeNoBallisticSolutionAim(weapon, mountX, mountY, mountZ, currentPitch, out);
    return out;
  }

  targeting.solveBallisticAim(
    entitySlot,
    turretIndex,
    out.aim.x,
    out.aim.y,
    out.aim.z,
    out.targetVelocity.x,
    out.targetVelocity.y,
    out.targetVelocity.z,
    out.targetAcceleration.x,
    out.targetAcceleration.y,
    out.targetAcceleration.z,
    out.originAcceleration.x,
    out.originAcceleration.y,
    out.originAcceleration.z,
    getProjectileLaunchSpeed(shot),
    GRAVITY,
    getBallisticArcPreference(weapon.config),
    getProjectileMaxTimeSec(shot),
    weapon.rotation,
    currentPitch,
  );
  copyBallisticSlabSolution(sim, entitySlot, turretIndex, mountX, mountY, mountZ, out);
  return out;
}

export function solveProjectileTurretAim(
  source: Entity,
  weapon: Turret,
  turretIndex: number,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  inheritOriginVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
  currentTick?: number,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;

  resolveTargetAimPoint(
    target,
    mountX, mountY, mountZ,
    out.aim,
    {
      lockOnType: weapon.config.aimStyle.lockOnType,
      source,
      currentTick,
    },
  );

  const targetVelocity = getEntityVelocity3d(target, out.targetVelocity);
  writeTurretMountVelocity(
    weapon, source, turretIndex, currentTick,
    inheritOriginVelocity, out.originVelocity,
  );
  const targetAcceleration = getEntityAcceleration3d(target, out.targetAcceleration);
  getEntityAcceleration3d(source, out.originAcceleration);

  const groundAimFraction = weapon.config.groundAimFraction;
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = mountX + f * (out.aim.x - mountX);
    out.aim.y = mountY + f * (out.aim.y - mountY);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
    targetVelocity.x *= f;
    targetVelocity.y *= f;
    targetVelocity.z = 0;
    targetAcceleration.x *= f;
    targetAcceleration.y *= f;
    targetAcceleration.z = 0;
  }

  return solveProjectileBallisticAim(
    source,
    weapon,
    turretIndex,
    shot,
    mountX, mountY, mountZ,
    currentPitch,
    out,
  );
}

export function solveProjectileTurretAimAtPoint(
  source: Entity,
  weapon: Turret,
  turretIndex: number,
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  inheritOriginVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
  currentTick?: number,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;
  out.aim.x = aimPoint.x;
  out.aim.y = aimPoint.y;
  out.aim.z = aimPoint.z;

  writeTurretMountVelocity(
    weapon, source, turretIndex, currentTick,
    inheritOriginVelocity, out.originVelocity,
  );
  getEntityAcceleration3d(source, out.originAcceleration);
  writeZeroVec3(out.targetVelocity);
  writeZeroVec3(out.targetAcceleration);

  const groundAimFraction = weapon.config.groundAimFraction;
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = mountX + f * (out.aim.x - mountX);
    out.aim.y = mountY + f * (out.aim.y - mountY);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
  }

  return solveProjectileBallisticAim(
    source,
    weapon,
    turretIndex,
    shot,
    mountX, mountY, mountZ,
    currentPitch,
    out,
  );
}

export function solveTurretAimAtGroundPoint(
  source: Entity,
  weapon: Turret,
  turretIndex: number,
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  groundHeightAt: GroundHeightLookup,
  out: TurretAimSolution,
  currentTick?: number,
): TurretAimSolution {
  if (!weaponUsesNormalAim(weapon)) {
    return solveTurretAimAtPoint(
      writeFallbackDirectionAimPoint(
        mountX, mountY, mountZ,
        weapon.rotation, currentPitch,
        out.aim,
      ),
      mountX, mountY, mountZ,
      currentPitch,
      weapon.config,
      out,
    );
  }

  const shot = weapon.config.shot;
  if (shot && isProjectileShot(shot) && usesBallisticAim(weapon.config)) {
    return solveProjectileTurretAimAtPoint(
      source,
      weapon,
      turretIndex,
      aimPoint,
      mountX, mountY, mountZ,
      currentPitch,
      true,
      groundHeightAt,
      out,
      currentTick,
    );
  }

  solveTurretAimAtPoint(
    aimPoint,
    mountX, mountY, mountZ,
    currentPitch,
    weapon.config,
    out,
  );
  return out;
}

export function solveTurretAim(
  unit: Entity,
  weapon: Turret,
  turretIndex: number,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  currentTick: number | undefined,
  groundHeightAt: GroundHeightLookup,
  out: TurretAimSolution,
): TurretAimSolution | null {
  if (!weaponUsesNormalAim(weapon)) return null;

  if (weapon.config.passive) {
    solveRayTurretAim(
      unit,
      target,
      mountX, mountY, mountZ,
      currentPitch,
      weapon.config,
      out,
      currentTick,
    );
    writeDirectAimSolutionFields(out);
    return out;
  }

  const shot = weapon.config.shot;
  if (shot && isProjectileShot(shot) && usesBallisticAim(weapon.config)) {
    return solveProjectileTurretAim(
      unit,
      weapon,
      turretIndex,
      target,
      mountX, mountY, mountZ,
      currentPitch,
      true,
      groundHeightAt,
      out,
      currentTick,
    );
  }

  solveRayTurretAim(
    unit,
    target,
    mountX, mountY, mountZ,
    currentPitch,
    weapon.config,
    out,
    currentTick,
  );
  writeDirectAimSolutionFields(out);
  return out;
}
