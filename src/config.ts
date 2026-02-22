/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

// Spatial grid cell size in pixels. Should be roughly 1/2 to 1/3 of typical weapon range.
export const SPATIAL_GRID_CELL_SIZE = 150;

// =============================================================================
// SNAPSHOT / NETWORKING
// =============================================================================

export interface SnapshotConfig {
  deltaEnabled: boolean;
  positionThreshold: number;
  rotationThreshold: number;
  velocityThreshold: number;
}

export const SNAPSHOT_CONFIG: SnapshotConfig = {
  /** Enable delta snapshots (only send changed entities). When false, every snapshot is a full keyframe. */
  deltaEnabled: true,
  /** Position change threshold (px). Entity is "unchanged" if position moved less than this. */
  positionThreshold: 0.01,
  /** Rotation change threshold (radians). */
  rotationThreshold: Math.PI / 64,
  /** Velocity change threshold (px/sec). */
  velocityThreshold: 0.01,
};

// Re-export bar config values used by sim/server code
export { CONTROL_BARS } from './controlBarConfig';
export type { SnapshotRate, KeyframeRatio, TickRate } from './controlBarConfig';
import { CONTROL_BARS } from './controlBarConfig';

export const DEFAULT_KEYFRAME_RATIO = CONTROL_BARS.server.keyframe.default;
export const KEYFRAME_RATIO_OPTIONS = CONTROL_BARS.server.keyframe.options;
export const DEFAULT_SNAPSHOT_RATE = CONTROL_BARS.server.snapshot.default;
export const SNAPSHOT_RATE_OPTIONS = CONTROL_BARS.server.snapshot.options;
export const MAX_TOTAL_UNITS = CONTROL_BARS.battle.cap.default;
export const DEFAULT_PROJ_VEL_INHERIT =
  CONTROL_BARS.battle.projVelInherit.default;
export const DEFAULT_FF_ACCEL_UNITS = CONTROL_BARS.battle.ffAccelUnits.default;
export const DEFAULT_FF_ACCEL_SHOTS = CONTROL_BARS.battle.ffAccelShots.default;
export const BAR_COLORS = CONTROL_BARS.themes;
// UNIT_SHORT_NAMES removed — now in UnitBlueprint.shortName

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

export interface EmaLowConfig {
  drop: number;
  recovery: number;
}
export interface EmaTierConfig {
  avg: number;
  low: EmaLowConfig;
}

export const EMA_CONFIG: Record<string, EmaTierConfig> = {
  tps: {
    avg: 0.5,
    low: { drop: 1, recovery: 0.05 },
  },
  fps: {
    avg: 0.01,
    low: { drop: 1, recovery: 0.001 },
  },
  snaps: {
    avg: 0.02,
    low: { drop: 1, recovery: 0.002 },
  },
};

// =============================================================================
// ECONOMY & RESOURCES
// =============================================================================

/** Starting energy stockpile for each player */
export const STARTING_STOCKPILE = 500;

/** Maximum energy stockpile capacity */
export const MAX_STOCKPILE = 1000;

/** Base energy income per second (before solar panels) */
export const BASE_INCOME_PER_SECOND = 10;

// =============================================================================
// UNIT CAP
// =============================================================================

/** Energy produced per second by each completed solar panel */
export const SOLAR_ENERGY_PER_SECOND = 50;

// =============================================================================
// COST MULTIPLIER
// =============================================================================

/**
 * Multiplier applied to all unit and building energy costs.
 * 1.0 = normal costs, 2.0 = double costs, 3.0 = triple costs
 */
export const COST_MULTIPLIER = 1.0;

// =============================================================================
// COMBAT PHYSICS
// =============================================================================

/**
 * Knockback forces for combat. Each value is a multiplier applied to damage.
 * Force = damage * multiplier. 0 = disabled.
 *
 * Beam/railgun knockback uses momentum-based force (mass × velocity × PROJECTILE_MASS_MULTIPLIER).
 */
export interface KnockbackConfig {
  FORCE_FIELD_PULL_MULTIPLIER: number;
  SPLASH: number;
}

export const KNOCKBACK: KnockbackConfig = {
  FORCE_FIELD_PULL_MULTIPLIER: 2.0, // Multiplier applied to each weapon's pullPower
  SPLASH: 250, // Knockback multiplier for area/splash explosions (mortar/disruptor)
};

/**
 * Whether turrets return to forward-facing (movement direction) when they have no target.
 * true = turrets snap back to face forward when idle.
 * false = turrets hold their last rotation when idle.
 */
export const TURRET_RETURN_TO_FORWARD = false;

// Color conversion utilities
export function hexToStr(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
export function hexToRgb(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

// Map colors
export const MAP_BG_COLOR = 0x0a0e0f; // in-bounds background
export const MAP_OOB_COLOR = 0x08080f; // out-of-bounds background
export const MAP_CAMERA_BG = 0x0a0a14; // camera clear color
export const MAP_GRID_COLOR = MAP_BG_COLOR;

// Scorched earth burn mark colors and decay
export const BURN_COLOR_HOT = 0x882200; // bright red start
export const BURN_COLOR_COOL = MAP_BG_COLOR; // fades to background
export const BURN_COLOR_TAU = 200; // color decay: red → black (ms), fast
export const BURN_COOL_TAU = 500; // color decay: black → background (ms), slow

/**
 * Two-state hysteresis range multipliers (relative to weapon base range).
 *
 * Each weapon has two states with hysteresis (acquire < release prevents flickering):
 *   - tracking: turret pre-aims at approaching enemies
 *   - engage: weapon actively fires
 *
 * Hierarchy (outer to inner):
 *   tracking.release (1.1x) > tracking.acquire (1.0x) > engage.release (0.95x) > engage.acquire (0.9x)
 */
export const TURRET_RANGE_MULTIPLIERS: import('./game/sim/types').TurretRangeMultipliers =
  {
    tracking: { acquire: 1.0, release: 1.1 },
    engage: { acquire: 0.9, release: 0.95 },
  };
export const FORCE_TURRET_RANGE_MULTIPLIERS: import('./game/sim/types').TurretRangeMultipliers =
  {
    tracking: { acquire: 1.0, release: 1.1 },
    engage: { acquire: 1.0, release: 1.05 },
  };

export const FORCE_PUSH: import('./game/sim/blueprints/types').ForceFieldZoneRatioConfig =
  {
    innerRatio: 0.0,
    outerRatio: 0.5,
    color: 0x3366ff,
    alpha: 0.05,
    particleAlpha: 0.2,
    power: 2000,
    damage: 0,
  };

export const FORCE_PULL: import('./game/sim/blueprints/types').ForceFieldZoneRatioConfig =
  {
    innerRatio: 0.5,
    outerRatio: 0.52,
    color: 0x3366ff,
    alpha: 0.2,
    particleAlpha: 0.2,
    power: null,
    damage: 0,
  };

/**
 * Force field weapon visual configuration.
 * Controls the pie-slice zone, concentric wave arcs, and inward-moving particle lines.
 */
export interface ForceFieldVisualConfig {
  particleCount: number;
  particleSpeed: number;
  particleLength: number;
  particleThickness: number;
  arcCount: number;
  arcSegments: number;
  arcJitter: number;
  arcThickness: number;
  arcOpacity: number;
  arcFlickerMs: number;
  trailSegments: number;
  trailSpacing: number;
  trailFalloff: number;
}

export const FORCE_FIELD_VISUAL: ForceFieldVisualConfig = {
  // --- Particle lines (radial dashes moving inward) ---
  particleCount: 20, // Number of radial particle lines around full circle
  particleSpeed: 10, // Inward travel speed
  particleLength: 0.1, // Length as fraction of maxRange (0.2 = 20%)
  particleThickness: 1, // Line thickness (px)

  // --- Enhanced-only: electric arcs ---
  arcCount: 4, // Number of lightning arcs visible at once
  arcSegments: 6, // Segments per arc (more = more jagged)
  arcJitter: 15, // Max perpendicular offset per segment (px)
  arcThickness: 1.5, // Line thickness of arcs (px)
  arcOpacity: 0.5, // Peak opacity of arcs
  arcFlickerMs: 80, // How often arcs re-randomize (ms) — lower = faster crackle

  // --- Enhanced-only: particle trails ---
  trailSegments: 3, // Number of trailing ghost segments behind each particle
  trailSpacing: 0.6, // Spacing between trail segments as fraction of dashLen
  trailFalloff: 0.45, // Opacity multiplier per successive trail segment
};

/**
 * Force field turret (grate) configuration per unit type.
 * All length/width values are multipliers of the unit's collision radius.
 */
export type ForceFieldTurretShape =
  | 'triangle'
  | 'line'
  | 'square'
  | 'hexagon'
  | 'circle';

export interface ForceFieldTurretConfig {
  shape: ForceFieldTurretShape; // piece geometry
  count: number; // number of pieces
  length: number; // how far turret extends (× radius)
  width: number; // max half-width of base piece (× radius)
  taper: number; // 0→1: tip shrinks to (1−taper) of base; also compresses spacing
  baseOffset: number; // where first piece sits (fraction of length)
  originOffset: number; // mount point offset along turret axis (× radius)
  thickness: number; // line width (px), used for 'line' shape
  reversePhase: boolean; // true: phase offsets run tip→base instead of base→tip
}

export const FORCE_FIELD_TURRET: Record<string, ForceFieldTurretConfig> = {
  forceField: {
    shape: 'circle',
    count: 5,
    length: 0.0,
    width: 0.45,
    taper: 0.5,
    baseOffset: 0.0,
    originOffset: 0,
    thickness: 1.5,
    reversePhase: true,
  },
  megaForceField: {
    shape: 'circle',
    count: 7,
    length: 0.0,
    width: 0.25,
    taper: 0.7,
    baseOffset: 0.0,
    originOffset: 0.0,
    thickness: 4.5,
    reversePhase: true,
  },
};

// =============================================================================
// TURRET RENDERING CONFIG
// =============================================================================

export interface SpinConfig {
  idle: number; // Slow idle spin (rad/sec)
  max: number; // Maximum spin speed when firing (rad/sec)
  accel: number; // Spin-up acceleration (rad/sec²)
  decel: number; // Spin-down deceleration (rad/sec²)
}

export type TurretConfig =
  | {
      type: 'simpleMultiBarrel';
      barrelCount: number;
      barrelLength: number;
      barrelThickness?: number;
      orbitRadius: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | {
      type: 'coneMultiBarrel';
      barrelCount: number;
      barrelLength: number;
      barrelThickness?: number;
      baseOrbit: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | {
      type: 'simpleSingleBarrel';
      barrelLength: number;
      barrelThickness?: number;
    }
  | { type: 'complexSingleEmitter'; grate: ForceFieldTurretConfig };

// =============================================================================
// CHASSIS MOUNT POINTS
// =============================================================================

/**
 * Where weapons attach on each unit chassis.
 * x = forward offset, y = lateral offset (both as multipliers of unit collision radius).
 * Position is computed as: mountWorldX = unitX + cos(bodyRot)*x*r - sin(bodyRot)*y*r
 */
export interface MountPoint {
  x: number;
  y: number;
}

// CHASSIS_MOUNTS removed — now in blueprints

// LEG_CONFIG removed — now in blueprints
// TREAD_CONFIG removed — now in blueprints
// WHEEL_CONFIG removed — now in blueprints

export interface BuildingStatEntry {
  baseCost: number;
  hp: number;
}

export const BUILDING_STATS: Record<string, BuildingStatEntry> = {
  solar: {
    baseCost: 100, // Base energy cost (before multiplier)
    hp: 200,
  },
  factory: {
    baseCost: 300, // Base energy cost (before multiplier)
    hp: 800,
  },
};

// COMMANDER_STATS removed — now in blueprints

// =============================================================================
// PHYSICS TUNING
// =============================================================================

/**
 * Global mass multiplier for all units.
 * Higher values = heavier units = slower acceleration, more momentum, more "weighty" feel.
 * 1.0 = use raw mass values from UNIT_STATS
 * 5.0 = units feel 5x heavier (similar to old demo feel)
 */
export const UNIT_MASS_MULTIPLIER = 10.0;

/**
 * Global mass multiplier for all projectiles.
 * Scales recoil on shooter, knockback on target, and resistance to force field pull.
 * 1.0 = use raw mass values from PROJECTILE_STATS
 * Higher = more recoil/knockback, lower = less
 */
export const PROJECTILE_MASS_MULTIPLIER = 1.0;

/**
 * Barrel thickness multiplier — scales the derived barrel width on turrets.
 * Barrel width is derived from projectile size (collision.radius * 2 for bullets, beam.width for beams).
 * 1.0 = barrel matches projectile diameter exactly, 0.5 = half-width barrels, 2.0 = double-width.
 */
export const BARREL_THICKNESS_MULTIPLIER = 0.8;

/**
 * Global thrust multiplier for all unit movement.
 * Scales the force applied when units accelerate toward waypoints.
 * Higher values = faster acceleration, higher top speed.
 * 1.0 = default, 0.5 = sluggish, 2.0 = snappy
 */
export const UNIT_THRUST_MULTIPLIER_GAME = 6.0;
export const UNIT_THRUST_MULTIPLIER_DEMO = 6.0;

// UNIT_STATS removed — now in blueprints

// PROJECTILE_STATS removed — now in blueprints

// WEAPON_STATS removed — now in blueprints

// =============================================================================
// MAP SIZE SETTINGS
// =============================================================================

export interface MapSize {
  width: number;
  height: number;
}

export const MAP_SETTINGS: Record<string, MapSize> = {
  game: { width: 3_000, height: 3_000 },
  demo: { width: 1_600, height: 7_00 },
};

// =============================================================================
// BACKGROUND GAME SETTINGS
// =============================================================================

/**
 * Unit spawn distribution for background battle.
 * - true: Inverse cost weighting (cheaper units spawn more frequently)
 * - false: Flat distribution (all units equally likely)
 */
export const BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING = true;

/** Whether to show the lobby modal on startup. If false, starts in spectate mode. */
export const SHOW_LOBBY_ON_STARTUP = false;

// Re-export audio config
export { AUDIO } from './audioConfig';
export type { SynthId, SoundEntry } from './audioConfig';

// =============================================================================
// UI
// =============================================================================

/** How often to sample combat stats for the history graph (ms) */
export const COMBAT_STATS_SAMPLE_INTERVAL = 200;

/** Maximum number of combat stats snapshots to retain (samples × interval = time window) */
export const COMBAT_STATS_HISTORY_MAX = 25; // 1200 × 500ms = 10 minutes

/** Whether the Combat Statistics modal is visible on page load */
export const COMBAT_STATS_VISIBLE_ON_LOAD = false;

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

/** Minimum zoom level (zoomed out) */
export const ZOOM_MIN = 0.4;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 5.0;

/**
 * Zoom multiplier per scroll wheel tick (exponential zoom).
 * Each scroll step multiplies/divides zoom by this factor.
 * 1.15 = 15% change per step, feels consistent at all zoom levels.
 */
export const ZOOM_FACTOR = 1 + 1 / 8;

/** Initial zoom level for the background demo game */
export const ZOOM_INITIAL_DEMO = 1.8;

/** Initial zoom level when a real game starts */
export const ZOOM_INITIAL_GAME = 0.5;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = 6.0;

/** Edge scroll configuration */
export const EDGE_SCROLL = {
  /** Fraction of effective viewport from each edge that triggers scrolling (0.15 = 15%) */
  borderRatio: 0.15,
  /** World units/sec at zoom 1.0 (scales inversely with zoom) */
  speed: 800,
  /** Fixed top bar height in pixels (excluded from effective viewport) */
  topBarHeight: 50,
  /** Overlay appearance */
  overlay: {
    fillColor: 0x000000,   // Border zone fill color
    fillAlpha: 0.8,        // Border zone fill opacity
    strokeColor: 0x000000, // Inner border line color
    strokeAlpha: 0.3,      // Inner border line opacity
    strokeWidth: 1,        // Inner border line width (px)
  },
};

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = 20.0;

