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
 * Knockback force multiplier applied when projectiles hit units.
 * Force = damage * KNOCKBACK_FORCE_MULTIPLIER
 * 0 = no knockback, higher = more knockback
 */
export const KNOCKBACK_FORCE_MULTIPLIER = 150;

/**
 * Additional knockback multiplier for beam/laser weapons.
 * Beams deal small damage per tick, so this scales up the pushback effect.
 * Total beam knockback = damage * KNOCKBACK_FORCE_MULTIPLIER * BEAM_KNOCKBACK_MULTIPLIER
 */
export const BEAM_KNOCKBACK_MULTIPLIER = 1.0;

/**
 * Recoil multiplier - fraction of knockback force applied back to the firing unit.
 * 0 = no recoil, 0.5 = 50% of knockback force applied as recoil, 1.0 = equal and opposite.
 * Applies to projectiles and beams, but NOT sonic wave weapons.
 */
export const RECOIL_MULTIPLIER = 1;

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

/**
 * Sonic wave inward acceleration exponent.
 * Controls how much the sine wave arcs accelerate as they approach the origin.
 * 1.0 = constant speed (linear)
 * 2.0 = quadratic - starts slow, speeds up toward center
 * 3.0 = cubic - starts very slow, accelerates more dramatically
 * Higher values = more dramatic slow-outside, fast-inside effect
 */
export const SONIC_WAVE_ACCEL_EXPONENT = 1;

/**
 * Sonic wave animation speed multiplier.
 * Controls overall animation speed of the wave visual effects.
 * 1.0 = default speed
 * 0.5 = half speed (slower)
 * 2.0 = double speed (faster)
 */
export const SONIC_WAVE_ANIMATION_SPEED = 0.3;

/** Number of concentric wave arcs in the sonic wave effect */
export const SONIC_WAVE_COUNT = 5;

/**
 * Maximum opacity of the sonic wave arcs.
 * Waves fade in as they approach the center, this is the peak opacity.
 * 0.0 = invisible, 1.0 = fully opaque
 */
export const SONIC_WAVE_OPACITY = 0.05;

/**
 * Opacity of the simple sonic wave arc used at min detail level.
 * 0.0 = invisible, 1.0 = fully opaque
 */
export const SONIC_WAVE_OPACITY_MIN_ZOOM = 0.1;

/**
 * Waviness amplitude - how much the wave arcs wobble.
 * Higher values = more pronounced wave distortion.
 */
export const SONIC_WAVE_AMPLITUDE = 0;

/**
 * Waviness frequency - number of wave oscillations per arc.
 * Higher values = more ripples along each arc.
 */
export const SONIC_WAVE_FREQUENCY = 10;

/**
 * Line thickness of the sonic wave arcs in pixels.
 */
export const SONIC_WAVE_THICKNESS = 10;

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
  // Scout - Disposable swarm unit. High DPS (50) but dies fast.
  // Value: Fast harassment, good vs slow units, countered by splash
  scout: {
    baseCost: 40,
    hp: 40,
    moveSpeed: 360,
    collisionRadius: 8,
    mass: 10,
    buildRate: 70,
  },
  // Burst - Glass cannon striker. Burst damage (54 per volley), fragile.
  // Value: Alpha strike potential, but slow and squishy
  burst: {
    baseCost: 55,
    hp: 65,
    moveSpeed: 130,
    collisionRadius: 10,
    mass: 15,
    buildRate: 55,
  },
  // Daddy - Beam walker. Sustained 45 DPS but VERY slow turret tracking.
  // Value: Good vs slow/stationary targets, struggles vs fast units
  daddy: {
    baseCost: 90,
    hp: 100,
    moveSpeed: 200,
    collisionRadius: 13,
    mass: 25,
    buildRate: 45,
  },
  // Brawl - Tanky shotgunner. High burst (72 dmg) but must close to 90 range.
  // Value: Wins close fights, but takes damage closing the gap
  brawl: {
    baseCost: 80,
    hp: 180,
    moveSpeed: 200,
    collisionRadius: 16,
    mass: 45,
    buildRate: 40,
  },
  // Shotgun - Area denial artillery. Splash damage, slow projectile.
  // Value: Excellent vs groups, but can be dodged, mediocre vs single targets
  shotgun: {
    baseCost: 100,
    hp: 100,
    moveSpeed: 220,
    collisionRadius: 14,
    mass: 35,
    buildRate: 32,
  },
  // Snipe - Long-range assassin. Hitscan piercing, but low DPS (17) and can't escape.
  // Value: Safe poke damage, but very slow and fragile if caught
  snipe: {
    baseCost: 75,
    hp: 55,
    moveSpeed: 70,
    collisionRadius: 11,
    mass: 20,
    buildRate: 28,
  },
  // Tank - Heavy siege unit. Massive HP (350), high damage (73 DPS), long range.
  // Value: Frontline anchor, wins attrition fights, slow to reposition
  tank: {
    baseCost: 180,
    hp: 350,
    moveSpeed: 60,
    collisionRadius: 24,
    mass: 500,
    buildRate: 18,
  },
  // Widow - Titan spider unit. 7 beam weapons + sonic wave = 335+ DPS.
  // Value: Army-in-one super unit, but expensive and high priority target
  widow: {
    baseCost: 800,
    hp: 1200,
    moveSpeed: 1600,
    collisionRadius: 38,
    mass: 500,
    buildRate: 20,
  },
  // Insect - Wave AoE unit. Continuous damage with pull, scales with 1/distance.
  // Value: Anti-swarm, area denial, but must get moderately close for full effect
  insect: {
    baseCost: 70,
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
    damage: 12, // Per pellet
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
    beamDuration: 20, // Instant flash
    beamWidth: 2,
  },

  // Daddy - Continuous damage beam (daddy long legs unit)
  // Slow, deliberate turret - low acceleration, tracks slowly
  daddy: {
    damage: 45, // DPS while beam is on target
    range: 140,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 4,
    turretTurnAccel: 9, // Fast acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Widow beam lasers - extended range continuous beams
  // Fast, snappy turrets - high acceleration
  widowBeam: {
    damage: 45,
    range: 160,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 4,
    turretTurnAccel: 9, // Fast acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Widow center beam - 2x stats of widowBeam, mounted at head center
  // Medium-slow turret - big gun needs time to aim
  widowCenterBeam: {
    damage: 45,
    range: 160,
    cooldown: 0, // Continuous
    beamDuration: 1000,
    beamWidth: 4,
    turretTurnAccel: 9, // Fast acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~3.3 rad/sec
  },

  // Insect - Continuous pie-slice wave AoE
  insect: {
    damage: 1, // Base DPS (scales with 1/distance)
    range: 400,
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
    cooldown: 0, // Continuous
    turretTurnAccel: 1, // Medium acceleration (rad/sec²)
    turretDrag: 0.1, // Moderate drag → terminal ~1.1 rad/sec
    waveAngleIdle: 0,
    waveAngleAttack: Math.PI * 0.125,
    waveTransitionTime: 500,
    pullPower: 300,
  },

  // D-gun - Commander special weapon
  dgun: {
    damage: 9999,
    range: 150,
    cooldown: 0, // No cooldown (energy-limited)
    projectileSpeed: 350,
    splashRadius: 40,
  },

  // Widow - Multi-weapon titan (placeholder, uses widowBeam + widowSonic)
  // widow: {
  //   damage: 0,
  //   range: 350,
  //   cooldown: 0,
  //   beamCount: 6,
  // },
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
  scout: { default: 'nearest' as const, returnToForward: false },
  burst: { default: 'nearest' as const, returnToForward: false },
  brawl: { default: 'nearest' as const, returnToForward: false },
  shotgun: { default: 'nearest' as const, returnToForward: false },
  tank: { default: 'nearest' as const, returnToForward: false },

  // Beam units - sticky (lock onto target and burn it down)
  daddy: { default: 'sticky' as const, returnToForward: false },
  snipe: { default: 'sticky' as const, returnToForward: false },

  // Wave/AoE units - track nearest
  insect: { default: 'nearest' as const, returnToForward: false },

  // Multi-weapon titan
  widow: {
    beam: 'sticky' as const,        // 6 vertex beams lock onto targets
    centerBeam: 'sticky' as const,  // Center beam locks onto target
    sonic: 'nearest' as const,      // Sonic wave tracks nearest threat
    returnToForward: false,         // Widow turrets stay where they are
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

/**
 * Zoom multiplier per scroll wheel tick (exponential zoom).
 * Each scroll step multiplies/divides zoom by this factor.
 * 1.15 = 15% change per step, feels consistent at all zoom levels.
 */
export const ZOOM_FACTOR = 1.15;

/** Initial zoom level when game starts */
export const ZOOM_INITIAL = 0.4;

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

  // Leg rendering for arachnid/daddy/insect units
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
