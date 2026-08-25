import * as THREE from 'three';
import { getClientConfig } from '@/clientBarConfig';
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
  for (const mode of ['demo', 'real'] as const) {
    const config = getClientConfig(mode);
    assertContract(
      config.environmentLight.default === 25 &&
        config.ambientLight.default === 0 &&
        config.directionalLight.default === 1250 &&
        config.skyLight.default === 25 &&
        config.exposure.default === 25,
      `${mode} lighting must default to ENV 25, AMB 0, SUN 1250, SKY 25, EXPO 25`,
    );
    for (const setting of [
      config.environmentLight,
      config.ambientLight,
      config.skyLight,
      config.exposure,
    ]) {
      assertContract(
        setting.options.some((option) => option.value === 500),
        `${mode} light controls must expose the expanded 500-percent ceiling`,
      );
    }
    assertContract(
      config.directionalLight.options.some((option) => option.value === 1250) &&
        config.directionalLight.options.some((option) => option.value === 1500),
      `${mode} SUN LIGHT must expose its 1250-percent default and 1500-percent headroom`,
    );
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
