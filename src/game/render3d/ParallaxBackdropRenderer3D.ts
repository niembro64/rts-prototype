import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { PRESET_BACKDROP_RENDER_CONFIG } from '@/config';
import {
  PRESET_BACKDROP_LAYER_IDS,
  type BackdropTarget,
  type PresetBackdropLayerId,
  type PresetBackdropLayerUrls,
} from './presetBackdrops';

const BACKDROP_TERMINAL_RENDER_ORDER = -1004;
const BACKDROP_TRANSPARENT_RENDER_ORDER_START = -1003;

type AuthoredLayerConfig = {
  readonly id: string;
  readonly minimumDistanceWorldUnits: number;
  readonly distanceMapFactor: number;
  readonly textureWidth: number;
  readonly blurRadiusPixels: number;
};

export type ResolvedBackdropLayerConfig = {
  readonly id: PresetBackdropLayerId;
  readonly distanceWorldUnits: number;
  readonly textureWidth: number;
  readonly blurRadiusPixels: number;
  readonly terminal: boolean;
};

const BACKDROP_VERTEX_SHADER = `
varying vec3 vWorldDirection;

vec3 backdropTransformDirection(vec3 direction, mat4 matrix) {
  return normalize((matrix * vec4(direction, 0.0)).xyz);
}

void main() {
  vWorldDirection = backdropTransformDirection(position, modelMatrix);
  vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Every shell is a background pass at the far-depth value. Opaque world
  // geometry therefore wins the depth test while clear pixels accept the
  // transparent near/middle/far composites.
  gl_Position = clipPosition.xyww;
}
`;

const BACKDROP_FRAGMENT_SHADER = `
uniform sampler2D uMap;
uniform vec3 uSphereCenter;
uniform float uSphereRadius;
uniform float uVerticalOffsetTurns;
varying vec3 vWorldDirection;

const float BACKDROP_RECIPROCAL_PI = 0.3183098861837907;
const float BACKDROP_RECIPROCAL_PI2 = 0.15915494309189535;

void main() {
  vec3 rayDirection = normalize(vWorldDirection);
  vec3 centerToCamera = cameraPosition - uSphereCenter;
  float projectedOrigin = dot(centerToCamera, rayDirection);
  float radiusTerm = dot(centerToCamera, centerToCamera)
    - uSphereRadius * uSphereRadius;
  float discriminant = projectedOrigin * projectedOrigin - radiusTerm;

  // Camera positions are authored to remain inside every shell. The fallback
  // keeps the terminal sky complete if an unusual debug camera leaves one.
  vec3 panoramaDirection = rayDirection;
  if (discriminant >= 0.0) {
    float hitDistance = -projectedOrigin + sqrt(discriminant);
    if (hitDistance > 0.0) {
      panoramaDirection = normalize(centerToCamera + rayDirection * hitDistance);
    }
  }

  float u = atan(panoramaDirection.z, panoramaDirection.x)
    * BACKDROP_RECIPROCAL_PI2 + 0.5;
  float v = asin(clamp(panoramaDirection.y, -1.0, 1.0))
    * BACKDROP_RECIPROCAL_PI + 0.5;
  v = clamp(v - uVerticalOffsetTurns, 0.0, 1.0);
  gl_FragColor = texture2D(uMap, vec2(u, v));
  #include <colorspace_fragment>
}
`;

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`worldRenderConfig.presetBackdrop.${field} must be finite and positive`);
  }
}

/** Resolve and validate the shared generator/renderer layer contract.
 * Exported so the boot contract test can cover ordering without WebGL. */
export function resolvePresetBackdropLayerConfig(
  mapWidth: number,
  mapHeight: number,
): readonly ResolvedBackdropLayerConfig[] {
  assertFinitePositive(mapWidth, 'mapWidth');
  assertFinitePositive(mapHeight, 'mapHeight');
  const authored = PRESET_BACKDROP_RENDER_CONFIG.layers as readonly AuthoredLayerConfig[];
  if (authored.length !== PRESET_BACKDROP_LAYER_IDS.length) {
    throw new Error('worldRenderConfig.presetBackdrop.layers must define exactly four layers');
  }
  const mapAxis = Math.max(mapWidth, mapHeight);
  let previousDistance = 0;
  let previousBlur = -1;
  return authored.map((layer, index) => {
    const expectedId = PRESET_BACKDROP_LAYER_IDS[index];
    if (layer.id !== expectedId) {
      throw new Error(
        `worldRenderConfig.presetBackdrop.layers[${index}].id must be ${expectedId}`,
      );
    }
    assertFinitePositive(
      layer.minimumDistanceWorldUnits,
      `layers[${index}].minimumDistanceWorldUnits`,
    );
    assertFinitePositive(layer.distanceMapFactor, `layers[${index}].distanceMapFactor`);
    assertFinitePositive(layer.textureWidth, `layers[${index}].textureWidth`);
    if (!Number.isInteger(layer.textureWidth) || layer.textureWidth % 2 !== 0) {
      throw new Error(
        `worldRenderConfig.presetBackdrop.layers[${index}].textureWidth must be an even integer`,
      );
    }
    if (!Number.isInteger(layer.blurRadiusPixels) || layer.blurRadiusPixels < 0) {
      throw new Error(
        `worldRenderConfig.presetBackdrop.layers[${index}].blurRadiusPixels must be a non-negative integer`,
      );
    }
    if (layer.blurRadiusPixels <= previousBlur) {
      throw new Error('preset backdrop blurRadiusPixels must increase with layer distance');
    }
    const distanceWorldUnits = Math.max(
      layer.minimumDistanceWorldUnits,
      layer.distanceMapFactor * mapAxis,
    );
    if (distanceWorldUnits <= previousDistance) {
      throw new Error('preset backdrop effective distances must increase from near to terminal');
    }
    previousDistance = distanceWorldUnits;
    previousBlur = layer.blurRadiusPixels;
    return {
      id: expectedId,
      distanceWorldUnits,
      textureWidth: layer.textureWidth,
      blurRadiusPixels: layer.blurRadiusPixels,
      terminal: index === PRESET_BACKDROP_LAYER_IDS.length - 1,
    };
  });
}

function backdropVerticalOffsetTurns(): number {
  const degrees = PRESET_BACKDROP_RENDER_CONFIG.verticalOffsetDegrees;
  if (!Number.isFinite(degrees) || Math.abs(degrees) >= 90) {
    throw new Error(
      'worldRenderConfig.presetBackdrop.verticalOffsetDegrees must be finite and between -90 and 90',
    );
  }
  return degrees / 180;
}

function configureBackdropTexture(texture: THREE.Texture, maxAnisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
}

/** Four finite, map-centered equirectangular shells. The shader analytically
 * intersects each world ray with its configured sphere, so all geometry can
 * stay on a far-depth cube without far-plane clipping. Camera translation
 * changes the hit azimuth/elevation by radius and produces real parallax. */
export class ParallaxBackdropRenderer3D implements BackdropTarget {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly layers: Array<{
    readonly material: THREE.ShaderMaterial;
    readonly mesh: THREE.Mesh;
  }> = [];
  private readonly maxAnisotropy: number;
  private readonly textureLoader: KTX2Loader;
  private textures: THREE.Texture[] = [];
  private activeKey: string | null = null;
  private loadGeneration = 0;
  private suppressed = false;
  private destroyed = false;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    const configs = resolvePresetBackdropLayerConfig(mapWidth, mapHeight);
    const verticalOffsetTurns = backdropVerticalOffsetTurns();
    const center = new THREE.Vector3(mapWidth / 2, 0, mapHeight / 2);
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    this.textureLoader = new KTX2Loader()
      .setTranscoderPath(`${import.meta.env.BASE_URL}assets/basis/`)
      .detectSupport(renderer);
    this.group.name = 'PresetParallaxBackdrop';
    this.group.visible = false;

    for (let index = 0; index < configs.length; index++) {
      const config = configs[index];
      const terminal = config.terminal;
      const material = new THREE.ShaderMaterial({
        name: `PresetBackdrop-${config.id}`,
        uniforms: {
          uMap: { value: null },
          uSphereCenter: { value: center.clone() },
          uSphereRadius: { value: config.distanceWorldUnits },
          uVerticalOffsetTurns: { value: verticalOffsetTurns },
        },
        vertexShader: BACKDROP_VERTEX_SHADER,
        fragmentShader: BACKDROP_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthTest: !terminal,
        depthWrite: false,
        depthFunc: THREE.LessEqualDepth,
        transparent: !terminal,
        blending: terminal ? THREE.NoBlending : THREE.NormalBlending,
        fog: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.name = `PresetBackdrop-${config.id}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = terminal
        ? BACKDROP_TERMINAL_RENDER_ORDER
        : BACKDROP_TRANSPARENT_RENDER_ORDER_START + (2 - index);
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        mesh.matrixWorld.copyPosition(camera.matrixWorld);
      };
      this.layers.push({ material, mesh });
      this.group.add(mesh);
    }
    scene.add(this.group);
  }

  setBackdropLayerUrls(urls: PresetBackdropLayerUrls | null): void {
    if (this.destroyed) return;
    const key = urls?.join('|') ?? null;
    if (key === this.activeKey) return;
    this.activeKey = key;
    const generation = ++this.loadGeneration;
    if (!urls) {
      this.replaceTextures([]);
      return;
    }
    void this.loadLayerSet(urls, generation, urls.join('|'));
  }

  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    this.syncVisibility();
  }

  private async loadLayerSet(
    urls: PresetBackdropLayerUrls,
    generation: number,
    key: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      urls.map((url) => this.textureLoader.loadAsync(url)),
    );
    const loaded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (this.destroyed || generation !== this.loadGeneration || key !== this.activeKey) {
      for (const texture of loaded) texture.dispose();
      return;
    }
    if (loaded.length !== PRESET_BACKDROP_LAYER_IDS.length) {
      for (const texture of loaded) texture.dispose();
      this.replaceTextures([]);
      return;
    }
    for (const texture of loaded) configureBackdropTexture(texture, this.maxAnisotropy);
    this.replaceTextures(loaded);
  }

  private replaceTextures(next: THREE.Texture[]): void {
    for (let index = 0; index < this.layers.length; index++) {
      this.layers[index].material.uniforms.uMap.value = next[index] ?? null;
    }
    for (const texture of this.textures) texture.dispose();
    this.textures = next;
    this.syncVisibility();
  }

  private syncVisibility(): void {
    this.group.visible = !this.destroyed
      && !this.suppressed
      && this.textures.length === PRESET_BACKDROP_LAYER_IDS.length;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration++;
    this.group.parent?.remove(this.group);
    for (const texture of this.textures) texture.dispose();
    this.textures = [];
    for (const { material, mesh } of this.layers) {
      mesh.onBeforeRender = () => {};
      material.dispose();
    }
    this.layers.length = 0;
    this.textureLoader.dispose();
    this.geometry.dispose();
  }
}
