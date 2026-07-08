// Continuous per-entity detail level (LOD scalar) — the "levels of detail"
// model. Every entity has a level L in [0,1]: 1.0 = full fidelity (only when
// decently zoomed in), 0.0 = the flat proxy glyph that shows position + class.
//
// This module is the single source of truth for WHERE each renderable feature
// exists on that 0..1 scale, and for turning a level into the discrete ladders
// the existing renderers already speak (geometry tier close/mid/far, and the
// GraphicsConfig style enums). It is deliberately free of THREE / camera /
// entity types so it stays a pure, unit-testable function of numbers.
//
// Host inheritance: composed parts (turret, barrel, locomotion, shield panels,
// chassis greeble) never compute their own level. They read their HOST entity's
// level and ask this module whether their feature is visible / which tier to
// use. So a turret's barrel and a unit's legs shed and simplify together with
// the body they ride on — small unimportant triangles abstract away first, the
// class-defining silhouette survives longest.
//
// In AUTO LOD, the level is produced from projected screen radius so the result
// follows how large the entity is on screen, not just raw camera distance. The
// proxy system uses the same score, so L reaches 0 at the glyph transition.

import {
  ENTITY_DETAIL_ENABLED,
  ENTITY_DETAIL_FULL_DETAIL_FRACTION,
  ENTITY_DETAIL_THRESHOLDS,
  ENTITY_LOD_VISUAL_SCORE,
} from '@/config';
import type {
  BeamStyle,
  GraphicsConfig,
  LegStyle,
  ProjectileStyle,
  TurretStyle,
  UnitShape,
} from '@/types/graphics';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import type { RenderViewState3D } from './RenderFrameState3D';

/**
 * A renderable feature/part whose presence is gated by its host's detail level.
 * Order here is only documentation; the shed order is the numeric threshold.
 */
export type DetailFeature =
  | 'body'
  | 'healthBar'
  | 'turret'
  | 'barrelPrimary'
  | 'locomotion'
  | 'nameLabel'
  | 'projectileTrail'
  | 'turretHead'
  | 'shieldPanels'
  | 'beamGlow'
  | 'buildingDetail'
  | 'chassisDetail'
  | 'barrelSecondary'
  | 'projectileGlow'
  | 'locomotionAnimated'
  | 'muzzleDetail';

export const DETAIL_FEATURES: readonly DetailFeature[] = [
  'body',
  'healthBar',
  'turret',
  'barrelPrimary',
  'locomotion',
  'nameLabel',
  'projectileTrail',
  'turretHead',
  'shieldPanels',
  'beamGlow',
  'buildingDetail',
  'chassisDetail',
  'barrelSecondary',
  'projectileGlow',
  'locomotionAnimated',
  'muzzleDetail',
];

/** Full-fidelity level and the glyph level, named so call sites read clearly. */
export const DETAIL_LEVEL_FULL = 1;
export const DETAIL_LEVEL_GLYPH = 0;

const THRESHOLDS = ENTITY_DETAIL_THRESHOLDS as Record<string, unknown>;

const FEATURE_VISUAL_THRESHOLD: Record<DetailFeature, readonly [string, string]> = {
  body: ['unit', 'body'],
  healthBar: ['hud', 'bars'],
  turret: ['turret', 'simple'],
  barrelPrimary: ['turret', 'primaryBarrel'],
  locomotion: ['locomotion', 'simple'],
  nameLabel: ['hud', 'names'],
  projectileTrail: ['shot', 'trail'],
  turretHead: ['turret', 'head'],
  shieldPanels: ['unit', 'shieldPanels'],
  beamGlow: ['beam', 'detailed'],
  buildingDetail: ['building', 'typeDetails'],
  chassisDetail: ['unit', 'chassisDetail'],
  barrelSecondary: ['turret', 'secondaryBarrels'],
  projectileGlow: ['shot', 'glow'],
  locomotionAnimated: ['locomotion', 'animated'],
  muzzleDetail: ['turret', 'muzzleDetail'],
};

const GEOMETRY_TIER_ORDER: readonly PrimitiveGeometryTier[] = ['far', 'mid', 'close'];

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

function fullDetailFraction(): number {
  const raw = ENTITY_DETAIL_FULL_DETAIL_FRACTION;
  if (!Number.isFinite(raw) || raw <= 0) return 0.4;
  return raw >= 1 ? 0.999 : raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rungForDetail<T extends string>(
  category: string,
  order: readonly T[],
  thresholdKeys: readonly string[],
  level: number,
  fallbackThresholds: readonly number[],
): T {
  const first = order[0];
  if (first === undefined) {
    throw new Error(`LOD rung order for ${category} must not be empty`);
  }
  let proposed = first;
  for (let i = 0; i < order.length; i++) {
    const thresholdKey = thresholdKeys[i];
    const threshold = thresholdKey === undefined
      ? fallbackThresholds[i] ?? 1
      : visualThreshold(category, thresholdKey, fallbackThresholds[i] ?? 1);
    const candidate = order[i];
    if (candidate !== undefined && level >= threshold) proposed = candidate;
  }
  return proposed;
}

function steppedScaleByThresholds(
  level: number,
  category: string,
  steps: readonly [key: string, scale: number, fallback: number][],
): number {
  let scale = 0;
  for (const [key, value, fallback] of steps) {
    if (level >= visualThreshold(category, key, fallback)) scale = Math.max(0, value);
  }
  return scale;
}

function projectedScoreProxyPixelRadius(): number {
  const value = ENTITY_LOD_VISUAL_SCORE.proxyPixelRadius;
  return Number.isFinite(value) && value >= 0 ? value : 2.5;
}

function projectedScoreFullPixelRadius(): number {
  const proxy = projectedScoreProxyPixelRadius();
  const value = ENTITY_LOD_VISUAL_SCORE.fullDetailPixelRadius;
  return Number.isFinite(value) && value > proxy ? value : Math.max(proxy + 1, 26);
}

function smoothstep01(value: number): number {
  const s = clamp01(value);
  return s * s * (3 - 2 * s);
}

/**
 * Map a camera distance and the entity's proxy-switch distance to a detail
 * level. L is pinned at 1 within `fullDetailFraction * switchDistance`, ramps
 * (smoothstep) down to 0 at `switchDistance`, and stays 0 beyond. Monotonic
 * non-increasing in distance, so a shrinking entity never gains detail.
 */
export function detailLevelForDistance(distance: number, switchDistance: number): number {
  if (!ENTITY_DETAIL_ENABLED) return DETAIL_LEVEL_FULL;
  if (!Number.isFinite(switchDistance) || switchDistance <= 0) return DETAIL_LEVEL_FULL;
  if (!Number.isFinite(distance) || distance <= 0) return DETAIL_LEVEL_FULL;
  const fullDistance = fullDetailFraction() * switchDistance;
  if (distance <= fullDistance) return DETAIL_LEVEL_FULL;
  if (distance >= switchDistance) return DETAIL_LEVEL_GLYPH;
  const t = (switchDistance - distance) / (switchDistance - fullDistance);
  // Smoothstep keeps the ramp gentle at both ends (no visible pop entering full
  // detail, no cliff into the glyph) while remaining monotonic in `t`.
  return smoothstep01(t);
}

/**
 * Map projected screen radius to L in [0,1]. This is the RTS-camera-stable
 * score: it follows what the player can actually see rather than raw zoom or
 * a camera-angle-dependent distance alone.
 */
export function detailLevelForProjectedRadius(projectedRadiusPx: number): number {
  if (!Number.isFinite(projectedRadiusPx) || projectedRadiusPx <= 0) {
    return DETAIL_LEVEL_GLYPH;
  }
  const proxyPx = projectedScoreProxyPixelRadius();
  const fullPx = projectedScoreFullPixelRadius();
  if (projectedRadiusPx <= proxyPx) return DETAIL_LEVEL_GLYPH;
  if (projectedRadiusPx >= fullPx) return DETAIL_LEVEL_FULL;
  return smoothstep01((projectedRadiusPx - proxyPx) / (fullPx - proxyPx));
}

export function projectedRadiusPxForView(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radius: number,
): number {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const dx = simX - view.cameraX;
  const dy = simZ - view.cameraY;
  const dz = simY - view.cameraZ;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const depth = dx * view.forwardX + dy * view.forwardY + dz * view.forwardZ;
  const visibleDepth = depth > r ? depth : distance;
  if (!Number.isFinite(visibleDepth) || visibleDepth <= 1e-4) {
    return Number.POSITIVE_INFINITY;
  }
  const fovScale = Math.tan(Math.max(0.001, view.fovYRad) * 0.5);
  const viewportScale = Math.max(1, view.viewportHeightPx) * 0.5;
  if (!Number.isFinite(fovScale) || fovScale <= 1e-6) {
    return (r / visibleDepth) * viewportScale;
  }
  return (r / (visibleDepth * fovScale)) * viewportScale;
}

export function detailLevelForViewPosition(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radius: number,
): number {
  return detailLevelForProjectedRadius(
    projectedRadiusPxForView(view, simX, simY, simZ, radius),
  );
}

/** The authored level at/above which `feature` is drawn (0 = always present). */
export function featureMinLevel(feature: DetailFeature): number {
  const [category, key] = FEATURE_VISUAL_THRESHOLD[feature];
  return visualThreshold(category, key, 0);
}

export function visualThreshold(
  category: string,
  key: string,
  fallback: number = 0,
): number {
  const bucket = THRESHOLDS[category];
  const value = isRecord(bucket) ? bucket[key] : undefined;
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return clamp01(raw);
}

export function visualFeatureVisibleAtDetail(
  category: string,
  key: string,
  level: number,
  fallback: number = 0,
): boolean {
  if (!ENTITY_DETAIL_ENABLED) return true;
  return level >= visualThreshold(category, key, fallback);
}

/** Whether `feature` is present on a host at the given detail level. */
export function featureVisibleAtDetail(feature: DetailFeature, level: number): boolean {
  if (!ENTITY_DETAIL_ENABLED) return true;
  return level >= featureMinLevel(feature);
}

/**
 * Geometry segment tier (close/mid/far) for a detail level. Close only near
 * full fidelity; most of the ramp is mid; the tail before the glyph is far.
 */
export function geometryTierForDetail(level: number): PrimitiveGeometryTier {
  if (!ENTITY_DETAIL_ENABLED) return 'close';
  const mid = visualThreshold('geometry', 'mid', 0.3);
  const close = visualThreshold('geometry', 'close', 0.62);
  if (level >= close) return 'close';
  if (level >= mid) return 'mid';
  return 'far';
}

/**
 * Clamp a detail-proposed rung to the user's global GraphicsConfig ceiling.
 * The graphics setting is the MAX fidelity the user allows; the detail level
 * only ever scales down from there. `order` runs cheapest -> richest.
 */
function clampRungToCeiling<T extends string>(
  order: readonly T[],
  proposed: T,
  ceiling: T,
): T {
  const proposedIdx = order.indexOf(proposed);
  const ceilingIdx = order.indexOf(ceiling);
  if (proposedIdx < 0 || ceilingIdx < 0) return ceiling;
  return proposedIdx <= ceilingIdx ? proposed : ceiling;
}

const TURRET_STYLE_ORDER: readonly TurretStyle[] = ['none', 'simple', 'full'];
const LEG_STYLE_ORDER: readonly LegStyle[] = ['none', 'simple', 'animated', 'full'];
const PROJECTILE_STYLE_ORDER: readonly ProjectileStyle[] = [
  'dot',
  'core',
  'trail',
  'glow',
  'full',
];
const BEAM_STYLE_ORDER: readonly BeamStyle[] = [
  'simple',
  'standard',
  'detailed',
  'complex',
];
const UNIT_SHAPE_ORDER: readonly UnitShape[] = ['circles', 'full'];

/** Turret rung for a host's level, clamped to the user's ceiling. */
export function turretStyleForDetail(level: number, ceiling: TurretStyle): TurretStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed = rungForDetail(
    'turret',
    TURRET_STYLE_ORDER,
    ['none', 'simple', 'full'],
    level,
    [0, 0.12, 0.4],
  );
  return clampRungToCeiling(TURRET_STYLE_ORDER, proposed, ceiling);
}

/** Locomotion (legs) rung for a host's level, clamped to the user's ceiling. */
export function legStyleForDetail(level: number, ceiling: LegStyle): LegStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed = rungForDetail(
    'locomotion',
    LEG_STYLE_ORDER,
    ['none', 'simple', 'animated', 'full'],
    level,
    [0, 0.14, 0.44, 0.62],
  );
  return clampRungToCeiling(LEG_STYLE_ORDER, proposed, ceiling);
}

/** Projectile rung for a projectile's own level, clamped to the user's ceiling. */
export function projectileStyleForDetail(
  level: number,
  ceiling: ProjectileStyle,
): ProjectileStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed = rungForDetail(
    'shot',
    PROJECTILE_STYLE_ORDER,
    ['dot', 'core', 'trail', 'glow', 'full'],
    level,
    [0, 0.1, 0.24, 0.6, 0.82],
  );
  return clampRungToCeiling(PROJECTILE_STYLE_ORDER, proposed, ceiling);
}

/** Beam rung for the firing host's level, clamped to the user's ceiling. */
export function beamStyleForDetail(level: number, ceiling: BeamStyle): BeamStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed = rungForDetail(
    'beam',
    BEAM_STYLE_ORDER,
    ['simple', 'standard', 'detailed', 'complex'],
    level,
    [0, 0.2, 0.56, 0.74],
  );
  return clampRungToCeiling(BEAM_STYLE_ORDER, proposed, ceiling);
}

/** Unit body shape rung for a host's level, clamped to the user's ceiling. */
export function unitShapeForDetail(level: number, ceiling: UnitShape): UnitShape {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed = rungForDetail(
    'unit',
    UNIT_SHAPE_ORDER,
    ['body', 'bodyDetail'],
    level,
    [0, 0.46],
  );
  return clampRungToCeiling(UNIT_SHAPE_ORDER, proposed, ceiling);
}

export function detailRungIndex(level: number): number {
  return GEOMETRY_TIER_ORDER.indexOf(geometryTierForDetail(level));
}

export function smokeSpawnScaleForDetail(level: number): number {
  if (!ENTITY_DETAIL_ENABLED) return 1;
  return steppedScaleByThresholds(
    level,
    'smoke',
    [
      ['none', 0, 0],
      ['minimumCadence', 0.25, 0.12],
      ['lowDensity', 0.42, 0.28],
      ['normalReducedDensity', 0.62, 0.46],
      ['nearFullDensity', 0.82, 0.64],
      ['fullDensity', 1, 0.82],
    ],
  );
}

export function explosionSpawnScaleForDetail(level: number): number {
  if (!ENTITY_DETAIL_ENABLED) return 1;
  return steppedScaleByThresholds(
    level,
    'explosion',
    [
      ['flashOnly', 0.18, 0],
      ['smallRing', 0.32, 0.18],
      ['fewParticles', 0.5, 0.36],
      ['debrisScatter', 0.75, 0.56],
      ['fullShock', 1, 0.76],
    ],
  );
}

export function debrisSpawnScaleForDetail(level: number): number {
  if (!ENTITY_DETAIL_ENABLED) return 1;
  return steppedScaleByThresholds(
    level,
    'debris',
    [
      ['none', 0, 0],
      ['lowCount', 0.2, 0.2],
      ['moderateCount', 0.45, 0.4],
      ['physicalPieces', 0.75, 0.6],
      ['fullPieces', 1, 0.8],
    ],
  );
}

/**
 * Coarse per-unit detail band: the turret and leg rungs (after clamping to the
 * user's ceiling) packed into one small int. Two units at the same band get
 * structurally identical meshes, so the band is a cheap key for "has this unit
 * shrunk/grown enough to need a different mesh?". Because the rungs are already
 * clamped to the global ceiling, a config that caps turrets/legs low collapses
 * every level to one band (no rebuilds).
 */
export function unitDetailBand(level: number, gfx: GraphicsConfig): number {
  const turret = TURRET_STYLE_ORDER.indexOf(turretStyleForDetail(level, gfx.turretStyle));
  const legs = LEG_STYLE_ORDER.indexOf(legStyleForDetail(level, gfx.legs));
  const tier = detailRungIndex(level);
  const shape = UNIT_SHAPE_ORDER.indexOf(unitShapeForDetail(level, gfx.unitShape));
  const treadsAnimated =
    gfx.treadsAnimated &&
    visualFeatureVisibleAtDetail('locomotion', 'basicAnimation', level, 0.44);
  return (
    (tier < 0 ? 0 : tier) * 64 +
    (turret < 0 ? 0 : turret) * 16 +
    (legs < 0 ? 0 : legs) * 4 +
    (shape < 0 ? 0 : shape) * 2 +
    (treadsAnimated ? 1 : 0)
  );
}

/**
 * A graphics config for one unit at `level`: the global config with only its
 * turret and leg rungs scaled down to the unit's detail level (those are the
 * two GraphicsConfig knobs that actually remove unit geometry). Returns the
 * input unchanged — no allocation — when nothing sheds.
 */
export function unitDetailGraphicsConfig(gfx: GraphicsConfig, level: number): GraphicsConfig {
  const turretStyle = turretStyleForDetail(level, gfx.turretStyle);
  const legs = legStyleForDetail(level, gfx.legs);
  const unitShape = unitShapeForDetail(level, gfx.unitShape);
  const chassisDetail =
    gfx.chassisDetail && visualFeatureVisibleAtDetail('unit', 'bodyDetail', level, 0.46);
  const treadsAnimated =
    gfx.treadsAnimated &&
    visualFeatureVisibleAtDetail('locomotion', 'basicAnimation', level, 0.44);
  if (
    turretStyle === gfx.turretStyle &&
    legs === gfx.legs &&
    unitShape === gfx.unitShape &&
    chassisDetail === gfx.chassisDetail &&
    treadsAnimated === gfx.treadsAnimated
  ) {
    return gfx;
  }
  return { ...gfx, turretStyle, legs, unitShape, chassisDetail, treadsAnimated };
}
