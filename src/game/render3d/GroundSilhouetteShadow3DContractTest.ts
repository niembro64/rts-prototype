import * as THREE from 'three';
import {
  getClientConfig,
  normalizeEntityShadowDarknessSelection,
  normalizeLightIntensitySelection,
} from '@/clientBarConfig';
import { GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG } from '../../config';
import {
  configureGroundSilhouetteCaster3D,
  configureGroundSilhouetteCasterTree3D,
  configureGroundSilhouetteReceiver3D,
} from './GroundSilhouetteShadow3D';
import { GroundSilhouetteSunShadow3D } from './SunLighting';
import { worldShadeFragment } from './WorldShade3D';
import {
  getTerrainBakedLightingUniform,
  setTerrainBakedLightingEnabled,
  TERRAIN_BAKED_LIGHTING_UNIFORM,
  terrainBakedLightingShadeExpression,
} from './RenderLighting3D';
import {
  TERRAIN_OUTWARD_NORMAL_LEVELS,
  TERRAIN_OUTWARD_NORMAL_UNIFORM,
  terrainOutwardNormalFragment,
  terrainOutwardNormalScopeLevel,
  terrainOutwardNormalUniformDeclaration,
} from './TerrainOutwardNormal3D';
import { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import { REFERENCE_ORNAMENT_PROFILE } from './TeamOrnament3D';
import { LegInstancedRenderer } from './LegInstancedRenderer';
import { createScreenSpaceLineMaterial } from './ScreenSpaceLineMaterial';
import { createCanvasHudSpriteMaterial } from './CanvasSpritePool';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[ground silhouette shadow contract] ${message}`);
}

/** GPU regression for the actual failure mode: authored upward normals on
 * back-facing DoubleSide terrain, with grass-like and ore-like Standard
 * material responses. Compare the same frame with and without the depth pass;
 * both halves must lose measurable light beneath their caster. */
function checkGrassAndMetalReceiveDirectionalSilhouettes(): void {
  const width = 160;
  const height = 112;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 1);
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-7, 7, 5, -5, 0.1, 50);
  camera.up.set(0, 0, -1);
  camera.position.set(0, 14, 0);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.12));
  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.position.set(0, 10, 8);
  sun.target.position.set(0, 0, 0);
  sun.shadow.mapSize.set(512, 512);
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -8;
  shadowCamera.right = 8;
  shadowCamera.top = 8;
  shadowCamera.bottom = -8;
  shadowCamera.near = 0.1;
  shadowCamera.far = 30;
  shadowCamera.updateProjectionMatrix();
  scene.add(sun, sun.target);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const addBackFacingReceiver = (
    x: number,
    color: number,
    metalness: number,
    roughness: number,
    metalCoverage: 0 | 1,
  ): void => {
    const geometry = new THREE.PlaneGeometry(6, 9);
    geometry.rotateX(-Math.PI * 0.5);
    const index = geometry.index;
    assertContract(index !== null, 'contract receiver plane must be indexed');
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms[TERRAIN_OUTWARD_NORMAL_UNIFORM] = { value: 2 };
      shader.fragmentShader = `${terrainOutwardNormalUniformDeclaration()}\n${shader.fragmentShader}`
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\nfloat metalCoverage = ${metalCoverage.toFixed(1)};`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n${terrainOutwardNormalFragment()}`,
        );
    };
    material.customProgramCacheKey = () =>
      `ground-shadow-surface-contract-${metalCoverage}`;
    const receiver = new THREE.Mesh(geometry, material);
    receiver.position.x = x;
    configureGroundSilhouetteReceiver3D(receiver);
    scene.add(receiver);
    geometries.push(geometry);
    materials.push(material);
  };
  addBackFacingReceiver(-3.1, 0x58753d, 0, 1, 0);
  addBackFacingReceiver(3.1, 0x4a4f53, 0.5, 0.88, 1);

  for (const x of [-3.1, 3.1]) {
    const geometry = new THREE.BoxGeometry(1.8, 3, 1.8);
    const material = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.7 });
    const caster = new THREE.Mesh(geometry, material);
    caster.position.set(x, 1.5, 2);
    configureGroundSilhouetteCaster3D(caster);
    scene.add(caster);
    geometries.push(geometry);
    materials.push(material);
  }

  const withoutShadow = new Uint8Array(width * height * 4);
  const withShadow = new Uint8Array(width * height * 4);
  const renderInto = (pixels: Uint8Array): void => {
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  };

  try {
    sun.castShadow = false;
    renderInto(withoutShadow);
    sun.castShadow = true;
    sun.shadow.needsUpdate = true;
    renderInto(withShadow);

    const signalForHalf = (minX: number, maxX: number): {
      signal: number;
      absoluteSignal: number;
      meanBefore: number;
      meanAfter: number;
      surfacePixels: number;
    } => {
      let positiveDelta = 0;
      let absoluteDelta = 0;
      let beforeTotal = 0;
      let afterTotal = 0;
      let surfacePixels = 0;
      for (let y = 8; y < height - 8; y++) {
        for (let x = minX; x < maxX; x++) {
          const offset = (y * width + x) * 4;
          const before = (
            withoutShadow[offset] +
            withoutShadow[offset + 1] +
            withoutShadow[offset + 2]
          ) / 3;
          if (before < 8) continue;
          const after = (
            withShadow[offset] +
            withShadow[offset + 1] +
            withShadow[offset + 2]
          ) / 3;
          const delta = before - after;
          positiveDelta += Math.max(0, delta);
          absoluteDelta += Math.abs(delta);
          beforeTotal += before;
          afterTotal += after;
          surfacePixels++;
        }
      }
      const divisor = Math.max(1, surfacePixels);
      return {
        signal: positiveDelta / divisor,
        absoluteSignal: absoluteDelta / divisor,
        meanBefore: beforeTotal / divisor,
        meanAfter: afterTotal / divisor,
        surfacePixels,
      };
    };
    const grass = signalForHalf(4, Math.floor(width * 0.47));
    const metal = signalForHalf(Math.ceil(width * 0.53), width - 4);
    assertContract(
      grass.signal > 0.2 && metal.signal > 0.2,
      'directional silhouettes must visibly darken both back-facing terrain ' +
      `materials (grass=${JSON.stringify(grass)}, metal=${JSON.stringify(metal)})`,
    );
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

export function runGroundSilhouetteShadow3DContractTest(): void {
  const canvasHudMaterial = createCanvasHudSpriteMaterial();
  assertContract(
    canvasHudMaterial.toneMapped === false &&
      canvasHudMaterial.userData.renderLighting === 'self-lit',
    'health bars, entity names, and waypoint sprites must retain authored HUD colors independent of scene lighting and exposure',
  );
  canvasHudMaterial.dispose();
  const overlayLineMaterial = createScreenSpaceLineMaterial();
  assertContract(
    overlayLineMaterial.toneMapped === false &&
      overlayLineMaterial.uniforms.uBrightness === undefined &&
      overlayLineMaterial.userData.renderLighting === 'self-lit',
    'waypoint lines, point boxes, and other ground HUD overlays must retain authored colors independent of scene lighting and exposure',
  );
  overlayLineMaterial.dispose();

  const expectedLightOptions = [0, 15, 150, 1500, 5000, 15000];
  assertContract(
    normalizeLightIntensitySelection(0) === 0 &&
      normalizeLightIntensitySelection(25) === 15 &&
      normalizeLightIntensitySelection(1250) === 1500 &&
      normalizeLightIntensitySelection(15000) === 15000,
    'legacy linear light values must migrate to the nearest logarithmic selection',
  );
  for (const mode of ['demo', 'real'] as const) {
    const config = getClientConfig(mode);
    assertContract(
      config.environmentLight.default === 150 &&
        config.ambientLight.default === 1500 &&
        config.directionalLight.default === 1500 &&
        config.skyLight.default === 1500 &&
        config.exposure.default === 15,
      `${mode} lighting must default to ENV 150, AMB 1500, SUN 1500, SKY 1500, EXPO 15`,
    );
    assertContract(
      !config.terrainBakedLighting.default,
      `${mode} must default the optional baked terrain lighting off`,
    );
    for (const setting of [
      config.environmentLight,
      config.ambientLight,
      config.directionalLight,
      config.skyLight,
      config.exposure,
    ]) {
      const values = setting.options.map((option) => option.value);
      assertContract(
        values.length === expectedLightOptions.length &&
          values.every((value, index) => value === expectedLightOptions[index]),
        `${mode} light controls must share the zero-plus-decades selection ladder`,
      );
      assertContract(
        [15, 150, 1500, 15000].every((value) => values.includes(value)) &&
          values.includes(5000) && 5000 > 1500 && 5000 < 15000,
        `${mode} light controls must retain the decade ladder plus the requested SUN tuning stop between 1500 and 15000`,
      );
      assertContract(
        values.includes(setting.default),
        `${mode} light-control defaults must remain selectable buttons`,
      );
    }
    assertContract(
      config.entityShadows.default,
      `${mode} must enable physical ground silhouettes by default`,
    );
    assertContract(
      config.entityShadowDarkness.default === 100 &&
        config.entityShadowDarkness.options.map((option) => option.value).join(',') ===
          '0,25,50,75,100',
      `${mode} must expose selectable live silhouette-shadow darkness through full strength`,
    );
  }
  assertContract(
    normalizeEntityShadowDarknessSelection(63) === 75 &&
      normalizeEntityShadowDarknessSelection(50) === 50,
    'shadow darkness must normalize to the nearest visible CLIENT button',
  );

  const bakedUniform = getTerrainBakedLightingUniform();
  setTerrainBakedLightingEnabled(false);
  assertContract(
    bakedUniform.value === 0 &&
      terrainBakedLightingShadeExpression('vTerrainShade') ===
        `mix(1.0, vTerrainShade, ${TERRAIN_BAKED_LIGHTING_UNIFORM})`,
    'baked terrain lighting off must select neutral shade through one live uniform',
  );
  setTerrainBakedLightingEnabled(true);
  assertContract(
    Number(bakedUniform.value) === 1,
    'baked terrain lighting must enable live without replacing the shared uniform',
  );
  setTerrainBakedLightingEnabled(false);

  assertContract(
    terrainOutwardNormalScopeLevel() === TERRAIN_OUTWARD_NORMAL_LEVELS.terrain,
    'all terrain fragments must restore their authored outward normal so live sun and silhouette shadows reach biome grass as well as ore',
  );
  checkGrassAndMetalReceiveDirectionalSilhouettes();

  const root = new THREE.Group();
  const solid = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial(),
  );
  const effect = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  root.add(solid, effect);
  configureGroundSilhouetteCasterTree3D(root);
  assertContract(
    solid.castShadow && !effect.castShadow,
    'lit entity geometry must cast its exact triangles while unlit effect geometry stays out of the sun pass',
  );

  const teamTrimRoot = new THREE.Group();
  const teamTrim = new TeamTrimRenderer3D(teamTrimRoot);
  teamTrim.allocHostKit(REFERENCE_ORNAMENT_PROFILE, 1);
  teamTrim.allocTurretCollar(1);
  assertContract(
    teamTrimRoot.children.length === 2 &&
      teamTrimRoot.children.every((part) => (part as THREE.Mesh).castShadow),
    'world-level unit kits and turret collars must cast their actual instanced ornament silhouettes',
  );

  const legRoot = new THREE.Group();
  const legs = new LegInstancedRenderer(legRoot);
  const keepSlot = (): void => {};
  legs.allocUpper(0xffffff, keepSlot);
  legs.allocLower(0xffffff, keepSlot);
  legs.allocLowerTaper(0xffffff, keepSlot);
  legs.allocJoint(0xffffff, keepSlot);
  legs.allocFoot(0xffffff, keepSlot);
  const legMeshes = legRoot.children as THREE.Mesh[];
  assertContract(
    legMeshes.length === 5 && legMeshes.every((part) => part.castShadow),
    'every world-level crawler segment, taper, joint, and foot pool must cast its articulated silhouette',
  );
  const proceduralSegments = legMeshes.filter(
    (part) => (part as THREE.InstancedMesh).isInstancedMesh !== true,
  );
  assertContract(
    proceduralSegments.length === 3 && proceduralSegments.every((part) => {
      const depthMaterial = part.customDepthMaterial as THREE.MeshDepthMaterial | undefined;
      const shaderProbe = {
        vertexShader: '#include <common>\n#include <begin_vertex>',
      };
      depthMaterial?.onBeforeCompile(shaderProbe as never, {} as never);
      return depthMaterial?.isMeshDepthMaterial === true &&
        shaderProbe.vertexShader.includes('instStart') &&
        shaderProbe.vertexShader.includes('instRight');
    }),
    'procedural crawler segments must reproduce their live per-part pose in the shadow-depth pass',
  );

  const terrain = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial(),
  );
  configureGroundSilhouetteReceiver3D(terrain);
  assertContract(terrain.receiveShadow, 'terrain geometry must receive the projected silhouettes');

  const terrainFogShade = worldShadeFragment('vTerrainWorldPos', false);
  assertContract(
    terrainFogShade.includes('texture2D(uWorldShadeMap') &&
      !terrainFogShade.includes('texture2D(uWorldShadowMap'),
    'terrain must keep fog coverage but retire the ellipse-shadow sampler so the directional shadow map stays within the 16-texture WebGL budget',
  );

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const shadow = new GroundSilhouetteSunShadow3D(sun, 4096, 2048);
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, 10000);
  const focus = new THREE.Vector3(100.123, 12, 200.456);
  try {
    shadow.sync(camera, focus, 1000, true, 25);
    const shadowCamera = sun.shadow.camera;
    const radius = shadowCamera.right;
    const quantum = GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG.frustumRadiusQuantum;
    const texelSize = radius * 2 / sun.shadow.mapSize.width;
    assertContract(
      sun.castShadow &&
        sun.shadow.intensity === 0.25 &&
        sun.shadow.mapSize.width === GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG.mapSize &&
        shadowCamera.left === -radius &&
        shadowCamera.top === radius &&
        shadowCamera.bottom === -radius &&
        Math.abs(radius / quantum - Math.round(radius / quantum)) < 1e-9,
      'the sun must use one quantized orthographic shadow frustum around the visible battle',
    );
    assertContract(
      Math.abs(sun.target.position.x / texelSize - Math.round(sun.target.position.x / texelSize)) < 1e-9 &&
        Math.abs(sun.target.position.z / texelSize - Math.round(sun.target.position.z / texelSize)) < 1e-9,
      'the sun focus must snap to shadow texels so outlines do not swim during sub-texel camera pans',
    );
    shadow.sync(camera, focus, 1000, true, 0);
    assertContract(
      !sun.castShadow && Number(sun.shadow.intensity) === 0,
      'zero darkness must remove silhouettes and skip the depth pass',
    );
    shadow.sync(camera, focus, 1000, false, 100);
    assertContract(!sun.castShadow, 'the client SHADOWS toggle must disable the depth pass');
  } finally {
    shadow.destroy();
    teamTrim.dispose();
    legs.destroy();
    solid.geometry.dispose();
    (solid.material as THREE.Material).dispose();
    effect.geometry.dispose();
    (effect.material as THREE.Material).dispose();
    terrain.geometry.dispose();
    (terrain.material as THREE.Material).dispose();
  }
}
