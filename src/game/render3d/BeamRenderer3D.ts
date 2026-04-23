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

// Must match the value in Render3DEntities so beams and barrel tips share a
// Y level. Kept as a constant (not exported from Render3DEntities) to avoid a
// circular import; if the value ever changes, update both.
const SHOT_HEIGHT = 28 + 16 / 2; // CHASSIS_HEIGHT + TURRET_HEIGHT / 2

// Cylinder radius is the sim's `shot.radius` (= shot.width / 2), floored so a
// very-thin beam isn't invisible. Matches TurretRenderer.ts which draws beams
// at `shot.width` pixels thick.
const BEAM_MIN_RADIUS = 0.75;
// Matches the 2D ProjectileRenderer aesthetic: beams are white lines at
// low alpha — the team's identity shows through the turret / hit halo,
// not through the beam color itself. 2D uses white @ alpha=0.33; 3D is
// a volumetric cylinder so we need higher per-pixel alpha to read as a
// glowing bar rather than a ghost. Tuned by eye: lasers slightly
// brighter than plain beams to keep the existing "laser = hotter" feel.
const BEAM_OPACITY = 0.55;
const LASER_OPACITY_MAX = 0.7;
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

  private placeSegment(
    mesh: THREE.Mesh,
    ax: number, az: number, bx: number, bz: number,
    cylRadius: number,
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
    // CylinderGeometry has radius 1; scale.x/.z become the actual radius, so
    // beam diameter = 2 · cylRadius = shot.width, matching the 2D renderer.
    mesh.scale.set(cylRadius, Math.max(length, 1e-3), cylRadius);
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
      // shot.radius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      let cylRadius = BEAM_MIN_RADIUS;
      if (shot && (shot.type === 'beam' || shot.type === 'laser')) {
        cylRadius = Math.max(BEAM_MIN_RADIUS, shot.radius);
      }
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
          this.placeSegment(mesh, prevX, prevY, r.x, r.y, cylRadius);
          prevX = r.x;
          prevY = r.y;
        }
      }
      const mesh = this.acquireSegment(segIdx++);
      mesh.material = material;
      this.placeSegment(mesh, prevX, prevY, endX, endY, cylRadius);
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
