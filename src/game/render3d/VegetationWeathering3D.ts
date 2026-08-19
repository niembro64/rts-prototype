// VegetationWeathering3D — Nothing In The World Has A Clean Edge, applied to
// everything that grows.
//
// A plant has two boundaries and both were drawn clean. Where it meets the
// GROUND, a trunk ended in a perfect ellipse on the terrain and a blade of
// grass started at full colour on the first pixel above it. Where it meets
// the AIR, a crown was one flat green mass of facets, every leaf the same
// green as every other leaf on every other tree on the map.
//
// The same three terms fix both, read from the same noise tile as the ore
// edge and the plateau rims (SurfaceWeathering3D), so a tree standing at the
// bottom of a worn terrace is dirty in the same way the terrace is:
//
//   the SOIL climbs the base of every plant, displaced and dissolved and
//   jittered so it is not a collar;
//   DRY patches dissolve through the live colour, so a crown has dead needles
//   in it and a sward has straw in it, decided per patch rather than spread;
//   DUST settles on what faces up, which is most of what separates a canopy
//   from a green shape.
//
// ── WORLD UNITS, NOT UVs ───────────────────────────────────────────────────
//
// The bark and leaf tiles were sampled through the models' uvs at an authored
// repeat count, so a big tree and a small tree wore bark at DIFFERENT PHYSICAL
// SIZES. That is the texel-density rule broken on the most numerous object in
// the world — detail belonging to the camera and to the model's unwrap rather
// than to the object. Every surface here is now projected from world position
// at an authored world size instead.
//
// World position, not object space, and that is a deliberate exception to the
// grain rule. Object space is required for anything that MOVES, because a
// moving body swims through a world-projected texture and a turning one
// rotates inside it. Vegetation never moves — there is no wind animation on
// props, they are placed once and instanced — so world projection is legal,
// and it buys something object space cannot: every instance of one template
// is unique, because its texture comes from WHERE IT GREW. Two identical
// spruces a metre apart are different trees. If props are ever animated, this
// is the line that has to change first.
//
// ── ONE CHOKE POINT ────────────────────────────────────────────────────────
//
// Applied in `EnvironmentPropRenderer3D.sharedMaterial`, which every
// vegetation material passes through — trunk, foliage and grass, textured
// close tier and flat reduced tiers alike. Patching only the textured tier
// would make the weathering pop on and off as a prop crosses a detail rung,
// so the reduced tiers take the weathering without the map and shed only what
// the map was carrying.

import * as THREE from 'three';
import {
  SOIL_SUBSTANCE_TILE_WORLD_SIZE,
  VEGETATION_WEATHERING,
} from '../../config';
import { SURFACE_WEATHERING_GLSL } from './SurfaceWeathering3D';
import { getSoilSubstanceTexture } from './SoilSubstanceTexture';
import { getWeatheringNoiseTexture } from './WeatheringNoiseTexture';

/** What a material is made of, which decides which terms it takes. */
export type VegetationWeatherRole = 'trunk' | 'foliage' | 'grass';

/** The world size of one wrap of this role's own surface tile. */
function tileWorldSizeFor(role: VegetationWeatherRole): number {
  if (role === 'trunk') return VEGETATION_WEATHERING.barkTileWorldSize;
  if (role === 'grass') return VEGETATION_WEATHERING.grassTileWorldSize;
  return VEGETATION_WEATHERING.foliageTileWorldSize;
}

/** Vertex-stage additions: the world position, the world normal, and the
 *  height above the plant's OWN base.
 *
 *  The height is what makes the soil term a property of the plant rather than
 *  of the terrain: measured against the instance origin, a trunk on a hillside
 *  is dirty at its own foot, not at whatever altitude the flat happens to be. */
const VEGETATION_WEATHER_VERTEX = [
  '#ifdef USE_INSTANCING',
  '  vec4 vegWeatherWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);',
  '  vec3 vegWeatherOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;',
  '  vVegWeatherNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);',
  '#else',
  '  vec4 vegWeatherWorld = modelMatrix * vec4(transformed, 1.0);',
  '  vec3 vegWeatherOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;',
  '  vVegWeatherNormal = normalize(mat3(modelMatrix) * normal);',
  '#endif',
  'vVegWeatherWorld = vegWeatherWorld.xyz;',
  'vVegWeatherHeight = vegWeatherWorld.y - vegWeatherOrigin.y;',
].join('\n');

/** Replaces three's uv map lookup with the world-projected one.
 *
 *  Keeping `texture2D(map, ...)` rather than reimplementing the whole chunk
 *  matters: three converts an sRGB map in the SAMPLER on WebGL2, not in the
 *  shader, so the texel is already linear here exactly as it was before. */
const VEGETATION_WEATHER_MAP = [
  '#ifdef USE_MAP',
  '  diffuseColor.rgb *= weatherSampleSubstance(',
  '    map,',
  '    vVegWeatherWorld,',
  '    normalize(vVegWeatherNormal),',
  '    uVegWeatherTileWorldSize',
  '  );',
  '#endif',
].join('\n');

/** The weathering itself, applied to `diffuseColor.rgb` after the map. */
function vegetationWeatherFragment(role: VegetationWeatherRole): string {
  const lines: string[] = [
    'if (uVegWeatherEnabled > 0.0) {',
    '  vec3 vegNormal = normalize(vVegWeatherNormal);',
    '  WeatherFields vegFields = weatherSampleFields(',
    '    uVegWeatherNoise,',
    '    weatherSurfacePlane(vVegWeatherWorld, vegNormal),',
    '    uVegWeatherNoiseTileWorldSize',
    '  );',
  ];

  // DRY. Dissolved, not blended: a canopy with an even wash of brown over it
  // is a browner canopy, where a canopy with dead patches in it is a canopy.
  // The presence ramp is centred on the coverage so the dissolve's own
  // threshold decides how much of the surface goes dry.
  lines.push(
    '  float vegDry = weatherDissolve(',
    '    clamp(1.0 - uVegWeatherDryCoverage, 0.0, 1.0),',
    '    vegFields,',
    // No derivative available or wanted: this is a colour dissolve on a
    // small, densely-facetted surface, and the softness that reads best is
    // the one that keeps the patches legible at every distance.
    '    0.16,',
    '    uVegWeatherGrainStrength',
    '  );',
    '  diffuseColor.rgb = mix(diffuseColor.rgb, uVegWeatherDryColor, vegDry * uVegWeatherDryAmount);',
  );

  if (role !== 'trunk') {
    // DUST, gated on the normal's up component. The tops of leaves pale and
    // their undersides do not; that split is most of what stops a low-poly
    // crown reading as one solid green shape.
    lines.push(
      '  float vegUp = clamp(vegNormal.y, 0.0, 1.0);',
      '  float vegDust = vegUp * vegUp * mix(0.35, 1.0, vegFields.band);',
      '  diffuseColor.rgb = mix(diffuseColor.rgb, uVegWeatherDustColor, vegDust * uVegWeatherDustAmount);',
    );
  } else {
    // A trunk instead takes a broad damp/dry mottle along its length — bark
    // is wet on one side of a tree and bleached on the other, and a trunk
    // that is one even brown is the same tell as a crown that is one even
    // green.
    lines.push(
      '  float vegMottle = mix(0.72, 1.22, vegFields.band);',
      '  diffuseColor.rgb *= mix(1.0, vegMottle, uVegWeatherTrunkAmount);',
    );
  }

  // SOIL at the base. Gated so the substance taps are only paid where the
  // plant actually meets the ground — the top of a tree is most of its
  // fragments and none of its dirt.
  lines.push(
    '  float vegBaseRamp = 1.0 - smoothstep(0.0, uVegWeatherBaseHeight, max(vVegWeatherHeight, 0.0));',
    '  if (vegBaseRamp > 0.0) {',
    '    float vegSoilRamp = weatherJitterRamp(',
    '      vegBaseRamp, vegFields, uVegWeatherBaseVariation',
    '    );',
    '    float vegGrime = weatherGrimeAmount(',
    '      vegSoilRamp, vegFields, uVegWeatherBaseFalloff, uVegWeatherBasePatchDepth',
    '    );',
    '    vec3 vegSoil = weatherSampleSubstance(',
    '      uVegWeatherSoil,',
    '      vVegWeatherWorld,',
    '      vegNormal,',
    '      uVegWeatherSoilTileWorldSize',
    '    );',
    '    diffuseColor.rgb = weatherApplyGrime(',
    '      diffuseColor.rgb,',
    '      vegSoil,',
    '      vegGrime,',
    '      uVegWeatherBaseStrength,',
    '      uVegWeatherBaseDarken,',
    '      uVegWeatherBaseSeamPower',
    '    );',
    '  }',
    '}',
  );
  return lines.join('\n');
}

function uniformDeclarations(): string {
  return [
    'uniform float uVegWeatherEnabled;',
    'uniform sampler2D uVegWeatherNoise;',
    'uniform sampler2D uVegWeatherSoil;',
    'uniform float uVegWeatherNoiseTileWorldSize;',
    'uniform float uVegWeatherSoilTileWorldSize;',
    'uniform float uVegWeatherTileWorldSize;',
    'uniform float uVegWeatherBaseHeight;',
    'uniform float uVegWeatherBaseStrength;',
    'uniform float uVegWeatherBaseDarken;',
    'uniform float uVegWeatherBaseSeamPower;',
    'uniform float uVegWeatherBaseFalloff;',
    'uniform float uVegWeatherBasePatchDepth;',
    'uniform float uVegWeatherBaseVariation;',
    'uniform float uVegWeatherGrainStrength;',
    'uniform vec3 uVegWeatherDryColor;',
    'uniform float uVegWeatherDryAmount;',
    'uniform float uVegWeatherDryCoverage;',
    'uniform vec3 uVegWeatherDustColor;',
    'uniform float uVegWeatherDustAmount;',
    'uniform float uVegWeatherTrunkAmount;',
  ].join('\n');
}

const VARYINGS = [
  'varying vec3 vVegWeatherWorld;',
  'varying vec3 vVegWeatherNormal;',
  'varying float vVegWeatherHeight;',
].join('\n');

/** Source strings a contract test can read, since a shader interface is the
 *  one contract the type system cannot check. */
export const VEGETATION_WEATHERING_SOURCE = {
  uniformDeclarations,
  varyings: VARYINGS,
  vertex: VEGETATION_WEATHER_VERTEX,
  map: VEGETATION_WEATHER_MAP,
  fragment: vegetationWeatherFragment,
} as const;

/** Patches one vegetation material.
 *
 *  IDEMPOTENT, and that is load-bearing rather than defensive: materials are
 *  cached and shared, and a double patch is a GLSL redefinition error three.js
 *  does not report unless booted with `?shaderErrors=1` — it presents as
 *  vegetation that simply does not draw. */
export function patchVegetationWeathering(
  material: THREE.MeshLambertMaterial,
  role: VegetationWeatherRole,
): void {
  if (material.userData.vegetationWeathering === true) return;
  material.userData.vegetationWeathering = true;

  const cfg = VEGETATION_WEATHERING;
  const uniforms: Record<string, { value: unknown }> = {
    uVegWeatherEnabled: { value: 1 },
    uVegWeatherNoise: { value: getWeatheringNoiseTexture() },
    uVegWeatherSoil: { value: getSoilSubstanceTexture() },
    uVegWeatherNoiseTileWorldSize: { value: cfg.noiseTileWorldSize },
    uVegWeatherSoilTileWorldSize: { value: SOIL_SUBSTANCE_TILE_WORLD_SIZE },
    uVegWeatherTileWorldSize: { value: tileWorldSizeFor(role) },
    uVegWeatherBaseHeight: { value: cfg.baseGrimeHeightWorldUnits },
    uVegWeatherBaseStrength: { value: cfg.baseGrimeStrength },
    uVegWeatherBaseDarken: { value: cfg.baseGrimeDarken },
    uVegWeatherBaseSeamPower: { value: cfg.baseGrimeSeamPower },
    uVegWeatherBaseFalloff: { value: cfg.baseGrimeFalloff },
    uVegWeatherBasePatchDepth: { value: cfg.baseGrimePatchDepth },
    uVegWeatherBaseVariation: { value: cfg.baseGrimeThicknessVariation },
    uVegWeatherGrainStrength: { value: cfg.grainStrength },
    uVegWeatherDryColor: { value: new THREE.Vector3(...cfg.dryColor) },
    uVegWeatherDryAmount: { value: cfg.dryAmount },
    uVegWeatherDryCoverage: { value: cfg.dryCoverage },
    uVegWeatherDustColor: { value: new THREE.Vector3(...cfg.dustColor) },
    uVegWeatherDustAmount: { value: cfg.dustAmount },
    uVegWeatherTrunkAmount: { value: cfg.trunkWeatherAmount },
  };

  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    for (const [name, uniform] of Object.entries(uniforms)) {
      shader.uniforms[name] = uniform as THREE.IUniform;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [VARYINGS, '#include <common>'].join('\n'))
      .replace(
        '#include <begin_vertex>',
        ['#include <begin_vertex>', VEGETATION_WEATHER_VERTEX].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          uniformDeclarations(),
          VARYINGS,
          SURFACE_WEATHERING_GLSL,
          '#include <common>',
        ].join('\n'),
      )
      // The map lookup is REPLACED, not appended: leaving three's uv sample in
      // place would multiply the surface by its own texture twice, once at
      // each density.
      .replace('#include <map_fragment>', VEGETATION_WEATHER_MAP)
      .replace(
        '#include <alphamap_fragment>',
        [vegetationWeatherFragment(role), '#include <alphamap_fragment>'].join('\n'),
      );
  };
  material.customProgramCacheKey = () =>
    `${previousCacheKey()}|vegetation-weathering-${role}-v1`;
  material.needsUpdate = true;
}
