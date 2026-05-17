// Combat utility functions

import type { Entity, ProjectileShot, Turret } from '../types';
import { distance, normalizeAngle, magnitude } from '../../math';
import { getTurretWorldMount } from '../../math';
import type { Vec3 } from '@/types/vec2';
import { getUnitGroundZ } from '../unitGeometry';
import { getRuntimeTurretMount, getRuntimeTurretMountHeight } from '../turretMounts';
import { GRAVITY } from '../../../config';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

/** True iff the entity carries the optional `commander` block — i.e.
 *  it's the player's commander unit. Centralized so a future tweak to
 *  the predicate (e.g. `commander && !isDying`) can't get applied to
 *  some sites and missed at others. */
export function isCommander(entity: { commander?: unknown }): boolean {
  return entity.commander !== undefined;
}

/** Bit-mask of which turrets are engaged/firing. Indices >= this can't
 *  fit in a 32-bit mask, so the helpers below treat them as always
 *  included (the rare unit with 31+ turrets falls back to "permissive"
 *  semantics rather than silently dropping out of the mask). */
export const TURRET_MASK_MAX_INDEX = 30;

export function turretBit(index: number): number {
  return index <= TURRET_MASK_MAX_INDEX ? (1 << index) : 0;
}

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
    return target.unit.radius.shot;
  } else if (target.building) {
    return target.building.targetRadius;
  }
  return 0;
}

export function getProjectileLaunchSpeed(shot: Pick<ProjectileShot, 'launchForce' | 'mass'>): number {
  if (shot.mass <= 1e-6) return 0;
  return shot.launchForce / shot.mass;
}

/** Step a non-negative cooldown timer toward zero by `dtMs`. Skips
 *  the work entirely when the timer is already at rest, and floors
 *  the result at 0 so the next tick's `if (cd > 0)` gate reads false
 *  instead of leaking a tiny negative deficit into the next cycle. */
export function decrementCooldown(cd: number, dtMs: number): number {
  if (cd <= 0) return 0;
  const next = cd - dtMs;
  return next < 0 ? 0 : next;
}

const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const _rwmOut: Vec3 = { x: 0, y: 0, z: 0 };

export type WeaponKinematicsOptions = {
  currentTick?: number;
  dtMs?: number;
  unitGroundZ?: number;
  surfaceN?: { nx: number; ny: number; nz: number };
};

function usesHostBodyCenterMount(
  unit: Entity,
  turret: { config?: { mountMode?: 'authored' | 'unitBodyCenter' } },
): boolean {
  return unit.unit !== undefined && turret.config?.mountMode === 'unitBodyCenter';
}

function writeHostBodyCenterMount(
  unit: Entity,
  cos: number,
  sin: number,
  options: { unitGroundZ?: number; surfaceN?: { nx: number; ny: number; nz: number } } | undefined,
  out: Vec3,
): Vec3 {
  const suspension = unit.unit?.suspension;
  if (suspension) {
    const unitGroundZ = options?.unitGroundZ ?? getUnitGroundZ(unit);
    const mount = getTurretWorldMount(
      unit.transform.x,
      unit.transform.y,
      unitGroundZ,
      cos,
      sin,
      suspension.offsetX,
      suspension.offsetY,
      unit.unit!.bodyCenterHeight + suspension.offsetZ,
      options?.surfaceN ?? FLAT_SURFACE_NORMAL,
    );
    out.x = mount.x;
    out.y = mount.y;
    out.z = mount.z;
    return out;
  }
  out.x = unit.transform.x;
  out.y = unit.transform.y;
  out.z = unit.transform.z;
  return out;
}

export function resolveWeaponWorldMount(
  unit: Entity,
  turret: {
    worldPos?: Vec3;
    worldPosTick?: number;
    mount: Vec3;
    config?: { mountMode?: 'authored' | 'unitBodyCenter' };
  },
  _turretIndex: number,
  cos: number,
  sin: number,
  options?: {
    currentTick?: number;
    unitGroundZ?: number;
    surfaceN?: { nx: number; ny: number; nz: number };
  },
  out: Vec3 = _rwmOut,
): Vec3 {
  if (usesHostBodyCenterMount(unit, turret)) {
    return writeHostBodyCenterMount(unit, cos, sin, options, out);
  }

  if (
    turret.worldPos &&
    (options?.currentTick === undefined || turret.worldPosTick === options.currentTick)
  ) {
    out.x = turret.worldPos.x;
    out.y = turret.worldPos.y;
    out.z = turret.worldPos.z;
    return out;
  }

  const unitGroundZ = options?.unitGroundZ ?? getUnitGroundZ(unit);
  const localMount = getRuntimeTurretMount(turret);
  const suspension = unit.unit?.suspension;
  const mount = getTurretWorldMount(
    unit.transform.x, unit.transform.y, unitGroundZ,
    cos, sin,
    localMount.x + (suspension?.offsetX ?? 0),
    localMount.y + (suspension?.offsetY ?? 0),
    localMount.z + (suspension?.offsetZ ?? 0),
    options?.surfaceN ?? FLAT_SURFACE_NORMAL,
  );
  out.x = mount.x;
  out.y = mount.y;
  out.z = mount.z;
  return out;
}

/** Authoritative per-turret mount kinematics.
 *
 *  This is the single place that writes `turret.worldPos`,
 *  `turret.worldVelocity`, and `turret.worldPosTick`. Callers that need
 *  a current turret position should use this before aim/fire/field
 *  math; callers that only need to read an already-current value can use
 *  resolveWeaponWorldMount.
 */
export function updateWeaponWorldKinematics(
  unit: Entity,
  turret: Turret,
  _turretIndex: number,
  cos: number,
  sin: number,
  options: WeaponKinematicsOptions = {},
  out: Vec3 = _rwmOut,
): Vec3 {
  const worldPos = turret.worldPos ?? (turret.worldPos = { x: 0, y: 0, z: 0 });
  const worldVel = turret.worldVelocity ?? (turret.worldVelocity = { x: 0, y: 0, z: 0 });
  const currentTick = options.currentTick;
  const bodyCenterMount = usesHostBodyCenterMount(unit, turret);
  if (currentTick !== undefined && turret.worldPosTick === currentTick && !bodyCenterMount) {
    out.x = worldPos.x;
    out.y = worldPos.y;
    out.z = worldPos.z;
    return out;
  }

  const unitGroundZ = options.unitGroundZ ?? getUnitGroundZ(unit);
  let mount: Vec3;
  if (bodyCenterMount) {
    mount = writeHostBodyCenterMount(unit, cos, sin, options, out);
  } else {
    const localMount = getRuntimeTurretMount(turret);
    const suspension = unit.unit?.suspension;
    mount = getTurretWorldMount(
      unit.transform.x, unit.transform.y, unitGroundZ,
      cos, sin,
      localMount.x + (suspension?.offsetX ?? 0),
      localMount.y + (suspension?.offsetY ?? 0),
      localMount.z + (suspension?.offsetZ ?? 0),
      options.surfaceN ?? FLAT_SURFACE_NORMAL,
    );
  }

  const prevTick = turret.worldPosTick;
  const ticksElapsed = currentTick !== undefined && prevTick !== undefined
    ? currentTick - prevTick
    : 0;

  if (ticksElapsed === 1 && options.dtMs !== undefined && options.dtMs > 0) {
    const invElapsedSec = 1000 / options.dtMs;
    worldVel.x = (mount.x - worldPos.x) * invElapsedSec;
    worldVel.y = (mount.y - worldPos.y) * invElapsedSec;
    worldVel.z = (mount.z - worldPos.z) * invElapsedSec;
  } else if (unit.unit) {
    worldVel.x = unit.unit.velocityX ?? 0;
    worldVel.y = unit.unit.velocityY ?? 0;
    worldVel.z = unit.unit.velocityZ ?? 0;
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

/** Per-turret mount height above the unit's ground footprint. Runtime
 *  turrets derive this from the unit blueprint's `turrets[i].mount.z`,
 *  so the server's targeting/firing path and the client renderer share
 *  the same authored 3D pivot. */
export function getTurretMountHeight(unit: Entity, turretIndex: number): number {
  const turret = unit.combat?.turrets?.[turretIndex];
  return turret ? getRuntimeTurretMountHeight(turret) : (unit.unit?.bodyCenterHeight ?? 0);
}

export function getEntityVelocity3(entity: Entity, out: Vec3): Vec3 {
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

export type GroundHeightLookup = (x: number, y: number) => number;

function isUnitAirborneForAcceleration(entity: Entity, groundHeightAt?: GroundHeightLookup): boolean {
  const unit = entity.unit;
  if (!unit) return false;
  const verticalSpeed = Math.abs(unit.velocityZ ?? 0);
  if (!groundHeightAt) return unit.jump?.active === true || verticalSpeed > 0.05;
  const groundPointZ = entity.transform.z - unit.bodyCenterHeight;
  return (
    groundPointZ > groundHeightAt(entity.transform.x, entity.transform.y) + 0.25 ||
    verticalSpeed > 0.05
  );
}

export function getEntityAcceleration3(
  entity: Entity,
  out: Vec3,
  groundHeightAt?: GroundHeightLookup,
): Vec3 {
  if (entity.unit) {
    out.x = entity.unit.movementAccelX ?? 0;
    out.y = entity.unit.movementAccelY ?? 0;
    out.z = entity.unit.movementAccelZ ?? 0;
    if (isUnitAirborneForAcceleration(entity, groundHeightAt)) out.z -= GRAVITY;
  } else if (entity.projectile) {
    out.x = 0;
    out.y = 0;
    out.z = -GRAVITY;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

export function updateProjectileSourceClearance(
  source: Entity | undefined,
  projectile: { hasLeftSource?: boolean },
  pointX: number,
  pointY: number,
  pointZ: number,
  pointRadius: number,
): boolean {
  if (projectile.hasLeftSource) return true;
  if (!source?.unit) {
    projectile.hasLeftSource = true;
    return true;
  }

  const dx = pointX - source.transform.x;
  const dy = pointY - source.transform.y;
  const dz = pointZ - source.transform.z;
  const clearance = source.unit.radius.shot + Math.max(0, pointRadius) + 2;
  if (dx * dx + dy * dy + dz * dz > clearance * clearance) {
    projectile.hasLeftSource = true;
    return true;
  }
  return false;
}

// Get angle to face based on movement (or body direction if stationary)
// Used by weapons when they have no target - they face movement direction
export function getMovementAngle(unit: Entity): number {
  if (!unit.unit) return unit.transform.rotation;

  const velX = unit.unit.velocityX ?? 0;
  const velY = unit.unit.velocityY ?? 0;
  const speed = magnitude(velX, velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - use body direction (weapons maintain their own rotation)
  return unit.transform.rotation;
}
