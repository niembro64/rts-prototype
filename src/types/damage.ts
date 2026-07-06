// Damage system types. All collision queries are 3D on this branch —
// projectile hits, laser hits, and splash AOE each carry altitude
// (z on every position, vz on velocity) so a shot flying over a unit's
// head actually misses, a mortar explosion punishes targets inside its
// 3D sphere (not a 2D disc), and a laser pointed upward ignores the
// guy at sea level.
//
// Sphere center-z for units: unit.transform.z (set by physics engine
// to unit.radius when resting on ground). The damage system compares
// hit-shape vs unit-sphere in full 3D.

import type { EntityId, PlayerId } from './sim';
import type { Vec2, Vec3 } from './vec2';

export type DamageSourceBase = {
  sourceEntityId: EntityId;
  ownerId: PlayerId;
  damage: number;
  excludeEntities: Set<EntityId>;
  excludeCommanders?: boolean;
};

/** Projectile swept damage: capsule swept from prev → current with
 *  `radius`. Travels through 3D; `velocity` is the full 3D launch
 *  velocity for momentum-based knockback. */
export type SweptDamageSource = DamageSourceBase & {
  type: 'swept';
  prev: Vec3;
  current: Vec3;
  radius: number;
  maxHits: number;
  velocity?: Vec3;
  projectileMass?: number;
};

/** Splash / AOE damage: 3D sphere of `radius` around `center`. Unit's
 *  shot collider must intersect this sphere — pure boolean overlap
 *  test, no distance falloff. Damage + knockback are applied at full
 *  magnitude inside the sphere, zero outside. `sliceAngle` /
 *  `sliceDirection` are planar for callers that need conic AOE. */
export type AreaDamageSource = DamageSourceBase & {
  type: 'area';
  center: Vec3;
  radius: number;
  sliceAngle?: number;
  sliceDirection?: number;
  knockbackForce?: number;
};

export type AnyDamageSource = SweptDamageSource | AreaDamageSource;

export type KnockbackInfo = {
  entityId: EntityId;
  /** Entity-slot cache for hot force application. `-1` means the caller only
   *  had an id and ForceAccumulator should resolve the current slot. */
  entitySlot: number;
  force: Vec2;
  /** Optional vertical force component for 3D pushes. Splash explosions
   *  pass `dirZ * force` so a blast below a unit lifts it. Omitted/0
   *  for purely horizontal knockback (line beams, recoil, etc.) so
   *  existing callers keep their old 2D behavior unchanged. */
  forceZ?: number;
};

export type DeathContext = {
  penetrationDir: Vec2;
  attackerVel: Vec2;
  attackMagnitude: number;
};

// Turrets never die separately from their host (they are inseparable
// mounted emitters), so there is no killed-turret set here; turret-mount
// damage resolves through the host body.
export type DamageResult = {
  hitEntityIds: EntityId[];
  killedUnitIds: Set<EntityId>;
  killedBuildingIds: Set<EntityId>;
  killedProjectileIds: Set<EntityId>;
  truncationT: number | null;
  knockbacks: KnockbackInfo[];
  deathContexts: Map<EntityId, DeathContext>;
  /** Per-kill, the playerId of the entity that dealt the killing blow.
   *  Drives the kill-credit channel (FOW-17): the death
   *  event flows to this player's snapshot even when they don't have
   *  vision of the corpse, so the killer learns "I got it" rather
   *  than the target silently vanishing. Undefined when the killer's
   *  ownership couldn't be resolved (e.g. neutral / world damage). */
  killerPlayerIds: Map<EntityId, PlayerId | null>;
};

export type HitInfo = {
  entityId: EntityId;
  hostEntityId?: EntityId;
  t: number;
  isUnit: boolean;
  isBuilding: boolean;
  isProjectile: boolean;
};
