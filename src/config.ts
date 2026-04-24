/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

// =============================================================================
// TYPE RE-EXPORTS (definitions live in ./types/config.ts)
// =============================================================================

export type {
  SnapshotConfig,
  EmaLowConfig,
  EmaTierConfig,
  EmaHighConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldTurretShape,
  ForceFieldTurretConfig,
  SpinConfig,
  BarrelShape,
  MountPoint,
  BuildingStatEntry,
  MapSize,
} from './types/config';

import type {
  SnapshotConfig,
  EmaTierConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldTurretConfig,
  BuildingStatEntry,
  MapSize,
} from './types/config';

// Spatial grid cell size in pixels. Should be roughly 1/2 to 1/3 of typical weapon range.
export const SPATIAL_GRID_CELL_SIZE = 150;


// F=============================================================================
// SNAPSHOT / NETWORKING
// =============================================================================

export const SNAPSHOT_CONFIG: SnapshotConfig = {
  /** Enable delta snapshots (only send changed entities). When false, every snapshot is a full keyframe. */
  deltaEnabled: true,
  /** Position change threshold (px). Entity x/y must change by more than this to be sent. */
  positionThreshold: 0.1,
  /** Linear velocity change threshold (px/tick). Entity velocityX/Y must change by more than this. */
  velocityThreshold: 0.1,
  /** Rotation position threshold (radians). Body rotation and turret rotations must change by more than this. */
  rotationPositionThreshold: Math.PI / 64,
  /** Rotation velocity threshold (rad/tick). Turret angular velocities must change by more than this. */
  rotationVelocityThreshold: 0.1,
};

// Re-export bar config values used by sim/server code
export { BATTLE_CONFIG } from './battleBarConfig';
export { SERVER_CONFIG } from './serverBarConfig';
export type { SnapshotRate, KeyframeRatio, TickRate } from './types/server';
import { SERVER_CONFIG } from './serverBarConfig';
import { BATTLE_CONFIG } from './battleBarConfig';
import { BAR_THEMES } from './barThemes';

export const DEFAULT_KEYFRAME_RATIO = SERVER_CONFIG.keyframe.default;
export const KEYFRAME_RATIO_OPTIONS = SERVER_CONFIG.keyframe.options;
export const DEFAULT_SNAPSHOT_RATE = SERVER_CONFIG.snapshot.default;
export const SNAPSHOT_RATE_OPTIONS = SERVER_CONFIG.snapshot.options;
export const MAX_TOTAL_UNITS = BATTLE_CONFIG.cap.default;
export const DEFAULT_PROJ_VEL_INHERIT = BATTLE_CONFIG.projVelInherit.default;
export const DEFAULT_FF_ACCEL_UNITS = BATTLE_CONFIG.ffAccelUnits.default;
export const DEFAULT_FF_ACCEL_SHOTS = BATTLE_CONFIG.ffAccelShots.default;
export const DEFAULT_FF_DMG_UNITS = BATTLE_CONFIG.ffDmgUnits.default;
export const BAR_COLORS = BAR_THEMES;

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

export const EMA_CONFIG: Record<string, EmaTierConfig> = {
  tps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
  fps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
  snaps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
};

// Frame timing EMA config (tracks durations in ms — uses "hi" instead of "low")
const FRAME_MS_EMA: EmaMsConfig = { avg: 0.01, hi: { spike: 0.5, recovery: 0.0001 } };
export const FRAME_TIMING_EMA = {
  frameMs: FRAME_MS_EMA,
  renderMs: FRAME_MS_EMA,
  logicMs: FRAME_MS_EMA,
};

/**
 * Initial values for EMA trackers — controls whether each metric starts
 * "high" (optimistic) or "low" (pessimistic) before real samples arrive.
 *
 * Starting HIGH means LOD begins at max quality and degrades if needed.
 * Starting LOW means LOD begins at min quality and climbs if performance allows.
 *
 * Rate trackers (FPS/TPS/SPS): high number = good performance.
 * Ms trackers (frame/render/logic): low number = good performance.
 */
export const EMA_INITIAL_VALUES = {
  // Rate trackers — start optimistic (high = good)
  tps:      60,     // assume 60 ticks/sec until measured
  fps:      60,     // assume 60 frames/sec until measured
  snaps:    32,     // assume 32 snapshots/sec until measured

  // Ms trackers — start optimistic (low = good)
  frameMs:  1,      // assume 1ms frame time until measured
  renderMs: 0.5,    // assume 0.5ms render time until measured
  logicMs:  0.5,    // assume 0.5ms logic time until measured
};

// =============================================================================
// SERVER TICK
// =============================================================================

/** Maximum dt (ms) the server will simulate in a single tick.
 *  Prevents spiral-of-death when a tick takes longer than the interval. */
export const MAX_TICK_DT_MS = 4 * (1000 / 60); // ~66.7ms (4 frames at 60Hz)

// =============================================================================
// VISUAL DIMENSIONS (shared sim + render)
// =============================================================================
// The sim knows the unit's physics sphere (radius around transform.z),
// but the visible chassis + turret mesh sits *above* that sphere center.
// Projectile muzzle / spawn altitude has to match the visible barrel
// tip, not the sphere center — otherwise shots come out of the unit's
// belly instead of the turret. These constants are the authoritative
// values: Render3DEntities.ts and Debris3D.ts import them from here
// so visual and sim stay locked together.

/** Vertical extent of every unit's chassis box, measured above the
 *  ground. Matches the "chassis drawn from y=0 to y=CHASSIS_HEIGHT"
 *  convention in Render3DEntities.ts. */
export const CHASSIS_HEIGHT = 28;

/** Vertical extent of a turret's head (barrel cluster sits at
 *  mid-height of the turret head). */
export const TURRET_HEIGHT = 16;

/** World-space altitude of the barrel tip above the unit's ground
 *  footprint, in the neutral (pitch=0) orientation. Projectile fire
 *  code adds `unit.transform.z - radius` to this to get the absolute
 *  muzzle z — non-grounded units (airborne, mid-explosion-knockback)
 *  then fire from the right height without a special case. */
export const MUZZLE_HEIGHT_ABOVE_GROUND = CHASSIS_HEIGHT + TURRET_HEIGHT / 2;

/** Universal gravity acceleration (world units / s², pulling −z).
 *  Single source of truth for every falling thing — physics engine's
 *  unit bodies, projectile ballistic integration, debris chunks,
 *  explosion spark particles, client-side dead-reckoning. Tuned for
 *  RTS-scale ballistics rather than real-world 9.8 m/s²; the map is
 *  ~3000 wu wide and shots travel hundreds of units per second, so
 *  heavier gravity would flatten every arc into a short lob. */
export const GRAVITY = 250;

// =============================================================================
// ECONOMY & RESOURCES
// =============================================================================

/** Starting energy stockpile for each player */
export const STARTING_STOCKPILE = 500;

/** Maximum energy stockpile capacity */
export const MAX_STOCKPILE = 1000;

/** Base energy income per second (before solar panels) */
export const BASE_INCOME_PER_SECOND = 10;

/** Starting mana stockpile for each player */
export const STARTING_MANA = 200;

/** Maximum mana stockpile capacity */
export const MAX_MANA = 1000;

/** Base mana income per second (before territory) */
export const BASE_MANA_PER_SECOND = 5;

/** Mana income per owned tile per second (regardless of flag height) */
export const MANA_PER_TILE_PER_SECOND = 10.0;

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
    power: 1400,
    damage: 10,
  };

/**
 * Force field weapon visual configuration.
 * Controls the pie-slice zone, concentric wave arcs, and inward-moving particle lines.
 */
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
// CHASSIS MOUNT POINTS
// =============================================================================

/**
 * Where weapons attach on each unit chassis.
 * x = forward offset, y = lateral offset (both as multipliers of unit collision radius).
 * Position is computed as: mountWorldX = unitX + cos(bodyRot)*x*r - sin(bodyRot)*y*r
 */
// CHASSIS_MOUNTS removed — now in blueprints

// LEG_CONFIG removed — now in blueprints
// TREAD_CONFIG removed — now in blueprints
// WHEEL_CONFIG removed — now in blueprints

export const BUILDING_STATS: Record<string, BuildingStatEntry> = {
  solar: {
    energyCost: 100, // Base energy cost (before multiplier)
    hp: 200,
  },
  factory: {
    energyCost: 300, // Base energy cost (before multiplier)
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
export const ZOOM_MIN = 0.2;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 5.0;

/**
 * Zoom multiplier per scroll wheel tick (exponential zoom).
 * Each scroll step multiplies/divides zoom by this factor.
 * 1.15 = 15% change per step, feels consistent at all zoom levels.
 */
export const ZOOM_FACTOR = 1 + 1 / 8;

/** Initial zoom level for the demo game (zoomed out overview) */
export const ZOOM_INITIAL_DEMO = 1.5;

/** Initial zoom level when a real game starts */
export const ZOOM_INITIAL_GAME = 0.5;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = 6.0;

const ARROW_COLOR = 0xffffff;
const ARROW_ALPHA = 0.1;
const ARROW_SIZE_MULT = 20;

const OVAL_ALPHA = 0.0;

/** Edge scroll configuration */
export const EDGE_SCROLL = {
  // --- Behavior ---
  borderRatioInner: 0.3, // inset from viewport edge for inner oval (larger = smaller oval)
  borderRatioOuter: 0.1, // inset from viewport edge for outer oval (smaller = larger oval)
  speed: 3000, // world units/sec at zoom 1.0 (scales inversely with zoom)
  intensityCurve: 1, // exponent on intensity (1 = linear, 2 = quadratic, 0.5 = sqrt)
  topBarHeight: 50, // fixed top bar exclusion (px)
  depth: 999, // z-depth of the overlay graphics layer
  ovalSegments: 10, // number of segments for both ellipses

  // --- Inner oval (safe zone boundary) ---
  innerOvalFillColor: 0x0044aa,
  innerOvalFillAlpha: OVAL_ALPHA,
  innerOvalStrokeColor: 0x4488ff,
  innerOvalStrokeAlpha: OVAL_ALPHA,
  innerOvalStrokeWidth: 2,

  // --- Outer oval (pan zone outer boundary) ---
  outerOvalStrokeColor: 0xff4444,
  outerOvalStrokeAlpha: OVAL_ALPHA,
  outerOvalStrokeWidth: 2,

  // --- Ring (pan zone between inner and outer ovals) ---
  ringFillColor: 0xff6600,
  ringFillAlpha: OVAL_ALPHA,

  // --- Arrow general ---
  arrowMaxLength: 300, // max arrow length (screen px)
  arrowGap: 10, // gap from screen center before shaft starts (screen px)
  arrowDragMaxDist: 100, // mouse displacement (px) for full intensity during drag pan

  // --- Arrow shaft ---
  shaftColor: ARROW_COLOR,
  shaftAlpha: ARROW_ALPHA,
  shaftWidth: 1 * ARROW_SIZE_MULT, // line width (screen px)

  // --- Arrow head ---
  headFillColor: ARROW_COLOR,
  headFillAlpha: ARROW_ALPHA,
  headStrokeColor: ARROW_COLOR,
  headStrokeAlpha: 0.0,
  headStrokeWidth: 1, // head outline width (screen px)
  headLength: 1.5 * ARROW_SIZE_MULT, // arrowhead length (screen px)
  headWidth: 1.2 * ARROW_SIZE_MULT, // arrowhead half-width (screen px)

  // --- Arrow outline (drawn behind shaft+head for contrast) ---
  outlineColor: 0x000000,
  outlineAlpha: 0.0,
  outlineWidth: 1, // extra width added around shaft/head (screen px)
};

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = 20.0;
