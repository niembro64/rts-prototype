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
export const EXPLOSION_VELOCITY_MULTIPLIER = 300.0;

/**
 * Multiplier for the impact force/damage direction.
 * Explosions will bias toward the direction the killing blow pushed them.
 * This uses the knockback force from the weapon that killed them.
 * 0 = ignore impact, 1.0 = realistic, 5.0+ = exaggerated
 */
export const EXPLOSION_IMPACT_FORCE_MULTIPLIER = 800.0;

/**
 * Multiplier for the attacker's projectile/beam direction.
 * Explosions will bias in the direction the projectile was traveling.
 * For beams, this is the direction from attacker to target.
 * 0 = ignore attacker direction, 1.0 = realistic, 5.0+ = exaggerated
 */
export const EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER = 500.0;

/**
 * Base explosion momentum even when all factors are zero.
 * Adds a minimum "oomph" to all explosions regardless of context.
 * This is raw velocity units added to the final momentum.
 */
export const EXPLOSION_BASE_MOMENTUM = 50;

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
  moveSpeed: 80,
  collisionRadius: 20,
  mass: 60,           // Heavy commander unit
  buildRate: 50,
  buildRange: 150,
  dgunCost: 200,
};

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
    moveSpeed: 260,
    collisionRadius: 8,
    mass: 1,        // Light and zippy
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
    moveSpeed: 100,
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
    moveSpeed: 200,
    collisionRadius: 24,
    mass: 50,       // Heavy tank
    buildRate: 18,
  },
  // Widow - Titan spider unit. 6 beam lasers + 1 sonic wave, 8 legs.
  widow: {
    baseCost: 600,
    hp: 1200,
    moveSpeed: 1000,
    collisionRadius: 38,
    mass: 50,      // Massive titan
    buildRate: 8,
  },
  // Insect - Small 4-legged unit with continuous wave AoE damage.
  insect: {
    baseCost: 90,
    hp: 80,
    moveSpeed: 100,
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
    cooldown: 80, // Very fast fire rate
    projectileSpeed: 650,
  },
  // Burst - 3-shot burst, medium damage
  burst: {
    damage: 18,
    range: 160,
    cooldown: 1200,
    burstCount: 3,
    burstDelay: 60,
    projectileSpeed: 600,
  },
  // Daddy - Continuous damage beam, shorter range (daddy long legs unit)
  daddy: {
    damage: 45, // Damage per second while beam is on target
    range: 140, // Short range - must get close
    cooldown: 0, // Continuous firing
    beamDuration: 1500, // Long sustained beam
    beamWidth: 4,
  },
  // Brawl - Shotgun spread, high close-range damage
  brawl: {
    damage: 12, // Per pellet
    range: 90,
    cooldown: 900,
    pelletCount: 6,
    projectileSpeed: 450,
  },
  // Shotgun - Slow, high splash damage artillery
  shotgun: {
    damage: 80,
    range: 200,
    cooldown: 2500,
    projectileSpeed: 250,
    splashRadius: 70,
  },
  // Snipe - Instant flash hitscan, moderate damage, long range, piercing
  snipe: {
    damage: 55, // Moderate single-shot damage
    range: 350, // Very long range sniper
    cooldown: 3200, // Long cooldown between shots
    beamDuration: 20, // Instant flash
    beamWidth: 2,
  },
  // Tank - Slow, devastating heavy cannon
  tank: {
    damage: 220,
    range: 360,
    cooldown: 3000,
    projectileSpeed: 300,
  },
  // D-gun (commander special)
  dgun: {
    damage: 9999,
    range: 150,
    projectileSpeed: 350,
    splashRadius: 40,
  },
  // Widow - Multi-weapon titan (6 beam lasers + 1 sonic)
  // This config is for the primary weapon slot; sub-weapons are handled specially
  widow: {
    damage: 0, // Placeholder - actual damage from sub-weapons
    range: 350, // Max range (beam range with 1.5x multiplier)
    cooldown: 0, // Multi-weapon system handles its own cooldowns
    // Sub-weapon counts
    beamCount: 6, // 6 continuous beam lasers
  },
  // Insect - Continuous pie-slice AoE with expanding/contracting effect
  // Interpolates between idle and attack angles based on firing state
  insect: {
    damage: 40, // Base DPS at point-blank
    range: 150, // Maximum range of the wave slice
    cooldown: 0, // Continuous (always on when targeting)
    waveAngleIdle: 0, // Angle when not firing (narrow beam)
    waveAngleAttack: Math.PI / 6, // Angle when firing (30° slice for baby unit)
    waveTransitionTime: 2000, // Time (ms) to transition between idle and attack
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
