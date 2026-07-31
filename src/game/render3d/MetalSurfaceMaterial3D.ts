// THE metal surface, and the only definition of it.
//
// Two very different renderers draw metal: MetalDepositRenderer3D builds small
// raised ore crowns, and TerrainTileRenderer3D shades a whole SURFACE = METAL
// world. They must be the same material — same albedo, same PBR response, same
// light, and same world-space texture projection — so both take their
// parameters and shader maths from here rather than each authoring their own.
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

/** Canonical world-space projection for the metal detail texture.
 *
 * Both deposit crowns and METAL terrain use the geometric face normal rather
 * than their interpolated lighting normal. Horizontal faces therefore sample
 * XZ identically, while rims and terrain cliffs receive the same triplanar
 * projection instead of stretching a top-down UV down their sides. */
export const METAL_SURFACE_TRIPLANAR_GLSL = [
  'vec3 sampleMetalSurfaceDetail(sampler2D detailTexture, vec3 worldPosition, vec3 geometricNormal, float tileWorldSize) {',
  '  vec3 weights = pow(abs(geometricNormal), vec3(8.0));',
  '  weights /= max(weights.x + weights.y + weights.z, 1.0e-5);',
  '  vec3 detailXZ = texture2D(detailTexture, worldPosition.xz / tileWorldSize).rgb;',
  '  vec3 detailYZ = texture2D(detailTexture, worldPosition.yz / tileWorldSize).rgb;',
  '  vec3 detailXY = texture2D(detailTexture, worldPosition.xy / tileWorldSize).rgb;',
  '  return detailXZ * weights.y + detailYZ * weights.x + detailXY * weights.z;',
  '}',
].join('\n');
