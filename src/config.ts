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

export const SNAPSHOT_CONFIG = {
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
export const DEFAULT_PROJ_VEL_INHERIT = CONTROL_BARS.battle.projVelInherit.default;
export const BAR_COLORS = CONTROL_BARS.themes;
// UNIT_SHORT_NAMES removed — now in UnitBlueprint.shortName

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

export const EMA_CONFIG = {
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
 * Beam/railgun hitForce and knockBackForce are defined per-projectile in projectiles.ts.
 */
export const KNOCKBACK = {
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
 * Range multipliers relative to fireRange (1.0x).
 * All ranges are derived from a weapon's base fireRange.
 *
 * Hierarchy (outer to inner):
 *   seeRange (1.3x) > fireRange (1.0x) > releaseRange (0.95x) > lockRange (0.85x) > fightstopRange (0.8x)
 *
 * - see: Turret pre-aims at approaching enemies. Target dropped when they leave.
 * - fire: Weapon fires at nearest enemy within this range (1.0x, the base).
 * - release: Lock release boundary (hysteresis). Locked target stays locked until exiting.
 * - lock: Lock acquisition. Weapon commits (sticky) when current target enters this range.
 * - fightstop: Unit stops moving in fight/patrol mode when enemy is within this range.
 */
export const RANGE_MULTIPLIERS = {
  see: 1.0,
  fire: 0.9,
  release: 0.8,
  lock: 0.7,
  fightstop: 0.6,
};

/**
 * Force field weapon visual configuration.
 * Controls the pie-slice zone, concentric wave arcs, and inward-moving particle lines.
 */
export const FORCE_FIELD_VISUAL = {
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
      type: 'multibarrel';
      barrelCount: number;
      barrelLength: number;
      barrelThickness: number;
      orbitRadius: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | {
      type: 'coneSpread';
      barrelCount: number;
      barrelLength: number;
      barrelThickness: number;
      baseOrbit: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | { type: 'single'; barrelLength: number; barrelThickness: number }
  | { type: 'beamEmitter'; barrelLength: number; barrelThickness: number }
  | { type: 'forceField'; grate: ForceFieldTurretConfig };

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

// =============================================================================
// EXPLOSION MOMENTUM FACTORS
// =============================================================================
// Each factor contributes to the final explosion direction/momentum.
// Set to 0 to disable a factor, higher values = more influence.

/**
 * Multiplier for the dying unit's own velocity.
 * Units moving fast when they die will have explosions trailing their motion.
 * 0 = ignore unit velocity, 1.0 = realistic, 5.0+ = exaggerated
 */
export const EXPLOSION_VELOCITY_MULTIPLIER = 30.0;

/**
 * Multiplier for the impact force/damage direction.
 * Explosions will bias toward the direction the killing blow pushed them.
 * This uses the knockback force from the weapon that killed them.
 * 0 = ignore impact, 1.0 = realistic, 5.0+ = exaggerated
 */
export const EXPLOSION_IMPACT_FORCE_MULTIPLIER = 80.0;

/**
 * Multiplier for the attacker's projectile/beam direction.
 * Explosions will bias in the direction the projectile was traveling.
 * For projectiles: actual velocity is used (this multiplier is applied on top)
 * For beams: direction * BEAM_EXPLOSION_MAGNITUDE is used
 * 0 = ignore attacker direction, 1.0 = realistic, 5.0+ = exaggerated
 */
export const EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER = 50.0;

/**
 * Magnitude for beam weapon explosion effects.
 * Since beams don't have velocity like projectiles, this provides
 * a base magnitude for the attacker direction in explosions.
 * Higher = more "push" effect from beam kills.
 */
export const BEAM_EXPLOSION_MAGNITUDE = 300;

/**
 * Base explosion momentum even when all factors are zero.
 * Adds a minimum "oomph" to all explosions regardless of context.
 * This is raw velocity units added to the final momentum.
 */
export const EXPLOSION_BASE_MOMENTUM = 500;

// =============================================================================
// FIRE (IMPACT) EXPLOSIONS
// =============================================================================

/**
 * Configuration for the unified fire/impact explosion renderer.
 * All projectile hit and expire explosions use this single config.
 */
export const FIRE_EXPLOSION = {
  // --- Lifetime ---
  /** Base lifetime in ms (scaled by sqrt(radius/8)) */
  baseLifetimeMs: 150,

  // --- Per-LOD tuning (indexed: [min, low, med, high, max]) ---
  /** Particle count multiplier per LOD tier */
  countMult: [1, 1.5, 2.5, 4, 6] as readonly number[],
  /** Center-drift strength per LOD tier (0 = no drift, 1 = full drift) */
  driftScale: [0.0, 0.1, 0.15, 0.35, 0.4] as readonly number[],
  /** Trail length multiplier per LOD tier (0 = no trails) */
  trailMult: [0, 0, 0, 0.6, 1.0] as readonly number[],

  // --- Strength normalization ---
  /** Velocity magnitude at which strength factor saturates to 1.0 */
  strengthNormalize: 200,
  /** Maximum strength factor (caps directional influence) */
  strengthMax: 1.5,
  /** Minimum strength for directional particles (keeps them visible even with zero input) */
  strengthFloor: 0.3,
  /** Combined-momentum magnitude for full drift */
  driftNormalize: 300,

  // --- Core fireball (Element 1 — collision radius zone) ---
  /** How far the core expands: collR → primR * this value */
  coreExpandTarget: 0.5,
  /** Core fade speed (1.0 = linear, higher = faster fade) */
  coreFadeRate: 1.3,
  /** Outer glow radius multiplier (relative to core radius) */
  coreGlowScale: 1.15,

  // --- Primary zone glow (Element 2) ---
  /** Starting scale for primary glow ring (fraction of primR) */
  primaryGlowStart: 0.7,
  /** Expansion over lifetime (added to start) */
  primaryGlowExpand: 0.5,
  /** Fade rate for primary zone */
  primaryFadeRate: 1.4,
  /** Fill alpha for primary zone glow */
  primaryGlowAlpha: 0.12,

  // --- Secondary zone glow (Element 3) ---
  /** Starting scale for secondary glow ring (fraction of secR) */
  secondaryGlowStart: 0.6,
  /** Expansion over lifetime */
  secondaryGlowExpand: 0.5,
  /** Fade rate for secondary zone */
  secondaryFadeRate: 1.6,
  /** Fill alpha for secondary zone glow */
  secondaryGlowAlpha: 0.07,

  // --- Projectile-velocity sparks (Element 4) ---
  /** Angular spread in radians (half-width) */
  sparkSpread: 0.5,
  /** Distance multiplier (relative to primR) */
  sparkDistMult: 2.2,
  /** Base particle size */
  sparkSizeBase: 2,
  /** Particle size random range (added to base) */
  sparkSizeRange: 3,
  /** Max trail length (px) */
  sparkTrailMax: 14,

  // --- Entity-velocity smoke (Element 5) ---
  /** Angular spread in radians */
  smokeSpread: 0.8,
  /** Distance multiplier (relative to primR) */
  smokeDistMult: 1.2,
  /** Base particle size */
  smokeSizeBase: 2.5,
  /** Particle size random range */
  smokeSizeRange: 3,
  /** Upward float per progress unit (px) */
  smokeFloatBase: 3,
  /** Max trail length (px) */
  smokeTrailMax: 8,

  // --- Penetration particles (Element 6) ---
  /** Angular spread in radians */
  penSpread: 0.6,
  /** Distance multiplier (relative to primR) */
  penDistMult: 1.8,
  /** Base particle size */
  penSizeBase: 2.5,
  /** Particle size random range */
  penSizeRange: 3,
  /** Max trail length (px) */
  penTrailMax: 12,

  // --- Secondary zone particles (part of Element 3) ---
  /** Angular spread */
  secParticleSpread: 0.9,
  /** Distance multiplier (relative to secR) */
  secParticleDistMult: 0.8,
  /** Base particle size */
  secParticleSizeBase: 2,
  /** Particle size random range */
  secParticleSizeRange: 2.5,
  /** Max trail length (px) */
  secParticleTrailMax: 12,

  // --- MAX-tier embers ---
  /** Base ember count */
  emberCountBase: 6,
  /** Extra embers per unit of (velStr + penStr) */
  emberCountPerStrength: 3,
  /** Ember base size */
  emberSizeBase: 1.2,
  /** Ember size random range */
  emberSizeRange: 1.2,
  /** Upward float distance (px) */
  emberFloat: 10,

  // --- Colors ---
  colors: {
    /** Core outer glow */
    coreGlow: 0xff6600,
    /** Core fireball */
    coreFireball: 0xff8822,
    /** Hot inner core */
    coreHot: 0xffcc44,
    /** White-hot center */
    coreWhite: 0xffffff,
    /** Primary zone glow fill */
    primaryGlow: 0xff6600,
    /** Primary zone ring stroke */
    primaryRing: 0xff8844,
    /** Secondary zone glow fill */
    secondaryGlow: 0xff4400,
    /** Secondary zone ring stroke */
    secondaryRing: 0xff6622,
    /** Secondary zone particle fill */
    secParticle: 0xff7733,
    /** Projectile spark fill */
    sparkFill: 0xffcc44,
    /** Projectile spark bright center */
    sparkCenter: 0xffffff,
    /** Projectile spark trail */
    sparkTrail: 0xff6622,
    /** Smoke puff fill */
    smokeFill: 0x555555,
    /** Smoke puff trail */
    smokeTrail: 0x555555,
    /** Penetration particle fill */
    penFill: 0xff7722,
    /** Penetration particle inner */
    penInner: 0xffaa55,
    /** Penetration trail */
    penTrail: 0xff5500,
    /** Ember outer */
    emberOuter: 0xff6600,
    /** Ember inner */
    emberInner: 0xffcc00,
  },

  // --- DeathEffectsHandler multipliers (sim→render momentum scaling) ---
  /** Multiplier applied to projectile velocity for attacker direction */
  projectileVelMult: 0.15,
  /** Multiplier applied to entity velocity */
  entityVelMult: 20.0,
  /** Multiplier applied to penetration direction */
  penetrationMult: 60.0,
};

// =============================================================================
// DEATH EXPLOSIONS
// =============================================================================

/**
 * Configuration for the unified death explosion renderer.
 * Per-LOD arrays indexed [min, low, med, high, max].
 * Draw call budget: ~3, ~12, ~25, ~55, ~120.
 */
export const DEATH_EXPLOSION = {
  // --- Per-LOD particle counts ---
  /** Core fireball concentric circles */
  coreCircles:       [2,     3,     4,     5,     5]     as readonly number[],
  /** Smoke particles (entity velocity direction) */
  smokeCount:        [0,     3,     4,     6,     8]     as readonly number[],
  /** Debris particles (penetration direction) */
  debrisCount:       [0,     2,     4,     7,     10]    as readonly number[],
  /** Spark particles (attacker direction) */
  sparkCount:        [0,     3,     5,     12,    24]    as readonly number[],
  /** Fragment particles (tight attacker cone, high+ only) */
  fragmentCount:     [0,     0,     0,     8,     15]    as readonly number[],
  /** Chunk particles (penetration direction with gravity, high+ only) */
  chunkCount:        [0,     0,     0,     6,     10]    as readonly number[],
  /** Embers (float up, max only) */
  emberCount:        [0,     0,     0,     0,     12]    as readonly number[],
  /** Momentum trail particles (combined direction, max only) */
  momentumCount:     [0,     0,     0,     0,     12]    as readonly number[],

  // --- Per-particle inner highlight circles ---
  debrisInners:      [0,     0,     1,     1,     2]     as readonly number[],
  sparkInners:       [0,     0,     1,     1,     2]     as readonly number[],
  fragmentInners:    [0,     0,     0,     2,     3]     as readonly number[],
  chunkInners:       [0,     0,     0,     1,     1]     as readonly number[],

  // --- Trail multipliers ---
  smokeTrailMult:    [0,     0,     0,     0.5,   1.0]   as readonly number[],
  debrisTrailMult:   [0,     0,     0,     0.6,   1.0]   as readonly number[],
  sparkTrailMult:    [0,     0,     0,     0.6,   1.0]   as readonly number[],
  sparkDualTrail:    [false, false, false, false, true]   as readonly boolean[],
  fragmentTrailMult: [0,     0,     0,     0.8,   1.0]   as readonly number[],

  // --- Spark distribution ---
  /** Whether sparks go full circle (true) or cone (false) */
  sparkFullCircle:   [false, false, false, true,  true]  as readonly boolean[],
  /** Directional bias for spark cone (higher = tighter cone in attacker dir) */
  sparkDirBias:      [0,     0.5,   0.8,   2.0,   3.0]   as readonly number[],

  // --- Center drift ---
  /** Drift scale per LOD (fraction of radius) */
  driftScale:        [0,     0.15,  0.25,  0.4,   0.5]   as readonly number[],
  /** Smoke upward float (px per progress unit) */
  smokeFloat:        [0,     4,     5,     7,     8]     as readonly number[],

  // --- Strength normalization ---
  strengthNormalize: 300,
  strengthMax: 1.5,
  strengthFloor: 0.3,
  driftNormalize: 400,

  // --- Core fireball ---
  coreExpandMult: 0.6,
  coreFadeRate: 1.3,
  coreGlowScale: 1.15,

  // --- Particle spreads (radians half-width) ---
  smokeSpread: 0.9,
  debrisSpread: 0.7,
  sparkConeSpread: 0.5,
  fragmentSpread: 0.4,
  chunkSpread: 1.2,

  // --- Particle speed ranges ---
  smokeSpeedBase: 0.5,
  smokeSpeedRange: 0.5,
  debrisSpeedBase: 0.7,
  debrisSpeedRange: 0.7,
  sparkSpeedBase: 0.8,
  sparkSpeedRange: 0.8,
  fragmentSpeedBase: 1.5,
  fragmentSpeedRange: 1.5,
  chunkSpeedBase: 0.4,
  chunkSpeedRange: 0.4,

  // --- Particle distance multipliers (relative to radius) ---
  smokeDistMult: 1.4,
  debrisDistMult: 2.0,
  sparkDistMult: 2.5,
  fragmentDistMult: 3.5,
  chunkDistMult: 1.0,

  // --- Particle sizes ---
  smokeSizeBase: 3,
  smokeSizeRange: 4,
  debrisSizeBase: 3,
  debrisSizeRange: 5,
  sparkSizeBase: 2.5,
  sparkSizeRange: 3,
  fragmentSizeBase: 4,
  fragmentSizeRange: 4,
  chunkSizeBase: 3,
  chunkSizeRange: 4,
  emberSizeBase: 1.5,
  emberSizeRange: 1.5,
  momentumSizeBase: 3,
  momentumSizeRange: 2,

  // --- Trail max lengths (px) ---
  smokeTrailMax: 10,
  debrisTrailMax: 15,
  sparkTrailMax: 20,
  fragmentTrailMax: 25,

  // --- Gravity / float ---
  chunkGravity: 20,
  emberFloat: 15,

  // --- Colors ---
  colors: {
    // Core
    coreGlow: 0xff6600,
    coreFireball: 0xff8822,
    coreHot: 0xffcc44,
    coreWhite: 0xffffff,
    // Smoke
    smokeFill: 0x444444,
    smokeTrail: 0x555555,
    // Debris
    debrisFill: 0xff7722,
    debrisInner: 0xffaa55,
    debrisTrail: 0xff5500,
    // Sparks
    sparkFill: 0xffdd88,
    sparkInner: 0xffffff,
    sparkTrail: 0xff6622,
    sparkTrailInner: 0xffaa44,
    // Fragments
    fragmentFill: 0xff6600,
    fragmentInner: 0xffcc44,
    fragmentCenter: 0xffffff,
    fragmentTrail: 0xff4400,
    fragmentTrailInner: 0xffaa00,
    // Chunks
    chunkFill: 0x332211,
    chunkInner: 0x664422,
    // Embers
    emberOuter: 0xff6600,
    emberInner: 0xffcc00,
    // Momentum trail
    momentumFill: 0xff8844,
    momentumInner: 0xffcc88,
  },
};

// =============================================================================
// DEATH DEBRIS
// =============================================================================

/**
 * When a unit dies, its visual pieces (legs, treads, body panels, turret barrels)
 * fly apart as line-segment debris. These settings control the physics and decay.
 */
export const DEBRIS_CONFIG = {
  /** Maximum debris fragments alive at once (oldest evicted first) */
  maxFragments: 300,

  // --- Launch velocities ---

  /** Minimum random outward speed (px/sec) */
  randomSpeedMin: 50,
  /** Random speed range added on top of min (px/sec) — actual = min + rand*range */
  randomSpeedRange: 200,

  /** Minimum speed along hit direction (px/sec) — biases debris away from attacker */
  hitBiasMin: 80,
  /** Random range added to hit bias (px/sec) */
  hitBiasRange: 120,

  /** Max angular velocity magnitude (rad/sec) — actual is ±half this value */
  angularSpeedMax: 30,

  // --- Physics decay ---

  /** Per-frame velocity multiplier (0–1). Lower = more drag. Applied to vx, vy, and angular vel. */
  drag: 0.99,

  // --- Color decay ---
  // Single-stage fade: original color → background color

  /** Time constant for baseColor → background fade (ms). Lower = faster disappearance. */
  fadeDecayTau: 800,
};

// =============================================================================
// BUILDING STATS
// =============================================================================

export const BUILDING_STATS = {
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

export const MAP_SETTINGS = {
  game: { width: 2_000, height: 2_000 },
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
export const ZOOM_MIN = 0.2;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 5.0;

/**
 * Zoom multiplier per scroll wheel tick (exponential zoom).
 * Each scroll step multiplies/divides zoom by this factor.
 * 1.15 = 15% change per step, feels consistent at all zoom levels.
 */
export const ZOOM_FACTOR = 1.15;

/** Initial zoom level for the background demo game */
export const ZOOM_INITIAL_DEMO = 1.8;

/** Initial zoom level when a real game starts */
export const ZOOM_INITIAL_GAME = 0.5;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = 6.0;

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = 20.0;

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at each detail level: min, low, medium, high, max.
 *
 * Auto-quality zoom thresholds are computed from ZOOM_MIN/ZOOM_MAX using
 * logarithmic spacing (see graphicsSettings.ts getEffectiveQuality).
 */
export const GRAPHICS_DETAIL_DEFINITIONS = {
  // Leg rendering for widow/daddy/tarantula units
  LEGS: {
    min: 'none',
    low: 'animated',
    medium: 'animated',
    high: 'animated',
    max: 'animated',
  },

  // Tread/wheel animations
  TREADS_ANIMATED: {
    min: false,
    low: false,
    medium: true,
    high: true,
    max: true,
  },

  // Beam rendering style
  // Controls beam line complexity (1-3 layers) and endpoint effects (circles, pulsing, sparks)
  BEAM_STYLE: {
    min: 'simple', // 1 beam line, 1 static endpoint circle
    low: 'simple', // 1 beam line, 1 static endpoint circle
    medium: 'standard', // 2 beam lines, 2 pulsing endpoint circles
    high: 'detailed', // 3 beam lines, 3 pulsing circles + 4 sparks
    max: 'complex', // 3 beam lines, 3 pulsing circles + 6 sparks
  },

  // Beam glow effects (bloom/glow around beams)
  BEAM_GLOW: {
    min: false,
    low: false,
    medium: false,
    high: true,
    max: true,
  },

  // Antialiasing (requires game restart to take effect)
  ANTIALIAS: {
    min: false,
    low: false,
    medium: false,
    high: false,
    max: false,
  },

  // Burn mark cutoff — how close to background color before marks stop drawing
  // Lower values = marks linger longer, higher = fewer draw calls
  BURN_MARK_ALPHA_CUTOFF: {
    min: 0.08,
    low: 0.08,
    medium: 0.08,
    high: 0.08,
    max: 0.08,
  },

  // Burn mark sample interval — frames to skip between placing new burn marks
  // 0 = every frame, 1 = every other frame, 3 = every 4th frame, etc.
  BURN_MARK_FRAMES_SKIP: {
    min: 5,
    low: 5,
    medium: 4,
    high: 2,
    max: 0,
  },

  // Force field visual style
  // 'minimal': faint fill only, 'simple': fill + particles,
  // 'normal': fill + particles, 'enhanced': fill + dense particles + wavy arcs
  FORCE_FIELD_STYLE: {
    min: 'minimal',
    low: 'simple',
    medium: 'normal',
    high: 'normal',
    max: 'normal',
  },
} as const;
