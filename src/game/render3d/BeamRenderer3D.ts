// BeamRenderer3D — renders beam and laser projectiles as thin 3D cylinders.
//
// ClientViewState already reconstructs start/end/reflections from the source
// unit's turret state each frame (server sends only spawn/despawn — see
// ClientViewState.applyPrediction). This renderer reads those fields and draws
// one cylinder per path segment at SHOT_HEIGHT so the beam line up with the
// barrel tips of all turrets.
//
// Cylinders come from a shared pool: each frame we rebuild by pulling from the
// pool and hiding any leftover meshes. Per-team materials are cached.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';

// Must match the value in Render3DEntities so beams and barrel tips share a
// Y level. Kept as a constant (not exported from Render3DEntities) to avoid a
// circular import; if the value ever changes, update both.
const SHOT_HEIGHT = 28 + 16 / 2; // CHASSIS_HEIGHT + TURRET_HEIGHT / 2

const BEAM_MIN_THICKNESS = 1.5;
const BEAM_THICKNESS_MULT = 2.0;  // render ~2x the sim's `radius` for visibility
const LASER_OPACITY_MAX = 0.95;
const BEAM_OPACITY = 0.85;

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

  // One material per (team, projectileType). Lasers and beams render the same
  // shape but at different opacities.
  private matCache = new Map<string, BeamMat>();

  // Scratch vectors reused per frame (no per-segment allocations).
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _mid = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _quat = new THREE.Quaternion();

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  private getMaterial(pid: PlayerId | undefined, projectileType: string): THREE.MeshBasicMaterial {
    const key = `${pid ?? -1}|${projectileType}`;
    const cached = this.matCache.get(key);
    if (cached) return cached.material;
    const color = pid !== undefined
      ? PLAYER_COLORS[pid]?.primary ?? 0xffffff
      : 0xffffff;
    const mat = new THREE.MeshBasicMaterial({
      color,
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

  private placeSegment(
    mesh: THREE.Mesh,
    ax: number, az: number, bx: number, bz: number,
    thickness: number,
  ): void {
    this._a.set(ax, SHOT_HEIGHT, az);
    this._b.set(bx, SHOT_HEIGHT, bz);
    this._mid.copy(this._a).lerp(this._b, 0.5);
    const length = this._a.distanceTo(this._b);
    this._dir.copy(this._b).sub(this._a);
    if (length > 1e-5) this._dir.multiplyScalar(1 / length);
    else this._dir.set(1, 0, 0); // avoid NaN on degenerate segments
    // Rotate cylinder's default +Y axis to align with the segment direction.
    this._quat.setFromUnitVectors(this._up, this._dir);
    mesh.position.copy(this._mid);
    mesh.quaternion.copy(this._quat);
    mesh.scale.set(thickness, Math.max(length, 1e-3), thickness);
  }

  update(projectiles: readonly Entity[]): void {
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

      const shot = proj.config.shot;
      let radius = 2;
      if (shot && (shot.type === 'beam' || shot.type === 'laser')) {
        radius = shot.radius;
      }
      const thickness = Math.max(BEAM_MIN_THICKNESS, radius * BEAM_THICKNESS_MULT);
      const material = this.getMaterial(proj.ownerId, pt);

      // Build the path: start → reflections[0..n-1] → end. Each consecutive
      // pair is one cylinder segment.
      let prevX = startX;
      let prevY = startY;
      const reflections = proj.reflections;
      if (reflections) {
        for (let i = 0; i < reflections.length; i++) {
          const r = reflections[i];
          const mesh = this.acquireSegment(segIdx++);
          mesh.material = material;
          this.placeSegment(mesh, prevX, prevY, r.x, r.y, thickness);
          prevX = r.x;
          prevY = r.y;
        }
      }
      const mesh = this.acquireSegment(segIdx++);
      mesh.material = material;
      this.placeSegment(mesh, prevX, prevY, endX, endY, thickness);
    }

    // Hide leftover pool entries (beams that disappeared this frame).
    for (let i = segIdx; i < this.segmentPool.length; i++) {
      this.segmentPool[i].visible = false;
    }
  }

  destroy(): void {
    for (const mesh of this.segmentPool) this.root.remove(mesh);
    this.segmentPool.length = 0;
    this.segmentGeom.dispose();
    for (const { material } of this.matCache.values()) material.dispose();
    this.matCache.clear();
    this.root.parent?.remove(this.root);
  }
}
