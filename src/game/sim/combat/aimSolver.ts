import type { Vec3 } from '@/types/vec2';
import type { TurretAimLockOnType } from '@/types/blueprints';
import type { Entity, ProjectileShot, Turret, TurretConfig } from '../types';
import { getShotMaxLifespan, isProjectileShot, isRocketLikeShot } from '../types';
import {
  clamp,
  getTransformCosSin,
  type KinematicState3,
  type KinematicVec3,
  solveTurretShotAngles,
  type TurretShotAngleSolution,
  type TurretShotArcPreference,
} from '../../math';
import { GRAVITY } from '../../../config';
import {
  getEntityAcceleration3,
  getEntityVelocity3,
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { pickTargetAimTurret } from './mirrorTargetPriority';
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
const _projectileAcceleration: KinematicVec3 = { x: 0, y: 0, z: 0 };
const _originState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _targetState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _shotAngleSolution: TurretShotAngleSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  direction: { x: 1, y: 0, z: 0 },
};
const BISECT_EPSILON = 1e-6;

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
  };
}

export function createTurretAimScratch(): TurretAimSolution {
  return createProjectileTurretAimScratch();
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

  if (target.building) {
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const halfD = target.building.depth / 2;
    const minX = target.transform.x - halfW;
    const maxX = target.transform.x + halfW;
    const minY = target.transform.y - halfH;
    const maxY = target.transform.y + halfH;
    const minZ = target.transform.z - halfD;
    const maxZ = target.transform.z + halfD;

    out.x = clamp(originX, minX, maxX);
    out.y = clamp(originY, minY, maxY);
    out.z = clamp(originZ, minZ, maxZ);

    // If the origin is inside the collider, the closest point is the
    // origin itself. Aim through the center instead of producing a
    // zero-length direction.
    if (out.x === originX && out.y === originY && out.z === originZ) {
      out.x = target.transform.x;
      out.y = target.transform.y;
      out.z = target.transform.z;
    }
    return out;
  }

  // Units and projectiles use their transform as the center of their
  // 3D gameplay collider. For spheres this is the stable aim point.
  out.x = target.transform.x;
  out.y = target.transform.y;
  out.z = target.transform.z;
  return out;
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
}

function writeTurretMountVelocity(
  weapon: Turret,
  source: Entity,
  inheritVelocity: boolean,
  out: Vec3,
): Vec3 {
  if (!inheritVelocity) return writeZeroVec3(out);

  const mountVelocity = weapon.worldVelocity;
  if (mountVelocity) {
    out.x = mountVelocity.x;
    out.y = mountVelocity.y;
    out.z = mountVelocity.z;
    return out;
  }
  return getEntityVelocity3(source, out);
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

function writeKinematicState(
  state: KinematicState3,
  position: Vec3,
  velocity: Vec3,
  acceleration: Vec3,
): void {
  state.position.x = position.x;
  state.position.y = position.y;
  state.position.z = position.z;
  state.velocity.x = velocity.x;
  state.velocity.y = velocity.y;
  state.velocity.z = velocity.z;
  state.acceleration.x = acceleration.x;
  state.acceleration.y = acceleration.y;
  state.acceleration.z = acceleration.z;
}

function writeKinematicStateAt(
  state: KinematicState3,
  x: number,
  y: number,
  z: number,
  velocity: Vec3,
  acceleration: Vec3,
): void {
  state.position.x = x;
  state.position.y = y;
  state.position.z = z;
  state.velocity.x = velocity.x;
  state.velocity.y = velocity.y;
  state.velocity.z = velocity.z;
  state.acceleration.x = acceleration.x;
  state.acceleration.y = acceleration.y;
  state.acceleration.z = acceleration.z;
}

function getProjectileAcceleration(_shot: ProjectileShot, out: KinematicVec3): KinematicVec3 {
  out.x = 0;
  out.y = 0;
  out.z = -GRAVITY;
  return out;
}

function getProjectileMaxTimeSec(shot: ProjectileShot): number | undefined {
  const lifeMs = getShotMaxLifespan(shot);
  return Number.isFinite(lifeMs) ? lifeMs / 1000 : undefined;
}

function getBallisticArcPreference(config: TurretConfig): TurretShotArcPreference {
  return config.aimStyle.angleType === 'ballisticArcHigh' ? 'high' : 'low';
}

function usesBallisticAim(config: TurretConfig): boolean {
  return (
    config.aimStyle.angleType === 'ballisticArcLow' ||
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

function projectileCanFallbackToRay(shot: ProjectileShot): boolean {
  return isRocketLikeShot(shot);
}

function solveProjectileShotAngles(
  shot: ProjectileShot,
  launchSpeed: number,
  arcPreference: TurretShotArcPreference,
  out: TurretShotAngleSolution,
): TurretShotAngleSolution | null {
  return solveTurretShotAngles({
    origin: _originState,
    target: _targetState,
    projectileSpeed: launchSpeed,
    projectileAcceleration: getProjectileAcceleration(shot, _projectileAcceleration),
    arcPreference,
    maxTimeSec: getProjectileMaxTimeSec(shot),
  }, out);
}

function copyShotAngleSolution(
  solution: TurretShotAngleSolution,
  out: ProjectileTurretAim,
): void {
  out.aim.x = solution.aimPoint.x;
  out.aim.y = solution.aimPoint.y;
  out.aim.z = solution.aimPoint.z;
  out.yaw = solution.yaw;
  out.pitch = solution.pitch;
  out.hasBallisticSolution = true;
}

export function solveProjectileTurretAim(
  source: Entity,
  weapon: Turret,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  _currentPitch: number,
  inheritOriginVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
  currentTick?: number,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;
  const launchSpeed = getProjectileLaunchSpeed(shot);

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

  const targetVelocity = getEntityVelocity3(target, out.targetVelocity);
  const originVelocity = writeTurretMountVelocity(weapon, source, inheritOriginVelocity, out.originVelocity);
  const targetAcceleration = getEntityAcceleration3(target, out.targetAcceleration, groundHeightAt);
  const originAcceleration = getEntityAcceleration3(source, out.originAcceleration, groundHeightAt);

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

  writeKinematicStateAt(_originState, mountX, mountY, mountZ, originVelocity, originAcceleration);
  writeKinematicState(_targetState, out.aim, targetVelocity, targetAcceleration);

  const horizDist = Math.hypot(out.aim.x - mountX, out.aim.y - mountY);
  const heightDiff = out.aim.z - mountZ;
  const fallbackYaw = Math.atan2(out.aim.y - mountY, out.aim.x - mountX);
  const shotAngles = solveProjectileShotAngles(
    shot,
    launchSpeed,
    getBallisticArcPreference(weapon.config),
    _shotAngleSolution,
  );
  if (shotAngles) {
    copyShotAngleSolution(shotAngles, out);
  } else {
    out.yaw = fallbackYaw;
    out.hasBallisticSolution = projectileCanFallbackToRay(shot);
    out.pitch = Math.atan2(heightDiff, horizDist);
  }
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
  return out;
}

export function solveProjectileTurretAimAtPoint(
  source: Entity,
  weapon: Turret,
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  inheritOriginVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;
  const launchSpeed = getProjectileLaunchSpeed(shot);
  out.aim.x = aimPoint.x;
  out.aim.y = aimPoint.y;
  out.aim.z = aimPoint.z;

  const originVelocity = writeTurretMountVelocity(weapon, source, inheritOriginVelocity, out.originVelocity);
  const originAcceleration = getEntityAcceleration3(source, out.originAcceleration, groundHeightAt);
  writeZeroVec3(out.targetVelocity);
  writeZeroVec3(out.targetAcceleration);

  const groundAimFraction = weapon.config.groundAimFraction;
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = mountX + f * (out.aim.x - mountX);
    out.aim.y = mountY + f * (out.aim.y - mountY);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
  }

  const yaw = Math.atan2(out.aim.y - mountY, out.aim.x - mountX);
  const horizDist = Math.hypot(out.aim.x - mountX, out.aim.y - mountY);
  const heightDiff = out.aim.z - mountZ;

  writeKinematicStateAt(_originState, mountX, mountY, mountZ, originVelocity, originAcceleration);
  writeKinematicState(_targetState, out.aim, out.targetVelocity, out.targetAcceleration);

  const shotAngles = solveProjectileShotAngles(
    shot,
    launchSpeed,
    getBallisticArcPreference(weapon.config),
    _shotAngleSolution,
  );
  if (shotAngles) {
    copyShotAngleSolution(shotAngles, out);
  } else {
    out.yaw = yaw;
    out.hasBallisticSolution = projectileCanFallbackToRay(shot);
    out.pitch = Math.atan2(heightDiff, horizDist);
  }
  writeTurretAimOrigin(out.origin, mountX, mountY, mountZ, out.yaw, out.pitch);
  return out;
}

export function solveTurretAimAtGroundPoint(
  source: Entity,
  weapon: Turret,
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  groundHeightAt: GroundHeightLookup,
  out: TurretAimSolution,
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
      aimPoint,
      mountX, mountY, mountZ,
      true,
      groundHeightAt,
      out,
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
