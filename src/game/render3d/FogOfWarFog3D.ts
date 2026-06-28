import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import {
  canEntityProvideFullVision,
  getEntityFullVisionRadius,
} from '../network/stateSerializerVisibility';
import type { Entity, PlayerId } from '../sim/types';
import { DEMO_CONFIG } from '@/demoConfig';
import { FOG_CONFIG } from '@/fogConfig';
import { COLORS } from '@/colorsConfig';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { disposeMesh } from './threeUtils';
import { WATER_SURFACE_OUTPUT_LINEAR_RGB } from './WaterColor3D';
import { clamp01 } from './RenderUtils';

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

// FogOfWarFog3D uses a custom ShaderMaterial, but its color attribute is kept
// in Three's normal linear working RGB. The fragment shader below then runs
// <colorspace_fragment>, so the output conversion path matches built-in
// materials instead of writing raw sRGB bytes directly.
const INFINITY_WATER_PUFF_RGB = WATER_SURFACE_OUTPUT_LINEAR_RGB;

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
  #include <colorspace_fragment>
}
`;

/** Soft fog-of-war field spheres. Unlike smoke puffs, these are not
 *  hard-edged translucent surfaces: fragment alpha eases from fully
 *  transparent at the projected sphere edge to maxAlpha at the center. */
export class FogOfWarFog3D {
  private readonly profile = FOG_CONFIG.fogOfWar;
  private readonly sourceXs: number[] = [];
  private readonly sourceYs: number[] = [];
  private readonly sourceRadii: number[] = [];
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

    this.pool = this.createPool(Math.max(1, this.profile.maxPoolSize | 0));
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
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
  }

  private createPool(maxSpheres: number): FogPool {
    const geom = createPrimitiveSphereGeometry('fog', 'close');
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
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFromOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectFromOwned(clientViewState.getBuildingsByPlayer(playerId));
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushSource(pulse.x, pulse.y, pulse.radius);
    }
  }

  private collectFromOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideFullVision(entity)) continue;
      this.pushSource(entity.transform.x, entity.transform.y, getEntityFullVisionRadius(entity));
    }
  }

  private pushSource(x: number, y: number, radius: number): void {
    this.sourceXs.push(x);
    this.sourceYs.push(y);
    this.sourceRadii.push(radius);
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
    for (let i = 0; i < this.sourceXs.length; i++) {
      const dx = x - this.sourceXs[i];
      const dy = y - this.sourceYs[i];
      const radius = this.sourceRadii[i];
      if (dx * dx + dy * dy <= radius * radius) return true;
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
    if (pool.mesh.count !== pool.active.length) pool.mesh.count = pool.active.length;
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
