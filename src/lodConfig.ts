import { ZOOM_MIN, ZOOM_MAX } from './config';
import type {
  LodThresholds,
  LodHysteresis,
  LodEmaSource,
  GraphicsDetailConfig,
} from './types/lod';

// =============================================================================
// LOD AUTO-MODE CONFIG
// =============================================================================

// Ratio thresholds dividing 0–1 into 5 quality zones.
// ratio >= max → 'max', >= high → 'high', … < low → 'min'
export const LOD_RATIO_THRESHOLDS: LodThresholds = {
  low: 0.2,
  medium: 0.4,
  high: 0.6,
  max: 0.8,
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

// Auto-zoom thresholds — logarithmic spacing between ZOOM_MIN and ZOOM_MAX.
// Produces 4 breakpoints dividing the zoom range into 5 quality zones.
const _zoomRatio = ZOOM_MAX / ZOOM_MIN;
export const LOD_ZOOM_THRESHOLDS: LodThresholds = {
  low: ZOOM_MIN * Math.pow(_zoomRatio, 1 / 5),
  medium: ZOOM_MIN * Math.pow(_zoomRatio, 2 / 5),
  high: ZOOM_MIN * Math.pow(_zoomRatio, 3 / 5),
  max: ZOOM_MIN * Math.pow(_zoomRatio, 4 / 5),
};

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at each detail level: min, low, medium, high, max.
 */
export const PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL = {
  // Unit body shape rendering
  // 'circles': two concentric circles (push+shot radii), 'full': complete body shape
  UNIT_SHAPE: {
    min: 'circles',
    low: 'full',
    medium: 'full',
    high: 'full',
    max: 'full',
  },
  // Whether to draw the push-radius circle in 'circles' mode
  CIRCLES_DRAW_PUSH: true,
  // Whether to draw the shot-radius circle in 'circles' mode
  CIRCLES_DRAW_SHOT: true,

  // Leg rendering for widow/daddy/tarantula/tick units
  // 'none': no legs drawn or updated,
  // 'simple': straight line per leg (no IK),
  // 'animated': full 2-segment IK legs, 'full': IK legs + joint circles (hip/knee/foot)
  LEGS: {
    min: 'none',
    low: 'simple',
    medium: 'animated',
    high: 'animated',
    max: 'full',
  },

  // Tread/wheel animations
  TREADS_ANIMATED: {
    min: false,
    low: false,
    medium: false,
    high: true,
    max: true,
  },

  // Beam rendering style
  // Controls beam line complexity (1-3 layers) and endpoint effects (circles, pulsing, sparks)
  BEAM_STYLE: {
    min: 'simple', // 1 beam line, 1 static endpoint circle
    low: 'simple', // 1 beam line, 1 static endpoint circle
    medium: 'simple', // 2 beam lines, 2 pulsing endpoint circles
    high: 'detailed', // 3 beam lines, 3 pulsing circles + 4 sparks
    max: 'complex', // 3 beam lines, 3 pulsing circles + 6 sparks
  },

  // Beam glow effects (bloom/glow around beams)
  BEAM_GLOW: {
    min: false,
    low: false,
    medium: true,
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

  // Unit chassis inner detail (armor plates, inner accents, center hubs, commander reactor/pylons/armored legs)
  // false = basic shape only, true = full inner detail polygons and overlays
  CHASSIS_DETAIL: {
    min: false,
    low: false,
    medium: true,
    high: true,
    max: true,
  },

  // Unit palette shading — whether units use full 3-color palette (base/light/dark) or monochrome (base only)
  // false = monochrome (base color for all), true = full light/dark shading
  PALETTE_SHADING: {
    min: false,
    low: false,
    medium: true,
    high: true,
    max: true,
  },

  // Turret barrel rendering complexity
  // 'none': no barrel geometry (force field zones only at min),
  // 'simple': single line per weapon,
  // 'full': orbital multi-barrel, cone spread, barrel base circles
  TURRET_STYLE: {
    min: 'none',
    low: 'simple',
    medium: 'full',
    high: 'full',
    max: 'full',
  },

  // Force field turret rendering (complexSingleEmitter grate + zones)
  // Separate from TURRET_STYLE so force turrets can be independently tuned.
  // 'none': force field zones only (no grate geometry),
  // 'simple': single pulsing circle + zones,
  // 'full': animated multi-ring grate + zones
  FORCE_TURRET_STYLE: {
    min: 'none',
    low: 'simple',
    medium: 'simple',
    high: 'full',
    max: 'full',
  },

  // Multi-barrel turret spin animation (gatling/cone barrels orbit their mount point)
  // false = barrels frozen at angle 0, true = animated spin (idle + firing acceleration)
  BARREL_SPIN: {
    min: false,
    low: false,
    medium: true,
    high: true,
    max: true,
  },

  // Burn mark cutoff — how close to background color before marks stop drawing
  // Lower values = marks linger longer, higher = fewer draw calls
  BURN_MARK_ALPHA_CUTOFF: {
    min: 1,
    low: 0.3,
    medium: 0.3,
    high: 0.05,
    max: 0.01,
  },

  // Burn mark sample interval — frames to skip between placing new burn marks
  // 0 = every frame, 1 = every other frame, 3 = every 4th frame, etc.
  BURN_MARK_FRAMES_SKIP: {
    min: 4,
    low: 3,
    medium: 3,
    // medium: 2,
    high: 1,
    max: 0,
  },

  // Projectile (shot) rendering style
  // 'dot': colored circle only, 'core': circle + white inner dot,
  // 'trail': core + position-history trail, 'glow': trail + outer glow ring + trail dots,
  // 'full': glow + pulsing halo + contrail lines + extra trail points
  PROJECTILE_STYLE: {
    min: 'dot',
    low: 'core',
    medium: 'core',
    // medium: 'trail',
    high: 'glow',
    max: 'full',
  },

  // Fire (impact) explosion style
  // 'flash': core fireball + zone glows + 1 particle each (~12 draws),
  // 'spark': +hot core center + spark/pen inners, ×1.5 particles (~18 draws),
  // 'burst': ×2.5 particles + moderate drift, no trails (~30 draws),
  // 'blaze': ×4 particles + short trails + strong drift (~45 draws),
  // 'inferno': ×6 particles + full trails + rising embers (~65 draws)
  FIRE_EXPLOSION_STYLE: {
    min: 'flash',
    low: 'spark',
    medium: 'spark',
    // medium: 'burst',
    high: 'blaze',
    max: 'inferno',
  },

  // Death (unit wreckage) explosion style — team-colored debris from unit shape (legs, treads, panels)
  // 'puff': core fireball only (~3 draws),
  // 'scatter': +smoke, debris chunks, sparks in cone (~12 draws),
  // 'shatter': more debris + inner highlights on chunks (~25 draws),
  // 'detonate': +fragment trails, gravity chunks, full-circle sparks (~55 draws),
  // 'obliterate': +rising embers, momentum trail, dual spark trails (~120 draws)
  DEATH_EXPLOSION_STYLE: {
    min: 'puff',
    low: 'scatter',
    medium: 'scatter',
    // medium: 'shatter',
    high: 'detonate',
    max: 'obliterate',
  },

  // Force field visual style
  // 'minimal': faint fill only, 'simple': fill + particles,
  // 'normal': fill + particles, 'enhanced': fill + dense particles + wavy arcs
  FORCE_FIELD_STYLE: {
    min: 'minimal',
    low: 'minimal',
    medium: 'simple',
    high: 'normal',
    max: 'enhanced',
  },
} as const satisfies GraphicsDetailConfig;
