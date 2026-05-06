import {
  TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
  TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_D_TERRAIN,
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_RIDGE_CONFIG,
  TERRAIN_RIPPLE_CONFIG,
  TILE_FLOOR_Y,
} from './terrainConfig';
import { clamp01, smootherstep } from './terrainMath';
import { depositOverride } from './terrainFlatZones';
import {
  getMountainRippleAmplitude,
  getMountainSeparatorAmplitude,
  getTerrainMapShape,
  getTerrainTeamCount,
} from './terrainState';
import {
  makeMapOvalMetrics,
  sampleMapOvalAt,
  type MapOvalMetrics,
  type MapOvalSample,
} from '../mapOval';

function plateauRampCurve(t: number): number {
  const smooth = smootherstep(t);
  const sharpness = clamp01(TERRAIN_PLATEAU_CONFIG.rampEdgeSharpness);
  return smooth + (t - smooth) * sharpness;
}

function applyTerrainPlateaus(height: number, strength: number = 1): number {
  if (!TERRAIN_PLATEAU_CONFIG.enabled || !Number.isFinite(height))
    return height;
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return height;
  const terraceStrength = clamp01(strength);
  if (terraceStrength <= 0) return height;

  const flatHalf = Math.min(
    0.49,
    Math.max(0, TERRAIN_PLATEAU_CONFIG.shelfFractionOfStep * 0.5),
  );
  const q = height / step;
  const nearestLevel = Math.round(q);
  const signedFromNearest = q - nearestLevel;
  const absFromNearest = Math.abs(signedFromNearest);
  let plateauLevel: number;
  if (absFromNearest <= flatHalf) {
    plateauLevel = nearestLevel;
  } else if (signedFromNearest > 0) {
    const rampSpan = Math.max(1e-6, 1 - flatHalf * 2);
    const rampT = (signedFromNearest - flatHalf) / rampSpan;
    plateauLevel = nearestLevel + plateauRampCurve(rampT);
  } else {
    const rampSpan = Math.max(1e-6, 1 - flatHalf * 2);
    const rampT = (1 + signedFromNearest - flatHalf) / rampSpan;
    plateauLevel = nearestLevel - 1 + plateauRampCurve(rampT);
  }
  const plateauHeight = plateauLevel * step;

  return height + (plateauHeight - height) * terraceStrength;
}

function getTerrainPlateauStrength(naturalSlope: number): number {
  const fullSlope = Math.max(0, TERRAIN_PLATEAU_CONFIG.fullTerraceMaxSlope);
  const noSlope = Math.max(
    fullSlope + 1e-6,
    TERRAIN_PLATEAU_CONFIG.noTerraceMinSlope,
  );
  if (naturalSlope <= fullSlope) return 1;
  if (naturalSlope >= noSlope) return 0;
  const t = (naturalSlope - fullSlope) / (noSlope - fullSlope);
  return 1 - smootherstep(clamp01(t));
}

function estimateGeneratedTerrainSlope(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  ovalMetrics: MapOvalMetrics,
): number {
  const eps = Math.max(1, TERRAIN_PLATEAU_CONFIG.slopeSampleDistance);
  const hx0 = getGeneratedNaturalTerrainHeight(
    x - eps,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hx1 = getGeneratedNaturalTerrainHeight(
    x + eps,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hy0 = getGeneratedNaturalTerrainHeight(
    x,
    y - eps,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hy1 = getGeneratedNaturalTerrainHeight(
    x,
    y + eps,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  return Math.hypot((hx1 - hx0) / (2 * eps), (hy1 - hy0) / (2 * eps));
}

function getTerrainCircleEndRadiusForMinDim(minDim: number): number {
  const maxEndRadius = minDim * 0.5;
  return Math.max(
    1,
    Math.min(
      maxEndRadius,
      minDim * TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
    ),
  );
}

function getTerrainCircleStartRadiusForMinDim(
  minDim: number,
  endRadius: number,
): number {
  const maxWidth = Math.max(0, endRadius - 1);
  const desiredWidth =
    minDim * Math.max(0, TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION);
  const width = Math.min(maxWidth, desiredWidth);
  return Math.max(0, endRadius - width);
}

function getTerrainGenerationBoundaryFadeForSample(
  ovalMetrics: MapOvalMetrics,
  oval: MapOvalSample,
): number {
  const endRadius = ovalMetrics.minDim * 0.5;
  const width = Math.min(
    Math.max(0, endRadius - 1),
    ovalMetrics.minDim * TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  );
  const startRadius = Math.max(0, endRadius - width);
  if (oval.distance <= startRadius) return 0;
  if (oval.distance >= endRadius) return 1;
  return smootherstep(
    clamp01((oval.distance - startRadius) / Math.max(1e-6, endRadius - startRadius)),
  );
}

/** Internal: boundary fade from a pre-built metrics + sample pair.
 *  Public callers go through `getTerrainMapBoundaryFade` (which builds
 *  both); the per-tick `getTerrainHeight` pipeline threads its own
 *  metrics + oval through this helper to avoid 3 redundant
 *  makeMapOvalMetrics calls per height sample. */
function getTerrainMapBoundaryFadeForSample(
  metrics: MapOvalMetrics,
  oval: MapOvalSample,
): number {
  if (getTerrainMapShape() !== 'circle') return 0;
  const endRadius = getTerrainCircleEndRadiusForMinDim(metrics.minDim);
  const startRadius = getTerrainCircleStartRadiusForMinDim(metrics.minDim, endRadius);
  if (oval.distance <= startRadius) return 0;
  if (oval.distance >= endRadius) return 1;
  return smootherstep(
    clamp01((oval.distance - startRadius) / (endRadius - startRadius)),
  );
}

export function getTerrainMapBoundaryFade(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (getTerrainMapShape() !== 'circle') return 0;
  const metrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const oval = sampleMapOvalAt(metrics, x, y);
  return getTerrainMapBoundaryFadeForSample(metrics, oval);
}

/** Internal: apply boundary fade with pre-built metrics + sample. */
function applyTerrainMapBoundaryForSample(
  height: number,
  metrics: MapOvalMetrics,
  oval: MapOvalSample,
): number {
  const w = getTerrainMapBoundaryFadeForSample(metrics, oval);
  if (w <= 0) return height;
  if (w >= 1) return TERRAIN_CIRCLE_UNDERWATER_HEIGHT;
  return height + (TERRAIN_CIRCLE_UNDERWATER_HEIGHT - height) * w;
}

function getGeneratedNaturalTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  ovalMetrics: MapOvalMetrics = makeMapOvalMetrics(mapWidth, mapHeight),
  /** Pre-computed oval sample for (x, y). Threaded by getTerrainHeight
   *  so the same sample is reused across natural+plateau+boundary
   *  pipeline stages instead of being re-sampled three times. */
  ovalSample?: MapOvalSample,
): number {
  const oval = ovalSample ?? sampleMapOvalAt(ovalMetrics, x, y);

  let ripple = 0;
  const maxDist = ovalMetrics.minDim * TERRAIN_RIPPLE_CONFIG.radiusFraction;
  if (oval.distance < maxDist && maxDist > 0) {
    const fadeT = (oval.distance / maxDist) * (Math.PI / 2);
    const fade = Math.cos(fadeT);
    const [c0, c1, c2] = TERRAIN_RIPPLE_CONFIG.components;
    const a = Math.cos(oval.distance / c0.wavelength);
    const b = Math.cos(oval.distance / c1.wavelength + TERRAIN_RIPPLE_CONFIG.phase);
    const c = Math.sin((oval.ox + oval.oy) / c2.wavelength);
    const sum = a * c0.magnitude + b * c1.magnitude + c * c2.magnitude;
    const norm = (sum + 1) * 0.5;
    ripple = getMountainRippleAmplitude() * fade * norm;
  }

  let ridge = 0;
  const teamCount = getTerrainTeamCount();
  if (teamCount > 0 && oval.distance > 0) {
    const cycle = (2 * Math.PI) / teamCount;
    let pos = (oval.angle + Math.PI / 4) % cycle;
    if (pos < 0) pos += cycle;
    const barrierMid = cycle / 2;
    const distFromBarrierCenter = Math.abs(pos - barrierMid);
    const minDim = ovalMetrics.minDim;
    const halfWidth = minDim * TERRAIN_RIDGE_CONFIG.halfWidthFraction;
    const alongDist = oval.distance * Math.cos(distFromBarrierCenter);
    const perpDist = oval.distance * Math.sin(distFromBarrierCenter);
    if (alongDist > 0 && perpDist < halfWidth) {
      const widthT = perpDist / halfWidth;
      const angFalloff = (1 + Math.cos(widthT * Math.PI)) * 0.5;
      const innerR = minDim * TERRAIN_RIDGE_CONFIG.innerRadiusFraction;
      const outerR = minDim * TERRAIN_RIDGE_CONFIG.outerRadiusFraction;
      let radT: number;
      if (alongDist >= outerR) {
        radT = 1;
      } else if (alongDist <= innerR) {
        radT = 0;
      } else {
        const span = outerR - innerR;
        radT = span > 0 ? (alongDist - innerR) / span : 1;
      }
      ridge = getMountainSeparatorAmplitude() * angFalloff * radT;
    }
  }

  const generationFade =
    getTerrainGenerationBoundaryFadeForSample(ovalMetrics, oval);
  return (ripple + ridge) * (1 - generationFade);
}

/**
 * Analytical terrain height at (x, y). Re-computes ripple + ridge +
 * slope-gated plateau + boundary fade + deposit override from scratch.
 *
 * COST: ~5x a single ripple+ridge evaluation when slope-gated plateaus
 * are enabled — `estimateGeneratedTerrainSlope` does four extra
 * `getGeneratedNaturalTerrainHeight` calls (central-difference). This
 * is acceptable during one-time terrain baking
 * (`buildTerrainTileMap`) but DANGEROUS for any recurring caller.
 *
 * For runtime hot paths (per-pixel minimap, per-tile pathfinding,
 * per-frame visual normals) use `getTerrainMeshHeight` /
 * `getTerrainMeshNormal` from `terrainTileMap.ts` instead — those are
 * O(1) lookups against the baked authoritative tile map and stay in
 * sync via `getTerrainVersion`.
 */
export function getTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  // Build the oval metrics + center sample ONCE per call and thread
  // them through every stage that needs them (natural ripple/ridge,
  // optional plateau slope estimator, boundary fade). Audit measured
  // 3 redundant makeMapOvalMetrics calls per getTerrainHeight before
  // this — small per call but called from every baked tile vertex,
  // every analytical fallback, every getTerrainMapBoundaryFade probe.
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const ovalSample = sampleMapOvalAt(ovalMetrics, x, y);
  const natural = getGeneratedNaturalTerrainHeight(
    x,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
    ovalSample,
  );
  let terraced = natural;
  if (TERRAIN_PLATEAU_CONFIG.enabled) {
    // Slope estimator samples four neighbors at ±eps — those need
    // their own oval samples (different positions), so only metrics
    // get threaded here.
    const naturalSlope = estimateGeneratedTerrainSlope(
      x,
      y,
      mapWidth,
      mapHeight,
      ovalMetrics,
    );
    terraced = applyTerrainPlateaus(
      natural,
      getTerrainPlateauStrength(naturalSlope),
    );
  }

  const terracedShaped = applyTerrainMapBoundaryForSample(
    terraced,
    ovalMetrics,
    ovalSample,
  );
  const override = depositOverride(x, y);
  const blended =
    override.height * (1 - override.weight) + terracedShaped * override.weight;

  return Math.max(TILE_FLOOR_Y, blended);
}
