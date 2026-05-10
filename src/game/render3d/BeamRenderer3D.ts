// BeamRenderer3D — renders beam and laser projectiles as thin 3D cylinders.
//
// ClientViewState receives authoritative start/end/reflections (including z)
// from the host snapshots. This renderer reads those fields and draws one
// cylinder per path segment using each segment's real altitude, so reflected
// beam visuals match the server collision path without client-side tracing.
//
// Beam cylinders are drawn through one InstancedMesh. Each live path segment
// writes a matrix + alpha into the shared instance buffers, so a beam-heavy
// fight stays one draw call instead of one mesh/material draw per segment.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { isLineShotType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { BeamStyle, ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';
import { getBeamSnapToBarrel, getGraphicsConfig } from '@/clientBarConfig';
import type { Lod3DState } from './Lod3D';
import { objectLodToGraphicsTier, type RenderObjectLodTier } from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';
import { normalizeLodCellSize } from '../lodGridMath';
import { landCellIndexForSize } from '../landGrid';

// Cylinder radius is the sim's `shot.radius` (= shot.width / 2), scaled
// down and floored so a very-thin beam still renders as a visible line.
// BEAM_RADIUS_SCALE drops the cylinder thickness vs. the sim's 2D line
// width — the 3D cylinder reads as chunkier than the 2D pixel stroke,
// so we under-sample radius to keep beams looking crisp.
const BEAM_MIN_RADIUS = 0.35;
const BEAM_RADIUS_SCALE = 0.55;
// Beams are white lines at low alpha — team identity comes from the
// turret / impact context, not the beam itself. Tuned by eye: lasers
// slightly brighter than plain beams to keep the "laser = hotter" feel.
const BEAM_OPACITY = 0.16;
const LASER_OPACITY_MAX = 0.24;
const BEAM_SEGMENT_CAP = 8192;
const BEAM_ENDPOINT_CAP = 4096;
const ENDPOINT_OPACITY = 0.18;
const LASER_ENDPOINT_OPACITY = 0.26;
const ENDPOINT_MIN_RADIUS = 2.5;

/** Per-frame lookup that returns the world-space barrel-tip position
 *  the rendered cylinder is drawn at. Render3DEntities populates this
 *  in its per-barrel matrix-compose loop. Returns null when the source
 *  unit's mesh isn't built / is off-scope, in which case the renderer
 *  falls back to `points[0]` from the snapshot polyline. */
export type BarrelTipResolver = {
  getBarrelTipWorldPos(
    entityId: number,
    turretIdx: number,
    barrelIdx: number,
  ): { x: number; y: number; z: number } | null;
};

const BEAM_LOD_ORDER: Record<RenderObjectLodTier, number> = {
  marker: 0,
  impostor: 1,
  mass: 2,
  simple: 3,
  rich: 4,
  hero: 5,
};

const BEAM_OPACITY_BY_TIER: Record<ConcreteGraphicsQuality, number> = {
  min: 0.28,
  low: 0.42,
  medium: 0.62,
  high: 0.82,
  max: 1,
};

const BEAM_RADIUS_BY_TIER: Record<ConcreteGraphicsQuality, number> = {
  min: 0.45,
  low: 0.55,
  medium: 0.7,
  high: 0.88,
  max: 1,
};

const BEAM_FLOW_BY_TIER: Record<ConcreteGraphicsQuality, {
  strength: number;
  spacing: number;
  speed: number;
}> = {
  min: { strength: 0.18, spacing: 240, speed: 3.8 },
  low: { strength: 0.26, spacing: 180, speed: 4.8 },
  medium: { strength: 0.4, spacing: 125, speed: 6.6 },
  high: { strength: 0.56, spacing: 90, speed: 8.8 },
  max: { strength: 0.72, spacing: 65, speed: 11.5 },
};

const BEAM_FLOW_STYLE_MULTIPLIER: Record<BeamStyle, number> = {
  simple: 0.55,
  standard: 0.82,
  detailed: 1,
  complex: 1.15,
};

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

const BEAM_FRAGMENT_SHADER = `
uniform float uTime;
varying float vAlpha;
varying float vAlong;
varying vec4 vFlow;
void main() {
  float alpha = vAlpha;
  if (vFlow.x > 0.001) {
    float repeats = max(0.001, vFlow.y);
    float p = fract(vAlong * repeats - uTime * vFlow.w + vFlow.z);
    float pulseA = pow(max(0.0, 1.0 - abs(p - 0.18) / 0.18), 2.7);
    float pulseB = pow(max(0.0, 1.0 - abs(p - 0.62) / 0.08), 3.0) * 0.32;
    float pulse = min(1.0, pulseA + pulseB);
    alpha = min(1.0, alpha * (1.0 + vFlow.x * 1.8) + pulse * vFlow.x * 0.22);
  }
  gl_FragColor = vec4(vec3(1.0), alpha);
}
`;

const ENDPOINT_VERTEX_SHADER = `
attribute float aAlpha;
attribute float aPhase;
varying float vAlpha;
varying float vPhase;
void main() {
  vAlpha = aAlpha;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const ENDPOINT_FRAGMENT_SHADER = `
uniform float uTime;
varying float vAlpha;
varying float vPhase;
void main() {
  float pulse = 0.78 + 0.22 * sin(uTime * 10.0 + vPhase * 6.2831853);
  gl_FragColor = vec4(vec3(1.0), vAlpha * pulse);
}
`;

export class BeamRenderer3D {
  private root: THREE.Group;
  // Unit cylinder along +Y; rotated/positioned to span each segment
  private segmentGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  private segmentMesh: THREE.InstancedMesh;
  private segmentMat: THREE.ShaderMaterial;
  private segmentAlpha = new Float32Array(BEAM_SEGMENT_CAP);
  private segmentAlphaAttr: THREE.InstancedBufferAttribute;
  private segmentFlow = new Float32Array(BEAM_SEGMENT_CAP * 4);
  private segmentFlowAttr: THREE.InstancedBufferAttribute;
  private flowTimeUniform = { value: 0 };
  private activeSegmentCount = 0;
  private endpointGeom = new THREE.SphereGeometry(1, 12, 10);
  private endpointMesh: THREE.InstancedMesh;
  private endpointMat: THREE.ShaderMaterial;
  private endpointAlpha = new Float32Array(BEAM_ENDPOINT_CAP);
  private endpointPhase = new Float32Array(BEAM_ENDPOINT_CAP);
  private endpointAlphaAttr: THREE.InstancedBufferAttribute;
  private endpointPhaseAttr: THREE.InstancedBufferAttribute;
  private activeEndpointCount = 0;

  // RENDER: WIN/PAD/ALL visibility scope — beams with BOTH endpoints
  // outside the scope rect skip segment placement entirely.
  private scope: ViewportFootprint;
  private ownedLodGrid = new RenderLodGrid();
  private frameLodGrid = this.ownedLodGrid;
  private lodActive = false;
  private frameGfx: GraphicsConfig = getGraphicsConfig();
  private lastContentVersion = -1;
  private lastRenderKey = '';

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

    this.segmentAlphaAttr = new THREE.InstancedBufferAttribute(this.segmentAlpha, 1);
    this.segmentAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.segmentGeom.setAttribute('aAlpha', this.segmentAlphaAttr);
    this.segmentFlowAttr = new THREE.InstancedBufferAttribute(this.segmentFlow, 4);
    this.segmentFlowAttr.setUsage(THREE.DynamicDrawUsage);
    this.segmentGeom.setAttribute('aFlow', this.segmentFlowAttr);
    this.segmentMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
      uniforms: {
        uTime: this.flowTimeUniform,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.segmentMesh = new THREE.InstancedMesh(
      this.segmentGeom,
      this.segmentMat,
      BEAM_SEGMENT_CAP,
    );
    this.segmentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.segmentMesh.frustumCulled = false;
    this.segmentMesh.renderOrder = 12;
    this.segmentMesh.count = 0;
    this.root.add(this.segmentMesh);

    this.endpointAlphaAttr = new THREE.InstancedBufferAttribute(this.endpointAlpha, 1);
    this.endpointAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.endpointPhaseAttr = new THREE.InstancedBufferAttribute(this.endpointPhase, 1);
    this.endpointPhaseAttr.setUsage(THREE.DynamicDrawUsage);
    this.endpointGeom.setAttribute('aAlpha', this.endpointAlphaAttr);
    this.endpointGeom.setAttribute('aPhase', this.endpointPhaseAttr);
    this.endpointMat = new THREE.ShaderMaterial({
      vertexShader: ENDPOINT_VERTEX_SHADER,
      fragmentShader: ENDPOINT_FRAGMENT_SHADER,
      uniforms: {
        uTime: this.flowTimeUniform,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.endpointMesh = new THREE.InstancedMesh(
      this.endpointGeom,
      this.endpointMat,
      BEAM_ENDPOINT_CAP,
    );
    this.endpointMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.endpointMesh.frustumCulled = false;
    this.endpointMesh.renderOrder = 13;
    this.endpointMesh.count = 0;
    this.root.add(this.endpointMesh);
  }

  private resolvePointLod(simX: number, simY: number, simZ: number): RenderObjectLodTier {
    if (!this.lodActive) return 'rich';
    return this.frameLodGrid.resolve(simX, simZ, simY);
  }

  private richerLod(a: RenderObjectLodTier, b: RenderObjectLodTier): RenderObjectLodTier {
    return BEAM_LOD_ORDER[b] > BEAM_LOD_ORDER[a] ? b : a;
  }

  private resolveBeamLod(
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
  ): RenderObjectLodTier {
    let tier = this.resolvePointLod(startX, startY, startZ);
    tier = this.richerLod(tier, this.resolvePointLod(endX, endY, endZ));
    tier = this.richerLod(tier, this.resolvePointLod(
      (startX + endX) * 0.5,
      (startY + endY) * 0.5,
      (startZ + endZ) * 0.5,
    ));
    return tier;
  }

  private placeSegment(
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    length: number,
  ): void {
    // sim-(x, y, z) maps to three-(x, z, y) — height is sim.z, which
    // the beam tracer now reports per segment (barrel-tip start,
    // reflection points, and final end all carry their real altitude).
    this._a.set(ax, az, ay);
    this._b.set(bx, bz, by);
    this._mid.copy(this._a).lerp(this._b, 0.5);
    this._dir.copy(this._b).sub(this._a);
    if (length > 1e-5) this._dir.multiplyScalar(1 / length);
    else this._dir.set(1, 0, 0); // avoid NaN on degenerate segments
    // Rotate cylinder's default +Y axis to align with the segment direction.
    this._quat.setFromUnitVectors(this._up, this._dir);
    // CylinderGeometry has radius 1; scale.x/.z become the actual radius, so
    // beam diameter = 2 · cylRadius = shot.width, matching the 2D renderer.
    this._scale.set(cylRadius, Math.max(length, 1e-3), cylRadius);
    this._matrix.compose(this._mid, this._quat, this._scale);
    this.segmentMesh.setMatrixAt(slot, this._matrix);
  }

  private writeSegment(
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    alpha: number,
    length: number,
    flowStrength: number,
    flowRepeats: number,
    flowPhase: number,
    flowSpeed: number,
  ): boolean {
    if (slot >= BEAM_SEGMENT_CAP || alpha <= 0.001) return false;
    this.segmentAlpha[slot] = alpha;
    const flowBase = slot * 4;
    this.segmentFlow[flowBase] = flowStrength;
    this.segmentFlow[flowBase + 1] = flowRepeats;
    this.segmentFlow[flowBase + 2] = flowPhase;
    this.segmentFlow[flowBase + 3] = flowSpeed;
    this.placeSegment(slot, ax, ay, az, bx, by, bz, cylRadius, length);
    return true;
  }

  private writeEndpoint(
    slot: number,
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    alpha: number,
    phase: number,
  ): boolean {
    if (slot >= BEAM_ENDPOINT_CAP || alpha <= 0.001 || radius <= 0.001) return false;
    this._matrix.makeScale(radius, radius, radius);
    this._matrix.setPosition(simX, simZ, simY);
    this.endpointMesh.setMatrixAt(slot, this._matrix);
    this.endpointAlpha[slot] = alpha;
    this.endpointPhase[slot] = phase;
    return true;
  }

  private flowPhase(entityId: number, segmentIndex: number): number {
    const v = Math.sin(entityId * 12.9898 + segmentIndex * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  private flowRepeats(length: number, spacing: number): number {
    if (spacing <= 0 || length <= 1e-3) return 1;
    return Math.max(1, Math.min(80, length / spacing));
  }

  private makeRenderKey(lod?: Lod3DState): string {
    if (!lod) return `none|${this.frameGfx.tier}|${this.scope.getVersion()}`;
    const size = normalizeLodCellSize(this.frameGfx.objectLodCellSize);
    const view = lod.view;
    const cameraAltitudeBand = Math.floor(view.cameraY / size);
    return [
      lod.key,
      size,
      landCellIndexForSize(view.cameraX, size),
      landCellIndexForSize(view.cameraZ, size),
      cameraAltitudeBand,
      this.scope.getVersion(),
    ].join('|');
  }

  update(
    projectiles: readonly Entity[],
    graphicsConfig?: GraphicsConfig,
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
    contentVersion?: number,
    barrelTipResolver?: BarrelTipResolver,
  ): void {
    if (projectiles.length === 0 && this.activeSegmentCount === 0 && this.activeEndpointCount === 0) return;
    this.flowTimeUniform.value = performance.now() * 0.001;
    this.frameGfx = graphicsConfig ?? getGraphicsConfig();
    this.lodActive = lod !== undefined;
    this.frameLodGrid = sharedLodGrid ?? this.ownedLodGrid;
    if (lod) {
      if (!sharedLodGrid) this.frameLodGrid.beginFrame(lod.view, this.frameGfx);
    }
    const snapToBarrel = getBeamSnapToBarrel() && !!barrelTipResolver;
    const renderKey = this.makeRenderKey(lod);
    if (
      // Skip the contentVersion early-return when snap-to-barrel is on:
      // the live barrel tip can move every frame (chassis-tilt EMA,
      // turret yaw/pitch prediction) even when the beam polyline
      // version hasn't bumped. Forcing a redraw keeps the first
      // segment glued to the barrel mouth at all times.
      !snapToBarrel &&
      contentVersion !== undefined &&
      contentVersion === this.lastContentVersion &&
      renderKey === this.lastRenderKey
    ) {
      return;
    }
    if (contentVersion !== undefined) this.lastContentVersion = contentVersion;
    this.lastRenderKey = renderKey;

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
      // Scope gate before any LOD-grid work. Off-screen beam segments
      // can be numerous in large fights, and resolving their camera
      // sphere tier is wasted if both endpoints are outside the active
      // render footprint.
      const startIn = this.scope.inScope(startPoint.x, startPoint.y, 200);
      const endIn = this.scope.inScope(endPoint.x, endPoint.y, 200);
      if (!startIn && !endIn) continue;

      // Vertical endpoints come from the 3D beam tracer; the polyline
      // points already carry their own z (per-vertex 3D position).
      const objectTier = this.resolveBeamLod(
        startPoint.x, startPoint.y, startPoint.z,
        endPoint.x, endPoint.y, endPoint.z,
      );
      const graphicsTier = objectLodToGraphicsTier(objectTier, this.frameGfx.tier);
      const opacityMul = BEAM_OPACITY_BY_TIER[graphicsTier];
      const radiusMul = BEAM_RADIUS_BY_TIER[graphicsTier];
      const flowCfg = BEAM_FLOW_BY_TIER[graphicsTier];
      const flowStyleMul = BEAM_FLOW_STYLE_MULTIPLIER[this.frameGfx.beamStyle] ?? 1;
      const flowTypeMul = pt === 'laser' ? 1.12 : 1;
      const flowStrength = flowCfg.strength * flowStyleMul * flowTypeMul;
      const flowSpeed = flowCfg.speed * flowTypeMul;
      const drawReflections = objectTier !== 'impostor'
        && graphicsTier !== 'min'
        && graphicsTier !== 'low';

      const profile = proj.config.shotProfile.visual;
      // lineRadius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      const cylRadius = Math.max(
        BEAM_MIN_RADIUS,
        profile.lineRadius * BEAM_RADIUS_SCALE * radiusMul,
      );
      const damageSphereRadius = Math.max(
        ENDPOINT_MIN_RADIUS,
        profile.lineDamageSphereRadius,
      );
      const baseAlpha = pt === 'laser' ? LASER_OPACITY_MAX : BEAM_OPACITY;

      // Walk the polyline pairwise and draw one cylinder per segment.
      // Each reflection vertex carries its own (x, y, z), so pitched
      // beams bouncing off vertical mirrors trace the correct 3D path.
      // Every segment renders at the same uniform alpha — the beam
      // already expires at the firing turret's `range` or wherever it
      // hit / reflected, so no global length-based fade is needed.
      // At low render LODs we collapse the polyline to a single
      // start→end segment (skip drawing reflections).
      const segAlpha = baseAlpha * opacityMul;
      const lastIdx = points.length - 1;
      const stride = drawReflections ? 1 : lastIdx;

      // Resolve the live barrel tip for the FIRST segment when the
      // snap toggle is on. The rendered cylinder mouth and the beam
      // start drift apart slightly each frame because they come from
      // different code paths (rendered chassis-tilt EMA + predicted
      // turret pose vs snapshot-frozen `points[0]` extrapolated by a
      // single linear velocity hint). When a tip is found, replace
      // the start of the first segment ONLY — reflection vertices
      // and the endpoint sphere stay on the server-traced polyline.
      let snapStartX = 0, snapStartY = 0, snapStartZ = 0;
      let hasSnapStart = false;
      if (snapToBarrel) {
        const turretIdx = proj.config.turretIndex ?? 0;
        const barrelIdx = proj.sourceBarrelIndex ?? 0;
        const tip = barrelTipResolver!.getBarrelTipWorldPos(
          proj.sourceEntityId, turretIdx, barrelIdx,
        );
        if (tip) {
          snapStartX = tip.x;
          snapStartY = tip.y;
          snapStartZ = tip.z;
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
        const dx = b.x - ax;
        const dy = b.y - ay;
        const dz = b.z - az;
        const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (this.writeSegment(
          segIdx,
          ax, ay, az,
          b.x, b.y, b.z,
          cylRadius,
          segAlpha,
          segLen,
          flowStrength,
          this.flowRepeats(segLen, flowCfg.spacing),
          this.flowPhase(e.id, segIdx),
          flowSpeed,
        )) {
          segIdx++;
        }
      }

      if (proj.endpointDamageable !== false) {
        const endpointAlpha = (pt === 'laser' ? LASER_ENDPOINT_OPACITY : ENDPOINT_OPACITY) * opacityMul;
        if (this.writeEndpoint(
          endpointIdx,
          endPoint.x,
          endPoint.y,
          endPoint.z,
          damageSphereRadius,
          endpointAlpha,
          this.flowPhase(e.id, 997),
        )) {
          endpointIdx++;
        }
      }
    }

    this.segmentMesh.count = segIdx;
    if (segIdx > 0) {
      this.segmentMesh.instanceMatrix.clearUpdateRanges();
      this.segmentMesh.instanceMatrix.addUpdateRange(0, segIdx * 16);
      this.segmentMesh.instanceMatrix.needsUpdate = true;
      this.segmentAlphaAttr.clearUpdateRanges();
      this.segmentAlphaAttr.addUpdateRange(0, segIdx);
      this.segmentAlphaAttr.needsUpdate = true;
      this.segmentFlowAttr.clearUpdateRanges();
      this.segmentFlowAttr.addUpdateRange(0, segIdx * 4);
      this.segmentFlowAttr.needsUpdate = true;
    }
    this.activeSegmentCount = segIdx;

    this.endpointMesh.count = endpointIdx;
    if (endpointIdx > 0) {
      this.endpointMesh.instanceMatrix.clearUpdateRanges();
      this.endpointMesh.instanceMatrix.addUpdateRange(0, endpointIdx * 16);
      this.endpointMesh.instanceMatrix.needsUpdate = true;
      this.endpointAlphaAttr.clearUpdateRanges();
      this.endpointAlphaAttr.addUpdateRange(0, endpointIdx);
      this.endpointAlphaAttr.needsUpdate = true;
      this.endpointPhaseAttr.clearUpdateRanges();
      this.endpointPhaseAttr.addUpdateRange(0, endpointIdx);
      this.endpointPhaseAttr.needsUpdate = true;
    }
    this.activeEndpointCount = endpointIdx;
  }

  destroy(): void {
    this.root.remove(this.segmentMesh);
    this.segmentMesh.dispose();
    this.segmentMat.dispose();
    this.segmentGeom.dispose();
    this.root.remove(this.endpointMesh);
    this.endpointMesh.dispose();
    this.endpointMat.dispose();
    this.endpointGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
