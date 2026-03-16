import { ZOOM_MIN, ZOOM_MAX } from './config';
import type {
  LodAutoModeConfig,
  LodHysteresis,
  LodEmaSource,
  GraphicsDetailConfig,
} from './types/lod';

// =============================================================================
// TPS BASELINE
// =============================================================================

// The TPS value considered "good" for bar display and LOD decisions.
// This is independent of TARGET TPS (the rate the server tries to run at).
// Bar fill and LOD ratio = actual TPS / GOOD_TPS.
export const GOOD_TPS = 60;

// =============================================================================
// LOD AUTO-MODE CONFIG
// =============================================================================

// Per-mode thresholds dividing the 0–1 ratio into 5 quality zones.
// ratio >= max → 'max', >= high → 'high', … < low → 'min'
// Zoom thresholds are absolute zoom values (logarithmic spacing between ZOOM_MIN/ZOOM_MAX).
// TPS/FPS thresholds are performance ratios (actual / GOOD_TPS for TPS, actual / 60 for FPS).
const _zoomRatio = ZOOM_MAX / ZOOM_MIN;
export const LOD_THRESHOLDS: LodAutoModeConfig = {
  zoom: {
    low: ZOOM_MIN * Math.pow(_zoomRatio, 1 / 5),
    medium: ZOOM_MIN * Math.pow(_zoomRatio, 2 / 5),
    high: ZOOM_MIN * Math.pow(_zoomRatio, 3 / 5),
    max: ZOOM_MIN * Math.pow(_zoomRatio, 4 / 5),
  },
  tps: {
    low: 0.05,
    medium: 0.1,
    high: 0.3,
    max: 0.8,
  },
  fps: {
    low: 0.1,
    medium: 0.2,
    high: 0.3,
    max: 0.4,
  },
};

// Hysteresis band applied to each threshold.
// When upgrading quality, ratio must exceed threshold + hysteresis.
// When downgrading, ratio must drop below threshold − hysteresis.
export const LOD_HYSTERESIS: LodHysteresis = {
  zoom: 0,
  tps: 0.05,
  fps: 0.05,
};

// Which EMA stat to use for each LOD ratio: 'avg' or 'low' (worst-case).
export const LOD_EMA_SOURCE: LodEmaSource = {
  tps: 'low',
  fps: 'low',
};

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at each detail level: min, low, medium, high, max.
 */
export const PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL = {
  // -------------------------------------------------------------------------
  // Each tier should feel visibly different from the one below it.
  //   MIN  — circles only, no turrets, no legs, no detail (~2 draws/unit)
  //   LOW  — full shapes, simple legs/turrets, palette shading (~6 draws/unit)
  //   MED  — animated legs, core projectiles, scatter deaths (~12 draws/unit)
  //   HIGH — chassis detail, tread animation, standard beams (~25 draws/unit)
  //   MAX  — full joints, barrel spin, trails, inferno explosions (~50 draws/unit)
  // -------------------------------------------------------------------------

  // Unit body shape rendering
  // 'circles': two concentric circles (push+shot radii), 'full': complete body shape
  UNIT_SHAPE: {
    min: 'circles',
    low: 'full',
    medium: 'full',
    high: 'full',
    max: 'full',
  },
  CIRCLES_DRAW_PUSH: true,
  CIRCLES_DRAW_SHOT: true,

  // Leg rendering for widow/daddy/tarantula/tick units
  // 'none': no legs, 'simple': 1 line/leg, 'animated': 2-segment IK, 'full': IK + joint circles
  LEGS: {
    min: 'none',
    low: 'simple',
    medium: 'animated',
    high: 'animated',
    max: 'full',
  },

  // Tread/wheel animations (adds ~6-8 lineBetween per tread — expensive with many treaded units)
  TREADS_ANIMATED: {
    min: false,
    low: false,
    medium: false,
    high: true,
    max: true,
  },

  // Beam rendering style
  // 'simple': 1 beam line + 1 endpoint circle, 'standard': 2 lines + 2 circles,
  // 'detailed': 3 lines + circles + 4 sparks, 'complex': 3 lines + 6 sparks
  BEAM_STYLE: {
    min: 'simple',
    low: 'simple',
    medium: 'simple',
    high: 'standard',
    max: 'detailed',
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

  // Unit chassis inner detail (armor plates, inner accents, center hubs — adds 3-5 draws/unit)
  // false = basic shape only, true = full inner detail polygons and overlays
  CHASSIS_DETAIL: {
    min: false,
    low: false,
    medium: false,
    high: true,
    max: true,
  },

  // Unit palette shading — 3-color palette (base/light/dark) vs monochrome
  // No draw-call cost, just richer color.
  PALETTE_SHADING: {
    min: false,
    low: true,
    medium: true,
    high: true,
    max: true,
  },

  // Turret barrel rendering complexity
  // 'none': no barrels, 'simple': single line/weapon, 'full': orbital multi-barrel + base circles
  TURRET_STYLE: {
    min: 'none',
    low: 'full',
    // low: 'simple',
    medium: 'full',
    high: 'full',
    max: 'full',
  },

  // Force field turret rendering (complexSingleEmitter grate)
  // 'none': zones only, 'simple': pulsing circle + zones, 'full': animated multi-ring grate
  FORCE_TURRET_STYLE: {
    min: 'none',
    low: 'none',
    medium: 'simple',
    high: 'simple',
    max: 'full',
  },

  // Multi-barrel turret spin animation
  // false = barrels frozen at angle 0, true = animated spin
  BARREL_SPIN: {
    min: false,
    low: false,
    medium: true,
    high: true,
    max: true,
  },

  // Burn mark cutoff — higher = marks disappear sooner = fewer active marks
  BURN_MARK_ALPHA_CUTOFF: {
    min: 1,
    low: 0.6,
    medium: 0.4,
    high: 0.2,
    max: 0.01,
  },

  // Burn mark sample interval — frames to skip between placing new burn marks
  BURN_MARK_FRAMES_SKIP: {
    min: 5,
    low: 4,
    medium: 3,
    high: 1,
    max: 0,
  },

  // Beam path collision recomputation — frames to skip between beam path traces
  BEAM_PATH_FRAMES_SKIP: {
    min: 0,
    low: 0,
    medium: 0,
    high: 0,
    max: 0,
  },

  // Projectile (shot) rendering style
  // 'dot': 1 circle, 'core': 2 circles, 'trail': core + history trail,
  // 'glow': trail + glow ring + dots, 'full': glow + pulsing halo + contrails
  PROJECTILE_STYLE: {
    min: 'dot',
    low: 'dot',
    medium: 'core',
    high: 'core',
    max: 'trail',
  },

  // Fire (impact) explosion style
  // 'flash' ~12 draws, 'spark' ~18, 'burst' ~30, 'blaze' ~45, 'inferno' ~65
  FIRE_EXPLOSION_STYLE: {
    min: 'flash',
    low: 'flash',
    medium: 'spark',
    high: 'burst',
    max: 'inferno',
  },

  // Death (unit wreckage) explosion style
  // 'puff' ~3 draws, 'scatter' ~12, 'shatter' ~25, 'detonate' ~55, 'obliterate' ~120
  DEATH_EXPLOSION_STYLE: {
    min: 'puff',
    low: 'scatter',
    medium: 'scatter',
    high: 'shatter',
    max: 'obliterate',
  },

  // Force field visual style
  // 'minimal': faint fill only, 'simple': fill + particles, 'enhanced': fill + particles + arcs
  FORCE_FIELD_STYLE: {
    min: 'minimal',
    low: 'minimal',
    medium: 'minimal',
    high: 'simple',
    max: 'enhanced',
  },
} as const satisfies GraphicsDetailConfig;
