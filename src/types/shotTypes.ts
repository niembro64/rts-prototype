import type { SoundEntry } from './audio';
import type { ShotId } from './blueprintIds';
import type { EntityId, PlayerId } from './entityTypes';

export type ProjectileShotKind = 'projectile' | 'rocket';

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
  outerRatio?: number;       // percentage of range (ignored if rimWidth set)
  rimWidth?: number;         // fixed world-space outer radius
  /** Downward sphere-center offset as a multiple of the computed outer radius. */
  originOffsetRadiusRatio?: number;
  color: number;
  alpha: number;
  particleAlpha: number;
};

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
  /** Shot blueprint ID for each spawned child. Must be a 'projectile' shot. */
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

/** Per-shot rocket-cylinder dimensions. Both values are multiples of
 *  the projectile's `collision.radius`. */
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
  /** Optional. Omit for carrier shots that only release submunitions. */
  explosion?: ShotExplosion;
  /** When true, the projectile runs detonation logic at the end of `lifespan`. */
  detonateOnExpiry: boolean;
  lifespan?: number;
  /** Fractional per-instance lifespan variance. `0.1` means plus/minus 10%. */
  lifespanVariance?: number;
  hitSound?: SoundEntry;
  /** Cluster behavior. */
  submunitions?: SubmunitionSpec;
  /** When true, gravity is not applied to this projectile's vertical velocity. */
  ignoresGravity?: boolean;
  /** Maximum yaw rate (radians / sec) the projectile applies while homing. */
  homingTurnRate?: number;
  /** Cosmetic smoke trail config. Sim-side: no effect. */
  smokeTrail?: SmokeTrailSpec;
  /** Cosmetic 3D-client mesh shape for the projectile body. */
  shape?: 'sphere' | 'cylinder';
  /** Cylinder dimensions when `shape === 'cylinder'`. */
  cylinderShape?: CylinderShapeSpec;
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
  hitSound?: SoundEntry;
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
  hitSound?: SoundEntry;
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
  /** Rocket/missile flag; gravity is not applied to vz while this shot is in flight. */
  ignoresGravity?: boolean;
  /** Cosmetic smoke-trail config. */
  smokeTrail?: SmokeTrailSpec;
  /** Cosmetic 3D-client mesh shape. */
  shape?: 'sphere' | 'cylinder';
  /** Cylinder dimensions when `shape === 'cylinder'`. */
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
  ignoresGravity: boolean;
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
  projectileShape: 'sphere' | 'cylinder';
  projectileBodyRadius: number;
  cylinderLengthMult: number;
  cylinderDiameterMult: number;
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
  return shot.type === 'projectile' || shot.type === 'rocket';
}

/** Rocket-class predicate: a projectile shot whose `ignoresGravity` flag is set. */
export function isRocketLikeShot(shot: ShotConfig): boolean {
  return isProjectileShot(shot) && shot.ignoresGravity === true;
}

/** Static (no-RNG) max lifespan for a shot. */
export function getShotMaxLifespan(shot: ShotConfig, fallbackLifespan: number = 2000): number {
  if (shot.type === 'beam') return Infinity;
  if (shot.type === 'laser') return shot.duration;
  if (shot.type === 'projectile' || shot.type === 'rocket') return shot.lifespan ?? fallbackLifespan;
  return fallbackLifespan;
}
