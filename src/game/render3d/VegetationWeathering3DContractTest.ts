// Contract: everything that grows is textured at a world density, and
// weathered by the same vocabulary as everything else.
//
// Every failure here is silent. An unsupplied uniform reads zero and the
// treatment stops. A missed choke point leaves one material unweathered while
// its neighbours are weathered, which reads as a bug in the art. A double
// patch is a GLSL redefinition error three.js does not report unless booted
// with `?shaderErrors=1` — it presents as vegetation that simply does not
// draw. And leaving three's uv map lookup in place alongside the projected
// one multiplies a surface by its own texture twice, at two densities, which
// looks like a darker tree rather than like a mistake.

import * as THREE from 'three';
import { VEGETATION_WEATHERING } from '../../config';
import { SURFACE_WEATHERING_GLSL } from './SurfaceWeathering3D';
import {
  VEGETATION_WEATHERING_SOURCE,
  patchVegetationWeathering,
} from './VegetationWeathering3D';
import { vegetationWeatherRoleForKey } from './EnvironmentPropRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[vegetation weathering contract] ${message}`);
  }
}

/** Which terms a surface takes follows what it is made of. The renderer reaches
 *  `sharedMaterial` from four call sites; classifying on the key rather than on
 *  an argument is what stops a fifth landing silently on the default. */
function checkRoleClassification(): void {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['randomEnvironment.forestSpruce2.grass-leaves', 'grass'],
    ['randomEnvironment.forestSpruce2.tree-trunk', 'trunk'],
    ['randomEnvironment.forestSpruce2.tree-leaves', 'foliage'],
    ['forestTree.trunk', 'trunk'],
    ['forestTree.leaves', 'foliage'],
    ['lowTree.trunk', 'trunk'],
    ['lowTree.leaves', 'foliage'],
    ['environmentLod.flat.wood', 'trunk'],
    ['environmentLod.flat.foliage', 'foliage'],
  ];
  for (const [key, expected] of cases) {
    const actual = vegetationWeatherRoleForKey(key);
    assertContract(
      actual === expected,
      `material key "${key}" classified as ${actual}, expected ${expected}`,
    );
  }
  // The reduced tiers must classify too. Weathering only the textured tier
  // makes the treatment pop on and off as a prop crosses a detail rung.
  assertContract(
    vegetationWeatherRoleForKey('environmentLod.flat.wood') === 'trunk' &&
    vegetationWeatherRoleForKey('environmentLod.flat.foliage') === 'foliage',
    'the flat reduced-tier materials must take weathering as well as the ' +
    'textured close tier, or the treatment pops at every rung change',
  );
}

/** A shader interface is the one contract the type system cannot check. */
function checkShaderSourceContract(): void {
  const declarations = VEGETATION_WEATHERING_SOURCE.uniformDeclarations();
  const source = [
    VEGETATION_WEATHERING_SOURCE.vertex,
    VEGETATION_WEATHERING_SOURCE.map,
    VEGETATION_WEATHERING_SOURCE.fragment('trunk'),
    VEGETATION_WEATHERING_SOURCE.fragment('foliage'),
    VEGETATION_WEATHERING_SOURCE.fragment('grass'),
  ].join('\n');
  const uniformNames = Array.from(
    declarations.matchAll(/uniform\s+\w+\s+(u\w+);/g),
    (match) => match[1],
  );
  for (const read of source.matchAll(/\buVegWeather\w*/g)) {
    assertContract(
      uniformNames.includes(read[0]),
      `the vegetation weathering reads ${read[0]}, which its uniform block ` +
      'does not declare — an unsupplied uniform is silently zero',
    );
  }
  for (const name of uniformNames) {
    assertContract(
      source.includes(name),
      `uniform ${name} is declared by the vegetation weathering but never read`,
    );
  }

  // Every varying the fragment reads must be written by the vertex stage.
  for (const varying of ['vVegWeatherWorld', 'vVegWeatherNormal', 'vVegWeatherHeight']) {
    assertContract(
      VEGETATION_WEATHERING_SOURCE.varyings.includes(`${varying};`),
      `${varying} is used but not declared`,
    );
    assertContract(
      VEGETATION_WEATHERING_SOURCE.vertex.includes(`${varying} =`),
      `${varying} is declared but the vertex stage never writes it`,
    );
  }

  // INSTANCING. Vegetation is drawn as InstancedMesh batches, so a world
  // position built from modelMatrix alone would put every instance of a
  // template at the same place in the texture — one tree's bark, copied onto
  // every tree on the map, which is the whole thing this projection buys.
  assertContract(
    VEGETATION_WEATHERING_SOURCE.vertex.includes('#ifdef USE_INSTANCING') &&
    VEGETATION_WEATHERING_SOURCE.vertex.includes('instanceMatrix'),
    'the vertex stage must fold instanceMatrix in; vegetation is instanced, ' +
    'and without it every instance samples the same patch of texture',
  );
  // The height must be measured against the instance ORIGIN, not against
  // world zero, or a tree on a hillside is dirty at whatever altitude the
  // flat happens to be rather than at its own foot.
  assertContract(
    /vVegWeatherHeight = vegWeatherWorld\.y - vegWeatherOrigin\.y;/.test(
      VEGETATION_WEATHERING_SOURCE.vertex,
    ),
    'the base height must be measured from the prop\'s own origin',
  );

  // WORLD PROJECTION, NOT UVs. This is the texel-density rule on the most
  // numerous object in the world: through uvs at a fixed repeat, a big tree
  // and a small tree wore bark at different physical sizes.
  assertContract(
    VEGETATION_WEATHERING_SOURCE.map.includes('weatherSampleSubstance(') &&
    VEGETATION_WEATHERING_SOURCE.map.includes('uVegWeatherTileWorldSize') &&
    !VEGETATION_WEATHERING_SOURCE.map.includes('vMapUv'),
    'the map lookup must be projected from world position at a world tile ' +
    'size, never sampled through the model uvs',
  );

  for (const shared of [
    'weatherSampleFields(',
    'weatherSurfacePlane(',
    'weatherDissolve(',
    'weatherJitterRamp(',
    'weatherGrimeAmount(',
    'weatherApplyGrime(',
    'weatherSampleSubstance(',
  ]) {
    assertContract(
      SURFACE_WEATHERING_GLSL.includes(shared),
      `SurfaceWeathering3D must define ${shared}`,
    );
    assertContract(
      source.includes(shared),
      `the vegetation must reach the shared ${shared} rather than re-deriving it`,
    );
  }

  // Dust is a canopy term. A trunk taking it would pale its sunward side into
  // the same colour the leaves above it went, which reads as one material.
  assertContract(
    !VEGETATION_WEATHERING_SOURCE.fragment('trunk').includes('uVegWeatherDustColor') &&
    VEGETATION_WEATHERING_SOURCE.fragment('foliage').includes('uVegWeatherDustColor'),
    'dust settles on what faces up — foliage and grass take it, a trunk does not',
  );
}

/** Tile sizes are WORLD sizes and every one must be real, or a surface
 *  collapses to one texel of its own texture. */
function checkDensities(): void {
  for (const [name, value] of [
    ['barkTileWorldSize', VEGETATION_WEATHERING.barkTileWorldSize],
    ['foliageTileWorldSize', VEGETATION_WEATHERING.foliageTileWorldSize],
    ['grassTileWorldSize', VEGETATION_WEATHERING.grassTileWorldSize],
    ['noiseTileWorldSize', VEGETATION_WEATHERING.noiseTileWorldSize],
    ['baseGrimeHeightWorldUnits', VEGETATION_WEATHERING.baseGrimeHeightWorldUnits],
  ] as const) {
    assertContract(
      Number.isFinite(value) && value > 0,
      `${name} must be a positive world size; got ${value}`,
    );
  }
}

/** IDEMPOTENCE. Materials are cached and shared, and the patch is reachable
 *  from the cache path and from a direct call. A second patch redefines every
 *  function it injected. */
function checkPatchIsIdempotent(): void {
  const material = new THREE.MeshLambertMaterial();
  patchVegetationWeathering(material, 'foliage');
  patchVegetationWeathering(material, 'foliage');
  const shader = {
    vertexShader: ['#include <common>', '#include <begin_vertex>'].join('\n'),
    fragmentShader: [
      '#include <common>',
      '#include <map_fragment>',
      '#include <alphamap_fragment>',
    ].join('\n'),
    uniforms: {} as Record<string, THREE.IUniform>,
  };
  material.onBeforeCompile(
    shader as unknown as THREE.WebGLProgramParametersWithUniforms,
    null as unknown as THREE.WebGLRenderer,
  );
  const declarations = (shader.fragmentShader.match(/uniform float uVegWeatherEnabled;/g) ?? []).length;
  assertContract(
    declarations === 1,
    `a second patch redeclared the uniform block (${declarations} copies); the ` +
    'result is a GLSL redefinition error three.js does not report unless ' +
    'booted with ?shaderErrors=1, which presents as vegetation that does not draw',
  );
  assertContract(
    !shader.fragmentShader.includes('#include <map_fragment>'),
    'the uv map lookup must be REPLACED, not appended — leaving it multiplies ' +
    'the surface by its own texture twice, once at each density',
  );
  assertContract(
    shader.uniforms.uVegWeatherEnabled !== undefined,
    'the patch must supply its own uniforms',
  );
  material.dispose();
}

export function runVegetationWeathering3DContractTest(): void {
  checkRoleClassification();
  checkShaderSourceContract();
  checkDensities();
  checkPatchIsIdempotent();
}
