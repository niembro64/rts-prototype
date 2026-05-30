// Blueprint types extracted from game/sim/blueprints/types.ts

import type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
} from './config';
import type { SoundEntry } from './audio';
import type { ShotBlueprintId, TurretBlueprintId, UnitBlueprintId } from './blueprintIds';
import type { TurretRangeOverrides } from './combatTypes';
import type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';
import type { ResourceCost } from './economyTypes';
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
  ForceFieldMaterialBlueprint,
  ForceFieldMaterialVisualConfig,
  ForceFieldShotBlueprint,
  ForceFieldSurfaceResponse,
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
export {
  FORCE_FIELD_SURFACE_RESPONSES,
  isForceFieldReflectionMode,
  isLineShotBlueprint,
} from './shotTypes';
export type { ConstructionEmitterSize, ConstructionEmitterVisualSpec } from './constructionTypes';

/** A reflective force-field panel mount on a turret. The panel itself is a
 *  PERFECT SQUARE flat plane — its side length is derived from the
 *  unit's vertical span (topY - baseY, populated at entity-creation
 *  time from the renderer body height + force-field panel column geometry).
 *  The blueprint specifies only WHERE the panel sits (offset relative
 *  to the turret) and WHICH WAY it points (angle relative to turret
 *  forward); the size is regularized so sim collision and 3D mesh
 *  always agree on a single canonical rectangle. */
export type ForceFieldPanel = {
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

/** Lock-on policy is broad by default: with no exclusions, a turret,
 *  unit host, or tower host may lock onto any living, observable
 *  building, tower, unit, or turret regardless of ownership. The
 *  exclusion sets below subtract candidates from that broad default.
 *  They are evaluated in order (relationship -> entity family ->
 *  level-1 named exclusions) before range / LOS / scoring run. */
export type TurretLockOnRelationshipExclusion =
  | 'friendly_entities'
  | 'enemy_entities';
export const TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS: readonly TurretLockOnRelationshipExclusion[] =
  ['friendly_entities', 'enemy_entities'];

export type TurretLockOnEntityFamilyExclusion =
  | 'buildings'
  | 'towers'
  | 'units'
  | 'turrets';
export const TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS: readonly TurretLockOnEntityFamilyExclusion[] =
  ['buildings', 'towers', 'units', 'turrets'];

export type LockOnExclusionObject = {
  excludeLockOnLevel0FriendsAndEnemies: TurretLockOnRelationshipExclusion[];
  excludeLockOnLevel0Entities: TurretLockOnEntityFamilyExclusion[];
  excludeLockOnLevel1Buildings: string[];
  excludeLockOnLevel1Towers: string[];
  excludeLockOnLevel1Units: string[];
  excludeLockOnLevel1Turrets: string[];
};

/** The role category a turret advertises. Host commands are routed by
 *  kind: an attack order lands on the host's primary attack turret, a
 *  build order on its primary construction turret, and so on. Per the
 *  "Host-directed turrets carry the host lock-on" rule, every host must
 *  carry exactly one `hostDirected` mount for each kind it mounts. */
export type WeaponKind = 'attack' | 'construction' | 'repair';
export const WEAPON_KINDS: readonly WeaponKind[] = ['attack', 'construction', 'repair'];

export type TurretBlueprint = {
  turretBlueprintId: TurretBlueprintId;
  /** Role category. See WeaponKind. Used by the blueprint loader to
   *  group a host's mounts and enforce exactly-one-host-directed-per-kind,
   *  and to route host commands (attack/build/repair) to the matching
   *  primary turret. */
  kind: WeaponKind;
  shotBlueprintId: ShotBlueprintId | null;
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
  /** Deprecated explicit absence field. Panel geometry is authored on
   *  TurretMount.forceFieldPanels; turret blueprints must keep this empty. */
  forceFieldPanels: ForceFieldPanel[];
  audio: { fireSound: SoundEntry } | null;
  radius: TurretRadiusConfig;
  /** Beam/rocket turrets with no visible barrel: only the head sphere
   *  renders. The head shows the unit color when idle/tracking and
   *  shifts halfway toward white when the turret locks on. Because
   *  there's no barrel to orient, plain head-only turrets skip per-tick
   *  yaw/pitch pose and rotation/pitch/velocity snapshots — these
   *  turrets never dirty an entity due to aim motion, only on
   *  target/state transitions. Beam/laser presentation travels through
   *  beam endpoint updates, not turret aim fields. The sim still tracks
   *  rotation/pitch internally to produce the correct fire direction.
   *  turretForceFieldPanel is NOT head-only — its authored barrel rotates
   *  to bisect targets through the normal aim path. */
  headOnly: boolean;
  /** Explicit aiming solver mode:
   *  - angleType: rayDirect for straight-line aim,
   *    rayBisectTurretAndBody for force-field-panel normals, ballisticArcLow for
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
   *  horizontal. Useful for passive / turretForceFieldPanels that should rest
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
  excludeLockOnLevel1Towers: string[];
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
  turretBlueprintId: TurretBlueprintId;
  mount: MountOffset;
  /** Shape geometry projected by this mount when the referenced turret emits
   *  a force-field panel shot. Materials live on the shot; these entries only
   *  describe panel placement relative to the mount. */
  forceFieldPanels?: ForceFieldPanel[];
  /** Host-directed vs fully-autonomous targeting policy for THIS mount.
   *  A host-directed turret inherits its host's lock-on (player/AI
   *  command target) when the host is locked on, applying its own
   *  exclusion/range/LOS gates on top; when the host has no lock it
   *  falls back to autonomous scanning. A fully-autonomous mount
   *  (`hostDirected: false`) ignores the host lock entirely. Fight-move
   *  and patrol halt logic counts only host-directed mounts. The
   *  blueprint loader enforces exactly one host-directed mount per
   *  turret kind the host carries so commands can land unambiguously. */
  hostDirected: boolean;
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
  turretBlueprintId: TurretBlueprintId;
  mount: MountOffset;
  /** Optional force-field panel geometry for tower-mounted panel emitters. */
  forceFieldPanels?: ForceFieldPanel[];
  /** Host-directed vs fully-autonomous targeting policy for THIS mount.
   *  See TurretMount.hostDirected — towers follow the same primary /
   *  secondary contract as units. */
  hostDirected: boolean;
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
   *  force with unit mass, terrain normal, gravity, water blocking,
   *  and any external force accumulators. This replaces the
   *  old top-level Unit.moveSpeed value, which was already used as
   *  thrust rather than as a hard speed cap. */
  driveForce: number;
  /** Ground traction coefficient: how much of the drive force can
   *  couple into the terrain contact patch. This is NOT damping or
   *  air resistance. Wheels have low traction, treads middle, legs
   *  high. */
  traction: number;
};

export type PathfindingTerrainMode = 'land' | 'anywhere';

export type PathfindingBlueprint = {
  pathfindingBlueprintId: string;
  /** `land` uses terrain/water/slope blocking; `anywhere` ignores
   *  terrain blocking while still respecting map bounds and buildings. */
  terrainMode: PathfindingTerrainMode;
  /** Maximum traversable terrain slope in degrees from horizontal.
   *  Required for `land`; null for `anywhere` because slope is ignored. */
  maxSlopeDeg: number | null;
};

type LocomotionBlueprintBase = {
  physics: LocomotionPhysics;
  /** Authored reference into pathfindingConfig.json. */
  pathfindingBlueprintId: string;
  /** Resolved pathfinding profile; filled by the blueprint loader. */
  pathfinding: PathfindingBlueprint;
};

/** Hover locomotion (drones, gunships) — no ground contact. Constant
 *  counter-gravity lift applies at any altitude, while ground-effect
 *  lift scales as 1 / distance to terrain. The stable altitude is:
 *    hoverHeightUpwardForce / (1 - gravityCounterUpwardForceRatio)
 *  Fan fields drive the visible ducted rotors that push smoke downward
 *  and slightly outward. */
export type HoverConfig = {
  /** Constant upward force as a ratio of gravity. Must be in [0, 1)
   *  for a finite terrain-following equilibrium. */
  gravityCounterUpwardForceRatio: number;
  /** Inverse-distance ground-effect lift coefficient, in world units.
   *  The force term is m·g·hoverHeightUpwardForce / distanceToGround. */
  hoverHeightUpwardForce: number;
  /** Per-tick randomization of `hoverHeightUpwardForce` as a fraction of
   *  itself. e.g. 0.1 → each tick samples a ground-effect coefficient in
   *  [hoverHeightUpwardForce * 0.9, hoverHeightUpwardForce * 1.1].
   *  Omit or 0 for a perfectly steady hover. */
  hoverHeightUpwardForceRandomizationAmount?: number;
  /** EMA smoothing weight applied to the per-tick (jittered)
   *  hoverHeightUpwardForce before it feeds the lift force. In [0, 1):
   *    smoothed = α · smoothed_prev + (1 − α) · raw
   *  0 (or omitted) = use the raw jittered sample directly; values close
   *  to 1 produce a slow drift that hides high-frequency noise from
   *  `hoverHeightUpwardForceRandomizationAmount`. */
  hoverHeightUpwardForceEMA?: number;
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
  /** Same semantics as `HoverConfig.gravityCounterUpwardForceRatio`. */
  gravityCounterUpwardForceRatio: number;
  /** Same semantics as `HoverConfig.hoverHeightUpwardForce`. */
  hoverHeightUpwardForce: number;
  /** Same semantics as `HoverConfig.hoverHeightUpwardForceRandomizationAmount`. */
  hoverHeightUpwardForceRandomizationAmount?: number;
  /** Same semantics as `HoverConfig.hoverHeightUpwardForceEMA`. */
  hoverHeightUpwardForceEMA?: number;
  /** Allows a flying profile to suppress the primary/front wing pair
   *  while keeping its rear wing pair and jets. Defaults to true. When
   *  false, the wing* dimension fields can be omitted. */
  wingEnabled?: boolean;
  wingSpan?: number;
  wingChord?: number;
  wingOffsetX?: number;
  wingHeight?: number;
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
  | (LocomotionBlueprintBase & { type: 'wheels'; config: WheelConfig })
  | (LocomotionBlueprintBase & { type: 'treads'; config: TreadConfig })
  | (LocomotionBlueprintBase & { type: 'legs'; config: LegConfig })
  | (LocomotionBlueprintBase & { type: 'hover'; config: HoverConfig })
  | (LocomotionBlueprintBase & { type: 'flying'; config: FlyingConfig });

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
   *  the global bar stack/name gap in config.ts. */
  barsOffsetAboveTop: number;
};

export type CloakBlueprint = {
  enabled: boolean;
};

export type DetectorBlueprint = {
  radius: number;
};

export type UnitBlueprint = LockOnExclusionObject & {
  unitBlueprintId: UnitBlueprintId;
  name: string;
  shortName: string;
  hp: number;
  /** Unit radii in world units. `body` is the visible chassis/body
   *  authoring radius, `shot` is the projectile-vs-unit collider, and
   *  `push` is the unit-vs-unit physics/selection spacing radius. */
  radius: { body: number; shot: number; push: number };
  /** World-space height of the authored unit body center above terrain.
   *  Hard vertical contract for the unit: physics rest altitude,
   *  targeting center, chassis lift, turret
   *  mounts, and locomotion attachment must all resolve against this
   *  same terrain-up coordinate system. */
  bodyCenterHeight: number;
  /** Authored full-sight sensor radius. This is deliberately separate
   *  from weapon, tracking, detector, radar, and builder action range. */
  fullVisionRadius: number;
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
  locomotionBlueprintId: string;
  locomotion: LocomotionBlueprint;
  /** Optional chassis-vs-locomotion spring. When omitted the unit
   *  body stays rigidly attached to locomotion, matching legacy
   *  behavior. */
  suspension: UnitSuspensionConfig | null;
  builder: { buildRange: number; constructionRate: number } | null;
  dgun: { turretBlueprintId: TurretBlueprintId; energyCost: number } | null;
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
