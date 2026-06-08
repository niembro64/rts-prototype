import { GRAVITY, LAND_CELL_SIZE } from '../../config';
import {
  getTransformCosSin,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
} from '../math';
import { getTurretWorldMount } from '../math/MountGeometry';
import type { Entity, ProjectileShot, Turret } from '../sim/types';
import { getShotMaxLifespan, isProjectileShot, isRocketLikeShot } from '../sim/types';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getRuntimeTurretMount } from '../sim/turretMounts';
import { getUnitGroundZ } from '../sim/unitGeometry';
import { getEntityPosition3d, getProjectileLaunchSpeed } from '../sim/combat/combatUtils';

const SEARCH_ITERATIONS = 14;
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };

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
const _intercept: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};
const _entityPosition = { x: 0, y: 0, z: 0 };

export type ProjectileGroundReach = 'reachable' | 'blocked' | null;

export function resolveProjectileSelectionGroundReach(
  entities: readonly Entity[],
  targetX: number,
  targetY: number,
  targetZ: number,
  mapWidth: number,
  mapHeight: number,
): ProjectileGroundReach {
  if (entities.length === 0) return null;
  if (
    !Number.isFinite(mapWidth) ||
    !Number.isFinite(mapHeight) ||
    mapWidth <= 0 ||
    mapHeight <= 0
  ) {
    return null;
  }

  let sawProjectileWeapon = false;
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
    const entity = entities[entityIndex];
    const turrets = entity.combat?.turrets ?? [];
    for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
      const canReach = projectileWeaponCanReachGroundPoint(
        entity,
        turrets[turretIndex],
        targetX,
        targetY,
        targetZ,
        mapWidth,
        mapHeight,
      );
      if (canReach === null) continue;
      sawProjectileWeapon = true;
      if (canReach) return 'reachable';
    }
  }
  return sawProjectileWeapon ? 'blocked' : null;
}

export function resolveProjectileWeaponMount(
  entity: Entity,
  weapon: Turret,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number; z: number } {
  const entityPosition = getEntityPosition3d(entity, _entityPosition);
  const { cos, sin } = getTransformCosSin(entity.transform);
  const surfaceN = entity.unit
    ? entity.unit.surfaceNormal ?? getSurfaceNormal(
        entityPosition.x,
        entityPosition.y,
        mapWidth,
        mapHeight,
        LAND_CELL_SIZE,
      )
    : FLAT_SURFACE_NORMAL;
  const mount = getRuntimeTurretMount(weapon);
  return getTurretWorldMount(
    entityPosition.x,
    entityPosition.y,
    getUnitGroundZ(entity),
    cos,
    sin,
    mount.x,
    mount.y,
    mount.z,
    surfaceN,
  );
}

export function projectileWeaponCanReachGroundPoint(
  entity: Entity,
  weapon: Turret,
  targetX: number,
  targetY: number,
  targetZ: number,
  mapWidth: number,
  mapHeight: number,
): boolean | null {
  if (weapon.config.visualOnly || weapon.config.passive || weapon.config.verticalLauncher) return null;
  const shot = weapon.config.shot;
  if (!shot || !isProjectileShot(shot)) return null;
  const speed = getProjectileLaunchSpeed(shot);
  if (speed <= 1e-6) return null;
  const mount = resolveProjectileWeaponMount(entity, weapon, mapWidth, mapHeight);
  return projectileShotCanReachGroundPoint(
    mount.x,
    mount.y,
    mount.z,
    targetX,
    targetY,
    targetZ,
    shot,
    speed,
  );
}

export function findProjectileShotReachDistance(
  originX: number,
  originY: number,
  launchZ: number,
  dirX: number,
  dirY: number,
  shot: ProjectileShot,
  speed: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const mapLimit = rayDistanceToMapEdge(originX, originY, dirX, dirY, mapWidth, mapHeight);
  if (mapLimit <= 0) return 0;

  if (isRocketLikeShot(shot)) {
    const lifeMs = getShotMaxLifespan(shot);
    if (!Number.isFinite(lifeMs)) return mapLimit;
    return Math.min(mapLimit, speed * lifeMs / 1000);
  }

  if (canReachAtDistance(originX, originY, launchZ, dirX, dirY, mapLimit, shot, speed, mapWidth, mapHeight)) {
    return mapLimit;
  }

  let lo = 0;
  let hi = mapLimit;
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) * 0.5;
    if (canReachAtDistance(originX, originY, launchZ, dirX, dirY, mid, shot, speed, mapWidth, mapHeight)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function projectileShotCanReachGroundPoint(
  originX: number,
  originY: number,
  launchZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  shot: ProjectileShot,
  speed: number,
): boolean {
  if (isRocketLikeShot(shot)) {
    const lifeMs = getShotMaxLifespan(shot);
    if (!Number.isFinite(lifeMs)) return true;
    const dx = targetX - originX;
    const dy = targetY - originY;
    return Math.hypot(dx, dy) <= speed * lifeMs / 1000;
  }

  const lifeMs = getShotMaxLifespan(shot);
  _originState.position.x = originX;
  _originState.position.y = originY;
  _originState.position.z = launchZ;
  _originState.velocity.x = 0;
  _originState.velocity.y = 0;
  _originState.velocity.z = 0;
  _originState.acceleration.x = 0;
  _originState.acceleration.y = 0;
  _originState.acceleration.z = 0;
  _targetState.position.x = targetX;
  _targetState.position.y = targetY;
  _targetState.position.z = targetZ;
  _targetState.velocity.x = 0;
  _targetState.velocity.y = 0;
  _targetState.velocity.z = 0;
  _targetState.acceleration.x = 0;
  _targetState.acceleration.y = 0;
  _targetState.acceleration.z = 0;
  return solveKinematicIntercept({
    myPosition: _originState.position,
    myVelocity: _originState.velocity,
    myAcceleration: _originState.acceleration,
    targetPosition: _targetState.position,
    targetVelocity: _targetState.velocity,
    targetAcceleration: _targetState.acceleration,
    projectileSpeed: speed,
    gravity: GRAVITY * shot.gravityForceMultiplier,
    preferLateSolution: false,
    maxTimeSec: Number.isFinite(lifeMs) ? lifeMs / 1000 : 0,
  }, _intercept) !== null;
}

function canReachAtDistance(
  originX: number,
  originY: number,
  launchZ: number,
  dirX: number,
  dirY: number,
  dist: number,
  shot: ProjectileShot,
  speed: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  if (dist <= 1e-3) return true;
  const x = originX + dirX * dist;
  const y = originY + dirY * dist;
  return projectileShotCanReachGroundPoint(
    originX,
    originY,
    launchZ,
    x,
    y,
    getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE),
    shot,
    speed,
  );
}

function rayDistanceToMapEdge(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  mapWidth: number,
  mapHeight: number,
): number {
  let t = Infinity;
  if (dirX > 1e-6) t = Math.min(t, (mapWidth - x) / dirX);
  else if (dirX < -1e-6) t = Math.min(t, -x / dirX);

  if (dirY > 1e-6) t = Math.min(t, (mapHeight - y) / dirY);
  else if (dirY < -1e-6) t = Math.min(t, -y / dirY);

  return Number.isFinite(t) ? Math.max(0, t) : 0;
}
