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
    baseCost: 100,          // Base energy cost (before multiplier)
    hp: 200,
    buildRate: 30,          // Max energy/sec commander can spend building this
  },
  factory: {
    baseCost: 300,          // Base energy cost (before multiplier)
    hp: 800,
    buildRate: 40,          // Max energy/sec commander can spend building this
    unitBuildRate: 50,      // Max energy/sec factory spends producing units
  },
};

// =============================================================================
// COMMANDER STATS
// =============================================================================

export const COMMANDER_STATS = {
  hp: 500,
  moveSpeed: 80,
  buildRate: 50,            // Max energy/sec for construction
  buildRange: 150,          // Max distance to build
  dgunCost: 200,            // Energy cost per D-gun shot
};

// =============================================================================
// UNIT STATS (base values before any multipliers)
// =============================================================================

export const UNIT_STATS = {
  // Scout - Tiny, fast, cheap swarm unit. Rapid fire, low damage.
  scout: {
    baseCost: 40,
    hp: 40,
    moveSpeed: 160,
    radius: 8,
    buildRate: 60,          // Builds very fast
  },
  // Burst - Fast striker with burst fire. Glass cannon.
  burst: {
    baseCost: 70,
    hp: 70,
    moveSpeed: 130,
    radius: 10,
    buildRate: 50,
  },
  // Beam - Balanced continuous damage dealer.
  beam: {
    baseCost: 100,
    hp: 100,
    moveSpeed: 100,
    radius: 13,
    buildRate: 40,
  },
  // Brawl - Tough close-range fighter with shotgun spread.
  brawl: {
    baseCost: 120,
    hp: 160,
    moveSpeed: 85,
    radius: 15,
    buildRate: 35,
  },
  // Mortar - Slow artillery with devastating splash damage.
  mortar: {
    baseCost: 150,
    hp: 120,
    moveSpeed: 65,
    radius: 14,
    buildRate: 30,
  },
  // Snipe - Fragile long-range instant-hit assassin.
  snipe: {
    baseCost: 180,
    hp: 60,
    moveSpeed: 75,
    radius: 11,
    buildRate: 25,
  },
  // Tank - Massive, slow, heavily armored siege unit.
  tank: {
    baseCost: 250,
    hp: 300,
    moveSpeed: 45,
    radius: 22,
    buildRate: 20,
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
    cooldown: 80,           // Very fast fire rate
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
  // Beam - Continuous damage beam
  beam: {
    damage: 45,             // Damage per second while beam is on target
    range: 170,
    cooldown: 0,            // Continuous
    beamDuration: 1000,
    beamWidth: 3,
  },
  // Brawl - Shotgun spread, high close-range damage
  brawl: {
    damage: 12,             // Per pellet
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
  // Snipe - Instant hitscan, high single-target damage, piercing
  snipe: {
    damage: 90,
    range: 350,
    cooldown: 2500,
    beamDuration: 100,
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
 * - Base: 3 energy/sec
 * - Per solar: +8 energy/sec
 * - With 5 solars: 3 + 40 = 43 energy/sec
 *
 * BUILD RATES:
 * - Commander builds at: 50 energy/sec
 * - Factory produces at: 50 energy/sec
 * - Both together: 100 energy/sec max spending
 *
 * UNIT COSTS (with COST_MULTIPLIER = 1.0):
 * - Minigun: 80 energy (1.6 sec at 50/sec)
 * - Laser: 100 energy (2 sec)
 * - Cannon: 150 energy (3 sec)
 * - Railgun: 180 energy (3.6 sec)
 *
 * BUILDING COSTS:
 * - Solar: 100 energy (2 sec to build)
 * - Factory: 300 energy (6 sec to build)
 */
