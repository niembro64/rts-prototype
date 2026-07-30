// THE metal surface, and the only definition of it.
//
// Two very different renderers draw metal: MetalDepositRenderer3D builds small
// faceted ore crowns, and TerrainTileRenderer3D shades a whole SURFACE = METAL
// world. They must be the same material — same albedo, same PBR response, same
// light — so both take their parameters and their shader maths from here
// rather than each authoring their own.
//
// Everything below resolves from ONE colorsConfig entry,
// `environment.metalDeposit`: retune a deposit and the metal world follows.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  METAL_DEPOSIT_ROCK_TEXTURE_BLEND,
  METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';

/** The authored metal surface. `color` is the sRGB ore base three.js decodes
 *  to linear working space; the rock detail texture is multiplied over it as
 *  the material's `map` at `rockTextureBlend`, tiled every
 *  `rockTileWorldSize` world units. */
export const METAL_SURFACE_MATERIAL = {
  color: COLORS.environment.metalDeposit.baseColorHex,
  metalness: COLORS.environment.metalDeposit.standardMaterial.metalness,
  roughness: COLORS.environment.metalDeposit.standardMaterial.roughness,
  flatShading: COLORS.environment.metalDeposit.standardMaterial.flatShading,
  rockTileWorldSize: METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE,
  rockTextureBlend: METAL_DEPOSIT_ROCK_TEXTURE_BLEND,
} as const;

/** The metal surface's PBR half, for a THREE.MeshStandardMaterial.
 *
 *  `envMapIntensity` is deliberately absent: neither surface sets it, so both
 *  take three.js's default of 1 and reflect `scene.environment` identically.
 *  Setting it on one and not the other is exactly how the two drifted apart
 *  before. `flatShading` is NOT included — that is a property of the geometry
 *  being shaded (a faceted coin vs. a smooth terrain mesh), not of the
 *  material's response to light, and forcing it on terrain would facet the
 *  entire world. */
export function metalSurfaceStandardParameters(): THREE.MeshStandardMaterialParameters {
  return {
    metalness: METAL_SURFACE_MATERIAL.metalness,
    roughness: METAL_SURFACE_MATERIAL.roughness,
  };
}

/** GLSL for the metal albedo, shared verbatim by both renderers' injected
 *  shaders so the maths cannot drift.
 *
 *  This is three.js's own `<map_fragment>` semantics spelled out: the decoded
 *  base colour multiplied by the rock texel at the material's map blend. The
 *  texel is raw LinearSRGB (the texture is created with
 *  LinearSRGBColorSpace), so it is used undecoded and only ever darkens or
 *  tints the base.
 *
 *  Callers must supply `baseLinear` already in linear working space — three.js
 *  decodes material/vertex colours for you, so a uniform built from a
 *  THREE.Color is already correct. */
export const METAL_SURFACE_ALBEDO_GLSL = [
  'vec3 metalSurfaceAlbedo(vec3 baseLinear, vec3 detailTexel, float blend) {',
  '  return baseLinear * mix(vec3(1.0), detailTexel, clamp(blend, 0.0, 1.0));',
  '}',
].join('\n');
