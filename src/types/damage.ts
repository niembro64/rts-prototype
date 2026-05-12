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

/** Beam / laser damage: a 3D line segment from `start` → `end`. `width`
 *  is the cylinder radius around that segment — a unit's sphere must
 *  overlap it to take damage. */
export type LineDamageSource = DamageSourceBase & {
  type: 'line';
  start: Vec3;
  end: Vec3;
  width: number;
  maxHits: number;
  projectileMass?: number;
  velocity?: number;
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

export type AnyDamageSource = LineDamageSource | SweptDamageSource | AreaDamageSource;

export type KnockbackInfo = {
  entityId: EntityId;
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

export type RecoilInfo = {
  sourceEntityId: EntityId;
  force: Vec2;
};

export type DamageResult = {
  hitEntityIds: EntityId[];
  killedUnitIds: Set<EntityId>;
  killedBuildingIds: Set<EntityId>;
  truncationT?: number;
  knockbacks: KnockbackInfo[];
  recoil?: RecoilInfo;
  deathContexts: Map<EntityId, DeathContext>;
  /** Per-kill, the playerId of the entity that dealt the killing blow.
   *  Drives the kill-credit channel (issues.txt FOW-17): the death
   *  event flows to this player's snapshot even when they don't have
   *  vision of the corpse, so the killer learns "I got it" rather
   *  than the target silently vanishing. Undefined when the killer's
   *  ownership couldn't be resolved (e.g. neutral / world damage). */
  killerPlayerIds: Map<EntityId, PlayerId | undefined>;
};

export type HitInfo = {
  entityId: EntityId;
  t: number;
  isUnit: boolean;
  isBuilding: boolean;
};
