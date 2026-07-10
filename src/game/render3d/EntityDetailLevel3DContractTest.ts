import {
  DETAIL_HYSTERESIS_LEVEL,
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  beamStyleForDetail,
  debrisSpawnScaleForDetail,
  detailLevelForRung,
  detailLevelForScreenRadius,
  detailRungForLevel,
  detailRungMinLevel,
  detailRungWithHysteresis,
  detailScreenRadiusPx,
  explosionSpawnScaleForDetail,
  featureVisibleAtDetail,
  geometryTierForDetail,
  legStyleForDetail,
  projectileStyleForDetail,
  smokeSpawnScaleForDetail,
  turretStyleForDetail,
  unitDetailBand,
  unitDetailGraphicsConfig,
  unitShapeForDetail,
  visualFeatureVisibleAtDetail,
} from './EntityDetailLevel3D';
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
  assertContract(turretStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'none', 'glyph removes turrets');
  assertContract(legStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps leg ceiling');
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_MID), 'full') === 'animated',
    'mid rung caps legs at animated (sheds joint spheres)',
  );
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_FAR), 'full') === 'simple',
    'far rung caps legs at simple',
  );
  assertContract(
    legStyleForDetail(detailLevelForRung(DETAIL_RUNG_MID), 'simple') === 'simple',
    'leg ladder never raises the user ceiling',
  );
  assertContract(legStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'none', 'glyph removes legs');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps projectile ceiling');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'dot', 'glyph uses projectile dots');
  assertContract(beamStyleForDetail(DETAIL_LEVEL_FULL, 'complex') === 'complex', 'full keeps beam ceiling');
  assertContract(
    beamStyleForDetail(detailLevelForRung(DETAIL_RUNG_FAR), 'complex') === 'standard',
    'far rung caps beams at standard',
  );
  assertContract(beamStyleForDetail(DETAIL_LEVEL_GLYPH, 'complex') === 'simple', 'glyph uses simple beams');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'full keeps unit shape ceiling');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'circles', 'glyph uses circle bodies');

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
  const midGfx = unitDetailGraphicsConfig(FULL_GFX, detailLevelForRung(DETAIL_RUNG_MID));
  assertContract(midGfx.legs === 'animated', 'mid unit config caps legs at animated');
  assertContract(midGfx.treadsAnimated, 'mid unit config keeps tread animation');
  assertContract(midGfx.chassisDetail, 'mid unit config keeps chassis detail');
  const farGfx = unitDetailGraphicsConfig(FULL_GFX, detailLevelForRung(DETAIL_RUNG_FAR));
  assertContract(farGfx.legs === 'simple', 'far unit config caps legs at simple');
  assertContract(!farGfx.treadsAnimated, 'far unit config freezes treads to the static slab');
  assertContract(!farGfx.chassisDetail, 'far unit config disables chassis detail');
  const lowGfx = unitDetailGraphicsConfig(FULL_GFX, DETAIL_LEVEL_GLYPH);
  assertContract(lowGfx !== FULL_GFX, 'glyph returns a reduced graphics config');
  assertContract(lowGfx.turretStyle === 'none', 'glyph unit config removes turrets');
  assertContract(lowGfx.legs === 'none', 'glyph unit config removes legs');
  assertContract(lowGfx.unitShape === 'circles', 'glyph unit config uses circles');
  assertContract(!lowGfx.chassisDetail, 'glyph unit config disables chassis detail');
  assertContract(!lowGfx.treadsAnimated, 'glyph unit config disables tread animation');
}
