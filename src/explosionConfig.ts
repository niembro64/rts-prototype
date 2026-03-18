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
  coreCircles: [2, 3, 4, 5, 5] as readonly number[],
  /** Smoke particles (entity velocity direction) */
  smokeCount: [0, 3, 4, 6, 8] as readonly number[],
  /** Debris particles (penetration direction) */
  debrisCount: [0, 2, 4, 7, 10] as readonly number[],
  /** Spark particles (attacker direction) */
  sparkCount: [0, 3, 5, 12, 24] as readonly number[],
  /** Fragment particles (tight attacker cone, high+ only) */
  fragmentCount: [0, 0, 0, 8, 15] as readonly number[],
  /** Chunk particles (penetration direction with gravity, high+ only) */
  chunkCount: [0, 0, 0, 6, 10] as readonly number[],
  /** Embers (float up, max only) */
  emberCount: [0, 0, 0, 0, 12] as readonly number[],
  /** Momentum trail particles (combined direction, max only) */
  momentumCount: [0, 0, 0, 0, 12] as readonly number[],

  // --- Per-particle inner highlight circles ---
  debrisInners: [0, 0, 1, 1, 2] as readonly number[],
  sparkInners: [0, 0, 1, 1, 2] as readonly number[],
  fragmentInners: [0, 0, 0, 2, 3] as readonly number[],
  chunkInners: [0, 0, 0, 1, 1] as readonly number[],

  // --- Trail multipliers ---
  smokeTrailMult: [0, 0, 0, 0.5, 1.0] as readonly number[],
  debrisTrailMult: [0, 0, 0, 0.6, 1.0] as readonly number[],
  sparkTrailMult: [0, 0, 0, 0.6, 1.0] as readonly number[],
  sparkDualTrail: [false, false, false, false, true] as readonly boolean[],
  fragmentTrailMult: [0, 0, 0, 0.8, 1.0] as readonly number[],

  // --- Spark distribution ---
  /** Whether sparks go full circle (true) or cone (false) */
  sparkFullCircle: [false, false, false, true, true] as readonly boolean[],
  /** Directional bias for spark cone (higher = tighter cone in attacker dir) */
  sparkDirBias: [0, 0.5, 0.8, 2.0, 3.0] as readonly number[],

  // --- Center drift ---
  /** Drift scale per LOD (fraction of radius) */
  driftScale: [0, 0.15, 0.25, 0.4, 0.5] as readonly number[],
  /** Smoke upward float (px per progress unit) */
  smokeFloat: [0, 4, 5, 7, 8] as readonly number[],

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
