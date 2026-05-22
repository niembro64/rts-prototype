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
import sharedSimConstants from './sharedSimConstants.json';
import snapshotConfigJson from './snapshotConfig.json';
import emaConfigJson from './emaConfig.json';
import combatConfigJson from './combatConfig.json';
import worldRenderConfigJson from './worldRenderConfig.json';
import forceFieldVisualConfigJson from './forceFieldVisualConfig.json';
import economyConfigJson from './economyConfig.json';
import windConfigJson from './windConfig.json';
import physicsTuningConfigJson from './physicsTuningConfig.json';
import serverDebugGridConfigJson from './serverDebugGridConfig.json';
import cameraConfigJson from './cameraConfig.json';
import realBattleConfigJson from './realBattleConfig.json';
import backgroundBattleConfigJson from './backgroundBattleConfig.json';
import type { CameraFovDegrees } from './types/client';
import type { DemoBattleWaypointType } from './demoConfig';
import { COLORS } from './colorsConfig';
export { LAND_CELL_SIZE } from './mapSizeConfig';

// Default square map span in canonical land cells. Demo Battle and Real Battle
// use the same option set and server/client math, while their selected size is
// persisted per mode. Keep this odd so the map has exactly one central
// land tile.
export const MAP_LAND_CELLS_WIDTH = MAP_DIMENSION_CONFIG.width.default;
export const MAP_LAND_CELLS_LENGTH = MAP_DIMENSION_CONFIG.length.default;

// Render-only vertical lift for the terrain mesh above sampled terrain. Keep
// this at 0 for normal play: the terrain renderer, host sim, and client
// prediction all share the same authoritative triangle surface. Use waypoint
// and floating-cell overlay lifts for readability instead of moving terrain.
export const LAND_TILE_GROUND_LIFT = worldRenderConfigJson.landTileGroundLift;

// 3D waypoint visual lift above the sampled terrain surface. This is
// render-only: command positions and pathfinding still use the actual
// terrain height, while dots/lines/flags float this many world units up
// so terrain LOD and overlay layers do not hide them.
export const WAYPOINT_GROUND_LIFT = worldRenderConfigJson.waypointGroundLift;

// Host-server spatial-grid debug snapshots are intentionally throttled
// separately from normal gameplay snapshots. These overlays are diagnostic
// data, not simulation state, and recomputing/sending them every snapshot can
// create visible hitches at high unit counts.
export const SERVER_GRID_DEBUG_INTERVAL_MS = serverDebugGridConfigJson.snapshotIntervalMs;
export const SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS = serverDebugGridConfigJson.maxOccupiedCells;
export const SERVER_GRID_DEBUG_MAX_SEARCH_CELLS = serverDebugGridConfigJson.maxSearchCells;

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
//
// Authored values live in src/snapshotConfig.json:
//   deltaEnabled            — master switch; false ⇒ every snap is a
//                             full keyframe (debug only; ~5-10×
//                             bandwidth in active play).
//   positionThreshold       — entity x/y must move more than this
//                             many WORLD UNITS to re-send. LOW 2.0,
//                             MID 0.5, HIGH 0.1.
//   velocityThreshold       — velocityX/Y must change by more than
//                             this (WORLD UNITS / SECOND) to re-send.
//                             LOW 2.0, MID 0.5, HIGH 0.1.
//   rotationPositionThreshold — body + turret rotations must change
//                               by more than this many RADIANS to
//                               re-send. LOW π/8 ≈ 0.3927 (22.5°),
//                               MID π/32 ≈ 0.0982 (5.6°), HIGH π/64
//                               ≈ 0.0491 (2.8°). The JSON value
//                               below is π/32 evaluated to a
//                               literal.
//   rotationVelocityThreshold — turret angular velocity (RAD / SEC)
//                               re-send threshold. LOW 0.5, MID
//                               0.1, HIGH 0.01.
//   ownedEntityDelta        — multipliers applied to the four
//                             thresholds above for recipient-owned
//                             entities. 1 keeps full fidelity on
//                             your own units' orders / aim.
//   observedEntityDelta     — same multipliers for entities owned by
//                             other players. Set >1 to coarsen
//                             remote movement / turret churn.
//   minimapSnapshotRateHz   — upper cadence for full minimap contact
//                             lists on delta snapshots. Keyframes
//                             always carry a fresh minimap baseline.
export const SNAPSHOT_CONFIG: SnapshotConfig = snapshotConfigJson;

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
export const DEFAULT_FORCE_FIELDS_OBSTRUCT_SIGHT =
  BATTLE_CONFIG.forceFieldsObstructSight.default;
export const DEFAULT_FORCE_FIELD_REFLECTION_MODE =
  BATTLE_CONFIG.forceFieldReflectionMode.default;
export const BAR_COLORS = BAR_THEMES;

// =============================================================================
// EMA (Exponential Moving Average) STATS TRACKING
// =============================================================================

// Authored values live in src/emaConfig.json.
//   tiers.<name>   — rate trackers (TPS, SPS). avg is the per-sample
//                    α; low.drop and low.recovery drive the
//                    asymmetric "dip fast, climb slow" tier so the
//                    bottom bar reads a sustained dip even after the
//                    average recovers.
//   frameMs        — the shared shape every per-frame ms tracker
//                    (frameMs / renderMs / logicMs / predMs) uses;
//                    "hi" is the dual of "low" so the spike side
//                    drops fast and the recovery side bleeds back
//                    slowly. predMs isolates the
//                    ClientViewState.applyPrediction wall-clock so
//                    LOGIC stays input/HUD/scaffolding-only.
//   initialValues  — seed values for every EMA. Rate trackers get
//                    "good = high", ms trackers get "good = low";
//                    seeding everything at 0 means the bottom bars
//                    start from an honest empty baseline and auto-
//                    LOD begins pessimistically for TPS-driven
//                    signals instead of assuming a healthy mid-tier.
//                    TPS/CPU host seeds live in GameServer because
//                    they depend on the configured tickRateHz.
export const EMA_CONFIG: Record<string, EmaTierConfig> = emaConfigJson.tiers;

const FRAME_MS_EMA: EmaMsConfig = emaConfigJson.frameMs;
export const FRAME_TIMING_EMA = {
  frameMs: FRAME_MS_EMA,
  renderMs: FRAME_MS_EMA,
  logicMs: FRAME_MS_EMA,
  predMs: FRAME_MS_EMA,
};

export const EMA_INITIAL_VALUES = emaConfigJson.initialValues;

// =============================================================================
// SERVER TICK
// =============================================================================

/** Maximum dt (ms) the server will simulate in a single tick.
 *  Prevents spiral-of-death when a tick takes longer than the interval.
 *  JSON value is 4 frames at 60Hz (~66.7ms). */
export const MAX_TICK_DT_MS = sharedSimConstants.maxTickDtMs;

/** Maximum authoritative beam/laser path segments traced per re-path.
 *  Segment 1 is launch origin -> first hit/range, segment 2 is after the
 *  first reflector, and so on. If the final allowed segment ends on a
 *  reflector, the beam terminates there and does not get endpoint
 *  damage. This prevents mirror/force-field loops from producing
 *  unbounded traces or arbitrary damage spheres. */
export const BEAM_MAX_SEGMENTS = combatConfigJson.beamMaxSegments;

export type RocketReflectorCollisionMode = 'explode' | 'reflect';

/** Rocket behavior when hitting mirror panels or force-field barriers.
 *  "explode" detonates at the reflector contact point. "reflect" uses the
 *  same velocity-preserving reflection path as normal projectiles. */
export const ROCKET_REFLECTOR_COLLISION_MODE: RocketReflectorCollisionMode =
  combatConfigJson.rocketReflectorCollisionMode as RocketReflectorCollisionMode;

// =============================================================================
// BATTLE WAYPOINT DEFAULTS
// =============================================================================

/** REAL BATTLE default order type assigned to units produced by
 *  player-built factories/fabricators. Demo-battle factories use
 *  DEMO_CONFIG.factoryWaypointType instead. */
export const REAL_BATTLE_FACTORY_WAYPOINT_TYPE =
  realBattleConfigJson.factoryWaypointType as DemoBattleWaypointType;
export const REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE =
  realBattleConfigJson.factoryWaypointDistance;

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
export const GRAVITY = sharedSimConstants.gravity;

/** Free-flight unit velocity damping per 60 Hz frame.
 *  Applied equally to x/y/z while a unit is in free flight. This is
 *  intentionally far weaker than grounded contact drag: 0.02 keeps
 *  about 30% of velocity over one second. */
export const UNIT_AIR_FRICTION_PER_60HZ_FRAME =
  sharedSimConstants.unitAirFrictionPer60HzFrame;

/** Ground-contact tangent velocity damping per 60 Hz frame.
 *  Applied only while the unit's locomotion ground point is at or
 *  below terrain height, and only to motion tangent to the terrain
 *  plane. */
export const UNIT_GROUND_FRICTION_PER_60HZ_FRAME =
  sharedSimConstants.unitGroundFrictionPer60HzFrame;

/** Terrain spring acceleration per world-unit of ground-point
 *  penetration. Force is mass * acceleration, so all unit masses
 *  settle at the same tiny gravity sag depth. */
export const UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT =
  sharedSimConstants.unitGroundSpringAccelPerWorldUnit;

/** Damping ratio for the terrain spring along the terrain normal.
 *  1 is critical damping for the spring's authored acceleration
 *  frequency. The ground never pulls downward; damping only reduces
 *  or increases the upward spring response. */
export const UNIT_GROUND_SPRING_DAMPING_RATIO =
  sharedSimConstants.unitGroundSpringDampingRatio;

/** Maximum outward terrain-normal velocity passive ground contact can
 *  produce. This permits small damped settling oscillation, but stops
 *  the terrain spring from launching units off the surface. */
export const UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED =
  sharedSimConstants.unitGroundPassiveReboundMaxSpeed;

/** Body sleep transition tick threshold shared with the WASM integrator. */
export const BODY_SLEEP_TICKS = sharedSimConstants.bodySleepTicks;

/** D-gun wave altitude above local terrain. The D-gun is no longer a
 *  ballistic shell; it rides the terrain at this offset until its
 *  range-derived runtime timeout expires. */
export const DGUN_TERRAIN_FOLLOW_HEIGHT = physicsTuningConfigJson.dgun.terrainFollowHeight;

// =============================================================================
// ECONOMY & RESOURCES
// =============================================================================

/** Starting energy stockpile for each player */
export const STARTING_STOCKPILE = economyConfigJson.energy.startingStockpile;

/** Maximum energy stockpile capacity */
export const MAX_STOCKPILE = economyConfigJson.energy.maxStockpile;

/** Base energy income per second (before solar panels) */
export const BASE_INCOME_PER_SECOND = economyConfigJson.energy.baseIncomePerSecond;

/** Starting metal stockpile for each player */
export const STARTING_METAL = economyConfigJson.metal.startingStockpile;

/** Maximum metal stockpile capacity */
export const MAX_METAL = economyConfigJson.metal.maxStockpile;

/** Base metal income per second (before extractors). Kept low — players
 *  are meant to claim deposits and run extractors on them for serious
 *  metal income, not coast on the passive drip. */
export const BASE_METAL_PER_SECOND = economyConfigJson.metal.baseIncomePerSecond;

/** Metal produced per second by each completed extractor sitting on a
 *  metal deposit. Tuned so 1 extractor ≈ 1 solar in income scale. */
export const EXTRACTOR_METAL_PER_SECOND = economyConfigJson.metal.extractorPerSecond;

// =============================================================================
// UNIT CAP
// =============================================================================

/** Energy produced per second by each completed solar panel */
export const SOLAR_ENERGY_PER_SECOND = economyConfigJson.energy.solarEnergyPerSecond;
export const WIND_ENERGY_PER_SECOND = windConfigJson.energyPerSecond;
export const WIND_SPEED_MIN = windConfigJson.speed.min;
export const WIND_SPEED_MAX = windConfigJson.speed.max;

/** Wind direction oscillation wave periods in seconds. These are true
 *  sine/cosine periods, not angular divisors. Longer = slower turning. */
export const WIND_DIRECTION_OSCILLATION_PERIODS_SECONDS =
  windConfigJson.directionOscillationPeriodsSeconds;

/** Wind magnitude/speed oscillation wave periods in seconds. Longer =
 *  slower production-multiplier drift for Wind buildings. */
export const WIND_SPEED_OSCILLATION_PERIODS_SECONDS =
  windConfigJson.speedOscillationPeriodsSeconds;

/** Visual wind turbine rotor speed, in radians per second at wind speed 1.0.
 *  Actual blade rotation is `wind.speed * WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED`. */
export const WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED =
  windConfigJson.turbine.rotorRadPerSecPerWindSpeed;

/** Wind turbine visual EMA half-life multipliers layered on top of the
 *  selected PLAYER CLIENT DRIFT preset.
 *
 *  1.0 = exactly the selected DRIFT half-life.
 *  <1.0 = faster turbine response.
 *  >1.0 = smoother/slower turbine response.
 *  0.0 = snap for that channel.
 */
export const WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS =
  windConfigJson.turbine.driftEmaHalfLifeMultipliers;

// =============================================================================
// COST MULTIPLIER
// =============================================================================

/**
 * Multiplier applied to all unit and building energy costs.
 * 1.0 = normal costs, 2.0 = double costs, 3.0 = triple costs
 */
export const COST_MULTIPLIER = economyConfigJson.costMultiplier;

// =============================================================================
// COMBAT PHYSICS
// =============================================================================

/**
 * Knockback forces for combat. Each value is a multiplier applied to damage.
 * Force = damage * multiplier. 0 = disabled.
 *
 * Beam/railgun knockback uses momentum-based force (mass × velocity × PROJECTILE_MASS_MULTIPLIER).
 */
export const KNOCKBACK: KnockbackConfig = combatConfigJson.knockback;

// Color conversion utilities
export function hexToStr(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
export function hexToRgb(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

// Map colors
export const MAP_BG_COLOR = COLORS.world.map.inBounds.colorHex; // in-bounds background
export const MAP_OOB_COLOR = COLORS.world.map.outOfBounds.colorHex; // out-of-bounds background
export const MAP_CAMERA_BG = COLORS.world.map.cameraClear.colorHex; // camera clear color
export const MAP_GRID_COLOR = MAP_BG_COLOR;

// Render-only fake horizon extent for the transparent water plane and
// submerged "infinity" terrain shelf around circle-perimeter maps.
// Kept shared so water and terrain always terminate at the same practical
// distance. This is only a few giant quads, so raising it is cheap; the
// camera far plane still controls what actually draws.
export const HORIZON_RENDER_EXTEND = worldRenderConfigJson.horizonRenderExtend;

// Render-only water surface tuning. `color` is the tint of the flat
// horizon water plane; `opacity` is material alpha. Lower opacity =
// more transparent.
export const WATER_RENDER_CONFIG = {
  color: COLORS.world.water.colorHex,
  opacity: COLORS.world.water.opacity,
} as const;

// Static sky background gradient. Generated once as a tiny canvas
// texture by ThreeApp, then reused as the scene background.
export const SKY_RENDER_CONFIG = COLORS.world.sky;

export const FOREST_SPRUCE2_WOOD_COLOR = COLORS.environment.forestSpruce2.wood.colorHex;
export const FOREST_SPRUCE2_LEAF_COLOR = COLORS.environment.forestSpruce2.leaf.colorHex;

// One shared sun definition for scene lights, terrain shading, and
// cheap contact-shadow offsets. Azimuth is in sim/map space:
// x=+east, y=+south. A diagonal, lower sun angle makes baked terrain
// shadows readable without paying for real-time shadow maps.
export const SUN_RENDER_CONFIG = {
  ...worldRenderConfigJson.sun,
  color: COLORS.world.sun.colorHex,
  visibleSkyDisk: {
    ...worldRenderConfigJson.sun.visibleSkyDisk,
    coreColor: COLORS.world.sun.visibleSkyDisk.coreColor,
    haloColor: COLORS.world.sun.visibleSkyDisk.haloColor,
    haloFadeColor: COLORS.world.sun.visibleSkyDisk.haloFadeColor,
    spriteColor: COLORS.world.sun.visibleSkyDisk.spriteColorHex,
    opacity: COLORS.world.sun.visibleSkyDisk.opacity,
  },
} as const;

// Static terrain shading is baked into terrain vertices when the mesh
// is rebuilt. It is not a real-time shadow map; it is a cheap, stable
// directional shade plus short terrain self-shadow probes along the
// sun ray. JSON stores `sampleDistance` as a LAND_CELL_SIZE
// multiplier so the absolute value is recomputed if the map's cell
// size ever changes.
export const TERRAIN_SHADOW_RENDER_CONFIG = {
  ...worldRenderConfigJson.terrainShadow,
  precomputed: {
    ...worldRenderConfigJson.terrainShadow.precomputed,
    sampleDistance:
      LAND_CELL_SIZE *
      worldRenderConfigJson.terrainShadow.precomputed.sampleDistanceLandCellMultiplier,
  },
} as const;

// Render-only blend that hides the color seam where the authoritative
// gameplay terrain hands off to the non-gameplay horizon shelf/water.
// `boundaryFadeStart`/`boundaryFadeEnd` are in the existing circular
// map-boundary fade space: 0 = full gameplay terrain, 1 = shelf/water.
// Square maps also get a small rectangular edge band in world units.
export const TERRAIN_HORIZON_BLEND_CONFIG = {
  enabled: worldRenderConfigJson.terrainHorizonBlend.enabled,
  boundaryFadeStart: worldRenderConfigJson.terrainHorizonBlend.boundaryFadeStart,
  boundaryFadeEnd: worldRenderConfigJson.terrainHorizonBlend.boundaryFadeEnd,
  rectangularEdgeStartDistance:
    LAND_CELL_SIZE * worldRenderConfigJson.terrainHorizonBlend.rectangularEdgeStartLandCellMultiplier,
  rectangularEdgeEndDistance: worldRenderConfigJson.terrainHorizonBlend.rectangularEdgeEndDistance,
  color: COLORS.world.terrain.horizonBlend.colorHex,
  shade: COLORS.world.terrain.horizonBlend.shade,
} as const;

/** Master switch for the procedural shader-drawn ground detail in the
 *  terrain fragment shader — the per-cell rotated grass-blade and twig
 *  rectangles that hash-place themselves across flat green ground. When
 *  false, the terrain keeps just the underlying biome colors (low/dry
 *  grass, rock, shoreline soil) without any of the four box-mark layers. */
export const TERRAIN_GROUND_DETAIL_ENABLED =
  worldRenderConfigJson.terrainGroundDetail.enabled;

/** The base color flat green ground gets pulled toward before the detail
 *  texture is applied. Defaults to the spruce leaf color so that grass clumps
 *  and tree foliage sit on a matching-color ground patch instead of standing
 *  out against a different-shade base. */
export const TERRAIN_GROUND_BASE_COLOR = COLORS.world.terrain.ground.baseColorHex;

/** How strongly the generated detail PNG overrides the base ground color in
 *  flat green areas, in [0, 1]. 0 = pure base color (clean, props rooted in
 *  a single color), 1 = full texture influence (noisy / busy). */
export const TERRAIN_GROUND_DETAIL_CONTRAST = COLORS.world.terrain.ground.detailContrast;

/** World-Y distance from the 0-height plane where the ground detail (the
 *  green base-color pull *and* the sticks-and-grass texture, both gated by
 *  the same mask) is allowed. Within MIN of 0: full strength. Beyond MAX
 *  from 0: zero. Smooth fade in between.
 *  Restricts the detail to the map's base 0-height flat zone: raised
 *  plateaus, lower shelves, uplands, and cliff sides all get the regular
 *  slope/height terrain colors with no green carpet or texture. */
export const TERRAIN_GROUND_DETAIL_HEIGHT_MIN =
  worldRenderConfigJson.terrainGroundDetail.heightMin;
export const TERRAIN_GROUND_DETAIL_HEIGHT_MAX =
  worldRenderConfigJson.terrainGroundDetail.heightMax;

/** World-space radius over which nearby angled terrain attenuates the green
 *  grass mask. Even a completely flat triangle that falls within this radius
 *  of a steep face is treated as partially sloped — so the grass / green
 *  base color fades smoothly inward from cliffs toward the center of the
 *  flat region rather than snapping to full green right at the cliff base.
 *  Beyond this radius the fade decays to zero, so the deep interior of a
 *  flat region reaches full grass. Larger = wider fade band; 0 disables it. */
export const TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_RADIUS =
  worldRenderConfigJson.terrainGroundDetail.neighborhoodFadeRadius;

/** Exponent applied to the linear distance term when computing each ring
 *  sample's weight: weight = (1 - distance / radius) ^ FALLOFF. Higher
 *  values concentrate the influence near the cliff and let grass recover
 *  to full strength sooner as you move into the flat region. 1 = linear
 *  (broad fade reaching nearly the full radius), 2 = quadratic (most of
 *  the fade happens in the first half of the radius — recommended), 3+ =
 *  even faster recovery into full grass. */
export const TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_FALLOFF =
  worldRenderConfigJson.terrainGroundDetail.neighborhoodFadeFalloff;

/** Same idea as the ground detail texture, but applied to every surface that
 *  is NOT part of the base 0-height flat zone — cliffs, mountain faces,
 *  plateaus. Sampled triplanar in the shader so vertical surfaces render
 *  correctly. Toggle, base color, and contrast knob mirror the ground set. */
export const TERRAIN_ROCK_DETAIL_ENABLED =
  worldRenderConfigJson.terrainRockDetail.enabled;
export const TERRAIN_ROCK_BASE_COLOR = COLORS.world.terrain.rock.baseColorHex;
export const TERRAIN_ROCK_DETAIL_CONTRAST = COLORS.world.terrain.rock.detailContrast;

/** How strongly the procedural tree-leaf / tree-trunk textures override the
 *  prop's solid base color, in [0, 1]. 0 = pure base color (the original
 *  flat green / brown look), 1 = full texture variation. Same semantics as
 *  the terrain detail contrast knobs above, but baked into the canvas at
 *  texture-generation time (trees use stock MeshLambertMaterial so there's
 *  nowhere to mix at shader time). Changing this value requires a reload —
 *  the textures are generated once and cached. */
export const TREE_LEAF_DETAIL_CONTRAST = worldRenderConfigJson.tree.leaf.detailContrast;
export const TREE_TRUNK_DETAIL_CONTRAST = worldRenderConfigJson.tree.trunk.detailContrast;

/** How many times the tree-leaf / tree-trunk texture tiles per UV unit on
 *  the model. Trees come in at a small global scale, so a face that covers
 *  most of UV [0, 1] is only a few dozen screen pixels — mipmaps average
 *  away the individual shapes and only the texture's mean color comes
 *  through. Tiling repeats packs more pattern copies into each face so the
 *  shapes survive even at heavy minification. Bark especially benefits
 *  from a higher repeat because the look depends on seeing many vertical
 *  cracks per trunk height. Trade-off: too high and the pattern reads as
 *  obvious tiling instead of organic surface. */
export const TREE_LEAF_TEXTURE_REPEAT = worldRenderConfigJson.tree.leaf.textureRepeat;
export const TREE_TRUNK_TEXTURE_REPEAT = worldRenderConfigJson.tree.trunk.textureRepeat;

// Stable render layering for ground-adjacent systems. Contact shadows
// render after terrain (so terrain depth is in the buffer for occlusion
// tests) but before units/buildings (so entities overdraw shadows
// naturally). Shadows depth-test against terrain so mountains occlude
// them; polygonOffset on the shadow material keeps them from z-fighting
// with the ground they sit on.
export const GROUND_RENDER_ORDER = worldRenderConfigJson.groundRenderOrder;

// Cheap object grounding shadows. This intentionally avoids Three.js
// shadow maps: all units/buildings write into one transparent instanced
// contact-shadow mesh and update at LOD-dependent strides.
export const CONTACT_SHADOW_RENDER_CONFIG = worldRenderConfigJson.contactShadow;

// Scorched earth burn mark colors and decay
export const BURN_COLOR_HOT = COLORS.world.burnMark.hotColorHex; // bright red start
export const BURN_COLOR_TAU = worldRenderConfigJson.burnMark.colorTauMs; // color decay: red → black (ms), fast
export const BURN_COOL_TAU = worldRenderConfigJson.burnMark.coolTauMs; // color decay: black → background (ms), slow

export const FORCE_FIELD_BARRIER: import('./game/sim/blueprints/types').ForceFieldBarrierRatioConfig =
  {
    ...forceFieldVisualConfigJson.barrier,
    color: COLORS.effects.forceField.barrier.colorHex,
    alpha: COLORS.effects.forceField.barrier.alpha,
    particleAlpha: COLORS.effects.forceField.barrier.particleAlpha,
  };

/** Force-field shield visual configuration. The bubble + emitter
 *  render at every tier; the MAX-tier orbital rings are tuned via
 *  RING_* constants inside ForceFieldRenderer3D rather than here. */
export const FORCE_FIELD_VISUAL: ForceFieldVisualConfig =
  {
    ...forceFieldVisualConfigJson.shield,
    fallbackColor: COLORS.effects.forceField.shield.fallbackColorHex,
    emitterIdleColor: COLORS.effects.forceField.shield.emitterIdleColorHex,
  } as ForceFieldVisualConfig;

/** Force-field projectile interception visual.
 *  The burst is a flat tangent-plane pulse at the sphere intersection:
 *  its plane normal is the shield surface normal, so the expanding ring
 *  lies 90 degrees from the impact normal. Ring opacity matches the
 *  force-field / mirror panel transparency:
 *  FORCE_FIELD_BARRIER.alpha (0.05) * FORCE_FIELD_OPACITY_BOOST (2.0) = 0.1. */
export const FORCE_FIELD_IMPACT_VISUAL: ForceFieldImpactVisualConfig =
  {
    ...forceFieldVisualConfigJson.impact,
    fallbackColor: COLORS.effects.forceField.impact.fallbackColorHex,
    ringOpacity: COLORS.effects.forceField.impact.ringOpacity,
    coreOpacity: COLORS.effects.forceField.impact.coreOpacity,
  } as ForceFieldImpactVisualConfig;

/**
 * Force field turret (grate) configuration per unit type.
 * All length/width values are multipliers of the unit's collision radius.
 */
export const FORCE_FIELD_TURRET: Record<string, ForceFieldTurretConfig> =
  forceFieldVisualConfigJson.turret as Record<string, ForceFieldTurretConfig>;

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
export const UNIT_MASS_MULTIPLIER = physicsTuningConfigJson.unit.massMultiplier;

/**
 * Global mass multiplier for all projectiles.
 * Scales recoil on shooter and knockback on target.
 * 1.0 = use raw mass values from PROJECTILE_STATS
 * Higher = more recoil/knockback, lower = less
 */
export const PROJECTILE_MASS_MULTIPLIER = physicsTuningConfigJson.projectile.massMultiplier;

/**
 * Global thrust multiplier for all unit movement.
 * Scales the force applied when units accelerate toward waypoints.
 * Higher values = faster acceleration, higher top speed.
 * 1.0 = default, 0.5 = sluggish, 2.0 = snappy
 */
export const UNIT_THRUST_MULTIPLIER_GAME = physicsTuningConfigJson.unit.thrustMultiplier;

/**
 * Global HP multiplier applied to every unit at creation time. The
 * blueprint hp is the "base" stat; the unit's actual hp/maxHp at
 * spawn is base × this. 1.0 = blueprint values; 2.0 = double defense
 * (units take twice as many hits to kill at the same incoming DPS).
 */
export const UNIT_HP_MULTIPLIER = physicsTuningConfigJson.unit.hpMultiplier;

/**
 * Vertical distance between terrain and a unit's locomotion ground
 * point at spawn. The unit body center is initialized at:
 *
 *   terrain height + bodyCenterHeight + this offset
 *
 * so newly-created units begin in freefall and settle through the same
 * gravity / terrain-spring path as every other airborne unit.
 */
export const UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND = physicsTuningConfigJson.unit.initialSpawnHeightAboveGround;

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
export const BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING =
  backgroundBattleConfigJson.spawnInverseCostWeighting;

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
export const CAMERA_FOV_DEGREES = cameraConfigJson.fovDegrees as CameraFovDegrees;

/** Minimum zoom level (zoomed out) */
export const ZOOM_MIN = cameraConfigJson.zoom.min;

/** Maximum zoom level (zoomed in) */
export const ZOOM_MAX = cameraConfigJson.zoom.max;

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
export const ZOOM_STEP_FRACTION = cameraConfigJson.zoom.stepFraction;

/** Initial zoom level for the demo game (zoomed out overview) */
export const ZOOM_INITIAL_DEMO = cameraConfigJson.zoom.initialDemo;

/** Initial zoom level when a real game starts. Higher = closer.
 *  3.0 frames the local commander as a clearly visible sphere
 *  (~50 px on a 3150-wu map at default FOV) so the player has
 *  something to look AT on spawn instead of a featureless ground
 *  with two distant dots. The 0.5 default that came over from the
 *  2D era put the camera ~2× baseDistance away — fine when the
 *  map is full of units, useless when a real game opens with just
 *  two commanders. The user can wheel out to see the opponent. */
export const ZOOM_INITIAL_GAME = cameraConfigJson.zoom.initialGame;

/** GAME LOBBY preview pane — pulled WAY back so the whole map
 *  fits in the small box and players can read the terrain layout
 *  (CENTER + DIVIDERS) at a glance. The preview shows commanders
 *  only (no units, no buildings) and slowly orbits around the map
 *  center, so a wide framing makes the relative spawn positions
 *  legible during the spin. */
export const ZOOM_INITIAL_LOBBY_PREVIEW = cameraConfigJson.zoom.initialLobbyPreview;

/** Continuous-orbit rate (radians per second) for the GAME LOBBY
 *  preview camera. ~5.3 °/s = a full rotation every ~68 s — slow
 *  enough that it reads as "alive" rather than "frantic". */
export const LOBBY_PREVIEW_SPIN_RATE = cameraConfigJson.lobbyPreview.spinRate;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = cameraConfigJson.panMultiplier;

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
export const CAMERA_ZOOM_IN_ANCHOR: CameraAnchorMode = cameraConfigJson.anchor.zoomIn as CameraAnchorMode;

/** Anchor for SCROLL-OUT (wheel deltaY > 0). Defaults to
 *  `'screen-center'` so zooming out reads as a normal pull-back
 *  from the framed scene, not the geometric inverse of the cursor-
 *  anchored zoom-in (which would yank whatever was under the
 *  cursor toward the screen center as the camera receded). The two
 *  defaults intentionally diverge: in to cursor, out from center. */
export const CAMERA_ZOOM_OUT_ANCHOR: CameraAnchorMode = cameraConfigJson.anchor.zoomOut as CameraAnchorMode;

/** Anchor for ALT + middle-click ORBIT (camera rotation). Defaults
 *  to `'screen-center'` so the framed view rotates around itself
 *  rather than around whichever spot the cursor happens to be
 *  hovering — easier to keep the scene composed while tumbling.
 *  Set to `'cursor'` to pivot around whatever the player is
 *  pointing at (the previous cursor-anchored behavior). */
export const CAMERA_ROTATE_ANCHOR: CameraAnchorMode = cameraConfigJson.anchor.rotate as CameraAnchorMode;

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
export const CAMERA_MIN_TERRAIN_CLEARANCE = cameraConfigJson.minTerrainClearance;

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
export const CAMERA_TARGET_TERRAIN_BAND = cameraConfigJson.targetTerrainBand;

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = cameraConfigJson.worldPaddingPercent;
