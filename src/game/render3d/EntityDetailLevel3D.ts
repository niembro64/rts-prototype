// Three-rung entity visual detail selected from projected screen coverage.
//
// The ladder is authored in lod.json `detail.thresholds` as three projected
// screen radii in px — highToMedPx / medToLowPx / lowToOffPx, named for the bar
// controls they switch between — measured at a fixed reference viewport height
// so the choice is resolution/DPR invariant. Internally those px thresholds are
// normalised into a coverage metric L in [0,1] (L = 0 at the OFF threshold),
// purely so a single scalar can be passed around; L only selects one discrete
// authored RUNG and is never a visual level itself:
//
//   GLYPH (0)  point-sprite proxy (BAR-style strategic icon); the icon
//              cross-fades in over the model beforehand — see
//              lodProxyFadeAlphaForScreenRadius
//   FAR   (1)  low-poly geometry, full authored unit silhouette and rig
//   MID   (2)  medium-poly geometry, full authored unit silhouette and rig
//   CLOSE (3)  high-poly geometry, full authored unit silhouette and rig
//
// AUTO and the manual controls therefore resolve to the same authored rungs,
// including OFF/GLYPH. A manual HIGH/MED/LOW pin selects the geometry rung of a
// DRAWN model only — it is not a visibility policy, so GLYPH stays the floor in
// every mode (detailRungWithGlyphFloor) and a strategic zoom keeps its icons
// instead of showing sub-pixel models. Features snap to rung boundaries on
// purpose: one hysteresis covers every transition and a whole zoom sweep costs
// at most three mesh transitions per entity. This module is pure (no THREE)
// and is the only interpreter of that config.

import { ENTITY_DETAIL_CONFIG } from '@/config';
import { getLodMode } from '@/clientBarConfig';
import { clamp01 } from '../math';
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
  | 'treadCleats'
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

type EffectSpawnScaleConfig = Record<
  'close' | 'mid' | 'far',
  number
>;

/** lod.json spells rungs in the bar's HIGH/MED/LOW/OFF vocabulary; the older
 *  geometry-tier spellings (close/mid/far/glyph) still resolve to the same
 *  rungs so nothing that predates the rename has to be re-authored. */
function rungFromName(name: unknown, fallback: DetailRung): DetailRung {
  switch (name) {
    case 'off': case 'glyph': return DETAIL_RUNG_GLYPH;
    case 'low': case 'far': return DETAIL_RUNG_FAR;
    case 'medium': case 'med': case 'mid': return DETAIL_RUNG_MID;
    case 'high': return DETAIL_RUNG_CLOSE;
    case 'close': return DETAIL_RUNG_CLOSE;
    default: return fallback;
  }
}

const detailConfig = ENTITY_DETAIL_CONFIG;

const ENTITY_DETAIL_ENABLED: boolean = detailConfig.enabled === true;
const REFERENCE_VIEWPORT_HEIGHT_PX = finitePositiveOr(
  detailConfig.referenceViewportHeightPx, 1080);
// The three authored boundaries, all in ONE unit: projected screen radius in px
// at the reference viewport. Named for the bar controls they switch between,
// so a threshold reads the same way in lod.json, in the HUD and here.
export const THRESHOLD_LOW_TO_OFF_PX = finitePositiveOr(
  detailConfig.thresholds?.lowToOffPx, 10);
export const THRESHOLD_MED_TO_LOW_PX = Math.max(
  THRESHOLD_LOW_TO_OFF_PX + 0.5,
  finitePositiveOr(detailConfig.thresholds?.medToLowPx, 15.12),
);
export const THRESHOLD_HIGH_TO_MED_PX = Math.max(
  THRESHOLD_MED_TO_LOW_PX + 0.5,
  finitePositiveOr(detailConfig.thresholds?.highToMedPx, 19.92),
);
/** Deadband on every boundary, in the same px unit. */
export const DETAIL_HYSTERESIS_PX = finitePositiveOr(
  detailConfig.thresholds?.hysteresisPx, 0.8);

// Internal coverage level L: a normalised restatement of the px thresholds
// above, kept only because packets and the effect/tier helpers pass a single
// scalar around. L = 0 at the OFF threshold and 1 at the top of the ramp,
// which sits a deadband's worth ABOVE the HIGH threshold so that upgrading
// into HIGH (which must clear the boundary by the margin) is reachable at all.
// Every comparison below is therefore exactly the px comparison it looks like.
const LEVEL_RAMP_TOP_PX = THRESHOLD_HIGH_TO_MED_PX + DETAIL_HYSTERESIS_PX * 2;
const LEVEL_RAMP_SPAN_PX = LEVEL_RAMP_TOP_PX - THRESHOLD_LOW_TO_OFF_PX;
const MID_RUNG_MIN_LEVEL = clamp01(
  (THRESHOLD_MED_TO_LOW_PX - THRESHOLD_LOW_TO_OFF_PX) / LEVEL_RAMP_SPAN_PX);
const CLOSE_RUNG_MIN_LEVEL = clamp01(
  (THRESHOLD_HIGH_TO_MED_PX - THRESHOLD_LOW_TO_OFF_PX) / LEVEL_RAMP_SPAN_PX);
export const DETAIL_HYSTERESIS_LEVEL = clamp01(
  DETAIL_HYSTERESIS_PX / LEVEL_RAMP_SPAN_PX);
// BAR-style icon cross-fade band: DERIVED, not authored. The proxy glyph
// starts fully transparent at the MED→LOW threshold — the moment geometry
// drops to the LOW tier — then fades in over that still-opaque LOW model. It
// reaches full opacity only at the OFF threshold, where the LOW model hard-cuts.
export const ICON_FADE_START_SCREEN_RADIUS_PX = THRESHOLD_MED_TO_LOW_PX;

/** Screen radius that maps to a given coverage level — the inverse of
 *  detailLevelForScreenRadius, for callers reasoning in px. */
export function detailScreenRadiusPxForLevel(level: number): number {
  return THRESHOLD_LOW_TO_OFF_PX + level * LEVEL_RAMP_SPAN_PX;
}
export const DETAIL_REBUILD_BUDGET_UNITS = Math.max(
  1, Math.floor(finitePositiveOr(detailConfig.rebuildBudgetPerFrame?.units, 24)));
export const DETAIL_REBUILD_BUDGET_BUILDINGS = Math.max(
  1, Math.floor(finitePositiveOr(detailConfig.rebuildBudgetPerFrame?.buildings, 8)));
export const DETAIL_RADIUS_FLOOR_PROJECTILE = finitePositiveOr(
  detailConfig.radiusFloor?.projectile, 11);
export const DETAIL_RADIUS_FLOOR_BEAM = finitePositiveOr(
  detailConfig.radiusFloor?.beam, 11);
const DETAIL_RADIUS_FLOOR_EFFECT = finitePositiveOr(
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
  treadCleats: DETAIL_RUNG_MID,
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
  key: 'smoke' | 'explosion',
  mid: number,
  far: number,
): EffectSpawnScaleConfig {
  const authored = detailConfig.effectSpawnScale?.[key] as
    | Partial<EffectSpawnScaleConfig>
    | undefined;
  return {
    close: clamp01(authored?.close ?? 1),
    mid: clamp01(authored?.mid ?? mid),
    far: clamp01(authored?.far ?? far),
  };
}

const SMOKE_SPAWN_SCALE = effectSpawnScaleConfig('smoke', 0.65, 0.3);
const EXPLOSION_SPAWN_SCALE = effectSpawnScaleConfig('explosion', 0.7, 0.35);

// ── Screen-coverage math ────────────────────────────────────────────

/** World-radius → screen-radius scale at the reference viewport height:
 *  screenPx = radiusWorld * detailPxScale(fovYRad) / distance. */
function detailPxScale(fovYRad: number): number {
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
  if (!Number.isFinite(distance) || distance <= 0) return LEVEL_RAMP_TOP_PX;
  const radius = finitePositiveOr(radiusWorld, 1);
  return (radius * detailPxScale(fovYRad)) / distance;
}

export function detailLevelForScreenRadius(screenRadiusPx: number): number {
  if (!ENTITY_DETAIL_ENABLED) return DETAIL_LEVEL_FULL;
  return clamp01(
    (screenRadiusPx - THRESHOLD_LOW_TO_OFF_PX) / LEVEL_RAMP_SPAN_PX,
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

/**
 * BAR-style icon cross-fade alpha from the projected screen radius.
 * 0 while the model still shows CLOSE- or MID-tier geometry (no icon), then a
 * smooth linear ramp from 0 up to 1 as the radius falls from the
 * mid→far rung boundary (LOW-tier onset) to the glyph threshold,
 * where the FAR model hard-cuts. The MODEL is never faded: it stays
 * fully opaque under the icon and stops drawing entirely once the
 * latched rung reaches GLYPH (where the now-fully-opaque glyph has
 * covered it).
 */
export function lodProxyFadeAlphaForScreenRadius(screenRadiusPx: number): number {
  if (!ENTITY_DETAIL_ENABLED) return 0;
  if (!Number.isFinite(screenRadiusPx)) return 0;
  if (screenRadiusPx >= ICON_FADE_START_SCREEN_RADIUS_PX) return 0;
  if (screenRadiusPx <= THRESHOLD_LOW_TO_OFF_PX) return 1;
  return (ICON_FADE_START_SCREEN_RADIUS_PX - screenRadiusPx) /
    (ICON_FADE_START_SCREEN_RADIUS_PX - THRESHOLD_LOW_TO_OFF_PX);
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
  return detailLevelForRung(detailRungForViewPosition(
    view,
    simX,
    simY,
    simZ,
    radiusWorld,
  ));
}

/** Raw projected-size rung for non-entity world objects, ignoring the LOD mode.
 * Supplying the previous coverage rung gives static props the same hysteresis
 * as entities. Latches must always track THIS value, never the mode-resolved
 * one, so a mode switch cannot feed a pinned rung back into the hysteresis. */
/** Safety factor on the cull cone, so the cone always strictly contains the
 *  view frustum even as the aspect ratio changes mid-frame. */
const VIEW_CULL_CONE_MARGIN = 1.15;

/** Conservative "this sphere cannot be on screen" test.
 *
 *  three.js frustum-culls per Mesh, but it still walks every node of every
 *  subtree to reach those meshes. A caller that owns a whole subtree can skip
 *  that walk entirely by hiding the subtree root -- worth a lot in an RTS,
 *  where most of the world is off camera at any moment.
 *
 *  Hiding something that IS visible would be a rendering bug, so this tests
 *  against a cone that strictly CONTAINS the frustum (built from the frustum's
 *  corner half-angle, times a margin) rather than against the frustum itself.
 *  It therefore returns false for plenty of off-screen spheres; it just never
 *  returns true for an on-screen one. Positions are sim-space, matching the
 *  other view helpers here: three (x, y, z) = sim (x, z, y).
 */
export function viewExcludesSphere(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radiusWorld: number,
): boolean {
  const dx = simX - view.cameraX;
  const dy = simZ - view.cameraY;
  const dz = simY - view.cameraZ;
  const radius = Math.max(0, radiusWorld);
  const along = dx * view.forwardX + dy * view.forwardY + dz * view.forwardZ;
  if (along + radius < 0) return true;
  if (along <= 0) return false;
  const tanY = Math.tan(Math.max(0.01, view.fovYRad) * 0.5);
  const tanCorner =
    Math.hypot(tanY * Math.max(1e-3, view.aspect), tanY) * VIEW_CULL_CONE_MARGIN;
  const coneRadius = along * tanCorner + radius;
  const perpSq = Math.max(0, dx * dx + dy * dy + dz * dz - along * along);
  return perpSq > coneRadius * coneRadius;
}

export function coverageRungForViewPosition(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radiusWorld: number = DETAIL_RADIUS_FLOOR_EFFECT,
  currentCoverageRung?: DetailRung,
): DetailRung {
  const level = detailLevelForRadiusDistance(
    radiusWorld,
    Math.hypot(view.cameraX - simX, view.cameraY - simZ, view.cameraZ - simY),
    view.fovYRad,
  );
  return currentCoverageRung === undefined
    ? detailRungForLevel(level)
    : detailRungWithHysteresis(currentCoverageRung, level);
}

/** Shared projected-size rung selection for non-entity world objects, with the
 * current LOD mode applied. */
export function detailRungForViewPosition(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
  radiusWorld: number = DETAIL_RADIUS_FLOOR_EFFECT,
  currentCoverageRung?: DetailRung,
): DetailRung {
  // OFF is the glyph end state, so it never needs the coverage rung at all.
  if (pinnedRungForLodMode() === DETAIL_RUNG_GLYPH) return DETAIL_RUNG_GLYPH;
  return detailRungForMode(coverageRungForViewPosition(
    view, simX, simY, simZ, radiusWorld, currentCoverageRung));
}

/** The authored rung the current manual LOD override pins, or null in AUTO. */
export function pinnedRungForLodMode(): DetailRung | null {
  switch (getLodMode()) {
    case 'high': return DETAIL_RUNG_CLOSE;
    case 'medium': return DETAIL_RUNG_MID;
    case 'low': return DETAIL_RUNG_FAR;
    case 'off': return DETAIL_RUNG_GLYPH;
    default: return null;
  }
}

/** Applies the current LOD mode to a latched camera-coverage rung. */
export function detailRungForMode(coverageRung: DetailRung): DetailRung {
  const pinned = pinnedRungForLodMode();
  return pinned === null ? coverageRung : detailRungWithGlyphFloor(pinned, coverageRung);
}

/**
 * Manual-override resolution. HIGH/MED/LOW pin which authored geometry rung a
 * DRAWN model uses; they do NOT decide whether the entity is drawn at all. An
 * entity whose projected coverage already reached GLYPH stays a strategic glyph
 * in every mode (BAR behaviour), so pinning HIGH can never trade a readable
 * icon for a sub-pixel model. OFF pins GLYPH and is the end state.
 */
function detailRungWithGlyphFloor(
  pinnedRung: DetailRung,
  coverageRung: DetailRung,
): DetailRung {
  if (pinnedRung === DETAIL_RUNG_GLYPH) return DETAIL_RUNG_GLYPH;
  return coverageRung === DETAIL_RUNG_GLYPH ? DETAIL_RUNG_GLYPH : pinnedRung;
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
 *  sitting on a boundary never oscillates. Multi-rung jumps (camera
 *  cuts) step to the HIGHEST rung whose floor clears the margin — an
 *  entity is never latched more than one rung below its raw target. */
export function detailRungWithHysteresis(
  currentRung: DetailRung,
  level: number,
): DetailRung {
  const targetRung = detailRungForLevel(level);
  if (targetRung === currentRung) return currentRung;
  if (targetRung > currentRung) {
    for (let rung = targetRung; rung > currentRung; rung--) {
      if (level >= rungMinLevel(rung as DetailRung) + DETAIL_HYSTERESIS_LEVEL) {
        return rung as DetailRung;
      }
    }
    return currentRung;
  }
  // Downgrading: L must fall below the current rung's floor by the margin.
  const floor = rungMinLevel(currentRung);
  return level <= floor - DETAIL_HYSTERESIS_LEVEL || targetRung === DETAIL_RUNG_GLYPH
    ? targetRung
    : currentRung;
}

/** Minimum raw L at which a rung becomes the target (its ladder floor). */
export function detailRungMinLevel(rung: DetailRung): number {
  switch (rung) {
    case DETAIL_RUNG_CLOSE: return CLOSE_RUNG_MIN_LEVEL;
    case DETAIL_RUNG_MID: return MID_RUNG_MIN_LEVEL;
    default: return 0;
  }
}

function rungMinLevel(rung: DetailRung): number {
  return detailRungMinLevel(rung);
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
  void level;
  return ceiling;
}

export function legStyleForDetail(level: number, ceiling: LegStyle): LegStyle {
  void level;
  return ceiling;
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
  void level;
  return ceiling;
}

// ── Effect spawn scales (one value per authored rung) ────────────────

function effectSpawnScale(config: EffectSpawnScaleConfig, level: number): number {
  switch (detailRungForLevel(level)) {
    case DETAIL_RUNG_CLOSE: return config.close;
    case DETAIL_RUNG_MID: return config.mid;
    case DETAIL_RUNG_FAR: return config.far;
    default: return 0;
  }
}

export function smokeSpawnScaleForDetail(level: number): number {
  return effectSpawnScale(SMOKE_SPAWN_SCALE, level);
}

export function explosionSpawnScaleForDetail(level: number): number {
  return effectSpawnScale(EXPLOSION_SPAWN_SCALE, level);
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
  return (
    rung * 64 +
    (turret < 0 ? 0 : turret) * 16 +
    (legs < 0 ? 0 : legs) * 4 +
    (shape < 0 ? 0 : shape) * 2
  );
}

/** Per-entity graphics config for a detail level. Unit LOD is geometry-only:
 *  authored rigs/styles stay intact and the geometry tier changes elsewhere. */
export function unitDetailGraphicsConfig(gfx: GraphicsConfig, level: number): GraphicsConfig {
  void level;
  return gfx;
}
