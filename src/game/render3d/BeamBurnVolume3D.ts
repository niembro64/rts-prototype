// DamageBurnVolume3D — persistent world-space thermal residue for damage
// impacts that do not terminate on terrain.
//
// Cells are fixed at the coordinates where energy was deposited. Repeated
// exposure feeds the same 3D cell; moving endpoints leave a sparse spatial
// trail. Heat/char aging is shader-driven and the bounded cell pool uses O(1)
// LRU eviction, matching the ground-scorch performance policy.

import * as THREE from 'three';
import { bindBurnDecayAttributes } from './instancedBufferUpdate';
import { getBurnMarks, getGraphicsConfig } from '@/clientBarConfig';
import { BURN_COLOR_TAU } from '@/config';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { applyExposureToRawShader } from './RenderLighting3D';
import { disposeMesh } from './threeUtils';
import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';

const MAX_BURN_VOLUMES = 1024;
// Space burns are volumes rather than surface pixels. Coarse 12-unit cells
// prevent damage spheres several units wide from stacking opaque shells every
// four units as an endpoint moves.
const BURN_VOLUME_CELL_SIZE = 12;
const BURN_VOLUME_RESIDUE_TAU_MS = 2600;
const BURN_VOLUME_MAX_LIFE_SEC = 9;
const PRUNE_INTERVAL_MS = 500;
const PACKED_CELL_BASE = 131072;
const PACKED_CELL_OFFSET = PACKED_CELL_BASE / 2;

const VERTEX_SHADER = /* glsl */`
  attribute float aLastHitSec;
  attribute float aHeat;
  attribute float aChar;
  attribute float aSeed;
  uniform float uTimeSec;
  uniform float uMaxLifeSec;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying float vLastHitSec;
  varying float vHeat;
  varying float vChar;
  varying float vSeed;

  void main() {
    vLastHitSec = aLastHitSec;
    vHeat = aHeat;
    vChar = aChar;
    vSeed = aSeed;
    float age = max(0.0, uTimeSec - aLastHitSec);
    float lifeProgress = clamp(age / max(0.001, uMaxLifeSec), 0.0, 1.0);
    float wrinkle =
      sin(position.x * 9.0 + aSeed * 31.0) *
      sin(position.y * 11.0 - aSeed * 19.0) *
      sin(position.z * 13.0 + aSeed * 23.0);
    float coolingScale = mix(1.0, 0.62, smoothstep(0.0, 1.0, lifeProgress));
    vec3 local = position * (1.0 + wrinkle * 0.085) * coolingScale;
    vec4 worldPosition = instanceMatrix * vec4(local, 1.0);
    vec4 mv = modelViewMatrix * worldPosition;
    vLocal = local;
    vNormal = normalize(mat3(modelViewMatrix * instanceMatrix) * normal);
    vViewDirection = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform float uTimeSec;
  uniform float uHotTauSec;
  uniform float uResidueTauSec;
  uniform float uMaxLifeSec;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  varying float vLastHitSec;
  varying float vHeat;
  varying float vChar;
  varying float vSeed;

  void main() {
    float age = max(0.0, uTimeSec - vLastHitSec);
    float hot = vHeat * exp(-age / max(0.001, uHotTauSec));
    float residue = vChar * exp(-age / max(0.001, uResidueTauSec));
    float lifeProgress = clamp(age / max(0.001, uMaxLifeSec), 0.0, 1.0);
    float survival = 1.0 - smoothstep(0.0, 1.0, lifeProgress);
    float fieldA = sin(vLocal.x * 12.0 + vLocal.y * 7.0 + vSeed * 37.0);
    float fieldB = sin(vLocal.z * 15.0 - vLocal.y * 9.0 - vSeed * 29.0);
    float fieldC = sin((vLocal.x + vLocal.z) * 18.0 + vSeed * 17.0);
    float fissure = smoothstep(0.72, 0.97, abs(fieldA * fieldB * fieldC));
    float dissolveField = 0.5 + 0.5 * sin(
      vLocal.x * 19.0 - vLocal.y * 23.0 + vLocal.z * 17.0 + vSeed * 53.0
    );
    float dissolveThreshold = smoothstep(0.18, 1.0, lifeProgress) * 0.92;
    if (dissolveField < dissolveThreshold) discard;
    float mottling = 0.72 + 0.28 * fieldA * fieldB;
    float facing = max(0.0, dot(normalize(vNormal), normalize(vViewDirection)));
    float rim = pow(1.0 - facing, 2.0);
    vec3 charColor = vec3(0.035, 0.014, 0.006) * mottling;
    vec3 emberColor = mix(vec3(0.72, 0.035, 0.002), vec3(1.0, 0.48, 0.035), fissure);
    float ember = hot * (0.16 + 0.84 * fissure);
    vec3 color = mix(charColor, emberColor, clamp(ember, 0.0, 1.0));
    float alpha = clamp(
      residue * (0.10 + rim * 0.12) + ember * (0.22 + fissure * 0.30),
      0.0,
      0.62
    ) * survival;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

type BurnVolumeKey = number | string;

export function beamBurnVolumeCellKey(
  x: number,
  y: number,
  z: number,
  cellSize: number = BURN_VOLUME_CELL_SIZE,
): BurnVolumeKey {
  const inv = 1 / Math.max(0.001, cellSize);
  const ix = Math.floor(x * inv);
  const iy = Math.floor(y * inv);
  const iz = Math.floor(z * inv);
  if (
    ix >= -PACKED_CELL_OFFSET && ix < PACKED_CELL_OFFSET &&
    iy >= -PACKED_CELL_OFFSET && iy < PACKED_CELL_OFFSET &&
    iz >= -PACKED_CELL_OFFSET && iz < PACKED_CELL_OFFSET
  ) {
    return ((ix + PACKED_CELL_OFFSET) * PACKED_CELL_BASE +
      iy + PACKED_CELL_OFFSET) * PACKED_CELL_BASE + iz + PACKED_CELL_OFFSET;
  }
  return `${ix}:${iy}:${iz}`;
}

type BurnVolume = {
  key: BurnVolumeKey;
  slot: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  heat: number;
  char: number;
  lastHitSec: number;
  seed: number;
};

function hashKey(key: BurnVolumeKey): number {
  if (typeof key === 'number') {
    let hash = (key % 0x100000000) | 0;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x45d9f3b);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 0x100000000;
  }
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}


export class DamageBurnVolume3D {
  private readonly geometry = createPrimitiveSphereGeometry('beam', 'far', 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly lastHit = new Float32Array(MAX_BURN_VOLUMES);
  private readonly heat = new Float32Array(MAX_BURN_VOLUMES);
  private readonly char = new Float32Array(MAX_BURN_VOLUMES);
  private readonly seed = new Float32Array(MAX_BURN_VOLUMES);
  private readonly lastHitAttr: THREE.InstancedBufferAttribute;
  private readonly heatAttr: THREE.InstancedBufferAttribute;
  private readonly charAttr: THREE.InstancedBufferAttribute;
  private readonly seedAttr: THREE.InstancedBufferAttribute;
  private readonly matrixDirty = createDirtySlotSpan();
  private readonly lastHitDirty = createDirtySlotSpan();
  private readonly heatDirty = createDirtySlotSpan();
  private readonly charDirty = createDirtySlotSpan();
  private readonly seedDirty = createDirtySlotSpan();
  private readonly volumes: BurnVolume[] = [];
  private readonly volumeByKey = new Map<BurnVolumeKey, BurnVolume>();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly matrix = new THREE.Matrix4();
  private timeSec = 0;
  private pruneAccumMs = 0;
  private currentCap = MAX_BURN_VOLUMES;
  private enabled = true;

  constructor(parent: THREE.Group) {
    const burnAttrs = bindBurnDecayAttributes(this.geometry, {
      lastHit: this.lastHit,
      heat: this.heat,
      char: this.char,
      seed: this.seed,
    });
    this.lastHitAttr = burnAttrs.lastHitAttr;
    this.heatAttr = burnAttrs.heatAttr;
    this.charAttr = burnAttrs.charAttr;
    this.seedAttr = burnAttrs.seedAttr;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTimeSec: { value: 0 },
        uHotTauSec: { value: Math.max(0.001, BURN_COLOR_TAU / 1000) },
        uResidueTauSec: { value: BURN_VOLUME_RESIDUE_TAU_MS / 1000 },
        uMaxLifeSec: { value: BURN_VOLUME_MAX_LIFE_SEC },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    applyExposureToRawShader(this.material);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_BURN_VOLUMES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    parent.add(this.mesh);
  }

  beginFrame(timeSec: number, dtMs: number): void {
    this.timeSec = timeSec;
    this.material.uniforms.uTimeSec.value = timeSec;
    this.enabled = getBurnMarks();
    if (!this.enabled) {
      this.clear();
      return;
    }
    const density = Math.max(0, Math.min(1, getGraphicsConfig().burnMarkDensity ?? 1));
    this.currentCap = Math.min(MAX_BURN_VOLUMES, Math.round(MAX_BURN_VOLUMES * density));
    const lifeMultiplier = 0.5 + density * 0.5;
    this.material.uniforms.uHotTauSec.value =
      Math.max(0.001, BURN_COLOR_TAU * lifeMultiplier / 1000);
    this.material.uniforms.uResidueTauSec.value =
      Math.max(0.001, BURN_VOLUME_RESIDUE_TAU_MS * lifeMultiplier / 1000);
    this.material.uniforms.uMaxLifeSec.value =
      BURN_VOLUME_MAX_LIFE_SEC * lifeMultiplier;
    while (this.volumes.length > this.currentCap) this.removeOldest();
    this.pruneAccumMs += Math.max(0, Math.min(250, dtMs));
    if (this.pruneAccumMs >= PRUNE_INTERVAL_MS) {
      this.pruneAccumMs %= PRUNE_INTERVAL_MS;
      this.pruneExpired();
    }
  }

  deposit(x: number, y: number, z: number, radius: number, energy: number): void {
    if (!this.enabled || this.currentCap <= 0 || !(energy > 0)) return;
    const key = beamBurnVolumeCellKey(x, y, z);
    let volume = this.volumeByKey.get(key);
    if (!volume) {
      if (this.volumes.length >= this.currentCap || this.volumes.length >= MAX_BURN_VOLUMES) {
        this.removeOldest();
      }
      volume = {
        key,
        slot: this.volumes.length,
        x,
        y,
        z,
        radius: Math.max(BURN_VOLUME_CELL_SIZE * 0.34, radius),
        heat: 0,
        char: 0,
        lastHitSec: this.timeSec,
        seed: hashKey(key),
      };
      this.volumes.push(volume);
      this.volumeByKey.set(key, volume);
      this.writeMatrix(volume);
      this.seed[volume.slot] = volume.seed;
      markDirtySlot(this.seedDirty, volume.slot);
    } else {
      this.volumeByKey.delete(key);
      this.volumeByKey.set(key, volume);
    }

    const age = Math.max(0, this.timeSec - volume.lastHitSec);
    const hotTau = Math.max(0.001, this.material.uniforms.uHotTauSec.value as number);
    const residueTau = Math.max(0.001, this.material.uniforms.uResidueTauSec.value as number);
    volume.heat = Math.min(1, volume.heat * Math.exp(-age / hotTau) + energy * 0.34);
    volume.char = Math.min(1, volume.char * Math.exp(-age / residueTau) + energy * 0.075);
    const nextRadius = Math.max(volume.radius, radius);
    if (nextRadius !== volume.radius) {
      volume.radius = nextRadius;
      this.writeMatrix(volume);
    }
    volume.lastHitSec = this.timeSec;
    this.writeThermalAttributes(volume);
  }

  endFrame(): void {
    this.mesh.count = this.volumes.length;
    uploadDirtySlotSpan(this.mesh.instanceMatrix, this.matrixDirty, 16, this.volumes.length);
    uploadDirtySlotSpan(this.lastHitAttr, this.lastHitDirty, 1, this.volumes.length);
    uploadDirtySlotSpan(this.heatAttr, this.heatDirty, 1, this.volumes.length);
    uploadDirtySlotSpan(this.charAttr, this.charDirty, 1, this.volumes.length);
    uploadDirtySlotSpan(this.seedAttr, this.seedDirty, 1, this.volumes.length);
  }

  private writeMatrix(volume: BurnVolume): void {
    const seed = volume.seed;
    this.euler.set(seed * 2.1, seed * 4.7, seed * 7.3);
    this.quaternion.setFromEuler(this.euler);
    this.position.set(volume.x, volume.z, volume.y);
    this.scale.set(
      volume.radius * (0.84 + seed * 0.24),
      volume.radius * (0.88 + (1 - seed) * 0.20),
      volume.radius * (0.82 + Math.abs(seed - 0.5) * 0.36),
    );
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(volume.slot, this.matrix);
    markDirtySlot(this.matrixDirty, volume.slot);
  }

  private writeThermalAttributes(volume: BurnVolume): void {
    const slot = volume.slot;
    this.lastHit[slot] = volume.lastHitSec;
    this.heat[slot] = volume.heat;
    this.char[slot] = volume.char;
    markDirtySlot(this.lastHitDirty, slot);
    markDirtySlot(this.heatDirty, slot);
    markDirtySlot(this.charDirty, slot);
  }

  private pruneExpired(): void {
    const maxLifeSec = Math.max(0.001, this.material.uniforms.uMaxLifeSec.value as number);
    for (let i = this.volumes.length - 1; i >= 0; i--) {
      const volume = this.volumes[i];
      const age = Math.max(0, this.timeSec - volume.lastHitSec);
      if (age >= maxLifeSec) this.removeAt(i);
    }
  }

  private removeOldest(): void {
    const oldest = this.volumeByKey.values().next();
    if (!oldest.done) this.removeAt(oldest.value.slot);
  }

  private removeAt(slot: number): void {
    const last = this.volumes.length - 1;
    const removed = this.volumes[slot];
    this.volumeByKey.delete(removed.key);
    if (slot !== last) {
      const moved = this.volumes[last];
      moved.slot = slot;
      this.volumes[slot] = moved;
      const matrices = this.mesh.instanceMatrix.array as Float32Array;
      matrices.copyWithin(slot * 16, last * 16, last * 16 + 16);
      this.lastHit[slot] = this.lastHit[last];
      this.heat[slot] = this.heat[last];
      this.char[slot] = this.char[last];
      this.seed[slot] = this.seed[last];
      markDirtySlot(this.matrixDirty, slot);
      markDirtySlot(this.lastHitDirty, slot);
      markDirtySlot(this.heatDirty, slot);
      markDirtySlot(this.charDirty, slot);
      markDirtySlot(this.seedDirty, slot);
    }
    this.volumes.pop();
    this.mesh.count = this.volumes.length;
  }

  private clear(): void {
    this.volumes.length = 0;
    this.volumeByKey.clear();
    this.mesh.count = 0;
    this.pruneAccumMs = 0;
    clearDirtySlotSpan(this.matrixDirty);
    clearDirtySlotSpan(this.lastHitDirty);
    clearDirtySlotSpan(this.heatDirty);
    clearDirtySlotSpan(this.charDirty);
    clearDirtySlotSpan(this.seedDirty);
  }

  destroy(): void {
    this.clear();
    disposeMesh(this.mesh);
  }
}

export { DamageBurnVolume3D as BeamBurnVolume3D };
