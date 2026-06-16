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
  ShieldVisualConfig,
  ShieldImpactVisualConfig,
  ShieldTurretShape,
  ShieldTurretConfig,
  SpinConfig,
  BarrelShape,
  MapSize,
} from './types/config';
export type {
  CameraAnchor,
  CameraAnchorScreen,
  CameraAnchorTerrain,
  CameraTerrainCollisionMode,
} from './types/camera';

import type {
  SnapshotConfig,
  EmaTierConfig,
  EmaMsConfig,
  KnockbackConfig,
  ShieldVisualConfig,
  ShieldImpactVisualConfig,
  ShieldTurretConfig,
  MapSize,
} from './types/config';
import type {
  CameraAnchor,
  CameraTerrainCollisionMode,
} from './types/camera';
import {
  LAND_CELL_SIZE,
  MAP_DIMENSION_CONFIG,
  nearestOddLandCellCount,
} from './mapSizeConfig';
import { ARCHITECTURE_CONFIG } from './architectureConfig';
import sharedSimConstants from './sharedSimConstants.json';
import emaConfigJson from './emaConfig.json';
import combatConfigJson from './combatConfig.json';
import beamConfigJson from './beamConfig.json';
import shieldConfigJson from './shieldConfig.json';
import worldRenderConfigJson from './worldRenderConfig.json';
import shieldVisualConfigJson from './shieldVisualConfig.json';
import explosionConfigJson from './explosionConfig.json';
import entityHudConfigJson from './entityHudConfig.json';
import telemetryConfigJson from './telemetryConfig.json';
import economyConfigJson from './economyConfig.json';
import windConfigJson from './windConfig.json';
import physicsTuningConfigJson from './physicsTuningConfig.json';
import serverDebugGridConfigJson from './serverDebugGridConfig.json';
import cameraConfigJson from './cameraConfig.json';
import realBattleConfigJson from './realBattleConfig.json';
import backgroundBattleConfigJson from './backgroundBattleConfig.json';
import type { CameraFovDegrees } from './types/client';
import type { EntityHudBlueprint } from './types/blueprints';
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
// so terrain and overlay layers do not hide them.
export const WAYPOINT_GROUND_LIFT = worldRenderConfigJson.waypointGroundLift;

// Host-server spatial-grid debug snapshots are intentionally throttled
// separately from normal gameplay snapshots. These overlays are diagnostic
// data, not simulation state, and recomputing/sending them every snapshot can
// create visible hitches at high unit counts.
export const SERVER_GRID_DEBUG_INTERVAL_MS = serverDebugGridConfigJson.snapshotIntervalMs;
export const SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS = serverDebugGridConfigJson.maxOccupiedCells;
export const SERVER_GRID_DEBUG_MAX_SEARCH_CELLS = serverDebugGridConfigJson.maxSearchCells;
export const GOOD_TPS = telemetryConfigJson.goodTps;

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
//   - Threshold values are authored as ratios, not absolute world
//     units/radians. 0.1 means 10%.
//   - deltaMovementPositionThresholdAsMapRatio is a ratio of the larger map axis.
//     On a 10,600wu square map, 0.1 means a 1,060wu position delta.
//   - deltaMovementVelocityMagnitudeThresholdAsLastSentSpeedRatio is relative
//     to the last-sent speed. A 5wu/s drop matters at 5wu/s, but not at 100wu/s.
//   - deltaMovementVelocityDirectionThresholdAsFullTurnRatio is a ratio of a full turn
//     between velocity vectors. 0.05 means 18 degrees. Direction is
//     ignored when either velocity vector is effectively stopped.
//   - deltaRotationPositionThresholdAsFullTurnRatio is a ratio of a full turn.
//     0.1 means 36 degrees.
//   - deltaRotationVelocityMagnitudeThresholdAsLastSentAngularSpeedRatio is
//     relative to the last-sent yaw/pitch angular speed vector magnitude.
//   - deltaRotationVelocityDirectionThresholdAsFullTurnRatio is a ratio of a full turn
//     between yaw/pitch angular velocity vectors. For one-axis turret
//     motion, a sign flip is a 180 degree direction change.
//
// THE TIERS BELOW are reference points only — pick the resolution
// that matches your bandwidth budget vs visual smoothness target.
// Higher resolution = more bytes on the wire, smoother visuals.
//
// Authored values live in src/architecture.json:
//   lockstep.presentationSnapshots.deltaSnapshotsEnabled
//                             — master switch; false => every snap is a
//                               full keyframe (debug only; ~5-10x
//                               bandwidth in active play).
//   deltaMovementPositionThresholdAsMapRatio
//                             — entity position must move by more than
//                               this ratio of the larger map axis to
//                               re-send. 0.1 = 10% of the full map.
//   deltaMovementVelocityMagnitudeThresholdAsLastSentSpeedRatio
//                             — velocity speed must change by more than
//                               this ratio of the last-sent speed to
//                               re-send. 0.1 = 10%.
//   deltaMovementVelocityDirectionThresholdAsFullTurnRatio
//                             — velocity heading must change by more than
//                               this ratio of a full 360 degree turn to
//                               re-send. 0.05 = 18 degrees.
//   deltaRotationPositionThresholdAsFullTurnRatio
//                             — body + turret rotations must change by
//                               more than this ratio of a full 360 degree
//                               turn to re-send. 0.1 = 36 degrees.
//   deltaRotationVelocityMagnitudeThresholdAsLastSentAngularSpeedRatio
//                             — turret yaw/pitch angular speed must
//                               change by more than this ratio of the
//                               last-sent angular speed to re-send.
//   deltaRotationVelocityDirectionThresholdAsFullTurnRatio
//                             — turret yaw/pitch angular velocity
//                               direction must change by more than this
//                               ratio of a full 360 degree turn.
//   fullSnapshotMinimapContactListMaxRefreshRateHz
//                             — maximum refresh cadence for full minimap
//                               contact lists embedded in delta snapshots.
//                               Keyframes always carry a fresh baseline.
//   fullSnapshotEntityDetailFieldsMaxRefreshRateHz
//                             — maximum refresh cadence for visual/detail
//                               entity fields such as normals, suspension,
//                               building, and factory state.
//   fullSnapshotProjectileDetailFieldsMaxRefreshRateHz
//                             — maximum refresh cadence for live beam path
//                               corrections embedded in delta snapshots.
export const SNAPSHOT_CONFIG: SnapshotConfig =
  ARCHITECTURE_CONFIG.lockstep.presentationSnapshots;

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
export const DEFAULT_TURRET_SHIELD_PANELS_ENABLED = BATTLE_CONFIG.turretShieldPanelsEnabled.default;
export const DEFAULT_TURRET_SHIELD_SPHERES_ENABLED =
  BATTLE_CONFIG.turretShieldSpheresEnabled.default;
export const DEFAULT_FORCE_FIELDS_VISIBLE =
  BATTLE_CONFIG.forceFieldsVisible.default;
export const DEFAULT_SHIELDS_OBSTRUCT_SIGHT =
  BATTLE_CONFIG.shieldsObstructSight.default;
export const DEFAULT_SHIELD_REFLECTION_MODE =
  BATTLE_CONFIG.shieldReflectionMode.default;
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
//                    start from an honest empty baseline for TPS-driven
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
 *  Segment 1 is launch origin -> first hit/trace limit, segment 2 is after the
 *  first reflector, and so on. If the final allowed segment ends on a
 *  reflector, the beam terminates there and does not get endpoint
 *  damage. This prevents shield-panel / shield-sphere loops
 *  from producing unbounded traces or arbitrary damage spheres. */
export const BEAM_MAX_SEGMENTS = combatConfigJson.beamMaxSegments;
export const BEAM_MIN_ON_TIME_MS = beamConfigJson.minOnTimeMs;

/** Minimum time (ms) a shield field stays commanded-on once it starts
 *  raising. Debounces rapid engage/disengage flicker from the targeting
 *  FSM — same contract as BEAM_MIN_ON_TIME_MS for beams. */
export const SHIELD_MIN_ON_TIME_MS = shieldConfigJson.minOnTimeMs;

// =============================================================================
// BATTLE WAYPOINT DEFAULTS
// =============================================================================

/** REAL BATTLE default order type assigned to units produced by
 *  player-built factories/fabricators. Demo-battle seeded fabricators
 *  force a fight first leg, then append their own patrol loop. */
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

/** Ground-contact tangent velocity damping per 60 Hz frame.
 *  Applied only while the unit's locomotion ground point is at or
 *  below terrain height, and only to motion tangent to the terrain
 *  plane. */
export const UNIT_GROUND_FRICTION_PER_60HZ_FRAME =
  sharedSimConstants.unitGroundFrictionPer60HzFrame;

/** Contact tolerance for deciding whether a unit's locomotion ground
 *  point is touching terrain/support. */
export const UNIT_GROUND_CONTACT_EPSILON =
  sharedSimConstants.unitGroundContactEpsilon;

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

/** Map-edge boundary spring acceleration per world-unit of penetration.
 *  The engine applies this as an inward spring before the WASM integration
 *  step, so world bounds are a force response rather than a post-step clamp. */
export const UNIT_WORLD_BOUNDARY_SPRING_ACCEL_PER_WORLD_UNIT =
  sharedSimConstants.unitWorldBoundarySpringAccelPerWorldUnit;

/** Damping ratio for the map-edge boundary spring along the inward normal. */
export const UNIT_WORLD_BOUNDARY_SPRING_DAMPING_RATIO =
  sharedSimConstants.unitWorldBoundarySpringDampingRatio;

/** Body sleep transition tick threshold shared with the WASM integrator. */
export const BODY_SLEEP_TICKS = sharedSimConstants.bodySleepTicks;

/** D-gun wave altitude above local terrain. */
export const DGUN_TERRAIN_FOLLOW_HEIGHT = physicsTuningConfigJson.dgun.terrainFollowHeight;
/** Vertical spring acceleration used by the D-gun terrain-follow thrust. */
export const DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT =
  physicsTuningConfigJson.dgun.terrainFollowSpringAccelPerWorldUnit;
/** Critical-damping ratio for the D-gun terrain-follow thrust. */
export const DGUN_TERRAIN_FOLLOW_DAMPING_RATIO =
  physicsTuningConfigJson.dgun.terrainFollowDampingRatio;
/** Maximum upward D-gun terrain-follow engine force before mass division. */
export const DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE =
  physicsTuningConfigJson.dgun.terrainFollowMaxThrustForce;

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
export const BEAM_EXPLOSION_MAGNITUDE = explosionConfigJson.beamExplosionMagnitude;

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

function readUnitIntervalConfig(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${fieldName} must be a finite number from 0 to 1`);
  }
  return value;
}

function readPositiveConfigNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a finite positive number`);
  }
  return value;
}

function readTextureResolutionConfig(value: unknown, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 256 ||
    value > 8192 ||
    (value & (value - 1)) !== 0
  ) {
    throw new Error(`${fieldName} must be a power-of-two integer from 256 to 8192`);
  }
  return value;
}

/** The base color flat green ground gets pulled toward before the detail
 *  texture is applied. Defaults to the spruce leaf color so that grass clumps
 *  and tree foliage sit on a matching-color ground patch instead of standing
 *  out against a different-shade base. */
export const TERRAIN_GROUND_BASE_COLOR = COLORS.world.terrain.ground.baseColorHex;

/** How strongly the generated detail PNG overrides the base ground color in
 *  flat green areas, in [0, 1]. 0 = pure base color (clean, props rooted in
 *  a single color), 1 = full texture influence (noisy / busy). */
export const TERRAIN_GROUND_DETAIL_CONTRAST = readUnitIntervalConfig(
  COLORS.world.terrain.ground.texture.blend,
  'colorsConfig.world.terrain.ground.texture.blend',
);

/** World units covered by one complete grass/sticks texture tile. Smaller
 *  values make the texture repeat more often and read finer; larger values
 *  stretch each repeat across more terrain. */
export const TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE = readPositiveConfigNumber(
  COLORS.world.terrain.ground.texture.tileWorldSize,
  'colorsConfig.world.terrain.ground.texture.tileWorldSize',
);
export const TERRAIN_GROUND_TEXTURE_RESOLUTION = readTextureResolutionConfig(
  COLORS.world.terrain.ground.texture.resolution,
  'colorsConfig.world.terrain.ground.texture.resolution',
);

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
 *  correctly. Toggle, base color, blend, and tile-size knobs mirror the
 *  ground set. */
export const TERRAIN_ROCK_DETAIL_ENABLED =
  worldRenderConfigJson.terrainRockDetail.enabled;
export const TERRAIN_ROCK_BASE_COLOR = COLORS.world.terrain.rock.baseColorHex;
export const TERRAIN_ROCK_DETAIL_CONTRAST = readUnitIntervalConfig(
  COLORS.world.terrain.rock.texture.blend,
  'colorsConfig.world.terrain.rock.texture.blend',
);
export const TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE = readPositiveConfigNumber(
  COLORS.world.terrain.rock.texture.tileWorldSize,
  'colorsConfig.world.terrain.rock.texture.tileWorldSize',
);
export const TERRAIN_ROCK_TEXTURE_RESOLUTION = readTextureResolutionConfig(
  COLORS.world.terrain.rock.texture.resolution,
  'colorsConfig.world.terrain.rock.texture.resolution',
);

/** Metal deposits reuse the rock detail texture, but their mesh material can
 *  blend the texture against the per-vertex ore colors independently from the
 *  terrain rock settings. */
export const METAL_DEPOSIT_ROCK_TEXTURE_BLEND = readUnitIntervalConfig(
  COLORS.environment.metalDeposit.rockTexture.blend,
  'colorsConfig.environment.metalDeposit.rockTexture.blend',
);
export const METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE = readPositiveConfigNumber(
  COLORS.environment.metalDeposit.rockTexture.tileWorldSize,
  'colorsConfig.environment.metalDeposit.rockTexture.tileWorldSize',
);
export const METAL_DEPOSIT_ROCK_TEXTURE_RESOLUTION = readTextureResolutionConfig(
  COLORS.environment.metalDeposit.rockTexture.resolution,
  'colorsConfig.environment.metalDeposit.rockTexture.resolution',
);
if (METAL_DEPOSIT_ROCK_TEXTURE_RESOLUTION !== TERRAIN_ROCK_TEXTURE_RESOLUTION) {
  throw new Error(
    'colorsConfig.environment.metalDeposit.rockTexture.resolution must match ' +
      'colorsConfig.world.terrain.rock.texture.resolution because both use RockDetailTexture.ts',
  );
}

/** How strongly the procedural tree-leaf / tree-trunk textures override the
 *  prop's solid base color, in [0, 1]. 0 = pure base color (the original
 *  flat green / brown look), 1 = full texture variation. Same semantics as
 *  the terrain texture blend knobs above, but baked into the canvas at
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
// contact-shadow mesh and update at configured strides.
export const CONTACT_SHADOW_RENDER_CONFIG = worldRenderConfigJson.contactShadow;

// Scorched earth burn mark colors and decay
export const BURN_COLOR_HOT = COLORS.world.burnMark.hotColorHex; // bright red start
export const BURN_COLOR_TAU = worldRenderConfigJson.burnMark.colorTauMs; // color decay: red → black (ms), fast
export const BURN_COOL_TAU = worldRenderConfigJson.burnMark.coolTauMs; // color decay: black → background (ms), slow

/** Force-field shield visual configuration. The bubble renders at
 *  every tier; the MAX-tier orbital rings are tuned via RING_*
 *  constants inside ShieldRenderer3D rather than here. */
export const SHIELD_VISUAL: ShieldVisualConfig =
  {
    ...shieldVisualConfigJson.shield,
    fallbackColor: COLORS.effects.shield.shield.fallbackColorHex,
  } as ShieldVisualConfig;

/** Force-field projectile interception visual.
 *  The burst is a flat tangent-plane pulse at the sphere intersection:
 *  its plane normal is the shield surface normal, so the expanding ring
 *  lies 90 degrees from the impact normal. Ring opacity matches the
 *  shield / shield panel transparency. */
export const SHIELD_IMPACT_VISUAL: ShieldImpactVisualConfig =
  {
    ...shieldVisualConfigJson.impact,
    fallbackColor: COLORS.effects.shield.impact.fallbackColorHex,
    ringOpacity: COLORS.effects.shield.impact.ringOpacity,
    coreOpacity: COLORS.effects.shield.impact.coreOpacity,
  } as ShieldImpactVisualConfig;

/**
 * Shield turret (grate) configuration per unit blueprint.
 * All length/width values are multipliers of the unit's collision radius.
 */
export const SHIELD_TURRET: Record<string, ShieldTurretConfig> =
  shieldVisualConfigJson.turret as Record<string, ShieldTurretConfig>;

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

/** Default per-blueprint HUD bar offsets, in world units above the
 *  entity's visual HUD top. Individual unit/building blueprints can
 *  override this by editing their `hud` block. */
export const DEFAULT_UNIT_HUD_LAYOUT: EntityHudBlueprint = {
  barsOffsetAboveTop: entityHudConfigJson.defaultUnitHudLayout.barsOffsetAboveTop,
};

export const DEFAULT_BUILDING_HUD_LAYOUT: EntityHudBlueprint = {
  barsOffsetAboveTop: entityHudConfigJson.defaultBuildingHudLayout.barsOffsetAboveTop,
};

/** Distance between stacked HUD bars: HP, energy, metal. */
export const ENTITY_HUD_BAR_STACK_GAP = entityHudConfigJson.barStackGap;

/** The full status stack is HP + resource build bars. */
export const ENTITY_HUD_BAR_STACK_ROWS = entityHudConfigJson.barStackRows;

/** Visual air gap between the top edge of the full bar stack and the
 *  bottom edge of the name label sprite. */
export const ENTITY_HUD_NAME_GAP_ABOVE_BARS = entityHudConfigJson.nameGapAboveBars;

/** HUD bars/names fade out by camera distance (the BAR clutter-control).
 *  Expressed as fractions of the orbit camera's max (zoomed-out) distance
 *  so the window scales with map size: full opacity nearer than
 *  START·maxDist, fully gone (and culled) past END·maxDist. */
export const ENTITY_HUD_FADE_START_DISTANCE_FRAC = entityHudConfigJson.fadeStartDistanceFrac;
export const ENTITY_HUD_FADE_END_DISTANCE_FRAC = entityHudConfigJson.fadeEndDistanceFrac;

// =============================================================================
// CAMERA & ZOOM
// =============================================================================

/** Main 3D game camera vertical field-of-view in degrees.
 *  Lower values feel like a narrower/telephoto lens; higher values
 *  feel like a wider-angle lens. This is lens FOV, not the orbit
 *  camera's pitch angle against the terrain. */
export const CAMERA_FOV_DEGREES = cameraConfigJson.fovDegrees as CameraFovDegrees;

/** Maximum zoom level (zoomed in). There is intentionally no minimum
 *  zoom level — zoom-out is unbounded (the old max-zoom-out rail was
 *  removed because it wedged the camera against terrain). */
export const ZOOM_MAX = cameraConfigJson.zoom.max;

/** Far-distance reference for HUD fade, expressed as a multiple of the
 *  base framing distance (max(mapW, mapH) * 0.35). Entity HUD elements
 *  (health bars, name tags) finish fading out by this distance, so the
 *  fade window tracks map size. This is NOT a zoom-out cap: the camera
 *  can dolly past it freely; HUD elements are simply fully faded there. */
export const CAMERA_FAR_REFERENCE_DISTANCE_FACTOR =
  cameraConfigJson.farReferenceDistanceFactor;

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

export type CameraBattleKind = 'demoBattle' | 'lobbyBattle' | 'realBattle';
export type CameraBattleFocus =
  | 'map-origin-use-map-height'
  | 'map-origin-map-height-agnostic'
  | 'local-commander';
export type CameraBattleDefault = {
  readonly focus: CameraBattleFocus;
  /** Higher = closer. Values below 1 are pulled back for broad map reads. */
  readonly zoom: number;
  readonly autoRotate: boolean;
  readonly autoRotateRate: number;
};

/** Initial camera framing per battle surface.
 *
 *  - demoBattle: wide map-origin view for the standalone demo battle.
 *  - lobbyBattle: wide map-origin preview with slow automatic rotation.
 *  - realBattle: existing local-commander POV, facing into the map. */
export const CAMERA_BATTLE_DEFAULTS = {
  demoBattle: {
    focus: cameraConfigJson.battleDefaults.demoBattle.focus as CameraBattleFocus,
    zoom: cameraConfigJson.battleDefaults.demoBattle.zoom,
    autoRotate: cameraConfigJson.battleDefaults.demoBattle.autoRotate,
    autoRotateRate: cameraConfigJson.battleDefaults.demoBattle.autoRotateRate,
  },
  lobbyBattle: {
    focus: cameraConfigJson.battleDefaults.lobbyBattle.focus as CameraBattleFocus,
    zoom: cameraConfigJson.battleDefaults.lobbyBattle.zoom,
    autoRotate: cameraConfigJson.battleDefaults.lobbyBattle.autoRotate,
    autoRotateRate: cameraConfigJson.battleDefaults.lobbyBattle.autoRotateRate,
  },
  realBattle: {
    focus: cameraConfigJson.battleDefaults.realBattle.focus as CameraBattleFocus,
    zoom: cameraConfigJson.battleDefaults.realBattle.zoom,
    autoRotate: cameraConfigJson.battleDefaults.realBattle.autoRotate,
    autoRotateRate: cameraConfigJson.battleDefaults.realBattle.autoRotateRate,
  },
} as const satisfies Record<CameraBattleKind, CameraBattleDefault>;

/** Camera pan speed multiplier (middle-click drag). 1.0 = 1:1 with mouse movement */
export const CAMERA_PAN_MULTIPLIER = cameraConfigJson.panMultiplier;

/**
 * Every world-pinning camera gesture chooses two independent axes:
 * a screen point and a terrain surface. The screen axis decides which
 * canvas pixel casts the ray; the terrain axis decides what surface
 * that ray resolves against.
 */
export const CAMERA_ZOOM_IN_ANCHOR = cameraConfigJson.anchor.zoomIn as CameraAnchor;
export const CAMERA_ZOOM_OUT_ANCHOR = cameraConfigJson.anchor.zoomOut as CameraAnchor;
export const CAMERA_ROTATE_ANCHOR = cameraConfigJson.anchor.rotate as CameraAnchor;
export const CAMERA_PAN_ANCHOR = cameraConfigJson.anchor.pan as CameraAnchor;

/** Minimum 3D clearance (sim units) between the camera and terrain.
 *  The camera checks terrain around its position and resolves along
 *  local terrain normals instead of checking only the vertical gap to
 *  the ground directly beneath it. */
export const CAMERA_MIN_TERRAIN_CLEARANCE = cameraConfigJson.minTerrainClearance;

/** How the orbit camera resolves frames where the eye would dip below
 *  terrain — see CameraTerrainCollisionMode. 'none' lets the camera pass
 *  through the heightfield; 'raiseEye' lifts the eye straight up to clear;
 *  'clampPitch' steepens the orbit arc to clear instead. */
export const CAMERA_TERRAIN_COLLISION_MODE =
  cameraConfigJson.terrainCollisionMode as CameraTerrainCollisionMode;

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = cameraConfigJson.worldPaddingPercent;
