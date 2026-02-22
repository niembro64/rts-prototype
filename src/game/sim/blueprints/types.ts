/**
 * Blueprint Type Definitions
 *
 * Interfaces for the unified blueprint system.
 * Blueprints are static config only — factory functions read them to create entities.
 */

import type {
  TurretConfig,
  MountPoint,
  ForceFieldTurretConfig,
  SpinConfig,
} from '../../../config';
import type { SoundEntry } from '../../../audioConfig';

// Re-export types that consumers will need
export type {
  TurretConfig,
  MountPoint,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
};

import type { TurretRangeOverrides } from '../types';
export type { TurretRangeOverrides };

// ── Force field zone ratio config (ratios of weapon range) ──

export interface ForceFieldZoneRatioConfig {
  innerRatio: number;
  outerRatio: number;
  color: number;
  alpha: number;
  particleAlpha: number;
  power: number | null;
  damage: number;
}

// ── Projectile Blueprint ──

export interface ShotBlueprint {
  id: string;
  damage: number;
  primaryDamageRadius: number;
  secondaryDamageRadius: number;
  splashOnExpiry: boolean;
  piercing?: boolean;
  // Bullet projectiles
  mass?: number;
  radius?: number;
  lifespan?: number;
  // Beam projectiles
  beamDuration?: number;
  beamWidth?: number;
  collisionRadius?: number;
  // Audio
  hitSound?: SoundEntry;
}

// ── Weapon Blueprint ──

export interface TurretBlueprint {
  id: string;
  projectileId?: string; // references ProjectileBlueprint (absent for force fields)
  range: number;
  cooldown?: number; // omit for continuous weapons (defaults to 0)
  color: number;
  turretTurnAccel: number;
  turretDrag: number;
  turretShape: TurretConfig;
  rangeMultiplierOverrides: TurretRangeOverrides;
  // Optional firing modifiers
  spreadAngle?: number;
  burstCount?: number;
  burstDelay?: number;
  pelletCount?: number;
  homingTurnRate?: number;
  launchForce?: number;
  hitForce?: number;
  knockBackForce?: number;
  isManualFire?: boolean;
  // Force field
  isForceField?: boolean;
  forceFieldAngle?: number;
  forceFieldTransitionTime?: number;
  push?: ForceFieldZoneRatioConfig;
  pull?: ForceFieldZoneRatioConfig;
  // Audio
  fireSound?: SoundEntry;
  laserSound?: SoundEntry;
}

// ── Weapon Mount (where a weapon attaches on a unit) ──

export interface TurretMount {
  weaponId: string; // references WeaponBlueprint
  offsetX: number; // unit-local fraction of radius (positive = forward)
  offsetY: number; // unit-local fraction of radius (positive = right)
}

// ── Locomotion Blueprint (discriminated union) ──

export interface WheelConfig {
  wheelDistX: number;
  wheelDistY: number;
  treadLength: number;
  treadWidth: number;
  wheelRadius: number;
  rotationSpeed: number;
}

export interface TreadConfig {
  treadOffset: number;
  treadLength: number;
  treadWidth: number;
  wheelRadius: number;
  rotationSpeed: number;
}

export interface LegConfig {
  thickness: number;
  footSize: number;
  lerpDuration: number;
}

export type LegStyle = 'widow' | 'daddy' | 'tarantula' | 'tick' | 'commander';

export type LocomotionBlueprint =
  | { type: 'wheels'; config: WheelConfig }
  | { type: 'treads'; config: TreadConfig }
  | { type: 'legs'; style: LegStyle; config: LegConfig };

// ── Unit Blueprint ──

export interface UnitBlueprint {
  id: string;
  name: string;
  shortName: string;
  // Stats
  hp: number;
  moveSpeed: number;
  collisionRadius: number;
  collisionRadiusMultiplier: number;
  mass: number;
  baseCost: number;
  // Weapons
  weapons: TurretMount[];
  chassisMounts: MountPoint[];
  // Rendering
  locomotion: LocomotionBlueprint;
  renderer: string; // key for body draw function dispatch
  // Capabilities
  builder?: { buildRange: number };
  dgun?: { weaponId: string; energyCost: number };
  // Audio
  deathSound?: SoundEntry;
  // Overrides
  weaponSeeRange?: number; // widow's custom see range
}
