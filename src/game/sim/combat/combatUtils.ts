// Combat utility functions

import type { Entity, ProjectileShot, Turret } from '../types';
import { distance, normalizeAngle, magnitude } from '../../math';
import { getTurretWorldMount } from '../../math';
import type { Vec3 } from '@/types/vec2';
import { getUnitGroundZ } from '../unitGeometry';
import { getRuntimeTurretMount, getRuntimeTurretMountHeight } from '../turretMounts';

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

/** Runtime weapon subset that can justify stopping a fight-move unit.
 *  Defensive/passive/manual/visual hardpoints can still rotate or activate,
 *  but they should not make a moving unit hold position as if it had a
 *  damage-dealing weapon ready. */
export function isFightMoveFireCapableTurret(turret: Turret): boolean {
  const config = turret.config;
  const shotType = config.shot.type;
  return (
    !config.visualOnly &&
    !config.isManualFire &&
    !config.passive &&
    shotType !== 'force' &&
    shotType !== 'buildSpray'
  );
}

/** Count fire-capable turrets in the runtime list. Movement uses this
 *  as the stop-ratio denominator instead of raw hardpoint count so
 *  construction emitters, manual D-guns, mirrors, and shields do not
 *  dilute normal attack-move behavior. */
export function fightMoveFireCapableTurretCount(turrets: readonly Turret[] | undefined): number {
  if (!turrets) return 0;
  let count = 0;
  for (let i = 0; i < turrets.length; i++) {
    if (isFightMoveFireCapableTurret(turrets[i])) count++;
  }
  return count;
}

/** Count fire-capable turrets that are engaged AND eligible for the
 *  firing path. The firing mask is written by targeting and then
 *  pruned by turret rotation when a ballistic projectile has no valid
 *  solution. That keeps fight-move from stopping at "engaged but
 *  cannot actually shoot" ranges. */
export function fightMoveFireEligibleTurretCount(
  turrets: readonly Turret[] | undefined,
  firingMask: number | undefined,
): number {
  if (!turrets) return 0;
  let count = 0;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (!isFightMoveFireCapableTurret(turret)) continue;
    if (turret.state !== 'engaged' || turret.target === null) continue;
    if (!turretMaskIncludes(firingMask, i)) continue;
    count++;
  }
  return count;
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

function writeHostBodyCenterMount(unit: Entity, out: Vec3): Vec3 {
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
    return writeHostBodyCenterMount(unit, out);
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
  const mount = getTurretWorldMount(
    unit.transform.x, unit.transform.y, unitGroundZ,
    cos, sin,
    localMount.x, localMount.y, localMount.z,
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
    mount = writeHostBodyCenterMount(unit, out);
  } else {
    const localMount = getRuntimeTurretMount(turret);
    mount = getTurretWorldMount(
      unit.transform.x, unit.transform.y, unitGroundZ,
      cos, sin,
      localMount.x, localMount.y, localMount.z,
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

export function computeTurretPointVelocity(
  turret: {
    rotation: number;
    angularVelocity: number;
    pitchVelocity: number;
    worldVelocity?: Vec3;
  },
  mountX: number,
  mountY: number,
  mountZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  out: Vec3,
  fallbackMountVelocity?: Vec3,
): Vec3 {
  const base = turret.worldVelocity ?? fallbackMountVelocity;
  out.x = base?.x ?? 0;
  out.y = base?.y ?? 0;
  out.z = base?.z ?? 0;

  const rx = pointX - mountX;
  const ry = pointY - mountY;
  const rz = pointZ - mountZ;

  const yawOmega = turret.angularVelocity;
  if (yawOmega !== 0) {
    out.x += -ry * yawOmega;
    out.y += rx * yawOmega;
  }

  const pitchOmega = turret.pitchVelocity;
  if (pitchOmega !== 0) {
    const pitchAxisX = Math.sin(turret.rotation) * pitchOmega;
    const pitchAxisY = -Math.cos(turret.rotation) * pitchOmega;
    out.x += pitchAxisY * rz;
    out.y += -pitchAxisX * rz;
    out.z += pitchAxisX * ry - pitchAxisY * rx;
  }

  return out;
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
