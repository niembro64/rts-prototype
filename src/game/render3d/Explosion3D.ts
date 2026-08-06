// Explosion3D - short-lived fire explosion markers for projectile impacts
// and unit deaths in the 3D view.
//
// Every impact emits exactly one bright white sphere that expands and fades. Material death
// debris remains separate in Debris3D.

import * as THREE from 'three';
import {
  INSTANCED_COLOR_ALPHA_PARTICLE_FRAGMENT_SHADER,
  INSTANCED_COLOR_ALPHA_PARTICLE_VERTEX_SHADER,
} from './instancedColorAlphaParticleShader';
import type { FireExplosionStyle } from '@/types/graphics';
import { COLORS } from '@/colorsConfig';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';
import { uploadColorAlphaMatrixPrefix } from './instancedBufferUpdate';
import {
  createInstancedColorAlphaPool,
  PRIMITIVE_GEOMETRY_TIERS,
} from './instancedParticlePool3D';
import {
  createPrimitiveSphereGeometry,
  getSharedPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { clamp01 } from './RenderUtils';
import type { RenderViewState3D } from './RenderFrameState3D';
import { detailLevelForViewPosition, geometryTierForDetail } from './EntityDetailLevel3D';
import { applyExposureToRawShader } from './RenderLighting3D';

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
    this.mat = new THREE.ShaderMaterial({
      vertexShader: INSTANCED_COLOR_ALPHA_PARTICLE_VERTEX_SHADER,
      fragmentShader: INSTANCED_COLOR_ALPHA_PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    // Raw shader: writes gl_FragColor itself, so it never tone-maps and is
    // invisible to exposure without this.
    applyExposureToRawShader(this.mat);
    const pool = createInstancedColorAlphaPool(parent, this.geom, cap, this.mat, renderOrder);
    this.mesh = pool.mesh;
    this.alphaArr = pool.alphaArr;
    this.colorArr = pool.colorArr;
    this.alphaAttr = pool.alphaAttr;
    this.colorAttr = pool.colorAttr;
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
    uploadColorAlphaMatrixPrefix(this.mesh, this.alphaAttr, this.colorAttr, n);
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
  // Per-frame tier tallies — instance-level scratch so update() does not
  // allocate a counter object every frame.
  private readonly _tierCounts: Record<PrimitiveGeometryTier, number> = { close: 0, mid: 0, far: 0 };

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
      this.puffPools.close.setCount(0);
      this.puffPools.mid.setCount(0);
      this.puffPools.far.setCount(0);
      return;
    }

    const counts = this._tierCounts;
    counts.close = 0;
    counts.mid = 0;
    counts.far = 0;

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
    for (let t = 0; t < PRIMITIVE_GEOMETRY_TIERS.length; t++) {
      const tier = PRIMITIVE_GEOMETRY_TIERS[t];
      this.puffPools[tier].setCount(counts[tier]);
    }
  }

  destroy(): void {
    this.puffs.length = 0;
    for (const pool of Object.values(this.puffPools)) pool.destroy();
    this.root.parent?.remove(this.root);
  }
}
