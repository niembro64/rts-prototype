// Explosion3D - short-lived fire explosion markers for projectile impacts
// and unit deaths in the 3D view.
//
// This renderer intentionally has no fire-explosion LOD tiers. Every impact
// emits exactly one bright white sphere that expands and fades. Material death
// debris remains separate in Debris3D.

import * as THREE from 'three';
import type { FireExplosionStyle } from '@/types/graphics';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';

const CORE_COLOR = 0xffffff;
const CORE_LIFETIME_MS = 180;
const DURATION_BASE_RADIUS = 10;
const CORE_EXPAND_START = 0.6;
const CORE_EXPAND_END = 1.6;
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
  private geom: THREE.SphereGeometry;
  private mat: THREE.ShaderMaterial;
  readonly mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private colorArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private scratch = new THREE.Matrix4();

  constructor(parent: THREE.Group, cap: number, renderOrder: number) {
    this.geom = new THREE.SphereGeometry(1, 12, 10);
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
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.addUpdateRange(0, Math.max(1, n));
    this.alphaAttr.needsUpdate = true;
    this.colorAttr.clearUpdateRanges();
    this.colorAttr.addUpdateRange(0, Math.max(1, n) * 3);
    this.colorAttr.needsUpdate = true;
  }

  destroy(): void {
    disposeMesh(this.mesh);
  }
}

export class Explosion3D {
  private root: THREE.Group;
  private puffPool: InstancedSpherePool;
  private puffs: Puff[] = [];
  private puffSpawnsThisFrame = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.puffPool = new InstancedSpherePool(this.root, MAX_PUFFS, 14);
  }

  beginFrame(): void {
    this.puffSpawnsThisFrame = 0;
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
  ): void {
    const r = Math.max(radius, 1.5);
    const durMult = durationMultiplier(r);
    this.addPuff(
      simX,
      simY,
      simZ,
      CORE_LIFETIME_MS * durMult,
      r * CORE_EXPAND_START,
      r * CORE_EXPAND_END,
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

  update(dtMs: number): void {
    if (this.puffs.length === 0) return;

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
      this.puffPool.write(i, p.px, p.py, p.pz, scale, p.r, p.g, p.b, fade);
      i++;
    }
    this.puffPool.setCount(this.puffs.length);
  }

  destroy(): void {
    this.puffs.length = 0;
    this.puffPool.destroy();
    this.root.parent?.remove(this.root);
  }
}
