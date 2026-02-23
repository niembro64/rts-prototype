// ── Two-state hysteresis range system ──
// Each weapon has two states: tracking (turret aimed) and engaged (actively firing).
// Each state uses hysteresis: acquire at a tighter range, release at a wider range.
// This prevents state flickering when targets hover near boundaries.

// All type definitions are now centralized in @/types/sim.
// This file re-exports them for backward compatibility and holds runtime constants.

export type {
  HysteresisRange,
  HysteresisRangeOverride,
  TurretRanges,
  TurretRangeMultipliers,
  TurretRangeOverrides,
  EntityId,
  PlayerId,
  Transform,
  Body,
  Selectable,
  Ownership,
  WaypointType,
  Waypoint,
  ActionType,
  BuildingType,
  UnitAction,
  Unit,
  Building,
  ForceFieldZoneConfig,
  ProjectileShot,
  BeamShot,
  FieldShot,
  ShotConfig,
  TurretConfig,
  Turret,
  ProjectileType,
  Projectile,
  EconomyState,
  Buildable,
  Builder,
  BuildingConfig,
  UnitBuildConfig,
  Factory,
  Commander,
  DGunProjectile,
  EntityType,
  Entity,
} from '@/types/sim';

import type { PlayerId } from '@/types/sim';

// Player colors - balanced for similar intensity/softness while remaining distinguishable
// All colors tuned to ~65% saturation and ~70% lightness for a cohesive soft look
export const PLAYER_COLORS: Record<PlayerId, { primary: number; secondary: number; name: string }> = {
  1: { primary: 0xe05858, secondary: 0xb84040, name: 'Red' },      // Soft coral red
  2: { primary: 0x5888e0, secondary: 0x4070b8, name: 'Blue' },     // Soft sky blue
  3: { primary: 0xd8c050, secondary: 0xb0a040, name: 'Yellow' },   // Soft gold yellow
  4: { primary: 0x58c058, secondary: 0x40a040, name: 'Green' },    // Soft grass green
  5: { primary: 0xa068d0, secondary: 0x8050b0, name: 'Purple' },   // Soft lavender purple
  6: { primary: 0xd88050, secondary: 0xb06840, name: 'Orange' },   // Soft peach orange
};

export const MAX_PLAYERS = 6;
