// MetalDepositEdgeBlend3D — how the ore region MEETS the ground.
//
// The region field (MetalDepositSurfaceField3D) answers "how far is this
// fragment from the ore boundary". Drawn straight, that answer is a clean
// stencil: a smooth contour, one anti-aliased pixel wide, the same width
// everywhere, with ore on one side and biome ground on the other. Every
// individual term of it is right and the result still reads as authored,
// because nothing in a landscape has an edge like that.
//
// This module is the layer that spends that distance on three things real
// ore edges have and a contour does not:
//
//   DISPLACEMENT  The contour is pushed outward by a fixed amount and then
//                 warped by a noise field measured in world units. The field
//                 is a metric signed distance, so adding to it literally
//                 moves the boundary — lobes at one scale with fingers
//                 eroded into them at another. The outward push is what
//                 makes the erosion eat into spare ore rather than into a
//                 small deposit's actual footprint.
//
//   DISSOLVE      Across the transition band, ore presence is decided by a
//                 granular field rather than by distance alone: at any given
//                 point the ore is either there or not, and the grain says
//                 which. The band's HALF-WIDTH is itself sampled from a
//                 broad field, so the transition is thick in places and
//                 tight in others instead of one authored width.
//
//   GRIME         A dirt band straddling the contour, reaching in over the
//                 ore and out over the ground by different distances, each
//                 jittered along the edge's length at two scales, its
//                 profile swinging along the edge, and its far side
//                 dissolved against the grain rather than faded — so no
//                 two stretches of one rim share a thickness, and the band
//                 never ends in a second, smoother contour of its own. It
//                 paints the dirt texture over both surfaces, darkens
//                 toward the contour,
//                 and takes the ore's reflection away where it covers —
//                 which is the term that actually matters. A rim that keeps
//                 its specular reads as a clean edge no matter how dark it
//                 is painted, because the highlight still traces the
//                 boundary exactly.
//
// EVERYTHING HERE IS PRESENTATION. The authoritative metal cells are each
// deposit's own cell list; this moves where ore is drawn, never where it can
// be mined. A displaced contour therefore disagrees with the build grid by
// up to `growWorldUnits + warpWorldUnits` — the build-square overlay, not
// the ore's silhouette, is what says where an extractor fits.
//
// THE MATHS IS NOT HERE. Displacement, dissolve, band ramps, grime shaping
// and the substance projection all live in SurfaceWeathering3D, shared with
// the plateau wall rims and the vegetation, because three treatments that
// meet on screen have to look like the same weather. What is ore-specific is
// only what this module holds: which quantity is being weathered (the region
// field's signed distance), the dirt it paints, and the tuning.
//
// DERIVATIVES ARE COMPUTED BY THE HOST, NOT HERE. fwidth() inside non-uniform
// control flow is undefined — the whole point of the early-out branch is that
// neighbouring fragments take different paths, which is exactly the case
// where a driver is free to hand back garbage. The host samples the
// derivative once at top level and passes it down.

import {
  ORE_EDGE_BLEND_BAND_MAX_WORLD_UNITS,
  ORE_EDGE_BLEND_BAND_MIN_WORLD_UNITS,
  ORE_EDGE_GRAIN_STRENGTH,
  ORE_EDGE_GRIME_DARKEN,
  ORE_EDGE_GRIME_FALLOFF,
  ORE_EDGE_GRIME_INNER_REACH_WORLD_UNITS,
  ORE_EDGE_GRIME_MATTE,
  ORE_EDGE_GRIME_OUTER_REACH_WORLD_UNITS,
  ORE_EDGE_GRIME_PATCH_DEPTH,
  ORE_EDGE_GRIME_SEAM_POWER,
  ORE_EDGE_GRIME_STRENGTH,
  ORE_EDGE_GRIME_THICKNESS_VARIATION,
  ORE_EDGE_GROW_WORLD_UNITS,
  ORE_EDGE_INFLUENCE_WORLD_UNITS,
  ORE_EDGE_NOISE_TILE_WORLD_SIZE,
  ORE_EDGE_WARP_WORLD_UNITS,
  SOIL_SUBSTANCE_TILE_WORLD_SIZE,
} from '../../config';
import {
  WEATHER_NOISE_SAMPLER,
  WEATHER_SOIL_SAMPLER,
} from './SurfaceWeathering3D';

export type OreEdgeBlendUniforms = {
  enabled: { value: number };
  noiseTileWorldSize: { value: number };
  dirtTileWorldSize: { value: number };
  influence: { value: number };
  grow: { value: number };
  warp: { value: number };
  bandMin: { value: number };
  bandMax: { value: number };
  grain: { value: number };
  grimeInner: { value: number };
  grimeOuter: { value: number };
  grimeVariation: { value: number };
  grimeFalloff: { value: number };
  grimePatchDepth: { value: number };
  grimeStrength: { value: number };
  grimeDarken: { value: number };
  grimeSeamPower: { value: number };
  grimeMatte: { value: number };
};

/** Builds the uniform block, generating both textures. `enabled` is the
 *  caller's: a SURFACE = METAL world has no ore boundary to weather, because
 *  every deposit edge on it is interior to a map that is entirely ore. */
export function createOreEdgeBlendUniforms(enabled: boolean): OreEdgeBlendUniforms {
  return {
    enabled: { value: enabled ? 1 : 0 },
    noiseTileWorldSize: { value: ORE_EDGE_NOISE_TILE_WORLD_SIZE },
    dirtTileWorldSize: { value: SOIL_SUBSTANCE_TILE_WORLD_SIZE },
    influence: { value: ORE_EDGE_INFLUENCE_WORLD_UNITS },
    grow: { value: ORE_EDGE_GROW_WORLD_UNITS },
    warp: { value: ORE_EDGE_WARP_WORLD_UNITS },
    bandMin: { value: ORE_EDGE_BLEND_BAND_MIN_WORLD_UNITS },
    bandMax: { value: ORE_EDGE_BLEND_BAND_MAX_WORLD_UNITS },
    grain: { value: ORE_EDGE_GRAIN_STRENGTH },
    grimeInner: { value: ORE_EDGE_GRIME_INNER_REACH_WORLD_UNITS },
    grimeOuter: { value: ORE_EDGE_GRIME_OUTER_REACH_WORLD_UNITS },
    grimeVariation: { value: ORE_EDGE_GRIME_THICKNESS_VARIATION },
    grimeFalloff: { value: ORE_EDGE_GRIME_FALLOFF },
    grimePatchDepth: { value: ORE_EDGE_GRIME_PATCH_DEPTH },
    grimeStrength: { value: ORE_EDGE_GRIME_STRENGTH },
    grimeDarken: { value: ORE_EDGE_GRIME_DARKEN },
    grimeSeamPower: { value: ORE_EDGE_GRIME_SEAM_POWER },
    grimeMatte: { value: ORE_EDGE_GRIME_MATTE },
  };
}

export function assignOreEdgeBlendUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  uniforms: OreEdgeBlendUniforms,
): void {
  shader.uniforms.uOreEdgeEnabled = uniforms.enabled;
  shader.uniforms.uOreEdgeNoiseTileWorldSize = uniforms.noiseTileWorldSize;
  shader.uniforms.uOreEdgeDirtTileWorldSize = uniforms.dirtTileWorldSize;
  shader.uniforms.uOreEdgeInfluence = uniforms.influence;
  shader.uniforms.uOreEdgeGrow = uniforms.grow;
  shader.uniforms.uOreEdgeWarp = uniforms.warp;
  shader.uniforms.uOreEdgeBandMin = uniforms.bandMin;
  shader.uniforms.uOreEdgeBandMax = uniforms.bandMax;
  shader.uniforms.uOreEdgeGrain = uniforms.grain;
  shader.uniforms.uOreEdgeGrimeInner = uniforms.grimeInner;
  shader.uniforms.uOreEdgeGrimeOuter = uniforms.grimeOuter;
  shader.uniforms.uOreEdgeGrimeVariation = uniforms.grimeVariation;
  shader.uniforms.uOreEdgeGrimeFalloff = uniforms.grimeFalloff;
  shader.uniforms.uOreEdgeGrimePatchDepth = uniforms.grimePatchDepth;
  shader.uniforms.uOreEdgeGrimeStrength = uniforms.grimeStrength;
  shader.uniforms.uOreEdgeGrimeDarken = uniforms.grimeDarken;
  shader.uniforms.uOreEdgeGrimeSeamPower = uniforms.grimeSeamPower;
  shader.uniforms.uOreEdgeGrimeMatte = uniforms.grimeMatte;
}

export function oreEdgeBlendUniformDeclarations(): string {
  return [
    'uniform float uOreEdgeEnabled;',
    // The two textures come from the shared weathering samplers the host
    // declares once for every treatment in the program; only the tile sizes
    // are the ore edge's own.
    'uniform float uOreEdgeNoiseTileWorldSize;',
    'uniform float uOreEdgeDirtTileWorldSize;',
    'uniform float uOreEdgeInfluence;',
    'uniform float uOreEdgeGrow;',
    'uniform float uOreEdgeWarp;',
    'uniform float uOreEdgeBandMin;',
    'uniform float uOreEdgeBandMax;',
    'uniform float uOreEdgeGrain;',
    'uniform float uOreEdgeGrimeInner;',
    'uniform float uOreEdgeGrimeOuter;',
    'uniform float uOreEdgeGrimeVariation;',
    'uniform float uOreEdgeGrimeFalloff;',
    'uniform float uOreEdgeGrimePatchDepth;',
    'uniform float uOreEdgeGrimeStrength;',
    'uniform float uOreEdgeGrimeDarken;',
    'uniform float uOreEdgeGrimeSeamPower;',
    'uniform float uOreEdgeGrimeMatte;',
  ].join('\n');
}

/** The two ore-shaped terms. Everything generic about them — the field
 *  taps, the displacement algebra, the dissolve, the band ramp, the grime
 *  shaping, the substance projection — lives in SurfaceWeathering3D and is
 *  shared with the plateau wall rims and the vegetation. What is ore-specific
 *  is only how the band width is chosen and that the reach is two-sided
 *  around a signed distance.
 *
 *  Sampling and USE are split because the samples must happen where
 *  derivatives are still legal and the use happens under a branch. Callers
 *  read the fields once, then pass them down. */
export const ORE_EDGE_BLEND_GLSL = [
  '// Ore coverage across the transition, dissolved against the grain. The',
  '// band half-width is drawn from the broad field, so the ore-to-ground',
  '// ramp is thick in stretches and tight in others rather than one',
  '// authored number.',
  '//',
  '// `distanceWidth` is the screen size of one world unit of the region',
  '// field, measured by the host at top level; dividing it by the band',
  '// converts it into the ramp\'s own units, which is what the dissolve',
  '// wants for its anti-aliasing.',
  'float oreEdgeCoverage(',
  '  float warpedDistance,',
  '  WeatherFields fields,',
  '  float distanceWidth,',
  '  float bandMin,',
  '  float bandMax,',
  '  float grainStrength',
  ') {',
  '  float band = max(mix(bandMin, bandMax, fields.band), 0.001);',
  '  float presence = clamp(0.5 - 0.5 * warpedDistance / band, 0.0, 1.0);',
  '  return weatherDissolve(presence, fields, 0.5 * distanceWidth / band, grainStrength);',
  '}',
  '',
  '// The dirt band. Dirt spreads further onto open ground than it does over',
  '// the ore body, so the two reaches differ; both are jittered along the',
  '// edge at two scales, the profile swings along it, the grain thins it in',
  '// patches, and its far edge is dissolved rather than faded — all by the',
  '// shared band composite, so the ore rim crumbles the way a wall rim does.',
  '//',
  '// The dissolve wants the screen width of the ramp in the ramp\'s own',
  '// units. The ramp spans the jittered reach, so the width of one world',
  '// unit of distance is divided by the TIGHTEST reach the band can take;',
  '// where it is wider the softening is merely a touch generous, which is',
  '// the safe side of an anti-aliasing estimate.',
  'float oreEdgeGrimeBand(',
  '  float warpedDistance,',
  '  WeatherFields fields,',
  '  float distanceWidth,',
  '  float innerReach,',
  '  float outerReach,',
  '  float variation,',
  '  float falloff,',
  '  float patchDepth,',
  '  float grainStrength',
  ') {',
  '  float ramp = weatherBandRamp(warpedDistance, fields, innerReach, outerReach, variation);',
  '  float tightest = max(min(innerReach, outerReach) * (1.0 - variation), 1.0);',
  '  return weatherGrimeBand(ramp, fields, falloff, patchDepth, distanceWidth / tightest, grainStrength);',
  '}',
].join('\n');

/** Resolves the ore boundary and the dirt band, replacing the coverage the
 *  region field would have produced on its own.
 *
 *  Exported as source rather than inlined at the injection site so the
 *  shipped strings are readable by a contract test — a shader interface is
 *  the one contract the type system cannot check.
 *
 *  THE EARLY-OUT is what makes five extra texture taps affordable on a
 *  full-screen surface. `uOreEdgeInfluence` is the furthest any term below
 *  can reach from the contour, so a fragment past it cannot be affected and
 *  does not pay for the samples. Ore edges are a thin fraction of the
 *  screen, so the overwhelming majority of warps take the cheap path
 *  together and the branch costs nothing to diverge on.
 *
 *  Host contract: `oreDistance` (world units, negative inside), its screen
 *  width `oreDistanceWidth` measured at TOP LEVEL, and a mutable
 *  `float oreRegionCoverage` this overwrites. Declares `oreEdgeGrime`. */
export function oreEdgeResolveFragment(
  worldPositionExpr: string,
  regionEnabledExpr: string,
): string {
  return [
    'float oreEdgeGrime = 0.0;',
    'if (uOreEdgeEnabled > 0.0 && abs(oreDistance) < uOreEdgeInfluence) {',
    '  WeatherFields oreFields = weatherSampleFields(',
    `    ${WEATHER_NOISE_SAMPLER},`,
    `    ${worldPositionExpr}.xz,`,
    '    uOreEdgeNoiseTileWorldSize',
    '  );',
    '  float oreEdgeDistance = weatherDisplace(',
    '    oreDistance,',
    '    oreFields,',
    '    uOreEdgeGrow,',
    '    uOreEdgeWarp',
    '  );',
    '  oreRegionCoverage = oreEdgeCoverage(',
    '    oreEdgeDistance,',
    '    oreFields,',
    '    oreDistanceWidth,',
    '    uOreEdgeBandMin,',
    '    uOreEdgeBandMax,',
    '    uOreEdgeGrain',
    `  ) * ${regionEnabledExpr};`,
    '  oreEdgeGrime = oreEdgeGrimeBand(',
    '    oreEdgeDistance,',
    '    oreFields,',
    '    oreDistanceWidth,',
    '    uOreEdgeGrimeInner,',
    '    uOreEdgeGrimeOuter,',
    '    uOreEdgeGrimeVariation,',
    '    uOreEdgeGrimeFalloff,',
    '    uOreEdgeGrimePatchDepth,',
    '    uOreEdgeGrain',
    `  ) * ${regionEnabledExpr};`,
    '}',
  ].join('\n');
}

/** The coverage the PBR half of the metal surface must take, given the
 *  geometric one.
 *
 *  This is the term that decides whether the treatment works at all. Dirt is
 *  not metal: leave the reflection at full strength across the rim and the
 *  environment highlight still traces the ore boundary exactly, so the edge
 *  reads as crisp no matter how much dirt is painted over it. Every other
 *  term here is cosmetic by comparison — this one is why the boundary stops
 *  being visible as a boundary. */
export function oreEdgeMatteCoverage(coverageExpr: string): string {
  return `${coverageExpr} * (1.0 - uOreEdgeGrimeMatte * oreEdgeGrime)`;
}

/** The albedo half of the grime, applied AFTER the ore surface has been
 *  composed so it dirties whichever of the two it lands on.
 *
 *  Two terms, not one: the dirt texture replaces the surface, and then the
 *  result is darkened toward the contour. The mix alone reaches the dirt's
 *  own colour and stops — but the seam where two materials meet is darker
 *  than either of them, and that dark line is most of what makes the join
 *  read as a join rather than as a boundary between two flat regions.
 *
 *  Host contract: `oreEdgeGrime`, a mutable `vec3 terrainRgb`, and
 *  `weatherSampleSubstance` — the same triplanar projection the ore
 *  surface itself is read through, so the dirt lands on a cliff face the way
 *  the ore beside it does instead of smearing down it. */
export function oreEdgeAlbedoFragment(
  worldPositionExpr: string,
  geometricNormalExpr: string,
): string {
  return [
    'if (oreEdgeGrime > 0.0) {',
    '  vec3 oreEdgeDirt = weatherSampleSoil(',
    `    ${WEATHER_SOIL_SAMPLER},`,
    `    ${worldPositionExpr},`,
    `    ${geometricNormalExpr},`,
    '    uOreEdgeDirtTileWorldSize',
    '  );',
    '  terrainRgb = weatherApplyGrime(',
    '    terrainRgb,',
    '    oreEdgeDirt,',
    '    oreEdgeGrime,',
    '    uOreEdgeGrimeStrength,',
    '    uOreEdgeGrimeDarken,',
    '    uOreEdgeGrimeSeamPower',
    '  );',
    '}',
  ].join('\n');
}
