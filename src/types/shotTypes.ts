import type { SoundEntry } from './audio';
import type { ShotId } from './blueprintIds';
import type { EntityId, PlayerId } from './entityTypes';

export type ProjectileShotKind = 'plasma' | 'rocket';
export type ProjectileTailShape = 'cone' | 'cylinder' | 'none';

/** The set of `shot.type` values that force-field panels reflect. Adding
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

/** Smoke tunables resolved from smokeConfig.json. Blueprint-side
 *  smokeTrail entries are legacy optional overrides for a configured
 *  smoke use; unconfigured shots do not emit smoke. */
export type SmokeTrailSpec = {
  /** Resolved smokeConfig top-level key for this smoke use. */
  useId?: string;
  /** Per-use active-puff ceiling. */
  maxPoolSize?: number;
  /** What to do when the use-specific puff ceiling is reached. */
  capPolicy: 'evictOldest' | 'skipWhenFull';
  /** Render frames to skip between puff spawns. Default comes from
   *  smokeConfig.json for the use case. */
  emitFramesSkip?: number;
  /** Puff emit velocity in world-units/sec, applied opposite to the
   *  projectile's instantaneous flight direction so the puffs drift
   *  rearward after birth. 0 (default) leaves puffs stationary in
   *  world space — the rocket flies on and the trail lingers in place. */
  exhaustSpeed?: number;
  /** Sphere radius the puff is born at, world units. */
  startRadius?: number;
  /** Multiplier applied to startRadius for the puff's final radius. */
  endRadiusMultiplier?: number;
  /** Duration in ms for alpha to ramp from 0 to maxAlpha. */
  fadeInMs?: number;
  /** Duration in ms for alpha to ramp from maxAlpha to 0 at end of life. */
  fadeOutMs?: number;
  /** Peak puff opacity after fade-in. */
  maxAlpha?: number;
  /** Puff color as a 0xRRGGBB hex int. Default lives in colorsConfig.json. */
  color?: number;
};

export type ProjectileShotBlueprint = {
  type: ProjectileShotKind;
  id: ShotId;
  mass: number;
  collision: ShotCollision;
  /** Null for carrier shots that only release submunitions. */
  explosion: ShotExplosion | null;
  /** When true, terminal impacts/timeouts run detonation logic. */
  detonateOnExpiry: boolean;
  /** Maximum active time in milliseconds. Required for rocket shots so
   *  guidance missiles do not live forever if they never hit. Null or
   *  omitted on non-rockets means no age-based expiry. */
  maxLifespan?: number | null;
  hitSound: SoundEntry | null;
  /** Cluster behavior. */
  submunitions: SubmunitionSpec | null;
  /** Maximum yaw rate (radians / sec) the projectile applies while homing. */
  homingTurnRate: number | null;
  /** Maximum thrust force (world-unit-newtons) the projectile's engine
   *  produces while homing. Combined with `mass`, this is the in-flight
   *  acceleration budget (`a_max = homingThrust / mass`) that bounds the
   *  steering vector. Gravity applies to rockets like every other mass
   *  body; the homing equation adds a counter-gravity term to the same
   *  thrust vector, so this budget pays for both lateral steering and
   *  holding altitude. A weak engine sags; it does not skip integration.
   *  Null for non-homing shots. */
  homingThrust: number | null;
  /** Per-shot multiplier on the global GRAVITY constant. 1 = full
   *  gravity (ballistic plasma); 0 = no gravity (rockets fly straight,
   *  line weapons skip ballistics entirely). Sim, client prediction,
   *  aim solver, and range envelope all read this so a shot's
   *  trajectory math agrees everywhere it's computed. */
  gravityForceMultiplier: number;
  /** Legacy/per-shot cosmetic smoke override. Current shared shot
   *  smoke profiles live in smokeConfig.json. Sim-side: no effect. */
  smokeTrail: SmokeTrailSpec | null;
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
  /** Always 0 for line weapons; carried so every shot blueprint
   *  exposes the same gravity knob. */
  gravityForceMultiplier: number;
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
  /** Always 0 for line weapons; carried so every shot blueprint
   *  exposes the same gravity knob. */
  gravityForceMultiplier: number;
  hitSound: SoundEntry | null;
};

export type ForceFieldShotBlueprint = {
  type: 'forceField';
  id: ShotId;
  angle: number;
  transitionTime: number;
  barrier: ForceFieldBarrierRatioConfig | null;
  hitSound: SoundEntry | null;
};

export type ShotBlueprint =
  | ProjectileShotBlueprint
  | BeamShotBlueprint
  | LaserShotBlueprint
  | ForceFieldShotBlueprint;
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
  /** When true, terminal impacts/timeouts run detonation logic. */
  detonateOnExpiry?: boolean;
  /** Maximum active time in milliseconds. Undefined means no age-based expiry. */
  maxLifespan?: number;
  homingTurnRate?: number;
  /** In-flight thrust budget in world-unit-newtons. Steering acceleration
   *  is bounded by `homingThrust / mass`. Undefined for non-homing shots. */
  homingThrust?: number;
  /** Per-shot scale on global GRAVITY for this shot's ballistic
   *  integration, aim solve, and range envelope. Mirrored from the
   *  blueprint. */
  gravityForceMultiplier: number;
  trailLength?: number;
  /** Cluster / flak-burst behavior. */
  submunitions?: SubmunitionSpec;
  /** Optional cosmetic smoke override merged with smokeConfig.json. */
  smokeTrail?: SmokeTrailSpec;
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
  /** Always 0; line weapons skip ballistic integration. */
  gravityForceMultiplier: number;
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
  /** Always 0; line weapons skip ballistic integration. */
  gravityForceMultiplier: number;
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
  type: 'forceField';
  id: ShotId;
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
// The force-field material is shape-independent: a beam reflecting off a
// panel and off a sphere is the same material, so it carries one kind.
// "Materials Are Independent Of Shape".
export type BeamReflectorKind = 'forceField';

export type BeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Any beam reflector entity — force-field panels and spheres both
   *  use this slot. */
  reflectorEntityId?: EntityId;
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
  /** Forward offset (world units) from the turret mount center to where the
   *  beam visually + physically begins. 0 for non-beam line shots. */
  lineEmissionOffset: number;
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

/** Static max active time for runtime shot entities. Traveling shots
 *  can opt into authored time-to-live values; otherwise they terminate
 *  through collision/ground physics. */
export function getShotMaxLifespan(shot: ShotConfig, fallbackLifespan: number = 2000): number {
  if (shot.type === 'beam') return Infinity;
  if (shot.type === 'laser') return shot.duration;
  if (shot.type === 'plasma' || shot.type === 'rocket') {
    return Number.isFinite(shot.maxLifespan) ? shot.maxLifespan! : Infinity;
  }
  return fallbackLifespan;
}
