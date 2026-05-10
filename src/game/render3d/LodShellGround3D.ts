import * as THREE from 'three';
import type { RenderObjectLodTier } from './RenderObjectLod';
import { hexToRgb01 } from './colorUtils';
import { DynamicLineBuffer3D } from './DynamicLineBuffer3D';

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
  private lineBuffer = new DynamicLineBuffer3D(STYLE.initialLineCap);
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
    this.lineMesh = new THREE.LineSegments(this.lineBuffer.geometry, lineMat);
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

    this.lineBuffer.resetDrawRange();
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;

    for (const shell of drawableShells) {
      this.pushShellRing(cx, cy, cz, shell.distance, shell);
    }

    const lineSeg = this.lineBuffer.finishFrame();
    this.lineMesh.visible = lineSeg > 0;
    this.hadVisible = this.lineMesh.visible;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.lineBuffer.dispose();
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
    this.lineBuffer.resetDrawRange();
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

  private pushShellRing(
    cx: number,
    cy: number,
    cz: number,
    sphereRadius: number,
    shell: LodShell,
  ): void {
    const color = SHELL_COLORS[shell.tier];
    const { r, g, b } = hexToRgb01(color);
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
      if (prev) this.lineBuffer.pushPointSegment(prev, point, r, g, b);
      prev = point;
    }

    if (!hadGap && first && prev && first !== prev) {
      this.lineBuffer.pushPointSegment(prev, first, r, g, b);
    }
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
}
