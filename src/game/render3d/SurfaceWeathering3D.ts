// SurfaceWeathering3D — the weathering vocabulary, and the only definition
// of it.
//
// A boundary between two materials is the most reliable tell that a world was
// authored rather than found. Every other cue can be right and a smooth
// contour of constant width still reads as a decal, because a smooth contour
// of constant width is a thing only a stencil produces.
//
// Three terms fix it, and none substitutes for another — displacement alone
// gives a wiggly stencil, dissolve alone a fuzzy one, grime alone a stencil
// with a line drawn along it:
//
//   DISPLACE   Move where the boundary is, by noise measured in the same
//              units as the quantity that defines it. Two scales: broad
//              lobes, and finer bites eroded into those lobes.
//
//   DISSOLVE   Destroy the transition's uniformity. Across the band the
//              material is either present or absent and a granular field
//              decides which, rather than distance deciding it evenly.
//
//   GRIME      Bury the join under a third substance, reaching different
//              distances into the two materials, jittered along the
//              boundary's length and thinned in patches.
//
// This module owns the maths, and the two SAMPLERS every treatment reads
// through. It owns no other uniforms, because the hosts differ in what they
// are weathering: the ore region displaces a signed distance in world units,
// the plateau wall rims displace a per-vertex proximity ramp, and the
// vegetation displaces a height above its own base. What must not differ is
// the SHAPE of the result, which is why all three call these functions rather
// than each rolling the noise algebra it happens to need.
//
// DERIVATIVES ARE THE HOST'S JOB. Every function here takes its softening
// width as a parameter. `fwidth` in non-uniform control flow is undefined,
// and a weathering treatment is nothing but branches that neighbouring
// fragments disagree about — the host measures once at top level and passes
// the width down.

import type * as THREE from 'three';
import { getSoilSubstanceTexture } from './SoilSubstanceTexture';
import { getWeatheringNoiseTexture } from './WeatheringNoiseTexture';

/** World scales the five field taps are read at, as multiples of the host's
 *  noise tile. Deliberately not powers of one another: two taps of the same
 *  channel at scales in a small integer ratio put their features in register
 *  and the sum reads as one pattern rather than as two.
 *
 *  Which channel each tap reads is fixed by what the channel IS (see
 *  WeatheringNoiseTexture): R is the smooth mottle, G the grain, B the broad
 *  blotch. The two thickness taps must come from different scales of the
 *  smoothest channel, or a transition band and the grime band over it would
 *  thicken together — one varying width wearing two names. */
export const WEATHER_FIELD_TAPS = {
  /** R at full tile — the lobes. */
  lobes: 1.0,
  /** R, smaller — fingers eroded into those lobes. */
  fingers: 0.3,
  /** G, small — the dissolve grain. */
  grain: 0.09,
  /** B — how wide the transition is here. */
  band: 0.55,
  /** B, broader — how far the grime reaches here. */
  reach: 1.45,
} as const;

/** The shared weathering functions. One GLSL block, injected once per host
 *  shader, called by every treatment that host runs.
 *
 *  Sampling and USE are split throughout: the samples happen where
 *  derivatives are still legal, the use happens under a branch. Hosts read
 *  the fields once and pass them down. */
export const SURFACE_WEATHERING_GLSL = [
  'struct WeatherFields {',
  '  float lobes;',
  '  float fingers;',
  '  float grain;',
  '  float band;',
  '  float reach;',
  '};',
  '',
  '// The plane a SURFACE\'s weather varies over. Flat ground can vary over',
  '// world XZ alone, but a wall face cannot: XZ barely changes down a',
  '// near-vertical face, so every field is constant along it and the whole',
  '// treatment streaks vertically. This is the same triplanar choice the',
  '// substance projection makes, applied to the sampling COORDINATE instead',
  '// of to three samples — which is legal here only because these are noise',
  '// fields. There is no structure for a blended coordinate to distort; the',
  '// pattern morphs through a narrow transition instead of jumping, and it',
  '// costs five taps rather than fifteen.',
  '//',
  '// Not every host wants it. The ore region is drawn from a field sampled by',
  '// world XZ with no height term, deliberately, so that an ore body draping',
  '// over relief keeps one continuous silhouette; giving its weather a height',
  '// term would tear that silhouette wherever the ground pitched.',
  'vec2 weatherSurfacePlane(vec3 position, vec3 geometricNormal) {',
  '  vec3 w = pow(abs(geometricNormal), vec3(8.0));',
  '  w /= max(w.x + w.y + w.z, 1.0e-5);',
  '  return position.xz * w.y + position.zy * w.x + position.xy * w.z;',
  '}',
  '',
  '// `plane` is whatever two axes the host wants the weather to vary over.',
  '// Terrain hands it world XZ; a static prop hands it two axes of its own',
  '// world position, which is legal precisely because it never moves — a',
  '// moving body would swim through its own weather, and would have to pass',
  '// object-space coordinates instead.',
  'WeatherFields weatherSampleFields(sampler2D noiseTex, vec2 plane, float tile) {',
  '  float unit = max(tile, 1.0);',
  '  WeatherFields fields;',
  `  fields.lobes   = texture2D(noiseTex, plane / (unit * ${WEATHER_FIELD_TAPS.lobes.toFixed(3)})).r;`,
  // The offsets keep two taps of one channel from sharing an origin, where
  // their features would otherwise coincide exactly.
  `  fields.fingers = texture2D(noiseTex, plane / (unit * ${WEATHER_FIELD_TAPS.fingers.toFixed(3)}) + vec2(0.37, 0.61)).r;`,
  `  fields.grain   = texture2D(noiseTex, plane / (unit * ${WEATHER_FIELD_TAPS.grain.toFixed(3)}) + vec2(0.73, 0.19)).g;`,
  `  fields.band    = texture2D(noiseTex, plane / (unit * ${WEATHER_FIELD_TAPS.band.toFixed(3)})).b;`,
  `  fields.reach   = texture2D(noiseTex, plane / (unit * ${WEATHER_FIELD_TAPS.reach.toFixed(3)}) + vec2(0.11, 0.83)).b;`,
  '  return fields;',
  '}',
  '',
  '// DISPLACE. Moves the boundary by up to `warp` in the units `value` is',
  '// measured in, having first pushed it by `grow` in the direction that',
  '// makes the material larger.',
  '//',
  '// Grow before you erode. Displacement symmetric about the authored',
  '// boundary makes small instances of a thing smaller, and the smallest',
  '// instance is usually the one whose size mattered — a five-cell ore',
  '// deposit is a hundred world units across and would lose a quarter of',
  '// its radius wherever the warp happened to point inward.',
  'float weatherDisplace(float value, WeatherFields fields, float grow, float warp) {',
  '  float lobe   = fields.lobes * 2.0 - 1.0;',
  '  float finger = fields.fingers * 2.0 - 1.0;',
  '  return value - grow + warp * (lobe * 0.66 + finger * 0.34);',
  '}',
  '',
  '// DISSOLVE. `presence` is the plain ramp — 1 where the material is solid,',
  '// 0 where it is gone, 0.5 at the boundary. Thresholding it against the',
  '// grain instead of taking it straight leaves the AVERAGE unchanged and',
  '// destroys the uniformity: the same fraction of material, decided per',
  '// patch rather than spread evenly, which is the difference between a soft',
  '// edge and a crumbling one.',
  '//',
  '// `softness` is the host-measured screen width of the ramp. It is what',
  '// keeps this from aliasing when the camera pulls back — and note the',
  '// grain sample itself mips toward its own mean as the camera pulls back,',
  '// so a far-away boundary recovers the smooth ramp on its own rather than',
  '// sparkling.',
  '//',
  '// The clamp on the softening is load-bearing in the other direction: an',
  '// unbounded width pushes the smoothstep so wide that solid interior, at',
  '// presence 1, resolves to partial coverage and the whole body goes',
  '// translucent when zoomed out.',
  'float weatherDissolve(float presence, WeatherFields fields, float softness, float grainStrength) {',
  '  float threshold = mix(0.5, clamp(fields.grain, 0.04, 0.96), clamp(grainStrength, 0.0, 1.0));',
  '  float soft = clamp(softness, 0.02, 0.5);',
  '  return smoothstep(threshold - soft, threshold + soft, clamp(presence, 0.0, 1.0));',
  '}',
  '',
  '// A two-sided ramp around a signed boundary: 1 at the boundary, falling to',
  '// 0 at `innerReach` on the negative side and `outerReach` on the positive',
  '// one. The two must differ and both must be non-zero — grime that lands on',
  '// only one side is an outline of the other.',
  '//',
  '// The reach is jittered along the boundary by the broad field, which is',
  '// what makes the band thick in stretches and tight in others instead of a',
  '// traced outline at one offset.',
  'float weatherBandRamp(',
  '  float signedDistance,',
  '  WeatherFields fields,',
  '  float innerReach,',
  '  float outerReach,',
  '  float variation',
  ') {',
  '  float reach = mix(innerReach, outerReach, step(0.0, signedDistance));',
  '  reach *= mix(1.0 - variation, 1.0 + variation, fields.reach);',
  '  return 1.0 - smoothstep(0.0, max(reach, 0.001), abs(signedDistance));',
  '}',
  '',
  '// Jitters a ramp a host already holds in [0,1]. Scaling the REACH by',
  '// `scale` is the same as scaling the remaining distance by its inverse,',
  '// which is what lets a host that never had a metric distance — a',
  '// per-vertex proximity, a normalized height — still get a band whose',
  '// thickness varies along its length.',
  'float weatherJitterRamp(float ramp, WeatherFields fields, float variation) {',
  '  float scale = max(mix(1.0 - variation, 1.0 + variation, fields.reach), 0.001);',
  '  return clamp(1.0 - (1.0 - clamp(ramp, 0.0, 1.0)) / scale, 0.0, 1.0);',
  '}',
  '',
  '// GRIME. Shapes a band ramp into the amount of third substance sitting on',
  '// the surface here. `falloff` above 1 pulls the grime toward the boundary;',
  '// the grain thins it in patches on top of that, because an even halo at',
  '// any width still describes the boundary exactly.',
  '//',
  '// Named ...Amount because hosts hold the result in a local named for the',
  '// treatment: in GLSL a variable hides a same-named function from its',
  '// declaration onward, and the resulting compile error is one three.js does',
  '// not report unless booted with ?shaderErrors=1 — it presents as a surface',
  '// that simply does not draw.',
  'float weatherGrimeAmount(float ramp, WeatherFields fields, float falloff, float patchDepth) {',
  '  float grime = pow(clamp(ramp, 0.0, 1.0), max(falloff, 0.001));',
  '  grime *= mix(1.0 - clamp(patchDepth, 0.0, 1.0), 1.0, fields.grain);',
  '  return clamp(grime, 0.0, 1.0);',
  '}',
  '',
  '// The albedo half, shared so a rim, an ore edge and a tree base all dirty',
  '// the same way. Two terms, not one: the substance replaces the surface,',
  '// and then the result darkens on a TIGHTER profile than it colours. The',
  '// mix alone reaches the substance and stops, but the seam where two',
  '// materials meet is darker than either of them, and widening a dark line',
  '// with the band turns a contact shadow into a drawn outline.',
  'vec3 weatherApplyGrime(',
  '  vec3 base,',
  '  vec3 substance,',
  '  float grime,',
  '  float strength,',
  '  float darken,',
  '  float seamPower',
  ') {',
  '  vec3 soiled = mix(base, substance, clamp(grime * strength, 0.0, 1.0));',
  '  float seam = pow(clamp(grime, 0.0, 1.0), max(seamPower, 0.001));',
  '  return soiled * mix(1.0, darken, seam);',
  '}',
  '',
  '// Triplanar projection of a substance texture, read from world position in',
  '// world units so a big host and a small host wear the same physical grain.',
  '// The geometric normal decides the blend, so a wall face and the flat',
  '// beside it receive the same material instead of one smearing down the',
  '// other.',
  'vec3 weatherSampleSubstance(sampler2D tex, vec3 position, vec3 geometricNormal, float tileWorldSize) {',
  '  vec3 weights = pow(abs(geometricNormal), vec3(8.0));',
  '  weights /= max(weights.x + weights.y + weights.z, 1.0e-5);',
  '  float unit = max(tileWorldSize, 1.0);',
  '  vec3 xz = texture2D(tex, position.xz / unit).rgb;',
  '  vec3 yz = texture2D(tex, position.yz / unit).rgb;',
  '  vec3 xy = texture2D(tex, position.xy / unit).rgb;',
  '  return xz * weights.y + yz * weights.x + xy * weights.z;',
  '}',
].join('\n');

// ── the shared samplers ──

/** Every treatment reads the same two textures: the noise field it displaces
 *  and dissolves with, and the soil it grimes with. Both are process-wide
 *  singletons, so a host that runs more than one treatment in ONE program
 *  binds one pair of samplers for all of them instead of a pair per
 *  treatment.
 *
 *  That is a hard budget, not tidiness. MAX_TEXTURE_IMAGE_UNITS is 16 on
 *  plenty of desktop drivers; the terrain fragment shader is the program that
 *  spends units fastest, and asking for one too many does not warn or
 *  degrade — the program fails to link and the entire terrain vanishes.
 *
 *  Only the SAMPLER is shared. Each treatment keeps its own tile-size
 *  uniforms, because how big the weather reads along a terrace rim is not how
 *  big it reads along an ore boundary. */
export const WEATHER_NOISE_SAMPLER = 'uWeatherNoise';
export const WEATHER_SOIL_SAMPLER = 'uWeatherSoil';

export type SurfaceWeatheringSamplerUniforms = {
  readonly noise: { value: THREE.Texture | null };
  readonly soil: { value: THREE.Texture | null };
};

/** `enabled` is "does this host run ANY weathering treatment": both textures
 *  are generated on first request, so a host with every treatment switched
 *  off must not ask for them. */
export function createSurfaceWeatheringSamplerUniforms(
  enabled: boolean,
): SurfaceWeatheringSamplerUniforms {
  return {
    noise: { value: enabled ? getWeatheringNoiseTexture() : null },
    soil: { value: enabled ? getSoilSubstanceTexture() : null },
  };
}

export function surfaceWeatheringSamplerDeclarations(): string {
  return [
    `uniform sampler2D ${WEATHER_NOISE_SAMPLER};`,
    `uniform sampler2D ${WEATHER_SOIL_SAMPLER};`,
  ].join('\n');
}

export function assignSurfaceWeatheringSamplerUniforms(
  shader: { uniforms: Record<string, unknown> },
  uniforms: SurfaceWeatheringSamplerUniforms,
): void {
  shader.uniforms[WEATHER_NOISE_SAMPLER] = uniforms.noise;
  shader.uniforms[WEATHER_SOIL_SAMPLER] = uniforms.soil;
}
