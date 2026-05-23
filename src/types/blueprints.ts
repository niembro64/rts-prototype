// Blueprint types extracted from game/sim/blueprints/types.ts

import type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
} from './config';
import type { SoundEntry } from './audio';
import type { ShotId, TurretId, UnitTypeId } from './blueprintIds';
import type { TurretRangeOverrides } from './combatTypes';
import type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';
import type { ResourceCost } from './economyTypes';
import type { ForceFieldBarrierRatioConfig } from './shotTypes';
import type { UnitSuspensionConfig } from './locomotionTypes';

// Re-export for consumers
export type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
};

export type {
  BeamShotBlueprint,
  ForceFieldBarrierRatioConfig,
  LaserShotBlueprint,
  LineShotBlueprint,
  ProjectileShotBlueprint,
  ProjectileShotKind,
  ShotBlueprint,
  ShotCollision,
  ShotExplosion,
  SmokeTrailSpec,
  SubmunitionSpec,
} from './shotTypes';
export { isLineShotBlueprint } from './shotTypes';
export type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';

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

export type TurretAimAngleType =
  | 'rayDirect'
  | 'rayBisectTurretAndBody'
  | 'ballisticArcLow'
  | 'ballisticArcLowOnlyUnder'
  | 'ballisticArcHigh';
export type TurretAimLockOnType = 'lockOnToTurret' | 'lockOnToBody';
export type TurretAimStyle = {
  angleType: TurretAimAngleType;
  lockOnType: TurretAimLockOnType;
};

/** Turret lock-on policy is broad by default: with no exclusions, a
 *  turret may lock onto any living, observable building, unit, or
 *  turret regardless of ownership. The exclusion sets below subtract
 *  candidates from that broad default. They are evaluated in order
 *  (relationship → entity family → level-1 named exclusions) before
 *  range / LOS / scoring run. */
export type TurretLockOnRelationshipExclusion =
  | 'friendly_entities'
  | 'enemy_entities';
export const TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS: readonly TurretLockOnRelationshipExclusion[] =
  ['friendly_entities', 'enemy_entities'];

export type TurretLockOnEntityFamilyExclusion = 'buildings' | 'units' | 'turrets';
export const TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS: readonly TurretLockOnEntityFamilyExclusion[] =
  ['buildings', 'units', 'turrets'];

export type TurretBlueprint = {
  id: TurretId;
  projectileId: ShotId | null;
  range: number;
  cooldown: number;
  color: number;
  turretTurnAccel: number;
  turretDrag: number;
  barrel: BarrelShape;
  rangeMultiplierOverrides: TurretRangeOverrides;
  /** Smooth this turret's projectile spawn events across snapshot intervals. */
  eventsSmooth: boolean;
  launchForce: number;
  isManualFire: boolean;
  passive: boolean;
  /** Actual terrain/entity line-of-sight gate. Force-field sight
   *  obstruction is configured separately at the battle level. */
  requiresNonObstructedLineOfSight: boolean;
  spread: { angle: number; pelletCount: number } | null;
  burst: { count: number; delay: number } | null;
  forceField: {
    angle: number;
    transitionTime: number;
    barrier: ForceFieldBarrierRatioConfig | null;
  } | null;
  mirrorPanels: MirrorPanel[];
  audio: { fireSound: SoundEntry } | null;
  radius: TurretRadiusConfig;
  /** Beam/rocket turrets with no visible barrel: only the head sphere
   *  renders. The head shows the unit color when idle/tracking and
   *  shifts halfway toward white when the turret locks on. Because
   *  there's no barrel to orient, plain head-only turrets skip per-tick
   *  yaw/pitch pose and rotation/pitch/velocity snapshots — these
   *  turrets never dirty an entity due to aim motion, only on
   *  target/state transitions. Mirror-panel hosts are the exception
   *  because the panel slab uses the hidden passive turret pose. The
   *  sim still tracks rotation/pitch internally to produce the correct
   *  fire direction. */
  headOnly: boolean;
  /** Explicit aiming solver mode:
   *  - angleType: rayDirect for straight-line aim,
   *    rayBisectTurretAndBody for mirror normals, ballisticArcLow for
   *    lower gravity solutions, ballisticArcLowOnlyUnder for low-arc
   *    drops whose lock-on point must be below the turret mount,
   *    ballisticArcHigh for lofted gravity solutions
   *  - lockOnType: lock onto the target's body/collider or a target turret mount */
  aimStyle: TurretAimStyle;
  /** Vertical launch system. When true, the turret ignores the normal
   *  yaw+pitch aim math and stays pointed straight up (pitch = π/2).
   *  Each fired projectile launches upward with a random cone
   *  deviation (`spread.angle` governs how far off vertical) — a
   *  homing-guided rocket is expected to take over from there. */
  verticalLauncher: boolean;
  /** Spawn pitch in radians, applied once when the turret instance is
   *  created (createUnitRuntimeTurrets/createBuildingRuntimeTurrets).
   *  Default 0 = barrel
   *  horizontal. Useful for passive / mirror turrets that should rest
   *  pointed at the sky until they actually acquire a target — once
   *  the aim solver runs, this initial value is overwritten by the
   *  per-tick solution and the damper takes over. Pitch is clamped
   *  to [-π/2, +π/2] by turretSystem; pass π/2 for "straight up". */
  idlePitch: number;
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
  groundAimFraction: number | null;
  /** Visual-only construction hardware. These turret blueprints still
   *  mount through normal unit/building hardpoints, but combat systems
   *  ignore them and the renderer builds the shared construction
   *  emitter instead of weapon barrels. */
  constructionEmitter: ConstructionEmitterVisualSpec | null;
  /** Lock-on policy: by default a turret can lock onto any friendly or
   *  enemy building, unit, or turret. These five exclusion sets
   *  subtract candidates from that broad default. Empty arrays mean no
   *  exclusion. Evaluated in order: relationship → entity family →
   *  level-1 named exclusions, all before range / LOS / scoring. */
  excludeLockOnLevel0FriendsAndEnemies: TurretLockOnRelationshipExclusion[];
  excludeLockOnLevel0Entities: TurretLockOnEntityFamilyExclusion[];
  /** Level-1 exclusions reference concrete blueprint ids. Each array is
   *  validated against the corresponding blueprint id set at startup;
   *  unknown ids fail validation rather than silently dropping. */
  excludeLockOnLevel1Buildings: string[];
  excludeLockOnLevel1Units: string[];
  excludeLockOnLevel1Turrets: string[];
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

export type UnitTurretMountZResolver = {
  /** Resolve the final pivot height after turret blueprints are loaded:
   *  body-top fraction + turret body radius / unit body radius. */
  kind: 'topMounted';
  bodyTopZFrac: number;
};

export type TurretMount = {
  turretId: TurretId;
  mount: MountOffset;
  /** Unit-blueprint authoring hint. The blueprint builder resolves this
   *  into mount.z once both unit and turret blueprints are available. */
  zResolver?: UnitTurretMountZResolver;
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
  /** Maximum traversable terrain slope in degrees from horizontal.
   *  A* treats steeper cells as blocked for this locomotion profile. */
  maxSlopeDeg: number;
};

/** Hover locomotion (drones, gunships) — no ground contact. The
 *  hoverHeight specifies the target altitude above the terrain
 *  directly under the unit; fan fields drive the visible ducted
 *  rotors that push smoke downward and slightly outward. */
export type HoverConfig = {
  hoverHeight: number;
  /** Per-tick randomization of `hoverHeight` as a fraction of itself.
   *  e.g. 0.1 → each tick samples a hover target in
   *  [hoverHeight * 0.9, hoverHeight * 1.1] for the lift force. Omit
   *  or 0 for a perfectly steady hover. */
  hoverHeightRandomizationAmount?: number;
  /** EMA smoothing weight applied to the per-tick (jittered) hoverHeight
   *  before it feeds the lift force. In [0, 1):
   *    smoothed = α · smoothed_prev + (1 − α) · raw
   *  0 (or omitted) = use the raw jittered sample directly; values close
   *  to 1 produce a slow drift that hides high-frequency noise from
   *  `hoverHeightRandomizationAmount`. */
  hoverHeightEMA?: number;
  fanDistX: number;
  fanDistY: number;
  /** Visual fan placement. Omit for the legacy four-corner quad. */
  fanLayout?: 'quad' | 'triFront';
  fanRadius: number;
  fanRingTubeRadius: number;
  /** Degrees each duct tilts away from the unit center. The exhaust
   *  smoke uses the same local axis so the plume matches the fan. */
  fanOutwardAngleDeg?: number;
  /** Rotor spin rate in radians per second. Positive value; direction
   *  is fixed (counter-clockwise viewed from above). */
  fanSpinRadPerSec?: number;
  /** Optional small "dragonfly tail" fan. Setting `tailFanOffsetX`
   *  switches the main fan layout from the 4-corner quad to a pair of
   *  lateral "wing" fans at (x=0, z=±fanDistY×unitRadius). When
   *  `tailFanRadius` is also set (> 0), an additional small fan is
   *  rendered at (x=tailFanOffsetX×unitRadius, z=0); omit
   *  `tailFanRadius` to keep the wing-fan layout without a tail fan.
   *  `tailFanRadius` / `tailFanRingTubeRadius` are unit-radius fractions
   *  matching the existing fan size convention. */
  tailFanOffsetX?: number;
  tailFanRadius?: number;
  tailFanRingTubeRadius?: number;
  /** Tilt the tail fan backward (degrees). 0 = straight down, 90 = fully
   *  rearward. Analogous to `fanOutwardAngleDeg`, except the tilt is
   *  along the unit's −X axis (the tail), not radially outward. */
  tailFanBackAngleDeg?: number;
};

/** Flying locomotion uses hover-style altitude physics, but the unit
 *  continuously drives forward and renders wings plus rear jet exhaust
 *  instead of downward hover fans. Dimensions are in unit-radius fractions. */
export type FlyingConfig = {
  hoverHeight: number;
  /** Same semantics as `HoverConfig.hoverHeightRandomizationAmount`. */
  hoverHeightRandomizationAmount?: number;
  /** Same semantics as `HoverConfig.hoverHeightEMA`. */
  hoverHeightEMA?: number;
  /** Allows a flying profile to suppress the primary/front wing pair
   *  while keeping its rear wing pair and jets. Defaults to true. */
  wingEnabled?: boolean;
  wingSpan: number;
  wingChord: number;
  wingOffsetX: number;
  wingHeight: number;
  wingThickness?: number;
  wingDihedralDeg?: number;
  /** Planform sweep as a chord fraction. Positive values sweep primary
   *  wing tips backward; with `tailWingMirrorX`, larger values make the
   *  tail wing tips project farther forward. */
  wingSweepFrac?: number;
  tailWingSpan?: number;
  tailWingChord?: number;
  tailWingOffsetX?: number;
  tailWingHeight?: number;
  tailWingThickness?: number;
  tailWingDihedralDeg?: number;
  /** Tail-specific planform sweep. See `wingSweepFrac`. */
  tailWingSweepFrac?: number;
  /** Flip the tail-wing geometry along the unit's forward axis so the
   *  rear pair reads as a mirror image of the front wings (root toward
   *  the tail, tip swept forward) instead of repeating the same
   *  backward sweep. */
  tailWingMirrorX?: boolean;
  jetOffsetX: number;
  jetOffsetY: number;
  jetOffsetZ: number;
  jetRadius: number;
  jetLength: number;
  jetCount?: 1 | 2;
};

export type LocomotionBlueprint =
  | { type: 'wheels'; physics: LocomotionPhysics; config: WheelConfig }
  | { type: 'treads'; physics: LocomotionPhysics; config: TreadConfig }
  | { type: 'legs'; physics: LocomotionPhysics; config: LegConfig }
  | { type: 'hover'; physics: LocomotionPhysics; config: HoverConfig }
  | { type: 'flying'; physics: LocomotionPhysics; config: FlyingConfig };

export type UnitBodyShapePart =
  | {
      kind: 'circle';
      offsetForward: number;
      offsetLateral?: number;
      radiusFrac: number;
      /** Vertical half-height. Defaults to radiusFrac for legacy spheres. */
      yFrac?: number;
      /** Optional sphere center height. Defaults to the half-height
       *  (`yFrac` / `radiusFrac`) so legacy spheres sit with their
       *  bottom on the body baseline. Set to 0 to center the sphere
       *  on the roll axis. */
      centerYFrac?: number;
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
    }
  | {
      kind: 'cylinder';
      offsetForward: number;
      offsetLateral?: number;
      /** Full cylinder length along the unit's +X axis. */
      lengthFrac: number;
      /** Circular cross-section radius. */
      radiusFrac: number;
      /** Optional cylinder center height. Defaults to radiusFrac so the
       *  part sits on the body baseline. */
      centerYFrac?: number;
      /** Optional pitch in radians applied around the unit's lateral
       *  (Z) axis. Positive tilts the cylinder's +X (forward) end up.
       *  Defaults to 0. */
      pitchRad?: number;
    }
  | {
      /** Like cylinder, but the rearward (−X) end is a point and the
       *  forward (+X) end is the wider base. Used for tail tapers. */
      kind: 'cone';
      offsetForward: number;
      offsetLateral?: number;
      /** Full cone length along the unit's +X axis. */
      lengthFrac: number;
      /** Base radius (the wider, non-pointy end at +X). */
      radiusFrac: number;
      /** Optional center height; defaults to radiusFrac. */
      centerYFrac?: number;
    };

export type UnitBodyShape =
  | { kind: 'polygon'; sides: number; radiusFrac: number; heightFrac: number; rotation: number }
  | { kind: 'rect'; lengthFrac: number; widthFrac: number; heightFrac: number }
  | { kind: 'rhombus'; lengthFrac: number; widthFrac: number; heightFrac: number }
  | { kind: 'circle'; radiusFrac: number; yFrac?: number }
  | { kind: 'oval'; xFrac: number; yFrac: number; zFrac: number }
  | { kind: 'composite'; parts: UnitBodyShapePart[] };

export type EntityHudBlueprint = {
  /** First bar sprite centerline offset above the computed visual HUD
   *  top, in world units. Names are derived from this bar anchor plus
   *  the global bar stack/name gap in entityHudConfig. */
  barsOffsetAboveTop: number;
};

export type CloakBlueprint = {
  enabled: boolean;
};

export type DetectorBlueprint = {
  radius: number;
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
   *  COST_MULTIPLIER on top. Each construction resource fills its own bar
   *  independently from the owner's stockpile. */
  cost: ResourceCost;
  turrets: TurretMount[];
  /** 3D chassis/body shape in unit-radius-1 space. */
  bodyShape: UnitBodyShape;
  /** Blueprint-authored 3D HUD placement for names and HP/build bars. */
  hud: EntityHudBlueprint;
  /** Optional absolute leg hip/attach height in radius.body fractions,
   *  measured from terrain in the same coordinate system as turret
   *  mount.z. Use only when the default segment midpoint is not the
   *  desired attachment height. */
  legAttachHeightFrac: number | null;
  /** Authored locomotion blueprint id. Kept alongside the resolved
   *  locomotion object so renderer-side use-specific config can key by
   *  locomotion profile without re-reading unit JSON. */
  locomotionId: string;
  locomotion: LocomotionBlueprint;
  /** Optional chassis-vs-locomotion spring. When omitted the unit
   *  body stays rigidly attached to locomotion, matching legacy
   *  behavior. */
  suspension: UnitSuspensionConfig | null;
  builder: { buildRange: number; constructionRate: number } | null;
  dgun: { turretId: TurretId; energyCost: number } | null;
  cloak: CloakBlueprint | null;
  detector: DetectorBlueprint | null;
  deathSound: SoundEntry | null;
  /** Fraction of this unit's non-visual turrets that must be engaged
   *  before a 'fight' or 'patrol' action halts movement. `null` =
   *  never halt for combat — the unit marches through enemy fire,
   *  turrets engaging opportunistically (canonical RTS attack-move).
   *  A number means "stop when engagedCount >= turrets * ratio"; e.g.
   *  0.9 for single-turret = halt on first engagement, 0.5 for a
   *  6-turret unit = halt when at least 3 turrets are firing. Lets
   *  siege/heavy units brawl in place while skirmishers keep moving. */
  fightStopEngagedRatio: number | null;
};
