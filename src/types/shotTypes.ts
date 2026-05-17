import type { SoundEntry } from './audio';
import type { ShotId } from './blueprintIds';
import type { EntityId, PlayerId } from './entityTypes';

export type ProjectileShotKind = 'plasma' | 'rocket';
export type ProjectileTailShape = 'cone' | 'cylinder' | 'none';

/** The set of `shot.type` values that mirror panels reflect. Adding
 *  one here automatically wires the new type into the aim solver,
 *  panel hit collision, and beam-trace reflection. */
export const LINE_SHOT_TYPES = ['beam', 'laser'] as const;
export type LineShotType = typeof LINE_SHOT_TYPES[number];

/** Predicate on raw `shot.type` strings, used at network / projectile
 *  layer boundaries where we have a string but not the full ShotConfig. */
export function isLineShotType(t: string): t is LineShotType {
  return t === 'beam' || t === 'laser';
}

export type ForceFieldBarrierRatioConfig = {
  outerRatio?: number | null;       // percentage of range (ignored if rimWidth set)
  rimWidth?: number | null;         // fixed world-space outer radius
  /** Downward sphere-center offset as a multiple of the computed outer radius. */
  originOffsetRadiusRatio?: number | null;
  color: number;
  alpha: number;
  particleAlpha: number;
};

export const FORCE_FIELD_REFLECTION_MODES = ['outside-in', 'inside-out', 'both'] as const;
export type ForceFieldReflectionMode = typeof FORCE_FIELD_REFLECTION_MODES[number];

export function isForceFieldReflectionMode(value: unknown): value is ForceFieldReflectionMode {
  return value === 'outside-in' || value === 'inside-out' || value === 'both';
}

export type ShotCollision = {
  /** Sphere radius for swept-collision and area-damage centering.
   *  Damage now lives entirely in the explosion block (primary +
   *  secondary zones); a direct hit triggers the explosion at the
   *  contact point, the explosion deals the damage. */
  radius: number;
};

/** Splash AoE for a projectile. SINGLE radius; damage and force are
 *  applied as a boolean overlap test. */
export type ShotExplosion = {
  radius: number;
  damage: number;
  force: number;
};

/**
 * Cluster / submunition specification. When attached to a projectile
 * shot, the sim spawns `count` copies of `shotId` at the explosion
 * origin whenever the parent shot explodes.
 */
export type SubmunitionSpec = {
  /** Shot blueprint ID for each spawned child. Must be a plasma/rocket shot. */
  shotId: ShotId;
  /** Number of children spawned per parent explosion. */
  count: number;
  /** Horizontal random-spread magnitude in the XY plane. */
  randomSpreadSpeedHorizontal: number;
  /** Vertical random-spread magnitude on the Z axis. */
  randomSpreadSpeedVertical: number;
  /** Multiplier applied to the parent's reflected velocity before it
   *  becomes the submunition's base direction. Defaults to 1.0. */
  reflectedVelocityDamper?: number;
};

/** @deprecated Projectile visuals are now type-derived: plasma uses a
 *  12x-radius cone tail, rocket uses an 8x-radius cylinder tail. */
export type CylinderShapeSpec = {
  /** World-space length of the rendered pill = collision.radius times this. */
  lengthMult?: number;
  /** World-space diameter of the rendered pill = collision.radius times this. */
  diameterMult?: number;
};

/** Per-shot smoke-trail tunables. Every field is optional; the
 *  3D renderer fills in engine-wide defaults for anything omitted. */
export type SmokeTrailSpec = {
  /** Render frames to skip between puff spawns for this shot at the
   *  highest-quality cadence. The active PLAYER CLIENT LOD can only
   *  increase this skip count. Default: 0 (sample every render frame at MAX). */
  emitFramesSkip?: number;
  /** Per-puff lifespan in ms at max LOD. Default: 1400. */
  lifespanMs?: number;
  /** Sphere radius the puff is born at, world units. Default: 2.5. */
  startRadius?: number;
  /** Sphere radius the puff swells to before it fully fades. Default: 8. */
  endRadius?: number;
  /** Puff opacity at birth (it fades to 0 over its lifespan). Default: 0.75. */
  startAlpha?: number;
  /** Puff color as a 0xRRGGBB hex int. Default: 0xcccccc (light grey). */
  color?: number;
};

export type ProjectileShotBlueprint = {
  type: ProjectileShotKind;
  id: ShotId;
  mass: number;
  collision: ShotCollision;
  /** Null for carrier shots that only release submunitions. */
  explosion: ShotExplosion | null;
  /** When true, the projectile runs detonation logic at the end of `lifespan`. */
  detonateOnExpiry: boolean;
  lifespan: number | null;
  /** Fractional per-instance lifespan variance. `0.1` means plus/minus 10%. */
  lifespanVariance: number | null;
  hitSound: SoundEntry | null;
  /** Cluster behavior. */
  submunitions: SubmunitionSpec | null;
  /** Maximum yaw rate (radians / sec) the projectile applies while homing. */
  homingTurnRate: number | null;
  /** Cosmetic smoke trail config. Sim-side: no effect. */
  smokeTrail: SmokeTrailSpec | null;
  /** @deprecated Ignored by the 3D projectile renderer. */
  shape: 'sphere' | 'cylinder' | null;
  /** @deprecated Ignored by the 3D projectile renderer. */
  cylinderShape: CylinderShapeSpec | null;
};

export type BeamShotBlueprint = {
  type: 'beam';
  id: ShotId;
  dps: number;
  force: number;
  recoil: number;
  /** Thin beam body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere radius. */
  damageSphere: { radius: number };
  hitSound: SoundEntry | null;
};

export type LaserShotBlueprint = {
  type: 'laser';
  id: ShotId;
  dps: number;
  force: number;
  recoil: number;
  /** Thin laser body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere radius. */
  damageSphere: { radius: number };
  duration: number;
  hitSound: SoundEntry | null;
};

export type ShotBlueprint =
  | ProjectileShotBlueprint
  | BeamShotBlueprint
  | LaserShotBlueprint;
export type LineShotBlueprint = BeamShotBlueprint | LaserShotBlueprint;

/** Blueprint-side counterpart of `isLineShot`. */
export function isLineShotBlueprint(sb: ShotBlueprint): sb is LineShotBlueprint {
  return isLineShotType(sb.type);
}

// Force field barrier configuration: a visual/interception sphere,
// not a unit or projectile acceleration volume.
export type ForceFieldBarrierConfig = {
  innerRange: number;
  outerRange: number;
  /** World-space downward offset from the emitter/turret origin to the sphere origin. */
  originOffsetZ: number;
  color: number;
  alpha: number;
  particleAlpha: number;
};

// Projectile shot: fire-and-forget, has mass, single-tick impact.
export type ProjectileShot = {
  type: ProjectileShotKind;
  id: ShotId;
  mass: number;
  launchForce: number;
  collision: ShotCollision;
  /** Splash AoE. */
  explosion?: ShotExplosion;
  /** When true, run detonation logic at the end of `lifespan`. */
  detonateOnExpiry?: boolean;
  lifespan?: number;
  /** Fractional per-instance variance applied to maxLifespan at projectile creation. */
  lifespanVariance?: number;
  homingTurnRate?: number;
  trailLength?: number;
  /** Cluster / flak-burst behavior. */
  submunitions?: SubmunitionSpec;
  /** Cosmetic smoke-trail config. */
  smokeTrail?: SmokeTrailSpec;
  /** @deprecated Ignored by the 3D projectile renderer. */
  shape?: 'sphere' | 'cylinder';
  /** @deprecated Ignored by the 3D projectile renderer. */
  cylinderShape?: CylinderShapeSpec;
};

// Beam shot: continuous line from turret, per-tick damage.
export type BeamShot = {
  type: 'beam';
  id: ShotId;
  dps: number;
  force: number;
  recoil: number;
  /** Thin beam body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere. */
  damageSphere: { radius: number };
};

// Laser shot: pulsed line weapon with duration + cooldown.
export type LaserShot = {
  type: 'laser';
  id: ShotId;
  dps: number;
  force: number;
  recoil: number;
  /** Thin laser body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere. */
  damageSphere: { radius: number };
  duration: number;
};

// Shared type for beam and laser (line weapons).
export type LineShot = BeamShot | LaserShot;
export type ActiveProjectileShot = ProjectileShot | BeamShot | LaserShot;

/** Predicate on a full ShotConfig. */
export function isLineShot(shot: ShotConfig): shot is LineShot {
  return isLineShotType(shot.type);
}

// Force shot: continuous spherical barrier around turret.
export type ForceShot = {
  type: 'force';
  angle: number;
  transitionTime: number;
  barrier?: ForceFieldBarrierConfig;
};

export type ShotConfig =
  | ProjectileShot
  | BeamShot
  | LaserShot
  | ForceShot;

// Projectile travel types.
export type ProjectileType = 'projectile' | 'beam' | 'laser';

/** One vertex of a beam/laser polyline. */
export type BeamReflectorKind = 'mirror' | 'forceField';

export type BeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  /** Legacy name: any beam reflector entity, not only mirrors. */
  mirrorEntityId?: EntityId;
  reflectorKind?: BeamReflectorKind;
  reflectorPlayerId?: PlayerId;
  /** Full 3D reflector surface normal in sim coords. Present on reflector vertices. */
  normalX?: number;
  normalY?: number;
  normalZ?: number;
};

export type ShotRuntimeProfile = {
  id: ShotId;
  type: ActiveProjectileShot['type'];
  projectileType: ProjectileType;
  isProjectile: boolean;
  isLine: boolean;
  isRocketLike: boolean;
  /** Swept/projectile collider radius for traveling shots, or line trace radius. */
  collisionRadius: number;
  /** Radius written into ImpactContext for audio/death effects. */
  impactRadius: number;
  /** Projectile splash radius. 0 when the shot has no splash zone. */
  explosionRadius: number;
  /** Beam/laser endpoint damage radius, or projectile direct collider. */
  damageRadius: number;
  maxLifespan: number;
  detonateOnExpiry: boolean;
  hasExplosion: boolean;
  hasSubmunitions: boolean;
};

export type ShotVisualProfile = {
  projectileBodyRadius: number;
  projectileTailShape: ProjectileTailShape;
  projectileTailLengthMult: number;
  projectileTailRadiusMult: number;
  /** Per-fin size as a multiple of the body radius. 0 means no fins. */
  projectileFinSizeMult: number;
  debugCollisionRadius: number;
  debugExplosionRadius: number;
  smokeTrail?: SmokeTrailSpec;
  /** Ground mark width authored from the shot once. */
  burnMarkWidth: number;
  lineRadius: number;
  lineDamageSphereRadius: number;
};

export type ShotProfile = {
  runtime: ShotRuntimeProfile;
  visual: ShotVisualProfile;
};

export function isProjectileShot(shot: ShotConfig): shot is ProjectileShot {
  return shot.type === 'plasma' || shot.type === 'rocket';
}

/** Rocket-class predicate used for seeker behavior and visuals. */
export function isRocketLikeShot(shot: ShotConfig): boolean {
  return isProjectileShot(shot) && shot.type === 'rocket';
}

/** Static (no-RNG) max lifespan for a shot. */
export function getShotMaxLifespan(shot: ShotConfig, fallbackLifespan: number = 2000): number {
  if (shot.type === 'beam') return Infinity;
  if (shot.type === 'laser') return shot.duration;
  if (shot.type === 'plasma' || shot.type === 'rocket') return shot.lifespan ?? fallbackLifespan;
  return fallbackLifespan;
}
