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
  damage: number;
};

export type ShotCollision = {
  radius: number;
  damage: number;
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
 * splash or `splashOnExpiry` timeout). Submunitions fly outward in
 * random directions within `angleSpread` radians (defaults to a full
 * 2π circle) at `speed` world-units/second.
 *
 * `lifespanMs` overrides the child shot's own blueprint lifespan for
 * just these spawned instances — lets you keep e.g. a standard lightShot
 * long enough to reach its targets normally, but give cluster-flak a
 * short, dramatic burst without a new blueprint entry.
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
  /** Launch speed for each child, world units / second. */
  speed: number;
  /** Optional per-spawn lifespan override (ms). Falls back to the child
   *  shot blueprint's own `lifespan` when omitted. */
  lifespanMs?: number;
  /** Total cone angle (radians). Omit for a full-circle fan. */
  angleSpread?: number;
  /** Optional collision-radius override. Affects both the 3D render
   *  sphere size and the swept-collision footprint — handy when the
   *  child shot's native radius is too small to read as a visible
   *  fragment (e.g. lightShot at 1.6 nearly disappears at default
   *  camera distance). Omit to use the child blueprint's own radius. */
  collisionRadius?: number;
};

export type ProjectileShotBlueprint = {
  type: 'projectile';
  id: string;
  mass: number;
  collision: ShotCollision;
  explosion: {
    primary: ShotExplosionZone;
    secondary: ShotExplosionZone;
  };
  splashOnExpiry: boolean;
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

export type MirrorPanel = {
  width: number;    // length of reflective edge
  height: number;   // panel thickness (rendering only)
  offsetX: number;  // forward offset from unit center (turret-local)
  offsetY: number;  // lateral offset (positive = left, turret-local)
  angle: number;    // rotation relative to turret forward (radians)
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
  /** Ballistic arc preference for the aim solver. Two solutions exist
   *  for any in-range target under gravity — a low flat arc and a
   *  high lofted arc. Default (omitted / false) picks the low arc
   *  for fast line-of-sight shots. `true` picks the high arc so
   *  mortars lob their rounds over terrain / walls. Irrelevant for
   *  beams and lasers (instantaneous, direct-aim). */
  highArc?: boolean;
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
