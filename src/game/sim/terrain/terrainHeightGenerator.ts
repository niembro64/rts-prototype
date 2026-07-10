import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import {
  TERRAIN_D_TERRAIN,
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_PERIMETER_CONFIG,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_PLATEAU_WALL_SLOPE_DEGREES,
  TERRAIN_RIDGE_CONFIG,
  TERRAIN_RIPPLE_CONFIG,
  TERRAIN_SHORELINE_CONFIG,
  TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES,
  TERRAIN_WATERS_EDGE_CLIFF_HEIGHT,
  TILE_FLOOR_Y,
  WATER_LEVEL,
} from './terrainConfig';
import { smootherstep } from './terrainMath';
import { clamp01 } from '../../math';
import { depositOverride } from './terrainFlatZones';
import {
  makeMapOvalMetrics,
  sampleMapOvalAt,
  type MapOvalMetrics,
  type MapOvalSample,
} from '../mapOval';
import {
  getMountainRippleAmplitude,
  getMountainSeparatorAmplitude,
  getTerrainPerimeterMagnitude,
  getTerrainTeamCount,
} from './terrainState';

/** Raised-cosine ramp on [0,1]: 0 at t=0, 1 at t=1, with zero slope at
 *  both ends. Used to blend the natural terrain into the PERIMETER ring
 *  across the inner→outer band. Mirrors the Rust perimeter weight. */
function perimeterRampWeight(t: number): number {
  return (1 - DMath.cos(t * Math.PI)) * 0.5;
}

function plateauRampCurve(t: number): number {
  const smooth = smootherstep(t);
  const sharpness = clamp01(TERRAIN_PLATEAU_CONFIG.rampEdgeSharpness);
  return smooth + (t - smooth) * sharpness;
}

const TERRAIN_PLATEAU_GRADIENT_SAMPLE_STEP = 8;

function plateauFlatHalfForGradient(gradientMagnitude: number): number {
  const authoredFlatHalf = Math.min(
    0.49,
    Math.max(0, TERRAIN_PLATEAU_CONFIG.shelfFractionOfStep * 0.5),
  );
  const angle = Math.max(
    1,
    Math.min(89, TERRAIN_PLATEAU_WALL_SLOPE_DEGREES),
  );
  if (angle >= 89) return authoredFlatHalf;

  const gradient = Math.max(0, Math.abs(gradientMagnitude));
  const tanAngle = Math.max(1e-6, Math.tan(angle * Math.PI / 180));
  const rampQSpan = Math.max(0, Math.min(1, gradient / tanAngle));
  const angleFlatHalf = Math.max(0, Math.min(0.49, (1 - rampQSpan) * 0.5));
  return Math.min(authoredFlatHalf, angleFlatHalf);
}

/** Snap height to the nearest TERRAIN_D_TERRAIN multiple. The
 *  `shelfFractionOfStep` slice of each step is treated as a flat
 *  shelf at that level; the remainder is a connecting ramp shaped by
 *  `rampEdgeSharpness` (0 = smoothstep, 1 = hard cliff at shelf
 *  edges). The plateau gate is unconditional — every point snaps
 *  whenever PLATEAU is ON. Smoothing back to the natural surface is
 *  the job of the deposit blend ring downstream, NOT the slope
 *  estimator. */
function applyTerrainPlateaus(
  height: number,
  gradientMagnitude: number,
): number {
  if (!Number.isFinite(height)) return height;
  const step = TERRAIN_D_TERRAIN;
  // step <= 0 = D-PLATEAU "NONE" picked, so terracing is disabled.
  if (step <= 0) return height;

  const flatHalf = plateauFlatHalfForGradient(gradientMagnitude);
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

/** Outer radius (world units) of the PERIMETER ring: at and beyond this
 *  distance the terrain is flat at exactly the perimeter magnitude. */
function getTerrainPerimeterOuterRadiusForMinDim(minDim: number): number {
  return Math.max(1, minDim * TERRAIN_PERIMETER_CONFIG.outerRadiusFraction);
}

/** Inner radius (world units) where the perimeter override begins. Inside
 *  it the natural terrain is untouched; clamped to never exceed the outer
 *  radius so the band stays well-formed for any config. */
function getTerrainPerimeterInnerRadiusForMinDim(
  minDim: number,
  outerRadius: number,
): number {
  const inner = minDim * Math.max(0, TERRAIN_PERIMETER_CONFIG.innerRadiusFraction);
  return Math.min(Math.max(0, inner), outerRadius);
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
  // PERIMETER off (magnitude 0) leaves the natural square map untouched,
  // exactly like the old SQUARE shape: weight 0 everywhere.
  if (getTerrainPerimeterMagnitude() === 0) return 0;
  const outerRadius = getTerrainPerimeterOuterRadiusForMinDim(metrics.minDim);
  const innerRadius = getTerrainPerimeterInnerRadiusForMinDim(
    metrics.minDim,
    outerRadius,
  );
  if (oval.distance <= innerRadius) return 0;
  if (oval.distance >= outerRadius) return 1;
  return perimeterRampWeight(
    clamp01((oval.distance - innerRadius) / Math.max(1e-6, outerRadius - innerRadius)),
  );
}

export function getTerrainMapBoundaryFade(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
): number {
  if (getTerrainPerimeterMagnitude() === 0) return 0;
  const metrics = makeMapOvalMetrics(mapWidth, mapHeight);
  const oval = sampleMapOvalAt(metrics, x, y);
  return getTerrainMapBoundaryFadeForSample(metrics, oval);
}

/** Internal: blend toward the PERIMETER magnitude with pre-built metrics +
 *  sample. Inside the inner radius the natural height passes through; in the
 *  band it cosine-blends toward the perimeter value; at/beyond the outer
 *  radius the height is hard-enforced to exactly the perimeter magnitude. */
function applyTerrainMapBoundaryForSample(
  height: number,
  metrics: MapOvalMetrics,
  oval: MapOvalSample,
): number {
  const w = getTerrainMapBoundaryFadeForSample(metrics, oval);
  if (w <= 0) return height;
  const perimeter = getTerrainPerimeterMagnitude();
  if (w >= 1) return perimeter;
  return height + (perimeter - height) * w;
}

function getShapedTerrainHeightBeforePlateaus(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  ovalMetrics: MapOvalMetrics = makeMapOvalMetrics(mapWidth, mapHeight),
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
  return applyTerrainMapBoundaryForSample(natural, ovalMetrics, ovalSample);
}

/** Unguarded gradient estimate of the shaped (pre-plateau) surface.
 *  The plateau path keeps its historical short-circuit in
 *  `getTerrainHeightWithMetrics`; the waters-edge pass needs a real
 *  gradient even when terracing is disabled. Mirrors
 *  `terrain_estimate_shaped_gradient` in the Rust sim. */
function estimateShapedTerrainGradient(
  x: number,
  y: number,
  mapWidth: number,
  mapHeight: number,
  ovalMetrics: MapOvalMetrics,
): number {
  const step = TERRAIN_PLATEAU_GRADIENT_SAMPLE_STEP;
  const x0 = Math.max(0, x - step);
  const x1 = Math.min(mapWidth, x + step);
  const y0 = Math.max(0, y - step);
  const y1 = Math.min(mapHeight, y + step);
  const dxSpan = Math.max(1e-6, x1 - x0);
  const dySpan = Math.max(1e-6, y1 - y0);
  const hX0 = getShapedTerrainHeightBeforePlateaus(
    x0,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hX1 = getShapedTerrainHeightBeforePlateaus(
    x1,
    y,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hY0 = getShapedTerrainHeightBeforePlateaus(
    x,
    y0,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const hY1 = getShapedTerrainHeightBeforePlateaus(
    x,
    y1,
    mapWidth,
    mapHeight,
    ovalMetrics,
  );
  const gx = (hX1 - hX0) / dxSpan;
  const gy = (hY1 - hY0) / dySpan;
  return Math.sqrt(gx * gx + gy * gy);
}

// ─────────────────────────────────────────────────────────────────
//  Waters-edge shoreline pass (beach / cliff slices). Mirrors the
//  Rust implementation in deposits.rs (`terrain_apply_waters_edge`)
//  so this analytic fallback agrees with the baked WASM mesh.
// ─────────────────────────────────────────────────────────────────

function watersEdgeBeachEnabled(): boolean {
  return (
    TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES > 0 &&
    TERRAIN_SHORELINE_CONFIG.beachFadeRadius > 0
  );
}

/** First-order horizontal distance from a point to the waterline
 *  contour: how far you must walk down/up the local slope for the
 *  shaped surface to reach the water level. Follows the water's curves
 *  on both the land and water sides; both shoreline fades key off it.
 *  Mirrors the Rust `terrain_waters_edge_shore_distance`. */
function watersEdgeShoreDistance(shaped: number, gradient: number): number {
  return Math.abs(shaped - WATER_LEVEL) / Math.max(1e-3, Math.abs(gradient));
}

/** Raised-cosine shoreline fade: 1 (full effect) at the waterline,
 *  easing to 0 at `radius` world units from the water's edge. The one
 *  falloff shape shared by the beach and cliff operators. Mirrors the
 *  Rust `terrain_waters_edge_fade_weight`. */
function watersEdgeFadeWeight(shoreDistance: number, radius: number): number {
  if (radius <= 0) return 0;
  return 1 - perimeterRampWeight(Math.min(1, shoreDistance / radius));
}

function watersEdgeCliffEnabled(): boolean {
  return (
    TERRAIN_WATERS_EDGE_CLIFF_HEIGHT > 0 &&
    TERRAIN_SHORELINE_CONFIG.cliffFadeRadius > 0
  );
}

/** Conservative vertical reach of the CLIFF band around the waterline
 *  (the beach is gated by horizontal shore distance instead). Plateau
 *  snapping can move a height by up to half a step, so the pre-plateau
 *  band gate widens by that much. */
function watersEdgeBandExtent(): number {
  const cliffHalf = watersEdgeCliffEnabled()
    ? TERRAIN_WATERS_EDGE_CLIFF_HEIGHT * 0.5
    : 0;
  const plateauSlack = TERRAIN_D_TERRAIN > 0 ? TERRAIN_D_TERRAIN * 0.5 : 0;
  return cliffHalf + plateauSlack;
}

/** First player spoke angle — mirrors `getPlayerBaseAngle(0, n)` in
 *  playerLayout.ts and METAL_DEPOSIT_FIRST_PLAYER_ANGLE in the Rust
 *  sim, so the shoreline halves anchor to the same slices as ridges
 *  and deposit rings. */
const WATERS_EDGE_FIRST_PLAYER_ANGLE = -Math.PI / 2 + Math.PI / 4;

/** Horizontal world-unit width of a waters-edge cap — the angular
 *  beach↔cliff transition. Derived from the same wall-slope config as
 *  every other wall (the run needed to drop half a cliff step at that
 *  slope), so the cap is a real end-cap wall face, not a fade. Mirrors
 *  the Rust `terrain_waters_edge_cap_width`. */
function watersEdgeCapWidth(): number {
  const angle = Math.max(1, Math.min(89, TERRAIN_PLATEAU_WALL_SLOPE_DEGREES));
  const tanAngle = Math.max(1e-6, Math.tan(angle * Math.PI / 180));
  return Math.max(2, (TERRAIN_WATERS_EDGE_CLIFF_HEIGHT * 0.5) / tanAngle);
}

/** Cliffness in [0, 1] for the shoreline at `angle`. The pattern is
 *  team-periodic so every player slice gets an IDENTICAL shoreline:
 *  each player's slice is split in half — the beach half centered on
 *  the player's spoke, the cliff half centered on the divider ridge
 *  between players — joined by wall-steep end caps of fixed world
 *  width. Mirrors the Rust `terrain_waters_edge_slice_cliffness`. */
function watersEdgeSliceCliffness(angle: number, distance: number): number {
  const teams = Math.max(1, getTerrainTeamCount());
  const cycle = (2 * Math.PI) / teams;
  // +0.25 rotates the half boundaries a quarter slice so the beach
  // half straddles the player spoke and the cliff half the divider.
  const rel = (angle - WATERS_EDGE_FIRST_PLAYER_ANGLE) / cycle + 0.25;
  const phase = (rel - Math.floor(rel)) * 2;
  const k = Math.floor(phase);
  const u = phase - k;
  const current = k; // half 0 = beach (0), half 1 = cliff (1)
  // Cap width in half-slice phase units at this radius: one half
  // spans an arc of distance * cycle / 2 world units.
  const halfArc = Math.max(1, distance) * cycle * 0.5;
  const transition = Math.min(0.5, watersEdgeCapWidth() / halfArc);
  if (u >= transition) return current;
  const previous = 1 - current;
  return previous + (current - previous) * smootherstep(u / transition);
}

/** Beach operator: within the vertical beach band around the
 *  waterline, fade out plateau terracing and compress the height
 *  gradient so the surface crosses the waterline at (at most) the
 *  authored beach slope. Full effect at the water's edge, raised-cosine
 *  fade back to the natural surface over `beachFadeRadius` world units
 *  of horizontal shore distance on both sides — the same falloff shape
 *  and distance metric as the cliff fade. */
function watersEdgeBeachHeight(
  terraced: number,
  shaped: number,
  gradient: number,
): number {
  const shoreDistance = watersEdgeShoreDistance(shaped, gradient);
  const weight = watersEdgeFadeWeight(
    shoreDistance,
    TERRAIN_SHORELINE_CONFIG.beachFadeRadius,
  );
  if (weight <= 0) return terraced;
  const beachTan = Math.tan(
    Math.max(0.1, Math.min(89, TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES)) *
      Math.PI / 180,
  );
  const gradientScale = Math.min(1, beachTan / Math.max(1e-6, gradient));
  const unterraced = terraced + (shaped - terraced) * weight;
  const scale = gradientScale + (1 - gradientScale) * (1 - weight);
  return WATER_LEVEL + (unterraced - WATER_LEVEL) * scale;
}

/** Cliff operator: heights within half a cliff-height of the
 *  waterline snap onto a single plateau-style terrace step centered
 *  on the waterline — flat shelves just below and above the water
 *  joined by a wall shaped by the same ramp curve and wall-slope
 *  config as plateau walls. Identity at the band edges.
 *
 *  The snap's amplitude fades with horizontal distance to the water's
 *  edge over `cliffFadeRadius` (first-order level-set distance
 *  |shaped - WL| / |gradient|, which follows the water's curves on
 *  both sides); radius <= 0 disables the fade. Mirrors the Rust
 *  `terrain_waters_edge_cliff_height_at`. */
function watersEdgeCliffHeightAt(
  terraced: number,
  shaped: number,
  gradient: number,
): number {
  const step = TERRAIN_WATERS_EDGE_CLIFF_HEIGHT;
  const half = step * 0.5;
  const d = terraced - WATER_LEVEL;
  if (Math.abs(d) >= half) return terraced;
  const t = (d + half) / step;
  const flatHalf = plateauFlatHalfForGradient(gradient);
  let ramp: number;
  if (t <= flatHalf) {
    ramp = 0;
  } else if (t >= 1 - flatHalf) {
    ramp = 1;
  } else {
    const rampSpan = Math.max(1e-6, 1 - flatHalf * 2);
    ramp = plateauRampCurve((t - flatHalf) / rampSpan);
  }
  const snapped = WATER_LEVEL - half + ramp * step;
  const shoreDistance = watersEdgeShoreDistance(shaped, gradient);
  const weight = watersEdgeFadeWeight(
    shoreDistance,
    TERRAIN_SHORELINE_CONFIG.cliffFadeRadius,
  );
  return terraced + (snapped - terraced) * weight;
}

function applyWatersEdge(
  terraced: number,
  shaped: number,
  gradient: number,
  angle: number,
  distance: number,
): number {
  const beachEnabled = watersEdgeBeachEnabled();
  const cliffEnabled = watersEdgeCliffEnabled();
  if (!beachEnabled && !cliffEnabled) return terraced;
  const cliffness = beachEnabled && cliffEnabled
    ? watersEdgeSliceCliffness(angle, distance)
    : cliffEnabled
      ? 1
      : 0;
  const beach = beachEnabled && cliffness < 1
    ? watersEdgeBeachHeight(terraced, shaped, gradient)
    : terraced;
  const cliff = cliffEnabled && cliffness > 0
    ? watersEdgeCliffHeightAt(terraced, shaped, gradient)
    : terraced;
  return beach + (cliff - beach) * cliffness;
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
  const beachEnabled = watersEdgeBeachEnabled();
  const cliffEnabled = watersEdgeCliffEnabled();
  const watersEdgeEnabled = beachEnabled || cliffEnabled;
  const plateauGradientNeeded =
    TERRAIN_D_TERRAIN > 0 && TERRAIN_PLATEAU_WALL_SLOPE_DEGREES < 89;
  // The shore-distance fades need the gradient wherever the pass is
  // enabled, so the estimate is no longer gated to a vertical band.
  const gradient = plateauGradientNeeded || watersEdgeEnabled
    ? estimateShapedTerrainGradient(x, y, mapWidth, mapHeight, ovalMetrics)
    : 0;
  const watersEdgeActive =
    watersEdgeEnabled &&
    ((beachEnabled &&
      watersEdgeShoreDistance(shaped, gradient) <
        TERRAIN_SHORELINE_CONFIG.beachFadeRadius) ||
      (cliffEnabled &&
        Math.abs(shaped - WATER_LEVEL) < watersEdgeBandExtent()));
  const terraced = applyTerrainPlateaus(shaped, gradient);
  const shored = watersEdgeActive
    ? applyWatersEdge(terraced, shaped, gradient, ovalSample.angle, ovalSample.distance)
    : terraced;

  let blended = shored;
  if (includeDeposits) {
    const override = depositOverride(x, y);
    blended = override.height * (1 - override.weight) + shored * override.weight;
  }

  return Math.max(TILE_FLOOR_Y, blended);
}
