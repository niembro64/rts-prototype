import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import {
  TERRAIN_CIRCLE_ISLAND_RADIUS_FRACTION,
  TERRAIN_CIRCLE_SHORELINE_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_D_TERRAIN,
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_RIDGE_CONFIG,
  TERRAIN_RIPPLE_CONFIG,
  TILE_FLOOR_Y,
} from './terrainConfig';
import { smootherstep } from './terrainMath';
import { clamp01 } from '../../math';
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

/** Snap height to the nearest TERRAIN_D_TERRAIN multiple. The
 *  `shelfFractionOfStep` slice of each step is treated as a flat
 *  shelf at that level; the remainder is a connecting ramp shaped by
 *  `rampEdgeSharpness` (0 = smoothstep, 1 = hard cliff at shelf
 *  edges). The plateau gate is unconditional — every point snaps
 *  whenever PLATEAU is ON. Smoothing back to the natural surface is
 *  the job of the deposit blend ring downstream, NOT the slope
 *  estimator. */
function applyTerrainPlateaus(height: number): number {
  if (!Number.isFinite(height)) return height;
  const step = TERRAIN_D_TERRAIN;
  // step <= 0 = D-PLATEAU "NONE" picked, so terracing is disabled.
  if (step <= 0) return height;

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
  return plateauLevel * step;
}

function getTerrainCircleEndRadiusForMinDim(minDim: number): number {
  const maxEndRadius = minDim * 0.5;
  return Math.max(
    1,
    Math.min(
      maxEndRadius,
      minDim * TERRAIN_CIRCLE_ISLAND_RADIUS_FRACTION,
    ),
  );
}

function getTerrainCircleStartRadiusForMinDim(
  minDim: number,
  endRadius: number,
): number {
  const maxWidth = Math.max(0, endRadius - 1);
  const desiredWidth =
    minDim * Math.max(0, TERRAIN_CIRCLE_SHORELINE_WIDTH_FRACTION);
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
  ovalSample: MapOvalSample | undefined = undefined,
): number {
  const oval = ovalSample ?? sampleMapOvalAt(ovalMetrics, x, y);

  let ripple = 0;
  const maxDist = ovalMetrics.minDim * TERRAIN_RIPPLE_CONFIG.radiusFraction;
  if (oval.distance < maxDist && maxDist > 0) {
    const fadeT = (oval.distance / maxDist) * (Math.PI / 2);
    const fade = DMath.cos(fadeT);
    const [c0, c1, c2] = TERRAIN_RIPPLE_CONFIG.components;
    const a = DMath.cos(oval.distance / c0.wavelength);
    const b = DMath.cos(oval.distance / c1.wavelength + TERRAIN_RIPPLE_CONFIG.phase);
    const c = DMath.sin((oval.ox + oval.oy) / c2.wavelength);
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
    const alongDist = oval.distance * DMath.cos(distFromBarrierCenter);
    const perpDist = oval.distance * DMath.sin(distFromBarrierCenter);
    if (alongDist > 0 && perpDist < halfWidth) {
      const widthT = perpDist / halfWidth;
      const angFalloff = (1 + DMath.cos(widthT * Math.PI)) * 0.5;
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
 * Analytical terrain height at (x, y). Pipeline:
 *   1. Natural ripple + ridge (`getGeneratedNaturalTerrainHeight`)
 *   2. Map boundary fade (round-island falloff)
 *   3. Plateau snapping — when PLATEAU is ON, snap unconditionally
 *      to TERRAIN_D_TERRAIN levels, turning the natural surface into
 *      a stair of plateaus + cliffs
 *   4. Deposit override — flat pad inside `flatPadCells` at exactly
 *      its `height`, smoothly blending out to the already-plateaued
 *      terrain across `terrainBlendRadius`
 *
 * Because the blend ring is applied AFTER plateau snapping, a metal
 * extractor placed across a cliff smooths that cliff into a ramp:
 * the inside of the pad stays flat at h, the outside transitions
 * smoothly to the stair-stepped neighbour.
 *
 * For runtime hot paths (per-pixel minimap, per-tile pathfinding,
 * per-frame visual normals) use `getTerrainMeshHeight` /
 * `getTerrainMeshNormal` from `terrainTileMap.ts` — those are O(1)
 * lookups against the baked authoritative tile map and stay in sync
 * via `getTerrainVersion`.
 */
export function getTerrainHeight(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  /** Set false to ignore deposit flat-zone overrides — used when a
   *  caller needs the natural-plus-plateau surface that a deposit pad
   *  would override (e.g. ring authoring with `dTerrainLevels: null`,
   *  which parks the pad at whatever the post-plateau height happens
   *  to be). */
  includeDeposits = true,
): number {
  const ovalMetrics = makeMapOvalMetrics(mapWidth, mapHeight);
  return getTerrainHeightWithMetrics(
    x,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
    includeDeposits,
  );
}


function getTerrainHeightWithMetrics(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  ovalMetrics: MapOvalMetrics,
  includeDeposits: boolean,
): number {
  const ovalSample = sampleMapOvalAt(ovalMetrics, x, y);
  const natural = getGeneratedNaturalTerrainHeight(
    x,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
    ovalSample,
  );
  const shaped = applyTerrainMapBoundaryForSample(
    natural,
    ovalMetrics,
    ovalSample,
  );
  const terraced = applyTerrainPlateaus(shaped);

  let blended = terraced;
  if (includeDeposits) {
    const override = depositOverride(x, y);
    blended = override.height * (1 - override.weight) + terraced * override.weight;
  }

  return Math.max(TILE_FLOOR_Y, blended);
}
