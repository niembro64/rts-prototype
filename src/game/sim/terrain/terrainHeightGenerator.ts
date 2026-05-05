import {
  RIDGE_HALF_WIDTH_FRACTION,
  RIDGE_INNER_RADIUS_FRACTION,
  RIDGE_OUTER_RADIUS_FRACTION,
  RIPPLE_PHASE,
  RIPPLE_RADIUS_FRACTION,
  RIPPLE_W1,
  RIPPLE_W2,
  RIPPLE_W3,
  TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
  TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_D_TERRAIN,
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_PLATEAU_CONFIG,
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
  const lowerLevel = Math.floor(q);
  const t = q - lowerLevel;
  let plateauHeight: number;
  if (t <= flatHalf) {
    plateauHeight = lowerLevel * step;
  } else if (t >= 1 - flatHalf) {
    plateauHeight = (lowerLevel + 1) * step;
  } else {
    const rampT = (t - flatHalf) / Math.max(1e-6, 1 - flatHalf * 2);
    plateauHeight = (lowerLevel + plateauRampCurve(rampT)) * step;
  }

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

function getTerrainCircleEndRadius(mapWidth: number, mapHeight: number): number {
  const minDim = makeMapOvalMetrics(mapWidth, mapHeight).minDim;
  const maxEndRadius = minDim * 0.5;
  return Math.max(
    1,
    Math.min(
      maxEndRadius,
      minDim * TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
    ),
  );
}

function getTerrainCircleStartRadius(
  mapWidth: number,
  mapHeight: number,
  endRadius: number,
): number {
  const minDim = makeMapOvalMetrics(mapWidth, mapHeight).minDim;
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

export function getTerrainMapBoundaryFade(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (getTerrainMapShape() !== 'circle') return 0;
  const endRadius = getTerrainCircleEndRadius(mapWidth, mapHeight);
  const startRadius = getTerrainCircleStartRadius(mapWidth, mapHeight, endRadius);
  const oval = sampleMapOvalAt(makeMapOvalMetrics(mapWidth, mapHeight), x, y);
  if (oval.distance <= startRadius) return 0;
  if (oval.distance >= endRadius) return 1;

  return smootherstep(
    clamp01((oval.distance - startRadius) / (endRadius - startRadius)),
  );
}

function applyTerrainMapBoundary(
  height: number,
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const w = getTerrainMapBoundaryFade(x, y, mapWidth, mapHeight);
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
): number {
  const oval = sampleMapOvalAt(ovalMetrics, x, y);

  let ripple = 0;
  const maxDist = ovalMetrics.minDim * RIPPLE_RADIUS_FRACTION;
  if (oval.distance < maxDist && maxDist > 0) {
    const fadeT = (oval.distance / maxDist) * (Math.PI / 2);
    const fade = Math.cos(fadeT);
    const a = Math.cos(oval.distance / RIPPLE_W1);
    const b = Math.cos(oval.distance / RIPPLE_W2 + RIPPLE_PHASE);
    const c = Math.sin((oval.ox + oval.oy) / RIPPLE_W3);
    const sum = a * 0.5 + b * 0.3 + c * 0.2;
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
    const halfWidth = minDim * RIDGE_HALF_WIDTH_FRACTION;
    const alongDist = oval.distance * Math.cos(distFromBarrierCenter);
    const perpDist = oval.distance * Math.sin(distFromBarrierCenter);
    if (alongDist > 0 && perpDist < halfWidth) {
      const widthT = perpDist / halfWidth;
      const angFalloff = (1 + Math.cos(widthT * Math.PI)) * 0.5;
      const innerR = minDim * RIDGE_INNER_RADIUS_FRACTION;
      const outerR = minDim * RIDGE_OUTER_RADIUS_FRACTION;
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

export function getTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const natural = getGeneratedNaturalTerrainHeight(
    x,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  let terraced = natural;
  if (TERRAIN_PLATEAU_CONFIG.enabled) {
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

  const terracedShaped = applyTerrainMapBoundary(
    terraced,
    x,
    y,
    mapWidth,
    mapHeight,
  );
  const override = depositOverride(x, y);
  const blended =
    override.height * (1 - override.weight) + terracedShaped * override.weight;

  return Math.max(TILE_FLOOR_Y, blended);
}
