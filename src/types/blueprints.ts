// Blueprint types extracted from game/sim/blueprints/types.ts

import type {
  BarrelShape,
  MountPoint,
  ForceFieldTurretConfig,
  SpinConfig,
} from './config';
import type { SoundEntry } from './audio';
import type { TurretRangeOverrides } from './sim';

// Re-export for consumers
export type {
  BarrelShape,
  MountPoint,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
};

export type ForceFieldZoneRatioConfig = {
  innerRatio: number;
  outerRatio?: number;       // percentage of range (ignored if rimWidth set)
  rimWidth?: number;         // fixed pixel width for the zone band
  color: number;
  alpha: number;
  particleAlpha: number;
  power: number | null;
};

export type ShotCollision = {
  /** Sphere radius for swept-collision and area-damage centering.
   *  Damage now lives entirely in the explosion block (primary +
   *  secondary zones); a direct hit triggers the explosion at the
   *  contact point, the explosion deals the damage. */
  radius: number;
};

export type ShotExplosionZone = {
  radius: number;
  damage: number;
  force: number;
};

/**
 * Cluster / submunition specification. When attached to a projectile
 * shot, the sim spawns `count` copies of `shotId` at the explosion
 * origin whenever the parent shot explodes (either via direct-hit
 * splash or `detonateOnExpiry` timeout). Submunitions fly outward in a
 * full 2π fan at `speed` world-units/second using the child shot's
 * own blueprint as-is — no per-spawn property overrides. If you need
 * a different lifespan, collision radius, or any other shot trait,
 * author a separate shot blueprint and reference it here.
 *
 * Recursive submunitions (a child shot whose own blueprint has its
 * own `submunitions`) fire normally — the only requirement is that
 * no cycle forms, which is purely a blueprint-authoring concern.
 */
export type SubmunitionSpec = {
  /** Shot blueprint ID for each spawned child. Must be a 'projectile' shot. */
  shotId: string;
  /** Number of children spawned per parent explosion. */
  count: number;
  /** Horizontal random-spread magnitude (XY plane). Each submunition's
   *  launch velocity is
   *
   *    v.x = bounceVx + randomSpreadSpeedHorizontal × ux
   *    v.y = bounceVy + randomSpreadSpeedHorizontal × uy
   *    v.z = bounceVz + randomSpreadSpeedVertical   × uz
   *
   *  where (ux, uy, uz) is a uniform random unit 3D vector. So this
   *  knob is the *horizontal radius* of the random offset ellipsoid
   *  centered on the bounce direction:
   *   - 0    → every fragment flies along the bounce direction's
   *            horizontal projection with no horizontal jitter.
   *   - small → tight horizontal cone.
   *   - large → wide horizontal fan. */
  randomSpreadSpeedHorizontal: number;
  /** Vertical random-spread magnitude (Z axis). Independently controls
   *  how much each fragment's launch angle deviates UP/DOWN from the
   *  bounce direction. A small value keeps fragments hugging the
   *  reflected vector vertically; a large value makes some go nearly
   *  straight up while others stay near the surface. */
  randomSpreadSpeedVertical: number;
  /** Multiplier applied to the parent's reflected velocity before it
   *  becomes the submunition's base direction. Models energy loss on
   *  impact (a coefficient-of-restitution-like knob).
   *
   *  - 1.0 = perfectly elastic bounce; carrier's full speed is
   *    preserved in the reflected direction
   *  - 0.5 = half the speed is preserved; the bounce reads softer
   *  - 0.0 = parent velocity is fully absorbed by the surface; the
   *    submunitions only have the random-spread perturbations, no
   *    inherited momentum (no visible bounce)
   *
   *  Defaults to 1.0 when omitted. */
  reflectedVelocityDamper?: number;
};

export type ProjectileShotBlueprint = {
  type: 'projectile';
  id: string;
  mass: number;
  collision: ShotCollision;
  /** Optional. Omit for "pure carrier" shots (e.g. a cluster mortar
   *  that does no damage of its own and only releases submunitions
   *  on detonation). When omitted, the projectile still detonates on
   *  hit / on expiry but applies no splash damage. */
  explosion?: {
    primary: ShotExplosionZone;
    secondary: ShotExplosionZone;
  };
  /** When true, the projectile runs its detonation logic at the end
   *  of `lifespan` (lifespan timer hits zero without a direct hit) —
   *  splash damage if `explosion` is set, submunitions if
   *  `submunitions` is set, both if both, and detonation audio either
   *  way. When false, the projectile silently disappears at expiry. */
  detonateOnExpiry: boolean;
  lifespan?: number;
  hitSound?: SoundEntry;
  /** Cluster behavior — see {@link SubmunitionSpec}. */
  submunitions?: SubmunitionSpec;
  /** When true, gravity is NOT applied to this projectile's vertical
   *  velocity each tick. Use for rockets / missiles / railgun slugs
   *  that travel by thrust rather than ballistic arc. Orthogonal to
   *  homing — a gravity-less projectile without homing flies in a
   *  perfectly straight line until it hits something. */
  ignoresGravity?: boolean;
  /** Cosmetic — declares this projectile leaves a fading smoke trail
   *  in the 3D renderer. Presence of this field turns the trail on;
   *  every individual property has an engine-wide default so authors
   *  can pass `{}` to use the defaults verbatim. Sim-side: no effect. */
  smokeTrail?: SmokeTrailSpec;
  /** Cosmetic 3D-client mesh shape for the projectile body.
   *  - 'sphere' (default): an isotropic ball, used for shells / orbs.
   *  - 'cylinder': a long pill aligned with the flight direction. Use
   *    for rockets / missiles so they read as oriented thrust-powered
   *    bodies rather than blobs. */
  shape?: 'sphere' | 'cylinder';
  /** When `shape === 'cylinder'`, controls the rendered pill's size
   *  relative to the projectile's collision radius. Both fields are
   *  multiples of `collision.radius`. Engine defaults: length=4,
   *  diameter=0.5. Has no effect when shape is sphere. */
  cylinderShape?: CylinderShapeSpec;
};

/** Per-shot rocket-cylinder dimensions. Both values are multiples of
 *  the projectile's `collision.radius`. */
export type CylinderShapeSpec = {
  /** World-space length of the rendered pill = collision.radius × this. */
  lengthMult?: number;
  /** World-space diameter of the rendered pill = collision.radius × this. */
  diameterMult?: number;
};

/** Per-shot smoke-trail tunables. Every field is optional; the
 *  3D renderer fills in engine-wide defaults for anything omitted. */
export type SmokeTrailSpec = {
  /** Milliseconds between consecutive puff spawns at max LOD.
   *  Default: 30 (~33 puffs/sec). Higher LOD → faster emission. */
  emitIntervalMs?: number;
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

export type BeamShotBlueprint = {
  type: 'beam';
  id: string;
  dps: number;
  force: number;
  recoil: number;
  radius: number;
  width: number;
  hitSound?: SoundEntry;
};

export type LaserShotBlueprint = {
  type: 'laser';
  id: string;
  dps: number;
  force: number;
  recoil: number;
  radius: number;
  width: number;
  duration: number;
  hitSound?: SoundEntry;
};

export type ShotBlueprint = ProjectileShotBlueprint | BeamShotBlueprint | LaserShotBlueprint;

/** A reflective mirror panel mount on a turret. The panel itself is a
 *  PERFECT SQUARE flat plane — its side length is derived from the
 *  unit's vertical span (topY - baseY, populated at entity-creation
 *  time from the renderer body height + mirror panel column geometry).
 *  The blueprint specifies only WHERE the panel sits (offset relative
 *  to the turret) and WHICH WAY it points (angle relative to turret
 *  forward); the size is regularized so sim collision and 3D mesh
 *  always agree on a single canonical rectangle. */
export type MirrorPanel = {
  offsetX: number;  // forward offset from unit center (turret-local)
  offsetY: number;  // lateral offset (positive = left, turret-local)
  angle: number;    // rotation of the panel normal relative to turret forward (radians)
};

export type TurretBlueprint = {
  id: string;
  projectileId?: string;
  range: number;
  cooldown?: number;
  color: number;
  turretTurnAccel: number;
  turretDrag: number;
  barrel: BarrelShape;
  rangeMultiplierOverrides: TurretRangeOverrides;
  homingTurnRate?: number;
  launchForce?: number;
  isManualFire?: boolean;
  passive?: boolean;
  spread?: { angle?: number; pelletCount?: number };
  burst?: { count?: number; delay?: number };
  forceField?: {
    angle?: number;
    transitionTime?: number;
    push?: ForceFieldZoneRatioConfig;
    pull?: ForceFieldZoneRatioConfig;
  };
  mirrorPanels?: MirrorPanel[];
  audio?: { fireSound?: SoundEntry; laserSound?: SoundEntry };
  /** World-space radius of the spherical turret-head visual. Overrides
   *  the auto-computed default (max(unitScale × TURRET_HEAD_FOOTPRINT_FRAC,
   *  TURRET_HEIGHT/2)). Use this when a specific turret needs a chunkier
   *  or daintier head than the unit's render size would imply — e.g. a
   *  light AA turret on a heavy chassis, or a hulking rocket pod on a
   *  small frame. Cosmetic only: shot spawn position uses barrelLength
   *  × unitScale and is independent of the head radius. */
  bodyRadius?: number;
  /** Ballistic arc preference for the aim solver. Two solutions exist
   *  for any in-range target under gravity — a low flat arc and a
   *  high lofted arc. Default (omitted / false) picks the low arc
   *  for fast line-of-sight shots. `true` picks the high arc so
   *  mortars lob their rounds over terrain / walls. Irrelevant for
   *  beams and lasers (instantaneous, direct-aim). */
  highArc?: boolean;
  /** Vertical launch system. When true, the turret ignores the normal
   *  yaw+pitch aim math and stays pointed straight up (pitch = π/2).
   *  Each fired projectile launches upward with a random cone
   *  deviation (`spread.angle` governs how far off vertical) — a
   *  homing-guided rocket is expected to take over from there. Pairs
   *  with the rocket-class shot flag `ignoresGravity`. */
  verticalLauncher?: boolean;
  /** Aim short of the target so the round lands on the ground at
   *  this fraction of the weapon→target distance, and let the
   *  submunition bounce/spread carry the rest. The aim point is
   *  computed as
   *
   *      aim = weapon + groundAimFraction × (target − weapon)
   *      aim.z = 0
   *
   *  `0.667` means "land 2/3 of the way to the target"; the
   *  fragment cluster's reflected velocity pushes the lightShots
   *  the remaining third. Omit / set to undefined for the normal
   *  "aim AT the target" behaviour. Only meaningful for
   *  ballistic projectile turrets — beams / lasers / vertical
   *  launchers ignore it. */
  groundAimFraction?: number;
};

export type TurretMount = {
  turretId: string;
  offsetX: number;
  offsetY: number;
};

export type WheelConfig = {
  wheelDistX: number;
  wheelDistY: number;
  treadLength: number;
  treadWidth: number;
  wheelRadius: number;
  rotationSpeed: number;
};

export type TreadConfig = {
  treadOffset: number;
  treadLength: number;
  treadWidth: number;
  wheelRadius: number;
  rotationSpeed: number;
};

export type LegConfig = {
  upperThickness: number;
  lowerThickness: number;
  hipRadius: number;
  kneeRadius: number;
  footRadius: number;
  lerpDuration: number;
};

export type LegStyle = 'widow' | 'daddy' | 'tarantula' | 'tick' | 'commander';

export type LocomotionBlueprint =
  | { type: 'wheels'; config: WheelConfig }
  | { type: 'treads'; config: TreadConfig }
  | { type: 'legs'; style: LegStyle; config: LegConfig };

export type UnitBlueprint = {
  id: string;
  name: string;
  shortName: string;
  hp: number;
  moveSpeed: number;
  unitRadiusCollider: { scale: number; shot: number; push: number };
  mass: number;
  energyCost: number;
  manaCost: number;
  turrets: TurretMount[];
  chassisMounts: MountPoint[];
  locomotion: LocomotionBlueprint;
  renderer: string;
  builder?: { buildRange: number; maxEnergyUseRate: number };
  dgun?: { turretId: string; energyCost: number };
  deathSound?: SoundEntry;
  seeRange?: number;
  fightStopEngagedRatio: number;
};
