// Shared types and constants for the render system

import Phaser from 'phaser';
import type { Entity, WaypointType, ActionType } from '../sim/types';

// ==================== INTERFACES ====================

/**
 * EntitySource - Interface that both WorldState and ClientViewState implement
 * Allows the renderer to work with either source transparently
 */
export interface EntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getProjectiles(): Entity[];
  getEntity(id: number): Entity | undefined;
}

// Explosion effect data
export interface ExplosionEffect {
  x: number;
  y: number;
  radius: number; // Maximum radius of explosion
  color: number; // Base color
  lifetime: number; // Total lifetime in ms
  elapsed: number; // Time elapsed in ms
  type: 'impact' | 'death'; // Type affects visual style

  // Three separate momentum vectors for different explosion layers:

  // 1. Unit velocity - where the unit was moving when it died
  // Used by: Smoke clouds, fire embers (trailing effect)
  velocityX?: number;
  velocityY?: number;
  velocityMag?: number;

  // 2. Penetration direction - from hit point through unit center
  // Used by: Debris chunks, shockwave rings (where the attack entered)
  penetrationX?: number;
  penetrationY?: number;
  penetrationMag?: number;

  // 3. Attacker direction - direction the projectile/beam was traveling
  // Used by: Spark trails, exit fragments (penetration effect)
  attackerX?: number;
  attackerY?: number;
  attackerMag?: number;

  // Combined momentum for layers that blend all forces
  combinedX?: number;
  combinedY?: number;
  combinedMag?: number;
}

// Color palette for unit rendering
export interface ColorPalette {
  base: number;
  light: number;
  dark: number;
}

// Context passed to unit renderers
export interface UnitRenderContext {
  graphics: Phaser.GameObjects.Graphics;
  x: number;
  y: number;
  radius: number;
  bodyRot: number;
  palette: ColorPalette;
  isSelected: boolean;
  entity: Entity;
  skipTurrets: boolean;
  turretsOnly: boolean;
}

// Context passed to building renderers
export interface BuildingRenderContext {
  graphics: Phaser.GameObjects.Graphics;
  entity: Entity;
  left: number;
  top: number;
  width: number;
  height: number;
  playerColor: number;
  sprayParticleTime: number;
}

// Per-projectile random offsets for visual variety
export interface BeamRandomOffsets {
  phaseOffset: number;      // Random offset for pulse timing
  rotationOffset: number;   // Random rotation for sparks
  sizeScale: number;        // Random size multiplier (0.8-1.2)
  pulseSpeed: number;       // Random pulse speed multiplier
}

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

  // Spray effects
  SPRAY_BUILD: 0x44ff44, // Green for building
  SPRAY_HEAL: 0x4488ff, // Blue for healing

  // Range circles
  VISION_RANGE: 0xffff88, // Yellow for vision range
  WEAPON_RANGE: 0xff4444, // Red for weapon range
  BUILD_RANGE: 0x44ff44, // Green for build range
} as const;

// Leg style configuration - re-exported from config.ts for convenience
// Maps old property names to new config object
import { LEG_CONFIG } from '../../config';
export const LEG_STYLE_CONFIG = {
  widow: { thickness: LEG_CONFIG.widow.thickness, footSizeMultiplier: LEG_CONFIG.widow.footSize, lerpSpeed: LEG_CONFIG.widow.lerpDuration },
  daddy: { thickness: LEG_CONFIG.daddy.thickness, footSizeMultiplier: LEG_CONFIG.daddy.footSize, lerpSpeed: LEG_CONFIG.daddy.lerpDuration },
  tarantula: { thickness: LEG_CONFIG.tarantula.thickness, footSizeMultiplier: LEG_CONFIG.tarantula.footSize, lerpSpeed: LEG_CONFIG.tarantula.lerpDuration },
  commander: { thickness: LEG_CONFIG.commander.thickness, footSizeMultiplier: LEG_CONFIG.commander.footSize, lerpSpeed: LEG_CONFIG.commander.lerpDuration },
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
  scorpion: 'Scorpion',
  viper: 'Viper',
  mammoth: 'Mammoth',
  widow: 'Widow',
  tarantula: 'Tarantula',
};
