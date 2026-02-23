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
  outerRatio: number;
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
};

export type BeamShotBlueprint = {
  type: 'beam';
  id: string;
  dps: number;
  force: number;
  recoil?: number;
  radius: number;
  width: number;
  duration?: number;
  hitSound?: SoundEntry;
};

export type ShotBlueprint = ProjectileShotBlueprint | BeamShotBlueprint;

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
  spread?: { angle?: number; pelletCount?: number };
  burst?: { count?: number; delay?: number };
  forceField?: {
    angle?: number;
    transitionTime?: number;
    push?: ForceFieldZoneRatioConfig;
    pull?: ForceFieldZoneRatioConfig;
  };
  audio?: { fireSound?: SoundEntry; laserSound?: SoundEntry };
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
  thickness: number;
  footSize: number;
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
  unitDrawScale: number;
  unitRadiusColliderShot: number;
  unitRadiusColliderPush: number;
  mass: number;
  baseCost: number;
  turrets: TurretMount[];
  chassisMounts: MountPoint[];
  locomotion: LocomotionBlueprint;
  renderer: string;
  builder?: { buildRange: number; maxEnergyUseRate: number };
  dgun?: { turretId: string; energyCost: number };
  deathSound?: SoundEntry;
  seeRange?: number;
};
