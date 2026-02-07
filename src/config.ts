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
 * Knockback forces for combat. Each value is a multiplier applied to damage.
 * Force = damage * multiplier. 0 = disabled.
 *
 * HIT = push on the TARGET when struck
 * FIRE = recoil on the SHOOTER when firing
 */
export const KNOCKBACK = {
  PROJECTILE_HIT: 250,
  PROJECTILE_FIRE: 250,
  BEAM_HIT: 750,
  BEAM_FIRE: 200,
  SONIC_PULL: 180,    // Pull strength toward wave origin (units/sec, scales with 1/distance)
};

/**
 * Default turret acceleration for weapons that don't specify their own.
 * Units: radians/sec² - how fast the turret speeds up its rotation.
 * Higher = snappier turret response.
 */
export const DEFAULT_TURRET_TURN_ACCEL = 20;

/**
 * Default turret drag for weapons that don't specify their own.
 * Applied per frame as: velocity *= (1 - drag)
 * Higher drag = slower terminal velocity, quicker stopping.
 * Terminal velocity ≈ accel / (60 * drag) at 60fps
 */
export const DEFAULT_TURRET_DRAG = 0.15;

/**
 * Multiplier for seeRange (tracking range) relative to fireRange.
 * seeRange = fireRange * SEE_RANGE_MULTIPLIER
 * Turret starts tracking enemies when they enter this range.
 * Target is lost when they leave this range.
 */
export const SEE_RANGE_MULTIPLIER = 1.1;

/**
 * Multiplier for seeRange for sticky targeting weapons.
 * Sticky weapons use a smaller seeRange (0.95x) so they don't acquire
 * targets far outside their fire range and then chase them.
 */
export const SEE_RANGE_MULTIPLIER_STICKY = 0.95;

/**
 * Multiplier for fightstopRange relative to fireRange.
 * fightstopRange = fireRange * FIGHTSTOP_RANGE_MULTIPLIER
 * Unit stops moving in fight/patrol mode when target is within this range.
 * For sticky weapons, new targets are searched within this range.
 */
export const FIGHTSTOP_RANGE_MULTIPLIER = 0.9;


/**
 * Sonic wave weapon visual configuration.
 * Controls the pie-slice zone, concentric wave arcs, and inward-moving particle lines.
 */
export const SONIC_WAVE_VISUAL = {
  // --- Overall ---
  showAnimatedWaves: false,      // true = animated wavy arcs, false = static filled slice
  animationSpeed: 0.3,           // Global speed multiplier (1.0 = default, 0.5 = half)
  accelExponent: 1,              // Inward acceleration curve (1 = linear, 2+ = slow outside/fast inside)

  // --- Filled slice zone ---
  sliceOpacity: 0.05,            // Opacity of the filled pie-slice background
  sliceOpacityMinZoom: 0.1,      // Opacity of the simple arc at min detail level

  // --- Concentric wave arcs (when showAnimatedWaves = true) ---
  waveCount: 5,                  // Number of concentric wave arcs
  waveOpacity: 0.05,             // Opacity of wave arcs
  waveThickness: 10,             // Line thickness of wave arcs (px)
  waveAmplitude: 0,              // Sine wobble amplitude (0 = smooth circles)
  waveFrequency: 10,             // Sine wobble frequency (oscillations per arc)
  wavePullSpeed: 0.8,            // Speed of wave arcs moving inward

  // --- Particle lines (radial dashes moving inward) ---
  particleCount: 20,             // Number of radial particle lines around full circle
  particleSpeed: 10,              // Inward travel speed
  particleLength: 0.1,           // Length as fraction of maxRange (0.2 = 20%)
  particleThickness: 1,        // Line thickness (px)
  particleOpacity: 0.3,          // Peak opacity (fades in/out during travel)
  particleSpawnOffset: 0.5,      // Where particles start as fraction of maxRange from center
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
  widow:     { thickness: 5, footSize: 0.1,  lerpDuration: 700 },
  daddy:     { thickness: 2, footSize: 0.14, lerpDuration: 500 },
  tarantula: { thickness: 4, footSize: 0.12, lerpDuration: 200 },
  commander: { thickness: 6, footSize: 0.15, lerpDuration: 400 },
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
  moveSpeed: 200,
  collisionRadius: 20,
  mass: 60, // Heavy commander unit
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
export const UNIT_MASS_MULTIPLIER = 10.0;

/**
 * Global thrust multiplier for all unit movement.
 * Scales the force applied when units accelerate toward waypoints.
 * Higher values = faster acceleration, higher top speed.
 * 1.0 = default, 0.5 = sluggish, 2.0 = snappy
 */
export const UNIT_THRUST_MULTIPLIER_GAME = 8.0;
export const UNIT_THRUST_MULTIPLIER_DEMO = 3.0;

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
    baseCost: 40,
    hp: 40,
    moveSpeed: 360,
    collisionRadius: 8,
    mass: 10,
    buildRate: 70,
  },
  // Lynx - Glass cannon striker. Burst damage (54 per volley), fragile.
  // Value: Alpha strike potential, but slow and squishy
  lynx: {
    baseCost: 50,
    hp: 65,
    moveSpeed: 130,
    collisionRadius: 10,
    mass: 15,
    buildRate: 55,
  },
  // Daddy - Beam walker. Sustained 45 DPS but VERY slow turret tracking.
  // Value: Good vs slow/stationary targets, struggles vs fast units
  daddy: {
    baseCost: 65,
    hp: 100,
    moveSpeed: 200,
    collisionRadius: 13,
    mass: 25,
    buildRate: 45,
  },
  // Badger - Tanky shotgunner. High burst (72 dmg) but must close to 90 range.
  // Value: Wins close fights, but takes damage closing the gap
  badger: {
    baseCost: 75,
    hp: 180,
    moveSpeed: 200,
    collisionRadius: 16,
    mass: 45,
    buildRate: 40,
  },
  // Scorpion - Area denial artillery. Splash damage, slow projectile.
  // Value: Excellent vs groups, but can be dodged, mediocre vs single targets
  scorpion: {
    baseCost: 85,
    hp: 100,
    moveSpeed: 220,
    collisionRadius: 14,
    mass: 35,
    buildRate: 32,
  },
  // Viper - Long-range assassin. Hitscan piercing, but low DPS (17) and can't escape.
  // Value: Safe poke damage, but very slow and fragile if caught
  viper: {
    baseCost: 55,
    hp: 55,
    moveSpeed: 70,
    collisionRadius: 11,
    mass: 20,
    buildRate: 28,
  },
  // Mammoth - Heavy siege unit. Massive HP (350), high damage (73 DPS), long range.
  // Value: Frontline anchor, wins attrition fights, slow to reposition
  mammoth: {
    baseCost: 160,
    hp: 350,
    moveSpeed: 60,
    collisionRadius: 24,
    mass: 500,
    buildRate: 18,
  },
  // Widow - Titan spider unit. 7 beam weapons + sonic wave = 335+ DPS.
  // Value: Army-in-one super unit, but expensive and high priority target
  widow: {
    baseCost: 700,
    hp: 1200,
    moveSpeed: 100,
    collisionRadius: 38,
    mass: 500,
    buildRate: 20,
  },
  // Tarantula - Wave AoE unit. Continuous damage with pull, scales with 1/distance.
  // Value: Anti-swarm, area denial, but must get moderately close for full effect
  tarantula: {
    baseCost: 55,
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
  // Gatling - Rapid fire, low damage per shot (Jackal's weapon)
  gatling: {
    damage: 4,
    range: 140,
    cooldown: 80,
    projectileSpeed: 650,
  },

  // Pulse - 3-shot burst, medium damage (Lynx's weapon)
  pulse: {
    damage: 18,
    range: 160,
    cooldown: 1200,
    projectileSpeed: 600,
    burstCount: 3,
    burstDelay: 60,
  },

  // Shotgun - Spread pellets, high close-range damage (Badger's weapon)
  shotgun: {
    damage: 12, // Per pellet
    range: 90,
    cooldown: 200,
    projectileSpeed: 450,
    pelletCount: 6,
  },

  // Mortar - Slow, high splash damage artillery (Scorpion's weapon)
  mortar: {
    damage: 80,
    range: 200,
    cooldown: 2500,
    projectileSpeed: 250,
    splashRadius: 70,
  },

  // Cannon - Slow, devastating heavy projectile (Mammoth's weapon)
  cannon: {
    damage: 220,
    range: 360,
    cooldown: 3000,
    projectileSpeed: 300,
  },

  // Railgun - Instant flash hitscan, long range, piercing (Viper's weapon)
  railgun: {
    damage: 55,
    range: 350,
    cooldown: 3200,
    beamDuration: 100, // Brief flash, long enough to be visible at 10Hz snapshots
    beamWidth: 2,
  },

  // Beam - Continuous damage beam (Daddy's weapon)
  // Slow, deliberate turret - low acceleration, tracks slowly
  beam: {
    damage: 45, // DPS while beam is on target
    range: 140,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 4,
    turretTurnAccel: 100, // Fast acceleration (rad/sec²)
    turretDrag: 0.5, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Widow beam lasers - extended range continuous beams
  // Fast, snappy turrets - high acceleration
  widowBeam: {
    damage: 45, // DPS while beam is on target
    range: 140,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 4,
    turretTurnAccel: 100, // Fast acceleration (rad/sec²)
    turretDrag: 0.5, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Widow center beam - 2x stats of widowBeam, mounted at head center
  // Medium-slow turret - big gun needs time to aim
  widowCenterBeam: {
    damage: 65,
    range: 200,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 12,
    turretTurnAccel: 4, // Fast acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Sonic - Continuous pie-slice wave AoE (Tarantula's weapon)
  sonic: {
    damage: 1, // Base DPS (scales with 1/distance)
    range: 400,
    waveInnerRange: 40, // Inner dead zone — no damage/pull inside this radius
    cooldown: 0, // Continuous
    turretTurnAccel: 1, // Medium acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~1.1 rad/sec
    waveAngleIdle: 0,
    waveAngleAttack: Math.PI * 0.125,
    waveTransitionTime: 2000,
    pullPower: 300,
  },

  // Widow sonic wave - larger pie-slice wave AoE
  widowSonic: {
    damage: 1, // Base DPS (scales with 1/distance)
    range: 600,
    waveInnerRange: 120, // Inner dead zone — no damage/pull inside this radius
    cooldown: 0, // Continuous
    turretTurnAccel: 1, // Medium acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~1.1 rad/sec
    waveAngleIdle: 0,
    waveAngleAttack: Math.PI * 2,
    waveTransitionTime: 500,
    pullPower: 300,
  },

  // Disruptor - Commander special weapon
  disruptor: {
    damage: 9999,
    range: 150,
    cooldown: 0, // No cooldown (energy-limited)
    projectileSpeed: 350,
    splashRadius: 40,
  },
};

// =============================================================================
// WEAPON TARGETING MODES
// =============================================================================
/**
 * Per-unit targeting behavior configuration.
 * Each unit type defines how its weapons acquire and keep targets.
 * - 'nearest': Always track closest enemy, switch to closer targets
 * - 'sticky': Stay on current target until it dies or leaves seeRange
 *
 * For multi-weapon units, specify per weapon type.
 * For single-weapon units, use 'default'.
 */
export const UNIT_TARGETING_MODES = {
  // Simple projectile units - track nearest, return to forward when idle
  jackal: { default: 'nearest' as const, returnToForward: false },
  lynx: { default: 'nearest' as const, returnToForward: false },
  badger: { default: 'nearest' as const, returnToForward: false },
  scorpion: { default: 'nearest' as const, returnToForward: false },
  mammoth: { default: 'nearest' as const, returnToForward: false },

  // Beam units - sticky (lock onto target and burn it down)
  daddy: { default: 'sticky' as const, returnToForward: false },
  viper: { default: 'sticky' as const, returnToForward: false },

  // Wave/AoE units - track nearest
  tarantula: { default: 'nearest' as const, returnToForward: false },

  // Multi-weapon titan
  widow: {
    beam: 'sticky' as const, // 6 vertex beams lock onto targets
    centerBeam: 'nearest' as const, // Center beam locks onto target
    sonic: 'nearest' as const, // Sonic wave tracks nearest threat
    returnToForward: false, // Widow turrets stay where they are
  },

  // Commander - projectile, track nearest
  commander: { default: 'nearest' as const, returnToForward: false },
};

// =============================================================================
// MAP SIZE SETTINGS
// =============================================================================

/** Main game map width in pixels */
export const MAP_WIDTH = 6000;

/** Main game map height in pixels */
export const MAP_HEIGHT = 6000;

/** Background/setup screen map width in pixels (slightly smaller) */
export const BACKGROUND_MAP_WIDTH = 1600;

/** Background/setup screen map height in pixels */
export const BACKGROUND_MAP_HEIGHT = 1600;

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
export const DEFAULT_NETWORK_UPDATES_PER_SECOND = 30;

/** Available options for the "Send Updates Per Second" UI control */
export const NETWORK_UPDATE_RATE_OPTIONS = [0.3, 1, 5, 10, 20, 30, 45, 60] as const;

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
export const WORLD_PADDING_PERCENT = 0.5;

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at each detail level: min, low, medium, high, max.
 *
 * AUTO_ZOOM_START: Zoom threshold where each detail level begins in auto mode
 *   - min: 0.0 means min detail from zoom 0 until low kicks in
 *   - low: 0.3 means low detail starts at zoom 0.3
 *   - medium: 0.6 means medium detail starts at zoom 0.6
 *   - high: 1.0 means high detail starts at zoom 1.0
 *   - max: 2.0 means max detail starts at zoom 2.0
 */
export const GRAPHICS_DETAIL_DEFINITIONS = {
  // Zoom thresholds for auto quality (zoom level where each tier starts)
  AUTO_ZOOM_START: {
    min: 0.0,
    low: 0.32,
    medium: 0.6,
    high: 1.0,
    max: 2.0,
  },

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

  // Sonic wave visual style
  // 'simple': single static arc at outer edge, no animation
  // 'detailed': animated wavy arcs with pull lines
  SONIC_WAVE_STYLE: {
    min: 'simple',
    low: 'simple',
    medium: 'detailed',
    high: 'detailed',
    max: 'detailed',
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
 * | Jackal   |   40 |   40 |  360  |  50 | 140   | Fast swarm (gatling) |
 * | Lynx   |   55 |   65 |  130  |  45 | 160   | 3-shot burst (pulse) |
 * | Tarantula|   70 |   80 |  200  |  40 | 400   | Sonic wave AoE       |
 * | Viper    |   75 |   55 |   70  |  17 | 350   | Railgun, pierce      |
 * | Badger   |   80 |  180 |  200  |  60 |  90   | Shotgun spread       |
 * | Daddy    |   90 |  100 |  200  |  45 | 140   | Continuous beam      |
 * | Scorpion |  100 |  100 |  220  |  32 | 200   | Mortar splash        |
 * | Mammoth  |  180 |  350 |   60  |  40 | 360   | Heavy cannon         |
 * | Widow    |  800 | 1200 |  100  | 310 | 350   | 6 beam + sonic       |
 *
 * BUILDING COSTS:
 * - Solar: 100 energy (2 sec to build)
 * - Factory: 300 energy (6 sec to build)
 */
