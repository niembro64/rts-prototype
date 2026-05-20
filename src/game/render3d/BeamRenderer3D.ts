// BeamRenderer3D — renders beam and laser projectiles as thin 3D cylinders.
//
// ClientViewState receives authoritative start/end/reflections (including z)
// from the host snapshots. This renderer reads those fields and draws one
// cylinder per path segment using each segment's real altitude, so reflected
// beam visuals match the server collision path without client-side tracing.
//
// Beam cylinders are drawn through two visual InstancedMesh layers. Each live
// path segment writes one outer matrix and one smaller inner matrix, so a
// beam-heavy fight stays two segment draw calls instead of one mesh/material
// draw per segment.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { isLineShotType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import { getBeamSnapToTurret } from '@/clientBarConfig';
import { detachObject, disposeMesh } from './threeUtils';
import beamConfig from './beamConfig.json';

// Visual tuning (color, wave alpha range, wave spacing/speed) lives in
// beamConfig.json — edit that file to retune how beams look. The remaining
// constants below shape buffer sizes and cylinder geometry, not look.
const BEAM_SEGMENT_CAP = 8192;
const BEAM_ENDPOINT_CAP = 4096;
const BEAM_MIN_RADIUS = 0.35;
const BEAM_RADIUS_SCALE = 0.55;
const ENDPOINT_MIN_RADIUS = 2.5;
const OPEN_ENDED_LINE_VISUAL_LENGTH = 12000;

export type TurretMountResolver = {
  getTurretMountWorldState(
    entityId: number,
    turretIdx: number,
  ): { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number } | null;
};

// GLSL needs decimal-pointed float literals (`1.0`, not `1`); JSON values
// might be `1` or `0.5`, so format them with a decimal so shader parses.
const glsl = (n: number): string => {
  const s = n.toString();
  return s.includes('.') ? s : `${s}.0`;
};
const glslVec3 = (rgb: readonly number[]): string =>
  `vec3(${glsl(rgb[0])}, ${glsl(rgb[1])}, ${glsl(rgb[2])})`;

type BeamVisualConfig = {
  color: readonly number[];
  waveLowAlpha: number;
  waveHighAlpha: number;
  /** Length ratio of high-alpha run to low-alpha run within one repeat.
   *  1 means equal lengths; 0.25 means high alpha is one quarter as long
   *  as the low-alpha region. */
  waveHighToLowAlphaLengthRatio?: number;
  waveSpacing: number;
  waveSpeed: number;
};

type BeamConfigFile = Partial<BeamVisualConfig> & {
  outer?: BeamVisualConfig;
  inner?: BeamVisualConfig;
};

const rawBeamConfig = beamConfig as BeamConfigFile;
const OUTER_VISUAL_CONFIG = rawBeamConfig.outer ?? (rawBeamConfig as BeamVisualConfig);
const INNER_VISUAL_CONFIG = rawBeamConfig.inner ?? {
  ...OUTER_VISUAL_CONFIG,
  waveSpeed: OUTER_VISUAL_CONFIG.waveSpeed * 1.8,
};

function highAlphaStart(config: BeamVisualConfig): number {
  const ratio = config.waveHighToLowAlphaLengthRatio ?? 1;
  const safeRatio = Number.isFinite(ratio) ? Math.max(0.001, ratio) : 1;
  const highFrac = safeRatio / (1 + safeRatio);
  return 1 - highFrac;
}

const BEAM_VISUAL_LAYERS: readonly {
  config: BeamVisualConfig;
  radiusMultiplier: number;
}[] = [
  { config: OUTER_VISUAL_CONFIG, radiusMultiplier: 1.0 },
  { config: INNER_VISUAL_CONFIG, radiusMultiplier: 0.45 },
];

const BEAM_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec4 aFlow;
varying float vAlpha;
varying float vAlong;
varying vec4 vFlow;
void main() {
  vAlpha = aAlpha;
  vAlong = position.y + 0.5;
  vFlow = aFlow;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const createBeamFragmentShader = (config: BeamVisualConfig): string => `
uniform float uTime;
varying float vAlpha;
varying float vAlong;
varying vec4 vFlow;
void main() {
  // vFlow = (unused, repeats, phase, speed). Beam alternates between
  // LOW_ALPHA and HIGH_ALPHA sections as the pattern travels along the
  // cylinder. waveHighToLowAlphaLengthRatio controls the high-vs-low
  // run length inside each waveSpacing slice.
  float repeats = max(0.001, vFlow.y);
  float p = fract(vAlong * repeats - uTime * vFlow.w + vFlow.z);
  float pulse = step(${glsl(highAlphaStart(config))}, p);
  float alpha = mix(${glsl(config.waveLowAlpha)}, ${glsl(config.waveHighAlpha)}, pulse) * vAlpha;
  gl_FragColor = vec4(${glslVec3(config.color)}, alpha);
}
`;

const ENDPOINT_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const createEndpointFragmentShader = (config: BeamVisualConfig): string => `
varying float vAlpha;
void main() {
  gl_FragColor = vec4(${glslVec3(config.color)}, ${glsl(config.waveHighAlpha)} * vAlpha);
}
`;

type BeamVisualLayer = {
  readonly config: BeamVisualConfig;
  readonly radiusMultiplier: number;
  readonly segmentMesh: THREE.InstancedMesh;
  readonly segmentAlpha: Float32Array;
  readonly segmentAlphaAttr: THREE.InstancedBufferAttribute;
  readonly segmentFlow: Float32Array;
  readonly segmentFlowAttr: THREE.InstancedBufferAttribute;
  readonly flowTimeUniform: { value: number };
  activeSegmentCount: number;
  readonly endpointMesh: THREE.InstancedMesh;
  readonly endpointAlpha: Float32Array;
  readonly endpointAlphaAttr: THREE.InstancedBufferAttribute;
  activeEndpointCount: number;
};

function createBeamVisualLayer(
  root: THREE.Group,
  config: BeamVisualConfig,
  radiusMultiplier: number,
  renderOrder: number,
): BeamVisualLayer {
  const segmentGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  const segmentAlpha = new Float32Array(BEAM_SEGMENT_CAP);
  const segmentAlphaAttr = new THREE.InstancedBufferAttribute(segmentAlpha, 1);
  segmentAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  segmentGeom.setAttribute('aAlpha', segmentAlphaAttr);
  const segmentFlow = new Float32Array(BEAM_SEGMENT_CAP * 4);
  const segmentFlowAttr = new THREE.InstancedBufferAttribute(segmentFlow, 4);
  segmentFlowAttr.setUsage(THREE.DynamicDrawUsage);
  segmentGeom.setAttribute('aFlow', segmentFlowAttr);
  const flowTimeUniform = { value: 0 };
  const segmentMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERTEX_SHADER,
    fragmentShader: createBeamFragmentShader(config),
    uniforms: {
      uTime: flowTimeUniform,
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const segmentMesh = new THREE.InstancedMesh(
    segmentGeom,
    segmentMat,
    BEAM_SEGMENT_CAP,
  );
  segmentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  segmentMesh.frustumCulled = false;
  segmentMesh.renderOrder = renderOrder;
  segmentMesh.count = 0;
  root.add(segmentMesh);

  const endpointGeom = new THREE.SphereGeometry(1, 12, 10);
  const endpointAlpha = new Float32Array(BEAM_ENDPOINT_CAP);
  const endpointAlphaAttr = new THREE.InstancedBufferAttribute(endpointAlpha, 1);
  endpointAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  endpointGeom.setAttribute('aAlpha', endpointAlphaAttr);
  const endpointMat = new THREE.ShaderMaterial({
    vertexShader: ENDPOINT_VERTEX_SHADER,
    fragmentShader: createEndpointFragmentShader(config),
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const endpointMesh = new THREE.InstancedMesh(
    endpointGeom,
    endpointMat,
    BEAM_ENDPOINT_CAP,
  );
  endpointMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  endpointMesh.frustumCulled = false;
  endpointMesh.renderOrder = renderOrder + 2;
  endpointMesh.count = 0;
  root.add(endpointMesh);

  return {
    config,
    radiusMultiplier,
    segmentMesh,
    segmentAlpha,
    segmentAlphaAttr,
    segmentFlow,
    segmentFlowAttr,
    flowTimeUniform,
    activeSegmentCount: 0,
    endpointMesh,
    endpointAlpha,
    endpointAlphaAttr,
    activeEndpointCount: 0,
  };
}

export class BeamRenderer3D {
  private root: THREE.Group;
  private readonly layers: BeamVisualLayer[];

  // RENDER: WIN/PAD/ALL visibility scope — beams with BOTH endpoints
  // outside the scope rect skip segment placement entirely.
  private scope: ViewportFootprint;
  private lastContentVersion = -1;
  private lastScopeVersion = -1;

  // Scratch vectors reused per frame (no per-segment allocations).
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _mid = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _quat = new THREE.Quaternion();
  private _scale = new THREE.Vector3();
  private _matrix = new THREE.Matrix4();

  constructor(parentWorld: THREE.Group, scope: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
    this.layers = BEAM_VISUAL_LAYERS.map((layer, i) =>
      createBeamVisualLayer(this.root, layer.config, layer.radiusMultiplier, 12 + i),
    );
  }

  private placeSegment(
    mesh: THREE.InstancedMesh,
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    length: number,
  ): void {
    // sim-(x, y, z) maps to three-(x, z, y) — height is sim.z, which
    // the beam tracer now reports per segment (mount-center start,
    // reflection points, and final end all carry their real altitude).
    this._a.set(ax, az, ay);
    this._b.set(bx, bz, by);
    this._mid.copy(this._a).lerp(this._b, 0.5);
    this._dir.copy(this._b).sub(this._a);
    if (length > 1e-5) this._dir.multiplyScalar(1 / length);
    else this._dir.set(1, 0, 0); // avoid NaN on degenerate segments
    // Rotate cylinder's default +Y axis to align with the segment direction.
    this._quat.setFromUnitVectors(this._up, this._dir);
    // CylinderGeometry has radius 1; scale.x/.z become this visual layer's
    // actual beam radius. The outer layer keeps the shot-width footprint;
    // the inner layer intentionally passes a smaller radius.
    this._scale.set(cylRadius, Math.max(length, 1e-3), cylRadius);
    this._matrix.compose(this._mid, this._quat, this._scale);
    mesh.setMatrixAt(slot, this._matrix);
  }

  private writeSegment(
    layer: BeamVisualLayer,
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    alpha: number,
    length: number,
    flowPhase: number,
  ): void {
    if (slot >= BEAM_SEGMENT_CAP || alpha <= 0.001) return;
    layer.segmentAlpha[slot] = alpha;
    const flowBase = slot * 4;
    layer.segmentFlow[flowBase] = 1.0;
    layer.segmentFlow[flowBase + 1] = this.flowRepeats(length, layer.config.waveSpacing);
    layer.segmentFlow[flowBase + 2] = flowPhase;
    layer.segmentFlow[flowBase + 3] = layer.config.waveSpeed;
    this.placeSegment(layer.segmentMesh, slot, ax, ay, az, bx, by, bz, cylRadius, length);
  }

  private writeEndpoint(
    layer: BeamVisualLayer,
    slot: number,
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    alpha: number,
  ): boolean {
    if (slot >= BEAM_ENDPOINT_CAP || alpha <= 0.001 || radius <= 0.001) return false;
    this._matrix.makeScale(radius, radius, radius);
    this._matrix.setPosition(simX, simZ, simY);
    layer.endpointMesh.setMatrixAt(slot, this._matrix);
    layer.endpointAlpha[slot] = alpha;
    return true;
  }

  private flowPhase(entityId: number, segmentIndex: number): number {
    const v = Math.sin(entityId * 12.9898 + segmentIndex * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  private flowRepeats(length: number, spacing: number): number {
    // Period must stay = spacing world units regardless of beam length —
    // no clamping. Short beams just show a slice of the pattern; long
    // beams pack more cycles in. Both keep the same world-space period.
    if (spacing <= 0 || length <= 1e-3) return 1;
    return length / spacing;
  }

  private isOpenEndedLinePath(proj: NonNullable<Entity['projectile']>): boolean {
    if (proj.endpointDamageable !== false) return false;
    const points = proj.points;
    if (!points || points.length < 2) return false;
    const endPoint = points[points.length - 1];
    return (
      endPoint.mirrorEntityId === undefined &&
      endPoint.reflectorKind === undefined
    );
  }

  private hasActiveVisuals(): boolean {
    return this.layers.some(
      (layer) => layer.activeSegmentCount > 0 || layer.activeEndpointCount > 0,
    );
  }

  private updateFlowTime(): void {
    const now = performance.now() * 0.001;
    for (const layer of this.layers) {
      layer.flowTimeUniform.value = now;
    }
  }

  update(
    projectiles: readonly Entity[],
    _graphicsConfig?: GraphicsConfig,
    contentVersion?: number,
    turretMountResolver?: TurretMountResolver,
  ): void {
    if (projectiles.length === 0 && !this.hasActiveVisuals()) return;
    this.updateFlowTime();
    const snapToTurret = getBeamSnapToTurret() && !!turretMountResolver;
    const scopeVersion = this.scope.getVersion();
    if (
      !snapToTurret &&
      contentVersion !== undefined &&
      contentVersion === this.lastContentVersion &&
      scopeVersion === this.lastScopeVersion
    ) {
      return;
    }
    if (contentVersion !== undefined) this.lastContentVersion = contentVersion;
    this.lastScopeVersion = scopeVersion;

    let segIdx = 0;
    let endpointIdx = 0;

    for (const e of projectiles) {
      const pt = e.projectile?.projectileType;
      if (!pt || !isLineShotType(pt)) continue;

      const proj = e.projectile!;
      const points = proj.points;
      if (!points || points.length < 2) continue;
      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      // Scope gate before segment placement. Off-screen beam segments
      // can be numerous in large fights.
      const startIn = this.scope.inScope(startPoint.x, startPoint.y, 200);
      const endIn = this.scope.inScope(endPoint.x, endPoint.y, 200);
      if (!startIn && !endIn) continue;

      const drawReflections = true;

      const profile = proj.config.shotProfile.visual;
      // lineRadius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      const cylRadius = Math.max(
        BEAM_MIN_RADIUS,
        profile.lineRadius * BEAM_RADIUS_SCALE,
      );
      const damageSphereRadius = Math.max(
        ENDPOINT_MIN_RADIUS,
        profile.lineDamageSphereRadius,
      );

      // Walk the polyline pairwise and draw one cylinder per segment.
      // Each reflection vertex carries its own (x, y, z), so pitched
      // beams bouncing off vertical mirrors trace the correct 3D path.
      // Per-segment alpha is held at 1.0 — the wave shader handles all
      // brightness modulation via mix(LOW_ALPHA, HIGH_ALPHA, pulse).
      const lastIdx = points.length - 1;
      const stride = drawReflections ? 1 : lastIdx;
      const openEndedLine = this.isOpenEndedLinePath(proj);

      let snapStartX = 0, snapStartY = 0, snapStartZ = 0;
      let hasSnapStart = false;
      if (snapToTurret) {
        const turretIdx = proj.config.turretIndex ?? 0;
        const mount = turretMountResolver!.getTurretMountWorldState(
          proj.sourceEntityId, turretIdx,
        );
        if (mount) {
          snapStartX = mount.x;
          snapStartY = mount.y;
          snapStartZ = mount.z;
          hasSnapStart = true;
        }
      }

      for (let i = 0; i < lastIdx; i += stride) {
        const a = points[i];
        const b = points[Math.min(i + stride, lastIdx)];
        const useSnap = hasSnapStart && i === 0;
        const ax = useSnap ? snapStartX : a.x;
        const ay = useSnap ? snapStartY : a.y;
        const az = useSnap ? snapStartZ : a.z;
        let bx = b.x;
        let by = b.y;
        let bz = b.z;
        if (openEndedLine && Math.min(i + stride, lastIdx) === lastIdx) {
          const prev = points[Math.max(0, lastIdx - 1)];
          let tailDx = endPoint.x - prev.x;
          let tailDy = endPoint.y - prev.y;
          let tailDz = endPoint.z - prev.z;
          let tailLen = Math.sqrt(tailDx * tailDx + tailDy * tailDy + tailDz * tailDz);
          if (tailLen <= 1e-6) {
            tailDx = endPoint.x - ax;
            tailDy = endPoint.y - ay;
            tailDz = endPoint.z - az;
            tailLen = Math.sqrt(tailDx * tailDx + tailDy * tailDy + tailDz * tailDz);
          }
          if (tailLen > 1e-6) {
            const tailScale = OPEN_ENDED_LINE_VISUAL_LENGTH / tailLen;
            bx = endPoint.x + tailDx * tailScale;
            by = endPoint.y + tailDy * tailScale;
            bz = endPoint.z + tailDz * tailScale;
          }
        }
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (segIdx < BEAM_SEGMENT_CAP) {
          const phase = this.flowPhase(e.id, segIdx);
          for (const layer of this.layers) {
            this.writeSegment(
              layer,
              segIdx,
              ax, ay, az,
              bx, by, bz,
              cylRadius * layer.radiusMultiplier,
              1.0,
              segLen,
              phase,
            );
          }
          segIdx++;
        }
      }

      if (proj.endpointDamageable !== false) {
        if (endpointIdx < BEAM_ENDPOINT_CAP) {
          for (const layer of this.layers) {
            this.writeEndpoint(
              layer,
              endpointIdx,
              endPoint.x,
              endPoint.y,
              endPoint.z,
              damageSphereRadius * layer.radiusMultiplier,
              1.0,
            );
          }
          endpointIdx++;
        }
      }
    }

    for (const layer of this.layers) {
      layer.segmentMesh.count = segIdx;
      if (segIdx > 0) {
        layer.segmentMesh.instanceMatrix.clearUpdateRanges();
        layer.segmentMesh.instanceMatrix.addUpdateRange(0, segIdx * 16);
        layer.segmentMesh.instanceMatrix.needsUpdate = true;
        layer.segmentAlphaAttr.clearUpdateRanges();
        layer.segmentAlphaAttr.addUpdateRange(0, segIdx);
        layer.segmentAlphaAttr.needsUpdate = true;
        layer.segmentFlowAttr.clearUpdateRanges();
        layer.segmentFlowAttr.addUpdateRange(0, segIdx * 4);
        layer.segmentFlowAttr.needsUpdate = true;
      }
      layer.activeSegmentCount = segIdx;

      layer.endpointMesh.count = endpointIdx;
      if (endpointIdx > 0) {
        layer.endpointMesh.instanceMatrix.clearUpdateRanges();
        layer.endpointMesh.instanceMatrix.addUpdateRange(0, endpointIdx * 16);
        layer.endpointMesh.instanceMatrix.needsUpdate = true;
        layer.endpointAlphaAttr.clearUpdateRanges();
        layer.endpointAlphaAttr.addUpdateRange(0, endpointIdx);
        layer.endpointAlphaAttr.needsUpdate = true;
      }
      layer.activeEndpointCount = endpointIdx;
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      disposeMesh(layer.segmentMesh);
      disposeMesh(layer.endpointMesh);
    }
    detachObject(this.root);
  }
}
