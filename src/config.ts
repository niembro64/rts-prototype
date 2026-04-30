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
  EmaLowConfig,
  EmaTierConfig,
  EmaHighConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldTurretShape,
  ForceFieldTurretConfig,
  SpinConfig,
  BarrelShape,
  MountPoint,
  BuildingStatEntry,
  MapSize,
} from './types/config';

import type {
  SnapshotConfig,
  EmaTierConfig,
  EmaMsConfig,
  KnockbackConfig,
  ForceFieldVisualConfig,
  ForceFieldTurretConfig,
  BuildingStatEntry,
  MapSize,
} from './types/config';

// Spatial grid cell size in pixels. Should be roughly 1/2 to 1/3 of typical weapon range.
export const SPATIAL_GRID_CELL_SIZE = 150;


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
export const DEFAULT_PROJ_VEL_INHERIT = BATTLE_CONFIG.projVelInherit.default;
export const DEFAULT_FIRING_FORCE = BATTLE_CONFIG.firingForce.default;
export const DEFAULT_HIT_FORCE = BATTLE_CONFIG.hitForce.default;
export const DEFAULT_FF_ACCEL_UNITS = BATTLE_CONFIG.ffAccelUnits.default;
export const DEFAULT_FF_ACCEL_SHOTS = BATTLE_CONFIG.ffAccelShots.default;
export const BAR_COLORS = BAR_THEMES;

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

export const EMA_CONFIG: Record<string, EmaTierConfig> = {
  tps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
  fps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
  snaps: {
    avg: 0.01,
    low: { drop: 0.5, recovery: 0.0001 },
  },
};

// Frame timing EMA config (tracks durations in ms — uses "hi" instead of "low")
const FRAME_MS_EMA: EmaMsConfig = { avg: 0.01, hi: { spike: 0.5, recovery: 0.0001 } };
export const FRAME_TIMING_EMA = {
  frameMs: FRAME_MS_EMA,
  renderMs: FRAME_MS_EMA,
  logicMs: FRAME_MS_EMA,
};

/**
 * Initial values for EMA trackers — controls whether each metric starts
 * "high" (optimistic) or "low" (pessimistic) before real samples arrive.
 *
 * Starting HIGH means LOD begins at max quality and degrades if needed.
 * Starting LOW means LOD begins at min quality and climbs if performance allows.
 *
 * Rate trackers (FPS/TPS/SPS): high number = good performance.
 * Ms trackers (frame/render/logic): low number = good performance.
 */
export const EMA_INITIAL_VALUES = {
  // Rate trackers — start optimistic (high = good)
  tps:      60,     // assume 60 ticks/sec until measured
  fps:      60,     // assume 60 frames/sec until measured
  snaps:    32,     // assume 32 snapshots/sec until measured

  // Ms trackers — start optimistic (low = good)
  frameMs:  1,      // assume 1ms frame time until measured
  renderMs: 0.5,    // assume 0.5ms render time until measured
  logicMs:  0.5,    // assume 0.5ms logic time until measured
};

// =============================================================================
// SERVER TICK
// =============================================================================

/** Maximum dt (ms) the server will simulate in a single tick.
 *  Prevents spiral-of-death when a tick takes longer than the interval. */
export const MAX_TICK_DT_MS = 4 * (1000 / 60); // ~66.7ms (4 frames at 60Hz)

// =============================================================================
// VISUAL DIMENSIONS (shared sim + render)
// =============================================================================
// The sim knows each unit's physics sphere (radius around transform.z),
// but the visible chassis + turret mesh sits *above* that sphere center.
// Chassis heights are now per-unit (derived from the unit's render body
// shape — see src/game/math/BodyDimensions.ts), so the only shared
// vertical constant left here is the turret head extent.

/** Vertical extent of a turret's head (barrel cluster sits at
 *  mid-height of the turret head). Projectile spawn altitude =
 *  bodyTopY(renderer, radius) + TURRET_HEIGHT/2, computed per-unit
 *  in getUnitMuzzleHeight (sim/combat/combatUtils.ts). */
export const TURRET_HEIGHT = 16;

/** World-y of the bottom edge of a mirror-unit's reflective panels,
 *  measured above the unit's ground footprint. Shared sim + render
 *  constant so beam reflection (which needs the panel's vertical span)
 *  and the 3D renderer draw the exact same rectangle. A small positive
 *  value keeps the panel off the ground tile to avoid z-fighting. */
export const MIRROR_BASE_Y = 2;

/** Extra vertical height added above the unit's turret top when sizing
 *  mirror panels. Tuned so mirrorHeight (= bodyTop + TURRET_HEIGHT +
 *  this − MIRROR_BASE_Y) matches the panel's edge length on a Loris,
 *  giving a square front face (≈ 40 wu). Shared sim + render constant —
 *  also drives the lift applied to non-mirror turrets on mirror-host
 *  units (they sit on top of the panel stack). */
export const MIRROR_EXTRA_HEIGHT = 15;

/** Maximum length for a live beam's ray trace, in world units.
 *  Turrets still fire only when their target is within weapon.ranges
 *  — once firing the beam extends along its aim up to this distance,
 *  truncating earlier if it hits a mirror / unit / building. After
 *  reflection the remainder is shortened by the distance already
 *  travelled, so the TOTAL polyline length (across all bounces) is
 *  bounded by this value. About half the 3000-wu map width. */
export const BEAM_MAX_LENGTH = 1500;

/** Universal gravity acceleration (world units / s², pulling −z).
 *  Single source of truth for every falling thing — physics engine's
 *  unit bodies, projectile ballistic integration, debris chunks,
 *  explosion spark particles, client-side dead-reckoning. Tuned for
 *  RTS-scale ballistics rather than real-world 9.8 m/s²; the map is
 *  ~3000 wu wide and shots travel hundreds of units per second, so
 *  heavier gravity would flatten every arc into a short lob. */
export const GRAVITY = 400;

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
  FORCE_FIELD_PULL_MULTIPLIER: 2.0, // Multiplier applied to each weapon's pullPower
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
export const MAP_BG_COLOR = 0x0a0e0f; // in-bounds background
export const MAP_OOB_COLOR = 0x08080f; // out-of-bounds background
export const MAP_CAMERA_BG = 0x0a0a14; // camera clear color
export const MAP_GRID_COLOR = MAP_BG_COLOR;

// Scorched earth burn mark colors and decay
export const BURN_COLOR_HOT = 0x882200; // bright red start
export const BURN_COLOR_COOL = MAP_BG_COLOR; // fades to background
export const BURN_COLOR_TAU = 200; // color decay: red → black (ms), fast
export const BURN_COOL_TAU = 500; // color decay: black → background (ms), slow

/**
 * Two-state hysteresis range multipliers (relative to weapon base range).
 *
 * Each weapon has two states with hysteresis (acquire < release prevents flickering):
 *   - tracking: turret pre-aims at approaching enemies
 *   - engage: weapon actively fires
 *
 * Hierarchy (outer to inner):
 *   tracking.release (1.1x) > tracking.acquire (1.0x) > engage.release (0.95x) > engage.acquire (0.9x)
 */
export const TURRET_RANGE_MULTIPLIERS: import('./game/sim/types').TurretRangeMultipliers =
  {
    tracking: { acquire: 1.0, release: 1.1 },
    engage: { acquire: 0.9, release: 0.95 },
  };
export const FORCE_TURRET_RANGE_MULTIPLIERS: import('./game/sim/types').TurretRangeMultipliers =
  {
    tracking: { acquire: 1.0, release: 1.1 },
    engage: { acquire: 1.0, release: 1.05 },
  };

export const FORCE_PUSH: import('./game/sim/blueprints/types').ForceFieldZoneRatioConfig =
  {
    innerRatio: 0.0,
    outerRatio: 0.5,
    color: 0x3366ff,
    alpha: 0.05,
    particleAlpha: 0.2,
    power: 1400,
  };

/**
 * Force field weapon visual configuration.
 * Controls the pie-slice zone, concentric wave arcs, and inward-moving particle lines.
 */
export const FORCE_FIELD_VISUAL: ForceFieldVisualConfig = {
  // --- Particle lines (radial dashes moving inward) ---
  particleCount: 20, // Number of radial particle lines around full circle
  particleSpeed: 10, // Inward travel speed
  particleLength: 0.1, // Length as fraction of maxRange (0.2 = 20%)
  particleThickness: 1, // Line thickness (px)

  // --- Enhanced-only: electric arcs ---
  arcCount: 4, // Number of lightning arcs visible at once
  arcSegments: 6, // Segments per arc (more = more jagged)
  arcJitter: 15, // Max perpendicular offset per segment (px)
  arcThickness: 1.5, // Line thickness of arcs (px)
  arcOpacity: 0.5, // Peak opacity of arcs
  arcFlickerMs: 80, // How often arcs re-randomize (ms) — lower = faster crackle

  // --- Enhanced-only: particle trails ---
  trailSegments: 3, // Number of trailing ghost segments behind each particle
  trailSpacing: 0.6, // Spacing between trail segments as fraction of dashLen
  trailFalloff: 0.45, // Opacity multiplier per successive trail segment
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
  megaForceField: {
    shape: 'circle',
    count: 7,
    length: 0.0,
    width: 0.25,
    taper: 0.7,
    baseOffset: 0.0,
    originOffset: 0.0,
    thickness: 4.5,
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

export const BUILDING_STATS: Record<string, BuildingStatEntry> = {
  solar: {
    energyCost: 100, // Base energy cost (before multiplier)
    hp: 200,
  },
  wind: {
    energyCost: 60, // Base energy cost (before multiplier)
    hp: 100,
  },
  factory: {
    energyCost: 300, // Base energy cost (before multiplier)
    hp: 800,
  },
};

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
 * Scales recoil on shooter, knockback on target, and resistance to force field pull.
 * 1.0 = use raw mass values from PROJECTILE_STATS
 * Higher = more recoil/knockback, lower = less
 */
export const PROJECTILE_MASS_MULTIPLIER = 1.0;

/**
 * Barrel thickness multiplier — scales the derived barrel width on turrets.
 * Barrel width is derived from projectile size (collision.radius * 2 for bullets, beam.width for beams).
 * 1.0 = barrel matches projectile diameter exactly, 0.5 = half-width barrels, 2.0 = double-width.
 */
export const BARREL_THICKNESS_MULTIPLIER = 0.8;

/**
 * Global thrust multiplier for all unit movement.
 * Scales the force applied when units accelerate toward waypoints.
 * Higher values = faster acceleration, higher top speed.
 * 1.0 = default, 0.5 = sluggish, 2.0 = snappy
 */
export const UNIT_THRUST_MULTIPLIER_GAME = 6.0;
export const UNIT_THRUST_MULTIPLIER_DEMO = 6.0;

/**
 * Global HP multiplier applied to every unit at creation time. The
 * blueprint hp is the "base" stat; the unit's actual hp/maxHp at
 * spawn is base × this. 1.0 = blueprint values; 2.0 = double defense
 * (units take twice as many hits to kill at the same incoming DPS).
 */
export const UNIT_HP_MULTIPLIER = 2.0;

// TARGETING_REACQUIRE_STRIDE moved to serverSimLodConfig.ts as part of
// the HOST SERVER LOD ladder — the stride is now picked per-tick from
// the resolved sim quality tier. See simQuality.getSimDetailConfig().

// UNIT_STATS removed — now in blueprints

// PROJECTILE_STATS removed — now in blueprints

// WEAPON_STATS removed — now in blueprints

// =============================================================================
// MAP SIZE SETTINGS
// =============================================================================

export const MAP_SETTINGS: Record<string, MapSize> = {
  // Real (foreground) match. Demo / lobby battle uses MAP_SETTINGS.demo
  // (2× linear) so the AI vs. AI showcase has more breathing room.
  //
  // Sized to a multiple of SPATIAL_GRID_CELL_SIZE * (2k+1) so each axis
  // ends up with an ODD number of tiles, giving the map a single
  // central tile (the ripple-disc visualization is centered there).
  // 3150 / 150 = 21 tiles per axis (game); 6150 / 150 = 41 (demo).
  game: { width: 3_150, height: 3_150 },
  demo: { width: 6_150, height: 6_150 },
};

/** Pick the map size for the current battle: demo (background) or game (real). */
export function getMapSize(backgroundMode: boolean): MapSize {
  return backgroundMode ? MAP_SETTINGS.demo : MAP_SETTINGS.game;
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

/** How often to sample combat stats for the history graph (ms) */
export const COMBAT_STATS_SAMPLE_INTERVAL = 200;

/** Maximum number of combat stats snapshots to retain (samples × interval = time window) */
export const COMBAT_STATS_HISTORY_MAX = 25; // 1200 × 500ms = 10 minutes

/** Whether the Combat Statistics modal is visible on page load */
export const COMBAT_STATS_VISIBLE_ON_LOAD = false;

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

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
export const ZOOM_INITIAL_DEMO = 1.5;

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
