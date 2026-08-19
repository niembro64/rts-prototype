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
//                 jittered along the edge's length. It paints the dirt
//                 texture over both surfaces, darkens toward the contour,
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
// DERIVATIVES ARE COMPUTED BY THE HOST, NOT HERE. Every function below takes
// the screen width of the distance field as a parameter. fwidth() inside
// non-uniform control flow is undefined — the whole point of the early-out
// branch is that neighbouring fragments take different paths, which is
// exactly the case where a driver is free to hand back garbage. The host
// samples the derivative once at top level and passes it down.

import * as THREE from 'three';
import {
  ORE_EDGE_BLEND_BAND_MAX_WORLD_UNITS,
  ORE_EDGE_BLEND_BAND_MIN_WORLD_UNITS,
  ORE_EDGE_DIRT_TILE_WORLD_SIZE,
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
} from '../../config';
import { getOreEdgeDirtTexture } from './OreEdgeDirtTexture';
import { getOreEdgeNoiseTexture } from './OreEdgeNoiseTexture';

export type OreEdgeBlendUniforms = {
  enabled: { value: number };
  noise: { value: THREE.Texture | null };
  noiseTileWorldSize: { value: number };
  dirt: { value: THREE.Texture | null };
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
    noise: { value: enabled ? getOreEdgeNoiseTexture() : null },
    noiseTileWorldSize: { value: ORE_EDGE_NOISE_TILE_WORLD_SIZE },
    dirt: { value: enabled ? getOreEdgeDirtTexture() : null },
    dirtTileWorldSize: { value: ORE_EDGE_DIRT_TILE_WORLD_SIZE },
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
  shader.uniforms.uOreEdgeNoise = uniforms.noise;
  shader.uniforms.uOreEdgeNoiseTileWorldSize = uniforms.noiseTileWorldSize;
  shader.uniforms.uOreEdgeDirt = uniforms.dirt;
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
    'uniform sampler2D uOreEdgeNoise;',
    'uniform float uOreEdgeNoiseTileWorldSize;',
    'uniform sampler2D uOreEdgeDirt;',
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

/** World scales the five field taps are read at, as multiples of the noise
 *  tile. They are deliberately not powers of one another: two taps of the
 *  same channel at scales in a small integer ratio put their features in
 *  register and the sum reads as one pattern rather than as two.
 *
 *  Which channel each tap reads is fixed by what the channel IS (see
 *  OreEdgeNoiseTexture): R is the smooth mottle, G the grain, B the broad
 *  blotch. The two thickness taps must come from different scales of the
 *  smoothest channel or the blend band and the dirt band would thicken
 *  together, which is one varying width wearing two names. */
const FIELD_TAPS = {
  /** R at full tile — the lobes. */
  lobes: 1.0,
  /** R, smaller — fingers eroded into those lobes. */
  fingers: 0.3,
  /** G, small — the dissolve grain. */
  grain: 0.09,
  /** B — how wide the ore-to-ground ramp is here. */
  band: 0.55,
  /** B, broader — how far the dirt reaches here. */
  reach: 1.45,
} as const;

/** The five field taps, and the terms derived from them.
 *
 *  Sampling and USE are split because the samples must happen where
 *  derivatives are still legal and the use happens under a branch. Callers
 *  read the fields once, then pass them down. */
export const ORE_EDGE_BLEND_GLSL = [
  'struct OreEdgeFields {',
  '  float lobes;',
  '  float fingers;',
  '  float grain;',
  '  float band;',
  '  float reach;',
  '};',
  '',
  'OreEdgeFields oreEdgeSampleFields(sampler2D noiseTex, vec2 worldXZ, float tile) {',
  '  float unit = max(tile, 1.0);',
  '  OreEdgeFields fields;',
  `  fields.lobes   = texture2D(noiseTex, worldXZ / (unit * ${FIELD_TAPS.lobes.toFixed(3)})).r;`,
  // The offsets keep two taps of one channel from sharing the origin, where
  // their features would otherwise coincide exactly.
  `  fields.fingers = texture2D(noiseTex, worldXZ / (unit * ${FIELD_TAPS.fingers.toFixed(3)}) + vec2(0.37, 0.61)).r;`,
  `  fields.grain   = texture2D(noiseTex, worldXZ / (unit * ${FIELD_TAPS.grain.toFixed(3)}) + vec2(0.73, 0.19)).g;`,
  `  fields.band    = texture2D(noiseTex, worldXZ / (unit * ${FIELD_TAPS.band.toFixed(3)})).b;`,
  `  fields.reach   = texture2D(noiseTex, worldXZ / (unit * ${FIELD_TAPS.reach.toFixed(3)}) + vec2(0.11, 0.83)).b;`,
  '  return fields;',
  '}',
  '',
  '// Where the ore boundary actually falls, in the same world units the',
  '// region field is measured in. Negative is inside the ore.',
  '//',
  '// `grow` runs first and moves the whole contour outward; the warp then',
  '// erodes back into it. Without the push, a five-cell deposit — a hundred',
  '// world units across — would lose a quarter of its radius wherever the',
  '// warp happened to point inward, and the smallest deposits on the map',
  '// would read as visibly smaller than the ones a player can build on.',
  'float oreEdgeWarpedDistance(float signedDistance, OreEdgeFields fields, float grow, float warp) {',
  '  float lobe   = fields.lobes * 2.0 - 1.0;',
  '  float finger = fields.fingers * 2.0 - 1.0;',
  '  return signedDistance - grow + warp * (lobe * 0.66 + finger * 0.34);',
  '}',
  '',
  '// Ore coverage across the transition, dissolved against the grain.',
  '//',
  '// `t` is the plain ramp: 1 well inside, 0 well outside, crossing 0.5 at',
  '// the warped contour. Thresholding it against the grain instead of taking',
  '// it straight leaves the AVERAGE coverage unchanged and destroys the',
  '// uniformity — the same fraction of ore, decided per patch rather than',
  '// spread evenly, which is the difference between a soft edge and a',
  '// crumbling one.',
  '//',
  '// `distanceWidth` is the screen size of one world unit of the field,',
  '// measured by the host at top level. It is what keeps this from aliasing',
  '// when the camera pulls back — and note the grain sample itself mips',
  '// toward its own mean as the camera pulls back, so a far-away edge',
  '// recovers the smooth ramp on its own rather than sparkling.',
  '//',
  '// The clamp on the softening is load-bearing in the other direction: an',
  '// unbounded width would push the smoothstep so wide that deep interior',
  '// ore, at t = 1, resolved to partial coverage and the whole deposit went',
  '// translucent when zoomed out.',
  'float oreEdgeCoverage(',
  '  float warpedDistance,',
  '  OreEdgeFields fields,',
  '  float distanceWidth,',
  '  float bandMin,',
  '  float bandMax,',
  '  float grainStrength',
  ') {',
  '  float band = max(mix(bandMin, bandMax, fields.band), 0.001);',
  '  float t = clamp(0.5 - 0.5 * warpedDistance / band, 0.0, 1.0);',
  '  float threshold = mix(0.5, clamp(fields.grain, 0.04, 0.96), clamp(grainStrength, 0.0, 1.0));',
  '  float soft = clamp(0.5 * distanceWidth / band, 0.02, 0.5);',
  '  return smoothstep(threshold - soft, threshold + soft, t);',
  '}',
  '',
  '// The dirt band. Named ...Band because the host holds its result in an',
  '// `oreEdgeGrime` local: in GLSL a variable hides a same-named function',
  '// from its declaration onward, so the two must not collide.',
  '//',
  '// Reaches differently on the two sides — dirt spreads',
  '// further onto open ground than it does over the ore body — and both',
  '// reaches are jittered along the length of the edge, which is what makes',
  '// the band thick in stretches and tight in others instead of a traced',
  '// outline at one offset.',
  '//',
  '// The grain thins it in patches on top of that, so the dirt is not an',
  '// even halo. A halo at any width still describes the contour exactly.',
  'float oreEdgeGrimeBand(',
  '  float warpedDistance,',
  '  OreEdgeFields fields,',
  '  float innerReach,',
  '  float outerReach,',
  '  float variation,',
  '  float falloff,',
  '  float patchDepth',
  ') {',
  '  float side = step(0.0, warpedDistance);',
  '  float reach = mix(innerReach, outerReach, side);',
  '  reach *= mix(1.0 - variation, 1.0 + variation, fields.reach);',
  '  float grime = 1.0 - smoothstep(0.0, max(reach, 0.001), abs(warpedDistance));',
  '  grime = pow(grime, max(falloff, 0.001));',
  '  grime *= mix(1.0 - clamp(patchDepth, 0.0, 1.0), 1.0, fields.grain);',
  '  return clamp(grime, 0.0, 1.0);',
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
    '  OreEdgeFields oreFields = oreEdgeSampleFields(',
    '    uOreEdgeNoise,',
    `    ${worldPositionExpr}.xz,`,
    '    uOreEdgeNoiseTileWorldSize',
    '  );',
    '  float oreEdgeDistance = oreEdgeWarpedDistance(',
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
    '    uOreEdgeGrimeInner,',
    '    uOreEdgeGrimeOuter,',
    '    uOreEdgeGrimeVariation,',
    '    uOreEdgeGrimeFalloff,',
    '    uOreEdgeGrimePatchDepth',
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
 *  `sampleMetalSurfaceDetail` — the same triplanar projection the ore
 *  surface itself is read through, so the dirt lands on a cliff face the way
 *  the ore beside it does instead of smearing down it. */
export function oreEdgeAlbedoFragment(
  worldPositionExpr: string,
  geometricNormalExpr: string,
): string {
  return [
    'if (oreEdgeGrime > 0.0) {',
    '  vec3 oreEdgeDirt = sampleMetalSurfaceDetail(',
    '    uOreEdgeDirt,',
    `    ${worldPositionExpr},`,
    `    ${geometricNormalExpr},`,
    '    uOreEdgeDirtTileWorldSize',
    '  );',
    '  terrainRgb = mix(terrainRgb, oreEdgeDirt, oreEdgeGrime * uOreEdgeGrimeStrength);',
    '  // The dark line rides a TIGHTER profile than the dirt colour. Widening',
    '  // the band is what makes the transition messy, and a dark line widened',
    '  // with it stops being a contact shadow and becomes a drawn outline —',
    '  // which describes the contour more precisely than the clean edge did.',
    '  float oreEdgeSeam = pow(oreEdgeGrime, uOreEdgeGrimeSeamPower);',
    '  terrainRgb *= mix(1.0, uOreEdgeGrimeDarken, oreEdgeSeam);',
    '}',
  ].join('\n');
}
