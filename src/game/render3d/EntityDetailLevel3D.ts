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

export const ENTITY_DETAIL_ENABLED = false;
export const DETAIL_HYSTERESIS_LEVEL = 0;
export const DETAIL_REBUILD_BUDGET_UNITS = Number.MAX_SAFE_INTEGER;
export const DETAIL_REBUILD_BUDGET_BUILDINGS = Number.MAX_SAFE_INTEGER;
export const DETAIL_RADIUS_FLOOR_PROJECTILE = 11;
export const DETAIL_RADIUS_FLOOR_BEAM = 11;
export const DETAIL_RADIUS_FLOOR_EFFECT = 12;
export const UNIT_ANIMATION_MIN_RUNG: DetailRung = DETAIL_RUNG_CLOSE;
export const BUILDING_ANIMATION_MIN_RUNG: DetailRung = DETAIL_RUNG_CLOSE;
export const LOCOMOTION_FAR_FRAME_STRIDE = 1;
export const ENVIRONMENT_GRASS_MIN_SCREEN_RADIUS_PX = 0;
export const ENVIRONMENT_TREE_MIN_SCREEN_RADIUS_PX = 0;
export const FOG_SPHERE_GEOMETRY_TIER: PrimitiveGeometryTier = 'close';

export function detailPxScale(_fovYRad: number): number {
  return 1;
}

export function detailScreenRadiusPx(
  _radiusWorld: number,
  _distance: number,
  _fovYRad: number,
): number {
  return Number.POSITIVE_INFINITY;
}

export function detailLevelForScreenRadius(_screenRadiusPx: number): number {
  return DETAIL_LEVEL_FULL;
}

export function detailLevelForRadiusDistance(
  _radiusWorld: number,
  _distance: number,
  _fovYRad: number,
): number {
  return DETAIL_LEVEL_FULL;
}

export function detailLevelForViewPosition(
  _view: RenderViewState3D,
  _simX: number,
  _simY: number,
  _simZ: number,
  _radiusWorld: number = DETAIL_RADIUS_FLOOR_EFFECT,
): number {
  return DETAIL_LEVEL_FULL;
}

export function detailRungForLevel(_level: number): DetailRung {
  return DETAIL_RUNG_CLOSE;
}

export function detailLevelForRung(_rung: DetailRung): number {
  return DETAIL_LEVEL_FULL;
}

export function detailRungWithHysteresis(
  _currentRung: DetailRung,
  _level: number,
): DetailRung {
  return DETAIL_RUNG_CLOSE;
}

export function detailRungMinLevel(_rung: DetailRung): number {
  return DETAIL_LEVEL_FULL;
}

export function detailRungIndex(_level: number): number {
  return DETAIL_RUNG_CLOSE;
}

export function featureVisibleAtRung(
  _feature: DetailFeature,
  _rung: DetailRung,
): boolean {
  return true;
}

export function featureVisibleAtDetail(
  _feature: DetailFeature,
  _level: number,
): boolean {
  return true;
}

export function visualFeatureVisibleAtDetail(
  _category: string,
  _key: string,
  _level: number,
  _fallback: number = DETAIL_LEVEL_FULL,
): boolean {
  return true;
}

export function geometryTierForDetail(_level: number): PrimitiveGeometryTier {
  return 'close';
}

export function turretStyleForDetail(_level: number, ceiling: TurretStyle): TurretStyle {
  return ceiling;
}

export function legStyleForDetail(_level: number, ceiling: LegStyle): LegStyle {
  return ceiling;
}

export function projectileStyleForDetail(
  _level: number,
  ceiling: ProjectileStyle,
): ProjectileStyle {
  return ceiling;
}

export function beamStyleForDetail(_level: number, ceiling: BeamStyle): BeamStyle {
  return ceiling;
}

export function unitShapeForDetail(_level: number, ceiling: UnitShape): UnitShape {
  return ceiling;
}

export function treadsAnimatedForDetail(_level: number, ceiling: boolean): boolean {
  return ceiling;
}

export function smokeSpawnScaleForDetail(_level: number): number {
  return 1;
}

export function explosionSpawnScaleForDetail(_level: number): number {
  return 1;
}

export function debrisSpawnScaleForDetail(_level: number): number {
  return 1;
}

export function unitDetailBand(_level: number, gfx: GraphicsConfig): number {
  const turret = TURRET_STYLE_ORDER.indexOf(gfx.turretStyle);
  const legs = LEG_STYLE_ORDER.indexOf(gfx.legs);
  const shape = UNIT_SHAPE_ORDER.indexOf(gfx.unitShape);
  return (
    DETAIL_RUNG_CLOSE * 64 +
    (turret < 0 ? 0 : turret) * 16 +
    (legs < 0 ? 0 : legs) * 4 +
    (shape < 0 ? 0 : shape) * 2 +
    (gfx.treadsAnimated ? 1 : 0)
  );
}

export function unitDetailGraphicsConfig(gfx: GraphicsConfig, _level: number): GraphicsConfig {
  return gfx;
}
