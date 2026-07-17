// Explosion3D - short-lived fire explosion markers for projectile impacts
// and unit deaths in the 3D view.
//
// Every impact emits exactly one bright white sphere that expands and fades. Material death
// debris remains separate in Debris3D.

import * as THREE from 'three';
import type { FireExplosionStyle } from '@/types/graphics';
import { COLORS } from '@/colorsConfig';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';
import {
  createPrimitiveSphereGeometry,
  getSharedPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { clamp01 } from './RenderUtils';
import type { RenderViewState3D } from './RenderFrameState3D';
import { detailLevelForViewPosition, geometryTierForDetail } from './EntityDetailLevel3D';

const CORE_COLOR = COLORS.effects.explosion.core.colorHex;
const CORE_LIFETIME_MS = 180;
const DURATION_BASE_RADIUS = 10;
const CORE_EXPAND_START = 0.6;
const CORE_EXPAND_END = 1.6;
const MIN_IMPACT_RADIUS = 1.5;
const MAX_PUFFS = 2048;
const MAX_PUFF_SPAWNS_PER_FRAME = 256;

type ExplosionStyle = FireExplosionStyle;

type Puff = {
  startR: number;
  endR: number;
  lifetimeMs: number;
  ageMs: number;
  px: number;
  py: number;
  pz: number;
  r: number;
  g: number;
  b: number;
};

const PARTICLE_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const PARTICLE_FRAGMENT_SHADER = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

function durationMultiplier(radius: number): number {
  return 1 + Math.log2(Math.max(1, radius / DURATION_BASE_RADIUS));
}

class InstancedSpherePool {
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  readonly mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private colorArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private scratch = new THREE.Matrix4();

  constructor(parent: THREE.Group, cap: number, renderOrder: number, tier: PrimitiveGeometryTier) {
    this.geom = tier === 'far'
      ? getSharedPrimitiveTetrahedronGeometry(1).clone()
      : createPrimitiveSphereGeometry('effect', tier);
    this.alphaArr = new Float32Array(cap);
    this.colorArr = new Float32Array(cap * 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);
    this.geom.setAttribute('aColor', this.colorAttr);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    parent.add(this.mesh);
  }

  write(
    i: number,
    x: number,
    y: number,
    z: number,
    scale: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    this.scratch.makeScale(scale, scale, scale);
    this.scratch.setPosition(x, y, z);
    this.mesh.setMatrixAt(i, this.scratch);
    this.alphaArr[i] = alpha;
    this.colorArr[i * 3] = r;
    this.colorArr[i * 3 + 1] = g;
    this.colorArr[i * 3 + 2] = b;
  }

  setCount(n: number): void {
    this.mesh.count = n;
    if (n <= 0) return;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.addUpdateRange(0, n);
    this.alphaAttr.needsUpdate = true;
    this.colorAttr.clearUpdateRanges();
    this.colorAttr.addUpdateRange(0, n * 3);
    this.colorAttr.needsUpdate = true;
  }

  prepareWarmupInstance(): void {
    this.write(0, 0, 0, 0, 0, 1, 1, 1, 0);
    this.setCount(1);
  }

  destroy(): void {
    disposeMesh(this.mesh);
  }
}

export class Explosion3D {
  static warnedBadInput = false;
  private root: THREE.Group;
  private puffPools: Record<PrimitiveGeometryTier, InstancedSpherePool>;
  private puffs: Puff[] = [];
  private puffSpawnsThisFrame = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.puffPools = {
      close: new InstancedSpherePool(this.root, MAX_PUFFS, 14, 'close'),
      mid: new InstancedSpherePool(this.root, MAX_PUFFS, 14, 'mid'),
      far: new InstancedSpherePool(this.root, MAX_PUFFS, 14, 'far'),
    };
  }

  beginFrame(): void {
    this.puffSpawnsThisFrame = 0;
  }

  prepareWarmup(): void {
    if (this.puffs.length > 0) return;
    for (const pool of Object.values(this.puffPools)) pool.prepareWarmupInstance();
  }

  finishWarmup(): void {
    if (this.puffs.length > 0) return;
    for (const pool of Object.values(this.puffPools)) pool.setCount(0);
  }

  spawnImpact(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    _momentumX: number = 0,
    _momentumZ: number = 0,
    _shellColor?: number,
    _styleOverride?: ExplosionStyle,
    detailScale: number = 1,
  ): void {
    const r = Number.isFinite(radius)
      ? Math.max(radius, MIN_IMPACT_RADIUS)
      : MIN_IMPACT_RADIUS;
    const durMult = durationMultiplier(r);
    const lod = clamp01(detailScale);
    const sizeScale = 0.72 + lod * 0.28;
    this.addPuff(
      simX,
      simY,
      simZ,
      CORE_LIFETIME_MS * durMult * (0.62 + lod * 0.38),
      r * CORE_EXPAND_START * sizeScale,
      r * CORE_EXPAND_END * sizeScale,
    );
  }

  spawnDeath(
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    momentumX: number = 0,
    momentumZ: number = 0,
    styleOverride?: ExplosionStyle,
    detailScale: number = 1,
  ): void {
    this.spawnImpact(
      simX,
      simY,
      simZ,
      radius * 2.5,
      momentumX,
      momentumZ,
      undefined,
      styleOverride,
      detailScale,
    );
  }

  private addPuff(
    simX: number,
    simY: number,
    simZ: number,
    lifetimeMs: number,
    startR: number,
    endR: number,
  ): void {
    if (this.puffs.length >= MAX_PUFFS) return;
    if (this.puffSpawnsThisFrame >= MAX_PUFF_SPAWNS_PER_FRAME) return;
    if (
      !Number.isFinite(simX) ||
      !Number.isFinite(simY) ||
      !Number.isFinite(simZ) ||
      !Number.isFinite(lifetimeMs) ||
      !Number.isFinite(startR) ||
      !Number.isFinite(endR)
    ) {
      if (!Explosion3D.warnedBadInput) {
        Explosion3D.warnedBadInput = true;
        console.error('Explosion3D.addPuff dropped puff with non-finite input', {
          simX, simY, simZ, lifetimeMs, startR, endR,
        });
      }
      return;
    }
    this.puffSpawnsThisFrame++;
    const { r, g, b } = hexToRgb01(CORE_COLOR);
    this.puffs.push({
      startR,
      endR,
      lifetimeMs,
      ageMs: 0,
      px: simX,
      py: simZ,
      pz: simY,
      r,
      g,
      b,
    });
  }

  update(dtMs: number, view?: RenderViewState3D): void {
    if (this.puffs.length === 0) {
      for (const pool of Object.values(this.puffPools)) pool.setCount(0);
      return;
    }

    const counts: Record<PrimitiveGeometryTier, number> = { close: 0, mid: 0, far: 0 };

    let i = 0;
    while (i < this.puffs.length) {
      const p = this.puffs[i];
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifetimeMs) {
        const last = this.puffs.length - 1;
        if (i !== last) this.puffs[i] = this.puffs[last];
        this.puffs.pop();
        continue;
      }
      const t = p.ageMs / p.lifetimeMs;
      const scale = p.startR + (p.endR - p.startR) * t;
      const fade = (1 - t) * (1 - t) * (1 - t);
      const tier = view
        ? geometryTierForDetail(detailLevelForViewPosition(view, p.px, p.pz, p.py, scale))
        : 'close';
      const writeIndex = counts[tier]++;
      this.puffPools[tier].write(writeIndex, p.px, p.py, p.pz, scale, p.r, p.g, p.b, fade);
      i++;
    }
    for (const tier of ['close', 'mid', 'far'] as const) {
      this.puffPools[tier].setCount(counts[tier]);
    }
  }

  destroy(): void {
    this.puffs.length = 0;
    for (const pool of Object.values(this.puffPools)) pool.destroy();
    this.root.parent?.remove(this.root);
  }
}
