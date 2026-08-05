import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { BodyGeomEntry, BodyMeshPart } from './BodyShape3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  CHASSIS_PART_INPUT_STRIDE,
  UnitChassisMatrixBatch3D,
} from './UnitChassisMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import type { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import { entityTeamColorHex } from './EntityInstanceColor3D';
import { FORMIK_UNIT_BLUEPRINT_ID } from './FormikOrnament3D';
import {
  growFloat32Array,
  writePositionQuaternion,
} from './typedArrayRenderUtils';

const WRITE_SMOOTH = 0;
const WRITE_POLY = 1;

// Dorsal fin — the unit's team trim. Proportions are in unit-radius-1
// space, the same space BodyMeshPart uses, so every hull gets a fin
// scaled to itself. It runs fore-aft along the spine because the RTS
// camera looks down: a lateral stripe would be invisible from above,
// which is exactly where the player needs to read alliance.
const FIN_LENGTH = 1.15;
const FIN_THICKNESS = 0.22;
const FIN_HEIGHT = 0.30;
/** How far the fin sinks into the hull, so it reads as mounted rather
 *  than floating above the body. */
const FIN_EMBED = 0.10;

/** Reused per fin write; the pose pass is a hot loop. */
const _finOffset = new THREE.Vector3();

export class UnitChassisInstancePose3D {
  private readonly batch = new UnitChassisMatrixBatch3D();
  private input = new Float32Array(CHASSIS_PART_INPUT_STRIDE * 1024);
  private count = 0;
  private readonly kinds: number[] = [];
  private readonly slots: number[] = [];
  private readonly entities: Entity[] = [];
  private readonly bodyShapeKeys: string[] = [];
  private readonly writeColors: boolean[] = [];

  /**
   * Place this unit's dorsal fin. The fin sits on the chassis spine at
   * the body's own top, oriented with the body, so it banks and tilts
   * with the hull instead of sliding around on it.
   *
   * The trim is TEAM color while the hull is PLAYER color — that pairing
   * is the whole point: teammates share the fin, and their hulls tell
   * them apart.
   */
  private updateTeamFin(
    entity: Entity,
    mesh: EntityMesh,
    bodyEntry: BodyGeomEntry,
    radius: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    teamTrim: TeamTrimRenderer3D,
  ): void {
    if (mesh.teamTrimSlot === undefined) {
      const slot = teamTrim.alloc();
      // A full pool just means no fin on this unit; never a broken frame.
      if (slot < 0) return;
      mesh.teamTrimSlot = slot;
    }
    const height = FIN_HEIGHT * radius;
    // Ride the body's top, sunk by FIN_EMBED so it looks mounted.
    const localY = (bodyEntry.topY - FIN_EMBED) * radius + height * 0.5;
    _finOffset.set(0, localY, 0).applyQuaternion(parentQuaternion);
    teamTrim.set(
      mesh.teamTrimSlot,
      parentPosition.x + _finOffset.x,
      parentPosition.y + _finOffset.y,
      parentPosition.z + _finOffset.z,
      parentQuaternion,
      FIN_LENGTH * radius,
      height,
      FIN_THICKNESS * radius,
      entityTeamColorHex(entity),
    );
  }

  /**
   * Place the Formik's bespoke rounded exoskeletal strokes. The merged kit is
   * one instance in unit-radius-1 space, so its rails stay registered to all
   * three smooth body lobes while the chassis tilts and yaws.
   */
  private updateFormikBodyOrnament(
    entity: Entity,
    mesh: EntityMesh,
    radius: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    teamTrim: TeamTrimRenderer3D,
  ): void {
    if (mesh.formikBodyTrimSlot === undefined) {
      const slot = teamTrim.allocFormikBody();
      if (slot < 0) return;
      mesh.formikBodyTrimSlot = slot;
    }
    teamTrim.setFormikBody(
      mesh.formikBodyTrimSlot,
      parentPosition.x,
      parentPosition.y,
      parentPosition.z,
      parentQuaternion,
      radius,
      entityTeamColorHex(entity),
    );
  }

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
    teamTrim: TeamTrimRenderer3D | null = null,
  ): void {
    if (!fullUnitDetail) {
      unitDetailInstances.clearChassisSlots(mesh);
      if (teamTrim !== null && mesh.teamTrimSlot !== undefined) {
        teamTrim.hide(mesh.teamTrimSlot);
      }
      if (teamTrim !== null && mesh.formikBodyTrimSlot !== undefined) {
        teamTrim.hideFormikBody(mesh.formikBodyTrimSlot);
      }
      return;
    }
    if (teamTrim !== null) {
      if (entity.unit?.unitBlueprintId === FORMIK_UNIT_BLUEPRINT_ID) {
        this.updateFormikBodyOrnament(
          entity,
          mesh,
          radius,
          parentPosition,
          parentQuaternion,
          teamTrim,
        );
      } else {
        this.updateTeamFin(
          entity,
          mesh,
          bodyEntry,
          radius,
          parentPosition,
          parentQuaternion,
          teamTrim,
        );
      }
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
    writePositionQuaternion(input, base, parentPosition, parentQuaternion);
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
    this.input = growFloat32Array(this.input, needed);
  }
}
