// THE metal surface, and the only definition of it.
//
// Metal is drawn in exactly one place now — the terrain — under two
// coverages: a SURFACE = METAL world where the whole map is ore, and an
// ordinary world where individual deposits are ore regions. They are the
// same material by construction: one coverage term selects between them,
// so there is no second metal shader that can drift.
//
// (There used to be a third: MetalDepositRenderer3D built raised ore
// crowns as separate meshes with a duplicate copy of this response, and
// hand-flipped its cap normal to imitate how the DoubleSide terrain
// lights a flat metal world. Shading the region on the terrain itself
// inherits that for free, so the crown and its hack are both gone.)
//
// Everything below resolves from ONE colorsConfig entry,
// `environment.metalDeposit`: retune a deposit and the metal world follows.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  METAL_DEPOSIT_ROCK_TEXTURE_BLEND,
  METAL_DEPOSIT_ROCK_TEXTURE_CONTRAST,
  METAL_DEPOSIT_ROCK_TEXTURE_LIT_COLOR_BLEND,
  METAL_DEPOSIT_ROCK_TEXTURE_ROUGHNESS_VARIATION,
  METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';

/** The authored metal surface. `color` is the sRGB ore base three.js decodes
 *  to linear working space. The shared shader applies the rock detail before
 *  lighting at `rockTextureBlend`, then preserves its dark structure after
 *  lighting at `rockTextureLitColorBlend`; both projections tile every
 *  `rockTileWorldSize` world units. */
export const METAL_SURFACE_MATERIAL = {
  color: COLORS.environment.metalDeposit.baseColorHex,
  metalness: COLORS.environment.metalDeposit.standardMaterial.metalness,
  roughness: COLORS.environment.metalDeposit.standardMaterial.roughness,
  rockTileWorldSize: METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE,
  rockTextureBlend: METAL_DEPOSIT_ROCK_TEXTURE_BLEND,
  rockTextureLitColorBlend: METAL_DEPOSIT_ROCK_TEXTURE_LIT_COLOR_BLEND,
  rockTextureContrast: METAL_DEPOSIT_ROCK_TEXTURE_CONTRAST,
  rockTextureRoughnessVariation: METAL_DEPOSIT_ROCK_TEXTURE_ROUGHNESS_VARIATION,
} as const;

/** The metal surface's PBR half, for a THREE.MeshStandardMaterial.
 *
 *  `envMapIntensity` is deliberately absent: neither surface sets it, so both
 *  take three.js's default of 1 and reflect `scene.environment` identically.
 *  Setting it on one and not the other is exactly how the two drifted apart
 *  before. Surface normals are likewise owned by the renderers' geometry, not
 *  duplicated as a material parameter. */
export function metalSurfaceStandardParameters(): THREE.MeshStandardMaterialParameters {
  return {
    metalness: METAL_SURFACE_MATERIAL.metalness,
    roughness: METAL_SURFACE_MATERIAL.roughness,
  };
}

/** GLSL for the metal texture response, shared verbatim by both renderers'
 *  injected shaders so the maths cannot drift.
 *
 *  The raw LinearSRGB rock texel is contrast-expanded around the texture's
 *  authored midtone before it modulates albedo. It also varies roughness:
 *  dark fractures are rougher and bright slabs are smoother, so the detail
 *  remains visible through the environment reflection instead of being
 *  overwhelmed by one broad highlight.
 *
 *  Callers must supply `baseLinear` already in linear working space — three.js
 *  decodes material/vertex colours for you, so a uniform built from a
 *  THREE.Color is already correct. */
export const METAL_SURFACE_RESPONSE_GLSL = [
  'vec3 metalSurfaceContrastedDetail(vec3 detailTexel, float contrast) {',
  '  const vec3 authoredMidtone = vec3(0.36);',
  '  return clamp(',
  '    (detailTexel - authoredMidtone) * max(contrast, 0.0) + authoredMidtone,',
  '    vec3(0.04),',
  '    vec3(1.0)',
  '  );',
  '}',
  '',
  'vec3 metalSurfaceAlbedo(vec3 baseLinear, vec3 detailTexel, float blend, float contrast) {',
  '  vec3 detail = metalSurfaceContrastedDetail(detailTexel, contrast);',
  '  return baseLinear * mix(vec3(1.0), detail, clamp(blend, 0.0, 1.0));',
  '}',
  '',
  '// Preserve dark rock detail after lighting so broad PBR reflections cannot',
  '// wash the surface back to a flat color at grazing angles. Normalize around',
  '// the authored texture midtone so this changes contrast, not the chosen base',
  '// color, and use luma so neutral reflections do not pick up a color cast.',
  'vec3 metalSurfaceLitColor(vec3 litColor, vec3 detailTexel, float contrast, float blend) {',
  '  vec3 detail = metalSurfaceContrastedDetail(detailTexel, contrast);',
  '  float luma = dot(detail, vec3(0.299, 0.587, 0.114));',
  '  float normalizedDarkDetail = clamp(luma / 0.36, 0.18, 1.0);',
  '  return litColor * mix(1.0, normalizedDarkDetail, clamp(blend, 0.0, 1.0));',
  '}',
  '',
  'float metalSurfaceRoughness(float baseRoughness, vec3 detailTexel, float contrast, float variation) {',
  '  vec3 detail = metalSurfaceContrastedDetail(detailTexel, contrast);',
  '  float luma = dot(detail, vec3(0.299, 0.587, 0.114));',
  '  float slabSignal = smoothstep(0.06, 0.80, luma);',
  '  return clamp(',
  '    baseRoughness + (0.5 - slabSignal) * clamp(variation, 0.0, 1.0),',
  '    0.12,',
  '    1.0',
  '  );',
  '}',
].join('\n');

/** Ore coverage from the baked region field — the term that turns "the
 *  whole map is metal" into "this part of the map is metal".
 *
 *  Three functions, not one, because the distance is worth more than the
 *  coverage: MetalDepositEdgeBlend3D displaces and dissolves that distance
 *  to weather the boundary, and it can only do that if it gets the metric
 *  value rather than an already-resolved [0,1].
 *
 *  The field stores signed distance to the ore edge (negative inside)
 *  encoded over ±`edgeRange`, sampled by world XZ with no height term,
 *  which is why an ore body wider than its flat pad simply continues
 *  down the surrounding relief instead of stopping at the flat.
 *
 *  The edge is resolved against the SCREEN gradient of that distance, so
 *  it stays one pixel soft at every camera distance rather than aliasing
 *  when zoomed out. `fwidth` is bounded on both ends because a derivative
 *  is only meaningful here between "one texel" and "the encoded range" —
 *  past the top the field saturates and the smoothstep would be reading
 *  noise. `edgeFeather` widens it deliberately for a soft ore-to-ground
 *  transition; 0 leaves the edge crisp.
 *
 *  THE SCREEN WIDTH IS ITS OWN FUNCTION because it is the only one of the
 *  three that may not be called under a branch. A derivative in non-uniform
 *  control flow is undefined, and the edge treatment's early-out is
 *  precisely a branch neighbouring fragments disagree about. Sampling the
 *  width at top level and passing it down is what keeps that legal. */
export const METAL_SURFACE_REGION_GLSL = [
  'float metalSurfaceRegionDistance(',
  '  sampler2D regionField,',
  '  vec2 fieldWorldSize,',
  '  vec3 worldPosition,',
  '  float edgeRange',
  ') {',
  '  vec2 uv = worldPosition.xz / max(fieldWorldSize, vec2(1.0));',
  '  // 16-bit distance, split hi/lo across R and G. The recombination is',
  '  // linear in both channels, so the bilinear/mip-filtered channels',
  '  // recombine to exactly the filtered distance.',
  '  // (`packed` is a reserved word in GLSL ES, hence the name.)',
  '  vec2 encodedPair = texture2D(regionField, clamp(uv, vec2(0.0), vec2(1.0))).rg;',
  '  float encoded = dot(encodedPair, vec2(65280.0, 255.0)) / 65535.0;',
  '  return (encoded * 2.0 - 1.0) * edgeRange;',
  '}',
  '',
  '// MUST be called at top level — fwidth under non-uniform control flow is',
  '// undefined, and the callers below are all branched.',
  'float metalSurfaceRegionScreenWidth(float signedDistance, float edgeRange) {',
  '  return clamp(fwidth(signedDistance), 0.25, edgeRange);',
  '}',
  '',
  'float metalSurfaceRegionCoverage(',
  '  float signedDistance,',
  '  float screenWidth,',
  '  float edgeFeather',
  ') {',
  '  float width = max(edgeFeather, screenWidth);',
  '  return 1.0 - smoothstep(-width, width, signedDistance);',
  '}',
].join('\n');

/** How a host layers the metal surface onto an ordinary one, by ore
 *  coverage. Exported as source rather than inlined at the injection site
 *  so the shipped strings are readable by a contract test — a shader
 *  interface is the one contract the type system cannot check.
 *
 *  All four assume the host has already declared `metalPbrCoverage` in
 *  [0,1] and `metalDetail` from weatherSampleSubstance.
 *
 *  WHY `metalPbrCoverage` AND NOT `metalCoverage`. The two differ only in
 *  the ore's dirty rim, and only in one direction: the rim is still ore
 *  geologically — it takes the ore albedo, and the outward-normal
 *  correction still applies to it — but it is buried under dirt, and dirt
 *  has no metal reflection. Handing these four terms the geometric
 *  coverage would give the rim a full specular highlight tracing the
 *  boundary, which reads as a crisp edge no matter how much dirt is
 *  painted over it. The host owns the relationship between the two; this
 *  block only insists on being told which one it is getting. */
export const METAL_SURFACE_LAYER_GLSL = {
  /** At `#include <roughnessmap_fragment>`. The host material stays at its
   *  own roughness; the metal roughness is a uniform so ore can be layered
   *  on without making the whole host metal. */
  roughness: [
    'roughnessFactor = mix(',
    '  roughnessFactor,',
    '  metalSurfaceRoughness(',
    '    uMetalSurfaceRoughness,',
    '    metalDetail,',
    '    uMetalSurfaceContrast,',
    '    uMetalSurfaceRoughnessVariation',
    '  ),',
    '  metalPbrCoverage',
    ');',
  ].join('\n'),

  /** At `#include <metalnessmap_fragment>`. */
  metalness: 'metalnessFactor = mix(metalnessFactor, uMetalSurfaceMetalness, metalPbrCoverage);',

  /** Immediately BEFORE the host declares `outgoingLight`, while
   *  `totalSpecular` is still assignable.
   *
   *  This is the line that lets a diffuse-only surface share a PBR
   *  material with metal without changing. MeshLambertMaterial has no
   *  specular path at all — no image-based reflection, no direct GGX lobe
   *  — so scaling accumulated specular by ore coverage reproduces it
   *  exactly at coverage 0, while ore at coverage 1 keeps the full
   *  reflection its material is supposed to have. Diffuse already matches:
   *  at metalness 0 the physical model's diffuseColor is the Lambert one.
   *  The dirty rim rides the same line at a fractional coverage, which is
   *  how it comes out matte rather than as a dark polished band.
   *
   *  Drop this and every non-ore surface silently gains a specular sheen. */
  specularGate: 'totalSpecular *= metalPbrCoverage;',

  /** Immediately AFTER the host declares `outgoingLight`. Preserves the
   *  dark rock structure through a broad reflection. */
  litColor: [
    'outgoingLight = mix(outgoingLight, metalSurfaceLitColor(',
    '  outgoingLight,',
    '  metalDetail,',
    '  uMetalSurfaceContrast,',
    '  uMetalSurfaceLitColorBlend',
    '), metalPbrCoverage);',
  ].join('\n'),
} as const;

/** Compose the host's `outgoingLight` patch with the metal layer in the
 *  ONLY order that works.
 *
 *  `totalSpecular` must be scaled BEFORE the declaration that sums it into
 *  `outgoingLight`, and the lit-colour blend must come AFTER — both are
 *  plain assignments, so getting either the wrong side of the declaration
 *  compiles fine and silently does nothing. Building the block here, and
 *  pinning the order in a contract test, is cheaper than finding out from a
 *  screenshot that ordinary ground picked up a sheen.
 *
 *  `trailingHostLines` are the host's own post-lighting terms (rim blends,
 *  depth dimming), which run after the metal layer. */
export function metalSurfaceOutgoingLightPatch(
  outgoingLightDeclaration: string,
  trailingHostLines: readonly string[] = [],
): string {
  return [
    METAL_SURFACE_LAYER_GLSL.specularGate,
    outgoingLightDeclaration,
    METAL_SURFACE_LAYER_GLSL.litColor,
    ...trailingHostLines,
  ].join('\n');
}

/** Uniform block the layer above reads. Declared here with the code that
 *  consumes it: an unsupplied uniform is silently zero, so the two halves
 *  must never be edited apart. */
export function metalSurfaceLayerUniformDeclarations(): string {
  return [
    'uniform vec3 uMetalSurfaceColor;',
    'uniform float uMetalSurfaceTileWorldSize;',
    'uniform float uMetalSurfaceBlend;',
    'uniform float uMetalSurfaceLitColorBlend;',
    'uniform float uMetalSurfaceContrast;',
    'uniform float uMetalSurfaceRoughnessVariation;',
    'uniform float uMetalSurfaceMetalness;',
    'uniform float uMetalSurfaceRoughness;',
  ].join('\n');
}

/* The metal detail texture is projected by `weatherSampleSubstance`
 * (SurfaceWeathering3D), which is the same triplanar every weathering
 * substance uses: read from world position in world units, blended by the
 * geometric face normal rather than the interpolated lighting normal, so
 * horizontal faces sample XZ identically while rims and cliffs receive a
 * real projection instead of a stretched top-down uv.
 *
 * It used to be a second copy here under its own name. Two identical
 * projections is exactly how one material starts landing at a different
 * physical size from another that is supposed to be the same stock.
 */
