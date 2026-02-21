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

  // Projectile/damage radii for impact explosion animation
  collisionRadius?: number;   // Projectile collision radius (innermost zone)
  primaryRadius?: number;     // Primary damage radius (middle zone)
  secondaryRadius?: number;   // Secondary damage radius (outer zone)

  // Collided entity's collision radius (for impact explosions)
  entityCollisionRadius?: number;
}

// Color palette for unit rendering
export interface ColorPalette {
  base: number;
  light: number;
  dark: number;
}

/** LOD level for unit rendering. 'min' = dot (handled by renderEntities before calling renderers), 'low' = simplified, 'high' = full detail */
export type LodLevel = 'min' | 'low' | 'high';

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
  /** LOD level: renderers only ever see 'low' or 'high' ('min' is handled by the dot fast path) */
  lod: LodLevel;
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
  UNIT_COLLISION_RADIUS: 0x44ffff, // Cyan for collision (visual) radius
  UNIT_PHYSICS_RADIUS: 0xff44ff, // Magenta for physics (hitbox) radius
} as const;

// Leg style rendering configuration — explicit per-style visual properties
export interface LegStyleConfig {
  upperThickness: number;  // line width for upper segment (hip to knee), px
  lowerThickness: number;  // line width for lower segment (knee to foot), px
  hipRadius: number;       // circle radius at hip/attachment joint, px
  kneeRadius: number;      // circle radius at knee joint, px
  footRadius: number;      // circle radius at foot, px
  lerpSpeed: number;       // foot animation lerp duration, ms
}

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
