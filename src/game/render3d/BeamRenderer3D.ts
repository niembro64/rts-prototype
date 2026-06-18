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
import { isRayType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import { getBeamSnapToTurret } from '@/clientBarConfig';
import { detachObject, disposeMesh } from './threeUtils';
import beamConfig from '@/beamConfig.json';
import {
  BEAM_ENDPOINT_VERTEX_SHADER,
  BEAM_INNER_VISUAL_CONFIG,
  BEAM_LAYER_INNER_SCALE,
  BEAM_OUTER_VISUAL_CONFIG,
  BEAM_SEGMENT_VERTEX_SHADER,
  BEAM_WAVE_TIME,
  beamWaveFlowPhase,
  beamWaveFlowRepeats,
  createBeamEndpointFragmentShader,
  createBeamSegmentFragmentShader,
  tickBeamWaveTime,
  type BeamVisualConfig,
} from './BeamWaveVisual3D';

// Visual tuning (color, wave alpha range, wave spacing/speed) lives in
// beamConfig.json + colorsConfig.json and is resolved by BeamWaveVisual3D —
// edit those files to retune how beams look. Beam cylinders originate at
// the turret mount center, matching the authoritative sim path.
const BEAM_SEGMENT_CAP = 8192;
const BEAM_ENDPOINT_CAP = 4096;
const BEAM_IMPOSTER_SEGMENT_CAP = BEAM_SEGMENT_CAP;
const BEAM_MIN_RADIUS = 0.35;
const BEAM_RADIUS_SCALE = 0.55;
const ENDPOINT_MIN_RADIUS = 2.5;
const DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH = 12000;
const DEFAULT_IMPOSTER_SEGMENT_COLOR = 0xffffff;
const DEFAULT_IMPOSTER_SEGMENT_LINE_WIDTH = 1;

export type TurretMountResolver = {
  getTurretMountWorldState(
    entityId: number,
    turretIdx: number,
  ): { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number } | null;
};

type OpenEndedLineConfig = {
  extendToInfinity: boolean;
  infinityVisualLength: number;
};

type BeamImposterSegmentConfig = {
  enabled: boolean;
  color: number;
  lineWidth: number;
};

type BeamConfigFile = {
  openEndedLine?: Partial<OpenEndedLineConfig>;
  imposterSegment?: Partial<BeamImposterSegmentConfig>;
};

const rawBeamConfig = beamConfig as unknown as BeamConfigFile;

const configuredInfinityVisualLength =
  rawBeamConfig.openEndedLine?.infinityVisualLength ?? DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH;

const OPEN_ENDED_LINE_CONFIG: OpenEndedLineConfig = {
  extendToInfinity: rawBeamConfig.openEndedLine?.extendToInfinity ?? true,
  infinityVisualLength:
    Number.isFinite(configuredInfinityVisualLength) && configuredInfinityVisualLength > 0
      ? configuredInfinityVisualLength
      : DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH,
};

const configuredImposterLineWidth =
  rawBeamConfig.imposterSegment?.lineWidth ?? DEFAULT_IMPOSTER_SEGMENT_LINE_WIDTH;

const BEAM_IMPOSTER_SEGMENT_CONFIG: BeamImposterSegmentConfig = {
  enabled: rawBeamConfig.imposterSegment?.enabled ?? true,
  color: rawBeamConfig.imposterSegment?.color ?? DEFAULT_IMPOSTER_SEGMENT_COLOR,
  lineWidth:
    Number.isFinite(configuredImposterLineWidth) && configuredImposterLineWidth > 0
      ? configuredImposterLineWidth
      : DEFAULT_IMPOSTER_SEGMENT_LINE_WIDTH,
};

const BEAM_VISUAL_LAYERS: readonly {
  config: BeamVisualConfig;
  radiusMultiplier: number;
}[] = [
  { config: BEAM_OUTER_VISUAL_CONFIG, radiusMultiplier: 1.0 },
  { config: BEAM_INNER_VISUAL_CONFIG, radiusMultiplier: BEAM_LAYER_INNER_SCALE },
];

type BeamVisualLayer = {
  readonly config: BeamVisualConfig;
  readonly radiusMultiplier: number;
  readonly segmentMesh: THREE.InstancedMesh;
  readonly segmentFlow: Float32Array;
  readonly segmentFlowAttr: THREE.InstancedBufferAttribute;
  activeSegmentCount: number;
  readonly endpointMesh: THREE.InstancedMesh;
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
  segmentAlpha.fill(1);
  const segmentAlphaAttr = new THREE.InstancedBufferAttribute(segmentAlpha, 1);
  segmentAlphaAttr.setUsage(THREE.StaticDrawUsage);
  segmentGeom.setAttribute('aAlpha', segmentAlphaAttr);
  const segmentFlow = new Float32Array(BEAM_SEGMENT_CAP * 4);
  const segmentFlowAttr = new THREE.InstancedBufferAttribute(segmentFlow, 4);
  segmentFlowAttr.setUsage(THREE.DynamicDrawUsage);
  segmentGeom.setAttribute('aFlow', segmentFlowAttr);
  const segmentMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_SEGMENT_VERTEX_SHADER,
    fragmentShader: createBeamSegmentFragmentShader(config),
    uniforms: {
      uTime: BEAM_WAVE_TIME,
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
  endpointAlpha.fill(1);
  const endpointAlphaAttr = new THREE.InstancedBufferAttribute(endpointAlpha, 1);
  endpointAlphaAttr.setUsage(THREE.StaticDrawUsage);
  endpointGeom.setAttribute('aAlpha', endpointAlphaAttr);
  const endpointMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_ENDPOINT_VERTEX_SHADER,
    fragmentShader: createBeamEndpointFragmentShader(config),
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
    segmentFlow,
    segmentFlowAttr,
    activeSegmentCount: 0,
    endpointMesh,
    activeEndpointCount: 0,
  };
}

export class BeamRenderer3D {
  private root: THREE.Group;
  private readonly layers: BeamVisualLayer[];
  private readonly imposterSegmentMesh: THREE.LineSegments;
  private readonly imposterSegmentPositions: Float32Array;
  private readonly imposterSegmentPositionAttr: THREE.BufferAttribute;
  private activeImposterSegmentCount = 0;

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
    this.layers = new Array<BeamVisualLayer>(BEAM_VISUAL_LAYERS.length);
    for (let i = 0; i < BEAM_VISUAL_LAYERS.length; i++) {
      const layer = BEAM_VISUAL_LAYERS[i];
      this.layers[i] = createBeamVisualLayer(
        this.root,
        layer.config,
        layer.radiusMultiplier,
        12 + i,
      );
    }

    const imposterSegmentGeom = new THREE.BufferGeometry();
    this.imposterSegmentPositions = new Float32Array(BEAM_IMPOSTER_SEGMENT_CAP * 2 * 3);
    this.imposterSegmentPositionAttr = new THREE.BufferAttribute(this.imposterSegmentPositions, 3);
    this.imposterSegmentPositionAttr.setUsage(THREE.DynamicDrawUsage);
    imposterSegmentGeom.setAttribute('position', this.imposterSegmentPositionAttr);
    imposterSegmentGeom.setDrawRange(0, 0);
    const imposterSegmentMat = new THREE.LineBasicMaterial({
      color: BEAM_IMPOSTER_SEGMENT_CONFIG.color,
      linewidth: BEAM_IMPOSTER_SEGMENT_CONFIG.lineWidth,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
    this.imposterSegmentMesh = new THREE.LineSegments(imposterSegmentGeom, imposterSegmentMat);
    this.imposterSegmentMesh.frustumCulled = false;
    this.imposterSegmentMesh.renderOrder = 11;
    this.imposterSegmentMesh.visible = BEAM_IMPOSTER_SEGMENT_CONFIG.enabled;
    this.root.add(this.imposterSegmentMesh);
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
    length: number,
    flowPhase: number,
  ): void {
    if (slot >= BEAM_SEGMENT_CAP) return;
    const flowBase = slot * 4;
    layer.segmentFlow[flowBase] = 1.0;
    layer.segmentFlow[flowBase + 1] = beamWaveFlowRepeats(length, layer.config.waveSpacing);
    layer.segmentFlow[flowBase + 2] = flowPhase;
    layer.segmentFlow[flowBase + 3] = layer.config.waveSpeed;
    this.placeSegment(layer.segmentMesh, slot, ax, ay, az, bx, by, bz, cylRadius, length);
  }

  private writeImposterSegment(
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): void {
    if (slot >= BEAM_IMPOSTER_SEGMENT_CAP) return;
    const base = slot * 6;
    // sim-(x, y, z) maps to three-(x, z, y).
    this.imposterSegmentPositions[base] = ax;
    this.imposterSegmentPositions[base + 1] = az;
    this.imposterSegmentPositions[base + 2] = ay;
    this.imposterSegmentPositions[base + 3] = bx;
    this.imposterSegmentPositions[base + 4] = bz;
    this.imposterSegmentPositions[base + 5] = by;
  }

  private writeEndpoint(
    layer: BeamVisualLayer,
    slot: number,
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
  ): boolean {
    if (slot >= BEAM_ENDPOINT_CAP || radius <= 0.001) return false;
    this._matrix.makeScale(radius, radius, radius);
    this._matrix.setPosition(simX, simZ, simY);
    layer.endpointMesh.setMatrixAt(slot, this._matrix);
    return true;
  }

  private isOpenEndedLinePath(proj: NonNullable<Entity['projectile']>): boolean {
    if (proj.endpointDamageable !== false) return false;
    const points = proj.points;
    if (!points || points.length < 2) return false;
    const endPoint = points[points.length - 1];
    return (
      endPoint.reflectorEntityId === null &&
      endPoint.reflectorKind === null
    );
  }

  private hasActiveVisuals(): boolean {
    if (this.activeImposterSegmentCount > 0) return true;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.activeSegmentCount > 0 || layer.activeEndpointCount > 0) return true;
    }
    return false;
  }

  update(
    projectiles: readonly Entity[],
    _graphicsConfig?: GraphicsConfig,
    contentVersion?: number,
    turretMountResolver?: TurretMountResolver,
  ): void {
    if (projectiles.length === 0 && !this.hasActiveVisuals()) return;
    tickBeamWaveTime();
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
    let imposterSegIdx = 0;
    let endpointIdx = 0;
    const layers = this.layers;
    const layerCount = layers.length;

    for (let projectileIndex = 0; projectileIndex < projectiles.length; projectileIndex++) {
      const e = projectiles[projectileIndex];
      const pt = e.projectile?.projectileType;
      if (!pt || !isRayType(pt)) continue;

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

      const profile = proj.config.shotProfile.visual;
      // lineRadius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      const cylRadius = Math.max(
        BEAM_MIN_RADIUS,
        profile.lineRadius * BEAM_RADIUS_SCALE,
      );

      // Walk the polyline pairwise and draw one cylinder per segment.
      // Each reflection vertex carries its own (x, y, z), so pitched
      // beams bouncing off vertical mirrors trace the correct 3D path.
      // Per-segment alpha is held at 1.0 — the wave shader handles all
      // brightness modulation via mix(LOW_ALPHA, HIGH_ALPHA, pulse).
      const lastIdx = points.length - 1;
      const openEndedLine = OPEN_ENDED_LINE_CONFIG.extendToInfinity && this.isOpenEndedLinePath(proj);

      // Sim's points[0] sits at the turret mount center; snap-to-turret
      // re-anchors to the live mount so the start tracks the turret
      // smoothly between snapshots. This is both the logical and visual
      // start of the beam.
      let baseStartX = startPoint.x;
      let baseStartY = startPoint.y;
      let baseStartZ = startPoint.z;
      if (snapToTurret) {
        const turretIdx = proj.config.turretIndex ?? 0;
        const mount = turretMountResolver!.getTurretMountWorldState(
          proj.sourceEntityId, turretIdx,
        );
        if (mount) {
          baseStartX = mount.x;
          baseStartY = mount.y;
          baseStartZ = mount.z;
        }
      }

      for (let i = 0; i < lastIdx; i++) {
        const a = points[i];
        const b = points[i + 1];
        const useSnappedStart = i === 0;
        const ax = useSnappedStart ? baseStartX : a.x;
        const ay = useSnappedStart ? baseStartY : a.y;
        const az = useSnappedStart ? baseStartZ : a.z;
        let bx = b.x;
        let by = b.y;
        let bz = b.z;
        if (
          openEndedLine &&
          i + 1 === lastIdx
        ) {
          const prev = points[lastIdx - 1];
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
            const tailScale = OPEN_ENDED_LINE_CONFIG.infinityVisualLength / tailLen;
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
          const phase = beamWaveFlowPhase(e.id, segIdx);
          for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
            const layer = layers[layerIndex];
            this.writeSegment(
              layer,
              segIdx,
              ax, ay, az,
              bx, by, bz,
              cylRadius * layer.radiusMultiplier,
              segLen,
              phase,
            );
          }
          segIdx++;
        }
        if (BEAM_IMPOSTER_SEGMENT_CONFIG.enabled && imposterSegIdx < BEAM_IMPOSTER_SEGMENT_CAP) {
          this.writeImposterSegment(
            imposterSegIdx,
            ax, ay, az,
            bx, by, bz,
          );
          imposterSegIdx++;
        }
      }

      if (proj.endpointDamageable !== false) {
        if (endpointIdx < BEAM_ENDPOINT_CAP) {
          const damageSphereRadius = Math.max(
            ENDPOINT_MIN_RADIUS,
            profile.lineDamageSphereRadius,
          );
          for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
            const layer = layers[layerIndex];
            this.writeEndpoint(
              layer,
              endpointIdx,
              endPoint.x,
              endPoint.y,
              endPoint.z,
              damageSphereRadius * layer.radiusMultiplier,
            );
          }
          endpointIdx++;
        }
      }
    }

    for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
      const layer = layers[layerIndex];
      layer.segmentMesh.count = segIdx;
      if (segIdx > 0) {
        layer.segmentMesh.instanceMatrix.clearUpdateRanges();
        layer.segmentMesh.instanceMatrix.addUpdateRange(0, segIdx * 16);
        layer.segmentMesh.instanceMatrix.needsUpdate = true;
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
      }
      layer.activeEndpointCount = endpointIdx;
    }

    this.activeImposterSegmentCount = imposterSegIdx;
    this.imposterSegmentMesh.visible = BEAM_IMPOSTER_SEGMENT_CONFIG.enabled;
    this.imposterSegmentMesh.geometry.setDrawRange(0, imposterSegIdx * 2);
    if (imposterSegIdx > 0) {
      this.imposterSegmentPositionAttr.clearUpdateRanges();
      this.imposterSegmentPositionAttr.addUpdateRange(0, imposterSegIdx * 6);
      this.imposterSegmentPositionAttr.needsUpdate = true;
    }
  }

  destroy(): void {
    disposeMesh(this.imposterSegmentMesh);
    for (const layer of this.layers) {
      disposeMesh(layer.segmentMesh);
      disposeMesh(layer.endpointMesh);
    }
    detachObject(this.root);
  }
}
