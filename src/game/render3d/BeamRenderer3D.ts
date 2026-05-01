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
import { BEAM_MAX_LENGTH } from '../../config';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { Lod3DState } from './Lod3D';
import { objectLodToGraphicsTier, type RenderObjectLodTier } from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';

// Fallback altitude for beams whose proj.startZ / endZ haven't been
// populated yet (a single frame gap before the tracer runs). Matches the
// old flat-beam height so a first-frame beam renders at the same Y it
// did pre-3D, rather than snapping to 0.
const SHOT_HEIGHT = 28 + 16 / 2;

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

const BEAM_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAGMENT_SHADER = `
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vec3(1.0), vAlpha);
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
  private activeSegmentCount = 0;

  // RENDER: WIN/PAD/ALL visibility scope — beams with BOTH endpoints
  // outside the scope rect skip segment placement entirely.
  private scope: ViewportFootprint;
  private ownedLodGrid = new RenderLodGrid();
  private frameLodGrid = this.ownedLodGrid;
  private lodActive = false;
  private frameGfx: GraphicsConfig = getGraphicsConfig();

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
    this.segmentMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
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
  ): void {
    // sim-(x, y, z) maps to three-(x, z, y) — height is sim.z, which
    // the beam tracer now reports per segment (barrel-tip start,
    // reflection points, and final end all carry their real altitude).
    this._a.set(ax, az, ay);
    this._b.set(bx, bz, by);
    this._mid.copy(this._a).lerp(this._b, 0.5);
    const length = this._a.distanceTo(this._b);
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
  ): boolean {
    if (slot >= BEAM_SEGMENT_CAP || alpha <= 0.001) return false;
    this.segmentAlpha[slot] = alpha;
    this.placeSegment(slot, ax, ay, az, bx, by, bz, cylRadius);
    return true;
  }

  update(
    projectiles: readonly Entity[],
    graphicsConfig?: GraphicsConfig,
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): void {
    if (projectiles.length === 0 && this.activeSegmentCount === 0) return;
    this.frameGfx = graphicsConfig ?? getGraphicsConfig();
    this.lodActive = lod !== undefined;
    this.frameLodGrid = sharedLodGrid ?? this.ownedLodGrid;
    if (lod) {
      if (!sharedLodGrid) this.frameLodGrid.beginFrame(lod.view, this.frameGfx);
    }

    let segIdx = 0;

    for (const e of projectiles) {
      const pt = e.projectile?.projectileType;
      if (pt !== 'beam' && pt !== 'laser') continue;

      const proj = e.projectile!;
      const startX = proj.startX;
      const startY = proj.startY;
      const endX = proj.endX;
      const endY = proj.endY;
      if (
        startX === undefined || startY === undefined ||
        endX === undefined || endY === undefined
      ) continue;
      // Vertical endpoints come from the 3D beam tracer; fall back to
      // SHOT_HEIGHT for beams that predate the z-aware path (e.g. a
      // keyframe where start/endZ wasn't populated yet).
      const startZ = proj.startZ ?? SHOT_HEIGHT;
      const endZ = proj.endZ ?? SHOT_HEIGHT;
      const objectTier = this.resolveBeamLod(startX, startY, startZ, endX, endY, endZ);
      if (objectTier === 'marker') continue;
      const graphicsTier = objectLodToGraphicsTier(objectTier, this.frameGfx.tier);
      const opacityMul = BEAM_OPACITY_BY_TIER[graphicsTier];
      const radiusMul = BEAM_RADIUS_BY_TIER[graphicsTier];
      const drawReflections = objectTier !== 'impostor'
        && graphicsTier !== 'min'
        && graphicsTier !== 'low';

      // Scope gate — skip the beam entirely when BOTH endpoints are
      // outside the render rect. A beam that crosses the rect (one
      // endpoint inside) still draws so long/grazing shots aren't
      // clipped to the visible area. Padding is generous (200) because
      // laser endpoints can be far from the beam's visible midline
      // when hitting terrain edges.
      const startIn = this.scope.inScope(startX, startY, 200);
      const endIn = this.scope.inScope(endX, endY, 200);
      if (!startIn && !endIn) continue;

      const shot = proj.config.shot;
      // shot.radius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      let cylRadius = BEAM_MIN_RADIUS;
      if (shot && (shot.type === 'beam' || shot.type === 'laser')) {
        cylRadius = Math.max(BEAM_MIN_RADIUS, shot.radius * BEAM_RADIUS_SCALE * radiusMul);
      }
      const baseAlpha = pt === 'laser' ? LASER_OPACITY_MAX : BEAM_OPACITY;

      // Build the path: start → reflections[0..n-1] → end. Each
      // consecutive pair is one cylinder segment. Each reflection
      // carries its own z so pitched beams bouncing off vertical
      // mirrors trace the correct 3D polyline. Cumulative distance
      // along the polyline drives a linear alpha fade so the beam
      // visually "decays" with range — fully bright at the muzzle,
      // fading to invisible at BEAM_MAX_LENGTH (which is also the
      // hard collision cutoff on the sim side, so the visual fade
      // hits zero at exactly the same place the beam itself ends).
      let prevX = startX;
      let prevY = startY;
      let prevZ = startZ;
      let cumDist = 0;
      const reflections = proj.reflections;
      if (reflections && drawReflections) {
        for (let i = 0; i < reflections.length; i++) {
          const r = reflections[i];
          const segLen = Math.hypot(r.x - prevX, r.y - prevY, r.z - prevZ);
          const midDist = cumDist + segLen / 2;
          const alpha = baseAlpha * Math.max(0, 1 - midDist / BEAM_MAX_LENGTH) * opacityMul;
          if (this.writeSegment(segIdx, prevX, prevY, prevZ, r.x, r.y, r.z, cylRadius, alpha)) {
            segIdx++;
          }
          prevX = r.x;
          prevY = r.y;
          prevZ = r.z;
          cumDist += segLen;
        }
      }
      const finalLen = Math.hypot(endX - prevX, endY - prevY, endZ - prevZ);
      const finalMid = cumDist + finalLen / 2;
      const finalAlpha = baseAlpha * Math.max(0, 1 - finalMid / BEAM_MAX_LENGTH) * opacityMul;
      if (this.writeSegment(segIdx, prevX, prevY, prevZ, endX, endY, endZ, cylRadius, finalAlpha)) {
        segIdx++;
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
    }
    this.activeSegmentCount = segIdx;
  }

  destroy(): void {
    this.root.remove(this.segmentMesh);
    this.segmentMesh.dispose();
    this.segmentMat.dispose();
    this.segmentGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
