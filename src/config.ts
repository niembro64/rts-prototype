/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

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
 * Knockback force multiplier applied when projectiles/lasers hit units.
 * Force = damage * KNOCKBACK_FORCE_MULTIPLIER
 * 0 = no knockback, higher = more knockback
 */
export const KNOCKBACK_FORCE_MULTIPLIER = 150;

/**
 * Pull strength for sonic wave weapons (units per second toward wave origin).
 * Higher = stronger pull effect.
 */
export const WAVE_PULL_STRENGTH = 180;

/**
 * Show the pie-chart debug zone visualization for sonic wave weapons.
 * When true, renders a faint filled pie slice and border showing the exact effect area.
 * Useful for debugging/tuning wave weapon ranges and angles.
 */
export const SONIC_WAVE_DEBUG_ZONE = false;

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
// BUILDING STATS
// =============================================================================

export const BUILDING_STATS = {
  solar: {
    baseCost: 100, // Base energy cost (before multiplier)
    hp: 200,
    buildRate: 30, // Max energy/sec commander can spend building this
  },
  factory: {
    baseCost: 300, // Base energy cost (before multiplier)
    hp: 800,
    buildRate: 40, // Max energy/sec commander can spend building this
    unitBuildRate: 50, // Max energy/sec factory spends producing units
  },
};

// =============================================================================
// COMMANDER STATS
// =============================================================================

export const COMMANDER_STATS = {
  hp: 500,
  moveSpeed: 800,
  collisionRadius: 20,
  mass: 60,           // Heavy commander unit
  buildRate: 50,
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
export const UNIT_MASS_MULTIPLIER = 5.0;

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
  // Scout - Disposable swarm unit. High DPS but dies fast.
  scout: {
    baseCost: 35,
    hp: 40,
    moveSpeed: 360,
    collisionRadius: 8,
    mass: 10,        // Light and zippy
    buildRate: 70,
  },
  // Burst - Glass cannon striker. High alpha, fragile.
  burst: {
    baseCost: 175,
    hp: 65,
    moveSpeed: 130,
    collisionRadius: 10,
    mass: 15,
    buildRate: 55,
  },
  // Daddy - Balanced baseline. Reliable sustained damage.
  daddy: {
    baseCost: 500,
    hp: 100,
    moveSpeed: 200,
    collisionRadius: 13,
    mass: 25,       // Medium baseline
    buildRate: 45,
  },
  // Brawl - Tanky brawler. High damage but must close distance.
  brawl: {
    baseCost: 110,
    hp: 180,
    moveSpeed: 200,
    collisionRadius: 16,
    mass: 45,       // Heavy brawler
    buildRate: 40,
  },
  // Shotgun - Area denial artillery. Splash damage.
  shotgun: {
    baseCost: 150,
    hp: 100,
    moveSpeed: 220,
    collisionRadius: 14,
    mass: 35,
    buildRate: 32,
  },
  // Snipe - Long-range assassin. Fragile but safe engagement range.
  snipe: {
    baseCost: 140,
    hp: 55,
    moveSpeed: 70,
    collisionRadius: 11,
    mass: 20,       // Light sniper
    buildRate: 28,
  },
  // Tank - Heavy siege unit. Massive HP compensates for slow speed.
  tank: {
    baseCost: 280,
    hp: 350,
    moveSpeed: 5000,
    collisionRadius: 24,
    mass: 500,       // Heavy tank
    buildRate: 18,
  },
  // Widow - Titan spider unit. 6 beam lasers + 1 sonic wave, 8 legs.
  widow: {
    baseCost: 600,
    hp: 1200,
    moveSpeed: 1000,
    collisionRadius: 38,
    mass: 240,      // Massive titan
    buildRate: 8,
  },
  // Insect - Small 4-legged unit with continuous wave AoE damage.
  insect: {
    baseCost: 90,
    hp: 80,
    moveSpeed: 200,
    collisionRadius: 11,
    mass: 18,
    buildRate: 50,
  },
};

// =============================================================================
// WEAPON STATS
// =============================================================================

export const WEAPON_STATS = {
  // Scout - Rapid fire, low damage per shot
  scout: {
    damage: 4,
    range: 140,
    cooldown: 80,
    projectileSpeed: 650,
  },

  // Burst - 3-shot burst, medium damage
  burst: {
    damage: 18,
    range: 160,
    cooldown: 1200,
    projectileSpeed: 600,
    burstCount: 3,
    burstDelay: 60,
  },

  // Brawl - Shotgun spread, high close-range damage
  brawl: {
    damage: 12,            // Per pellet
    range: 90,
    cooldown: 900,
    projectileSpeed: 450,
    pelletCount: 6,
  },

  // Shotgun - Slow, high splash damage artillery
  shotgun: {
    damage: 80,
    range: 200,
    cooldown: 2500,
    projectileSpeed: 250,
    splashRadius: 70,
  },

  // Tank - Slow, devastating heavy cannon
  tank: {
    damage: 220,
    range: 360,
    cooldown: 3000,
    projectileSpeed: 300,
  },

  // Snipe - Instant flash hitscan, long range, piercing
  snipe: {
    damage: 55,
    range: 350,
    cooldown: 3200,
    beamDuration: 20,      // Instant flash
    beamWidth: 2,
  },

  // Daddy - Continuous damage beam (daddy long legs unit)
  daddy: {
    damage: 45,            // DPS while beam is on target
    range: 140,
    cooldown: 0,           // Continuous
    beamDuration: 1500,
    beamWidth: 4,
  },

  // Widow beam lasers - extended range continuous beams
  widowBeam: {
    damage: 45,
    range: 210,
    cooldown: 0,           // Continuous
    beamDuration: 1500,
    beamWidth: 4,
  },

  // Insect - Continuous pie-slice wave AoE
  insect: {
    damage: 20,            // Base DPS (scales with 1/distance)
    range: 500,
    cooldown: 0,           // Continuous
    trackingRange: 600,    // Turret tracks at this range
    engageRange: 400,      // Unit stops in fight mode at this range
    rotationRate: 0.1,     // Turret turn speed (radians/sec)
    waveAngleIdle: 0,
    waveAngleAttack: Math.PI * 0.5,
    waveTransitionTime: 2000,
    pullPower: 180,
  },

  // Widow sonic wave - larger pie-slice wave AoE
  widowSonic: {
    damage: 20,            // Base DPS (scales with 1/distance)
    range: 900,
    cooldown: 0,           // Continuous
    trackingRange: 1000,   // Turret tracks at this range
    engageRange: 800,      // Unit stops in fight mode at this range
    rotationRate: 0.1,     // Turret turn speed (radians/sec)
    waveAngleIdle: 0,
    waveAngleAttack: Math.PI * 0.75,
    waveTransitionTime: 500,
    pullPower: 300,
  },

  // D-gun - Commander special weapon
  dgun: {
    damage: 9999,
    range: 150,
    cooldown: 0,           // No cooldown (energy-limited)
    projectileSpeed: 350,
    splashRadius: 40,
  },

  // Widow - Multi-weapon titan (placeholder, uses widowBeam + widowSonic)
  widow: {
    damage: 0,
    range: 350,
    cooldown: 0,
    beamCount: 6,
  },
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

// =============================================================================
// NETWORKING
// =============================================================================

/**
 * Default updates per second for network state broadcasts.
 * Can be changed by host during gameplay via UI.
 * Options: 1, 5, 10, 30
 */
export const DEFAULT_NETWORK_UPDATES_PER_SECOND = 10;

// =============================================================================
// AUDIO
// =============================================================================

/** Enable or disable the continuous laser beam sound effect */
export const LASER_SOUND_ENABLED = false;

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

/** Minimum zoom level (zoomed out) */
export const ZOOM_MIN = 0.1;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 5.0;

/** Zoom change per scroll wheel tick */
export const ZOOM_STEP = 0.1;

/** Initial zoom level when game starts */
export const ZOOM_INITIAL = 0.4;

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at LOW, MEDIUM, and HIGH detail levels.
 *
 * AUTO_ZOOM_START: Zoom threshold where each detail level begins
 *   - low: 0.0 means low detail from zoom 0 until medium kicks in
 *   - medium: 0.3 means medium detail starts at zoom 0.3
 *   - high: 1.0 means high detail starts at zoom 1.0
 */
export const GRAPHICS_DETAIL_DEFINITIONS = {
  // Zoom thresholds for auto quality (zoom level where each tier starts)
  AUTO_ZOOM_START: {
    low: 0.0,
    medium: 0.6,
    high: 1.0,
    extra: 2.0,
  },

  // Leg rendering for arachnid/daddy/insect units
  LEGS: {
    low: 'none',
    medium: 'animated',
    high: 'animated',
    extra: 'animated',
  },

  // Explosion style
  EXPLOSIONS: {
    low: 'one-simple-circle',
    medium: 'three-velocity-circles',
    high: 'three-velocity-chunks',
    extra: 'three-velocity-complex',
  },

  // Tread/wheel animations
  TREADS_ANIMATED: {
    low: false,
    medium: true,
    high: true,
    extra: true,
  },

  // Beam rendering style
  // Controls beam line complexity (1-3 layers) and endpoint effects (circles, pulsing, sparks)
  BEAM_STYLE: {
    low: 'simple',           // 1 beam line, 1 static endpoint circle
    medium: 'standard',      // 2 beam lines, 2 pulsing endpoint circles
    high: 'detailed',        // 3 beam lines, 3 pulsing circles + 4 sparks
    extra: 'complex',        // 3 beam lines, 3 pulsing circles + 6 sparks
  },

  // Beam glow effects (extra bloom/glow around beams)
  BEAM_GLOW: {
    low: false,
    medium: false,
    high: true,
    extra: true,
  },

  // Antialiasing (requires game restart to take effect)
  ANTIALIAS: {
    low: false,
    medium: true,
    high: true,
    extra: true,
  },
} as const;

// =============================================================================
// BALANCE SUMMARY
// =============================================================================
/**
 * Current balance at a glance:
 *
 * INCOME:
 * - Base: 10 energy/sec
 * - Per solar: +50 energy/sec
 * - With 3 solars: 10 + 150 = 160 energy/sec
 *
 * BUILD RATES:
 * - Commander builds at: 50 energy/sec
 * - Factory produces at: 50 energy/sec
 * - Both together: 100 energy/sec max spending
 *
 * UNIT COSTS & DPS (ordered by cost):
 * | Unit     | Cost | HP   | Speed | DPS | Range | Special              |
 * |----------|------|------|-------|-----|-------|----------------------|
 * | Scout    |   35 |   40 |  160  |  50 | 140   | Fast swarm           |
 * | Burst    |   75 |   65 |  130  |  45 | 160   | 3-shot burst         |
 * | Insect   |   90 |   80 |  110  |  40 | 150   | 30° wave AoE         |
 * | Daddy    |  100 |  100 |  100  |  45 | 140   | Continuous beam      |
 * | Brawl    |  110 |  180 |   80  |  60 |  90   | 6 pellets            |
 * | Snipe    |  140 |   55 |   70  |  17 | 350   | Instant flash, pierce|
 * | Shotgun  |  150 |  100 |   60  |  32 | 200   | Splash (70r)         |
 * | Tank     |  280 |  350 |   40  |  40 | 260   | Heavy hitter         |
 * | Widow    | 1000 | 1200 |   25  | 310 | 350   | 6 beam + sonic       |
 *
 * BUILDING COSTS:
 * - Solar: 100 energy (2 sec to build)
 * - Factory: 300 energy (6 sec to build)
 */
