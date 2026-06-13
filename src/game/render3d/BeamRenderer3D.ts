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
import { getPlayerColors, isRayType } from '../sim/types';
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
// edit those files to retune how beams look. The start-point ball is no
// longer drawn here: it lives at the beam turret's barrel tip full-time
// (see the emitter rig in TurretMesh3D / UnitDetailInstanceRenderer3D).
// The remaining constants below shape buffer sizes and cylinder geometry,
// not look.
const BEAM_SEGMENT_CAP = 8192;
const BEAM_ENDPOINT_CAP = 4096;
const BEAM_EMITTER_CAP = 4096;
const BEAM_MIN_RADIUS = 0.35;
const BEAM_RADIUS_SCALE = 0.55;
const ENDPOINT_MIN_RADIUS = 2.5;
const DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH = 12000;

export type TurretMountResolver = {
  getTurretMountWorldState(
    entityId: number,
    turretIdx: number,
  ): { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number } | null;
};

/** Torus ring drawn around the beam start point with player color.
 *  radiusMultiplier scales beam.lineRadius for the torus's main ring
 *  radius; tubeRadiusMultiplier does the same for the tube thickness;
 *  offsetAlongBeam scales beam.lineRadius for the position offset along
 *  the firing direction (negative = behind the start, positive = forward);
 *  alpha is the ring's opacity (1 = fully opaque, 0 = invisible). */
type StartPointTorusConfig = {
  radiusMultiplier: number;
  tubeRadiusMultiplier: number;
  offsetAlongBeam: number;
  alpha: number;
};

type OpenEndedLineConfig = {
  extendToInfinity: boolean;
  infinityVisualLength: number;
};

type BeamConfigFile = {
  openEndedLine?: Partial<OpenEndedLineConfig>;
  startPointTorus?: Partial<StartPointTorusConfig>[];
};

const rawBeamConfig = beamConfig as unknown as BeamConfigFile;

const START_POINT_TORUS_CONFIGS: readonly StartPointTorusConfig[] = (
  rawBeamConfig.startPointTorus ?? []
).map((c) => ({
  radiusMultiplier: c.radiusMultiplier ?? 2.0,
  tubeRadiusMultiplier: c.tubeRadiusMultiplier ?? 0.3,
  offsetAlongBeam: c.offsetAlongBeam ?? 0,
  alpha: c.alpha ?? 1.0,
}));

const configuredInfinityVisualLength =
  rawBeamConfig.openEndedLine?.infinityVisualLength ?? DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH;

const OPEN_ENDED_LINE_CONFIG: OpenEndedLineConfig = {
  extendToInfinity: rawBeamConfig.openEndedLine?.extendToInfinity ?? true,
  infinityVisualLength:
    Number.isFinite(configuredInfinityVisualLength) && configuredInfinityVisualLength > 0
      ? configuredInfinityVisualLength
      : DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH,
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
  readonly segmentAlpha: Float32Array;
  readonly segmentAlphaAttr: THREE.InstancedBufferAttribute;
  readonly segmentFlow: Float32Array;
  readonly segmentFlowAttr: THREE.InstancedBufferAttribute;
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
  const segmentMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_SEGMENT_VERTEX_SHADER,
    fragmentShader: createBeamSegmentFragmentShader(config),
    uniforms: {
      // One shared clock with the always-on emitter rig (cone + ball)
      // so the bands flow continuously from barrel into beam.
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
  const endpointAlphaAttr = new THREE.InstancedBufferAttribute(endpointAlpha, 1);
  endpointAlphaAttr.setUsage(THREE.DynamicDrawUsage);
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
    segmentAlpha,
    segmentAlphaAttr,
    segmentFlow,
    segmentFlowAttr,
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
  private readonly torusMeshes: THREE.InstancedMesh[];
  private readonly torusColor = new THREE.Color();

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
  // TorusGeometry's default ring axis points along local Z; rotating this
  // unit Z onto the beam direction stands each torus up around the beam.
  private _torusAxis = new THREE.Vector3(0, 0, 1);
  private _torusPos = new THREE.Vector3();
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

    // The start-point ball ("generator orb") is no longer drawn here: it
    // sits at the beam turret's barrel tip full-time, rendered in the same
    // wave material as the beam (TurretMesh3D / UnitDetailInstanceRenderer3D).

    // Player-colored torus rings around the start point. One mesh per
    // config entry; each entry bakes its own tube/radius ratio so we
    // can scale uniformly per-instance by (lineRadius * radiusMultiplier).
    // alpha < 1 flips the material into transparent mode (depthWrite
    // off so rings don't occlude the orb / beam behind them).
    this.torusMeshes = START_POINT_TORUS_CONFIGS.map((cfg, idx) => {
      const safeRadiusMult = cfg.radiusMultiplier > 1e-5 ? cfg.radiusMultiplier : 1;
      const tubeRatio = cfg.tubeRadiusMultiplier / safeRadiusMult;
      const geom = new THREE.TorusGeometry(1, tubeRatio, 8, 24);
      const alpha = Math.max(0, Math.min(1, cfg.alpha));
      const isTransparent = alpha < 1;
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: isTransparent,
        opacity: alpha,
        depthWrite: !isTransparent,
      });
      const mesh = new THREE.InstancedMesh(geom, mat, BEAM_EMITTER_CAP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 11 + idx + 1;
      mesh.count = 0;
      this.root.add(mesh);
      return mesh;
    });
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
    layer.segmentFlow[flowBase + 1] = beamWaveFlowRepeats(length, layer.config.waveSpacing);
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
    for (const tMesh of this.torusMeshes) {
      if (tMesh.count > 0) return true;
    }
    return this.layers.some(
      (layer) => layer.activeSegmentCount > 0 || layer.activeEndpointCount > 0,
    );
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
    let endpointIdx = 0;
    let torusIdx = 0;

    for (const e of projectiles) {
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
      const damageSphereRadius = Math.max(
        ENDPOINT_MIN_RADIUS,
        profile.lineDamageSphereRadius,
      );
      const emissionOffset = profile.lineEmissionOffset;

      // Walk the polyline pairwise and draw one cylinder per segment.
      // Each reflection vertex carries its own (x, y, z), so pitched
      // beams bouncing off vertical mirrors trace the correct 3D path.
      // Per-segment alpha is held at 1.0 — the wave shader handles all
      // brightness modulation via mix(LOW_ALPHA, HIGH_ALPHA, pulse).
      const lastIdx = points.length - 1;
      const openEndedLine = this.isOpenEndedLinePath(proj);

      // Sim's points[0] sits at the turret mount center; snap-to-turret
      // re-anchors to the live mount so the start tracks the turret
      // smoothly between snapshots. Either way, this position is the
      // LOGICAL start (mount center) — the visual offset is applied
      // below.
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

      // Firing direction (normalized, sim coords). Use the same snapped
      // logical start the visible first segment uses; otherwise the beam
      // cylinder can leave the live turret mount at a different angle from
      // the fake barrel/orb when prediction moves the mount between
      // snapshots. Fall back to the raw snapshot direction only if the
      // snapped segment is degenerate.
      const nextPoint = points[1];
      let beamDirX = nextPoint.x - baseStartX;
      let beamDirY = nextPoint.y - baseStartY;
      let beamDirZ = nextPoint.z - baseStartZ;
      let beamDirLen = Math.sqrt(
        beamDirX * beamDirX + beamDirY * beamDirY + beamDirZ * beamDirZ,
      );
      if (
        beamDirLen <= 1e-5 &&
        (baseStartX !== startPoint.x ||
          baseStartY !== startPoint.y ||
          baseStartZ !== startPoint.z)
      ) {
        beamDirX = nextPoint.x - startPoint.x;
        beamDirY = nextPoint.y - startPoint.y;
        beamDirZ = nextPoint.z - startPoint.z;
        beamDirLen = Math.sqrt(
          beamDirX * beamDirX + beamDirY * beamDirY + beamDirZ * beamDirZ,
        );
      }
      let hasBeamDir = false;
      if (beamDirLen > 1e-5) {
        const inv = 1 / beamDirLen;
        beamDirX *= inv;
        beamDirY *= inv;
        beamDirZ *= inv;
        hasBeamDir = true;
      }

      // Visual start = mount-center start pushed forward along the
      // firing direction by emissionOffset, so the beam visually
      // "generates" outside the turret. The first beam segment, orb,
      // and torus rings all anchor here; the sim path itself remains
      // at the mount center.
      let visualStartX = baseStartX;
      let visualStartY = baseStartY;
      let visualStartZ = baseStartZ;
      if (emissionOffset > 0 && hasBeamDir) {
        visualStartX += beamDirX * emissionOffset;
        visualStartY += beamDirY * emissionOffset;
        visualStartZ += beamDirZ * emissionOffset;
      }
      // Player-colored torus rings around the start point. Each ring's
      // axis aligns with the firing direction so the torus encircles
      // the beam; per-config offsetAlongBeam pushes it forward/back of
      // the visual start along that direction. (The start ball itself is
      // the turret's always-on emitter ball at the barrel tip.)
      if (
        emissionOffset > 0 &&
        hasBeamDir &&
        torusIdx < BEAM_EMITTER_CAP &&
        this.torusMeshes.length > 0
      ) {
        // Rotate the torus's local Z (default ring axis) onto the firing
        // direction expressed in three-coords (x, z=height, y).
        this._dir.set(beamDirX, beamDirZ, beamDirY);
        this._quat.setFromUnitVectors(this._torusAxis, this._dir);
        this.torusColor.set(getPlayerColors(proj.ownerId).primary);
        for (let ti = 0; ti < this.torusMeshes.length; ti++) {
          const cfg = START_POINT_TORUS_CONFIGS[ti];
          const torusScale = profile.lineRadius * cfg.radiusMultiplier;
          const torusOffset = profile.lineRadius * cfg.offsetAlongBeam;
          const tSimX = visualStartX + beamDirX * torusOffset;
          const tSimY = visualStartY + beamDirY * torusOffset;
          const tSimZ = visualStartZ + beamDirZ * torusOffset;
          this._torusPos.set(tSimX, tSimZ, tSimY);
          this._scale.set(torusScale, torusScale, torusScale);
          this._matrix.compose(this._torusPos, this._quat, this._scale);
          this.torusMeshes[ti].setMatrixAt(torusIdx, this._matrix);
          this.torusMeshes[ti].setColorAt(torusIdx, this.torusColor);
        }
        torusIdx++;
      }

      for (let i = 0; i < lastIdx; i++) {
        const a = points[i];
        const b = points[i + 1];
        // First segment starts at the visual offset point — there is
        // no cylinder drawn between the mount center and the orb.
        const useVisualStart = i === 0;
        const ax = useVisualStart ? visualStartX : a.x;
        const ay = useVisualStart ? visualStartY : a.y;
        const az = useVisualStart ? visualStartZ : a.z;
        let bx = b.x;
        let by = b.y;
        let bz = b.z;
        if (
          OPEN_ENDED_LINE_CONFIG.extendToInfinity &&
          openEndedLine &&
          i + 1 === lastIdx
        ) {
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

    for (const tMesh of this.torusMeshes) {
      tMesh.count = torusIdx;
      if (torusIdx > 0) {
        tMesh.instanceMatrix.clearUpdateRanges();
        tMesh.instanceMatrix.addUpdateRange(0, torusIdx * 16);
        tMesh.instanceMatrix.needsUpdate = true;
        const colorAttr = tMesh.instanceColor;
        if (colorAttr) {
          colorAttr.clearUpdateRanges();
          colorAttr.addUpdateRange(0, torusIdx * 3);
          colorAttr.needsUpdate = true;
        }
      }
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      disposeMesh(layer.segmentMesh);
      disposeMesh(layer.endpointMesh);
    }
    for (const tMesh of this.torusMeshes) disposeMesh(tMesh);
    detachObject(this.root);
  }
}
