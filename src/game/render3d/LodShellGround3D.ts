import * as THREE from 'three';
import type { RenderObjectLodTier } from './RenderObjectLod';

type LodShell = {
  tier: Exclude<RenderObjectLodTier, 'marker' | 'hero'>;
  distance: number;
};

type GroundPoint = {
  x: number;
  y: number;
  z: number;
};

const STYLE = {
  samplesPerRing: 96,
  worldLift: 8,
  initialLineCap: 512,
  sphereSearchSteps: 24,
  sphereSolveIterations: 10,
  minUpdateIntervalMs: 180,
  cameraQuantize: 12,
};

const SHELL_COLORS: Record<LodShell['tier'], number> = {
  impostor: 0x8a8f98,
  mass: 0xb68cff,
  simple: 0xffd66f,
  rich: 0x6cecff,
};

export class LodShellGround3D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;
  private getGroundHeight: (x: number, z: number) => number;
  private lineCap = STYLE.initialLineCap;
  private linePositions = new Float32Array(this.lineCap * 2 * 3);
  private lineColors = new Float32Array(this.lineCap * 2 * 3);
  private lineGeom = new THREE.BufferGeometry();
  private lineMesh: THREE.LineSegments;
  private hadVisible = false;
  private lastUpdateKey = '';
  private lastUpdateMs = 0;

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    getGroundHeight: (x: number, z: number) => number,
  ) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.getGroundHeight = getGroundHeight;

    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      // Debug shell markings should remain readable even if the camera
      // clips below terrain. Positions still sit on the terrain/sphere
      // intersection; only depth rejection is disabled.
      depthTest: false,
      depthWrite: false,
    });
    this.lineMesh = new THREE.LineSegments(this.lineGeom, lineMat);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 7;
    this.lineMesh.visible = false;
    parent.add(this.lineMesh);
  }

  update(camera: THREE.PerspectiveCamera, shells: readonly LodShell[], visible: boolean): void {
    if (!visible) {
      this.hide();
      return;
    }

    const drawableShells = this.drawableShells(shells);
    if (drawableShells.length === 0) {
      this.hide();
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const updateKey = this.makeUpdateKey(camera, drawableShells);
    if (this.lastUpdateKey !== '') {
      const tooSoon = now - this.lastUpdateMs < STYLE.minUpdateIntervalMs;
      if (updateKey === this.lastUpdateKey || tooSoon) return;
    }
    this.lastUpdateKey = updateKey;
    this.lastUpdateMs = now;

    const state = { lineSeg: 0 };
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;

    for (const shell of drawableShells) {
      this.pushShellRing(state, cx, cy, cz, shell.distance, shell);
    }

    this.lineGeom.setDrawRange(0, state.lineSeg * 2);
    const position = this.lineGeom.getAttribute('position') as THREE.BufferAttribute;
    const color = this.lineGeom.getAttribute('color') as THREE.BufferAttribute;
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.lineMesh.visible = state.lineSeg > 0;
    this.hadVisible = this.lineMesh.visible;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.lineGeom.dispose();
    const material = this.lineMesh.material;
    if (Array.isArray(material)) {
      for (const mat of material) mat.dispose();
    } else {
      material.dispose();
    }
  }

  private hide(): void {
    if (!this.hadVisible) {
      this.lastUpdateKey = '';
      this.lastUpdateMs = 0;
      return;
    }
    this.lineGeom.setDrawRange(0, 0);
    this.lineMesh.visible = false;
    this.hadVisible = false;
    this.lastUpdateKey = '';
    this.lastUpdateMs = 0;
  }

  private drawableShells(shells: readonly LodShell[]): LodShell[] {
    const out: LodShell[] = [];
    for (const shell of shells) {
      if (shell.distance <= 0 || !Number.isFinite(shell.distance)) continue;
      out.push(shell);
    }
    return out;
  }

  private makeUpdateKey(camera: THREE.PerspectiveCamera, shells: readonly LodShell[]): string {
    const q = STYLE.cameraQuantize;
    const qx = Math.round(camera.position.x / q);
    const qy = Math.round(camera.position.y / q);
    const qz = Math.round(camera.position.z / q);
    let key = `${qx},${qy},${qz}`;
    for (const shell of shells) {
      key += `|${shell.tier}:${Math.round(shell.distance)}`;
    }
    return key;
  }

  private growLineCap(needed: number): void {
    let cap = this.lineCap;
    while (cap < needed) cap *= 2;
    if (cap === this.lineCap) return;
    this.lineCap = cap;
    this.linePositions = new Float32Array(cap * 2 * 3);
    this.lineColors = new Float32Array(cap * 2 * 3);
    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
  }

  private pushShellRing(
    state: { lineSeg: number },
    cx: number,
    cy: number,
    cz: number,
    sphereRadius: number,
    shell: LodShell,
  ): void {
    const color = SHELL_COLORS[shell.tier];
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    let first: GroundPoint | null = null;
    let prev: GroundPoint | null = null;
    let hadGap = false;

    for (let i = 0; i < STYLE.samplesPerRing; i++) {
      const angle = (i / STYLE.samplesPerRing) * Math.PI * 2;
      const point = this.findGroundPoint(cx, cy, cz, Math.cos(angle), Math.sin(angle), sphereRadius);
      if (!point) {
        hadGap = true;
        prev = null;
        continue;
      }
      if (!first) first = point;
      if (prev) this.pushSegment(state, prev, point, r, g, b);
      prev = point;
    }

    if (!hadGap && first && prev && first !== prev) this.pushSegment(state, prev, first, r, g, b);
  }

  private findGroundPoint(
    cx: number,
    cy: number,
    cz: number,
    dirX: number,
    dirZ: number,
    sphereRadius: number,
  ): GroundPoint | null {
    const mapInterval = this.rayMapInterval(cx, cz, dirX, dirZ);
    if (!mapInterval) return null;
    const startR = Math.max(0, mapInterval.enter);
    const endR = Math.min(sphereRadius, mapInterval.exit);
    if (endR <= startR || !Number.isFinite(endR)) return null;

    const shellSq = sphereRadius * sphereRadius;
    const evalAt = (r: number): number | null => {
      const x = cx + dirX * r;
      const z = cz + dirZ * r;
      if (x < 0 || x > this.mapWidth || z < 0 || z > this.mapHeight) return null;
      const groundY = this.getGroundHeight(x, z);
      const dy = groundY - cy;
      return r * r + dy * dy - shellSq;
    };

    let prevR = startR;
    let prev = evalAt(prevR);
    if (prev === null) return null;

    const tolerance = Math.max(1, shellSq * 1e-5);
    if (Math.abs(prev) <= tolerance) return this.groundPointAt(cx, cz, dirX, dirZ, prevR);

    let bestR = prevR;
    let bestAbs = Math.abs(prev);
    const span = endR - startR;
    for (let step = 1; step <= STYLE.sphereSearchSteps; step++) {
      const r = startR + (span * step) / STYLE.sphereSearchSteps;
      const v = evalAt(r);
      if (v === null) continue;
      const abs = Math.abs(v);
      if (abs < bestAbs) {
        bestAbs = abs;
        bestR = r;
      }
      if (Math.abs(v) <= tolerance) return this.groundPointAt(cx, cz, dirX, dirZ, r);
      if ((prev <= 0 && v >= 0) || (prev >= 0 && v <= 0)) {
        const root = this.solveRootBetween(evalAt, prevR, r, prev);
        return this.groundPointAt(cx, cz, dirX, dirZ, root);
      }
      prev = v;
      prevR = r;
    }

    return bestAbs <= tolerance
      ? this.groundPointAt(cx, cz, dirX, dirZ, bestR)
      : null;
  }

  private solveRootBetween(
    evalAt: (r: number) => number | null,
    loStart: number,
    hiStart: number,
    loValue: number,
  ): number {
    let lo = loStart;
    let hi = hiStart;
    const loInside = loValue <= 0;
    for (let i = 0; i < STYLE.sphereSolveIterations; i++) {
      const mid = (lo + hi) * 0.5;
      const v = evalAt(mid);
      if (v === null) {
        hi = mid;
      } else if ((v <= 0) === loInside) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) * 0.5;
  }

  private groundPointAt(
    cx: number,
    cz: number,
    dirX: number,
    dirZ: number,
    r: number,
  ): GroundPoint | null {
    const x = cx + dirX * r;
    const z = cz + dirZ * r;
    if (x < 0 || x > this.mapWidth || z < 0 || z > this.mapHeight) return null;
    return {
      x,
      y: this.getGroundHeight(x, z) + STYLE.worldLift,
      z,
    };
  }

  private rayMapInterval(
    cx: number,
    cz: number,
    dirX: number,
    dirZ: number,
  ): { enter: number; exit: number } | null {
    let enter = -Infinity;
    let exit = Infinity;
    const applySlab = (origin: number, dir: number, min: number, max: number): boolean => {
      if (Math.abs(dir) < 1e-6) return origin >= min && origin <= max;
      let a = (min - origin) / dir;
      let b = (max - origin) / dir;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      enter = Math.max(enter, a);
      exit = Math.min(exit, b);
      return enter <= exit;
    };
    if (!applySlab(cx, dirX, 0, this.mapWidth)) return null;
    if (!applySlab(cz, dirZ, 0, this.mapHeight)) return null;
    if (exit < 0) return null;
    return { enter, exit };
  }

  private pushSegment(
    state: { lineSeg: number },
    a: GroundPoint,
    b: GroundPoint,
    r: number,
    g: number,
    colorB: number,
  ): void {
    if (state.lineSeg + 1 > this.lineCap) {
      this.growLineCap(state.lineSeg + 1);
    }
    const o = state.lineSeg * 6;
    this.linePositions[o + 0] = a.x;
    this.linePositions[o + 1] = a.y;
    this.linePositions[o + 2] = a.z;
    this.linePositions[o + 3] = b.x;
    this.linePositions[o + 4] = b.y;
    this.linePositions[o + 5] = b.z;
    this.lineColors[o + 0] = r;
    this.lineColors[o + 1] = g;
    this.lineColors[o + 2] = colorB;
    this.lineColors[o + 3] = r;
    this.lineColors[o + 4] = g;
    this.lineColors[o + 5] = colorB;
    state.lineSeg++;
  }
}
