import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import {
  SHIELD_PANEL_INPUT_STRIDE,
  ShieldPanelMatrixBatch3D,
} from './ShieldPanelMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export class ShieldPanelPose3D {
  private readonly aimDir = new THREE.Vector3();
  private readonly batch = new ShieldPanelMatrixBatch3D();
  private input = new Float32Array(SHIELD_PANEL_INPUT_STRIDE * 256);
  private count = 0;
  private readonly slots: number[] = [];
  private readonly entities: Entity[] = [];

  begin(): void {
    this.count = 0;
    this.slots.length = 0;
    this.entities.length = 0;
  }

  update(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    shieldPanelTurret: Turret | undefined,
    pivotLocal: THREE.Vector3,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    chassisTiltInverse: THREE.Quaternion | undefined,
    turretShieldPanelsEnabled: boolean,
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

    const slotCount = Math.min(
      mirrors.panels.length,
      mirrors.panelSlots.length,
    );
    for (let panelIdx = 0; panelIdx < slotCount; panelIdx++) {
      this.enqueuePanel(
        entity,
        mirrors.panelSlots[panelIdx],
        parentPosition,
        parentQuaternion,
        mirrors.root,
        mirrors.panels[panelIdx],
      );
    }
  }

  flush(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    const count = this.count;
    if (count <= 0) return;

    const input = this.batch.begin(count);
    input.set(this.input.subarray(0, count * SHIELD_PANEL_INPUT_STRIDE));
    const output = this.batch.compute(count);
    const outputStride = this.batch.outputStride;

    for (let i = 0; i < count; i++) {
      unitDetailInstances.writeShieldPanelMatrixArray(
        this.slots[i],
        output,
        i * outputStride,
        this.entities[i],
      );
    }
  }

  private enqueuePanel(
    entity: Entity,
    slot: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    root: THREE.Group,
    panel: THREE.Mesh,
  ): void {
    const index = this.count;
    this.count++;
    this.ensureInputCapacity(this.count);

    const base = index * SHIELD_PANEL_INPUT_STRIDE;
    const input = this.input;
    input[base] = parentPosition.x;
    input[base + 1] = parentPosition.y;
    input[base + 2] = parentPosition.z;
    input[base + 3] = parentQuaternion.x;
    input[base + 4] = parentQuaternion.y;
    input[base + 5] = parentQuaternion.z;
    input[base + 6] = parentQuaternion.w;
    input[base + 7] = root.position.x;
    input[base + 8] = root.position.y;
    input[base + 9] = root.position.z;
    input[base + 10] = root.quaternion.x;
    input[base + 11] = root.quaternion.y;
    input[base + 12] = root.quaternion.z;
    input[base + 13] = root.quaternion.w;
    input[base + 14] = panel.position.x;
    input[base + 15] = panel.position.y;
    input[base + 16] = panel.position.z;
    input[base + 17] = panel.quaternion.x;
    input[base + 18] = panel.quaternion.y;
    input[base + 19] = panel.quaternion.z;
    input[base + 20] = panel.quaternion.w;
    input[base + 21] = panel.scale.x;
    input[base + 22] = panel.scale.y;
    input[base + 23] = panel.scale.z;

    this.slots[index] = slot;
    this.entities[index] = entity;
  }

  private ensureInputCapacity(count: number): void {
    const needed = count * SHIELD_PANEL_INPUT_STRIDE;
    if (this.input.length >= needed) return;
    let next = this.input.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.input);
    this.input = expanded;
  }
}
