// TerrainSubstanceMaterial3D — the world's own ground and rock substances, on
// an object that is not the terrain.
//
// The terrain shader spends most of its length DECIDING which substance a
// fragment is: height above the zero plane, neighbourhood slope, shoreline,
// ore coverage, wall rims. An object that is made of one substance has no such
// decision to make. What it needs is the substance itself, mixed the way the
// terrain mixes it once it has decided — the base colour, the detail tile at
// its authored world size, and the broad field layers over both — so a slab
// quarried out of the world looks like the world rather than like a prop
// wearing one of its textures.
//
// The tile sizes are world units, not uvs, which is the whole point: a
// caption plinth and a mountainside are the same physical grain, and an object
// that changes size changes how much of the tile it shows rather than
// stretching it.

import * as THREE from 'three';
import {
  TERRAIN_GROUND_BASE_COLOR,
  TERRAIN_GROUND_DETAIL_CONTRAST,
  TERRAIN_GROUND_DETAIL_ENABLED,
  TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE,
  TERRAIN_ROCK_BASE_COLOR,
  TERRAIN_ROCK_DETAIL_CONTRAST,
  TERRAIN_ROCK_DETAIL_ENABLED,
  TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';
import { getGroundDetailTexture } from './GroundDetailTexture';
import { getRockDetailTexture } from './RockDetailTexture';
import {
  createSurfaceFieldUniforms,
  assignSurfaceFieldUniforms,
  surfaceFieldLayeredCall,
  surfaceFieldLayeredTriplanarCall,
  surfaceFieldUniformDeclarations,
  SURFACE_FIELD_GLSL,
  SURFACE_FIELD_TRIPLANAR_GLSL,
} from './SurfaceFieldTexture';
import { SURFACE_WEATHERING_GLSL } from './SurfaceWeathering3D';

/** Which of the world's two everyday substances an object is made of. Metal is
 *  deliberately absent: ore is a coverage the terrain computes per fragment
 *  from a baked region, not a material anything is carved from. */
export type TerrainSubstance = 'ground' | 'rock';

type SubstanceRecipe = {
  readonly texture: () => THREE.Texture;
  readonly enabled: boolean;
  readonly tileWorldSize: number;
  readonly baseColor: number;
  readonly contrast: number;
};

const RECIPES: Record<TerrainSubstance, SubstanceRecipe> = {
  ground: {
    texture: getGroundDetailTexture,
    enabled: TERRAIN_GROUND_DETAIL_ENABLED,
    tileWorldSize: TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE,
    baseColor: TERRAIN_GROUND_BASE_COLOR,
    contrast: TERRAIN_GROUND_DETAIL_CONTRAST,
  },
  rock: {
    texture: getRockDetailTexture,
    enabled: TERRAIN_ROCK_DETAIL_ENABLED,
    tileWorldSize: TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE,
    baseColor: TERRAIN_ROCK_BASE_COLOR,
    contrast: TERRAIN_ROCK_DETAIL_CONTRAST,
  },
};

/** The terrain's colour convention: authored hex bytes ARE working-space
 *  values (rawSrgbVec3 in TerrainTileRenderer3D), so they go in with no sRGB
 *  decode, or a slab reads darker than the ground it was cut from. */
function rawSrgbVec3(hex: number): THREE.Vector3 {
  return new THREE.Vector3(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  );
}

/** Ground is sampled from world XZ at two co-prime scales and rotations and
 *  blended by a slow positional wobble, so the apparent repeat is the two
 *  scales' beat rather than the tile — the same trick, and the same constants,
 *  the terrain's flat-green zone uses. */
const GROUND_ALBEDO_GLSL = [
  '  vec2 worldXZ = vSubstanceWorldPos.xz;',
  '  vec2 uvA = worldXZ / uSubstanceTileWorldSize;',
  '  mat2 secondaryRot = mat2(0.7174, 0.6967, -0.6967, 0.7174);',
  '  vec2 uvB = (secondaryRot * worldXZ) / (uSubstanceTileWorldSize * 0.7367);',
  '  vec4 detailA = texture2D(uSubstanceTexture, uvA);',
  '  vec4 detailB = texture2D(uSubstanceTexture, uvB);',
  '  float bx = sin(worldXZ.x * 0.0089 + worldXZ.y * 0.0067);',
  '  float bz = cos(worldXZ.x * 0.0073 - worldXZ.y * 0.0091);',
  '  vec4 detail = mix(detailA, detailB, clamp(0.5 + 0.55 * bx * bz, 0.0, 1.0));',
  '  substance = mix(substance, detail.rgb, detail.a * uSubstanceContrast);',
  `  substance = ${surfaceFieldLayeredCall('ground', 'substance', 'worldXZ')};`,
].join('\n');

/** Rock is triplanar, blended by the INTERPOLATED normal — the same choice the
 *  terrain makes, and for the same reason: the face normal is constant across
 *  a triangle, so projecting through it draws the object's triangulation onto
 *  its own surface. */
const ROCK_ALBEDO_GLSL = [
  '  vec3 triW = pow(abs(normalize(vSubstanceWorldNormal)), vec3(8.0));',
  '  triW /= max(triW.x + triW.y + triW.z, 1e-5);',
  '  vec4 rockXZ = texture2D(uSubstanceTexture, vSubstanceWorldPos.xz / uSubstanceTileWorldSize);',
  '  vec4 rockYZ = texture2D(uSubstanceTexture, vSubstanceWorldPos.yz / uSubstanceTileWorldSize);',
  '  vec4 rockXY = texture2D(uSubstanceTexture, vSubstanceWorldPos.xy / uSubstanceTileWorldSize);',
  '  vec4 detail = rockXZ * triW.y + rockYZ * triW.x + rockXY * triW.z;',
  '  substance = mix(substance, detail.rgb, detail.a * uSubstanceContrast);',
  `  substance = ${surfaceFieldLayeredTriplanarCall(
    'rock',
    'substance',
    'vSubstanceWorldPos',
    'normalize(vSubstanceWorldNormal)',
  )};`,
].join('\n');

/**
 * Patch `material` so its albedo is the world's `substance`. Idempotent per
 * material, like every other material patch in the renderer, because a second
 * onBeforeCompile would stack a second copy of the same injection.
 */
export function applyTerrainSubstanceMaterial(
  material: THREE.MeshStandardMaterial,
  substance: TerrainSubstance,
): void {
  if (material.userData.terrainSubstance === substance) return;
  material.userData.terrainSubstance = substance;

  const recipe = RECIPES[substance];
  const fields = createSurfaceFieldUniforms(substance, recipe.enabled);
  const uniforms = {
    texture: { value: recipe.enabled ? recipe.texture() : null },
    tileWorldSize: { value: recipe.tileWorldSize },
    baseColor: { value: rawSrgbVec3(recipe.baseColor) },
    contrast: { value: recipe.enabled ? recipe.contrast : 0 },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSubstanceTexture = uniforms.texture;
    shader.uniforms.uSubstanceTileWorldSize = uniforms.tileWorldSize;
    shader.uniforms.uSubstanceBaseColor = uniforms.baseColor;
    shader.uniforms.uSubstanceContrast = uniforms.contrast;
    assignSurfaceFieldUniforms(shader, substance, fields);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          'varying vec3 vSubstanceWorldPos;',
          'varying vec3 vSubstanceWorldNormal;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <worldpos_vertex>',
        [
          '#include <worldpos_vertex>',
          'vSubstanceWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          'vSubstanceWorldNormal = normalize(mat3(modelMatrix) * normal);',
        ].join('\n'),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          'uniform sampler2D uSubstanceTexture;',
          'uniform float uSubstanceTileWorldSize;',
          'uniform vec3 uSubstanceBaseColor;',
          'uniform float uSubstanceContrast;',
          surfaceFieldUniformDeclarations(substance),
          SURFACE_WEATHERING_GLSL,
          SURFACE_FIELD_GLSL,
          SURFACE_FIELD_TRIPLANAR_GLSL,
          'varying vec3 vSubstanceWorldPos;',
          'varying vec3 vSubstanceWorldNormal;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '{',
          '  vec3 substance = uSubstanceBaseColor;',
          substance === 'ground' ? GROUND_ALBEDO_GLSL : ROCK_ALBEDO_GLSL,
          '  diffuseColor.rgb *= substance;',
          '}',
        ].join('\n'),
      );
  };
  // Three keys its program cache on material PARAMETERS, not on the source a
  // patch produced, so two standard materials that differ only in their
  // onBeforeCompile silently share one compiled program. The substance has to
  // be in the key or the rock slab renders as grass.
  material.customProgramCacheKey = () => `terrain-substance-${substance}`;
  material.needsUpdate = true;
}
