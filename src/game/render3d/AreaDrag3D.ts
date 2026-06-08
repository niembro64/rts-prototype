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
  buildMexArea: ACTION_COLORS.build,
  buildLine: ACTION_COLORS.build,
};

export class AreaDrag3D {
  private readonly root = new THREE.Group();
  private readonly ringGeom = new THREE.RingGeometry(0.975, 1, 96);
  private readonly discGeom = new THREE.CircleGeometry(1, 96);
  private readonly ringMats = new Map<Input3DAreaDragKind, THREE.MeshBasicMaterial>();
  private readonly discMats = new Map<Input3DAreaDragKind, THREE.MeshBasicMaterial>();
  private readonly ring: THREE.Mesh;
  private readonly disc: THREE.Mesh;

  constructor(parentWorld: THREE.Group) {
    this.ring = new THREE.Mesh(this.ringGeom);
    this.disc = new THREE.Mesh(this.discGeom);
    this.ring.rotation.x = -Math.PI / 2;
    this.disc.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 19;
    this.disc.renderOrder = 18;
    this.root.visible = false;
    this.root.add(this.disc, this.ring);
    parentWorld.add(this.root);
  }

  update(state: Input3DAreaDragState): void {
    if (!state.active || state.radius <= 0) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.ring.material = this.getRingMat(state.kind);
    this.disc.material = this.getDiscMat(state.kind);
    const y = state.z !== undefined ? state.z + RING_LIFT : LEGACY_Y;
    this.root.position.set(state.x, y, state.y);
    this.ring.scale.setScalar(state.radius);
    this.disc.scale.setScalar(state.radius);
  }

  destroy(): void {
    this.root.parent?.remove(this.root);
    this.ringGeom.dispose();
    this.discGeom.dispose();
    for (const mat of this.ringMats.values()) mat.dispose();
    for (const mat of this.discMats.values()) mat.dispose();
    this.ringMats.clear();
    this.discMats.clear();
  }

  private getRingMat(kind: Input3DAreaDragKind): THREE.MeshBasicMaterial {
    const cached = this.ringMats.get(kind);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: AREA_COLORS[kind],
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ringMats.set(kind, mat);
    return mat;
  }

  private getDiscMat(kind: Input3DAreaDragKind): THREE.MeshBasicMaterial {
    const cached = this.discMats.get(kind);
    if (cached) return cached;
    const mat = new THREE.MeshBasicMaterial({
      color: AREA_COLORS[kind],
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.discMats.set(kind, mat);
    return mat;
  }
}
