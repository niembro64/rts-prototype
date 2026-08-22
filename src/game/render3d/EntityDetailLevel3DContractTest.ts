import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  GLYPH_MIN_SCREEN_RADIUS_PX,
  GLYPH_PLAYER_RING_FRACTION,
  GLYPH_TEAM_RING_FRACTION,
  GLYPH_WHITE_CORE_FRACTION,
  glyphMinScreenRadiusPxForViewport,
  ICON_FADE_START_SCREEN_RADIUS_PX,
  beamStyleForDetail,
  detailLevelForRung,
  detailLevelForViewPosition,
  detailLevelForScreenRadius,
  detailRungForLevel,
  detailRungForViewPosition,
  detailRungMinLevel,
  detailScreenRadiusPx,
  featureVisibleAtDetail,
  geometryTierForDetail,
  legStyleForDetail,
  ladderEquivalentScreenRadiusPx,
  lodProxyFadeAlphaForScreenRadius,
  projectileDetailLadder,
  projectileStyleForDetail,
  THRESHOLD_HIGH_TO_MED_PX,
  THRESHOLD_LOW_TO_OFF_PX,
  THRESHOLD_MED_TO_LOW_PX,
  smokeSpawnScaleForDetail,
  turretStyleForDetail,
  unitDetailBand,
  unitDetailGraphicsConfig,
  unitShapeForDetail,
  visualFeatureVisibleAtDetail,
} from './EntityDetailLevel3D';
import { getLodMode, setLodMode } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { DetailFeature, DetailRung } from './EntityDetailLevel3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity detail level 3d contract] ${message}`);
  }
}

const FULL_GFX: GraphicsConfig = {
  hudFrameStride: 1,
  effectFrameStride: 1,
  terrainTileFrameStride: 1,
  terrainTileSideWalls: true,
  waterSubdivisions: 8,
  waterFrameStride: 1,
  waterWaveAmplitude: 1,
  unitShape: 'full',
  legs: 'full',
  chassisDetail: true,
  paletteShading: true,
  turretStyle: 'full',
  forceTurretStyle: 'full',
  barrelSpin: true,
  beamStyle: 'complex',
  beamGlow: true,
  antialias: true,
  burnMarkDensity: 1,
  groundPrintDensity: 1,
  projectileStyle: 'full',
};

const DETAIL_FEATURES: readonly DetailFeature[] = [
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
  'treadCleats',
  'muzzleDetail',
];

const ALL_RUNGS: readonly DetailRung[] = [
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_MID,
  DETAIL_RUNG_CLOSE,
];

export function runEntityDetailLevel3DContractTest(): void {
  const previousLodMode = getLodMode();
  try {
    const view = {
      viewportHeightPx: 900,
      cameraX: 0,
      cameraY: 0,
      cameraZ: 0,
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
      fovYRad: Math.PI / 4,
      aspect: 1,
    };
    setLodMode('high');
    assertContract(
      detailLevelForViewPosition(view, 0, -10, 0) === DETAIL_LEVEL_FULL,
      'HIGH freezes bare-position effects at the close rung',
    );
    // The glyph floor holds in every manual mode: a pin chooses the geometry of
    // a DRAWN model, so it must never replace a readable strategic icon with a
    // sub-pixel model. This is what makes HIGH usable at a strategic zoom.
    for (const mode of ['high', 'medium', 'low'] as const) {
      setLodMode(mode);
      assertContract(
        detailRungForViewPosition(view, 0, -10000, 0, 1) === DETAIL_RUNG_GLYPH,
        `${mode} kept a sub-pixel model instead of the glyph`,
      );
      assertContract(
        detailRungForViewPosition(view, 0, -10, 0, 1000) !== DETAIL_RUNG_GLYPH,
        `${mode} glyphed an entity that fills the screen`,
      );
    }
    setLodMode('medium');
    assertContract(
      detailLevelForViewPosition(view, 0, -10, 0) === detailLevelForRung(DETAIL_RUNG_MID),
      'MED freezes bare-position effects at the medium rung',
    );
    setLodMode('low');
    assertContract(
      detailLevelForViewPosition(view, 0, -10, 0) === detailLevelForRung(DETAIL_RUNG_FAR),
      'LOW freezes bare-position effects at the far rung',
    );
    setLodMode('off');
    assertContract(
      detailLevelForViewPosition(view, 0, -10, 0) === DETAIL_LEVEL_GLYPH &&
        detailRungForViewPosition(view, 0, -10, 0) === DETAIL_RUNG_GLYPH,
      'OFF freezes world visuals at the glyph/removal end state',
    );
    setLodMode('auto');
    assertContract(
      detailRungForViewPosition(view, 0, -10000, 0, 1) === DETAIL_RUNG_GLYPH,
      'AUTO removes a small world prop at long projected distance',
    );
    assertContract(
      detailRungForViewPosition(view, 0, -10000, 0, 1000) === DETAIL_RUNG_CLOSE,
      'AUTO retains more detail for a larger prop at the same distance',
    );
    // A pin replaces the AUTO ladder for everything still drawn as a model.
    setLodMode('high');
    assertContract(
      detailRungForViewPosition(view, 0, -10000, 0, 200) === DETAIL_RUNG_CLOSE,
      'HIGH did not lift a mid-coverage prop to the close rung',
    );
    setLodMode('low');
    assertContract(
      detailRungForViewPosition(view, 0, -10000, 0, 1000) === DETAIL_RUNG_FAR,
      'LOW did not drop a close-coverage prop to the far rung',
    );
  } finally {
    setLodMode(previousLodMode);
  }

  // ── Screen-coverage level ─────────────────────────────────────────
  const fov = Math.PI / 4;
  assertContract(
    detailScreenRadiusPx(30, 100, fov) > detailScreenRadiusPx(30, 200, fov),
    'projected radius shrinks with distance',
  );
  assertContract(
    detailScreenRadiusPx(60, 100, fov) > detailScreenRadiusPx(30, 100, fov),
    'projected radius grows with world radius',
  );
  assertContract(
    detailLevelForScreenRadius(0) === DETAIL_LEVEL_GLYPH,
    'zero screen coverage is the glyph end',
  );
  assertContract(
    detailLevelForScreenRadius(10000) === DETAIL_LEVEL_FULL,
    'huge screen coverage is the full end',
  );
  const midLevel = detailLevelForScreenRadius(15);
  assertContract(
    midLevel > DETAIL_LEVEL_GLYPH && midLevel <= DETAIL_LEVEL_FULL,
    'intermediate coverage lands strictly inside the ramp',
  );

  // ── BAR-style icon cross-fade band ────────────────────────────────
  assertContract(
    Math.abs(
      detailLevelForScreenRadius(ICON_FADE_START_SCREEN_RADIUS_PX) -
        detailRungMinLevel(DETAIL_RUNG_CLOSE),
    ) <= 1e-6,
    'icon fade starts exactly at the close→mid rung boundary (HIGH→MED)',
  );
  assertContract(
    lodProxyFadeAlphaForScreenRadius(ICON_FADE_START_SCREEN_RADIUS_PX) === 0 &&
      lodProxyFadeAlphaForScreenRadius(10000) === 0,
    'the icon remains fully transparent throughout HIGH',
  );
  assertContract(
    lodProxyFadeAlphaForScreenRadius(ICON_FADE_START_SCREEN_RADIUS_PX - 0.01) < 0.01,
    'the icon fade begins smoothly from alpha 0 (no pop-in)',
  );
  // Midway between the CONFIGURED glyph radius and the fade onset — a
  // hardcoded glyph value here breaks the moment lod.json is tuned.
  const bandPx = (ICON_FADE_START_SCREEN_RADIUS_PX + THRESHOLD_LOW_TO_OFF_PX) / 2;
  const bandAlpha = lodProxyFadeAlphaForScreenRadius(bandPx);
  assertContract(
    bandPx >= ICON_FADE_START_SCREEN_RADIUS_PX ||
      (bandAlpha > 0 && bandAlpha < 1),
    'inside the band the icon alpha sits strictly between 0 and 1',
  );
  assertContract(
    lodProxyFadeAlphaForScreenRadius(0) === 1,
    'at/below the glyph radius the icon is fully opaque',
  );
  let previousFade = -1;
  for (let px = ICON_FADE_START_SCREEN_RADIUS_PX + 1; px >= 0; px -= 0.5) {
    const fade = lodProxyFadeAlphaForScreenRadius(px);
    assertContract(fade >= previousFade, 'icon fade alpha is monotonic as coverage shrinks');
    previousFade = fade;
  }

  // ── Rung ladder + representative-level round trip ─────────────────
  assertContract(
    detailRungForLevel(DETAIL_LEVEL_FULL) === DETAIL_RUNG_CLOSE,
    'L=1 is the close rung',
  );
  assertContract(
    detailRungForLevel(DETAIL_LEVEL_GLYPH) === DETAIL_RUNG_GLYPH,
    'L=0 is the glyph rung',
  );
  for (const rung of ALL_RUNGS) {
    assertContract(
      detailRungForLevel(detailLevelForRung(rung)) === rung,
      `detailLevelForRung round-trips rung ${rung}`,
    );
  }
  assertContract(
    detailRungForLevel(0.001) === DETAIL_RUNG_FAR,
    'barely-above-glyph L is the far rung',
  );

  // ── The ladder is stateless ───────────────────────────────────────
  // There is no deadband and no latch: the rung is a pure function of L, so
  // the same coverage always gives the same answer however the entity got
  // there. A regression that reintroduces per-entity memory shows up here as
  // a rung that depends on call order.
  const midFloor = detailRungMinLevel(DETAIL_RUNG_MID);
  const closeFloor = detailRungMinLevel(DETAIL_RUNG_CLOSE);
  assertContract(
    detailRungForLevel(midFloor) === DETAIL_RUNG_MID &&
      detailRungForLevel(closeFloor) === DETAIL_RUNG_CLOSE,
    'sitting exactly on a rung floor resolves to that rung',
  );
  const EPSILON_LEVEL = 1e-4;
  assertContract(
    detailRungForLevel(midFloor - EPSILON_LEVEL) === DETAIL_RUNG_FAR &&
      detailRungForLevel(closeFloor - EPSILON_LEVEL) === DETAIL_RUNG_MID,
    'a hair below a floor is the rung below — no deadband holds the higher one',
  );
  for (const level of [DETAIL_LEVEL_GLYPH, midFloor, closeFloor, DETAIL_LEVEL_FULL]) {
    const first = detailRungForLevel(level);
    assertContract(
      detailRungForLevel(level) === first && detailRungForLevel(level) === first,
      'repeat calls at one level disagree — the ladder kept state',
    );
  }

  // ── Projectile per-class px ladders ────────────────────────────────
  // Traveling shots have their own authored ladders (plasma/rocket/missile),
  // remapped boundary-to-boundary onto the entity ladder: sitting on a class
  // boundary must behave exactly like sitting on the matching entity
  // boundary, and rays must NOT have a ladder (they keep the beam floor).
  for (const shotType of ['plasma', 'rocket', 'missile'] as const) {
    const ladder = projectileDetailLadder(shotType);
    assertContract(ladder !== null, `${shotType} shots have an authored px ladder`);
    assertContract(
      ladder.highToMedPx > ladder.medToLowPx &&
        ladder.medToLowPx > ladder.lowToOffPx &&
        ladder.lowToOffPx > 0,
      `${shotType} ladder boundaries are strictly ordered`,
    );
    assertContract(
      ladderEquivalentScreenRadiusPx(ladder.highToMedPx, ladder) === THRESHOLD_HIGH_TO_MED_PX &&
        ladderEquivalentScreenRadiusPx(ladder.medToLowPx, ladder) === THRESHOLD_MED_TO_LOW_PX &&
        ladderEquivalentScreenRadiusPx(ladder.lowToOffPx, ladder) === THRESHOLD_LOW_TO_OFF_PX,
      `${shotType} ladder boundaries land exactly on the entity boundaries`,
    );
    assertContract(
      detailRungForLevel(detailLevelForScreenRadius(
        ladderEquivalentScreenRadiusPx(ladder.highToMedPx * 4, ladder))) === DETAIL_RUNG_CLOSE &&
        detailRungForLevel(detailLevelForScreenRadius(
          ladderEquivalentScreenRadiusPx(ladder.lowToOffPx / 2, ladder))) === DETAIL_RUNG_GLYPH,
      `${shotType} shots are CLOSE far above the ladder and GLYPH below its OFF boundary`,
    );
    let previousPx = 0;
    for (let px = 0; px <= ladder.highToMedPx * 2; px += ladder.lowToOffPx / 8) {
      const mapped = ladderEquivalentScreenRadiusPx(px, ladder);
      assertContract(
        mapped >= previousPx,
        `${shotType} ladder remap is monotonic in projected size`,
      );
      previousPx = mapped;
    }
  }
  assertContract(
    projectileDetailLadder('beam') === null &&
      projectileDetailLadder('laser') === null &&
      projectileDetailLadder('shield') === null,
    'rays and shields have no projectile ladder — beams keep the radius floor',
  );

  // ── Strategic glyph: bands and floor ──────────────────────────────
  assertContract(
    GLYPH_WHITE_CORE_FRACTION > 0 &&
      GLYPH_WHITE_CORE_FRACTION < GLYPH_TEAM_RING_FRACTION &&
      GLYPH_TEAM_RING_FRACTION < GLYPH_PLAYER_RING_FRACTION &&
      GLYPH_PLAYER_RING_FRACTION < 1,
    'every glyph must show all four colors: white core, team, player, black outline',
  );
  assertContract(
    GLYPH_MIN_SCREEN_RADIUS_PX === THRESHOLD_LOW_TO_OFF_PX,
    'the glyph floor is the size the glyph had at the OFF flip',
  );
  assertContract(
    glyphMinScreenRadiusPxForViewport(2160) === GLYPH_MIN_SCREEN_RADIUS_PX * 2 &&
      glyphMinScreenRadiusPxForViewport(0) === GLYPH_MIN_SCREEN_RADIUS_PX,
    'the glyph floor scales from the reference viewport to the live one',
  );

  // ── Features: monotonic ladder, all-on at full, all-off at glyph ──
  for (const feature of DETAIL_FEATURES) {
    assertContract(featureVisibleAtDetail(feature, DETAIL_LEVEL_FULL), `${feature} is visible at full`);
    assertContract(!featureVisibleAtDetail(feature, DETAIL_LEVEL_GLYPH), `${feature} is hidden at glyph`);
    let wasVisible = false;
    for (const rung of ALL_RUNGS) {
      const visible = featureVisibleAtDetail(feature, detailLevelForRung(rung));
      assertContract(
        !wasVisible || visible,
        `${feature} never disappears as detail increases (rung ${rung})`,
      );
      wasVisible = visible;
    }
  }
  assertContract(
    featureVisibleAtDetail('treadCleats', DETAIL_LEVEL_FULL) &&
      featureVisibleAtDetail(
        'treadCleats',
        detailLevelForRung(DETAIL_RUNG_MID),
      ) &&
      !featureVisibleAtDetail(
        'treadCleats',
        detailLevelForRung(DETAIL_RUNG_FAR),
      ),
    'tread cleats are present at HIGH/MED and absent at LOW/OFF',
  );

  assertContract(
    visualFeatureVisibleAtDetail('building', 'typeDetails', DETAIL_LEVEL_FULL),
    'visual feature helper returns true at full',
  );
  assertContract(
    !visualFeatureVisibleAtDetail('building', 'typeDetails', DETAIL_LEVEL_GLYPH),
    'visual feature helper returns false at glyph',
  );
  assertContract(
    visualFeatureVisibleAtDetail('building', 'largeAnimation', detailLevelForRung(DETAIL_RUNG_FAR)),
    'far-rung buildings keep their large animation rigs',
  );

  // ── Geometry tier ladder ──────────────────────────────────────────
  assertContract(geometryTierForDetail(DETAIL_LEVEL_FULL) === 'close', 'close rung uses close geometry');
  assertContract(
    geometryTierForDetail(detailLevelForRung(DETAIL_RUNG_MID)) === 'mid',
    'mid rung uses mid geometry',
  );
  assertContract(
    geometryTierForDetail(detailLevelForRung(DETAIL_RUNG_FAR)) === 'far',
    'far rung uses far geometry',
  );
  assertContract(geometryTierForDetail(DETAIL_LEVEL_GLYPH) === 'far', 'glyph rung maps to far geometry');

  // ── Style ladders ─────────────────────────────────────────────────
  assertContract(turretStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps turret ceiling');
  assertContract(
    turretStyleForDetail(detailLevelForRung(DETAIL_RUNG_FAR), 'full') === 'full',
    'far rung keeps the turret (cluster collapse is the barrelSecondary feature)',
  );
  assertContract(turretStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'full', 'unit low geometry keeps turrets');
  assertContract(legStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps leg ceiling');
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_MID), 'full') === 'full',
    'mid rung keeps the full authored leg rig',
  );
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_FAR), 'full') === 'full',
    'far rung keeps the full authored leg rig',
  );
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_MID), 'simple') === 'simple',
    'leg ladder never raises the user ceiling',
  );
  assertContract(legStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'full', 'unit low geometry keeps legs');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps projectile ceiling');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'dot', 'glyph uses projectile dots');
  assertContract(beamStyleForDetail(DETAIL_LEVEL_FULL, 'complex') === 'complex', 'full keeps beam ceiling');
  assertContract(
    beamStyleForDetail(detailLevelForRung(DETAIL_RUNG_FAR), 'complex') === 'standard',
    'far rung caps beams at standard',
  );
  assertContract(beamStyleForDetail(DETAIL_LEVEL_GLYPH, 'complex') === 'simple', 'glyph uses simple beams');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps unit shape ceiling');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'full', 'unit low geometry keeps authored bodies');

  // ── Smoke spawn scale: one value per H/M/L rung ────────────────────
  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'full smoke is full scale');
  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) === 0, 'glyph smoke is suppressed');
  const lowSmokeScale = smokeSpawnScaleForDetail(detailLevelForRung(DETAIL_RUNG_FAR));
  const mediumSmokeScale = smokeSpawnScaleForDetail(detailLevelForRung(DETAIL_RUNG_MID));
  assertContract(
    lowSmokeScale > 0 && mediumSmokeScale >= lowSmokeScale,
    'smoke has ordered Low/Medium spawn scales',
  );
  assertContract(
    smokeSpawnScaleForDetail(0.001) === lowSmokeScale,
    'smoke output is constant throughout the Low rung',
  );
  assertContract(
    smokeSpawnScaleForDetail(detailRungMinLevel(DETAIL_RUNG_CLOSE) - 0.001) ===
      mediumSmokeScale,
    'smoke output is constant throughout the Medium rung',
  );

  // ── Rebuild band + graphics ceiling ───────────────────────────────
  const bands = new Set<number>();
  for (const rung of ALL_RUNGS) {
    bands.add(unitDetailBand(detailLevelForRung(rung), FULL_GFX));
  }
  assertContract(bands.size === ALL_RUNGS.length, 'each rung produces a distinct rebuild band');

  assertContract(
    unitDetailGraphicsConfig(FULL_GFX, DETAIL_LEVEL_FULL) === FULL_GFX,
    'full detail returns the existing graphics config object',
  );
  for (const rung of ALL_RUNGS) {
    const resolved = unitDetailGraphicsConfig(FULL_GFX, detailLevelForRung(rung));
    assertContract(resolved === FULL_GFX, `rung ${rung} preserves the authored unit rig config`);
  }
}
