import * as THREE from 'three';
import { WAYPOINT_GROUND_LIFT } from '../../config';
import { ACTION_COLORS } from '../uiLabels';
import type { Input3DAreaDragKind, Input3DAreaDragState } from './Input3DAreaDragState';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { GroundLineBatch3D } from './GroundLineBatch3D';
import { hexToRgb01 } from './colorUtils';
import { createPrimitiveCircleGeometry } from './PrimitiveGeometryQuality3D';

const RING_LIFT = WAYPOINT_GROUND_LIFT + 1;
const LEGACY_Y = RING_LIFT;
const OUTLINE_OPACITY = 0.88;
const OUTLINE_SEGMENTS = 96;

const AREA_COLORS: Record<Input3DAreaDragKind, number> = {
  repairArea: ACTION_COLORS.repair,
  reclaimArea: ACTION_COLORS.reclaim,
  resurrectArea: ACTION_COLORS.resurrect,
  attackArea: ACTION_COLORS.attack,
  attackGround: ACTION_COLORS.attackGround,
  buildMexArea: ACTION_COLORS.build,
  upgradeMexArea: ACTION_COLORS.build,
  buildLine: ACTION_COLORS.build,
  buildBorder: ACTION_COLORS.build,
  buildGrid: ACTION_COLORS.build,
};
const BALLISTIC_BLOCKED_COLOR = 0xff3434;

// Area/build drag preview. The OUTLINES (radius ring, build line, build-rect
// border) go through the unified screen-space line batch — constant on-screen
// width, depth-occluded. The FILLS (radius disc, build-rect fill) stay as
// world-scaled translucent meshes, since a filled area should scale with the
// area, not the screen.
export class AreaDrag3D {
  private readonly root = new THREE.Group();
  private readonly discGeom = createPrimitiveCircleGeometry('hud', 'close');
  private readonly rectFillGeom = new THREE.BoxGeometry(1, 0.2, 1);
  private readonly discMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly rectFillMats = new Map<Input3DAreaDragKind, THREE.MeshBasicMaterial>();
  private readonly disc: THREE.Mesh;
  private readonly rectFill: THREE.Mesh;
  private readonly lineBatch: GroundLineBatch3D;
  private readonly outlineWidthPx: number;
  private rectPoints = new Float32Array(12);
  private linePoints = new Float32Array(6);

  constructor(parentWorld: THREE.Group, overlayLines: OverlayLineSystem) {
    this.disc = new THREE.Mesh(this.discGeom);
    this.rectFill = new THREE.Mesh(this.rectFillGeom);
    this.disc.rotation.x = -Math.PI / 2;
    // Fills sit just under the outline batch so the outline reads on top.
    this.disc.renderOrder = 15;
    this.rectFill.renderOrder = 15;
    this.outlineWidthPx = overlayLines.style('drag').widthPx;
    this.lineBatch = overlayLines.createBatch('drag', 8);
    this.root.visible = false;
    this.root.add(this.disc, this.rectFill, this.lineBatch.mesh);
    parentWorld.add(this.root);
  }

  update(state: Input3DAreaDragState): void {
    this.lineBatch.begin();
    if (!state.active || state.radius <= 0) {
      this.root.visible = false;
      this.lineBatch.finishFrame();
      return;
    }
    this.root.visible = true;
    if (state.kind === 'buildLine') {
      this.updateBuildLine(state);
    } else if (state.kind === 'buildBorder') {
      this.updateBuildRectangle(state, false);
    } else if (state.kind === 'buildGrid') {
      this.updateBuildRectangle(state, true);
    } else {
      this.rectFill.visible = false;
      this.disc.visible = true;
      this.disc.material = this.getDiscMat(state.kind, state.ballisticReach);
      const y = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
      this.disc.position.set(state.x, y, state.y);
      this.disc.scale.setScalar(state.radius);
      const c = hexToRgb01(colorForState(state.kind, state.ballisticReach));
      this.lineBatch.pushRing(
        state.x, y, state.y, state.radius, OUTLINE_SEGMENTS,
        c.r, c.g, c.b, OUTLINE_OPACITY, this.outlineWidthPx, 0,
      );
    }
    this.lineBatch.finishFrame();
  }

  destroy(): void {
    this.root.parent?.remove(this.root);
    this.discGeom.dispose();
    this.rectFillGeom.dispose();
    this.lineBatch.dispose();
    for (const mat of this.discMats.values()) mat.dispose();
    for (const mat of this.rectFillMats.values()) mat.dispose();
    this.discMats.clear();
    this.rectFillMats.clear();
  }

  private updateBuildLine(state: Input3DAreaDragState): void {
    this.disc.visible = false;
    this.rectFill.visible = false;

    const endX = state.endX ?? state.x;
    const endY = state.endY ?? state.y;
    const startZ = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
    const endZ = state.endZ !== undefined ? state.endZ + RING_LIFT : startZ;
    const dx = endX - state.x;
    const dz = endY - state.y;
    if (Math.hypot(dx, dz) < 1e-3) return;

    const lp = this.linePoints;
    lp[0] = state.x; lp[1] = startZ; lp[2] = state.y;
    lp[3] = endX; lp[4] = endZ; lp[5] = endY;
    const c = hexToRgb01(AREA_COLORS[state.kind]);
    this.lineBatch.pushPolyline(lp, 2, c.r, c.g, c.b, OUTLINE_OPACITY, this.outlineWidthPx, false);
  }

  private updateBuildRectangle(state: Input3DAreaDragState, filled: boolean): void {
    this.disc.visible = false;

    const endX = state.endX ?? state.x;
    const endY = state.endY ?? state.y;
    const minX = Math.min(state.x, endX);
    const maxX = Math.max(state.x, endX);
    const minY = Math.min(state.y, endY);
    const maxY = Math.max(state.y, endY);
    const startZ = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
    const endZ = state.endZ !== undefined ? state.endZ + RING_LIFT : startZ;
    const y = (startZ + endZ) / 2;
    const width = maxX - minX;
    const depth = maxY - minY;
    if (width < 1e-3 || depth < 1e-3) {
      this.rectFill.visible = false;
      return;
    }

    this.rectFill.visible = filled;
    if (filled) {
      this.rectFill.material = this.getRectFillMat(state.kind);
      this.rectFill.position.set((minX + maxX) / 2, y - 0.05, (minY + maxY) / 2);
      this.rectFill.scale.set(width, 1, depth);
    }

    const rp = this.rectPoints;
    rp[0] = minX; rp[1] = y; rp[2] = minY;
    rp[3] = maxX; rp[4] = y; rp[5] = minY;
    rp[6] = maxX; rp[7] = y; rp[8] = maxY;
    rp[9] = minX; rp[10] = y; rp[11] = maxY;
    const c = hexToRgb01(AREA_COLORS[state.kind]);
    this.lineBatch.pushPolyline(rp, 4, c.r, c.g, c.b, OUTLINE_OPACITY, this.outlineWidthPx, true);
  }

  private getDiscMat(
    kind: Input3DAreaDragKind,
    ballisticReach: Input3DAreaDragState['ballisticReach'] = null,
  ): THREE.MeshBasicMaterial {
    const key = materialKey(kind, ballisticReach);
    const cached = this.discMats.get(key);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: colorForState(kind, ballisticReach),
      transparent: true,
      opacity: ballisticReach === 'blocked' ? 0.22 : 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.discMats.set(key, mat);
    return mat;
  }

  private getRectFillMat(kind: Input3DAreaDragKind): THREE.MeshBasicMaterial {
    const cached = this.rectFillMats.get(kind);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: AREA_COLORS[kind],
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    });
    this.rectFillMats.set(kind, mat);
    return mat;
  }
}

function materialKey(
  kind: Input3DAreaDragKind,
  ballisticReach: Input3DAreaDragState['ballisticReach'],
): Input3DAreaDragKind | `${Input3DAreaDragKind}:blocked` {
  return ballisticReach === 'blocked' ? `${kind}:blocked` : kind;
}

function colorForState(
  kind: Input3DAreaDragKind,
  ballisticReach: Input3DAreaDragState['ballisticReach'],
): number {
  return ballisticReach === 'blocked' ? BALLISTIC_BLOCKED_COLOR : AREA_COLORS[kind];
}
