// ForceFieldImpactRenderer3D - tangent-plane reflector hit flashes.
//
// Force-field projectile impacts are authored by the server at the exact
// sphere intersection point. Continuous beam/laser reflection contacts
// come from live beam polyline vertices. In both cases the supplied
// normal is in sim coordinates; this renderer draws rings in the plane
// perpendicular to that normal, so the pulse lies tangent to the
// force-field shell or mirror panel.

import * as THREE from 'three';
import { FORCE_FIELD_IMPACT_VISUAL } from '../../config';
import { getPlayerPrimaryColor, type Entity, type PlayerId } from '../sim/types';
import { writeHexToRgb01Array } from './colorUtils';
import { disposeMesh } from './threeUtils';

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

function makeImpactMaterial(blending: THREE.Blending = THREE.AdditiveBlending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: IMPACT_VS,
    fragmentShader: IMPACT_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending,
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

  constructor(
    parent: THREE.Group,
    geom: THREE.BufferGeometry,
    readonly capacity: number,
    renderOrder: number,
    blending: THREE.Blending = THREE.AdditiveBlending,
  ) {
    this.geom = geom;
    this.alphaArr = new Float32Array(capacity);
    this.colorArr = new Float32Array(capacity * 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', this.alphaAttr);
    geom.setAttribute('aColor', this.colorAttr);

    this.mat = makeImpactMaterial(blending);
    this.mesh = new THREE.InstancedMesh(geom, this.mat, capacity);
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
    writeHexToRgb01Array(color, this.colorArr, index * 3);
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
    disposeMesh(this.mesh);
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
  private continuousTimeMs = 0;

  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);
  private static readonly CONTINUOUS_BEAM_HIT_CAP = 256;
  private static readonly CONTINUOUS_RING_COUNT = 2;

  constructor(parentWorld: THREE.Group) {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    const ringSegments = Math.max(12, Math.floor(cfg.ringSegments));
    const tubeSegments = Math.max(3, Math.floor(cfg.ringTubeSegments));
    const tubeRadius = Math.min(0.45, Math.max(0.01, cfg.ringTubeRadiusFrac));
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    // TorusGeometry lies in the xy-plane with its axis on z, matching
    // RingGeometry's orientation so the existing normal-aligned quaternion
    // and surface offset still work unchanged. NormalBlending makes the
    // tori read like rings of force-field/mirror material.
    this.ringPool = new ImpactPool(
      this.root,
      new THREE.TorusGeometry(1, tubeRadius, tubeSegments, ringSegments),
      cfg.maxImpacts * Math.max(1, cfg.ringCount)
        + ForceFieldImpactRenderer3D.CONTINUOUS_BEAM_HIT_CAP
          * ForceFieldImpactRenderer3D.CONTINUOUS_RING_COUNT,
      18,
      THREE.NormalBlending,
    );
    this.corePool = new ImpactPool(
      this.root,
      new THREE.CircleGeometry(1, ringSegments),
      cfg.maxImpacts + ForceFieldImpactRenderer3D.CONTINUOUS_BEAM_HIT_CAP,
      17,
    );
  }

  private resolveColor(playerId: PlayerId | undefined): number {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    return cfg.colorMode === 'player' && playerId !== undefined
      ? getPlayerPrimaryColor(playerId)
      : cfg.fallbackColor;
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

    const color = this.resolveColor(playerId);
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

  update(dtMs: number, lineProjectiles: readonly Entity[] = []): void {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    this.continuousTimeMs += dtMs;
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
        // Linear radius grow with a quadratic ease-out alpha fade — the
        // torus stays mostly visible for the first half of its life and
        // tapers away as it reaches end-of-life. Matches the core ring's
        // (1-t)² fade so the two visuals decay in step.
        const fade = (1 - t) * (1 - t);
        const radius = cfg.startRadius + (cfg.endRadius - cfg.startRadius) * t;
        // Uniform scale so the torus tube cross-section grows proportionally.
        this.scratchScale.set(radius, radius, radius);
        this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
        this.ringPool.write(ringCursor++, this.scratchMat, impact.color, cfg.ringOpacity * fade);
      }

      i++;
    }

    const continuousCounts = this.writeContinuousBeamHits(
      lineProjectiles,
      ringCursor,
      coreCursor,
    );
    ringCursor = continuousCounts.ringCursor;
    coreCursor = continuousCounts.coreCursor;

    this.corePool.setCount(coreCursor);
    this.ringPool.setCount(ringCursor);
  }

  private writeContinuousBeamHits(
    lineProjectiles: readonly Entity[],
    ringCursor: number,
    coreCursor: number,
  ): { ringCursor: number; coreCursor: number } {
    const cfg = FORCE_FIELD_IMPACT_VISUAL;
    if (lineProjectiles.length === 0) return { ringCursor, coreCursor };

    let written = 0;
    const time = this.continuousTimeMs;
    for (const entity of lineProjectiles) {
      if (written >= ForceFieldImpactRenderer3D.CONTINUOUS_BEAM_HIT_CAP) break;
      const points = entity.projectile?.points;
      if (!points || points.length < 2) continue;

      for (let i = 1; i < points.length; i++) {
        if (written >= ForceFieldImpactRenderer3D.CONTINUOUS_BEAM_HIT_CAP) break;
        const point = points[i];
        if (point.mirrorEntityId === undefined) continue;
        const nx = point.normalX;
        const ny = point.normalY;
        const nz = point.normalZ;
        if (
          nx === undefined || ny === undefined || nz === undefined ||
          !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)
        ) {
          continue;
        }
        const len = Math.hypot(nx, ny, nz);
        if (len <= 1e-6) continue;

        const invLen = 1 / len;
        const snx = nx * invLen;
        const sny = ny * invLen;
        const snz = nz * invLen;
        this.scratchPos.set(
          point.x + snx * cfg.surfaceOffset,
          point.z + snz * cfg.surfaceOffset,
          point.y + sny * cfg.surfaceOffset,
        );
        this.scratchNormal.set(snx, snz, sny).normalize();
        this.scratchQuat.setFromUnitVectors(ForceFieldImpactRenderer3D.Z_AXIS, this.scratchNormal);

        const color = this.resolveColor(point.reflectorPlayerId);
        const sizeMul = 1;
        const alphaMul = 0.8;
        const phaseSeed = entity.id * 0.173 + i * 0.417;
        const pulse = (time * 0.006 + phaseSeed) % 1;
        const sinPulse = Math.sin((pulse + phaseSeed) * Math.PI * 2) * 0.5 + 0.5;

        if (coreCursor < this.corePool.capacity) {
          const coreRadius = cfg.startRadius * sizeMul * (1.05 + sinPulse * 0.22);
          this.scratchScale.set(coreRadius, coreRadius, 1);
          this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
          this.corePool.write(
            coreCursor++,
            this.scratchMat,
            color,
            cfg.coreOpacity * alphaMul * (0.55 + sinPulse * 0.35),
          );
        }

        for (let ring = 0; ring < ForceFieldImpactRenderer3D.CONTINUOUS_RING_COUNT; ring++) {
          if (ringCursor >= this.ringPool.capacity) break;
          const t = (pulse + ring / ForceFieldImpactRenderer3D.CONTINUOUS_RING_COUNT) % 1;
          const ease = 1 - Math.pow(1 - t, 2);
          const radius = (cfg.startRadius + (cfg.endRadius * 0.72 - cfg.startRadius) * ease) * sizeMul;
          const fade = (1 - t) * (1 - t);
          // Uniform scale for the torus tube to grow proportionally.
          this.scratchScale.set(radius, radius, radius);
          this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
          this.ringPool.write(
            ringCursor++,
            this.scratchMat,
            color,
            cfg.ringOpacity * 0.34 * alphaMul * fade,
          );
        }

        written++;
      }
    }

    return { ringCursor, coreCursor };
  }

  destroy(): void {
    this.impacts.length = 0;
    this.ringPool.destroy();
    this.corePool.destroy();
    this.root.parent?.remove(this.root);
  }
}
