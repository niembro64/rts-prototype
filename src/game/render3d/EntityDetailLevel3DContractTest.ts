import {
  DETAIL_FEATURES,
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  beamStyleForDetail,
  detailLevelForDistance,
  featureMinLevel,
  featureVisibleAtDetail,
  geometryTierForDetail,
  legStyleForDetail,
  projectileStyleForDetail,
  turretStyleForDetail,
  unitShapeForDetail,
  type DetailFeature,
} from './EntityDetailLevel3D';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity detail level 3d contract] ${message}`);
  }
}

const TIER_RANK: Record<PrimitiveGeometryTier, number> = { far: 0, mid: 1, close: 2 };

/** Rough triangle weight per feature — a shed part removes its weight. Only the
 *  ORDER/monotonicity matters for the budget invariant, not the exact numbers. */
const FEATURE_TRIANGLE_WEIGHT: Record<DetailFeature, number> = {
  body: 120,
  healthBar: 4,
  turret: 60,
  barrelPrimary: 24,
  locomotion: 40,
  nameLabel: 0,
  projectileTrail: 12,
  turretHead: 30,
  shieldPanels: 40,
  beamGlow: 16,
  buildingDetail: 60,
  chassisDetail: 50,
  barrelSecondary: 24,
  projectileGlow: 10,
  locomotionAnimated: 20,
  muzzleDetail: 12,
};

function tierTriangleFactor(tier: PrimitiveGeometryTier): number {
  return tier === 'close' ? 1 : tier === 'mid' ? 0.6 : 0.35;
}

/** Estimated per-entity triangle load at a level: sum of visible feature
 *  weights, scaled by the geometry tier's segment factor. */
function estimatedTriangles(level: number): number {
  const tierFactor = tierTriangleFactor(geometryTierForDetail(level));
  let total = 0;
  for (const feature of DETAIL_FEATURES) {
    if (featureVisibleAtDetail(feature, level)) total += FEATURE_TRIANGLE_WEIGHT[feature];
  }
  return total * tierFactor;
}

function sweepLevels(): number[] {
  const levels: number[] = [];
  for (let i = 0; i <= 100; i++) levels.push(i / 100);
  return levels;
}

export function runEntityDetailLevel3DContractTest(): void {
  const switchDistance = 1000;

  // 1. Level is pinned at 1 close, 0 past the switch, monotonic non-increasing
  //    in distance (a shrinking entity never regains detail).
  assertContract(
    detailLevelForDistance(0, switchDistance) === DETAIL_LEVEL_FULL,
    'at zero distance the level is full fidelity',
  );
  assertContract(
    detailLevelForDistance(switchDistance, switchDistance) === DETAIL_LEVEL_GLYPH,
    'at the switch distance the level is the glyph (0)',
  );
  assertContract(
    detailLevelForDistance(switchDistance * 2, switchDistance) === DETAIL_LEVEL_GLYPH,
    'past the switch distance the level stays 0',
  );
  let prevLevel = Number.POSITIVE_INFINITY;
  for (let d = 0; d <= switchDistance * 1.2; d += switchDistance / 200) {
    const level = detailLevelForDistance(d, switchDistance);
    assertContract(level >= 0 && level <= 1, `level ${level} at distance ${d} is in [0,1]`);
    assertContract(
      level <= prevLevel + 1e-9,
      `level is non-increasing as distance grows (d=${d})`,
    );
    prevLevel = level;
  }

  // 2. Bigger entities keep detail longer: same distance, larger switch
  //    distance (larger radius) -> level is at least as high.
  const near = switchDistance * 0.7;
  assertContract(
    detailLevelForDistance(near, switchDistance * 2) >=
      detailLevelForDistance(near, switchDistance),
    'a larger entity holds a higher-or-equal detail level at the same distance',
  );

  // 3. The body survives to the glyph; every feature threshold is in [0,1].
  assertContract(featureMinLevel('body') === 0, 'the body is present at every level down to the glyph');
  for (const feature of DETAIL_FEATURES) {
    const min = featureMinLevel(feature);
    assertContract(min >= 0 && min <= 1, `feature ${feature} threshold ${min} is in [0,1]`);
  }

  // 4. As the level drops, the visible feature set only shrinks and the
  //    geometry tier only steps down (never up).
  let prevVisibleCount = Number.POSITIVE_INFINITY;
  let prevTier = TIER_RANK.close;
  for (let i = sweepLevels().length - 1; i >= 0; i--) {
    const level = sweepLevels()[i];
    let visible = 0;
    for (const feature of DETAIL_FEATURES) {
      if (featureVisibleAtDetail(feature, level)) visible++;
    }
    assertContract(
      visible <= prevVisibleCount,
      `visible feature count is non-increasing as level drops (level=${level})`,
    );
    prevVisibleCount = visible;
    const tier = TIER_RANK[geometryTierForDetail(level)];
    assertContract(tier <= prevTier, `geometry tier is non-increasing as level drops (level=${level})`);
    prevTier = tier;
  }

  // 5. Estimated per-entity triangle load falls monotonically with the level,
  //    so a screen that fills with shrinking (lower-level) entities stays
  //    within a bounded budget instead of growing without limit.
  let prevTriangles = Number.NEGATIVE_INFINITY;
  const ascending = sweepLevels();
  for (const level of ascending) {
    const triangles = estimatedTriangles(level);
    assertContract(
      triangles >= prevTriangles - 1e-9,
      `triangle estimate is non-decreasing with level (level=${level})`,
    );
    prevTriangles = triangles;
  }
  assertContract(
    estimatedTriangles(DETAIL_LEVEL_GLYPH) < estimatedTriangles(DETAIL_LEVEL_FULL),
    'the glyph level costs strictly fewer triangles than full fidelity',
  );

  // 6. Style ladders never exceed the user's ceiling and only scale down.
  assertContract(turretStyleForDetail(1, 'simple') === 'simple', 'turret detail respects a simple ceiling');
  assertContract(turretStyleForDetail(1, 'full') === 'full', 'turret is full at full detail under a full ceiling');
  assertContract(
    turretStyleForDetail(featureMinLevel('turret') - 0.01, 'full') === 'none',
    'turret sheds below its threshold',
  );
  assertContract(legStyleForDetail(1, 'none') === 'none', 'a none-legs ceiling stays none');
  assertContract(
    legStyleForDetail(featureMinLevel('locomotion') - 0.01, 'full') === 'none',
    'locomotion sheds below its threshold',
  );
  assertContract(
    projectileStyleForDetail(0, 'full') === 'dot',
    'a glyph-level projectile collapses to a dot',
  );
  assertContract(
    projectileStyleForDetail(1, 'trail') === 'trail',
    'projectile detail respects a trail ceiling',
  );
  assertContract(beamStyleForDetail(1, 'standard') === 'standard', 'beam detail respects a standard ceiling');
  assertContract(unitShapeForDetail(1, 'full') === 'full', 'unit shape is full at full detail');
  assertContract(
    unitShapeForDetail(featureMinLevel('chassisDetail') - 0.01, 'full') === 'circles',
    'unit shape collapses to circles once chassis detail sheds',
  );
}
