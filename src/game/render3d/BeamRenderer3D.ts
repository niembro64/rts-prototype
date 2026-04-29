// BeamRenderer3D — renders beam and laser projectiles as thin 3D cylinders.
//
// ClientViewState reconstructs start/end/reflections (including z) from the
// source unit's turret yaw + pitch each frame via the 3D beam tracer in
// BeamPathResolver. This renderer reads those fields and draws one cylinder
// per path segment using each segment's real altitude — a pitched beam
// leaves the barrel tip at the unit's muzzle height and its reflections
// each carry their own hit-point z, so the rendered polyline matches the
// collision math exactly.
//
// Cylinders come from a shared pool: each frame we rebuild by pulling from
// the pool and hiding any leftover meshes. Per-team materials are cached.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { BEAM_MAX_LENGTH } from '../../config';
import type { ViewportFootprint } from '../ViewportFootprint';

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
const BEAM_COLOR = 0xffffff;

type BeamMat = {
  material: THREE.MeshBasicMaterial;
  /** Neutralise pool color if later re-used for a different team. */
  pid: PlayerId | undefined;
};

export class BeamRenderer3D {
  private root: THREE.Group;
  // Unit cylinder along +Y; rotated/positioned to span each segment
  private segmentGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  private segmentPool: THREE.Mesh[] = [];
  private activeSegmentCount = 0;

  // One material per (team, projectileType). Lasers and beams render the same
  // shape but at different opacities.
  private matCache = new Map<string, BeamMat>();

  // One MUTABLE material per pool slot, used to apply per-segment
  // distance-based alpha decay. Cloned from the team/type material on
  // first acquire; per-frame updates rewrite color (in case the slot
  // is reused for a different team) and opacity (the fade).
  private segmentMats: THREE.MeshBasicMaterial[] = [];

  // RENDER: WIN/PAD/ALL visibility scope — beams with BOTH endpoints
  // outside the scope rect skip segment placement entirely.
  private scope: ViewportFootprint;

  // Scratch vectors reused per frame (no per-segment allocations).
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _mid = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _quat = new THREE.Quaternion();

  constructor(parentWorld: THREE.Group, scope: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
  }

  private getMaterial(pid: PlayerId | undefined, projectileType: string): THREE.MeshBasicMaterial {
    // Beam color is WHITE regardless of player — matches 2D where the
    // beam core is always `0xffffff` and team identity comes from the
    // shooter / hit flare. The `pid` field is still kept in the cache
    // key so we can swap out later if we add a team-colored outer halo.
    const key = `${pid ?? -1}|${projectileType}`;
    const cached = this.matCache.get(key);
    if (cached) return cached.material;
    const mat = new THREE.MeshBasicMaterial({
      color: BEAM_COLOR,
      transparent: true,
      opacity: projectileType === 'laser' ? LASER_OPACITY_MAX : BEAM_OPACITY,
      depthWrite: false,
    });
    this.matCache.set(key, { material: mat, pid });
    return mat;
  }

  private acquireSegment(i: number): THREE.Mesh {
    let mesh = this.segmentPool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.segmentGeom);
      mesh.renderOrder = 12;
      this.root.add(mesh);
      this.segmentPool.push(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  /** Per-pool-slot mutable material so each segment can carry its own
   *  alpha (set from the distance-fade math). Cloned lazily from the
   *  team/type base material; color + opacity rewritten each frame. */
  private acquireSegmentMat(
    i: number,
    base: THREE.MeshBasicMaterial,
    fadeMul: number,
  ): THREE.MeshBasicMaterial {
    let mat = this.segmentMats[i];
    if (!mat) {
      mat = base.clone();
      this.segmentMats[i] = mat;
    }
    mat.color.copy(base.color);
    mat.opacity = base.opacity * fadeMul;
    return mat;
  }

  private placeSegment(
    mesh: THREE.Mesh,
    ax: number, az: number, bx: number, bz: number,
    ay: number, by: number,
    cylRadius: number,
  ): void {
    // sim-(x, y, z) maps to three-(x, z, y) — height is sim.z, which
    // the beam tracer now reports per segment (barrel-tip start,
    // reflection points, and final end all carry their real altitude).
    this._a.set(ax, ay, az);
    this._b.set(bx, by, bz);
    this._mid.copy(this._a).lerp(this._b, 0.5);
    const length = this._a.distanceTo(this._b);
    this._dir.copy(this._b).sub(this._a);
    if (length > 1e-5) this._dir.multiplyScalar(1 / length);
    else this._dir.set(1, 0, 0); // avoid NaN on degenerate segments
    // Rotate cylinder's default +Y axis to align with the segment direction.
    this._quat.setFromUnitVectors(this._up, this._dir);
    mesh.position.copy(this._mid);
    mesh.quaternion.copy(this._quat);
    // CylinderGeometry has radius 1; scale.x/.z become the actual radius, so
    // beam diameter = 2 · cylRadius = shot.width, matching the 2D renderer.
    mesh.scale.set(cylRadius, Math.max(length, 1e-3), cylRadius);
  }

  update(projectiles: readonly Entity[]): void {
    if (projectiles.length === 0 && this.activeSegmentCount === 0) return;

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
        cylRadius = Math.max(BEAM_MIN_RADIUS, shot.radius * BEAM_RADIUS_SCALE);
      }
      const baseMat = this.getMaterial(proj.ownerId, pt);

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
      if (reflections) {
        for (let i = 0; i < reflections.length; i++) {
          const r = reflections[i];
          const segLen = Math.hypot(r.x - prevX, r.y - prevY, r.z - prevZ);
          const midDist = cumDist + segLen / 2;
          const fade = Math.max(0, 1 - midDist / BEAM_MAX_LENGTH);
          const slot = segIdx++;
          const mesh = this.acquireSegment(slot);
          mesh.material = this.acquireSegmentMat(slot, baseMat, fade);
          this.placeSegment(mesh, prevX, prevY, r.x, r.y, prevZ, r.z, cylRadius);
          prevX = r.x;
          prevY = r.y;
          prevZ = r.z;
          cumDist += segLen;
        }
      }
      const finalLen = Math.hypot(endX - prevX, endY - prevY, endZ - prevZ);
      const finalMid = cumDist + finalLen / 2;
      const finalFade = Math.max(0, 1 - finalMid / BEAM_MAX_LENGTH);
      const finalSlot = segIdx++;
      const mesh = this.acquireSegment(finalSlot);
      mesh.material = this.acquireSegmentMat(finalSlot, baseMat, finalFade);
      this.placeSegment(mesh, prevX, prevY, endX, endY, prevZ, endZ, cylRadius);
    }

    // Hide leftover pool entries (beams that disappeared this frame).
    for (let i = segIdx; i < this.segmentPool.length; i++) {
      this.segmentPool[i].visible = false;
    }
    this.activeSegmentCount = segIdx;
  }

  destroy(): void {
    for (const mesh of this.segmentPool) this.root.remove(mesh);
    this.segmentPool.length = 0;
    for (const mat of this.segmentMats) mat.dispose();
    this.segmentMats.length = 0;
    this.segmentGeom.dispose();
    for (const { material } of this.matCache.values()) material.dispose();
    this.matCache.clear();
    this.root.parent?.remove(this.root);
  }
}
