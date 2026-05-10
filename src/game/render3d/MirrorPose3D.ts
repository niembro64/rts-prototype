import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import type { MirrorMesh } from './MirrorMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export type MirrorPose3DUpdate = {
  entity: Entity;
  mirrors: MirrorMesh;
  turrets: readonly Turret[];
  bodyCenterLocal: THREE.Vector3;
  unitChainMat: THREE.Matrix4;
  chassisTiltInverse?: THREE.Quaternion;
  mirrorsEnabled: boolean;
  unitDetailInstances: UnitDetailInstanceRenderer3D;
};

export class MirrorPose3D {
  private readonly aimDir = new THREE.Vector3();
  private readonly parentMat = new THREE.Matrix4();
  private readonly stepMat = new THREE.Matrix4();
  private readonly finalMat = new THREE.Matrix4();
  private readonly oneVec = new THREE.Vector3(1, 1, 1);

  update(options: MirrorPose3DUpdate): void {
    const {
      entity,
      mirrors,
      turrets,
      bodyCenterLocal,
      unitChainMat,
      chassisTiltInverse,
      mirrorsEnabled,
      unitDetailInstances,
    } = options;

    mirrors.root.position.copy(bodyCenterLocal);
    mirrors.root.visible = mirrorsEnabled;
    if (!mirrorsEnabled) return;

    const mirrorRot = turrets[0]?.rotation ?? entity.transform.rotation;
    const mirrorPitch = turrets[0]?.pitch ?? 0;
    const cosMirrorRot = Math.cos(mirrorRot);
    const sinMirrorRot = Math.sin(mirrorRot);
    const cosMirrorPitch = Math.cos(mirrorPitch);
    const sinMirrorPitch = Math.sin(mirrorPitch);

    this.aimDir.set(
      cosMirrorRot * cosMirrorPitch,
      sinMirrorPitch,
      sinMirrorRot * cosMirrorPitch,
    );
    if (chassisTiltInverse) this.aimDir.applyQuaternion(chassisTiltInverse);

    const combinedYaw = Math.atan2(-this.aimDir.z, this.aimDir.x);
    const ny = this.aimDir.y;
    const localPitch = Math.asin(ny < -1 ? -1 : ny > 1 ? 1 : ny);
    mirrors.root.rotation.set(
      0,
      combinedYaw + entity.transform.rotation,
      localPitch,
      'YZX',
    );

    if (!mirrors.panelSlots) return;

    this.parentMat.copy(unitChainMat);
    this.stepMat.compose(
      mirrors.root.position,
      mirrors.root.quaternion,
      this.oneVec,
    );
    this.parentMat.multiply(this.stepMat);

    const slotCount = Math.min(
      mirrors.panels.length,
      mirrors.panelSlots.length,
    );
    for (let panelIdx = 0; panelIdx < slotCount; panelIdx++) {
      const panel = mirrors.panels[panelIdx];
      const slot = mirrors.panelSlots[panelIdx];
      this.stepMat.compose(
        panel.position,
        panel.quaternion,
        panel.scale,
      );
      this.finalMat.multiplyMatrices(this.parentMat, this.stepMat);
      unitDetailInstances.writeMirrorPanelMatrix(slot, this.finalMat, entity);
    }
  }
}
