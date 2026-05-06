import { LAND_CELL_SIZE, ZOOM_MIN, ZOOM_MAX } from './config';
import type {
  LodAutoModeConfig,
  LodHysteresis,
  LodEmaSource,
  GraphicsDetailConfig,
  LodSignalStates,
} from './types/lod';
import { assertMonotonicLodThresholds } from './types/lod';
import type {
  CameraSphereRadii,
  ConcreteGraphicsQuality,
} from './types/graphics';

// =============================================================================
// PLAYER CLIENT LOD — SIGNAL TOGGLES
// =============================================================================

// Per-signal enable flags. Set false to remove a signal from the LOD
// system entirely:
//   - The AUTO mode no longer factors that signal into its min().
//   - The dedicated auto-{signal} mode resolves to MAX (a no-op).
//   - The matching button is hidden in the PLAYER CLIENT LOD bar.
//
// Toggle here to debug a single signal in isolation, or to disable a
// signal that should not globally downgrade the renderer. Zoom is off
// by default in 3D because camera scale now feeds per-object view LOD
// instead of the global performance tier.
export const LOD_SIGNALS_ENABLED = {
  zoom: false,
  serverTps: true,
  renderTps: true,
  units: true,
} as const;

// Default per-signal tri-state, applied:
//   1) on first browser load (before localStorage is populated), and
//   2) when the user clicks DEFAULTS on the PLAYER CLIENT bar.
//
// Single source of truth — clientBarConfig.ts seeds `currentSignalStates`
// from this, and the DEFAULTS reset path re-applies it. To change what a
// signal does on first load, edit this table and nothing else.
//
export const LOD_SIGNAL_DEFAULTS: LodSignalStates = {
  zoom: 'off',
  serverTps: 'active',
  renderTps: 'active',
  units: 'off',
};

// =============================================================================
// TPS BASELINE
// =============================================================================

// The TPS value considered "good" for bar display and LOD decisions.
// Server TPS measures authoritative simulation ticks; render TPS measures the
// PLAYER CLIENT update loop that runs prediction/input/render prep.
// Bar fill and LOD ratio = actual TPS / GOOD_TPS.
export const GOOD_TPS = 60;

// =============================================================================
// LOD AUTO-MODE CONFIG
// =============================================================================

// Per-mode thresholds dividing the 0–1 ratio into 5 quality zones.
// ratio >= max → 'max', >= high → 'high', … < low → 'min'
// Zoom thresholds are absolute zoom values (logarithmic spacing between ZOOM_MIN/ZOOM_MAX).
// TPS thresholds are performance ratios:
//   serverTps/renderTps => actual / GOOD_TPS
const _zoomRatio = ZOOM_MAX / ZOOM_MIN;
export const LOD_THRESHOLDS: LodAutoModeConfig = {
  zoom: {
    low: ZOOM_MIN * Math.pow(_zoomRatio, 1 / 5),
    medium: ZOOM_MIN * Math.pow(_zoomRatio, 2 / 5),
    high: ZOOM_MIN * Math.pow(_zoomRatio, 3 / 5),
    max: ZOOM_MIN * Math.pow(_zoomRatio, 4 / 5),
  },
  serverTps: {
    low: 0.2,
    medium: 0.4,
    high: 0.6,
    max: 0.8,
  },
  renderTps: {
    low: 0.2,
    medium: 0.4,
    high: 0.6,
    max: 0.8,
  },
  // UNIT-FULLNESS THRESHOLDS — fractions of the user-configured unit
  // cap. The ratio fed in is `1 − unitCount / unitCap`, so an empty
  // world is 1.0 and a full one is 0.0. Same direction as TPS:
  // ratio >= threshold ⇒ tier eligible.
  //
  // Defaults: full visuals only while the world is sparse, then move
  // into hybrid/mass rendering before the frame has already collapsed.
  // Whether the cap is 1k or 16k, the LOD ladder steps at the same
  // proportional milestones.
  units: {
    low: 0.2,
    medium: 0.4,
    high: 0.6,
    max: 0.8,
  },
};

// Validate LOD_THRESHOLDS at module load. ratioToRank assumes the
// four rungs are finite and strictly increasing — a malformed config
// would silently skip a tier or promote too eagerly. Hard-fail in
// dev so config drift surfaces before any resolver runs.
assertMonotonicLodThresholds('zoom', LOD_THRESHOLDS.zoom);
assertMonotonicLodThresholds('serverTps', LOD_THRESHOLDS.serverTps);
assertMonotonicLodThresholds('renderTps', LOD_THRESHOLDS.renderTps);
assertMonotonicLodThresholds('units', LOD_THRESHOLDS.units);

// Hysteresis band applied to each threshold.
// When upgrading quality, ratio must exceed threshold + hysteresis.
// When downgrading, ratio must drop below threshold − hysteresis.
export const LOD_HYSTERESIS: LodHysteresis = {
  zoom: 0,
  serverTps: 0.05,
  renderTps: 0.05,
  units: 0.05,
};

// Which PLAYER CLIENT EMA sample drives each auto-LOD signal.
// Toggle these between 'avg' and 'low' when tuning how quickly the
// renderer drops detail:
//   - serverTps 'avg' = steady server tick rate, 'low' = lower/worst tick rate.
//   - renderTps 'avg' = steady client update-loop tick rate, 'low' = lower/worst.
export const LOD_EMA_SOURCE: LodEmaSource = {
  serverTps: 'low',
  renderTps: 'low',
};

// =============================================================================
// GRAPHICS DETAIL DEFINITIONS
// =============================================================================

// Client-side prediction cadence by PLAYER CLIENT LOD. Values are
// FRAMES TO SKIP, not frame stride:
//   0 => update every render frame
//   1 => update every other render frame
//   7 => update once every 8 render frames
//
// Labels are intentionally the same names shown in the bar:
// MIN / LOW / MID / HI / MAX.
export const CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP = {
  MIN: 4,
  LOW: 3,
  MID: 2,
  HI: 1,
  MAX: 0,
} as const;

/**
 * Centralized graphics detail level configuration.
 * Each key defines what happens at each detail level: min, low, medium, high, max.
 */
export const CAMERA_SPHERE_BASE_RADIUS = 100;

// Scales the innermost "rich" sphere by global PLAYER CLIENT LOD.
// CAMERA_SPHERE_BASE_RADIUS is a true linear multiplier for every
// generated camera sphere radius. Keep these modest: the camera
// distance itself is part of the 3D sphere distance, so huge radii make
// an entire 3150 game map resolve to the same LOD band.
export const CAMERA_SPHERE_LOD_RADIUS_MULTIPLIERS = {
  min: 1,
  low: 2,
  medium: 4,
  high: 8,
  max: 16,
} as const satisfies Record<ConcreteGraphicsQuality, number>;

// Scales each concentric camera sphere from that LOD's rich radius.
// Edit these to change ring spacing globally without touching every LOD.
// Set a sphere multiplier to 0 to disable that shell; disabled shells
// are skipped by both object LOD resolution and debug ground rings.
export const CAMERA_SPHERE_RING_RADIUS_MULTIPLIERS = {
  rich: 1,
  simple: 2,
  mass: 4,
  impostor: 8,
} as const satisfies CameraSphereRadii;

function makeCameraSphereRadii(
  lod: ConcreteGraphicsQuality,
): CameraSphereRadii {
  const richRadius =
    CAMERA_SPHERE_BASE_RADIUS * CAMERA_SPHERE_LOD_RADIUS_MULTIPLIERS[lod];
  return {
    rich: Math.round(richRadius * CAMERA_SPHERE_RING_RADIUS_MULTIPLIERS.rich),
    simple: Math.round(
      richRadius * CAMERA_SPHERE_RING_RADIUS_MULTIPLIERS.simple,
    ),
    mass: Math.round(richRadius * CAMERA_SPHERE_RING_RADIUS_MULTIPLIERS.mass),
    impostor: Math.round(
      richRadius * CAMERA_SPHERE_RING_RADIUS_MULTIPLIERS.impostor,
    ),
  };
}

export const PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL = {
  // -------------------------------------------------------------------------
  // Each tier should feel visibly different from the one below it.
  //   MIN  — circles only, no turrets, no legs, no detail (~2 draws/unit)
  //   LOW  — full shapes, simple legs/turrets, palette shading (~6 draws/unit)
  //   MED  — animated legs, core projectiles, scatter deaths (~12 draws/unit)
  //   HIGH — chassis detail, tread animation, standard beams (~25 draws/unit)
  //   MAX  — full joints, barrel spin, trails, inferno explosions (~50 draws/unit)
  // -------------------------------------------------------------------------

  // Unit renderer policy. Object design LOD is now driven by the
  // camera-shell resolver, so every global tier keeps the hybrid path:
  // all units get the cheap packed body, while units inside the rich
  // / simple camera spheres get their ring-appropriate detail mesh.
  UNIT_RENDER_MODE: {
    min: 'hybrid',
    low: 'hybrid',
    medium: 'hybrid',
    high: 'hybrid',
    max: 'hybrid',
  },
  // Camera-centered object LOD sphere radii, in world units. Ground
  // markings are the terrain intersections of these spheres, so their
  // footprints shrink and expand naturally as camera altitude changes.
  // Object size is intentionally ignored so detail is regular and
  // controlled by one set of concentric fidelity shells.
  //
  // Bands:
  //   0..rich       => rich
  //   rich..simple  => simple
  //   simple..mass  => mass
  //   mass..impostor => impostor
  //   outside impostor => marker sphere

  CAMERA_SPHERE_RADII: {
    min: makeCameraSphereRadii('min'),
    low: makeCameraSphereRadii('low'),
    medium: makeCameraSphereRadii('medium'),
    high: makeCameraSphereRadii('high'),
    max: makeCameraSphereRadii('max'),
  },
  // Player-client object LOD grid cell size. This intentionally shares
  // the canonical land-cell size used by the host spatial grid and
  // capture/mana tiles. LOD changes adjust camera sphere radii, quality,
  // cadence, and budgets; the land partition itself stays fixed.
  OBJECT_LOD_CELL_SIZE: LAND_CELL_SIZE,
  HUD_FRAME_STRIDE: {
    min: 4,
    low: 3,
    medium: 2,
    high: 1,
    max: 1,
  },
  EFFECT_FRAME_STRIDE: {
    min: 4,
    low: 3,
    medium: 2,
    high: 1,
    max: 1,
  },
  CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP: {
    min: CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP.MIN,
    low: CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP.LOW,
    medium: CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP.MID,
    high: CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP.HI,
    max: CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP.MAX,
  },
  // Mana/capture tile terrain smoothness by camera-sphere object LOD.
  // The renderer resolves each tile through the same 2D LOD grid as
  // units/buildings, then reads this table for that tile's effective
  // MIN/LOW/MID/HI/MAX desired smoothness. Terrain cells auto-upgrade
  // from this request when the lower mesh would diverge from the shared
  // authoritative triangle surface by more than
  // MANA_TILE_FLAT_HEIGHT_THRESHOLD. Tile borders always keep shared edge
  // samples so adjacent tiles with different smoothness do not crack.
  // Side walls follow the same per-tile camera-sphere tier.
  //
  // Values are per-tile terrain subdivisions. The renderer caps this at
  // TERRAIN_MESH_SUBDIV and rounds non-divisors up to an authoritative
  // subdivision count, so higher values are safe but no richer than the
  // terrain mesh can represent. Coplanar/flat cells collapse to the
  // cheapest mesh at every LOD.
  MANA_TILE_SMOOTHNESS: {
    min: 1,
    low: 2,
    medium: 3,
    high: 4,
    max: 4,
  },
  CAPTURE_TILE_FRAME_STRIDE: {
    min: 8,
    low: 5,
    medium: 3,
    high: 2,
    max: 1,
  },
  CAPTURE_TILE_SIDE_WALLS: {
    min: false,
    low: true,
    medium: true,
    high: true,
    max: true,
  },
  // Water is a static transparent horizon plane. The legacy
  // subdivision/wave/stride knobs are kept in the resolved graphics
  // config for compatibility with older renderer call sites, while
  // opacity controls the one cheap water draw.
  WATER_SUBDIVISIONS: {
    min: 1,
    low: 8,
    medium: 24,
    high: 48,
    max: 96,
  },
  WATER_FRAME_STRIDE: {
    min: 8,
    low: 4,
    medium: 2,
    high: 1,
    max: 1,
  },
  WATER_WAVE_AMPLITUDE: {
    min: 0,
    low: 1.5,
    medium: 3,
    high: 4.5,
    max: 6,
  },
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
    high: 'full',
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

  // Smoke puff emission cadence — render frames skipped between
  // rocket trail samples. Frame-count gating gives stable visual
  // spacing per LOD and avoids time-accumulator backlog bursts after
  // slow frames.
  SMOKE_TRAIL_FRAMES_SKIP: {
    min: 7,
    low: 5,
    medium: 3,
    high: 1,
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

  // Material explosions: part-based wreckage/debris emitted by Debris3D
  // when units die. These are separate from fireball impact explosions.
  // Style controls visual richness, piece budget caps pieces per death,
  // and physics frame skip controls how often debris position/tumble
  // integrates:
  //   0 => every render frame, 1 => every other frame, etc.
  MATERIAL_EXPLOSION_STYLE: {
    min: 'puff',
    low: 'scatter',
    medium: 'shatter',
    high: 'detonate',
    max: 'obliterate',
  },
  MATERIAL_EXPLOSION_PIECE_BUDGET: {
    min: 3,
    low: 6,
    medium: 12,
    high: 24,
    max: 40,
  },
  MATERIAL_EXPLOSION_PHYSICS_FRAMES_SKIP: {
    min: 8,
    low: 5,
    medium: 3,
    high: 1,
    max: 0,
  },

  // Legacy death explosion style alias. Kept aligned with material
  // explosions for older call sites and saved configs.
  DEATH_EXPLOSION_STYLE: {
    min: 'puff',
    low: 'scatter',
    medium: 'shatter',
    high: 'detonate',
    max: 'obliterate',
  },
} as const satisfies GraphicsDetailConfig;
