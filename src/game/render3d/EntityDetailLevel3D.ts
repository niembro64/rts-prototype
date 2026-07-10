// Continuous entity visual detail from projected screen coverage.
//
// Every entity gets a detail level L in [0,1] derived from its projected
// screen radius at a fixed reference viewport height (resolution/DPR
// invariant): L = 0 at/below the glyph radius — the entity is the flat
// point-sprite proxy — and L = 1 at/above the full-detail radius. Between
// the ends, discrete RUNGS pick the geometry segment tier and which named
// features are built:
//
//   GLYPH (0)  point-sprite proxy, zero triangles
//   FAR   (1)  'far' segment tier, primary barrel only, static locomotion
//   MID   (2)  'mid' segment tier, no joint spheres / muzzle trim
//   CLOSE (3)  'close' segment tier, full authored presentation
//
// Features snap to rung boundaries on purpose: one hysteresis covers every
// transition and a whole zoom sweep costs at most three mesh transitions
// per entity. Thresholds live in lod.json `detail`; this module is pure
// (no THREE) and interprets that config.

import { ENTITY_DETAIL_CONFIG } from '@/config';
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

export const DETAIL_LEVEL_FULL = 1;
export const DETAIL_LEVEL_GLYPH = 0;

export const DETAIL_RUNG_GLYPH = 0;
export const DETAIL_RUNG_FAR = 1;
export const DETAIL_RUNG_MID = 2;
export const DETAIL_RUNG_CLOSE = 3;
export type DetailRung =
  | typeof DETAIL_RUNG_GLYPH
  | typeof DETAIL_RUNG_FAR
  | typeof DETAIL_RUNG_MID
  | typeof DETAIL_RUNG_CLOSE;

const TURRET_STYLE_ORDER: readonly TurretStyle[] = ['none', 'simple', 'full'];
const LEG_STYLE_ORDER: readonly LegStyle[] = ['none', 'simple', 'animated', 'full'];
const UNIT_SHAPE_ORDER: readonly UnitShape[] = ['circles', 'full'];

function finitePositiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

type EffectSpawnScaleConfig = {
  zeroBelow: number;
  fullAbove: number;
  floor: number;
};

function rungFromName(name: unknown, fallback: DetailRung): DetailRung {
  switch (name) {
    case 'glyph': return DETAIL_RUNG_GLYPH;
    case 'far': return DETAIL_RUNG_FAR;
    case 'mid': return DETAIL_RUNG_MID;
    case 'close': return DETAIL_RUNG_CLOSE;
    default: return fallback;
  }
}

const detailConfig = ENTITY_DETAIL_CONFIG;

export const ENTITY_DETAIL_ENABLED: boolean = detailConfig.enabled === true;
const REFERENCE_VIEWPORT_HEIGHT_PX = finitePositiveOr(
  detailConfig.referenceViewportHeightPx, 1080);
const GLYPH_SCREEN_RADIUS_PX = finitePositiveOr(detailConfig.screenRadiusPx?.glyph, 4);
const FULL_SCREEN_RADIUS_PX = Math.max(
  GLYPH_SCREEN_RADIUS_PX + 1,
  finitePositiveOr(detailConfig.screenRadiusPx?.full, 26),
);
const MID_RUNG_MIN_LEVEL = clamp01(finitePositiveOr(detailConfig.rungMinLevel?.mid, 0.32));
const CLOSE_RUNG_MIN_LEVEL = Math.max(
  MID_RUNG_MIN_LEVEL,
  clamp01(finitePositiveOr(detailConfig.rungMinLevel?.close, 0.62)),
);
export const DETAIL_HYSTERESIS_LEVEL = clamp01(
  finitePositiveOr(detailConfig.hysteresisLevel, 0.05));
export const DETAIL_REBUILD_BUDGET_UNITS = Math.max(
  1, Math.floor(finitePositiveOr(detailConfig.rebuildBudgetPerFrame?.units, 24)));
export const DETAIL_REBUILD_BUDGET_BUILDINGS = Math.max(
  1, Math.floor(finitePositiveOr(detailConfig.rebuildBudgetPerFrame?.buildings, 8)));
export const DETAIL_RADIUS_FLOOR_PROJECTILE = finitePositiveOr(
  detailConfig.radiusFloor?.projectile, 11);
export const DETAIL_RADIUS_FLOOR_BEAM = finitePositiveOr(
  detailConfig.radiusFloor?.beam, 11);
export const DETAIL_RADIUS_FLOOR_EFFECT = finitePositiveOr(
  detailConfig.radiusFloor?.effectDefault, 12);

const FEATURE_MIN_RUNG: Record<DetailFeature, DetailRung> = {
  body: DETAIL_RUNG_FAR,
  healthBar: DETAIL_RUNG_FAR,
  turret: DETAIL_RUNG_FAR,
  barrelPrimary: DETAIL_RUNG_FAR,
  locomotion: DETAIL_RUNG_FAR,
  nameLabel: DETAIL_RUNG_FAR,
  projectileTrail: DETAIL_RUNG_FAR,
  turretHead: DETAIL_RUNG_FAR,
  shieldPanels: DETAIL_RUNG_FAR,
  beamGlow: DETAIL_RUNG_MID,
  buildingDetail: DETAIL_RUNG_MID,
  chassisDetail: DETAIL_RUNG_MID,
  barrelSecondary: DETAIL_RUNG_MID,
  projectileGlow: DETAIL_RUNG_MID,
  locomotionAnimated: DETAIL_RUNG_MID,
  muzzleDetail: DETAIL_RUNG_CLOSE,
};
{
  const authored = detailConfig.featureMinRung as
    | Record<string, string>
    | undefined;
  if (authored) {
    for (const key of Object.keys(FEATURE_MIN_RUNG) as DetailFeature[]) {
      FEATURE_MIN_RUNG[key] = rungFromName(authored[key], FEATURE_MIN_RUNG[key]);
    }
  }
}

const VISUAL_FEATURE_MIN_RUNG = new Map<string, DetailRung>();
{
  const authored = detailConfig.visualFeatureMinRung as
    | Record<string, Record<string, string>>
    | undefined;
  if (authored) {
    for (const category of Object.keys(authored)) {
      const keys = authored[category];
      for (const key of Object.keys(keys)) {
        VISUAL_FEATURE_MIN_RUNG.set(
          `${category}:${key}`,
          rungFromName(keys[key], DETAIL_RUNG_FAR),
        );
      }
    }
  }
}

export const UNIT_ANIMATION_MIN_RUNG: DetailRung = rungFromName(
  detailConfig.animation?.unitAnimationMinRung, DETAIL_RUNG_MID);
export const BUILDING_ANIMATION_MIN_RUNG: DetailRung = rungFromName(
  detailConfig.animation?.buildingAnimationMinRung, DETAIL_RUNG_MID);
export const LOCOMOTION_FAR_FRAME_STRIDE = Math.max(
  1, Math.floor(finitePositiveOr(detailConfig.animation?.locomotionFarFrameStride, 4)));

function effectSpawnScaleConfig(
  key: 'smoke' | 'explosion' | 'debris',
  zeroBelow: number,
  fullAbove: number,
  floor: number,
): EffectSpawnScaleConfig {
  const authored = detailConfig.effectSpawnScale?.[key] as
    | Partial<EffectSpawnScaleConfig>
    | undefined;
  return {
    zeroBelow: clamp01(authored?.zeroBelow ?? zeroBelow),
    fullAbove: clamp01(authored?.fullAbove ?? fullAbove),
    floor: clamp01(authored?.floor ?? floor),
  };
}

const SMOKE_SPAWN_SCALE = effectSpawnScaleConfig('smoke', 0.02, 0.5, 0);
const EXPLOSION_SPAWN_SCALE = effectSpawnScaleConfig('explosion', 0.02, 0.6, 0.18);
const DEBRIS_SPAWN_SCALE = effectSpawnScaleConfig('debris', 0.15, 0.6, 0);

export const ENVIRONMENT_GRASS_MIN_SCREEN_RADIUS_PX = finitePositiveOr(
  detailConfig.environment?.grassMinScreenRadiusPx, 3);
export const ENVIRONMENT_TREE_MIN_SCREEN_RADIUS_PX = finitePositiveOr(
  detailConfig.environment?.treeMinScreenRadiusPx, 1.5);
export const FOG_SPHERE_GEOMETRY_TIER: PrimitiveGeometryTier =
  detailConfig.fogSphereTier === 'close' || detailConfig.fogSphereTier === 'far'
    ? detailConfig.fogSphereTier
    : 'mid';

// ── Screen-coverage math ────────────────────────────────────────────

/** World-radius → screen-radius scale at the reference viewport height:
 *  screenPx = radiusWorld * detailPxScale(fovYRad) / distance. */
export function detailPxScale(fovYRad: number): number {
  const halfFov = Number.isFinite(fovYRad) && fovYRad > 0 && fovYRad < Math.PI
    ? fovYRad / 2
    : Math.PI / 8;
  return (REFERENCE_VIEWPORT_HEIGHT_PX / 2) / Math.tan(halfFov);
}

export function detailScreenRadiusPx(
  radiusWorld: number,
  distance: number,
  fovYRad: number,
): number {
  if (!Number.isFinite(distance) || distance <= 0) return FULL_SCREEN_RADIUS_PX;
  const radius = finitePositiveOr(radiusWorld, 1);
  return (radius * detailPxScale(fovYRad)) / distance;
}

export function detailLevelForScreenRadius(screenRadiusPx: number): number {
  if (!ENTITY_DETAIL_ENABLED) return DETAIL_LEVEL_FULL;
  return clamp01(
    (screenRadiusPx - GLYPH_SCREEN_RADIUS_PX) /
      (FULL_SCREEN_RADIUS_PX - GLYPH_SCREEN_RADIUS_PX),
  );
}

export function detailLevelForRadiusDistance(
  radiusWorld: number,
  distance: number,
  fovYRad: number,
): number {
  return detailLevelForScreenRadius(
    detailScreenRadiusPx(radiusWorld, distance, fovYRad),
  );
}

/** Detail level for a bare sim position (effect events, smoke emitters)
 *  where no entity radius is at hand — uses the effect radius floor. */
export function detailLevelForViewPosition(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radiusWorld: number = DETAIL_RADIUS_FLOOR_EFFECT,
): number {
  const dx = view.cameraX - simX;
  const dy = view.cameraY - simZ;
  const dz = view.cameraZ - simY;
  return detailLevelForRadiusDistance(
    radiusWorld,
    Math.sqrt(dx * dx + dy * dy + dz * dz),
    view.fovYRad,
  );
}

// ── Rung ladder ─────────────────────────────────────────────────────

export function detailRungForLevel(level: number): DetailRung {
  if (level <= DETAIL_LEVEL_GLYPH) return DETAIL_RUNG_GLYPH;
  if (level >= CLOSE_RUNG_MIN_LEVEL) return DETAIL_RUNG_CLOSE;
  if (level >= MID_RUNG_MIN_LEVEL) return DETAIL_RUNG_MID;
  return DETAIL_RUNG_FAR;
}

/** Minimum L of a rung — the representative level stamped onto packets
 *  so `detailRungForLevel(detailLevelForRung(r)) === r` round-trips. */
export function detailLevelForRung(rung: DetailRung): number {
  switch (rung) {
    case DETAIL_RUNG_CLOSE: return DETAIL_LEVEL_FULL;
    case DETAIL_RUNG_MID: return MID_RUNG_MIN_LEVEL;
    case DETAIL_RUNG_FAR: return Math.min(MID_RUNG_MIN_LEVEL / 2, 0.01);
    default: return DETAIL_LEVEL_GLYPH;
  }
}

/** Latched rung transition: moving to a different rung requires L to
 *  clear that rung's boundary by the hysteresis margin, so an entity
 *  sitting on a boundary never oscillates. */
export function detailRungWithHysteresis(
  currentRung: DetailRung,
  level: number,
): DetailRung {
  const targetRung = detailRungForLevel(level);
  if (targetRung === currentRung) return currentRung;
  if (targetRung > currentRung) {
    // Upgrading: L must exceed the target rung's floor by the margin.
    const floor = rungMinLevel(targetRung);
    return level >= floor + DETAIL_HYSTERESIS_LEVEL ? targetRung : currentRung;
  }
  // Downgrading: L must fall below the current rung's floor by the margin.
  const floor = rungMinLevel(currentRung);
  return level <= floor - DETAIL_HYSTERESIS_LEVEL || targetRung === DETAIL_RUNG_GLYPH
    ? targetRung
    : currentRung;
}

function rungMinLevel(rung: DetailRung): number {
  switch (rung) {
    case DETAIL_RUNG_CLOSE: return CLOSE_RUNG_MIN_LEVEL;
    case DETAIL_RUNG_MID: return MID_RUNG_MIN_LEVEL;
    default: return 0;
  }
}

export function detailRungIndex(level: number): number {
  return detailRungForLevel(level);
}

// ── Feature + style ladders ─────────────────────────────────────────

export function featureVisibleAtRung(feature: DetailFeature, rung: DetailRung): boolean {
  return rung >= FEATURE_MIN_RUNG[feature];
}

export function featureVisibleAtDetail(feature: DetailFeature, level: number): boolean {
  return featureVisibleAtRung(feature, detailRungForLevel(level));
}

/** Category-keyed feature visibility (building/tower detail keys). The
 *  fallback is a legacy minimum LEVEL used only when the key is not
 *  authored in lod.json. */
export function visualFeatureVisibleAtDetail(
  category: string,
  key: string,
  level: number,
  fallback: number = DETAIL_LEVEL_FULL,
): boolean {
  const minRung = VISUAL_FEATURE_MIN_RUNG.get(`${category}:${key}`);
  if (minRung !== undefined) return detailRungForLevel(level) >= minRung;
  return level >= fallback;
}

export function geometryTierForDetail(level: number): PrimitiveGeometryTier {
  switch (detailRungForLevel(level)) {
    case DETAIL_RUNG_CLOSE: return 'close';
    case DETAIL_RUNG_MID: return 'mid';
    default: return 'far';
  }
}

export function turretStyleForDetail(level: number, ceiling: TurretStyle): TurretStyle {
  return detailRungForLevel(level) === DETAIL_RUNG_GLYPH ? 'none' : ceiling;
}

export function legStyleForDetail(level: number, ceiling: LegStyle): LegStyle {
  switch (detailRungForLevel(level)) {
    case DETAIL_RUNG_CLOSE: return ceiling;
    case DETAIL_RUNG_MID: return minLegStyle(ceiling, 'animated');
    case DETAIL_RUNG_FAR: return minLegStyle(ceiling, 'simple');
    default: return 'none';
  }
}

function minLegStyle(a: LegStyle, b: LegStyle): LegStyle {
  return LEG_STYLE_ORDER.indexOf(a) <= LEG_STYLE_ORDER.indexOf(b) ? a : b;
}

export function projectileStyleForDetail(
  level: number,
  ceiling: ProjectileStyle,
): ProjectileStyle {
  return detailRungForLevel(level) === DETAIL_RUNG_GLYPH ? 'dot' : ceiling;
}

export function beamStyleForDetail(level: number, ceiling: BeamStyle): BeamStyle {
  switch (detailRungForLevel(level)) {
    case DETAIL_RUNG_GLYPH: return 'simple';
    case DETAIL_RUNG_FAR: return ceiling === 'simple' ? 'simple' : 'standard';
    default: return ceiling;
  }
}

export function unitShapeForDetail(level: number, ceiling: UnitShape): UnitShape {
  return detailRungForLevel(level) === DETAIL_RUNG_GLYPH ? 'circles' : ceiling;
}

export function treadsAnimatedForDetail(level: number, ceiling: boolean): boolean {
  return ceiling && featureVisibleAtDetail('locomotionAnimated', level);
}

// ── Effect spawn scales (continuous in L) ───────────────────────────

function effectSpawnScale(config: EffectSpawnScaleConfig, level: number): number {
  if (level >= config.fullAbove) return 1;
  if (level <= config.zeroBelow) return config.floor;
  const t = (level - config.zeroBelow) / (config.fullAbove - config.zeroBelow);
  return config.floor + (1 - config.floor) * t;
}

export function smokeSpawnScaleForDetail(level: number): number {
  return effectSpawnScale(SMOKE_SPAWN_SCALE, level);
}

export function explosionSpawnScaleForDetail(level: number): number {
  return effectSpawnScale(EXPLOSION_SPAWN_SCALE, level);
}

export function debrisSpawnScaleForDetail(level: number): number {
  return effectSpawnScale(DEBRIS_SPAWN_SCALE, level);
}

// ── Unit rebuild band + graphics ceiling ────────────────────────────

/** Packs everything that forces a unit mesh rebuild when it changes:
 *  the rung plus every style the rung/graphics ceiling combination
 *  resolves to. Same packing shape as before, rung now spans 0-3. */
export function unitDetailBand(level: number, gfx: GraphicsConfig): number {
  const rung = detailRungForLevel(level);
  const turret = TURRET_STYLE_ORDER.indexOf(turretStyleForDetail(level, gfx.turretStyle));
  const legs = LEG_STYLE_ORDER.indexOf(legStyleForDetail(level, gfx.legs));
  const shape = UNIT_SHAPE_ORDER.indexOf(unitShapeForDetail(level, gfx.unitShape));
  const treadsAnimated = treadsAnimatedForDetail(level, gfx.treadsAnimated);
  return (
    rung * 64 +
    (turret < 0 ? 0 : turret) * 16 +
    (legs < 0 ? 0 : legs) * 4 +
    (shape < 0 ? 0 : shape) * 2 +
    (treadsAnimated ? 1 : 0)
  );
}

/** Per-entity graphics config for a detail level: the user's global
 *  settings are the ceiling; detail only ever scales DOWN. Returns the
 *  input object untouched when nothing sheds. */
export function unitDetailGraphicsConfig(gfx: GraphicsConfig, level: number): GraphicsConfig {
  const legs = legStyleForDetail(level, gfx.legs);
  const turretStyle = turretStyleForDetail(level, gfx.turretStyle);
  const unitShape = unitShapeForDetail(level, gfx.unitShape);
  const chassisDetail = gfx.chassisDetail && featureVisibleAtDetail('chassisDetail', level);
  const treadsAnimated = treadsAnimatedForDetail(level, gfx.treadsAnimated);
  if (
    legs === gfx.legs &&
    turretStyle === gfx.turretStyle &&
    unitShape === gfx.unitShape &&
    chassisDetail === gfx.chassisDetail &&
    treadsAnimated === gfx.treadsAnimated
  ) {
    return gfx;
  }
  return {
    ...gfx,
    turretStyle,
    legs,
    unitShape,
    chassisDetail,
    treadsAnimated,
  };
}
