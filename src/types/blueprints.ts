// Blueprint types extracted from game/sim/blueprints/types.ts

import type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
} from './config';
import type { SoundEntry } from './audio';
import type { ShotId, TurretId, UnitTypeId } from './blueprintIds';
import type { TurretRangeOverrides, ResourceCost } from './sim';
import { isLineShotType } from './sim';

// Re-export for consumers
export type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
};

export type ForceFieldBarrierRatioConfig = {
  outerRatio?: number;       // percentage of range (ignored if rimWidth set)
  rimWidth?: number;         // fixed world-space outer radius
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

/** Splash AoE for a projectile. SINGLE radius — damage and force are
 *  applied as a boolean overlap test: a unit's shot collider whose
 *  sphere intersects this radius takes the FULL `damage` and FULL
 *  `force` (no distance falloff). Outside the sphere, nothing.
 *  Reduce `radius` if a shot is feeling overly generous. */
export type ShotExplosion = {
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
  shotId: ShotId;
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

export type ProjectileShotKind = 'projectile' | 'rocket';

export type ProjectileShotBlueprint = {
  type: ProjectileShotKind;
  id: ShotId;
  mass: number;
  collision: ShotCollision;
  /** Optional. Omit for "pure carrier" shots that do no damage of
   *  their own and only release submunitions on detonation. When omitted,
   *  the projectile still detonates on
   *  hit / on expiry but applies no splash damage. Single radius —
   *  damage + force are applied boolean (sphere-vs-sphere intersect). */
  explosion?: ShotExplosion;
  /** When true, the projectile runs its detonation logic at the end
   *  of `lifespan` (lifespan timer hits zero without a direct hit) —
   *  splash damage if `explosion` is set, submunitions if
   *  `submunitions` is set, both if both, and detonation audio either
   *  way. When false, the projectile silently disappears at expiry. */
  detonateOnExpiry: boolean;
  lifespan?: number;
  /** Fractional per-instance lifespan variance. `0.1` means each
   *  projectile rolls a max lifespan in the range ±10% around
   *  `lifespan` when it is created. */
  lifespanVariance?: number;
  hitSound?: SoundEntry;
  /** Cluster behavior — see {@link SubmunitionSpec}. */
  submunitions?: SubmunitionSpec;
  /** When true, gravity is NOT applied to this projectile's vertical
   *  velocity each tick. Rocket shot blueprints normally set this so
   *  they travel by thrust rather than ballistic arc. Orthogonal to
   *  homing — a gravity-less projectile without homing flies in a
   *  perfectly straight line until it hits something. */
  ignoresGravity?: boolean;
  /** Maximum yaw rate (radians / sec) the projectile applies while
   *  steering toward an acquired target. Property of the ROCKET, not
   *  the turret — different turrets that fire the same rocket
   *  produce projectiles that turn at the same rate. Omit / 0 = no
   *  homing (the projectile flies straight; pairs with `ignoresGravity`
   *  for railgun-style shots). When set, the firing turret hands the
   *  rocket its current target at spawn time and the rocket bends its
   *  velocity toward that target each tick at this rate. */
  homingTurnRate?: number;
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
  /** Render frames to skip between puff spawns for this shot at the
   *  highest-quality cadence. The active PLAYER CLIENT LOD can only
   *  increase this skip count; it never emits more often than the shot
   *  blueprint allows. Default: 0 (sample every render frame at MAX). */
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

export type BeamShotBlueprint = {
  type: 'beam';
  id: ShotId;
  dps: number;
  force: number;
  recoil: number;
  /** Thin beam body radius used for obstruction/path tracing. */
  radius: number;
  width: number;
  /** Endpoint damage sphere radius. The line chooses where the beam
   *  terminates; this sphere determines damage at that endpoint. */
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
  /** Endpoint damage sphere radius. The line chooses where the laser
   *  terminates; this sphere determines damage at that endpoint. */
  damageSphere: { radius: number };
  duration: number;
  hitSound?: SoundEntry;
};

export type BuildSprayShotBlueprint = {
  type: 'buildSpray';
  id: ShotId;
  /** Max time-of-flight per particle, in ms. */
  lifespan: number;
  /** Particle launch speed (world units per second). */
  speed: number;
  /** Cosmetic — sphere radius for the rendered particle. */
  visualRadius: number;
  /** Build-spray particles don't hit anything; the field is here for
   *  shape uniformity with the other shot blueprints so callers can
   *  read `.hitSound` without narrowing the union first. */
  hitSound?: SoundEntry;
};

export type ShotBlueprint =
  | ProjectileShotBlueprint
  | BeamShotBlueprint
  | LaserShotBlueprint
  | BuildSprayShotBlueprint;
export type LineShotBlueprint = BeamShotBlueprint | LaserShotBlueprint;

/** Blueprint-side counterpart of `isLineShot` from types/sim.ts. Both
 *  predicates share the same underlying type list (`LINE_SHOT_TYPES`)
 *  so adding a new line-shot variety only changes one place. */
export function isLineShotBlueprint(sb: ShotBlueprint): sb is LineShotBlueprint {
  return isLineShotType(sb.type);
}

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

export type TurretRadiusConfig = {
  /** World-space radius of this turret's spherical body. The unit
   *  blueprint owns the 3D mount point; this radius only controls the
   *  body sphere drawn around that point and the barrel geometry
   *  authored relative to that sphere. */
  body: number;
};

export type ConstructionEmitterSize = 'small' | 'large';

export type ConstructionEmitterVisualSpec = {
  defaultSize: ConstructionEmitterSize;
  sizes: Record<ConstructionEmitterSize, {
    towerSize: ConstructionEmitterSize;
    pylonHeight: number;
    pylonOffset: number;
    innerPylonRadius: number;
    showerRadius: number;
  }>;
};

export type TurretBlueprint = {
  id: TurretId;
  projectileId?: ShotId;
  range: number;
  cooldown?: number;
  color: number;
  turretTurnAccel: number;
  turretDrag: number;
  barrel: BarrelShape;
  rangeMultiplierOverrides: TurretRangeOverrides;
  /** Smooth this turret's projectile spawn events across snapshot intervals. */
  eventsSmooth: boolean;
  launchForce?: number;
  isManualFire?: boolean;
  passive?: boolean;
  /** How runtime resolves the turret's world-space body center. The
   *  default authored mode uses the host blueprint mount. Unit-body-
   *  center mode is for turrets whose gameplay body is exactly the
   *  owning unit's target center, e.g. Loris mirrors. */
  mountMode?: 'authored' | 'unitBodyCenter';
  spread?: { angle?: number; pelletCount?: number };
  burst?: { count?: number; delay?: number };
  forceField?: {
    angle?: number;
    transitionTime?: number;
    barrier?: ForceFieldBarrierRatioConfig;
  };
  mirrorPanels?: MirrorPanel[];
  audio?: { fireSound?: SoundEntry };
  radius: TurretRadiusConfig;
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
  /** Spawn pitch in radians, applied once when the turret instance is
   *  created (createTurretsFromDefinition). Default 0 = barrel
   *  horizontal. Useful for passive / mirror turrets that should rest
   *  pointed at the sky until they actually acquire a target — once
   *  the aim solver runs, this initial value is overwritten by the
   *  per-tick solution and the damper takes over. Pitch is clamped
   *  to [-π/2, +π/2] by turretSystem; pass π/2 for "straight up". */
  idlePitch?: number;
  /** Aim short of the target so the round lands on the ground at
   *  this fraction of the weapon→target distance, and let the
   *  submunition bounce/spread carry the rest. The aim point is
   *  computed as
   *
   *      aim = weapon + groundAimFraction × (target − weapon)
   *      aim.z = 0
   *
   *  `0.667` means "land 2/3 of the way to the target"; the child
   *  submunitions' reflected velocity carries the burst the remaining
   *  third. Omit / set to undefined for the normal
   *  "aim AT the target" behaviour. Only meaningful for
   *  ballistic projectile turrets — beams / lasers / vertical
   *  launchers ignore it. */
  groundAimFraction?: number;
  /** Visual-only construction hardware. These turret blueprints still
   *  mount through normal unit/building hardpoints, but combat systems
   *  ignore them and the renderer builds the shared construction
   *  emitter instead of weapon barrels. */
  constructionEmitter?: ConstructionEmitterVisualSpec;
};

/** Chassis-local 3D mount offset, authored in body-radius fractions.
 *  x = forward, y = lateral/left, z = height above terrain. The z
 *  component is the weapon pivot / turret-head center, used by both
 *  authoritative firing math and 3D rendering. Wrap with `TurretMount`
 *  when pairing the offset with a turret-id. */
export type MountOffset = {
  x: number;
  y: number;
  z: number;
};

export type TurretMount = {
  turretId: TurretId;
  mount: MountOffset;
  /** Optional visual variant for turret blueprints that expose
   *  variant-specific art, such as construction emitters. */
  visualVariant?: ConstructionEmitterSize;
};

/** Building hardpoint. Coordinates are world units relative to the
 *  building footprint center/base:
 *    x = forward, y = lateral/left, z = turret-head center above base.
 *  This mirrors unit TurretMount semantics after unit mounts have been
 *  multiplied by unit radius. */
export type BuildingTurretMount = {
  turretId: TurretId;
  mount: MountOffset;
  visualVariant?: ConstructionEmitterSize;
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
  lerpDuration: number;
  /** Left-side authored leg geometry in body-radius fractions. Runtime
   *  code mirrors this list to the right side so units define their
   *  actual attach pattern here rather than by renderer-owned style id. */
  leftSide: LegLayoutEntry[];
};

export type LegLayoutEntry = {
  attachOffsetXFrac: number;
  attachOffsetYFrac: number;
  upperLegLengthFrac: number;
  lowerLegLengthFrac: number;
  snapTriggerAngle: number;
  snapTargetAngle: number;
  snapDistanceMultiplier: number;
  extensionThreshold: number;
};

export type LocomotionPhysics = {
  /** Authored propulsion force scalar. The server turns this into a
   *  slope-aware force with unit mass, terrain normal, gravity, water
   *  blocking, and any external force accumulators. This replaces the
   *  old top-level Unit.moveSpeed value, which was already used as
   *  thrust rather than as a hard speed cap. */
  driveForce: number;
  /** Ground traction coefficient: how much of the drive force can
   *  couple into the terrain contact patch. This is NOT damping or
   *  air resistance. Wheels have low traction, treads middle, legs
   *  high. */
  traction: number;
};

export type LocomotionBlueprint =
  | { type: 'wheels'; physics: LocomotionPhysics; config: WheelConfig }
  | { type: 'treads'; physics: LocomotionPhysics; config: TreadConfig }
  | { type: 'legs'; physics: LocomotionPhysics; config: LegConfig };

export type UnitBodyShapePart =
  | {
      kind: 'circle';
      offsetForward: number;
      offsetLateral?: number;
      radiusFrac: number;
      /** Vertical half-height. Defaults to radiusFrac for legacy spheres. */
      yFrac?: number;
    }
  | {
      kind: 'oval';
      offsetForward: number;
      offsetLateral?: number;
      /** Forward half-extent along the unit's +X axis. */
      xFrac: number;
      /** Vertical half-height. */
      yFrac: number;
      /** Lateral half-extent along the unit's side axis. */
      zFrac: number;
    };

export type UnitBodyShape =
  | { kind: 'polygon'; sides: number; radiusFrac: number; heightFrac: number; rotation: number }
  | { kind: 'rect'; lengthFrac: number; widthFrac: number; heightFrac: number }
  | { kind: 'circle'; radiusFrac: number; yFrac?: number }
  | { kind: 'oval'; xFrac: number; yFrac: number; zFrac: number }
  | { kind: 'composite'; parts: UnitBodyShapePart[] };

export type EntityHudBlueprint = {
  /** First bar sprite centerline offset above the computed visual HUD
   *  top, in world units. Names are derived from this bar anchor plus
   *  the global bar stack/name gap in entityHudConfig. */
  barsOffsetAboveTop: number;
};

export type UnitBlueprint = {
  id: UnitTypeId;
  name: string;
  shortName: string;
  hp: number;
  /** Unit radii in world units. `body` is the visible chassis/body
   *  authoring radius, `shot` is the projectile-vs-unit collider, and
   *  `push` is the unit-vs-unit physics/selection spacing radius. */
  radius: { body: number; shot: number; push: number };
  /** World-space height of the authored unit body center above terrain.
   *  Hard vertical contract for the unit: physics rest altitude,
   *  targeting center, low-LOD imposter center, chassis lift, turret
   *  mounts, and locomotion attachment must all resolve against this
   *  same terrain-up coordinate system. */
  bodyCenterHeight: number;
  mass: number;
  /** Per-resource build cost (authored). BUILDING/UNIT configs apply
   *  COST_MULTIPLIER on top. Each resource fills its own bar
   *  independently from the owner's stockpile. */
  cost: ResourceCost;
  turrets: TurretMount[];
  /** 3D chassis/body shape in unit-radius-1 space. */
  bodyShape: UnitBodyShape;
  /** Blueprint-authored 3D HUD placement for names and HP/build bars. */
  hud: EntityHudBlueprint;
  /** Hide the rendered chassis while keeping bodyShape for logical
   *  mount/leg/debris math. Used by units whose weapon turret is meant
   *  to visually replace the whole body. */
  hideChassis?: boolean;
  /** Optional absolute leg hip/attach height in radius.body fractions,
   *  measured from terrain in the same coordinate system as turret
   *  mount.z. Use only for units whose visible body is a turret or
   *  custom rig rather than the logical bodyShape segment. */
  legAttachHeightFrac?: number;
  locomotion: LocomotionBlueprint;
  builder?: { buildRange: number; constructionRate: number };
  dgun?: { turretId: TurretId; energyCost: number };
  deathSound?: SoundEntry;
  fightStopEngagedRatio: number;
};
