import {
  DETAIL_HYSTERESIS_LEVEL,
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  ICON_FADE_MIN_ALPHA,
  ICON_FADE_START_SCREEN_RADIUS_PX,
  PLASMA_DETAIL_HYSTERESIS_LEVEL,
  PLASMA_HIGH_RUNG_MIN_LEVEL,
  PLASMA_LOD_REFERENCE_TAIL_LENGTH_WORLD,
  PLASMA_MEDIUM_RUNG_MIN_LEVEL,
  beamStyleForDetail,
  debrisSpawnScaleForDetail,
  detailLevelForRung,
  detailLevelForRadiusDistance,
  detailLevelForViewPosition,
  detailLevelForScreenRadius,
  detailRungForLevel,
  detailRungMinLevel,
  detailRungWithHysteresis,
  detailScreenRadiusPx,
  explosionSpawnScaleForDetail,
  featureVisibleAtDetail,
  geometryTierForDetail,
  legStyleForDetail,
  lodProxyFadeAlphaForScreenRadius,
  plasmaDetailRungForLevel,
  plasmaDetailRungWithHysteresis,
  plasmaDetailRadiusForTailLength,
  plasmaLodDistanceScaleForTailLength,
  projectileStyleForDetail,
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
  treadsAnimated: true,
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
  fireExplosionStyle: 'inferno',
  materialExplosionStyle: 'obliterate',
  materialExplosionPieceBudget: 1,
  materialExplosionPhysicsFramesSkip: 1,
  deathExplosionStyle: 'obliterate',
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
    };
    setLodMode('high');
    assertContract(
      detailLevelForViewPosition(view, 0, -10000, 0) === DETAIL_LEVEL_FULL,
      'HIGH freezes bare-position effects at the close rung',
    );
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
    lodProxyFadeAlphaForScreenRadius(ICON_FADE_START_SCREEN_RADIUS_PX) === 0 &&
      lodProxyFadeAlphaForScreenRadius(10000) === 0,
    'no icon overlay at/above the fade-start screen radius',
  );
  const bandPx = (ICON_FADE_START_SCREEN_RADIUS_PX + 4) / 2;
  const bandAlpha = lodProxyFadeAlphaForScreenRadius(bandPx);
  assertContract(
    bandPx >= ICON_FADE_START_SCREEN_RADIUS_PX ||
      (bandAlpha >= ICON_FADE_MIN_ALPHA && bandAlpha < 1),
    'inside the band the icon alpha sits between the pop-in floor and 1',
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

  // ── Hysteresis ────────────────────────────────────────────────────
  const midFloor = detailLevelForRung(DETAIL_RUNG_MID);
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_FAR, midFloor + DETAIL_HYSTERESIS_LEVEL / 2) ===
      DETAIL_RUNG_FAR,
    'upgrade inside the hysteresis margin keeps the latched rung',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_FAR, midFloor + DETAIL_HYSTERESIS_LEVEL * 1.5) ===
      DETAIL_RUNG_MID,
    'upgrade past the hysteresis margin switches rungs',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_MID, midFloor - DETAIL_HYSTERESIS_LEVEL / 2) ===
      DETAIL_RUNG_MID,
    'downgrade inside the hysteresis margin keeps the latched rung',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_MID, midFloor - DETAIL_HYSTERESIS_LEVEL * 1.5) ===
      DETAIL_RUNG_FAR,
    'downgrade past the hysteresis margin switches rungs',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_CLOSE, DETAIL_LEVEL_GLYPH) === DETAIL_RUNG_GLYPH,
    'the glyph flip is never blocked by hysteresis',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_MID, midFloor) === DETAIL_RUNG_MID,
    'sitting exactly on a rung floor never oscillates',
  );
  // Multi-rung jumps (camera cuts) must land on the highest rung whose
  // floor clears the margin — never stay stuck rungs below the target.
  const closeFloor = detailRungMinLevel(DETAIL_RUNG_CLOSE);
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_FAR, closeFloor + DETAIL_HYSTERESIS_LEVEL / 2) ===
      DETAIL_RUNG_MID,
    'a far-latched entity inside the close hysteresis band steps to mid, not stays far',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_GLYPH, midFloor + DETAIL_HYSTERESIS_LEVEL / 2) ===
      DETAIL_RUNG_FAR,
    'a glyph-latched entity inside the mid hysteresis band steps to far, not stays glyph',
  );
  assertContract(
    detailRungWithHysteresis(DETAIL_RUNG_GLYPH, DETAIL_LEVEL_FULL) === DETAIL_RUNG_CLOSE,
    'a glyph-latched entity at full level jumps straight to close',
  );

  // Plasma keeps its richer meshes farther out than the shared entity ladder.
  assertContract(
    PLASMA_HIGH_RUNG_MIN_LEVEL < detailRungMinLevel(DETAIL_RUNG_CLOSE),
    'plasma high resolution extends beyond the general close rung',
  );
  assertContract(
    PLASMA_MEDIUM_RUNG_MIN_LEVEL < detailRungMinLevel(DETAIL_RUNG_MID) / 2,
    'plasma medium resolution extends substantially beyond the general mid rung',
  );
  assertContract(
    plasmaDetailRungForLevel(0) === DETAIL_RUNG_FAR,
    'zero-detail plasma still resolves to its real low-triangle mesh',
  );
  assertContract(
    plasmaDetailRungWithHysteresis(
      DETAIL_RUNG_CLOSE,
      PLASMA_HIGH_RUNG_MIN_LEVEL - PLASMA_DETAIL_HYSTERESIS_LEVEL / 2,
    ) === DETAIL_RUNG_CLOSE,
    'plasma high remains latched inside its downgrade margin',
  );
  assertContract(
    plasmaDetailRungWithHysteresis(
      DETAIL_RUNG_MID,
      PLASMA_MEDIUM_RUNG_MIN_LEVEL - PLASMA_DETAIL_HYSTERESIS_LEVEL * 1.5,
    ) === DETAIL_RUNG_FAR,
    'plasma medium downgrades after clearing its farther low threshold',
  );
  assertContract(
    plasmaDetailRungWithHysteresis(
      DETAIL_RUNG_FAR,
      PLASMA_MEDIUM_RUNG_MIN_LEVEL + PLASMA_DETAIL_HYSTERESIS_LEVEL * 1.5,
    ) === DETAIL_RUNG_MID,
    'plasma low upgrades only after clearing the medium margin',
  );

  // Plasma size scaling follows projected angular size: screen size is
  // proportional to world size / distance, so a K-times-longer tail reaches
  // the same LOD threshold at K times the camera distance.
  assertContract(
    plasmaLodDistanceScaleForTailLength(PLASMA_LOD_REFERENCE_TAIL_LENGTH_WORLD) === 1,
    'smallest plasma tail retains the existing transition distances exactly',
  );
  assertContract(
    plasmaLodDistanceScaleForTailLength(PLASMA_LOD_REFERENCE_TAIL_LENGTH_WORLD * 5) === 5,
    'five-times-longer plasma holds each geometry tier five times farther away',
  );
  const referenceDistance = 900;
  const largeScale = 5;
  const referencePlasmaLevel = detailLevelForRadiusDistance(
    plasmaDetailRadiusForTailLength(PLASMA_LOD_REFERENCE_TAIL_LENGTH_WORLD),
    referenceDistance,
    fov,
  );
  const largePlasmaLevel = detailLevelForRadiusDistance(
    plasmaDetailRadiusForTailLength(
      PLASMA_LOD_REFERENCE_TAIL_LENGTH_WORLD * largeScale,
    ),
    referenceDistance * largeScale,
    fov,
  );
  assertContract(
    Math.abs(referencePlasmaLevel - largePlasmaLevel) < 1e-12,
    'equal angular tail sizes resolve the same continuous plasma detail level',
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

  // ── Effect spawn scales: continuous, monotonic ────────────────────
  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'full smoke is full scale');
  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) === 0, 'glyph smoke is suppressed');
  assertContract(explosionSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'full explosions are full scale');
  assertContract(explosionSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) < 1, 'glyph explosions are reduced');
  assertContract(explosionSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) > 0, 'glyph explosions keep a floor flash');
  assertContract(debrisSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'full debris is full scale');
  assertContract(debrisSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) === 0, 'glyph debris is suppressed');
  for (const scale of [smokeSpawnScaleForDetail, explosionSpawnScaleForDetail, debrisSpawnScaleForDetail]) {
    let previous = -1;
    for (let level = 0; level <= 1.0001; level += 0.1) {
      const value = scale(Math.min(1, level));
      assertContract(value >= previous, 'effect spawn scales are monotonic in L');
      previous = value;
    }
  }

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
