import * as THREE from 'three';
import {
  GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG,
  SUN_RENDER_CONFIG,
  TERRAIN_SHADOW_RENDER_CONFIG,
} from '../../config';
import { clamp } from '../math';
import { configureSpriteTexture } from './threeUtils';
import { registerSunLights } from './RenderLighting3D';

type SimSunDirection = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

const horizontal = Math.cos(SUN_RENDER_CONFIG.elevationRad);

export const SUN_DIRECTION_SIM: SimSunDirection = Object.freeze({
  x: horizontal * Math.cos(SUN_RENDER_CONFIG.azimuthRad),
  y: horizontal * Math.sin(SUN_RENDER_CONFIG.azimuthRad),
  z: Math.sin(SUN_RENDER_CONFIG.elevationRad),
});

/** Direction sunlight travels through sim space, opposite the world-to-sun
 * vector. Shared by the 3D top-bar instrument and its 2D minimap projection. */
export const SUN_LIGHT_TRAVEL_SIM: SimSunDirection = Object.freeze({
  x: -SUN_DIRECTION_SIM.x,
  y: -SUN_DIRECTION_SIM.y,
  z: -SUN_DIRECTION_SIM.z,
});

const sunHorizontalMag = Math.max(
  1e-6,
  Math.hypot(SUN_DIRECTION_SIM.x, SUN_DIRECTION_SIM.y),
);
const sunHorizontalX = SUN_DIRECTION_SIM.x / sunHorizontalMag;
const sunHorizontalY = SUN_DIRECTION_SIM.y / sunHorizontalMag;
const sunSlope = SUN_DIRECTION_SIM.z / sunHorizontalMag;
let sunDiskTexture: THREE.CanvasTexture | null = null;

export class GroundSilhouetteSunShadow3D {
  private readonly direction = writeSunDirectionThree(new THREE.Vector3());
  private readonly mapDiagonal: number;
  private enabled = false;

  constructor(
    private readonly sun: THREE.DirectionalLight,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.mapDiagonal = Math.hypot(mapWidth, mapHeight);
    const config = GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG;
    const mapSize = Math.max(256, Math.floor(config.mapSize));
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.bias = config.bias;
    sun.shadow.normalBias = config.normalBias;
    sun.shadow.radius = config.pcfRadius;
    sun.shadow.autoUpdate = true;
  }

  /**
   * Keep the orthographic shadow camera on the visible battle. Snapping the
   * focus to shadow texels prevents the projected outline from swimming while
   * the RTS camera makes sub-texel pans.
   */
  sync(
    camera: THREE.PerspectiveCamera,
    focus: THREE.Vector3,
    orbitDistance: number,
    clientEnabled: boolean,
    darknessPercent: number,
  ): void {
    const config = GROUND_SILHOUETTE_SHADOW_RENDER_CONFIG;
    const darkness = clamp(darknessPercent / 100, 0, 1);
    this.sun.shadow.intensity = darkness;
    const nextEnabled = config.enabled && clientEnabled && darkness > 0;
    if (this.enabled !== nextEnabled) {
      this.enabled = nextEnabled;
      this.sun.castShadow = nextEnabled;
      this.sun.shadow.needsUpdate = nextEnabled;
    }
    if (!nextEnabled) return;

    const verticalHalfView = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) *
      Math.max(1, orbitDistance);
    const horizontalHalfView = verticalHalfView * Math.max(0.1, camera.aspect);
    const desiredRadius = Math.hypot(horizontalHalfView, verticalHalfView) *
      config.frustumRadiusMultiplier;
    const quantum = Math.max(1, config.frustumRadiusQuantum);
    const quantizedRadius = Math.ceil(desiredRadius / quantum) * quantum;
    const mapRadiusCap = Math.max(
      quantum,
      this.mapDiagonal * config.maximumMapDiagonalFraction,
    );
    const radius = Math.min(
      mapRadiusCap,
      Math.max(config.minimumFrustumRadius, quantizedRadius),
    );

    const shadowCamera = this.sun.shadow.camera;
    if (
      shadowCamera.left !== -radius ||
      shadowCamera.right !== radius ||
      shadowCamera.top !== radius ||
      shadowCamera.bottom !== -radius
    ) {
      shadowCamera.left = -radius;
      shadowCamera.right = radius;
      shadowCamera.top = radius;
      shadowCamera.bottom = -radius;
      shadowCamera.near = config.cameraNear;
      shadowCamera.far = Math.max(
        config.cameraFar,
        SUN_RENDER_CONFIG.distance + radius * 2,
      );
      shadowCamera.updateProjectionMatrix();
    }

    const texelSize = radius * 2 / Math.max(1, this.sun.shadow.mapSize.width);
    const targetX = Math.round(focus.x / texelSize) * texelSize;
    const targetZ = Math.round(focus.z / texelSize) * texelSize;
    this.sun.target.position.set(targetX, focus.y, targetZ);
    this.sun.position.copy(this.sun.target.position).addScaledVector(
      this.direction,
      SUN_RENDER_CONFIG.distance,
    );
  }

  destroy(): void {
    this.sun.shadow.dispose();
  }
}

function getSunDiskTexture(): THREE.CanvasTexture {
  if (sunDiskTexture) return sunDiskTexture;
  const cfg = SUN_RENDER_CONFIG.visibleSkyDisk;
  const size = Math.max(16, cfg.texturePixels | 0);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create sun disk texture');
  }
  const c = size * 0.5;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, cfg.coreColor);
  gradient.addColorStop(Math.max(0.01, Math.min(1, cfg.coreRadius)), cfg.coreColor);
  gradient.addColorStop(Math.max(0.01, Math.min(1, cfg.haloRadius)), cfg.haloColor);
  gradient.addColorStop(1, cfg.haloFadeColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  sunDiskTexture = new THREE.CanvasTexture(canvas);
  sunDiskTexture.colorSpace = THREE.SRGBColorSpace;
  configureSpriteTexture(sunDiskTexture);
  return sunDiskTexture;
}

export function getTerrainShadowCacheKey(): string {
  const cfg = TERRAIN_SHADOW_RENDER_CONFIG;
  const pre = cfg.precomputed;
  return [
    cfg.enabled ? 1 : 0,
    SUN_RENDER_CONFIG.azimuthRad,
    SUN_RENDER_CONFIG.elevationRad,
    cfg.ambient,
    cfg.directStrength,
    cfg.minShade,
    cfg.maxShade,
    pre.enabled ? 1 : 0,
    pre.samples,
    pre.sampleDistance,
    pre.bias,
    pre.softness,
    pre.strength,
  ].join(':');
}

export function writeSunDirectionThree(out: THREE.Vector3): THREE.Vector3 {
  return out.set(SUN_DIRECTION_SIM.x, SUN_DIRECTION_SIM.z, SUN_DIRECTION_SIM.y).normalize();
}

export function installSunLighting(
  scene: THREE.Scene,
  mapWidth: number,
  mapHeight: number,
): GroundSilhouetteSunShadow3D {
  const ambient = new THREE.AmbientLight(
    SUN_RENDER_CONFIG.color,
    SUN_RENDER_CONFIG.ambientIntensity,
  );
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(
    SUN_RENDER_CONFIG.color,
    SUN_RENDER_CONFIG.directionalIntensity,
  );
  const direction = writeSunDirectionThree(new THREE.Vector3());
  const target = new THREE.Vector3(mapWidth * 0.5, 0, mapHeight * 0.5);
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(direction, SUN_RENDER_CONFIG.distance);
  scene.add(sun);
  scene.add(sun.target);
  const groundShadows = new GroundSilhouetteSunShadow3D(sun, mapWidth, mapHeight);

  // The ambient and directional light intensities are owned by
  // RenderLighting3D with the scene/renderer illumination knobs. Shadow-map
  // enable and darkness remain in GroundSilhouetteSunShadow3D above because
  // that object also owns whether the pass is rendered. Registering the lights
  // re-applies the current illumination scales after a scene rebuild.
  registerSunLights(ambient, sun);

  const diskCfg = SUN_RENDER_CONFIG.visibleSkyDisk;
  if (diskCfg.enabled) {
    const material = new THREE.SpriteMaterial({
      map: getSunDiskTexture(),
      color: SUN_RENDER_CONFIG.visibleSkyDisk.spriteColor,
      transparent: true,
      opacity: diskCfg.opacity,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    const disk = new THREE.Sprite(material);
    disk.name = 'VisibleSunDisk';
    disk.position.copy(target).addScaledVector(direction, diskCfg.distance);
    disk.scale.setScalar(diskCfg.size);
    disk.renderOrder = -100;
    scene.add(disk);
  }
  return groundShadows;
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function terrainDirectionalShade(normal: SimSunDirection): number {
  if (!TERRAIN_SHADOW_RENDER_CONFIG.enabled) return 1;
  const direct = Math.max(
    0,
    normal.x * SUN_DIRECTION_SIM.x +
      normal.y * SUN_DIRECTION_SIM.y +
      normal.z * SUN_DIRECTION_SIM.z,
  );
  return clamp(
    TERRAIN_SHADOW_RENDER_CONFIG.ambient +
      direct * TERRAIN_SHADOW_RENDER_CONFIG.directStrength,
    TERRAIN_SHADOW_RENDER_CONFIG.minShade,
    TERRAIN_SHADOW_RENDER_CONFIG.maxShade,
  );
}

export function terrainPrecomputedShadow(
  x: number,
  y: number,
  height: number,
  mapWidth: number,
  mapHeight: number,
  sampleHeight: (x: number, y: number) => number,
): number {
  const cfg = TERRAIN_SHADOW_RENDER_CONFIG.precomputed;
  if (!TERRAIN_SHADOW_RENDER_CONFIG.enabled || !cfg.enabled) return 1;

  const samples = Math.max(0, cfg.samples | 0);
  if (samples === 0) return 1;

  // Hoist invariants out of the per-sample loop. Caller invokes this
  // per terrain mesh vertex during scene build, so even small per-iter
  // savings compound across thousands of vertices.
  const sampleDistance = cfg.sampleDistance;
  const bias = cfg.bias;
  const strength = cfg.strength;
  const softness = Math.max(1, cfg.softness);
  const samplesInv = 1 / samples;
  // Per-vertex shade can never drop below this without further samples
  // being clipped by terrainSunShade's clamp anyway. Once we hit it we
  // can stop sampling — saves the tail of the ray walk on already-
  // shaded vertices (the ones that need it most).
  const minShade = TERRAIN_SHADOW_RENDER_CONFIG.minShade;

  let shade = 1;
  for (let i = 1; i <= samples; i++) {
    const distance = sampleDistance * i;
    const sx = x + sunHorizontalX * distance;
    const sy = y + sunHorizontalY * distance;
    if (sx < 0 || sy < 0 || sx > mapWidth || sy > mapHeight) continue;

    const rayHeight = height + sunSlope * distance + bias;
    const blocker = sampleHeight(sx, sy) - rayHeight;
    if (blocker <= 0) continue;

    const block = smoothstep(0, softness, blocker);
    const distanceWeight = 1 - (i - 1) * samplesInv;
    const candidate = 1 - strength * block * distanceWeight;
    if (candidate < shade) {
      shade = candidate;
      if (shade <= minShade) return shade;
    }
  }
  return shade;
}

export function terrainSunShade(
  normal: SimSunDirection,
  precomputedShadow: number,
): number {
  return clamp(
    terrainDirectionalShade(normal) * precomputedShadow,
    TERRAIN_SHADOW_RENDER_CONFIG.minShade,
    TERRAIN_SHADOW_RENDER_CONFIG.maxShade,
  );
}
