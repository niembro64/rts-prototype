import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import {
  canEntityProvideFullVision,
  getEntityFullVisionRadius,
} from '../network/stateSerializerVisibility';
import type { Entity, PlayerId } from '../sim/types';
import {
  SUN_RENDER_CONFIG,
  TERRAIN_HORIZON_BLEND_CONFIG,
  WATER_RENDER_CONFIG,
} from '../../config';
import { WATER_FULLY_OPAQUE } from '../sim/Terrain';
import { DEMO_CONFIG } from '@/demoConfig';
import { FOG_CONFIG } from '@/fogConfig';
import { COLORS } from '@/colorsConfig';
import { disposeMesh } from './threeUtils';

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

type FogSphere = {
  timeLeft: number;
  age: number;
  durationSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  radius: number;
  maxAlpha: number;
  threeX: number;
  threeY: number;
  threeZ: number;
  r: number;
  g: number;
  b: number;
};

type FogPool = {
  maxSpheres: number;
  geom: THREE.SphereGeometry;
  mesh: THREE.InstancedMesh;
  alphaArr: Float32Array;
  colorArr: Float32Array;
  alphaAttr: THREE.InstancedBufferAttribute;
  colorAttr: THREE.InstancedBufferAttribute;
  active: FogSphere[];
  colorUpdateMin: number;
  colorUpdateMax: number;
};

type Rgb01 = {
  r: number;
  g: number;
  b: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hexToLinearRgb(hex: number): Rgb01 {
  const color = new THREE.Color(hex);
  return { r: color.r, g: color.g, b: color.b };
}

function multiplyRgb(a: Rgb01, b: Rgb01): Rgb01 {
  return {
    r: a.r * b.r,
    g: a.g * b.g,
    b: a.b * b.b,
  };
}

function scaleRgb(color: Rgb01, scale: number): Rgb01 {
  return {
    r: color.r * scale,
    g: color.g * scale,
    b: color.b * scale,
  };
}

function mixRgb(base: Rgb01, tint: Rgb01, t: number): Rgb01 {
  const clampedT = clamp01(t);
  return {
    r: base.r + (tint.r - base.r) * clampedT,
    g: base.g + (tint.g - base.g) * clampedT,
    b: base.b + (tint.b - base.b) * clampedT,
  };
}

function rrtAndOdtFit(color: Rgb01): Rgb01 {
  const fit = (v: number): number => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  };
  return {
    r: fit(color.r),
    g: fit(color.g),
    b: fit(color.b),
  };
}

function applyAcesFilmicToneMapping(color: Rgb01): Rgb01 {
  const exposed = scaleRgb(color, 1 / 0.6);
  const acesIn = {
    r: 0.59719 * exposed.r + 0.35458 * exposed.g + 0.04823 * exposed.b,
    g: 0.07600 * exposed.r + 0.90834 * exposed.g + 0.01566 * exposed.b,
    b: 0.02840 * exposed.r + 0.13383 * exposed.g + 0.83777 * exposed.b,
  };
  const fit = rrtAndOdtFit(acesIn);
  return {
    r: clamp01(1.60475 * fit.r - 0.53108 * fit.g - 0.07367 * fit.b),
    g: clamp01(-0.10208 * fit.r + 1.10813 * fit.g - 0.00605 * fit.b),
    b: clamp01(-0.00327 * fit.r - 0.07276 * fit.g + 1.07602 * fit.b),
  };
}

function linearToOutputRgb(color: Rgb01): Rgb01 {
  const output = new THREE.Color(color.r, color.g, color.b).convertLinearToSRGB();
  return {
    r: clamp01(output.r),
    g: clamp01(output.g),
    b: clamp01(output.b),
  };
}

function builtInMaterialOutputRgb(linearColor: Rgb01): Rgb01 {
  return linearToOutputRgb(applyAcesFilmicToneMapping(linearColor));
}

function infinityShelfOutputRgb(): Rgb01 {
  const shelfDiffuse = hexToLinearRgb(TERRAIN_HORIZON_BLEND_CONFIG.color);
  const shelfShade = TERRAIN_HORIZON_BLEND_CONFIG.shade;
  shelfDiffuse.r = clamp(shelfDiffuse.r, 0.02, 1) * shelfShade;
  shelfDiffuse.g = clamp(shelfDiffuse.g, 0.02, 1) * shelfShade;
  shelfDiffuse.b = clamp(shelfDiffuse.b, 0.02, 1) * shelfShade;

  const lightColor = hexToLinearRgb(SUN_RENDER_CONFIG.color);
  const directUp = Math.max(0, Math.sin(SUN_RENDER_CONFIG.elevationRad));
  const lightScale =
    (SUN_RENDER_CONFIG.ambientIntensity +
      SUN_RENDER_CONFIG.directionalIntensity * directUp) / Math.PI;
  return builtInMaterialOutputRgb(scaleRgb(multiplyRgb(shelfDiffuse, lightColor), lightScale));
}

function infinityWaterOutputRgb(): Rgb01 {
  const shelfOutput = infinityShelfOutputRgb();
  const waterOutput = builtInMaterialOutputRgb(hexToLinearRgb(WATER_RENDER_CONFIG.color));
  const waterOpacity = WATER_FULLY_OPAQUE ? 1 : clamp01(WATER_RENDER_CONFIG.opacity);
  return mixRgb(shelfOutput, waterOutput, waterOpacity);
}

// FogOfWarFog3D uses a custom ShaderMaterial with toneMapped=false, so
// its instance color is already in final output space. Cache that output
// color once, then assign it to every puff.
const INFINITY_WATER_PUFF_RGB = infinityWaterOutputRgb();

function setFogPuffToInfinityWaterColor(fog: FogSphere): void {
  fog.r = INFINITY_WATER_PUFF_RGB.r;
  fog.g = INFINITY_WATER_PUFF_RGB.g;
  fog.b = INFINITY_WATER_PUFF_RGB.b;
}

const FOG_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
varying vec3 vViewPosition;
varying vec3 vViewCenter;
varying float vViewRadius;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 viewCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 viewPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewCenter = viewCenter.xyz;
  vViewRadius = length((modelViewMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FOG_FRAGMENT_SHADER = `
uniform float uTransparentOuterFraction;
varying float vAlpha;
varying vec3 vColor;
varying vec3 vViewPosition;
varying vec3 vViewCenter;
varying float vViewRadius;
void main() {
  float edge = clamp(length(vViewPosition.xy - vViewCenter.xy) / max(vViewRadius, 0.0001), 0.0, 1.0);
  float visibleRadius = max(0.0001, 1.0 - clamp(uTransparentOuterFraction, 0.0, 0.95));
  float center = clamp((visibleRadius - edge) / visibleRadius, 0.0, 1.0);
  float soft = 0.5 - 0.5 * cos(center * 3.141592653589793);
  float alpha = vAlpha * soft;
  gl_FragColor = vec4(vColor, alpha);
}
`;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Soft fog-of-war field spheres. Unlike smoke puffs, these are not
 *  hard-edged translucent surfaces: fragment alpha eases from fully
 *  transparent at the projected sphere edge to maxAlpha at the center. */
export class FogOfWarFog3D {
  private readonly profile = FOG_CONFIG.fogOfWar;
  private readonly sources: VisionSource[] = [];
  private readonly centerX: number;
  private readonly centerY: number;
  private readonly spawnRadius: number;
  private readonly samplePoint = { x: 0, y: 0 };
  private readonly mat: THREE.ShaderMaterial;
  private readonly pool: FogPool;
  private readonly _scratchMat = new THREE.Matrix4();
  private spawnCredit = 0;
  private rngState = 0x6d2b79f5;

  constructor(
    worldGroup: THREE.Group,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.centerX = mapWidth * 0.5;
    this.centerY = mapHeight * 0.5;
    const outerSpawnRadius = Math.min(mapWidth, mapHeight) * 0.5 - DEMO_CONFIG.spawnMarginPx;
    this.spawnRadius = Math.max(
      0,
      DEMO_CONFIG.baseRings.fogOfWar.radiusFraction * outerSpawnRadius,
    );

    this.mat = new THREE.ShaderMaterial({
      vertexShader: FOG_VERTEX_SHADER,
      fragmentShader: FOG_FRAGMENT_SHADER,
      uniforms: {
        uTransparentOuterFraction: {
          value: Math.min(0.95, Math.max(0, this.profile.transparentOuterFraction)),
        },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });

    const geomCfg = FOG_CONFIG.sphereGeometry;
    this.pool = this.createPool(
      Math.max(8, geomCfg.widthSegments | 0),
      Math.max(6, geomCfg.heightSegments | 0),
      Math.max(1, this.profile.maxPoolSize | 0),
    );
    worldGroup.add(this.pool.mesh);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    enabled: boolean,
    dtMs: number,
  ): void {
    if (!enabled || this.spawnRadius <= 0) {
      this.clearPool();
      return;
    }

    const dtSec = Math.max(0, dtMs / 1000);
    this.collectSources(clientViewState, localPlayerId);
    this.fadeVisibleFog();
    this.advancePool(dtSec);
    this.spawnTowardDensity(dtSec);
    this.flushPool();
  }

  destroy(): void {
    disposeMesh(this.pool.mesh);
    this.pool.active.length = 0;
    this.sources.length = 0;
  }

  private createPool(
    widthSegments: number,
    heightSegments: number,
    maxSpheres: number,
  ): FogPool {
    const geom = new THREE.SphereGeometry(1, widthSegments, heightSegments);
    const alphaArr = new Float32Array(maxSpheres);
    const colorArr = new Float32Array(maxSpheres * 3);
    const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(colorArr, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', alphaAttr);
    geom.setAttribute('aColor', colorAttr);

    const mesh = new THREE.InstancedMesh(geom, this.mat, maxSpheres);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;

    return {
      maxSpheres,
      geom,
      mesh,
      alphaArr,
      colorArr,
      alphaAttr,
      colorAttr,
      active: [],
      colorUpdateMin: Number.POSITIVE_INFINITY,
      colorUpdateMax: -1,
    };
  }

  private clearPool(): void {
    if (this.pool.active.length === 0) return;
    this.pool.active.length = 0;
    this.spawnCredit = 0;
    this.flushPool();
  }

  private advancePool(dtSec: number): void {
    const pool = this.pool;
    let i = 0;
    while (i < pool.active.length) {
      const fog = pool.active[i];
      fog.timeLeft -= dtSec;
      fog.age += dtSec;
      if (fog.timeLeft <= 0) {
        const last = pool.active.length - 1;
        if (i !== last) {
          pool.active[i] = pool.active[last];
          this.writeFogColor(i, pool.active[i]);
        }
        pool.active.pop();
        continue;
      }

      const fadeIn = fog.fadeInSec <= 0 ? 1 : clamp01(fog.age / fog.fadeInSec);
      const fadeOutStartSec = Math.max(0, fog.durationSec - fog.fadeOutSec);
      const fadeOut = fog.fadeOutSec <= 0 || fog.age <= fadeOutStartSec
        ? 1
        : clamp01((fog.durationSec - fog.age) / fog.fadeOutSec);
      pool.alphaArr[i] = fog.maxAlpha * fadeIn * fadeOut;
      this._scratchMat.makeScale(fog.radius, fog.radius, fog.radius);
      this._scratchMat.setPosition(fog.threeX, fog.threeY, fog.threeZ);
      pool.mesh.setMatrixAt(i, this._scratchMat);
      i++;
    }
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sources.length = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFromOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectFromOwned(clientViewState.getBuildingsByPlayer(playerId));
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.sources.push({ x: pulse.x, y: pulse.y, radius: pulse.radius });
    }
  }

  private collectFromOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideFullVision(entity)) continue;
      this.sources.push({
        x: entity.transform.x,
        y: entity.transform.y,
        radius: getEntityFullVisionRadius(entity),
      });
    }
  }

  private spawnTowardDensity(dtSec: number): void {
    const targetActiveCount = this.estimateTargetActiveCount();
    if (targetActiveCount <= 0) {
      this.spawnCredit = 0;
      return;
    }

    const activeCount = this.pool.active.length;
    const missingCount = Math.max(0, targetActiveCount - activeCount);
    const canReplaceAtCap =
      this.profile.capPolicy === 'evictOldest' &&
      activeCount >= this.pool.maxSpheres &&
      activeCount <= targetActiveCount;
    const desiredSpawnCount = missingCount > 0
      ? missingCount
      : canReplaceAtCap ? targetActiveCount : 0;
    if (desiredSpawnCount <= 0) {
      this.spawnCredit = Math.min(this.spawnCredit, 1);
      return;
    }

    const birthRate = targetActiveCount / this.fogDurationSec();
    this.spawnCredit = Math.min(
      this.profile.maxSpawnsPerFrame,
      this.spawnCredit + birthRate * dtSec,
    );
    const emitLimit = Math.min(
      this.profile.maxSpawnsPerFrame,
      desiredSpawnCount,
      this.profile.capPolicy === 'evictOldest'
        ? this.pool.maxSpheres
        : this.pool.maxSpheres - this.pool.active.length,
      Math.floor(this.spawnCredit),
    );
    if (emitLimit <= 0) return;

    let emitted = 0;
    for (
      let attempts = 0;
      attempts < emitLimit * this.profile.spawnAttemptsPerFog && emitted < emitLimit;
      attempts++
    ) {
      const { x, y } = this.samplePointInSpawnDisk();
      if (this.isInVision(x, y)) continue;
      if (this.spawnFog(x, y)) emitted++;
    }
    this.spawnCredit = Math.max(0, this.spawnCredit - emitted);
  }

  private fadeVisibleFog(): void {
    const fadeOutSec = Math.max(0, this.profile.fadeOutMs / 1000);
    const active = this.pool.active;
    for (let i = 0; i < active.length; i++) {
      const fog = active[i];
      if (!this.isInVision(fog.threeX, fog.threeZ)) continue;
      if (fadeOutSec <= 0) {
        fog.timeLeft = 0;
        fog.durationSec = fog.age;
        continue;
      }
      fog.timeLeft = Math.max(0.001, Math.min(fog.timeLeft, fadeOutSec));
      fog.durationSec = Math.min(fog.durationSec, fog.age + fog.timeLeft);
    }
  }

  private spawnFog(x: number, y: number): boolean {
    const pool = this.pool;
    const replacing = pool.active.length >= pool.maxSpheres;
    if (replacing && this.profile.capPolicy === 'skipWhenFull') return false;

    const radius = Math.max(1, this.profile.radius);
    const z = this.randomFogZ();
    const durationSec = this.fogDurationSec();
    const fog: FogSphere = {
      timeLeft: durationSec,
      age: 0,
      durationSec,
      fadeInSec: Math.max(0, this.profile.fadeInMs / 1000),
      fadeOutSec: Math.max(0, this.profile.fadeOutMs / 1000),
      radius,
      maxAlpha: Math.max(0, COLORS.world.fogOfWar.cloud.maxAlpha),
      threeX: x,
      threeY: z,
      threeZ: y,
      r: 0,
      g: 0,
      b: 0,
    };
    setFogPuffToInfinityWaterColor(fog);
    const index = replacing ? this.pickFogEvictionSlot() : pool.active.length;
    if (replacing) pool.active[index] = fog;
    else pool.active.push(fog);
    pool.alphaArr[index] = 0;
    this._scratchMat.makeScale(fog.radius, fog.radius, fog.radius);
    this._scratchMat.setPosition(fog.threeX, fog.threeY, fog.threeZ);
    pool.mesh.setMatrixAt(index, this._scratchMat);
    this.writeFogColor(index, fog);
    return true;
  }

  private randomFogZ(): number {
    return this.profile.zMin + this.rand01() * Math.max(0, this.profile.zRange);
  }

  private pickFogEvictionSlot(): number {
    let bestIndex = 0;
    let bestLifeFrac = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.pool.active.length; i++) {
      const fog = this.pool.active[i];
      const lifeFrac = fog.timeLeft / fog.durationSec;
      if (lifeFrac < bestLifeFrac) {
        bestIndex = i;
        bestLifeFrac = lifeFrac;
      }
    }
    return bestIndex;
  }

  private isInVision(x: number, y: number): boolean {
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const dx = x - source.x;
      const dy = y - source.y;
      if (dx * dx + dy * dy <= source.radius * source.radius) return true;
    }
    return false;
  }

  private estimateTargetActiveCount(): number {
    let hiddenSamples = 0;
    const sampleCount = Math.max(1, this.profile.densitySamples | 0);
    for (let i = 0; i < sampleCount; i++) {
      const { x, y } = this.samplePointInSpawnDisk();
      if (!this.isInVision(x, y)) hiddenSamples++;
    }
    if (hiddenSamples <= 0) return 0;
    const hiddenRatio = hiddenSamples / sampleCount;
    return Math.min(
      this.pool.maxSpheres,
      Math.max(1, Math.ceil(this.pool.maxSpheres * hiddenRatio)),
    );
  }

  private fogDurationSec(): number {
    return Math.max(
      0.001,
      Math.max(0, this.profile.fadeInMs / 1000) +
      Math.max(0, this.profile.fadeOutMs / 1000),
    );
  }

  private samplePointInSpawnDisk(): { x: number; y: number } {
    const angle = this.rand01() * Math.PI * 2;
    const radius = Math.sqrt(this.rand01()) * this.spawnRadius;
    this.samplePoint.x = this.centerX + Math.cos(angle) * radius;
    this.samplePoint.y = this.centerY + Math.sin(angle) * radius;
    return this.samplePoint;
  }

  private writeFogColor(index: number, fog: FogSphere): void {
    const pool = this.pool;
    pool.colorArr[index * 3] = fog.r;
    pool.colorArr[index * 3 + 1] = fog.g;
    pool.colorArr[index * 3 + 2] = fog.b;
    if (index < pool.colorUpdateMin) pool.colorUpdateMin = index;
    if (index > pool.colorUpdateMax) pool.colorUpdateMax = index;
  }

  private flushPool(): void {
    const pool = this.pool;
    pool.mesh.count = pool.active.length;
    if (pool.active.length > 0) {
      const count = pool.active.length;
      pool.mesh.instanceMatrix.clearUpdateRanges();
      pool.mesh.instanceMatrix.addUpdateRange(0, count * 16);
      pool.mesh.instanceMatrix.needsUpdate = true;
      pool.alphaAttr.clearUpdateRanges();
      pool.alphaAttr.addUpdateRange(0, count);
      pool.alphaAttr.needsUpdate = true;
      if (pool.colorUpdateMax >= pool.colorUpdateMin) {
        pool.colorAttr.clearUpdateRanges();
        pool.colorAttr.addUpdateRange(
          pool.colorUpdateMin * 3,
          (pool.colorUpdateMax - pool.colorUpdateMin + 1) * 3,
        );
        pool.colorAttr.needsUpdate = true;
      }
    }
    pool.colorUpdateMin = Number.POSITIVE_INFINITY;
    pool.colorUpdateMax = -1;
  }

  private rand01(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x | 0;
    return ((x >>> 0) / 4294967296);
  }
}
