import * as THREE from 'three';
import type { Entity } from '../sim/types';
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
import {
  setEulerIfChanged,
  setObjectVisibleIfChanged,
} from './threeTransformWriteUtils';
import type { ClientRenderTurretHostRows } from './ClientRenderTurretStateSlab';
import {
  growFloat32Array,
  writePositionQuaternion,
} from './typedArrayRenderUtils';

export class ShieldPanelPose3D {
  private readonly aimBatch = new UnitTurretAimBatch3D();
  private aimInput = new Float32Array(TURRET_AIM_INPUT_STRIDE * 256);
  private aimParentPose = new Float32Array(7 * 256);
  private aimCount = 0;
  private readonly aimEntities: Entity[] = [];
  private readonly aimMirrors: ShieldPanelMesh[] = [];
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
    this.count = 0;
    this.slots.length = 0;
    this.entities.length = 0;
  }

  update(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    turretRows: ClientRenderTurretHostRows | undefined,
    shieldPanelTurretIndex: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    chassisTiltInverse: THREE.Quaternion | undefined,
    legacyRotation?: number,
    legacyPitch?: number,
  ): void {
    if (!mirrors.supportVisible) {
      setObjectVisibleIfChanged(mirrors.root, true);
      mirrors.supportVisible = true;
    }
    mirrors.panelSlotsActive = true;

    const shieldPanelRow = turretRows !== undefined &&
      shieldPanelTurretIndex >= 0 &&
      shieldPanelTurretIndex < turretRows.count
      ? turretRows.start + shieldPanelTurretIndex
      : -1;
    const shieldPanelRot = shieldPanelRow >= 0
      ? turretRows!.views.rotation[shieldPanelRow]
      : legacyRotation ?? entity.transform.rotation;
    const shieldPanelPitch = shieldPanelRow >= 0
      ? turretRows!.views.pitch[shieldPanelRow]
      : legacyPitch ?? 0;
    this.enqueueAim(
      entity,
      mirrors,
      parentPosition,
      parentQuaternion,
      entity.transform.rotation,
      shieldPanelRot,
      shieldPanelPitch,
      chassisTiltInverse,
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
      setEulerIfChanged(
        mirrors.root.rotation,
        0,
        output[outputBase],
        output[outputBase + 1],
        'YZX',
      );

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

      this.enqueuePanels(
        this.aimEntities[i],
        mirrors,
        this.parentPositionScratch,
        this.parentQuaternionScratch,
      );
    }
  }

  private enqueuePanels(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
  ): void {
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
    writePositionQuaternion(input, base, parentPosition, parentQuaternion);
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

  private enqueueAim(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    hostRotation: number,
    aimRotation: number,
    aimPitch: number,
    chassisTiltInverse: THREE.Quaternion | undefined,
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
    writePositionQuaternion(
      this.aimParentPose,
      poseBase,
      parentPosition,
      parentQuaternion,
    );

    this.aimEntities[index] = entity;
    this.aimMirrors[index] = mirrors;
  }

  private ensureInputCapacity(count: number): void {
    const needed = count * SHIELD_PANEL_INPUT_STRIDE;
    if (this.input.length >= needed) return;
    this.input = growFloat32Array(this.input, needed);
  }

  private ensureAimCapacity(count: number): void {
    const needed = count * TURRET_AIM_INPUT_STRIDE;
    if (this.aimInput.length < needed) {
      this.aimInput = growFloat32Array(this.aimInput, needed);
    }

    const poseNeeded = count * 7;
    if (this.aimParentPose.length >= poseNeeded) return;
    this.aimParentPose = growFloat32Array(this.aimParentPose, poseNeeded);
  }
}
