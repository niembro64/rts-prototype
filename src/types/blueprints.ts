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
  CylinderShapeSpec,
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
  /** Priority used by passive mirror turrets when choosing which
   *  line-shot weapon to face. Omit/0 means "not a mirror threat";
   *  line-shot turrets that omit this default to low priority in the
   *  blueprint build step. */
  mirrorReflectPriority?: number;
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
   *  created (createUnitRuntimeTurrets/createBuildingRuntimeTurrets).
   *  Default 0 = barrel
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
};
