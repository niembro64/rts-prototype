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
  minigun: {
    baseCost: 80,
    hp: 100,
    moveSpeed: 120,
    radius: 12,
    buildRate: 40,          // Max energy/sec factory spends on this unit
  },
  laser: {
    baseCost: 100,
    hp: 100,
    moveSpeed: 100,
    radius: 14,
    buildRate: 40,
  },
  shotgun: {
    baseCost: 90,
    hp: 100,
    moveSpeed: 110,
    radius: 13,
    buildRate: 40,
  },
  cannon: {
    baseCost: 150,
    hp: 150,
    moveSpeed: 80,
    radius: 16,
    buildRate: 30,
  },
  grenade: {
    baseCost: 160,
    hp: 120,
    moveSpeed: 90,
    radius: 14,
    buildRate: 25,
  },
  railgun: {
    baseCost: 180,
    hp: 100,
    moveSpeed: 85,
    radius: 14,
    buildRate: 25,
  },
  burstRifle: {
    baseCost: 120,
    hp: 100,
    moveSpeed: 115,
    radius: 12,
    buildRate: 35,
  },
};

// =============================================================================
// WEAPON STATS
// =============================================================================

export const WEAPON_STATS = {
  minigun: {
    damage: 5,
    range: 150,
    cooldown: 100,          // ms between shots
    projectileSpeed: 600,
  },
  laser: {
    damage: 40,             // Damage per second while beam is on target
    range: 180,
    cooldown: 0,            // Continuous
    beamDuration: 1000,
    beamWidth: 3,
  },
  shotgun: {
    damage: 8,              // Per pellet
    range: 100,
    cooldown: 1000,
    pelletCount: 5,
    projectileSpeed: 500,
  },
  cannon: {
    damage: 70,
    range: 280,
    cooldown: 2000,
    projectileSpeed: 350,
  },
  grenade: {
    damage: 90,
    range: 160,
    cooldown: 3000,
    projectileSpeed: 280,
    splashRadius: 60,
  },
  railgun: {
    damage: 70,
    range: 300,
    cooldown: 2000,
    beamDuration: 120,
    beamWidth: 2,
  },
  burstRifle: {
    damage: 20,
    range: 170,
    cooldown: 1500,
    burstCount: 3,
    burstDelay: 80,
    projectileSpeed: 550,
  },
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
 * How many times per second the host broadcasts game state to clients.
 * Higher = smoother but more bandwidth. Lower = choppier but less bandwidth.
 */
export const NETWORK_UPDATES_PER_SECOND = 3;

/** Calculated interval in milliseconds between network updates */
export const NETWORK_UPDATE_INTERVAL_MS = 1000 / NETWORK_UPDATES_PER_SECOND;

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
