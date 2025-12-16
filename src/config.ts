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
  collisionRadius: 20, // Hitbox size for physics/collision
  buildRate: 50, // Max energy/sec for construction
  buildRange: 150, // Max distance to build
  dgunCost: 200, // Energy cost per D-gun shot
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
  // Value: 50 DPS × 0.82 range × (40 HP × 1.26 speed) = ~20 → Cost: 35
  scout: {
    baseCost: 35,
    hp: 40,
    moveSpeed: 160,
    collisionRadius: 8, // Hitbox size for physics/collision
    buildRate: 70, // Very fast production
  },
  // Burst - Glass cannon striker. High alpha, fragile.
  // Value: 45 DPS × 0.94 range × 1.2 burst × (70 HP × 1.14 speed) = ~41 → Cost: 75
  burst: {
    baseCost: 75,
    hp: 65,
    moveSpeed: 130,
    collisionRadius: 10,
    buildRate: 55,
  },
  // Beam - Balanced baseline. Reliable sustained damage.
  // Value: 45 DPS × 1.0 range × (100 HP × 1.0 speed) = 45 → Cost: 100 (baseline)
  beam: {
    baseCost: 100,
    hp: 100,
    moveSpeed: 100,
    collisionRadius: 13,
    buildRate: 45,
  },
  // Brawl - Tanky brawler. High damage but must close distance.
  // Value: 60 effective DPS × 0.53 range × (160 HP × 0.92 speed) = ~47 → Cost: 110
  brawl: {
    baseCost: 110,
    hp: 180,
    moveSpeed: 80,
    collisionRadius: 16,
    buildRate: 40,
  },
  // Mortar - Area denial artillery. Splash doubles effective damage.
  // Value: 32 DPS × 1.18 range × 2.0 splash × (100 HP × 0.81 speed) = ~61 → Cost: 150
  mortar: {
    baseCost: 150,
    hp: 100,
    moveSpeed: 60,
    collisionRadius: 14,
    buildRate: 32,
  },
  // Snipe - Long-range assassin. Fragile but safe engagement range.
  // Value: 36 DPS × 2.06 range × 1.3 pierce × (55 HP × 0.87 speed) = ~50 → Cost: 140
  snipe: {
    baseCost: 140,
    hp: 55,
    moveSpeed: 70,
    collisionRadius: 11,
    buildRate: 28,
  },
  // Tank - Heavy siege unit. Massive HP compensates for slow speed.
  // Value: 40 DPS × 1.53 range × (350 HP × 0.67 speed) = ~143 → Cost: 280
  tank: {
    baseCost: 280,
    hp: 350,
    moveSpeed: 40,
    collisionRadius: 24,
    buildRate: 18,
  },
  // Arachnid - Titan spider unit. 4 beam lasers + 4 snipe lasers, 8 legs.
  // Combined DPS: 4×45 (beam) + 4×17 (snipe) = ~248 DPS across multiple ranges
  // Extremely slow, massive HP pool, very expensive. Apex predator.
  arachnid: {
    baseCost: 1000,
    hp: 1200,
    moveSpeed: 25,
    collisionRadius: 38,
    buildRate: 8, // Very slow to produce
  },
  // Sonic - Small 4-legged spider with continuous wave AoE damage.
  // Pie-slice damage field with inverse-square falloff (1/d²).
  // High damage up close, fades rapidly with distance.
  sonic: {
    baseCost: 90,
    hp: 80,
    moveSpeed: 110,
    collisionRadius: 11,
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
  // Beam - Continuous damage beam, shorter range
  beam: {
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
  // Mortar - Slow, high splash damage
  mortar: {
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
    damage: 120,
    range: 260,
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
  // Arachnid - Multi-weapon titan (4 beam + 4 snipe lasers)
  // This config is for the primary weapon slot; sub-weapons are handled specially
  arachnid: {
    damage: 0, // Placeholder - actual damage from sub-weapons
    range: 350, // Max range (snipe range)
    cooldown: 0, // Multi-weapon system handles its own cooldowns
    // Sub-weapon counts
    beamCount: 4, // 4 continuous beam lasers
    snipeCount: 4, // 4 sniper lasers
  },
  // Sonic - Continuous pie-slice AoE with expanding/contracting effect
  // Interpolates between idle and attack angles based on firing state
  sonic: {
    damage: 40, // Base DPS at point-blank
    range: 150, // Maximum range of the wave slice
    cooldown: 0, // Continuous (always on when targeting)
    waveAngleIdle: 0, // Angle when not firing (narrow beam)
    waveAngleAttack: Math.PI, // Angle when firing (45° wide slice)
    waveTransitionTime: 2000, // Time (ms) to transition between idle and attack
  },
};

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
 * | Beam     |  100 |  100 |  100  |  45 | 140   | Continuous beam      |
 * | Brawl    |  110 |  180 |   80  |  60 |  90   | 6 pellets            |
 * | Snipe    |  140 |   55 |   70  |  17 | 350   | Instant flash, pierce|
 * | Mortar   |  150 |  100 |   60  |  32 | 200   | Splash (70r)         |
 * | Tank     |  280 |  350 |   40  |  40 | 260   | Heavy hitter         |
 * | Arachnid | 1800 | 1200 |   25  | 248 | 350   | 4 beam + 4 snipe     |
 *
 * BUILDING COSTS:
 * - Solar: 100 energy (2 sec to build)
 * - Factory: 300 energy (6 sec to build)
 */
