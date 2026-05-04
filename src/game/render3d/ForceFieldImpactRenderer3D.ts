// ForceFieldImpactRenderer3D - tangent-plane shield hit flashes.
//
// A force-field impact is authored by the server at the exact sphere
// intersection point. The supplied normal is the shield surface normal
// in sim coordinates; this renderer draws expanding rings in the plane
// perpendicular to that normal, so the pulse lies tangent to the field.

import * as THREE from 'three';
import { FORCE_FIELD_IMPACT_VISUAL } from '../../config';
import { getPlayerPrimaryColor, type PlayerId } from '../sim/types';

type Impact = {
  ageMs: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  color: number;
};

const IMPACT_VS = `
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

const IMPACT_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

function makeImpactMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: IMPACT_VS,
    fragmentShader: IMPACT_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

class ImpactPool {
  readonly geom: THREE.BufferGeometry;
  readonly mat: THREE.ShaderMaterial;
  readonly mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private colorArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;

  constructor(parent: THREE.Group, geom: THREE.BufferGeometry, cap: number, renderOrder: number) {
    this.geom = geom;
    this.alphaArr = new Float32Array(cap);
    this.colorArr = new Float32Array(cap * 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', this.alphaAttr);
    geom.setAttribute('aColor', this.colorAttr);

    this.mat = makeImpactMaterial();
    this.mesh = new THREE.InstancedMesh(geom, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    parent.add(this.mesh);
  }

  write(
    index: number,
    matrix: THREE.Matrix4,
    color: number,
    alpha: number,
  ): void {
    this.mesh.setMatrixAt(index, matrix);
    this.alphaArr[index] = alpha;
    this.colorArr[index * 3] = ((color >> 16) & 0xff) / 255;
    this.colorArr[index * 3 + 1] = ((color >> 8) & 0xff) / 255;
    this.colorArr[index * 3 + 2] = (color & 0xff) / 255;
  }

  setCount(count: number): void {
    this.mesh.count = count;
    const n = Math.max(1, count);
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

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
    this.geom.dispose();
  }
}

export class ForceFieldImpactRenderer3D {
  private root: THREE.Group;
  private ringPool: ImpactPool;
  private corePool: ImpactPool;
  private impacts: Impact[] = [];
  private scratchMat = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchScale = new THREE.Vector3();
  private scratchQuat = new THREE.Quaternion();
  private scratchNormal = new THREE.Vector3();

  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor(parentWorld: THREE.Group) {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    const ringSegments = Math.max(12, Math.floor(cfg.ringSegments));
    const inner = Math.min(0.98, Math.max(0.05, cfg.ringInnerRadiusFrac));
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    this.ringPool = new ImpactPool(
      this.root,
      new THREE.RingGeometry(inner, 1, ringSegments),
      cfg.maxImpacts * Math.max(1, cfg.ringCount),
      18,
    );
    this.corePool = new ImpactPool(
      this.root,
      new THREE.CircleGeometry(1, ringSegments),
      cfg.maxImpacts,
      17,
    );
  }

  spawn(
    simX: number,
    simY: number,
    simZ: number,
    normal: { x: number; y: number; z: number },
    playerId: PlayerId | undefined,
  ): void {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    if (this.impacts.length >= cfg.maxImpacts) {
      this.impacts[0] = this.impacts[this.impacts.length - 1];
      this.impacts.pop();
    }

    const color = cfg.colorMode === 'player' && playerId !== undefined
      ? getPlayerPrimaryColor(playerId)
      : cfg.fallbackColor;
    const nx = Number.isFinite(normal.x) ? normal.x : 0;
    const ny = Number.isFinite(normal.y) ? normal.y : 0;
    const nz = Number.isFinite(normal.z) ? normal.z : 1;
    const len = Math.hypot(nx, ny, nz) || 1;

    // Convert sim (x, y, z-up) into Three (x, y-up, z).
    const wx = simX + (nx / len) * cfg.surfaceOffset;
    const wy = simZ + (nz / len) * cfg.surfaceOffset;
    const wz = simY + (ny / len) * cfg.surfaceOffset;
    this.impacts.push({
      ageMs: 0,
      x: wx,
      y: wy,
      z: wz,
      nx: nx / len,
      ny: nz / len,
      nz: ny / len,
      color,
    });
  }

  update(dtMs: number): void {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    let ringCursor = 0;
    let coreCursor = 0;

    let i = 0;
    while (i < this.impacts.length) {
      const impact = this.impacts[i];
      impact.ageMs += dtMs;
      if (impact.ageMs >= cfg.durationMs) {
        const last = this.impacts.length - 1;
        if (i !== last) this.impacts[i] = this.impacts[last];
        this.impacts.pop();
        continue;
      }

      this.scratchNormal.set(impact.nx, impact.ny, impact.nz).normalize();
      this.scratchQuat.setFromUnitVectors(ForceFieldImpactRenderer3D.Z_AXIS, this.scratchNormal);
      this.scratchPos.set(impact.x, impact.y, impact.z);

      const coreDuration = Math.max(1, cfg.durationMs * cfg.coreDurationFrac);
      if (impact.ageMs < coreDuration) {
        const t = impact.ageMs / coreDuration;
        const fade = (1 - t) * (1 - t);
        const radius = cfg.startRadius + (cfg.endRadius * cfg.coreRadiusFrac - cfg.startRadius) * t;
        this.scratchScale.set(radius, radius, 1);
        this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
        this.corePool.write(coreCursor++, this.scratchMat, impact.color, cfg.coreOpacity * fade);
      }

      for (let ring = 0; ring < cfg.ringCount; ring++) {
        const ringAge = impact.ageMs - ring * cfg.ringDelayMs;
        if (ringAge < 0 || ringAge >= cfg.durationMs) continue;
        const t = ringAge / cfg.durationMs;
        const ease = 1 - Math.pow(1 - t, 3);
        const radius = cfg.startRadius + (cfg.endRadius - cfg.startRadius) * ease;
        const fade = (1 - t) * (1 - t);
        this.scratchScale.set(radius, radius, 1);
        this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
        this.ringPool.write(ringCursor++, this.scratchMat, impact.color, cfg.ringOpacity * fade);
      }

      i++;
    }

    this.corePool.setCount(coreCursor);
    this.ringPool.setCount(ringCursor);
  }

  destroy(): void {
    this.impacts.length = 0;
    this.ringPool.destroy();
    this.corePool.destroy();
    this.root.parent?.remove(this.root);
  }
}
