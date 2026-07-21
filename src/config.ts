/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

// =============================================================================
// TYPE RE-EXPORTS (definitions live in ./types/config.ts)
// =============================================================================

import type {
  EmaTierConfig,
  EmaMsConfig,
  KnockbackConfig,
  ShieldVisualConfig,
  ShieldImpactVisualConfig,
  MapSize,
} from './types/config';
import type {
  CameraAnchor,
  CameraConstraintConfig,
  CameraLostTerrainRecoveryConfig,
  CameraMovementConfig,
  CameraTerrainCollisionMode,
  CameraZoomDistanceSamplingConfig,
} from './types/camera';
import {
  LAND_CELL_SIZE,
  MAP_DIMENSION_CONFIG,
  nearestOddLandCellCount,
} from './mapSizeConfig';
import sharedSimConstants from './sharedSimConstants.json';
import emaConfigJson from './emaConfig.json';
import combatConfigJson from './combatConfig.json';
import beamConfigJson from './beamConfig.json';
import worldRenderConfigJson from './worldRenderConfig.json';
import lodConfigJson from './lod.json';
import shieldVisualConfigJson from './shieldVisualConfig.json';
import explosionConfigJson from './explosionConfig.json';
import entityHudConfigJson from './entityHudConfig.json';
import telemetryConfigJson from './telemetryConfig.json';
import economyConfigJson from './economyConfig.json';
import windConfigJson from './windConfig.json';
import physicsTuningConfigJson from './physicsTuningConfig.json';
import cameraConfigJson from './cameraConfig.json';
import realBattleConfigJson from './realBattleConfig.json';
import backgroundBattleConfigJson from './backgroundBattleConfig.json';
import type { CameraFovDegrees, CameraSmoothMode } from './types/client';
import type { EntityHudBlueprint } from './types/blueprints';
import type { DemoBattleWaypointType } from './demoConfig';
import { COLORS } from './colorsConfig';
export { LAND_CELL_SIZE } from './mapSizeConfig';

// Default square map span in canonical land cells. Demo Battle and Real Battle
// use the same option set and server/client math, while their selected size is
// persisted per mode. Keep this odd so the map has exactly one central
// land tile.
const MAP_LAND_CELLS_WIDTH = MAP_DIMENSION_CONFIG.width.default;
const MAP_LAND_CELLS_LENGTH = MAP_DIMENSION_CONFIG.length.default;

// Render-only vertical lift for the terrain mesh above sampled terrain. Keep
// this at 0 for normal play: the terrain renderer, host sim, and client
// adjacent-tick presentation all share the same authoritative triangle surface. Use waypoint
// and floating-cell overlay lifts for readability instead of moving terrain.
export const LAND_TILE_GROUND_LIFT = worldRenderConfigJson.landTileGroundLift;

// 3D waypoint visual lift above the sampled terrain surface. This is
// render-only: command positions and pathfinding still use the actual
// terrain height, while dots/lines/flags float this many world units up
// so terrain and overlay layers do not hide them.
export const WAYPOINT_GROUND_LIFT = worldRenderConfigJson.waypointGroundLift;

/** Render-only dimensions for the open-bottom world slab. */
export const WORLD_BOX_RENDER_CONFIG = worldRenderConfigJson.worldBox;

export const GOOD_TPS = telemetryConfigJson.goodTps;

// =============================================================================
// SNAPSHOT / NETWORKING
// =============================================================================

// Re-export bar config values used by sim/server code
export type { SnapshotRate,  } from './types/server';
import { BATTLE_CONFIG } from './battleBarConfig';

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
//                    slowly. predMs (legacy telemetry name) isolates the
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

/** Maximum authoritative beam/laser path segments traced per re-path.
 *  Segment 1 is launch origin -> first hit/trace limit, segment 2 is after the
 *  first reflector, and so on. If the final allowed segment ends on a
 *  reflector, the beam terminates there and does not get endpoint
 *  damage. This prevents shield-panel / shield-sphere loops
 *  from producing unbounded traces or arbitrary damage spheres. */
export const BEAM_MAX_SEGMENTS = combatConfigJson.beamMaxSegments;
export const BEAM_MIN_ON_TIME_MS = beamConfigJson.minOnTimeMs;
/** Presentation-only beam origins follow their live rendered turret mounts. */
export const BEAM_SNAP_ORIGIN_TO_TURRET = beamConfigJson.snapOriginToTurret;

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

/** Contact tolerance for deciding whether a unit's locomotion ground
 *  point is touching terrain/support. */
export const UNIT_GROUND_CONTACT_EPSILON =
  sharedSimConstants.unitGroundContactEpsilon;

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

// =============================================================================
// UNIT CAP
// =============================================================================

export const WIND_SPEED_MIN = windConfigJson.speed.min;
export const WIND_SPEED_MAX = windConfigJson.speed.max;

/** Ratio of blade-tip linear speed to authoritative wind speed. The animator
 *  converts this to angular speed using each turbine's actual rotor radius. */
export const WIND_TURBINE_ROTOR_TIP_SPEED_RATIO =
  windConfigJson.turbine.rotorTipSpeedRatio;
/** When true the turbine blades spin proportional to live (actual) wind speed
 *  (dead air -> still); when false every open turbine spins at the flat
 *  "potential" rate below regardless of current wind. */
export const WIND_TURBINE_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION =
  windConfigJson.turbine.rotorSpinReflectsActualProduction;
export const WIND_TURBINE_ROTOR_POTENTIAL_RAD_PER_SEC =
  windConfigJson.turbine.rotorPotentialRadPerSec;

/** Wind turbine visual response half-life multipliers.
 *
 *  1.0 = the controller's named base half-life.
 *  <1.0 = faster turbine response.
 *  >1.0 = smoother/slower turbine response.
 *  0.0 = snap for that channel.
 */
export const WIND_TURBINE_RESPONSE_HALF_LIFE_MULTIPLIERS =
  windConfigJson.turbine.responseHalfLifeMultipliers;

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

// Map colors
export const MAP_BG_COLOR = COLORS.world.map.inBounds.colorHex; // in-bounds background
 // out-of-bounds background
 // camera clear color

// Render-only fake horizon extent for the transparent water plane and
// submerged "infinity" terrain shelf around circle-perimeter maps.
// Kept shared so water and terrain always terminate at the same practical
// distance. This is only a few giant quads, so raising it is cheap; the
// camera far plane still controls what actually draws.
export const HORIZON_RENDER_EXTEND = worldRenderConfigJson.horizonRenderExtend;

// Shared entity detail ladder switch. Every visual follows the same
// screen-coverage-selected HIGH/MED/LOW rungs; there is no separate
// distance-only emission LOD channel.
export const ENTITY_LOD_ENABLED = lodConfigJson.entity.enabled;

// Screen-coverage-selected three-rung detail ladder (thresholds, animation
// shedding, and per-rung effect scales). Tuning lives in lod.json `detail`;
// EntityDetailLevel3D interprets it.
export const ENTITY_DETAIL_CONFIG = lodConfigJson.detail;

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
const METAL_DEPOSIT_ROCK_TEXTURE_RESOLUTION = readTextureResolutionConfig(
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

// Per-kind styling (screen-pixel width, ground lift, render order) for the
// unified ground overlay line system (selection rings, range circles,
// sight/radar boundaries, waypoints, drag previews). Widths are in CSS
// pixels and stay constant on screen at any zoom.
export const OVERLAY_LINE_CONFIG = worldRenderConfigJson.overlayLines;
export type OverlayLineKind = keyof typeof OVERLAY_LINE_CONFIG.kinds;

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
 *   terrain height + supportPointOffsetZ + this offset
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

const normalizeMapLandCells = nearestOddLandCellCount;

const landCellMapSpan = (landCells: number): number =>
  normalizeMapLandCells(landCells) * LAND_CELL_SIZE;

function mapSizeFromLandCells(
  widthLandCells: number,
  lengthLandCells: number = widthLandCells,
): MapSize {
  return {
    width: landCellMapSpan(widthLandCells),
    height: landCellMapSpan(lengthLandCells),
  };
}

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

/** Background battle unit-generation distributions authored in
 * `backgroundBattleConfig.json`. */
export const BACKGROUND_UNIT_SPAWN_DISTRIBUTIONS = [
  'flat-distribution',
  'inverse-cost',
] as const;
export type BackgroundUnitSpawnDistribution =
  (typeof BACKGROUND_UNIT_SPAWN_DISTRIBUTIONS)[number];

function readBackgroundUnitSpawnDistribution(): BackgroundUnitSpawnDistribution {
  const value = backgroundBattleConfigJson.unitSpawnDistribution;
  if (value === 'flat-distribution' || value === 'inverse-cost') return value;
  throw new Error(
    'backgroundBattleConfig.unitSpawnDistribution must be "flat-distribution" or "inverse-cost"',
  );
}

/** Distribution shared by opening/reinforcement selection and AI factory
 * selection. `flat-distribution` gives every enabled blueprint equal odds. */
export const BACKGROUND_UNIT_SPAWN_DISTRIBUTION = readBackgroundUnitSpawnDistribution();

// Re-export audio config

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

/** BAR's first-frame Spring-camera rx=2.6 converted to this controller's
 * angle-from-vertical convention: pitch = PI - rx. */
export const CAMERA_INITIAL_PITCH_RADIANS = cameraConfigJson.initialPitchRadians;

/** Orbit-camera EMA time constant for each configured smoothing mode. */
export const CAMERA_SMOOTH_TAU_SECONDS = cameraConfigJson.smoothingTauSeconds as
  Readonly<Record<CameraSmoothMode, number>>;

/** Maximum zoom level (zoomed in). When camera constraints use
 *  zoomInLimit='zoom-max', this becomes the closest orbit distance via
 *  baseDistance / ZOOM_MAX. */
export const ZOOM_MAX = cameraConfigJson.zoom.max;

/** BAR's game-level Spring-camera closest focus distance. */
export const ZOOM_MIN_ORBIT_DISTANCE = cameraConfigJson.zoom.minOrbitDistance;

/** BAR Spring-camera zoom-out rail: controller distance is capped at 1.333x
 * the map's larger horizontal dimension. */
export const ZOOM_MAX_ORBIT_DISTANCE_MAP_FACTOR =
  cameraConfigJson.zoom.maxOrbitDistanceMapFactor;

/** Display reference for rendered eye distance in the CLIENT bar. The actual
 * BAR zoom-out rail is controller distance = 1.333x the larger map axis. */
export const ZOOM_MAX_MAP_CENTER_DISTANCE = cameraConfigJson.zoom.maxMapCenterDistance;

/** Far-distance reference for HUD fade, expressed as a multiple of the
 *  base framing distance (max(mapW, mapH) * 0.35). Entity HUD elements
 *  (health bars, name tags) finish fading out by this distance, so the
 *  fade window tracks map size. */
export const CAMERA_FAR_REFERENCE_DISTANCE_FACTOR =
  cameraConfigJson.farReferenceDistanceFactor;

/**
 * Per-wheel-tick zoom fraction. Each scroll-IN moves the camera toward the
 * configured terrain-bed anchor. BAR's SpringController uses an asymmetric
 * linear factor for each normalized wheel unit:
 *
 *   factor_in  = (1 − f)         → distance shrinks by f
 *   factor_out = (1 + f)         → distance grows by f
 *
 * BAR's default ScrollWheelSpeed=25 and controller coefficient 0.007 make
 * f=0.175. The configured anchor remains pinned through the move.
 */
export const ZOOM_STEP_FRACTION = cameraConfigJson.zoom.stepFraction;

/** Terrain-neighborhood sampling used to smooth cursor-relative zoom depth,
 *  plus the presentation settings for the matching CLIENT debug overlay. */
export const CAMERA_ZOOM_DISTANCE_SAMPLING =
  cameraConfigJson.zoom.distanceSampling as CameraZoomDistanceSamplingConfig;

/** Full camera movement tuning, grouped by physical mouse gesture. Each
 *  gesture owns its base movement amount and its velocity-sensitive gain
 *  block so momentum can be tuned or disabled independently. */
export const CAMERA_MOVEMENT_CONFIG =
  cameraConfigJson.movement as CameraMovementConfig;

/** High-level camera rails. These restore the stable RTS orbit behavior
 *  without coupling camera body movement to terrain height. */
export const CAMERA_CONSTRAINTS =
  cameraConfigJson.constraints as CameraConstraintConfig;

/** Automatic camera recovery used only when neither terrain nor water is in
 * the viewport. Normal zoom/pan/orbit behavior is unaffected. */
export const CAMERA_LOST_TERRAIN_RECOVERY =
  cameraConfigJson.lostTerrainRecovery as CameraLostTerrainRecoveryConfig;

/** Eye-versus-terrain resolution. persistRaiseEye is the sole intentional
 * departure from BAR: the resolved vertical lift is committed to controller
 * state instead of disappearing after the eye clears the mountain. */
export const CAMERA_TERRAIN_COLLISION = cameraConfigJson.terrainCollision as {
  readonly mode: CameraTerrainCollisionMode;
  readonly minClearance: number;
};

export type CameraBattleKind = 'demoBattle' | 'lobbyBattle' | 'realBattle';
export type CameraBattleFocus =
  | 'map-origin-use-map-height'
  | 'map-origin-map-height-agnostic'
  | 'local-commander';
type CameraBattleDefault = {
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

/**
 * World padding as a percentage of map dimensions.
 * 0.5 = 50% padding on each side (left, right, top, bottom).
 * For a 2000x2000 map with 0.5, padding is 1000px on each side.
 */
export const WORLD_PADDING_PERCENT = cameraConfigJson.worldPaddingPercent;
