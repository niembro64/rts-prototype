import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  beamStyleForDetail,
  debrisSpawnScaleForDetail,
  detailLevelForDistance,
  explosionSpawnScaleForDetail,
  featureVisibleAtDetail,
  geometryTierForDetail,
  legStyleForDetail,
  projectileStyleForDetail,
  smokeSpawnScaleForDetail,
  turretStyleForDetail,
  unitDetailGraphicsConfig,
  unitShapeForDetail,
  visualFeatureVisibleAtDetail,
} from './EntityDetailLevel3D';
import type { GraphicsConfig } from '@/types/graphics';
import type { DetailFeature } from './EntityDetailLevel3D';

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

export function runEntityDetailLevel3DContractTest(): void {
  const switchDistance = 1000;

  assertContract(
    detailLevelForDistance(0, switchDistance) === DETAIL_LEVEL_FULL,
    'zero distance is HIGH',
  );
  assertContract(
    detailLevelForDistance(switchDistance - 0.001, switchDistance) === DETAIL_LEVEL_FULL,
    'inside the switch distance is HIGH',
  );
  assertContract(
    detailLevelForDistance(switchDistance, switchDistance) === DETAIL_LEVEL_GLYPH,
    'at the switch distance is LOW',
  );
  assertContract(
    detailLevelForDistance(switchDistance + 0.001, switchDistance) === DETAIL_LEVEL_GLYPH,
    'outside the switch distance is LOW',
  );

  for (const feature of DETAIL_FEATURES) {
    assertContract(featureVisibleAtDetail(feature, DETAIL_LEVEL_FULL), `${feature} is visible at HIGH`);
    assertContract(!featureVisibleAtDetail(feature, DETAIL_LEVEL_GLYPH), `${feature} is hidden at LOW`);
  }

  assertContract(
    visualFeatureVisibleAtDetail('building', 'typeDetails', DETAIL_LEVEL_FULL),
    'visual feature helper returns true at HIGH',
  );
  assertContract(
    !visualFeatureVisibleAtDetail('building', 'typeDetails', DETAIL_LEVEL_GLYPH),
    'visual feature helper returns false at LOW',
  );

  assertContract(geometryTierForDetail(DETAIL_LEVEL_FULL) === 'close', 'HIGH uses close geometry');
  assertContract(geometryTierForDetail(DETAIL_LEVEL_GLYPH) === 'far', 'LOW uses far geometry');
  assertContract(turretStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'HIGH keeps turret ceiling');
  assertContract(turretStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'none', 'LOW removes turrets');
  assertContract(legStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'HIGH keeps leg ceiling');
  assertContract(legStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'none', 'LOW removes legs');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'HIGH keeps projectile ceiling');
  assertContract(projectileStyleForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'dot', 'LOW uses projectile dots');
  assertContract(beamStyleForDetail(DETAIL_LEVEL_FULL, 'complex') === 'complex', 'HIGH keeps beam ceiling');
  assertContract(beamStyleForDetail(DETAIL_LEVEL_GLYPH, 'complex') === 'simple', 'LOW uses simple beams');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_FULL, 'full') === 'full', 'HIGH keeps unit shape ceiling');
  assertContract(unitShapeForDetail(DETAIL_LEVEL_GLYPH, 'full') === 'circles', 'LOW uses circle bodies');

  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'HIGH smoke is full scale');
  assertContract(smokeSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) === 0, 'LOW smoke is suppressed');
  assertContract(explosionSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'HIGH explosions are full scale');
  assertContract(explosionSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) < 1, 'LOW explosions are reduced');
  assertContract(debrisSpawnScaleForDetail(DETAIL_LEVEL_FULL) === 1, 'HIGH debris is full scale');
  assertContract(debrisSpawnScaleForDetail(DETAIL_LEVEL_GLYPH) === 0, 'LOW debris is suppressed');

  assertContract(unitDetailGraphicsConfig(FULL_GFX, DETAIL_LEVEL_FULL) === FULL_GFX, 'HIGH returns the existing graphics config');
  const lowGfx = unitDetailGraphicsConfig(FULL_GFX, DETAIL_LEVEL_GLYPH);
  assertContract(lowGfx !== FULL_GFX, 'LOW returns a reduced graphics config');
  assertContract(lowGfx.turretStyle === 'none', 'LOW unit config removes turrets');
  assertContract(lowGfx.legs === 'none', 'LOW unit config removes legs');
  assertContract(lowGfx.unitShape === 'circles', 'LOW unit config uses circles');
  assertContract(!lowGfx.chassisDetail, 'LOW unit config disables chassis detail');
  assertContract(!lowGfx.treadsAnimated, 'LOW unit config disables tread animation');
}
