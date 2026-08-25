import * as THREE from 'three';
import {
  getClientConfig,
  normalizeLightIntensitySelection,
} from '@/clientBarConfig';
import { GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG } from '../../config';
import {
  configureGroundSilhouetteCasterTree3D,
  configureGroundSilhouetteReceiver3D,
} from './GroundSilhouetteShadow3D';
import { GroundSilhouetteSunShadow3D } from './SunLighting';
import { worldShadeFragment } from './WorldShade3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[ground silhouette shadow contract] ${message}`);
}

export function runGroundSilhouetteShadow3DContractTest(): void {
  const expectedLightOptions = [0, 15, 150, 1500, 15000];
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
      config.environmentLight.default === 15 &&
        config.ambientLight.default === 0 &&
        config.directionalLight.default === 1500 &&
        config.skyLight.default === 15 &&
        config.exposure.default === 15,
      `${mode} lighting must default to ENV 15, AMB 0, SUN 1500, SKY 15, EXPO 15`,
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
      const positiveValues = values.filter((value) => value > 0);
      assertContract(
        positiveValues.every((value, index) =>
          index === 0 || value === positiveValues[index - 1] * 10),
        `${mode} light controls must increase by an exact power of ten per button`,
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
  }

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
    shadow.sync(camera, focus, 1000, true);
    const shadowCamera = sun.shadow.camera;
    const radius = shadowCamera.right;
    const quantum = GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG.frustumRadiusQuantum;
    const texelSize = radius * 2 / sun.shadow.mapSize.width;
    assertContract(
      sun.castShadow &&
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
    shadow.sync(camera, focus, 1000, false);
    assertContract(!sun.castShadow, 'the client SHADOWS toggle must disable the depth pass');
  } finally {
    shadow.destroy();
    solid.geometry.dispose();
    (solid.material as THREE.Material).dispose();
    effect.geometry.dispose();
    (effect.material as THREE.Material).dispose();
    terrain.geometry.dispose();
    (terrain.material as THREE.Material).dispose();
  }
}
