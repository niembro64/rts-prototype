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
// The level itself is produced from the SAME per-entity switch distance the
// proxy system already uses (see EntityLod3D), so L reaches 0 exactly where an
// entity would flip to its glyph — one coherent system, no second threshold.

import {
  ENTITY_DETAIL_ENABLED,
  ENTITY_DETAIL_FEATURE_MIN_LEVEL,
  ENTITY_DETAIL_FULL_DETAIL_FRACTION,
  ENTITY_DETAIL_TIER_CUTOFFS,
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

const FEATURE_MIN_LEVEL = ENTITY_DETAIL_FEATURE_MIN_LEVEL as Record<DetailFeature, number>;

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
  const s = clamp01(t);
  return s * s * (3 - 2 * s);
}

/** The authored level at/above which `feature` is drawn (0 = always present). */
export function featureMinLevel(feature: DetailFeature): number {
  const value = FEATURE_MIN_LEVEL[feature];
  return Number.isFinite(value) ? value : 0;
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
  const cutoffs = ENTITY_DETAIL_TIER_CUTOFFS;
  if (level >= cutoffs.close) return 'close';
  if (level >= cutoffs.mid) return 'mid';
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
  let proposed: TurretStyle = 'none';
  if (featureVisibleAtDetail('turret', level)) {
    proposed = featureVisibleAtDetail('turretHead', level) ? 'full' : 'simple';
  }
  return clampRungToCeiling(TURRET_STYLE_ORDER, proposed, ceiling);
}

/** Locomotion (legs) rung for a host's level, clamped to the user's ceiling. */
export function legStyleForDetail(level: number, ceiling: LegStyle): LegStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  let proposed: LegStyle = 'none';
  if (featureVisibleAtDetail('locomotion', level)) {
    proposed = featureVisibleAtDetail('locomotionAnimated', level)
      ? 'full'
      : featureVisibleAtDetail('chassisDetail', level)
        ? 'animated'
        : 'simple';
  }
  return clampRungToCeiling(LEG_STYLE_ORDER, proposed, ceiling);
}

/** Projectile rung for a projectile's own level, clamped to the user's ceiling. */
export function projectileStyleForDetail(
  level: number,
  ceiling: ProjectileStyle,
): ProjectileStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  let proposed: ProjectileStyle = 'dot';
  if (featureVisibleAtDetail('projectileGlow', level)) proposed = 'full';
  else if (featureVisibleAtDetail('projectileTrail', level)) proposed = 'trail';
  else if (featureVisibleAtDetail('healthBar', level)) proposed = 'core';
  return clampRungToCeiling(PROJECTILE_STYLE_ORDER, proposed, ceiling);
}

/** Beam rung for the firing host's level, clamped to the user's ceiling. */
export function beamStyleForDetail(level: number, ceiling: BeamStyle): BeamStyle {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  let proposed: BeamStyle = 'simple';
  if (featureVisibleAtDetail('beamGlow', level)) proposed = 'complex';
  else if (featureVisibleAtDetail('projectileTrail', level)) proposed = 'detailed';
  else if (featureVisibleAtDetail('turret', level)) proposed = 'standard';
  return clampRungToCeiling(BEAM_STYLE_ORDER, proposed, ceiling);
}

/** Unit body shape rung for a host's level, clamped to the user's ceiling. */
export function unitShapeForDetail(level: number, ceiling: UnitShape): UnitShape {
  if (!ENTITY_DETAIL_ENABLED) return ceiling;
  const proposed: UnitShape = featureVisibleAtDetail('chassisDetail', level)
    ? 'full'
    : 'circles';
  return clampRungToCeiling(UNIT_SHAPE_ORDER, proposed, ceiling);
}

/** How far a unit's detail level must move from its last-built level before its
 *  mesh is rebuilt into a new band. Prevents a unit parked on a band boundary
 *  from rebuilding every frame as its level dithers. */
export const UNIT_DETAIL_REBUILD_MARGIN = 0.04;

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
  return (turret < 0 ? 0 : turret) * 8 + (legs < 0 ? 0 : legs);
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
  if (turretStyle === gfx.turretStyle && legs === gfx.legs) return gfx;
  return { ...gfx, turretStyle, legs };
}
