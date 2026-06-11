import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import {
  SHIELD_PANEL_INPUT_STRIDE,
  ShieldPanelMatrixBatch3D,
} from './ShieldPanelMatrixBatch3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  TURRET_AIM_MODE_POSE,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export type ShieldPanelEmissionPose3D = {
  rotation: number;
  pitch: number;
};

export class ShieldPanelPose3D {
  private readonly aimBatch = new UnitTurretAimBatch3D();
  private aimInput = new Float32Array(TURRET_AIM_INPUT_STRIDE * 256);
  private aimParentPose = new Float32Array(7 * 256);
  private aimCount = 0;
  private readonly aimEntities: Entity[] = [];
  private readonly aimMirrors: ShieldPanelMesh[] = [];
  private readonly aimRecordIsPanelEmission: boolean[] = [];
  private readonly parentPositionScratch = new THREE.Vector3();
  private readonly parentQuaternionScratch = new THREE.Quaternion();

  private readonly batch = new ShieldPanelMatrixBatch3D();
  private input = new Float32Array(SHIELD_PANEL_INPUT_STRIDE * 256);
  private count = 0;
  private readonly slots: number[] = [];
  private readonly entities: Entity[] = [];

  begin(): void {
    this.aimCount = 0;
    this.aimEntities.length = 0;
    this.aimMirrors.length = 0;
    this.aimRecordIsPanelEmission.length = 0;
    this.count = 0;
    this.slots.length = 0;
    this.entities.length = 0;
  }

  update(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    shieldPanelTurret: Turret | undefined,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    chassisTiltInverse: THREE.Quaternion | undefined,
    supportVisible: boolean,
    panelEmissionVisible: boolean,
    panelEmissionPose?: ShieldPanelEmissionPose3D,
  ): void {
    if (mirrors.supportVisible !== supportVisible) {
      mirrors.root.visible = supportVisible;
      mirrors.supportVisible = supportVisible;
    }
    this.setPanelMeshesVisible(mirrors, panelEmissionVisible);
    if (!supportVisible) return;

    const shieldPanelRot = shieldPanelTurret?.rotation ?? entity.transform.rotation;
    const shieldPanelPitch = shieldPanelTurret?.pitch ?? 0;
    this.enqueueAim(
      entity,
      mirrors,
      parentPosition,
      parentQuaternion,
      entity.transform.rotation,
      shieldPanelRot,
      shieldPanelPitch,
      chassisTiltInverse,
      false,
    );
    if (!panelEmissionVisible) return;

    this.enqueueAim(
      entity,
      mirrors,
      parentPosition,
      parentQuaternion,
      entity.transform.rotation,
      panelEmissionPose?.rotation ?? shieldPanelRot,
      panelEmissionPose?.pitch ?? shieldPanelPitch,
      chassisTiltInverse,
      true,
    );
  }

  flush(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    this.flushAimRecords();
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

  private flushAimRecords(): void {
    const count = this.aimCount;
    if (count <= 0) return;

    const input = this.aimBatch.begin(count);
    input.set(this.aimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
    const output = this.aimBatch.compute(count);
    const outputStride = this.aimBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const mirrors = this.aimMirrors[i];
      const outputBase = i * outputStride;
      const isPanelEmission = this.aimRecordIsPanelEmission[i];
      const root = isPanelEmission ? mirrors.panelRoot : mirrors.root;
      root.rotation.set(0, output[outputBase], output[outputBase + 1], 'YZX');

      const poseBase = i * 7;
      this.parentPositionScratch.set(
        this.aimParentPose[poseBase],
        this.aimParentPose[poseBase + 1],
        this.aimParentPose[poseBase + 2],
      );
      this.parentQuaternionScratch.set(
        this.aimParentPose[poseBase + 3],
        this.aimParentPose[poseBase + 4],
        this.aimParentPose[poseBase + 5],
        this.aimParentPose[poseBase + 6],
      );

      if (isPanelEmission) {
        this.enqueuePanels(
          this.aimEntities[i],
          mirrors,
          this.parentPositionScratch,
          this.parentQuaternionScratch,
          mirrors.panelRoot.position,
          mirrors.panelRoot.quaternion,
        );
      }
    }
  }

  private enqueuePanels(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    rootPosition: THREE.Vector3,
    rootQuaternion: THREE.Quaternion,
  ): void {
    if (!mirrors.panelSlots) return;
    mirrors.panelSlotsActive = true;

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
        rootPosition,
        rootQuaternion,
        mirrors.panels[panelIdx],
      );
    }
  }

  private enqueuePanel(
    entity: Entity,
    slot: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    rootPosition: THREE.Vector3,
    rootQuaternion: THREE.Quaternion,
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
    input[base + 7] = rootPosition.x;
    input[base + 8] = rootPosition.y;
    input[base + 9] = rootPosition.z;
    input[base + 10] = rootQuaternion.x;
    input[base + 11] = rootQuaternion.y;
    input[base + 12] = rootQuaternion.z;
    input[base + 13] = rootQuaternion.w;
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

  private enqueueAim(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    hostRotation: number,
    aimRotation: number,
    aimPitch: number,
    chassisTiltInverse: THREE.Quaternion | undefined,
    isPanelEmission: boolean,
  ): void {
    const index = this.aimCount;
    this.aimCount++;
    this.ensureAimCapacity(this.aimCount);

    const base = index * TURRET_AIM_INPUT_STRIDE;
    const input = this.aimInput;
    input[base] = hostRotation;
    input[base + 1] = TURRET_AIM_MODE_POSE;
    input[base + 2] = aimRotation;
    input[base + 3] = aimPitch;
    input[base + 4] = 0;
    input[base + 5] = 0;
    input[base + 6] = 0;
    input[base + 7] = chassisTiltInverse?.x ?? 0;
    input[base + 8] = chassisTiltInverse?.y ?? 0;
    input[base + 9] = chassisTiltInverse?.z ?? 0;
    input[base + 10] = chassisTiltInverse?.w ?? 1;
    input[base + 11] = chassisTiltInverse ? 1 : 0;

    const poseBase = index * 7;
    const parentPose = this.aimParentPose;
    parentPose[poseBase] = parentPosition.x;
    parentPose[poseBase + 1] = parentPosition.y;
    parentPose[poseBase + 2] = parentPosition.z;
    parentPose[poseBase + 3] = parentQuaternion.x;
    parentPose[poseBase + 4] = parentQuaternion.y;
    parentPose[poseBase + 5] = parentQuaternion.z;
    parentPose[poseBase + 6] = parentQuaternion.w;

    this.aimEntities[index] = entity;
    this.aimMirrors[index] = mirrors;
    this.aimRecordIsPanelEmission[index] = isPanelEmission;
  }

  private setPanelMeshesVisible(mirrors: ShieldPanelMesh, visible: boolean): void {
    if (mirrors.panelRoot.visible !== visible) mirrors.panelRoot.visible = visible;
    if (mirrors.panelMeshesVisible === visible) return;
    for (const panel of mirrors.panels) panel.visible = visible;
    mirrors.panelMeshesVisible = visible;
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

  private ensureAimCapacity(count: number): void {
    const needed = count * TURRET_AIM_INPUT_STRIDE;
    if (this.aimInput.length < needed) {
      let next = this.aimInput.length;
      while (next < needed) next *= 2;
      const expanded = new Float32Array(next);
      expanded.set(this.aimInput);
      this.aimInput = expanded;
    }

    const poseNeeded = count * 7;
    if (this.aimParentPose.length >= poseNeeded) return;
    let nextPose = this.aimParentPose.length;
    while (nextPose < poseNeeded) nextPose *= 2;
    const expandedPose = new Float32Array(nextPose);
    expandedPose.set(this.aimParentPose);
    this.aimParentPose = expandedPose;
  }
}
