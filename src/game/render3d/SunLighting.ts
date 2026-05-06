import * as THREE from 'three';
import {
  SUN_RENDER_CONFIG,
  TERRAIN_SHADOW_RENDER_CONFIG,
} from '../../config';

export type SimSunDirection = Readonly<{
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

const sunHorizontalMag = Math.max(
  1e-6,
  Math.hypot(SUN_DIRECTION_SIM.x, SUN_DIRECTION_SIM.y),
);
const sunHorizontalX = SUN_DIRECTION_SIM.x / sunHorizontalMag;
const sunHorizontalY = SUN_DIRECTION_SIM.y / sunHorizontalMag;
const sunSlope = SUN_DIRECTION_SIM.z / sunHorizontalMag;
let sunDiskTexture: THREE.CanvasTexture | null = null;

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
  gradient.addColorStop(1, 'rgba(246,198,111,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  sunDiskTexture = new THREE.CanvasTexture(canvas);
  sunDiskTexture.colorSpace = THREE.SRGBColorSpace;
  sunDiskTexture.magFilter = THREE.LinearFilter;
  sunDiskTexture.minFilter = THREE.LinearFilter;
  sunDiskTexture.generateMipmaps = false;
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
): void {
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

  const diskCfg = SUN_RENDER_CONFIG.visibleSkyDisk;
  if (diskCfg.enabled) {
    const material = new THREE.SpriteMaterial({
      map: getSunDiskTexture(),
      color: 0xffffff,
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
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function terrainDirectionalShade(normal: SimSunDirection): number {
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

  let shade = 1;
  const samples = Math.max(0, cfg.samples | 0);
  for (let i = 1; i <= samples; i++) {
    const distance = cfg.sampleDistance * i;
    const sx = x + sunHorizontalX * distance;
    const sy = y + sunHorizontalY * distance;
    if (sx < 0 || sy < 0 || sx > mapWidth || sy > mapHeight) continue;

    const rayHeight = height + sunSlope * distance + cfg.bias;
    const blocker = sampleHeight(sx, sy) - rayHeight;
    if (blocker <= 0) continue;

    const block = clamp(blocker / Math.max(1, cfg.softness), 0, 1);
    const distanceWeight = 1 - (i - 1) / Math.max(1, samples);
    shade = Math.min(shade, 1 - cfg.strength * block * distanceWeight);
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
