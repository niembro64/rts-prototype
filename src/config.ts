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

/** Keyframe ratio: fraction of snapshots that are full keyframes. 1 = ALL, 0 = NONE (after first). Default 1e-2 (every 100th). */
export const DEFAULT_KEYFRAME_RATIO = 0.01;

/** Available keyframe ratio options for the FULLSNAP UI control */
export const KEYFRAME_RATIO_OPTIONS: readonly (number | 'ALL' | 'NONE')[] = [
  'ALL',
  0.1, // 1e-1
  0.01, // 1e-2
  0.001, // 1e-3
  0.0001, // 1e-4
  0.00001, // 1e-5
  'NONE',
] as const;

export type KeyframeRatio = number | 'ALL' | 'NONE';

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

/**
 * Maximum total units across all players.
 * This is divided evenly among players (e.g., 120 total / 2 players = 60 each)
 */
export const MAX_TOTAL_UNITS = 120;

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
 * HIT = push on the TARGET when struck
 * FIRE = recoil on the SHOOTER when firing
 */
export const KNOCKBACK = {
  BEAM_HIT: 750,
  BEAM_FIRE: 200,
  FORCE_FIELD_PULL_MULTIPLIER: 2.0, // Multiplier applied to each weapon's pullPower
  SPLASH: 250, // Knockback multiplier for area/splash explosions (mortar/disruptor)
};

/**
 * Default turret acceleration for weapons that don't specify their own.
 * Units: radians/sec² - how fast the turret speeds up its rotation.
 * Higher = snappier turret response.
 */
export const DEFAULT_TURRET_TURN_ACCEL = 40;

/**
 * Default turret drag for weapons that don't specify their own.
 * Applied per frame as: velocity *= (1 - drag)
 * Higher drag = slower terminal velocity, quicker stopping.
 * Terminal velocity ≈ accel / (60 * drag) at 60fps
 */
export const DEFAULT_TURRET_DRAG = 0.15;

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
  see: 1.2,
  fire: 1.0,
  release: 0.9,
  lock: 0.8,
  fightstop: 0.7,
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
export type ForceFieldTurretShape = 'triangle' | 'line' | 'square' | 'hexagon' | 'circle';

export interface ForceFieldTurretConfig {
  shape: ForceFieldTurretShape; // piece geometry
  count: number;                // number of pieces
  length: number;               // how far turret extends (× radius)
  width: number;                // max half-width of base piece (× radius)
  taper: number;                // 0→1: tip shrinks to (1−taper) of base; also compresses spacing
  baseOffset: number;           // where first piece sits (fraction of length)
  originOffset: number;         // mount point offset along turret axis (× radius)
  thickness: number;            // line width (px), used for 'line' shape
  reversePhase: boolean;        // true: phase offsets run tip→base instead of base→tip
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
// LEG RENDERING
// =============================================================================

/**
 * Per-unit-style leg rendering configuration.
 * thickness: line width of leg segments (px)
 * footSize: foot circle radius as fraction of unit collision radius
 * lerpDuration: time in ms for foot to slide to new position (lower = snappier)
 */
export const LEG_CONFIG = {
  widow: { thickness: 6, footSize: 0.1, lerpDuration: 600 },
  daddy: { thickness: 2, footSize: 0.14, lerpDuration: 300 },
  tarantula: { thickness: 4, footSize: 0.12, lerpDuration: 200 },
  recluse: { thickness: 1.5, footSize: 0.08, lerpDuration: 160 },
  commander: { thickness: 6, footSize: 0.15, lerpDuration: 400 },
};

/**
 * Per-unit tread rendering configuration (2 treads: left/right).
 * All values are multipliers of unit collision radius.
 * treadOffset: lateral distance from center to tread center
 * treadLength: length of tread rectangle
 * treadWidth: width of tread rectangle
 * wheelRadius: internal wheel radius for rotation animation
 * rotationSpeed: visual rotation multiplier (higher = treads spin faster)
 */
export const TREAD_CONFIG = {
  mammoth: {
    treadOffset: 0.9,
    treadLength: 2.0,
    treadWidth: 0.6,
    wheelRadius: 0.175,
    rotationSpeed: 1.0,
  },
  badger: {
    treadOffset: 0.85,
    treadLength: 1.7,
    treadWidth: 0.55,
    wheelRadius: 0.12,
    rotationSpeed: 1.0,
  },
  lynx: {
    treadOffset: 0.8,
    treadLength: 1.6,
    treadWidth: 0.45,
    wheelRadius: 0.12,
    rotationSpeed: 1.0,
  },
};

/**
 * Per-unit wheel rendering configuration (4 wheels).
 * All values are multipliers of unit collision radius.
 * wheelDistX: forward/back distance from center to wheel
 * wheelDistY: lateral distance from center to wheel
 * treadLength: length of drawn mini-tread at each wheel
 * treadWidth: width of drawn mini-tread at each wheel
 * wheelRadius: wheel radius for rotation animation
 * rotationSpeed: visual rotation multiplier (higher = wheels spin faster)
 */
export const WHEEL_CONFIG = {
  jackal: {
    wheelDistX: 0.6,
    wheelDistY: 0.7,
    treadLength: 0.5,
    treadWidth: 0.15,
    wheelRadius: 0.28,
    rotationSpeed: 1.0,
  },
  mongoose: {
    wheelDistX: 0.65,
    wheelDistY: 0.7,
    treadLength: 0.5,
    treadWidth: 0.3,
    wheelRadius: 0.22,
    rotationSpeed: 1.0,
  },
};

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

// =============================================================================
// COMMANDER STATS
// =============================================================================

export const COMMANDER_STATS = {
  hp: 500,
  moveSpeed: 200,
  collisionRadius: 20,
  mass: 60, // Heavy commander unit
  buildRange: 150,
  dgunCost: 200,
};

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

// =============================================================================
// UNIT STATS (base values before any multipliers)
// =============================================================================
/**
 * UNIT VALUE FUNCTION - Sophisticated cost balancing
 *
 * Each unit's cost is derived from:
 *   Value = (EffectiveDPS × TacticalModifier) + (Survivability × DefenseWeight)
 *
 * Where:
 *   - EffectiveDPS = RawDPS × HitReliability (spread weapons less reliable)
 *   - TacticalModifier = RangeFactor × SpecialAbilityMult (splash=2×, pierce=1.3×)
 *   - Survivability = HP × SpeedFactor (fast units survive longer)
 *   - DefenseWeight = 0.5 (offense valued more than defense)
 *
 * DPS Calculations:
 *   Scout:  4dmg / 0.08s = 50 DPS
 *   Burst:  54dmg / 1.2s = 45 DPS (3×18 burst)
 *   Beam:   45 DPS (continuous beam, short 140 range)
 *   Brawl:  72dmg / 0.9s = 80 DPS max (6×12 pellets, ~60 effective)
 *   Mortar: 80dmg / 2.5s = 32 DPS (but splash doubles effective)
 *   Snipe:  55dmg / 3.2s = 17 DPS (instant flash, 350 range, piercing)
 *   Tank:   120dmg / 3.0s = 40 DPS
 */

export const UNIT_STATS = {
  // Jackal - Disposable swarm unit. High DPS (50) but dies fast.
  // Value: Fast harassment, good vs slow units, countered by splash
  jackal: {
    baseCost: 25,
    hp: 40,
    moveSpeed: 300,
    collisionRadius: 8,
    mass: 10,
  },
  // Lynx - Glass cannon striker. Burst damage (54 per volley), fragile.
  // Value: Alpha strike potential, but slow and squishy
  lynx: {
    baseCost: 40,
    hp: 65,
    moveSpeed: 170,
    collisionRadius: 10,
    mass: 15,
  },
  // Daddy - Heavy beam walker. Mega beam, sustained DPS but VERY slow turret tracking.
  // Value: Good vs slow/stationary targets, struggles vs fast units
  daddy: {
    baseCost: 105,
    hp: 60,
    moveSpeed: 200,
    collisionRadius: 13,
    mass: 25,
  },
  // Badger - Tanky shotgunner. High burst (72 dmg) but must close to 90 range.
  // Value: Wins close fights, but takes damage closing the gap
  badger: {
    baseCost: 70,
    hp: 240,
    moveSpeed: 200,
    collisionRadius: 16,
    mass: 200,
  },
  // Mongoose - Area denial artillery. Splash damage, slow projectile.
  // Value: Excellent vs groups, but can be dodged, mediocre vs single targets
  mongoose: {
    baseCost: 85,
    hp: 100,
    moveSpeed: 220,
    collisionRadius: 14,
    mass: 35,
  },
  // Recluse - Long-range assassin spider. Hitscan piercing, but low DPS (17) and can't escape.
  // Value: Safe poke damage, but very slow and fragile if caught
  recluse: {
    baseCost: 55,
    hp: 25,
    moveSpeed: 200,
    collisionRadius: 11,
    mass: 9,
  },
  // Mammoth - Heavy siege unit. Massive HP (350), high damage (73 DPS), long range.
  // Value: Frontline anchor, wins attrition fights, slow to reposition
  mammoth: {
    baseCost: 260,
    hp: 1050,
    moveSpeed: 60,
    collisionRadius: 24,
    mass: 500,
  },
  // Widow - Titan spider unit. 6 beam weapons + force field.
  // Value: Army-in-one super unit, but expensive and high priority target
  widow: {
    baseCost: 600,
    hp: 3000,
    moveSpeed: 100,
    collisionRadius: 38,
    mass: 800,
  },
  // Tarantula - Force field AoE unit. Continuous damage with pull.
  // Value: Anti-swarm, area denial, but must get moderately close for full effect
  tarantula: {
    baseCost: 35,
    hp: 200,
    moveSpeed: 200,
    collisionRadius: 11,
    mass: 18,
  },
};

// =============================================================================
// PROJECTILE STATS — what the projectile IS
// =============================================================================

export const PROJECTILE_STATS = {
  lightRound: {
    damage: 1,
    speed: 200,
    mass: 0.3,
    radius: 2,
    lifespan: 600,
    primaryDamageRadius: 5,
    secondaryDamageRadius: 10,
    splashOnExpiry: false,
  },
  pulseBolt: {
    damage: 6,
    speed: 200,
    mass: 0.6,
    radius: 3,
    lifespan: 600,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
  },
  buckshot: {
    damage: 5,
    speed: 250,
    mass: 4,
    radius: 4,
    lifespan: 300,
    primaryDamageRadius: 10,
    secondaryDamageRadius: 18,
    splashOnExpiry: false,
  },
  mortarShell: {
    damage: 80,
    speed: 200,
    mass: 2.0,
    radius: 7,
    lifespan: 2000,
    primaryDamageRadius: 70,
    secondaryDamageRadius: 110,
    splashOnExpiry: true,
  },
  cannonShell: {
    damage: 260,
    speed: 400,
    mass: 3.0,
    radius: 10,
    lifespan: 1800,
    primaryDamageRadius: 25,
    secondaryDamageRadius: 45,
    splashOnExpiry: true,
  },
  railBeam: {
    damage: 10,
    beamDuration: 100,
    beamWidth: 1,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
    piercing: true as const,
  },
  laserBeam: {
    damage: 85,
    beamDuration: 1000,
    beamWidth: 4,
    collisionRadius: 8,
    primaryDamageRadius: 12,
    secondaryDamageRadius: 60,
    splashOnExpiry: false,
  },
  heavyLaserBeam: {
    damage: 100,
    beamDuration: 1000,
    beamWidth: 6,
    collisionRadius: 8,
    primaryDamageRadius: 12,
    secondaryDamageRadius: 20,
    splashOnExpiry: false,
  },
  disruptorBolt: {
    damage: 9999,
    speed: 350,
    mass: 20.0,
    radius: 25,
    lifespan: 2000,
    primaryDamageRadius: 40,
    secondaryDamageRadius: 70,
    splashOnExpiry: true,
    piercing: true as const,
  },
};

// =============================================================================
// WEAPON STATS — how the weapon DELIVERS the projectile
// =============================================================================

export const WEAPON_STATS = {
  gatling: {
    projectile: 'lightRound' as const,
    audioId: 'minigun' as const,
    range: 110,
    cooldown: 80,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  pulse: {
    projectile: 'pulseBolt' as const,
    audioId: 'burst-rifle' as const,
    range: 160,
    cooldown: 1200,
    burstCount: 3,
    burstDelay: 40,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  shotgun: {
    projectile: 'buckshot' as const,
    audioId: 'shotgun' as const,
    range: 90,
    cooldown: 100,
    pelletCount: 2,
    spreadAngle: Math.PI / 2,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  mortar: {
    projectile: 'mortarShell' as const,
    audioId: 'grenade' as const,
    range: 200,
    cooldown: 2500,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  cannon: {
    projectile: 'cannonShell' as const,
    audioId: 'cannon' as const,
    range: 360,
    cooldown: 3000,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  railgun: {
    projectile: 'railBeam' as const,
    audioId: 'railgun' as const,
    range: 250,
    cooldown: 2000,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  beam: {
    projectile: 'laserBeam' as const,
    audioId: 'beam' as const,
    range: 150,
    cooldown: 0,
    turretTurnAccel: 100,
    turretDrag: 0.4,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  megaBeam: {
    projectile: 'heavyLaserBeam' as const,
    audioId: 'beam' as const,
    range: 180,
    cooldown: 0,
    turretTurnAccel: 100,
    turretDrag: 0.65,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },

  // Force fields — no projectile, damage applied directly
  // Inner/middle radii are ratios of range (the outer/fire radius)
  forceField: {
    audioId: 'force-field' as const,
    range: SPATIAL_GRID_CELL_SIZE * 0.9,
    cooldown: 0,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    forceFieldAngle: Math.PI * 2,
    forceFieldTransitionTime: 300,
    push: {
      innerRatio: 0.0,
      outerRatio: 0.65,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: 1000,
      damage: 1,
    },
    pull: {
      innerRatio: 0.65,
      outerRatio: 0.7,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: null,
      damage: 1,
    },
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
  megaForceField: {
    audioId: 'force-field' as const,
    range: SPATIAL_GRID_CELL_SIZE * 0.9,
    cooldown: 0,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    forceFieldAngle: Math.PI * 2,
    forceFieldTransitionTime: 1000,
    push: {
      innerRatio: 0.0,
      outerRatio: 0.65,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: 1000,
      damage: 1,
    },
    pull: {
      innerRatio: 0.65,
      outerRatio: 0.7,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: null,
      damage: 1,
    },
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },

  disruptor: {
    projectile: 'disruptorBolt' as const,
    audioId: 'cannon' as const,
    range: 150,
    cooldown: 0,
    rangeMultipliers: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
  },
};

// =============================================================================
// MAP SIZE SETTINGS
// =============================================================================

export const MAP_SETTINGS = {
  game: { width: 2_000, height: 2_000 },
  demo: { width: 1_600, height: 9_00 },
};

// =============================================================================
// UNIT SHORT NAMES (for compact UI buttons)
// =============================================================================

export const UNIT_SHORT_NAMES: Record<string, string> = {
  jackal: 'JKL',
  lynx: 'LNX',
  daddy: 'DDY',
  badger: 'BDG',
  mongoose: 'MGS',
  recluse: 'RCL',
  mammoth: 'MMT',
  widow: 'WDW',
  tarantula: 'TRN',
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

// =============================================================================
// NETWORKING
// =============================================================================

export type SnapshotRate = number | 'realtime';

/**
 * Default snapshot rate. 'realtime' emits inline every frame (~60Hz).
 * Numeric values use a setInterval at the given Hz.
 */
export const DEFAULT_SNAPSHOT_RATE: SnapshotRate = 'realtime';

/** Available options for the "Send Updates Per Second" UI control */
export const SNAPSHOT_RATE_OPTIONS: readonly SnapshotRate[] = [
  1,
  5,
  10,
  20,
  30,
  45,
  60,
  'realtime',
] as const;

// =============================================================================
// AUDIO
// =============================================================================

/** Enable or disable the continuous laser beam sound effect */
export const LASER_SOUND_ENABLED = false;

// =============================================================================
// UI
// =============================================================================

/** Maximum number of combat stats snapshots to retain (~10Hz → 600 = ~1 minute) */
export const COMBAT_STATS_HISTORY_MAX = 100;

/** Whether the Combat Statistics modal is visible on page load */
export const COMBAT_STATS_VISIBLE_ON_LOAD = false;

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

/** Minimum zoom level (zoomed out) */
export const ZOOM_MIN = 0.5;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 5.0;

/**
 * Zoom multiplier per scroll wheel tick (exponential zoom).
 * Each scroll step multiplies/divides zoom by this factor.
 * 1.15 = 15% change per step, feels consistent at all zoom levels.
 */
export const ZOOM_FACTOR = 1.15;

/** Initial zoom level for the background demo game */
export const ZOOM_INITIAL_DEMO = 1.32;

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

  // Explosion style
  EXPLOSIONS: {
    min: 'one-simple-circle',
    low: 'one-simple-circle',
    medium: 'three-velocity-circles',
    high: 'three-velocity-chunks',
    max: 'three-velocity-complex',
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
    medium: true,
    high: true,
    max: true,
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
