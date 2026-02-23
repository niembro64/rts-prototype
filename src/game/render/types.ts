// Shared types and constants for the render system

import type { WaypointType, ActionType } from '../sim/types';

// Re-export all render types from centralized type files
export type {
  EntitySource,
  ExplosionEffect,
  ColorPalette,
  ProjectileTrail,
  UnitRenderContext,
  BuildingRenderContext,
  BeamRandomOffsets,
  LegStyleConfig,
} from '@/types/render';
import type { LegStyleConfig } from '@/types/render';

// ==================== CONSTANTS ====================

// Color constants
export const COLORS = {
  WHITE: 0xf0f0f0,
  BLACK: 0x1a1a1a,
  DARK_GRAY: 0x383838,
  GRAY: 0x606060,
  GRAY_LIGHT: 0x909090,

  // Selection and UI
  UNIT_SELECTED: 0x00ff88,
  BUILDING: 0x886644,
  BUILDING_OUTLINE: 0xaa8866,
  HEALTH_BAR_BG: 0x333333,
  HEALTH_BAR_FG: 0x44dd44,
  HEALTH_BAR_LOW: 0xff4444,
  BUILD_BAR_FG: 0xffcc00, // Yellow for build progress
  GHOST: 0x88ff88, // Green tint for placement ghost
  COMMANDER: 0xffd700, // Gold for commander indicator

  // Range circles (outer to inner: see > fire > release > lock > fightstop)
  VISION_RANGE: 0xffff88, // Yellow for see range (turret pre-aim)
  WEAPON_RANGE: 0xff4444, // Red for fire range
  RELEASE_RANGE: 0x44aaff, // Blue for release range (lock release boundary)
  LOCK_RANGE: 0xaa44ff, // Purple for lock range (lock acquisition)
  FIGHTSTOP_RANGE: 0xff8844, // Orange for fightstop range
  BUILD_RANGE: 0x44ff44, // Green for build range

  // Projectile range circles
  PROJ_COLLISION_RANGE: 0xff0000, // Bright red for collision radius
  PROJ_PRIMARY_RANGE: 0xff8844, // Orange for primary damage radius
  PROJ_SECONDARY_RANGE: 0xffdd44, // Yellow for secondary damage radius

  // Unit radius circles
  UNIT_SCALE_RADIUS: 0x44ffff, // Cyan for drawScale (visual/click) radius
  UNIT_SHOT_RADIUS: 0xff44ff, // Magenta for shot collider radius
  UNIT_PUSH_RADIUS: 0x44ff44, // Green for push collider radius
} as const;

export const LEG_STYLE_CONFIG: Record<string, LegStyleConfig> = {
  widow: {
    upperThickness: 7,
    lowerThickness: 6,
    hipRadius: 4,
    kneeRadius: 6,
    footRadius: 3.5,
    lerpSpeed: 600,
  },
  daddy: {
    upperThickness: 2.5,
    lowerThickness: 2,
    hipRadius: 1.5,
    kneeRadius: 0.8,
    footRadius: 1.8,
    lerpSpeed: 300,
  },
  tarantula: {
    upperThickness: 6.5,
    lowerThickness: 6,
    hipRadius: 3.5,
    kneeRadius: 6,
    footRadius: 1.5,
    lerpSpeed: 200,
  },
  tick: {
    upperThickness: 2,
    lowerThickness: 1.5,
    hipRadius: 1,
    kneeRadius: 1.5,
    footRadius: 1,
    lerpSpeed: 160,
  },
  commander: {
    upperThickness: 8,
    lowerThickness: 7,
    hipRadius: 5,
    kneeRadius: 7,
    footRadius: 5,
    lerpSpeed: 400,
  },
};

// Waypoint colors by type (legacy - for factories)
export const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00, // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444, // Red
};

// Action colors by type (for unit action queue)
export const ACTION_COLORS: Record<ActionType, number> = {
  move: 0x00ff00, // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444, // Red
  build: 0xffcc00, // Yellow for building
  repair: 0x44ff44, // Light green for repair
};

// Unit display names by unit type ID
export const UNIT_NAMES: Record<string, string> = {
  jackal: 'Jackal',
  lynx: 'Lynx',
  daddy: 'Daddy',
  badger: 'Badger',
  mongoose: 'Mongoose',
  tick: 'Tick',
  mammoth: 'Mammoth',
  widow: 'Widow',
  tarantula: 'Tarantula',
};
