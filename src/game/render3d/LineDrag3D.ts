// LineDrag3D — right-click-drag formation line preview for the 3D view.
//
// While the user is holding right-mouse and dragging with multiple units
// selected, draw the path polyline the cursor has traced plus one small
// sphere at every unit's assigned spot along that path. Matches the 2D
// overlay in CommandController.drawLinePath: mode-colored line + filled
// dots + white outlines.
//
// Segments of the path are rendered as stretched flat boxes just above the
// ground (thin ribbon that reads as a line at any zoom, unlike WebGL's
// 1-pixel LineBasicMaterial which can disappear at far zoom). Target dots
// are small spheres raised slightly off the floor so they pop over the
// tile grid and the path ribbon.
//
// Data comes from Input3DManager.getLineDragState(), read once per frame in
// RtsScene3D.update(). No per-frame allocation after warmup — meshes are
// pulled from a pool and hidden when the drag ends.

import * as THREE from 'three';
import type { WaypointType } from '../sim/types';
import { WAYPOINT_COLORS } from '../uiLabels';

// Lift values chosen so the preview reads above the tile layer (y=0) and the
// burn-mark layer (y≈2.5), but below beam cylinders (y=SHOT_HEIGHT). Target
// dots sit slightly higher than the line so they don't z-fight with it.
const LINE_Y = 3.5;
const DOT_Y = 5.0;

// Visual sizing. Ribbon width is constant in world units (it's a 3D scene —
// dividing by camera zoom the way the 2D overlay does would fight the
// perspective projection). Target dots scale with a base radius plus a
// gentle modulation so multiple dots don't visually merge when close.
const LINE_WIDTH = 3;
const DOT_RADIUS = 6;

type DragState = {
  active: boolean;
  points: ReadonlyArray<{ x: number; y: number }>;
  targets: ReadonlyArray<{ x: number; y: number }>;
  mode: WaypointType;
};

export class LineDrag3D {
  private root: THREE.Group;

  // Ribbon segment = flat box scaled to (segmentLength × LINE_WIDTH), laid on
  // XZ plane. Pool entries are hidden when not in use; visible ones are
  // repositioned each frame.
  private segmentGeom = new THREE.BoxGeometry(1, 0.5, 1);
  private segmentPool: THREE.Mesh[] = [];

  // Filled sphere for each target; thin white ring around it for contrast
  // against dark tiles. Both are scaled uniformly from a unit base.
  private dotGeom = new THREE.SphereGeometry(1, 14, 10);
  private dotPool: THREE.Mesh[] = [];
  private ringGeom = new THREE.RingGeometry(1.0, 1.15, 24);
  private ringPool: THREE.Mesh[] = [];

  // One fill + one line material per mode; lazily built, disposed on destroy.
  private fillMats = new Map<WaypointType, THREE.MeshBasicMaterial>();
  private ringMat: THREE.MeshBasicMaterial;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    // Render after entities but before HUD overlays so dots draw on top of
    // the chassis but beneath the 2D SVG layer (which lives in the DOM).
    this.root.renderOrder = 16;
    parentWorld.add(this.root);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  update(state: DragState): void {
    // Inactive or empty — hide every live mesh and early-out. We don't tear
    // down pools here; they're reused the next drag.
    if (!state.active || state.points.length === 0) {
      this.hideAll();
      return;
    }

    const fill = this.getFillMat(state.mode);

    // --- Path ribbon ---
    // Each consecutive pair of points becomes one segment box, rotated around
    // Y so its local X axis points along the segment direction.
    const pts = state.points;
    let segIdx = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const length = Math.hypot(dx, dz);
      if (length < 1e-3) continue;
      const seg = this.acquireSegment(segIdx++);
      seg.material = fill;
      const angle = Math.atan2(dz, dx);
      seg.rotation.set(0, -angle, 0);
      seg.position.set((a.x + b.x) / 2, LINE_Y, (a.y + b.y) / 2);
      seg.scale.set(length, 1, LINE_WIDTH);
    }
    for (let i = segIdx; i < this.segmentPool.length; i++) {
      this.segmentPool[i].visible = false;
    }

    // --- Target dots + white outline ring ---
    const targets = state.targets;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const dot = this.acquireDot(i);
      dot.material = fill;
      dot.position.set(t.x, DOT_Y, t.y);
      dot.scale.setScalar(DOT_RADIUS);

      const ring = this.acquireRing(i);
      ring.position.set(t.x, DOT_Y, t.y);
      ring.scale.setScalar(DOT_RADIUS);
    }
    for (let i = targets.length; i < this.dotPool.length; i++) {
      this.dotPool[i].visible = false;
    }
    for (let i = targets.length; i < this.ringPool.length; i++) {
      this.ringPool[i].visible = false;
    }
  }

  private acquireSegment(i: number): THREE.Mesh {
    let mesh = this.segmentPool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.segmentGeom);
      mesh.renderOrder = 16;
      this.root.add(mesh);
      this.segmentPool.push(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  private acquireDot(i: number): THREE.Mesh {
    let mesh = this.dotPool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.dotGeom);
      mesh.renderOrder = 17;
      this.root.add(mesh);
      this.dotPool.push(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  private acquireRing(i: number): THREE.Mesh {
    let mesh = this.ringPool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.ringGeom, this.ringMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 18;
      this.root.add(mesh);
      this.ringPool.push(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  private getFillMat(mode: WaypointType): THREE.MeshBasicMaterial {
    const cached = this.fillMats.get(mode);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: WAYPOINT_COLORS[mode],
      transparent: true,
      // Path ribbon opacity 0.6 and dot opacity 0.9 combined — since the same
      // material serves both, pick the higher value; ring material already
      // provides the outline separation that sells the "dot" shape.
      opacity: 0.85,
      depthWrite: false,
    });
    this.fillMats.set(mode, mat);
    return mat;
  }

  private hideAll(): void {
    for (const m of this.segmentPool) m.visible = false;
    for (const m of this.dotPool) m.visible = false;
    for (const m of this.ringPool) m.visible = false;
  }

  destroy(): void {
    for (const m of this.segmentPool) this.root.remove(m);
    for (const m of this.dotPool) this.root.remove(m);
    for (const m of this.ringPool) this.root.remove(m);
    this.segmentPool.length = 0;
    this.dotPool.length = 0;
    this.ringPool.length = 0;
    this.segmentGeom.dispose();
    this.dotGeom.dispose();
    this.ringGeom.dispose();
    for (const mat of this.fillMats.values()) mat.dispose();
    this.fillMats.clear();
    this.ringMat.dispose();
    this.root.parent?.remove(this.root);
  }
}
