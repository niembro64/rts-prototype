// Combat utility functions

import type { Entity, ProjectileShot, Turret } from '../types';
import { distance, normalizeAngle, magnitude } from '../../math';
import { getTurretWorldMount } from '../../math';
import type { Vec3 } from '@/types/vec2';
import { getUnitGroundZ } from '../unitGeometry';
import { getRuntimeTurretMount, getRuntimeTurretMountHeight } from '../turretMounts';
import { GRAVITY } from '../../../config';
import { readCombatTargetingTurretMountKinematicsInto } from './targetingInputStamping';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

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
const _entityPositionScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _entityVelocityScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _mountKinematicsVelScratch: Vec3 = { x: 0, y: 0, z: 0 };

type SurfaceNormal = { nx: number; ny: number; nz: number };

export type WeaponKinematicsOptions = {
  currentTick: number | undefined;
  dtMs: number | undefined;
  unitGroundZ: number | undefined;
  surfaceN: SurfaceNormal | undefined;
};

export type WeaponWorldMountOptions = {
  currentTick: number | undefined;
  unitGroundZ: number | undefined;
  surfaceN: SurfaceNormal | undefined;
};

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
    readCombatTargetingTurretMountKinematicsInto(
      unit, turretIndex, currentTick, out, _mountKinematicsVelScratch,
    )
  ) {
    return out;
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
  const localMount = getRuntimeTurretMount(turret);
  const sourceUnit = unit.unit;
  const suspension = sourceUnit !== null ? sourceUnit.suspension : null;
  const unitPosition = getEntityPosition3d(unit, _entityPositionScratch);
  const mount = getTurretWorldMount(
    unitPosition.x, unitPosition.y, unitGroundZ,
    cos, sin,
    localMount.x + (suspension !== null ? suspension.offsetX : 0),
    localMount.y + (suspension !== null ? suspension.offsetY : 0),
    localMount.z + (suspension !== null ? suspension.offsetZ : 0),
    optionSurfaceN ?? FLAT_SURFACE_NORMAL,
  );
  out.x = mount.x;
  out.y = mount.y;
  out.z = mount.z;
  return out;
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
    readCombatTargetingTurretMountKinematicsInto(
      unit, turretIndex, currentTick, out, _mountKinematicsVelScratch,
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
  const localMount = getRuntimeTurretMount(turret);
  const sourceUnit = unit.unit;
  const suspension = sourceUnit !== null ? sourceUnit.suspension : null;
  const unitPosition = getEntityPosition3d(unit, _entityPositionScratch);
  const mount = getTurretWorldMount(
    unitPosition.x, unitPosition.y, unitGroundZ,
    cos, sin,
    localMount.x + (suspension !== null ? suspension.offsetX : 0),
    localMount.y + (suspension !== null ? suspension.offsetY : 0),
    localMount.z + (suspension !== null ? suspension.offsetZ : 0),
    options.surfaceN ?? FLAT_SURFACE_NORMAL,
  );

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

/** Per-turret mount height above the unit's ground footprint. Runtime
 *  turrets derive this from the unit blueprint's `turrets[i].mount.z`,
 *  so the server's targeting/firing path and the client renderer share
 *  the same authored 3D pivot. */
export function getTurretMountHeight(unit: Entity, turretIndex: number): number {
  const combat = unit.combat;
  const turret = combat !== null ? combat.turrets[turretIndex] : undefined;
  if (turret !== undefined) return getRuntimeTurretMountHeight(turret);
  const sourceUnit = unit.unit;
  return sourceUnit !== null ? sourceUnit.bodyCenterHeight : 0;
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
      projShot && 'gravityForceMultiplier' in projShot
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
  projectile: { hasLeftSource: boolean },
  pointX: number,
  pointY: number,
  pointZ: number,
  pointRadius: number,
): boolean {
  if (projectile.hasLeftSource) return true;
  if (source === undefined || source.unit === null) {
    projectile.hasLeftSource = true;
    return true;
  }

  const sourceUnit = source.unit;
  const sourcePosition = getEntityPosition3d(source, _entityPositionScratch);
  const dx = pointX - sourcePosition.x;
  const dy = pointY - sourcePosition.y;
  const dz = pointZ - sourcePosition.z;
  const clearance = sourceUnit.radius.shot + Math.max(0, pointRadius) + 2;
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

  const velocity = getEntityVelocity3d(unit, _entityVelocityScratch);
  const velX = velocity.x;
  const velY = velocity.y;
  const speed = magnitude(velX, velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - use body direction (weapons maintain their own rotation)
  return unit.transform.rotation;
}
