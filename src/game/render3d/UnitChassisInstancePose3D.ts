import type * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { BodyGeomEntry, BodyMeshPart } from './BodyShape3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  CHASSIS_PART_INPUT_STRIDE,
  UnitChassisMatrixBatch3D,
} from './UnitChassisMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

const WRITE_SMOOTH = 0;
const WRITE_POLY = 1;

export class UnitChassisInstancePose3D {
  private readonly batch = new UnitChassisMatrixBatch3D();
  private input = new Float32Array(CHASSIS_PART_INPUT_STRIDE * 1024);
  private count = 0;
  private readonly kinds: number[] = [];
  private readonly slots: number[] = [];
  private readonly entities: Entity[] = [];
  private readonly bodyShapeKeys: string[] = [];
  private readonly writeColors: boolean[] = [];

  begin(): void {
    this.count = 0;
    this.kinds.length = 0;
    this.slots.length = 0;
    this.entities.length = 0;
    this.bodyShapeKeys.length = 0;
    this.writeColors.length = 0;
  }

  update(
    entity: Entity,
    mesh: EntityMesh,
    bodyEntry: BodyGeomEntry,
    radius: number,
    fullUnitDetail: boolean,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
  ): void {
    if (!fullUnitDetail) {
      unitDetailInstances.clearChassisSlots(mesh);
      return;
    }

    if (mesh.smoothChassisSlots) {
      const writeColor = unitDetailInstances.prepareSmoothChassisColor(entity);
      const slotCount = Math.min(bodyEntry.parts.length, mesh.smoothChassisSlots.length);
      for (let partIdx = 0; partIdx < slotCount; partIdx++) {
        this.enqueuePart(
          WRITE_SMOOTH,
          mesh.smoothChassisSlots[partIdx],
          entity,
          '',
          writeColor,
          parentPosition,
          parentQuaternion,
          radius,
          bodyEntry.parts[partIdx],
        );
      }
      return;
    }

    if (mesh.polyChassisSlot === undefined) return;
    const part = bodyEntry.parts[0];
    if (!part) return;
    this.enqueuePart(
      WRITE_POLY,
      mesh.polyChassisSlot,
      entity,
      mesh.bodyShapeKey,
      false,
      parentPosition,
      parentQuaternion,
      radius,
      part,
    );
  }

  flush(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    const count = this.count;
    if (count <= 0) return;

    const input = this.batch.begin(count);
    input.set(this.input.subarray(0, count * CHASSIS_PART_INPUT_STRIDE));
    const output = this.batch.compute(count);
    const outputStride = this.batch.outputStride;

    for (let i = 0; i < count; i++) {
      const offset = i * outputStride;
      if (this.kinds[i] === WRITE_SMOOTH) {
        unitDetailInstances.writeSmoothChassisMatrixArray(
          this.slots[i],
          output,
          offset,
          this.entities[i],
          this.writeColors[i],
        );
      } else {
        unitDetailInstances.writePolyChassisMatrixArray(
          this.entities[i],
          this.bodyShapeKeys[i],
          this.slots[i],
          output,
          offset,
        );
      }
    }
  }

  private enqueuePart(
    kind: number,
    slot: number,
    entity: Entity,
    bodyShapeKey: string,
    writeColor: boolean,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    radius: number,
    part: BodyMeshPart,
  ): void {
    const index = this.count;
    this.count++;
    this.ensureInputCapacity(this.count);

    const base = index * CHASSIS_PART_INPUT_STRIDE;
    const input = this.input;
    input[base] = parentPosition.x;
    input[base + 1] = parentPosition.y;
    input[base + 2] = parentPosition.z;
    input[base + 3] = parentQuaternion.x;
    input[base + 4] = parentQuaternion.y;
    input[base + 5] = parentQuaternion.z;
    input[base + 6] = parentQuaternion.w;
    input[base + 7] = radius;
    input[base + 8] = part.x;
    input[base + 9] = part.y;
    input[base + 10] = part.z;
    input[base + 11] = part.scaleX;
    input[base + 12] = part.scaleY;
    input[base + 13] = part.scaleZ;
    input[base + 14] = part.rotZ ?? 0;

    this.kinds[index] = kind;
    this.slots[index] = slot;
    this.entities[index] = entity;
    this.bodyShapeKeys[index] = bodyShapeKey;
    this.writeColors[index] = writeColor;
  }

  private ensureInputCapacity(count: number): void {
    const needed = count * CHASSIS_PART_INPUT_STRIDE;
    if (this.input.length >= needed) return;
    let next = this.input.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.input);
    this.input = expanded;
  }
}
