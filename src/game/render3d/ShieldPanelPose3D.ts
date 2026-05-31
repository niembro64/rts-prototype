import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export class ShieldPanelPose3D {
  private readonly aimDir = new THREE.Vector3();
  private readonly parentMat = new THREE.Matrix4();
  private readonly stepMat = new THREE.Matrix4();
  private readonly finalMat = new THREE.Matrix4();
  private readonly oneVec = new THREE.Vector3(1, 1, 1);

  update(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    shieldPanelTurret: Turret | undefined,
    pivotLocal: THREE.Vector3,
    unitChainMat: THREE.Matrix4,
    chassisTiltInverse: THREE.Quaternion | undefined,
    turretShieldPanelsEnabled: boolean,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
  ): void {
    mirrors.root.position.copy(pivotLocal);
    mirrors.root.visible = turretShieldPanelsEnabled;
    if (!turretShieldPanelsEnabled) return;

    const shieldPanelRot = shieldPanelTurret?.rotation ?? entity.transform.rotation;
    const shieldPanelPitch = shieldPanelTurret?.pitch ?? 0;
    const cosShieldPanelRot = Math.cos(shieldPanelRot);
    const sinShieldPanelRot = Math.sin(shieldPanelRot);
    const cosShieldPanelPitch = Math.cos(shieldPanelPitch);
    const sinShieldPanelPitch = Math.sin(shieldPanelPitch);

    this.aimDir.set(
      cosShieldPanelRot * cosShieldPanelPitch,
      sinShieldPanelPitch,
      sinShieldPanelRot * cosShieldPanelPitch,
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
      unitDetailInstances.writeShieldPanelMatrix(slot, this.finalMat, entity);
    }
  }
}
