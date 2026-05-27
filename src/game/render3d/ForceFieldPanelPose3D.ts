import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import type { ForceFieldPanelMesh } from './ForceFieldPanelMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export class ForceFieldPanelPose3D {
  private readonly aimDir = new THREE.Vector3();
  private readonly parentMat = new THREE.Matrix4();
  private readonly stepMat = new THREE.Matrix4();
  private readonly finalMat = new THREE.Matrix4();
  private readonly oneVec = new THREE.Vector3(1, 1, 1);

  update(
    entity: Entity,
    mirrors: ForceFieldPanelMesh,
    forceFieldPanelTurret: Turret | undefined,
    pivotLocal: THREE.Vector3,
    unitChainMat: THREE.Matrix4,
    chassisTiltInverse: THREE.Quaternion | undefined,
    turretForceFieldPanelsEnabled: boolean,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
  ): void {
    mirrors.root.position.copy(pivotLocal);
    mirrors.root.visible = turretForceFieldPanelsEnabled;
    if (!turretForceFieldPanelsEnabled) return;

    const forceFieldPanelRot = forceFieldPanelTurret?.rotation ?? entity.transform.rotation;
    const forceFieldPanelPitch = forceFieldPanelTurret?.pitch ?? 0;
    const cosForceFieldPanelRot = Math.cos(forceFieldPanelRot);
    const sinForceFieldPanelRot = Math.sin(forceFieldPanelRot);
    const cosForceFieldPanelPitch = Math.cos(forceFieldPanelPitch);
    const sinForceFieldPanelPitch = Math.sin(forceFieldPanelPitch);

    this.aimDir.set(
      cosForceFieldPanelRot * cosForceFieldPanelPitch,
      sinForceFieldPanelPitch,
      sinForceFieldPanelRot * cosForceFieldPanelPitch,
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
      unitDetailInstances.writeForceFieldPanelMatrix(slot, this.finalMat, entity);
    }
  }
}
