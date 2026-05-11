/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

// =============================================================================
// TYPE RE-EXPORTS (definitions live in ./types/config.ts)
// =============================================================================

export type {
  SnapshotConfig,
  SnapshotDeltaResolutionConfig,
  EmaLowConfig,
  EmaTierConfig,
  EmaHighConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldImpactVisualConfig,
  ForceFieldTurretShape,
  ForceFieldTurretConfig,
  SpinConfig,
  BarrelShape,
  MapSize,
} from './types/config';

import type {
  SnapshotConfig,
  EmaTierConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldImpactVisualConfig,
  ForceFieldTurretConfig,
  MapSize,
} from './types/config';
import {
  LAND_CELL_SIZE,
  MAP_DIMENSION_CONFIG,
  nearestOddLandCellCount,
} from './mapSizeConfig';
export { LAND_CELL_SIZE } from './mapSizeConfig';

// Default square map span in canonical land cells. Demo Battle and Real Battle
// use the same option set and server/client math, while their selected size is
// persisted per mode. Keep this odd so the map has exactly one central
// land/mana tile.
export const MAP_LAND_CELLS_WIDTH = MAP_DIMENSION_CONFIG.width.default;
export const MAP_LAND_CELLS_LENGTH = MAP_DIMENSION_CONFIG.length.default;

// Logical metal resource footprint, in fine build-grid cells per side.
// This drives the metal-producing square, extractor gridWidth/gridHeight,
// and the visual footprint of both the deposit marker and extractor.
export const METAL_DEPOSIT_RESOURCE_CELLS = 5;

// Circular terrain pad diameter around each metal deposit, in fine
// build-grid cells. This is intentionally separate from the logical
// resource square: it only controls how much nearby terrain is forced flat.
export const METAL_DEPOSIT_FLAT_PAD_CELLS = 20;

// Render-only vertical lift for the terrain mesh above sampled terrain. Keep
// this at 0 for normal play: the terrain renderer, host sim, and client
// prediction all share the same authoritative triangle surface. Use waypoint
// and floating-cell overlay lifts for readability instead of moving terrain.
export const MANA_TILE_GROUND_LIFT = 0;

// 3D waypoint visual lift above the sampled terrain surface. This is
// render-only: command positions and pathfinding still use the actual
// terrain height, while dots/lines/flags float this many world units up
// so mana-tile LOD and overlay layers do not hide them.
export const WAYPOINT_GROUND_LIFT = 12;

// Host-server spatial-grid debug snapshots are intentionally throttled
// separately from normal gameplay snapshots. These overlays are diagnostic
// data, not simulation state, and recomputing/sending them every snapshot can
// create visible hitches at high unit counts.
export const SERVER_GRID_DEBUG_INTERVAL_MS = 250;
export const SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS = 4096;
export const SERVER_GRID_DEBUG_MAX_SEARCH_CELLS = 4096;

// F=============================================================================
// SNAPSHOT / NETWORKING
// =============================================================================

// =============================================================================
// SNAPSHOT THRESHOLDS — what makes a delta "worth sending"
// =============================================================================
//
// On every delta snap the serializer (stateSerializer.ts:getChangedFields)
// compares each entity's current state to the version the client last
// saw and sets a bit in `changedFields` for any field whose change
// exceeds its threshold. Entities with `changedFields === 0` are
// SKIPPED ENTIRELY for that snap — those are the bytes deltas save.
//
// UNITS USED BELOW:
//   - "world unit" (wu) is the sim's native length scale. The map is
//     measured in wu (e.g. ~3000 wu wide); a typical unit's body
//     radius is ~10–20 wu. NOT screen pixels — zoom doesn't change
//     a wu value.
//   - Linear velocity (entity.unit.velocityX/Y) is in wu / SECOND.
//   - Angular velocity (turret.angularVelocity) is in rad / SECOND.
//     (Both are integrated against `dtSec` in the sim — not per-tick.)
//   - Rotation thresholds use Math.PI fractions for precision.
//
// THE TIERS BELOW are reference points only — pick the resolution
// that matches your bandwidth budget vs visual smoothness target.
// Higher resolution = more bytes on the wire, smoother visuals.
export const SNAPSHOT_CONFIG: SnapshotConfig = {
  /** Master switch — false ⇒ every snap is a full keyframe (debug
   *  only; bandwidth roughly 5–10× higher in active play). */
  deltaEnabled: true,

  /** Entity x/y must move more than this many WORLD UNITS for the
   *  serializer to ship a new position. (Vertical z piggybacks on
   *  the same flag.) The right value depends on how visibly choppy
   *  client-side smoothing tolerates between snaps.
   *
   *    LOW resolution  — 2.0 wu
   *      Slow movers drop a position update every few snaps; visible
   *      stepping at moderate zoom. Half the position bytes vs MID.
   *      Use only if bandwidth is the absolute bottleneck.
   *    MID resolution  — 0.5 wu
   *      Sub-pixel under typical zoom; client interpolation hides
   *      the steps. Idle units stay quiet (physics jitter is sub-
   *      0.5 wu). Good general-purpose value.
   *    HIGH resolution — 0.1 wu
   *      Every drift gets sent. Approaches keyframe bandwidth on
   *      lots of mobile units. Reserve for low-unit-count scenes
   *      where you want pixel-perfect motion. */
  positionThreshold: 0.1,

  /** velocityX/Y (in WORLD UNITS / SECOND) must change by more than
   *  this for a fresh velocity field on the wire. Used by the
   *  snapshot serializer AND the projectile / force-field paths that
   *  emit standalone velocity events between snaps. Larger values
   *  hide small accelerations from the client (it extrapolates with
   *  whatever velocity it last saw).
   *
   *    LOW resolution  — 2.0 wu/s
   *      Only large velocity events ship (collisions, big AoE
   *      knockback). Smooth curves coarsen visibly.
   *    MID resolution  — 0.5 wu/s
   *      Catches accel/decel and knockback hits; ignores per-tick
   *      integration jitter.
   *    HIGH resolution — 0.1 wu/s
   *      Every micro-acceleration shipped. Best for slow-motion
   *      replay or low-count debug. */
  velocityThreshold: 0.1,

  /** Body rotation + turret rotations must change by more than this
   *  many RADIANS to re-send. Use Math.PI fractions for clarity —
   *  Math.PI/32 ≈ 0.0982 rad ≈ 5.6°.
   *
   *    LOW resolution  — Math.PI / 8   (≈ 22.5°)
   *      Visibly stuttery on slow turret tracking. Half the
   *      rotation bytes vs MID. Shouldn't be used for combat.
   *    MID resolution  — Math.PI / 32  (≈ 5.6°)
   *      Smooth aim with client-side damped-spring interpolation.
   *      Idle bodies stay quiet.
   *    HIGH resolution — Math.PI / 64  (≈ 2.8°)
   *      Crisp turret motion even on slow trackers; every small
   *      rotation ships. Reserve for cinematic scenes / replays. */
  rotationPositionThreshold: Math.PI / 32,

  /** Turret angular velocity (in RADIANS / SECOND) must change by
   *  more than this for a fresh angular-velocity field on the wire.
   *  Reference scale: Math.PI rad/s ≈ 180°/s; 6 rad/s ≈ 344°/s.
   *
   *    LOW resolution  — 0.5 rad/s
   *      Only major events (target switch, unit death, snap-home).
   *      Client extrapolation coarsens noticeably.
   *    MID resolution  — 0.1 rad/s
   *      Catches target-switches and big rotation accelerations;
   *      ignores spring-damper jitter near steady aim.
   *    HIGH resolution — 0.01 rad/s
   *      Every micro-correction; turret feels glued to the target. */
  rotationVelocityThreshold: 0.1,

  /** Recipient-owned entities keep the baseline diff precision so the
   *  player sees their own orders, collision correction, and turret aim
   *  at full fidelity. */
  ownedEntityDelta: {
    positionThresholdMultiplier: 1,
    velocityThresholdMultiplier: 1,
    rotationPositionThresholdMultiplier: 1,
    rotationVelocityThresholdMultiplier: 1,
  },

  /** Entities owned by other players can use coarser diff precision.
   *  This preserves keyframe/delta correctness while cutting remote
   *  movement + turret churn from every recipient's delta stream. */
  observedEntityDelta: {
    positionThresholdMultiplier: 4,
    velocityThresholdMultiplier: 4,
    rotationPositionThresholdMultiplier: 4,
    rotationVelocityThresholdMultiplier: 4,
  },

  /** Projectile side-channel cadence in emitted snapshots. Spawns and
   *  despawns always ship immediately; this only gates live velocity
   *  corrections and authoritative beam path updates. */
  ownedProjectileUpdateStride: 1,
  observedProjectileUpdateStride: 3,
};

// Re-export bar config values used by sim/server code
export { BATTLE_CONFIG } from './battleBarConfig';
export { SERVER_CONFIG } from './serverBarConfig';
export type { SnapshotRate, KeyframeRatio, TickRate } from './types/server';
import { SERVER_CONFIG } from './serverBarConfig';
import { BATTLE_CONFIG } from './battleBarConfig';
import { BAR_THEMES } from './barThemes';

export const DEFAULT_KEYFRAME_RATIO = SERVER_CONFIG.keyframe.default;
export const KEYFRAME_RATIO_OPTIONS = SERVER_CONFIG.keyframe.options;
export const DEFAULT_SNAPSHOT_RATE = SERVER_CONFIG.snapshot.default;
export const SNAPSHOT_RATE_OPTIONS = SERVER_CONFIG.snapshot.options;
export const MAX_TOTAL_UNITS = BATTLE_CONFIG.cap.default;
export const DEFAULT_MIRRORS_ENABLED = BATTLE_CONFIG.mirrorsEnabled.default;
export const DEFAULT_FORCE_FIELDS_ENABLED =
  BATTLE_CONFIG.forceFieldsEnabled.default;
export const BAR_COLORS = BAR_THEMES;

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

export const EMA_CONFIG: Record<string, EmaTierConfig> = {
  tps: {
    avg: 0.01,
    low: { drop: 0.01, recovery: 0.001 },
  },
  snaps: {
    avg: 0.01,
    low: { drop: 0.01, recovery: 0.001 },
  },
};

// Frame timing EMA config (tracks durations in ms — uses "hi" instead of "low")
const FRAME_MS_EMA: EmaMsConfig = {
  avg: 0.01,
  hi: { spike: 0.01, recovery: 0.001 },
};
export const FRAME_TIMING_EMA = {
  frameMs: FRAME_MS_EMA,
  renderMs: FRAME_MS_EMA,
  logicMs: FRAME_MS_EMA,
  /** Pure ClientViewState.applyPrediction wall-clock per frame.
   *  Pulled OUT of logicMs so the LOGIC bar isolates non-prediction
   *  cost (input, HUD, scene scaffolding) and the PRED bar isolates
   *  the dead-reckon + drift + per-frame turret/shot prediction pass. */
  predMs: FRAME_MS_EMA,
};

/**
 * Initial values for EMA trackers — controls whether each metric starts
 * "high" (optimistic) or "low" (pessimistic) before real samples arrive.
 *
 * Starting HIGH means LOD begins at max quality and degrades if needed.
 * Starting LOW means LOD begins at min quality and climbs if performance allows.
 *
 * Rate trackers (TPS/SPS): high number = good performance.
 * Ms trackers (frame/render/logic): low number = good performance.
 *
 * We seed visible EMA stats at 0.0 so the bottom bars start from an
 * honest empty baseline and climb as real samples arrive. This also
 * means auto-LOD begins pessimistically for TPS-driven signals
 * instead of assuming a healthy mid-tier before measurement.
 */
export const EMA_INITIAL_VALUES = {
  // TPS/CPU host seeds live in GameServer because they depend on the
  // configured tickRateHz.
  tps: 0,
  snaps: 0,

  // Ms trackers drive CPU/GPU/FRAME bars. 0 ms means no measured work yet.
  frameMs: 0,
  renderMs: 0,
  logicMs: 0,
  predMs: 0,
};

// =============================================================================
// SERVER TICK
// =============================================================================

/** Maximum dt (ms) the server will simulate in a single tick.
 *  Prevents spiral-of-death when a tick takes longer than the interval. */
export const MAX_TICK_DT_MS = 4 * (1000 / 60); // ~66.7ms (4 frames at 60Hz)

/** Maximum authoritative beam/laser path segments traced per re-path.
 *  Segment 1 is launch origin -> first hit/range, segment 2 is after the
 *  first reflector, and so on. If the final allowed segment ends on a
 *  reflector, the beam terminates there and does not get endpoint
 *  damage. This prevents mirror/force-field loops from producing
 *  unbounded traces or arbitrary damage spheres. */
export const BEAM_MAX_SEGMENTS = 4;

// =============================================================================
// BATTLE WAYPOINT DEFAULTS
// =============================================================================

/** REAL BATTLE default order type assigned to units produced by
 *  player-built factories/fabricators. Demo-battle factories use
 *  DEMO_CONFIG.factoryWaypointType instead. */
export const REAL_BATTLE_FACTORY_WAYPOINT_TYPE = 'fight' as const;
export const REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE = 0.5;

// =============================================================================
// VISUAL DIMENSIONS (shared sim + render)
// =============================================================================
/** Universal gravity acceleration (world units / s², pulling −z).
 *  Single source of truth for every falling thing — physics engine's
 *  unit bodies, projectile ballistic integration, debris chunks,
 *  explosion spark particles, client-side dead-reckoning. Tuned for
 *  RTS-scale ballistics rather than real-world 9.8 m/s²; the map is
 *  ~3000 wu wide and shots travel hundreds of units per second, so
 *  heavier gravity would flatten every arc into a short lob. */
export const GRAVITY = 100;

/** Free-flight unit velocity damping per 60 Hz frame.
 *  Applied equally to x/y/z while a unit is in free flight. This is
 *  intentionally far weaker than grounded contact drag: 0.002 keeps
 *  about 88.7% of velocity over one second. */
export const UNIT_AIR_FRICTION_PER_60HZ_FRAME = 0.002;

/** Ground-contact tangent velocity damping per 60 Hz frame.
 *  Applied only while the unit's locomotion ground point is at or
 *  below terrain height, and only to motion tangent to the terrain
 *  plane. */
export const UNIT_GROUND_FRICTION_PER_60HZ_FRAME = 0.15;

/** Terrain spring acceleration per world-unit of ground-point
 *  penetration. Force is mass * acceleration, so all unit masses
 *  settle at the same tiny gravity sag depth. */
export const UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT = 900;

/** Damping ratio for the terrain spring along the terrain normal.
 *  1 is critical damping for the spring's authored acceleration
 *  frequency. The ground never pulls downward; damping only reduces
 *  or increases the upward spring response. */
export const UNIT_GROUND_SPRING_DAMPING_RATIO = 1;

/** Maximum outward terrain-normal velocity passive ground contact can
 *  produce. This permits small damped settling oscillation, but stops
 *  the terrain spring from acting like a jump actuator. Explicit jump
 *  forces can add their own per-tick outward velocity above this cap;
 *  they do not let passive spring rebound bypass the cap entirely. */
export const UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED = 5;

/** D-gun wave altitude above local terrain. The D-gun is no longer a
 *  ballistic shell; it rides the terrain at this offset until its
 *  configured lifespan expires. */
export const DGUN_TERRAIN_FOLLOW_HEIGHT = 4;

// =============================================================================
// ECONOMY & RESOURCES
// =============================================================================

/** Starting energy stockpile for each player */
export const STARTING_STOCKPILE = 500;

/** Maximum energy stockpile capacity */
export const MAX_STOCKPILE = 1000;

/** Base energy income per second (before solar panels) */
export const BASE_INCOME_PER_SECOND = 10;

/** Starting mana stockpile for each player */
export const STARTING_MANA = 200;

/** Maximum mana stockpile capacity */
export const MAX_MANA = 1000;

/** Base mana income per second (before territory) */
export const BASE_MANA_PER_SECOND = 5;

/** Starting metal stockpile for each player */
export const STARTING_METAL = 200;

/** Maximum metal stockpile capacity */
export const MAX_METAL = 1000;

/** Base metal income per second (before extractors). Kept low — players
 *  are meant to claim deposits and run extractors on them for serious
 *  metal income, not coast on the passive drip. */
export const BASE_METAL_PER_SECOND = 2;

/** Metal produced per second by each completed extractor sitting on a
 *  metal deposit. Tuned so 1 extractor ≈ 1 solar in income scale. */
export const EXTRACTOR_METAL_PER_SECOND = 50;

// Per-tile territory mana income uses BASE_MANA_PER_SECOND above as
// the perimeter rate, scaled by the central-hotspot config in
// captureConfig.ts (MANA_CENTER_TILE_MULTIPLIER, MANA_HOTSPOT_RADIUS_FRACTION).
// A team's per-tile income is `flag_height × tile_rate`, where the
// flag height is its OWNERSHIP RATIO and the tile rate comes from
// the hotspot falloff.

// =============================================================================
// UNIT CAP
// =============================================================================

/** Energy produced per second by each completed solar panel */
export const SOLAR_ENERGY_PER_SECOND = 50;
export const WIND_ENERGY_PER_SECOND = 50;
export const WIND_SPEED_MIN = 0.25;
export const WIND_SPEED_MAX = 1.55;

/** Wind direction oscillation wave periods in seconds. These are true
 *  sine/cosine periods, not angular divisors. Longer = slower turning. */
const wmult = 0.5;

export const WIND_DIRECTION_OSCILLATION_PERIODS_SECONDS = {
  primary: 96 * wmult,
  secondary: 173 * wmult,
  tertiary: 317 * wmult,
} as const;

/** Wind magnitude/speed oscillation wave periods in seconds. Longer =
 *  slower production-multiplier drift for Wind buildings. */
export const WIND_SPEED_OSCILLATION_PERIODS_SECONDS = {
  primary: 42 * wmult,
  secondary: 89 * wmult,
  tertiary: 157 * wmult,
} as const;

/** Visual wind turbine rotor speed, in radians per second at wind speed 1.0.
 *  Actual blade rotation is `wind.speed * WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED`. */
export const WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED = 2;

/** Wind turbine visual EMA half-life multipliers layered on top of the
 *  selected PLAYER CLIENT DRIFT preset.
 *
 *  1.0 = exactly the selected DRIFT half-life.
 *  <1.0 = faster turbine response.
 *  >1.0 = smoother/slower turbine response.
 *  0.0 = snap for that channel.
 */
export const WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS = {
  fanYaw: 4,
  bladeSpeed: 1.0,
} as const;

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
 * Beam/railgun knockback uses momentum-based force (mass × velocity × PROJECTILE_MASS_MULTIPLIER).
 */
export const KNOCKBACK: KnockbackConfig = {
  SPLASH: 250, // Knockback multiplier for area/splash explosions (mortar/disruptor)
};

/**
 * Whether turrets return to forward-facing (movement direction) when they have no target.
 * true = turrets snap back to face forward when idle.
 * false = turrets hold their last rotation when idle.
 */
export const TURRET_RETURN_TO_FORWARD = false;

// Color conversion utilities
export function hexToStr(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
export function hexToRgb(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

// Map colors
export const MAP_BG_COLOR = 0x445138; // in-bounds background
export const MAP_OOB_COLOR = 0x121820; // out-of-bounds background
export const MAP_CAMERA_BG = 0x8fb1c9; // camera clear color
export const MAP_GRID_COLOR = MAP_BG_COLOR;

// Render-only fake horizon extent for the transparent water plane and
// submerged "infinity" terrain shelf around circle-perimeter maps.
// Kept shared so water and terrain always terminate at the same practical
// distance. This is only a few giant quads, so raising it is cheap; the
// camera far plane still controls what actually draws.
export const HORIZON_RENDER_EXTEND = 180000;

// Render-only water surface tuning. `color` is the tint of the flat
// horizon water plane; `opacity` is material alpha. Lower opacity =
// more transparent.
export const WATER_RENDER_CONFIG = {
  color: 0x1f6f8c,
  opacity: 0.82,
} as const;

// Static sky background gradient. Generated once as a tiny canvas
// texture by ThreeApp, then reused as the scene background.
export const SKY_RENDER_CONFIG = {
  topColor: '#6d9dcc',
  midColor: '#b7cddd',
  horizonColor: '#e1d5bd',
  midStop: 0.64,
} as const;

export const FOREST_SPRUCE2_WOOD_COLOR = 0x5b4230;
export const FOREST_SPRUCE2_LEAF_COLOR = 0x416f35;

// One shared sun definition for scene lights, terrain shading, and
// cheap contact-shadow offsets. Azimuth is in sim/map space:
// x=+east, y=+south. A diagonal, lower sun angle makes baked terrain
// shadows readable without paying for real-time shadow maps.
export const SUN_RENDER_CONFIG = {
  azimuthRad: -Math.PI * 0.25,
  elevationRad: Math.PI * 0.12,
  color: 0xfff0cf,
  ambientIntensity: 0.24,
  directionalIntensity: 1.45,
  distance: 6000,
  visibleSkyDisk: {
    enabled: true,
    distance: 60000,
    size: 1900,
    texturePixels: 128,
    coreColor: '#fff8dc',
    haloColor: '#f0b860',
    coreRadius: 0.18,
    haloRadius: 0.66,
    opacity: 0.86,
  },
} as const;

// Static terrain shading is baked into terrain vertices when the mesh
// is rebuilt. It is not a real-time shadow map; it is a cheap, stable
// directional shade plus short terrain self-shadow probes along the
// sun ray.
export const TERRAIN_SHADOW_RENDER_CONFIG = {
  enabled: true,
  ambient: 0.34,
  directStrength: 1.08,
  minShade: 0.26,
  maxShade: 1.18,
  precomputed: {
    enabled: true,
    samples: 7,
    sampleDistance: LAND_CELL_SIZE * 0.26,
    bias: 16,
    softness: 82,
    strength: 0.58,
  },
} as const;

// Render-only blend that hides the color seam where the authoritative
// gameplay terrain hands off to the non-gameplay horizon shelf/water.
// `boundaryFadeStart`/`boundaryFadeEnd` are in the existing circular
// map-boundary fade space: 0 = full gameplay terrain, 1 = shelf/water.
// Square maps also get a small rectangular edge band in world units.
export const TERRAIN_HORIZON_BLEND_CONFIG = {
  enabled: true,
  boundaryFadeStart: 0.58,
  boundaryFadeEnd: 1,
  rectangularEdgeStartDistance: LAND_CELL_SIZE * 2.5,
  rectangularEdgeEndDistance: 0,
  color: 0x163f4c,
  shade: 1,
} as const;

/** Master switch for the procedural shader-drawn ground detail in the
 *  terrain fragment shader — the per-cell rotated grass-blade and twig
 *  rectangles that hash-place themselves across flat green ground. When
 *  false, the terrain keeps just the underlying biome colors (low/dry
 *  grass, rock, shoreline soil) without any of the four box-mark layers. */
export const TERRAIN_GROUND_DETAIL_ENABLED = true;

/** The base color flat green ground gets pulled toward before the detail
 *  texture is applied. Defaults to the spruce leaf color so that grass clumps
 *  and tree foliage sit on a matching-color ground patch instead of standing
 *  out against a different-shade base. */
export const TERRAIN_GROUND_BASE_COLOR = FOREST_SPRUCE2_LEAF_COLOR;

/** How strongly the generated detail PNG overrides the base ground color in
 *  flat green areas, in [0, 1]. 0 = pure base color (clean, props rooted in
 *  a single color), 1 = full texture influence (noisy / busy). */
export const TERRAIN_GROUND_DETAIL_CONTRAST = 0.3;

/** World-Y range where the ground detail (the green base-color pull *and*
 *  the sticks-and-grass texture, both gated by the same mask) is allowed.
 *  Below MIN: full strength. Above MAX: zero. Smooth fade in between.
 *  Restricts the detail to the map's base 0-height flat zone — raised
 *  plateaus, uplands, and cliff sides all get the regular slope/height
 *  terrain colors with no green carpet or texture. */
export const TERRAIN_GROUND_DETAIL_HEIGHT_MIN = 5;
export const TERRAIN_GROUND_DETAIL_HEIGHT_MAX = 40;

/** Same idea as the ground detail texture, but applied to every surface that
 *  is NOT part of the base 0-height flat zone — cliffs, mountain faces,
 *  plateaus. Sampled triplanar in the shader so vertical surfaces render
 *  correctly. Toggle, base color, and contrast knob mirror the ground set. */
export const TERRAIN_ROCK_DETAIL_ENABLED = true;
export const TERRAIN_ROCK_BASE_COLOR = 0x6f6a5b;
export const TERRAIN_ROCK_DETAIL_CONTRAST = 0.1;

// Stable render layering for ground-adjacent systems. Contact shadows
// render after terrain (so terrain depth is in the buffer for occlusion
// tests) but before units/buildings (so entities overdraw shadows
// naturally). Shadows depth-test against terrain so mountains occlude
// them; polygonOffset on the shadow material keeps them from z-fighting
// with the ground they sit on.
export const GROUND_RENDER_ORDER = {
  terrain: -20,
  contactShadows: -10,
} as const;

// Cheap object grounding shadows. This intentionally avoids Three.js
// shadow maps: all units/buildings write into one transparent instanced
// contact-shadow mesh and update at LOD-dependent strides.
export const CONTACT_SHADOW_RENDER_CONFIG = {
  enabled: true,
  maxInstances: 16000,
  lift: 1.35,
  opacity: {
    min: 0.11,
    low: 0.13,
    medium: 0.16,
    high: 0.18,
    max: 0.2,
  },
  frameStride: {
    min: 4,
    low: 3,
    medium: 2,
    high: 1,
    max: 1,
  },
  unitShotRadiusMultiplier: 1.25,
  buildingRadiusMultiplier: 0.72,
  minBuildingRadius: 22,
  sunStretch: 1.35,
  crossSunSquash: 0.78,
  unitSunOffsetPerHeight: 0.18,
  buildingSunOffsetPerHeight: 0.22,
  maxSunOffset: 70,
} as const;

// Seam-safe mana tile terrain texture. These waves are evaluated from
// world-space X/Z only, so adjacent mana tiles share exact vertex colors
// on shared edges and corners.
/** Global period multiplier for every sine wave in MANA_TILE_TEXTURE.
 *
 *  1.0 = the configured tile-width periods below.
 *  2.0 = all waves are twice as wide / slower-changing.
 *  0.5 = all waves are half as wide / more frequent.
 *
 *  This replaces the old local `mmult` scale multiplier. The current
 *  value preserves the previous `mmult = 0.02` broad-stroke period.
 */
export const MANA_TILE_TEXTURE_PERIOD_MULTIPLIER = 0.2;
/** Static baked mana-surface texture resolution. Higher values preserve
 *  more procedural texture detail without requiring more terrain
 *  triangles; cost is one small GPU texture per map. */
export const MANA_TILE_TEXTURE_PIXELS_PER_TILE = 32;
/** Master switch for the procedural sine-wave swirls in the mana/ground texture.
 *  When false, the terrain keeps a flat base color and still receives baked
 *  lighting/shadows from TERRAIN_SHADOW_RENDER_CONFIG. */
export const MANA_TILE_TEXTURE_SWIRLS_ENABLED = true;

const manaTileWaveScale = (tileWidths: number): number =>
  (Math.PI * 2) /
  (LAND_CELL_SIZE * tileWidths * MANA_TILE_TEXTURE_PERIOD_MULTIPLIER);

export const MANA_TILE_TEXTURE = {
  xWaves: [
    { scale: manaTileWaveScale(20.4), phase: 1.31, amplitude: 0.14 },
    { scale: manaTileWaveScale(17.8), phase: 4.76, amplitude: 0.16 },
  ],
  zWaves: [
    { scale: manaTileWaveScale(32.7), phase: 2.38, amplitude: 0.11 },
    { scale: manaTileWaveScale(23.6), phase: 5.11, amplitude: 0.14 },
  ],
  cross: {
    // Keep this at 0 by default: a strong `(x + z)` term reads as a
    // regular 45-degree pattern across the mana grid.
    scale: manaTileWaveScale(61.5),
    phase: 1.9,
    amplitude: 0,
    xInfluence: 0.31,
    zInfluence: -0.73,
  },
  fleck: {
    xScale: manaTileWaveScale(35.2),
    zScaleMultiplier: 0.61,
    xPhase: 3.37,
    zPhase: 0.94,
    amplitude: 0.025,
    power: 1.6,
  },
  vein: {
    xScale: manaTileWaveScale(38.5),
    zScale: manaTileWaveScale(53.7),
    xWarpScale: manaTileWaveScale(34.3),
    zWarpScale: manaTileWaveScale(61.9),
    xWarpAmplitude: 3.2,
    zWarpAmplitude: 2.6,
    amplitude: 0.18,
    power: 1.8,
  },
  base: {
    brightness: 0.52,
    xWaveAmplitude: 0.07,
    zWaveAmplitude: 0.06,
    color: { r: 0.025, g: 0.045, b: 0.052 },
  },
  tone: {
    // Signed grayscale texture layer. The combined procedural wave
    // signal maps negative -> black, zero -> gray, positive -> white,
    // then blends back into the mana-tile base color.
    neutral: 0.28,
    contrast: 0.88,
    mix: 0.36,
  },
  overlayOpacity: {
    min: 0.46,
    max: 0.76,
  },
} as const;

export const MANA_TILE_TEXTURE_CACHE_KEY = JSON.stringify({
  swirlsEnabled: MANA_TILE_TEXTURE_SWIRLS_ENABLED,
  texture: MANA_TILE_TEXTURE,
});

// Scorched earth burn mark colors and decay
export const BURN_COLOR_HOT = 0x882200; // bright red start
export const BURN_COLOR_COOL = MAP_BG_COLOR; // fades to background
export const BURN_COLOR_TAU = 200; // color decay: red → black (ms), fast
export const BURN_COOL_TAU = 500; // color decay: black → background (ms), slow

export const FORCE_FIELD_BARRIER: import('./game/sim/blueprints/types').ForceFieldBarrierRatioConfig =
  {
    outerRatio: 0.8,
    // Sphere origin sits below the turret origin by this fraction of
    // the computed outer radius. 0.5 means "half a field radius down".
    originOffsetRadiusRatio: 0.3,
    color: 0xffffff,
    alpha: 0.05,
    particleAlpha: 0.2,
  };

/** Force-field shield visual configuration. The bubble + emitter
 *  render at every tier; the MAX-tier orbital rings are tuned via
 *  RING_* constants inside ForceFieldRenderer3D rather than here. */
export const FORCE_FIELD_VISUAL: ForceFieldVisualConfig = {
  colorMode: 'config',
  fallbackColor: 0xffffff,
  emitterIdleColor: 0xffffff,
};

/** Force-field projectile interception visual.
 *  The burst is a flat tangent-plane pulse at the sphere intersection:
 *  its plane normal is the shield surface normal, so the expanding ring
 *  lies 90 degrees from the impact normal. */
export const FORCE_FIELD_IMPACT_VISUAL: ForceFieldImpactVisualConfig = {
  style: 'tangentRingPulse',
  colorMode: 'config',
  fallbackColor: 0xffffff,
  maxImpacts: 192,
  durationMs: 420,
  ringCount: 3,
  ringSegments: 48,
  ringDelayMs: 55,
  startRadius: 5,
  endRadius: 38,
  ringTubeRadiusFrac: 0.11,
  ringTubeSegments: 6,
  // Match the force-field/mirror panel transparency:
  // FORCE_FIELD_BARRIER.alpha (0.05) * FORCE_FIELD_OPACITY_BOOST (2.0) = 0.1.
  ringOpacity: 0.1,
  coreRadiusFrac: 0.42,
  coreOpacity: 0.22,
  coreDurationFrac: 0.45,
  surfaceOffset: 1.2,
};

/**
 * Force field turret (grate) configuration per unit type.
 * All length/width values are multipliers of the unit's collision radius.
 */
export const FORCE_FIELD_TURRET: Record<string, ForceFieldTurretConfig> = {
  forceField: {
    shape: 'circle',
    count: 5,
    length: 0.0,
    width: 0.45,
    taper: 0.5,
    baseOffset: 0.0,
    originOffset: 0,
    thickness: 1.5,
    reversePhase: true,
  },
};

// =============================================================================
// CHASSIS MOUNT POINTS
// =============================================================================

/**
 * Where weapons attach on each unit chassis.
 * x = forward offset, y = lateral offset (both as multipliers of unit collision radius).
 * Position is computed as: mountWorldX = unitX + cos(bodyRot)*x*r - sin(bodyRot)*y*r
 */
// CHASSIS_MOUNTS removed — now in blueprints

// LEG_CONFIG removed — now in blueprints
// TREAD_CONFIG removed — now in blueprints
// WHEEL_CONFIG removed — now in blueprints

// COMMANDER_STATS removed — now in blueprints

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
 * Global mass multiplier for all projectiles.
 * Scales recoil on shooter and knockback on target.
 * 1.0 = use raw mass values from PROJECTILE_STATS
 * Higher = more recoil/knockback, lower = less
 */
export const PROJECTILE_MASS_MULTIPLIER = 1.0;

/**
 * Global thrust multiplier for all unit movement.
 * Scales the force applied when units accelerate toward waypoints.
 * Higher values = faster acceleration, higher top speed.
 * 1.0 = default, 0.5 = sluggish, 2.0 = snappy
 */
export const UNIT_THRUST_MULTIPLIER_GAME = 20.0;

/**
 * Global HP multiplier applied to every unit at creation time. The
 * blueprint hp is the "base" stat; the unit's actual hp/maxHp at
 * spawn is base × this. 1.0 = blueprint values; 2.0 = double defense
 * (units take twice as many hits to kill at the same incoming DPS).
 */
export const UNIT_HP_MULTIPLIER = 2.0;

/**
 * Vertical distance between terrain and a unit's locomotion ground
 * point at spawn. The unit body center is initialized at:
 *
 *   terrain height + bodyCenterHeight + this offset
 *
 * so newly-created units begin in freefall and settle through the same
 * gravity / terrain-spring path as every other airborne unit.
 */
export const UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND = 3;

// TARGETING_REACQUIRE_STRIDE moved to serverSimLodConfig.ts as part of
// the HOST SERVER LOD ladder — the stride is now picked per-tick from
// the resolved sim quality tier. See simQuality.getSimDetailConfig().

// UNIT_STATS removed — now in blueprints

// PROJECTILE_STATS removed — now in blueprints

// WEAPON_STATS removed — now in blueprints

// =============================================================================
// MAP SIZE SETTINGS
// =============================================================================

export const normalizeMapLandCells = nearestOddLandCellCount;

const landCellMapSpan = (landCells: number): number =>
  normalizeMapLandCells(landCells) * LAND_CELL_SIZE;

export function mapSizeFromLandCells(
  widthLandCells: number,
  lengthLandCells: number = widthLandCells,
): MapSize {
  return {
    width: landCellMapSpan(widthLandCells),
    height: landCellMapSpan(lengthLandCells),
  };
}

const UNIVERSAL_MAP_SIZE = mapSizeFromLandCells(
  MAP_LAND_CELLS_WIDTH,
  MAP_LAND_CELLS_LENGTH,
);

export const MAP_SETTINGS: Record<string, MapSize> = {
  // Both modes share one authoritative land-cell map size. With the default
  // 320wu land cell and 21 cells per axis, every battle is 6720x6720wu.
  game: UNIVERSAL_MAP_SIZE,
  demo: UNIVERSAL_MAP_SIZE,
};

/** Pick the map size for the current battle. Demo and real currently share
 *  the same dimensions; keep the parameter for existing call sites. */
export function getMapSize(
  _backgroundMode: boolean,
  widthLandCells: number = MAP_LAND_CELLS_WIDTH,
  lengthLandCells: number = MAP_LAND_CELLS_LENGTH,
): MapSize {
  return mapSizeFromLandCells(widthLandCells, lengthLandCells);
}

// =============================================================================
// BACKGROUND GAME SETTINGS
// =============================================================================

/**
 * Unit spawn distribution for background battle.
 * - true: Inverse cost weighting (cheaper units spawn more frequently)
 * - false: Flat distribution (all units equally likely)
 */
export const BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING = true;

// Re-export audio config
export { AUDIO } from './audioConfig';
export type { SynthId, SoundEntry } from './audioConfig';

// =============================================================================
// UI
// =============================================================================

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

/** Main 3D game camera vertical field-of-view in degrees.
 *  Lower values feel like a narrower/telephoto lens; higher values
 *  feel like a wider-angle lens. This is lens FOV, not the orbit
 *  camera's pitch angle against the terrain. */
export const CAMERA_FOV_DEGREES = 30;

/** Minimum zoom level (zoomed out) */
export const ZOOM_MIN = 0.2;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = 40.0;

/**
 * Per-wheel-tick zoom fraction. Each scroll-IN moves the camera
 * this fraction of the way toward the world point under the
 * cursor (the actual rendered ground/water hit, not a flat-plane
 * approximation). Scroll-OUT applies the inverse factor 1/(1−f),
 * so a scroll-in followed by a scroll-out lands back at the same
 * camera state.
 *
 *   factor_in  = (1 − f)         → distance shrinks by f
 *   factor_out = 1 / (1 − f)     → exact inverse of factor_in
 *
 * 0.125 keeps roughly the historical 1.125-multiplier "feel" but
 * the cursor's world point stays pinned through the move.
 */
export const ZOOM_STEP_FRACTION = 0.2;

/** Initial zoom level for the demo game (zoomed out overview) */
export const ZOOM_INITIAL_DEMO = 3.5;

/** Initial zoom level when a real game starts. Higher = closer.
 *  3.0 frames the local commander as a clearly visible sphere
 *  (~50 px on a 3150-wu map at default FOV) so the player has
 *  something to look AT on spawn instead of a featureless ground
 *  with two distant dots. The 0.5 default that came over from the
 *  2D era put the camera ~2× baseDistance away — fine when the
 *  map is full of units, useless when a real game opens with just
 *  two commanders. The user can wheel out to see the opponent. */
export const ZOOM_INITIAL_GAME = 3.0;

/** GAME LOBBY preview pane — pulled WAY back so the whole map
 *  fits in the small box and players can read the terrain layout
 *  (CENTER + DIVIDERS) at a glance. The preview shows commanders
 *  only (no units, no buildings) and slowly orbits around the map
 *  center, so a wide framing makes the relative spawn positions
 *  legible during the spin. */
export const ZOOM_INITIAL_LOBBY_PREVIEW = 0.6;

/** Continuous-orbit rate (radians per second) for the GAME LOBBY
 *  preview camera. ~5.3 °/s = a full rotation every ~68 s — slow
 *  enough that it reads as "alive" rather than "frantic". */
export const LOBBY_PREVIEW_SPIN_RATE = 0.0925;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = 6.0;

/**
 * Where the wheel-zoom and alt+middle-click rotate operations
 * are anchored on the world.
 *
 *   - 'cursor'        → ground point under the mouse cursor
 *   - 'screen-center' → ground point at the center of the screen
 *
 * Each interaction has its own knob so the three behaviors can be
 * mixed (e.g. zoom in toward cursor but zoom out from the screen
 * center, which feels more like a stable pull-back than an
 * exact-inverse "back along the cursor pin"). The picker for both
 * modes is the same 3D raycast helper — when the chosen point
 * misses geometry, the camera falls back to a y=0 plane projection.
 */
export type CameraAnchorMode = 'cursor' | 'screen-center';

/** Anchor for SCROLL-IN (wheel deltaY < 0). Defaults to cursor so
 *  zooming in continues to pull the world toward the spot the
 *  player is pointing at — the existing "zoom toward what I'm
 *  looking at" feel. Set to `'screen-center'` to dolly in along
 *  the view axis instead. */
export const CAMERA_ZOOM_IN_ANCHOR: CameraAnchorMode = 'cursor';

/** Anchor for SCROLL-OUT (wheel deltaY > 0). Defaults to
 *  `'screen-center'` so zooming out reads as a normal pull-back
 *  from the framed scene, not the geometric inverse of the cursor-
 *  anchored zoom-in (which would yank whatever was under the
 *  cursor toward the screen center as the camera receded). The two
 *  defaults intentionally diverge: in to cursor, out from center. */
export const CAMERA_ZOOM_OUT_ANCHOR: CameraAnchorMode = 'screen-center';

/** Anchor for ALT + middle-click ORBIT (camera rotation). Defaults
 *  to `'screen-center'` so the framed view rotates around itself
 *  rather than around whichever spot the cursor happens to be
 *  hovering — easier to keep the scene composed while tumbling.
 *  Set to `'cursor'` to pivot around whatever the player is
 *  pointing at (the previous cursor-anchored behavior). */
export const CAMERA_ROTATE_ANCHOR: CameraAnchorMode = 'screen-center';

/** Minimum world-Y gap (sim units) between the camera and the
 *  terrain directly beneath it. Acts as the TRUE "minimum zoom"
 *  rail: the wheel-zoom altitude clamp uses
 *  `terrain(x,z) + CAMERA_MIN_TERRAIN_CLEARANCE` as its floor (not
 *  the flat altitudeMin), so the player can never zoom into a hill
 *  or get pinned between mountains. The same value is also used by
 *  the per-frame camera lift in `OrbitCamera.apply()` as a hard
 *  backstop. Tune up if "minimum zoom" feels too close to terrain;
 *  down if you want the camera able to nuzzle the surface. 80 is
 *  visually safe across the current heightmap (mountains ~750 wu,
 *  TILE_FLOOR_Y = -1200) and well above z-fighting range. */
export const CAMERA_MIN_TERRAIN_CLEARANCE = 80;

/** Half-width (sim units) of the band the orbit-camera target's Y
 *  coordinate is clamped to, measured from the terrain height at
 *  the target's XZ. Bounds cursor-pin's 3D Y drift: every wheel
 *  event blends `target.y` with the cursor's world-point Y, and
 *  zoom-OUT in particular (α > 1) PUSHES target away from the
 *  anchor rather than toward it — so target.y multiplies by
 *  (1 + zoomStepFraction) per click whenever the cursor is below
 *  the target. Across many zoom-in/out cycles target.y can balloon
 *  far above (or below) any real surface, until the altitudeMax/Min
 *  clamps invert the user's zoom direction and the camera gets
 *  stuck at a low effective zoom-out. The band re-anchors target.y
 *  to the actual terrain elevation it's flying over, killing the
 *  drift while still letting cursor-pin work for normal slopes
 *  within ±BAND wu. */
export const CAMERA_TARGET_TERRAIN_BAND = 200;

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = 20.0;
