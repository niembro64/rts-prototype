import * as THREE from 'three';
import { WAYPOINT_GROUND_LIFT } from '../../config';
import { ACTION_COLORS } from '../uiLabels';
import type { Input3DAreaDragKind, Input3DAreaDragState } from './Input3DAreaDragState';

const RING_LIFT = WAYPOINT_GROUND_LIFT + 1;
const LEGACY_Y = RING_LIFT;

const AREA_COLORS: Record<Input3DAreaDragKind, number> = {
  repairArea: ACTION_COLORS.repair,
  reclaimArea: ACTION_COLORS.reclaim,
  attackArea: ACTION_COLORS.attack,
  attackGround: ACTION_COLORS.attackGround,
  buildMexArea: ACTION_COLORS.build,
  upgradeMexArea: ACTION_COLORS.build,
  buildLine: ACTION_COLORS.build,
  buildBorder: ACTION_COLORS.build,
  buildGrid: ACTION_COLORS.build,
};
const BALLISTIC_BLOCKED_COLOR = 0xff3434;

export class AreaDrag3D {
  private static readonly _UNIT_X = new THREE.Vector3(1, 0, 0);
  private static readonly _scratchDir = new THREE.Vector3();
  private static readonly _scratchQuat = new THREE.Quaternion();

  private readonly root = new THREE.Group();
  private readonly ringGeom = new THREE.RingGeometry(0.975, 1, 96);
  private readonly discGeom = new THREE.CircleGeometry(1, 96);
  private readonly lineGeom = new THREE.BoxGeometry(1, 0.5, 1);
  private readonly rectFillGeom = new THREE.BoxGeometry(1, 0.2, 1);
  private readonly borderGeom = new THREE.BufferGeometry();
  private readonly ringMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly discMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly borderMats = new Map<Input3DAreaDragKind, THREE.LineBasicMaterial>();
  private readonly rectFillMats = new Map<Input3DAreaDragKind, THREE.MeshBasicMaterial>();
  private readonly ring: THREE.Mesh;
  private readonly disc: THREE.Mesh;
  private readonly line: THREE.Mesh;
  private readonly rectFill: THREE.Mesh;
  private readonly border: THREE.LineSegments;

  constructor(parentWorld: THREE.Group) {
    this.ring = new THREE.Mesh(this.ringGeom);
    this.disc = new THREE.Mesh(this.discGeom);
    this.line = new THREE.Mesh(this.lineGeom);
    this.rectFill = new THREE.Mesh(this.rectFillGeom);
    this.border = new THREE.LineSegments(this.borderGeom);
    this.ring.rotation.x = -Math.PI / 2;
    this.disc.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 19;
    this.disc.renderOrder = 18;
    this.line.renderOrder = 19;
    this.rectFill.renderOrder = 18;
    this.border.renderOrder = 19;
    this.root.visible = false;
    this.root.add(this.disc, this.ring, this.line, this.rectFill, this.border);
    parentWorld.add(this.root);
  }

  update(state: Input3DAreaDragState): void {
    if (!state.active || state.radius <= 0) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    if (state.kind === 'buildLine') {
      this.updateBuildLine(state);
      return;
    }
    if (state.kind === 'buildBorder') {
      this.updateBuildRectangle(state, false);
      return;
    }
    if (state.kind === 'buildGrid') {
      this.updateBuildRectangle(state, true);
      return;
    }
    this.line.visible = false;
    this.rectFill.visible = false;
    this.border.visible = false;
    this.ring.visible = true;
    this.disc.visible = true;
    this.ring.material = this.getRingMat(state.kind, state.ballisticReach);
    this.disc.material = this.getDiscMat(state.kind, state.ballisticReach);
    const y = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
    this.root.position.set(state.x, y, state.y);
    this.ring.scale.setScalar(state.radius);
    this.disc.scale.setScalar(state.radius);
  }

  destroy(): void {
    this.root.parent?.remove(this.root);
    this.ringGeom.dispose();
    this.discGeom.dispose();
    this.lineGeom.dispose();
    this.rectFillGeom.dispose();
    this.borderGeom.dispose();
    for (const mat of this.ringMats.values()) mat.dispose();
    for (const mat of this.discMats.values()) mat.dispose();
    for (const mat of this.borderMats.values()) mat.dispose();
    for (const mat of this.rectFillMats.values()) mat.dispose();
    this.ringMats.clear();
    this.discMats.clear();
    this.borderMats.clear();
    this.rectFillMats.clear();
  }

  private updateBuildLine(state: Input3DAreaDragState): void {
    this.ring.visible = false;
    this.disc.visible = false;
    this.rectFill.visible = false;
    this.border.visible = false;
    this.line.visible = true;
    this.line.material = this.getRingMat(state.kind);
    this.root.position.set(0, 0, 0);

    const endX = state.endX ?? state.x;
    const endY = state.endY ?? state.y;
    const startZ = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
    const endZ = state.endZ !== undefined ? state.endZ + RING_LIFT : startZ;
    const dx = endX - state.x;
    const dy = endZ - startZ;
    const dz = endY - state.y;
    const length3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length3D < 1e-3) {
      this.line.visible = false;
      return;
    }
    const dirVec = AreaDrag3D._scratchDir;
    const quat = AreaDrag3D._scratchQuat;
    dirVec.set(dx / length3D, dy / length3D, dz / length3D);
    quat.setFromUnitVectors(AreaDrag3D._UNIT_X, dirVec);
    this.line.quaternion.copy(quat);
    this.line.position.set(
      (state.x + endX) / 2,
      (startZ + endZ) / 2,
      (state.y + endY) / 2,
    );
    this.line.scale.set(length3D, 1, 4);
  }

  private updateBuildRectangle(state: Input3DAreaDragState, filled: boolean): void {
    this.ring.visible = false;
    this.disc.visible = false;
    this.line.visible = false;
    this.border.visible = true;
    this.border.material = this.getBorderMat(state.kind);
    this.root.position.set(0, 0, 0);

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
      this.border.visible = false;
      this.rectFill.visible = false;
      return;
    }

    this.rectFill.visible = filled;
    if (filled) {
      this.rectFill.material = this.getRectFillMat(state.kind);
      this.rectFill.position.set((minX + maxX) / 2, y - 0.05, (minY + maxY) / 2);
      this.rectFill.scale.set(width, 1, depth);
    }

    const positions = new Float32Array([
      minX, y, minY, maxX, y, minY,
      maxX, y, minY, maxX, y, maxY,
      maxX, y, maxY, minX, y, maxY,
      minX, y, maxY, minX, y, minY,
    ]);
    this.borderGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.borderGeom.computeBoundingSphere();
  }

  private getRingMat(
    kind: Input3DAreaDragKind,
    ballisticReach: Input3DAreaDragState['ballisticReach'] = null,
  ): THREE.MeshBasicMaterial {
    const key = materialKey(kind, ballisticReach);
    const cached = this.ringMats.get(key);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: colorForState(kind, ballisticReach),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ringMats.set(key, mat);
    return mat;
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

  private getBorderMat(kind: Input3DAreaDragKind): THREE.LineBasicMaterial {
    const cached = this.borderMats.get(kind);
    if (cached) return cached;
    const mat = new THREE.LineBasicMaterial({
      color: AREA_COLORS[kind],
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    this.borderMats.set(kind, mat);
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
