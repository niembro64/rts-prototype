// Combat system types extracted from game/sim/combat/types.ts

import type { EntityId, PlayerId, Entity } from './sim';
import type { DeathContext } from './damage';
import type { Vec2, Vec3 } from './vec2';

export type TurretAudioId = string;
export type SimEventSourceType = 'turret' | 'unit' | 'building' | 'system';

export type ImpactContext = {
  collisionRadius: number;
  /** Splash radius for the rendered explosion / death effect. With
   *  the boolean AoE model there's a single radius per shot;
   *  collisionRadius is the body-vs-body radius for direct hits and
   *  this is the splash sphere's radius if the shot has one. */
  explosionRadius: number;
  projectile: { pos: Vec2; vel: Vec2 };
  entity: { vel: Vec2; collisionRadius: number };
  penetrationDir: Vec2;
};

export type SimDeathContext = {
  unitVel: Vec2;
  hitDir: Vec2;
  projectileVel: Vec2;
  attackMagnitude: number;
  /** Combat/death-effect radius, usually the shot collider radius. */
  radius: number;
  /** Render body radius used for material debris templates. Kept
   *  separate from `radius` because shot, visual, and push colliders
   *  intentionally differ for several units. */
  visualRadius?: number;
  /** Physics push radius used to recover the unit's rendered base
   *  height from `transform.z`. */
  pushRadius?: number;
  /** Exact rendered base altitude at death (`transform.z - pushRadius`).
   *  Debris pieces are local-to-body/base, so using this avoids
   *  guessing the third axis from the shot collider. */
  baseZ?: number;
  color: number;
  unitType?: string;
  rotation?: number;
  /** Per-turret world-frame yaw + pitch at the moment of death,
   *  one entry per entry in the unit's blueprint `turrets` array.
   *  Debris3D rotates the barrel templates by these so each
   *  cylinder spawns at the world-space pose its live mesh held —
   *  not the chassis-aligned default. Optional: when missing
   *  Debris3D falls back to chassis-aligned (legacy behaviour). */
  turretPoses?: Array<{ rotation: number; pitch: number }>;
};

export type SimEvent = {
  type:
    | 'fire'
    | 'hit'
    | 'death'
    | 'laserStart'
    | 'laserStop'
    | 'forceFieldStart'
    | 'forceFieldStop'
    | 'projectileExpire';
  /** Weapon/audio routing key. This is a turret id for weapon events;
   *  non-weapon events should use sourceType/sourceKey instead of
   *  overloading this field with unit or building ids. */
  turretId: TurretAudioId;
  /** Explicit provenance for sim events. `turretId` remains the audio
   *  key; this pair describes what authored the event. */
  sourceType?: SimEventSourceType;
  sourceKey?: string;
  /** Event origin in full 3D sim coords. For a shell hitting the
   *  ground the z is 0; for an airburst it's the projectile's
   *  altitude at detonation; for a death event it's the dying
   *  entity's position. 2D clients ignore z, 3D clients use it to
   *  place the explosion / debris visuals at the exact impact
   *  altitude so the event visuals line up with what the sim
   *  computed. */
  pos: Vec3;
  entityId?: EntityId;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
};

export type ProjectileSpawnEvent = {
  id: EntityId;
  pos: Vec3;
  rotation: number;
  velocity: Vec3;
  projectileType: string;
  /** Resolved per-instance max lifespan in ms. Present for projectiles
   *  whose blueprint lifespan may be randomized. */
  maxLifespan?: number;
  /** Compatibility/source turret id. New code should use
   *  sourceTurretId for provenance and shotId for projectile config. */
  turretId: string;
  /** Actual shot blueprint id that should be hydrated on clients.
   *  This is especially important for submunitions, which are shot
   *  blueprints spawned by another projectile rather than by a turret. */
  shotId: string;
  /** Real turret blueprint id that ultimately authored this projectile,
   *  inherited through submunition chains when applicable. */
  sourceTurretId?: string;
  playerId: PlayerId;
  sourceEntityId: EntityId;
  turretIndex: number;
  /** Which physical barrel in the turret's cluster this shot came out
   *  of (0..barrelCount−1). Sent so the client can call getBarrelTip
   *  with the same barrelIndex the server used — spawn visuals emerge
   *  from the exact barrel the server picked, even on multi-barrel
   *  gatlings cycling through their cluster. */
  barrelIndex: number;
  isDGun?: boolean;
  /** True for cluster-flak submunitions and any other projectile that
   *  did NOT emerge from the shooter's barrel — the client should
   *  spawn the visual at `pos` as-is and skip the barrel-tip override
   *  it normally applies so the shot flies from the turret. Without
   *  this flag submunitions would snap back to the original shooter's
   *  gun muzzle every frame they're created. */
  fromParentDetonation?: boolean;
  beam?: { start: Vec3; end: Vec3 };
  targetEntityId?: EntityId;
  homingTurnRate?: number;
};

export type ProjectileDespawnEvent = {
  id: EntityId;
};

export type ProjectileVelocityUpdateEvent = {
  id: EntityId;
  pos: Vec3;
  velocity: Vec3;
};

export type FireTurretsResult = {
  projectiles: Entity[];
  events: SimEvent[];
  spawnEvents: ProjectileSpawnEvent[];
};

export type CollisionResult = {
  deadUnitIds: Set<EntityId>;
  deadBuildingIds: Set<EntityId>;
  events: SimEvent[];
  despawnEvents: ProjectileDespawnEvent[];
  deathContexts: Map<EntityId, DeathContext>;
  /** New projectile entities created by collisions (submunitions /
   *  cluster spawns). Simulation adds these to the world after the
   *  handler returns — the handler can't safely mutate the projectile
   *  cache mid-iteration. */
  newProjectiles: Entity[];
  /** Network spawn events matching `newProjectiles`, 1-to-1. */
  spawnEvents: ProjectileSpawnEvent[];
};
