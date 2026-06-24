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
import { COLORS } from '@/colorsConfig';
import { WAYPOINT_COLORS } from '../uiLabels';
import { WAYPOINT_GROUND_LIFT } from '../../config';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { GroundLineBatch3D } from './GroundLineBatch3D';
import { hexToRgb01 } from './colorUtils';

// Lift values chosen so the preview reads above terrain overlays at
// terrain overlays. Keep these tied to the persistent waypoint lift so
// issued commands and the drag preview stay visually aligned.
//
// The DragState's points / targets carry the click-altitude `z` from
// CursorGround.pickSim (sim coord = three.y), so the preview rides the
// rendered terrain instead of a fixed plane. LINE_LIFT / DOT_LIFT are
// added on top of that altitude so the ribbon clears the ground without
// z-fighting on slopes. The constants below are the legacy fixed-plane
// values, used only as a fallback when a point's z is missing
// (degenerate / 2D-only callers).
const LINE_LIFT = WAYPOINT_GROUND_LIFT;
const DOT_LIFT = WAYPOINT_GROUND_LIFT;
const LEGACY_LINE_Y = WAYPOINT_GROUND_LIFT;
const LEGACY_DOT_Y = WAYPOINT_GROUND_LIFT;
const BALLISTIC_BLOCKED_COLOR = 0xff3434;

// Visual sizing. Ribbon width is constant in world units (it's a 3D scene —
// dividing by camera zoom the way the 2D overlay does would fight the
// perspective projection). Target dots scale with a base radius plus a
// gentle modulation so multiple dots don't visually merge when close.
const DOT_RADIUS = 6;

type DragState = {
  active: boolean;
  points: ReadonlyArray<{ x: number; y: number; z?: number }>;
  targets: ReadonlyArray<{ x: number; y: number; z?: number }>;
  targetBallisticReach?: ReadonlyArray<'reachable' | 'blocked' | null>;
  mode: WaypointType;
};

export class LineDrag3D {
  private root: THREE.Group;

  // Path ribbon — the unified screen-space line batch (constant on-screen
  // width, depth-occluded), drawn through the traced drag points.
  private readonly lineBatch: GroundLineBatch3D;
  private readonly lineWidthPx: number;
  private linePoints = new Float32Array(0);

  // Filled sphere for each target; thin white ring around it for contrast
  // against dark tiles. Both are scaled uniformly from a unit base.
  private dotGeom = new THREE.SphereGeometry(1, 14, 10);
  private dotPool: THREE.Mesh[] = [];
  private ringGeom = new THREE.RingGeometry(1.0, 1.15, 24);
  private ringPool: THREE.Mesh[] = [];
  private hadVisible = false;

  // One fill + one line material per mode; lazily built, disposed on destroy.
  private fillMats = new Map<WaypointType, THREE.MeshBasicMaterial>();
  private blockedMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;

  constructor(parentWorld: THREE.Group, overlayLines: OverlayLineSystem) {
    this.root = new THREE.Group();
    // Render after entities but before HUD overlays so dots draw on top of
    // the chassis but beneath the 2D SVG layer (which lives in the DOM).
    this.root.renderOrder = 16;
    parentWorld.add(this.root);

    this.lineWidthPx = overlayLines.style('drag').widthPx;
    this.lineBatch = overlayLines.createBatch('drag', 64);
    this.root.add(this.lineBatch.mesh);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: COLORS.effects.lineDrag.ring.colorHex,
      transparent: true,
      opacity: COLORS.effects.lineDrag.ring.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.blockedMat = new THREE.MeshBasicMaterial({
      color: BALLISTIC_BLOCKED_COLOR,
      transparent: true,
      opacity: COLORS.effects.lineDrag.fillOpacity,
      depthWrite: false,
    });
  }

  update(state: DragState): void {
    // Inactive or empty — hide every live mesh and early-out. We don't tear
    // down pools here; they're reused the next drag.
    if (!state.active || state.points.length === 0) {
      if (this.hadVisible) this.hideAll();
      return;
    }

    const fill = this.getFillMat(state.mode);

    // --- Path ribbon ---
    // The traced points (each lifted onto the terrain it was sampled over)
    // become one screen-space polyline: constant on-screen width and
    // depth-occluded, drawn straight between consecutive lifted points.
    const pts = state.points;
    this.lineBatch.begin();
    if (pts.length >= 2) {
      if (this.linePoints.length < pts.length * 3) {
        this.linePoints = new Float32Array(pts.length * 3);
      }
      const lp = this.linePoints;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        lp[i * 3] = p.x;
        lp[i * 3 + 1] = p.z !== undefined ? p.z + LINE_LIFT : LEGACY_LINE_Y;
        lp[i * 3 + 2] = p.y;
      }
      const c = hexToRgb01(WAYPOINT_COLORS[state.mode]);
      this.lineBatch.pushPolyline(
        lp, pts.length,
        c.r, c.g, c.b, COLORS.effects.lineDrag.fillOpacity, this.lineWidthPx,
        false,
      );
    }
    this.lineBatch.finishFrame();
    const segIdx = pts.length >= 2 ? pts.length - 1 : 0;

    // --- Target dots + white outline ring ---
    const targets = state.targets;
    const targetReach = state.targetBallisticReach ?? [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const blocked = targetReach[i] === 'blocked';
      const dotY = t.z !== undefined ? t.z + DOT_LIFT : LEGACY_DOT_Y;
      const dot = this.acquireDot(i);
      dot.material = blocked ? this.blockedMat : fill;
      dot.position.set(t.x, dotY, t.y);
      dot.scale.setScalar(DOT_RADIUS);

      const ring = this.acquireRing(i);
      ring.position.set(t.x, dotY, t.y);
      ring.scale.setScalar(DOT_RADIUS);
    }
    for (let i = targets.length; i < this.dotPool.length; i++) {
      this.dotPool[i].visible = false;
    }
    for (let i = targets.length; i < this.ringPool.length; i++) {
      this.ringPool[i].visible = false;
    }
    this.hadVisible = segIdx > 0 || targets.length > 0;
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
      opacity: COLORS.effects.lineDrag.fillOpacity,
      depthWrite: false,
    });
    this.fillMats.set(mode, mat);
    return mat;
  }

  private hideAll(): void {
    this.lineBatch.begin();
    this.lineBatch.finishFrame();
    for (const m of this.dotPool) m.visible = false;
    for (const m of this.ringPool) m.visible = false;
    this.hadVisible = false;
  }

  destroy(): void {
    for (const m of this.dotPool) this.root.remove(m);
    for (const m of this.ringPool) this.root.remove(m);
    this.lineBatch.dispose();
    this.dotPool.length = 0;
    this.ringPool.length = 0;
    this.dotGeom.dispose();
    this.ringGeom.dispose();
    for (const mat of this.fillMats.values()) mat.dispose();
    this.fillMats.clear();
    this.blockedMat.dispose();
    this.ringMat.dispose();
    this.root.parent?.remove(this.root);
  }
}
