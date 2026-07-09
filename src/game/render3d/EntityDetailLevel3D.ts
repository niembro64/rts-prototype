// Binary entity visual detail.
//
// The renderer now has one LOD decision:
//   HIGH = full meshes and full authored presentation.
//   LOW  = the proxy/glyph representation.
//
// AUTO flips between those two states at the single world-space distance in
// `lod.json`. The helpers in this module remain because many renderers already
// ask "what style should I use at this detail level?", but the answers are now
// binary instead of a multi-rung 0..1 ladder.

import { ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE } from '@/config';
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

const TURRET_STYLE_ORDER: readonly TurretStyle[] = ['none', 'simple', 'full'];
const LEG_STYLE_ORDER: readonly LegStyle[] = ['none', 'simple', 'animated', 'full'];
const UNIT_SHAPE_ORDER: readonly UnitShape[] = ['circles', 'full'];

function isFullDetail(level: number): boolean {
  return level >= DETAIL_LEVEL_FULL;
}

function finitePositiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function detailLevelForDistance(distance: number, switchDistance: number): number {
  const threshold = finitePositiveOr(switchDistance, ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE);
  if (!Number.isFinite(distance) || distance <= 0) return DETAIL_LEVEL_FULL;
  return distance < threshold ? DETAIL_LEVEL_FULL : DETAIL_LEVEL_GLYPH;
}

export function detailLevelForViewPosition(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
): number {
  const dx = view.cameraX - simX;
  const dy = view.cameraY - simZ;
  const dz = view.cameraZ - simY;
  return detailLevelForDistance(
    Math.sqrt(dx * dx + dy * dy + dz * dz),
    ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE,
  );
}

export function visualFeatureVisibleAtDetail(
  _category: string,
  _key: string,
  level: number,
  _fallback: number = DETAIL_LEVEL_FULL,
): boolean {
  return isFullDetail(level);
}

export function featureVisibleAtDetail(_feature: DetailFeature, level: number): boolean {
  return isFullDetail(level);
}

export function geometryTierForDetail(level: number): PrimitiveGeometryTier {
  return isFullDetail(level) ? 'close' : 'far';
}

export function turretStyleForDetail(level: number, ceiling: TurretStyle): TurretStyle {
  return isFullDetail(level) ? ceiling : 'none';
}

export function legStyleForDetail(level: number, ceiling: LegStyle): LegStyle {
  return isFullDetail(level) ? ceiling : 'none';
}

export function projectileStyleForDetail(
  level: number,
  ceiling: ProjectileStyle,
): ProjectileStyle {
  return isFullDetail(level) ? ceiling : 'dot';
}

export function beamStyleForDetail(level: number, ceiling: BeamStyle): BeamStyle {
  return isFullDetail(level) ? ceiling : 'simple';
}

export function unitShapeForDetail(level: number, ceiling: UnitShape): UnitShape {
  return isFullDetail(level) ? ceiling : 'circles';
}

export function detailRungIndex(level: number): number {
  return isFullDetail(level) ? 1 : 0;
}

export function smokeSpawnScaleForDetail(level: number): number {
  return isFullDetail(level) ? 1 : 0;
}

export function explosionSpawnScaleForDetail(level: number): number {
  return isFullDetail(level) ? 1 : 0.18;
}

export function debrisSpawnScaleForDetail(level: number): number {
  return isFullDetail(level) ? 1 : 0;
}

export function unitDetailBand(level: number, gfx: GraphicsConfig): number {
  const tier = detailRungIndex(level);
  const turret = TURRET_STYLE_ORDER.indexOf(turretStyleForDetail(level, gfx.turretStyle));
  const legs = LEG_STYLE_ORDER.indexOf(legStyleForDetail(level, gfx.legs));
  const shape = UNIT_SHAPE_ORDER.indexOf(unitShapeForDetail(level, gfx.unitShape));
  const treadsAnimated = isFullDetail(level) && gfx.treadsAnimated;
  return (
    tier * 64 +
    (turret < 0 ? 0 : turret) * 16 +
    (legs < 0 ? 0 : legs) * 4 +
    (shape < 0 ? 0 : shape) * 2 +
    (treadsAnimated ? 1 : 0)
  );
}

export function unitDetailGraphicsConfig(gfx: GraphicsConfig, level: number): GraphicsConfig {
  if (isFullDetail(level)) return gfx;
  if (
    gfx.turretStyle === 'none' &&
    gfx.legs === 'none' &&
    gfx.unitShape === 'circles' &&
    gfx.chassisDetail === false &&
    gfx.treadsAnimated === false
  ) {
    return gfx;
  }
  return {
    ...gfx,
    turretStyle: 'none',
    legs: 'none',
    unitShape: 'circles',
    chassisDetail: false,
    treadsAnimated: false,
  };
}
