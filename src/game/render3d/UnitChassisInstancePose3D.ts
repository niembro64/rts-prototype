import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { BodyGeomEntry } from './BodyShape3D';
import type { EntityMesh } from './EntityMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export type UnitChassisInstancePose3DUpdate = {
  entity: Entity;
  mesh: EntityMesh;
  bodyEntry: BodyGeomEntry;
  radius: number;
  fullUnitDetail: boolean;
  parentPosition: THREE.Vector3;
  parentQuaternion: THREE.Quaternion;
  unitDetailInstances: UnitDetailInstanceRenderer3D;
};

export class UnitChassisInstancePose3D {
  private readonly parentMat = new THREE.Matrix4();
  private readonly partMat = new THREE.Matrix4();
  private readonly finalMat = new THREE.Matrix4();
  private readonly parentScale = new THREE.Vector3();
  private readonly partLocalPos = new THREE.Vector3();
  private readonly partScale = new THREE.Vector3();
  private readonly identityQuat = new THREE.Quaternion();

  update(options: UnitChassisInstancePose3DUpdate): void {
    const {
      entity,
      mesh,
      bodyEntry,
      radius,
      fullUnitDetail,
      parentPosition,
      parentQuaternion,
      unitDetailInstances,
    } = options;

    if (!fullUnitDetail || mesh.hideChassis) {
      unitDetailInstances.hideChassisSlots(mesh);
      return;
    }

    if (mesh.smoothChassisSlots) {
      this.composeParent(parentPosition, parentQuaternion, radius);
      const writeColor = unitDetailInstances.prepareSmoothChassisColor(entity);
      const slotCount = Math.min(bodyEntry.parts.length, mesh.smoothChassisSlots.length);
      for (let partIdx = 0; partIdx < slotCount; partIdx++) {
        const part = bodyEntry.parts[partIdx];
        const slot = mesh.smoothChassisSlots[partIdx];
        this.composePart(part.x, part.y, part.z, part.scaleX, part.scaleY, part.scaleZ);
        this.finalMat.multiplyMatrices(this.parentMat, this.partMat);
        unitDetailInstances.writeSmoothChassisMatrix(
          slot,
          this.finalMat,
          entity,
          writeColor,
        );
      }
      return;
    }

    if (mesh.polyChassisSlot === undefined) return;
    const part = bodyEntry.parts[0];
    if (!part) return;
    this.composeParent(parentPosition, parentQuaternion, radius);
    this.composePart(part.x, part.y, part.z, part.scaleX, part.scaleY, part.scaleZ);
    this.finalMat.multiplyMatrices(this.parentMat, this.partMat);
    unitDetailInstances.writePolyChassisMatrix(
      entity,
      mesh.bodyShapeKey,
      mesh.polyChassisSlot,
      this.finalMat,
    );
  }

  private composeParent(
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    radius: number,
  ): void {
    this.parentScale.set(radius, radius, radius);
    this.parentMat.compose(parentPosition, parentQuaternion, this.parentScale);
  }

  private composePart(
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): void {
    this.partLocalPos.set(x, y, z);
    this.partScale.set(scaleX, scaleY, scaleZ);
    this.partMat.compose(
      this.partLocalPos,
      this.identityQuat,
      this.partScale,
    );
  }
}
