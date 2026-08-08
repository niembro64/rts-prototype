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
import {
  DEFAULT_TEAM_ORNAMENT_FIT,
  hostOrnamentProfile,
  type HostOrnamentProfile,
} from './TeamOrnament3D';
import { getUnitBlueprint } from '../sim/blueprints';
import {
  growFloat32Array,
  writePositionQuaternion,
} from './typedArrayRenderUtils';

const WRITE_SMOOTH = 0;
const WRITE_POLY = 1;

/**
 * Fit the shared team kit to whatever body this unit actually has.
 *
 * The bounds come from the body parts themselves, in the unit-radius-1 space
 * they are authored in, so a new blueprint gets a fitted kit the first time
 * one is built — there is no per-unit ornament table to keep in sync, and no
 * unit can end up wearing the wrong shape because someone forgot to add a row.
 *
 * Cached on the mesh: the parts are immutable for a given body shape and tier,
 * and this runs in the per-frame pose pass.
 */
function ornamentProfileFor(
  entity: Entity,
  mesh: EntityMesh,
  bodyEntry: BodyGeomEntry,
): HostOrnamentProfile {
  const cached = mesh.teamTrimProfile;
  if (cached !== undefined) return cached;
  let minX = 0;
  let maxX = 0;
  let halfWidth = 0;
  for (const part of bodyEntry.parts) {
    minX = Math.min(minX, part.x - part.scaleX);
    maxX = Math.max(maxX, part.x + part.scaleX);
    halfWidth = Math.max(halfWidth, Math.abs(part.z) + part.scaleZ);
  }
  // A bodyless host (shield emitters, turret-hosted visuals) still has to read
  // as somebody's: fall back to the unit sphere the renderer would draw.
  if (maxX - minX < 1e-3) {
    minX = -1;
    maxX = 1;
  }
  if (halfWidth < 1e-3) halfWidth = 1;
  // The BOUNDS are measured; the FIT is authored. Where the rails start, stop
  // and how high they ride over each end is a fact about how this hull is
  // meant to be dressed, and no measurement of a bounding box recovers it.
  const blueprintId = entity.unit?.unitBlueprintId;
  const profile = hostOrnamentProfile({
    minX,
    maxX,
    halfWidth,
    topY: bodyEntry.topY > 1e-3 ? bodyEntry.topY : 1,
  }, blueprintId === undefined
    ? DEFAULT_TEAM_ORNAMENT_FIT
    : getUnitBlueprint(blueprintId).teamOrnament);
  mesh.teamTrimProfile = profile;
  return profile;
}

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
   * Place this unit's team kit — the rail-and-rib frame, fitted to its own
   * hull.
   *
   * The merged kit is one instance in unit-radius-1 space, so its rails stay
   * registered to every body lobe while the chassis banks, tilts and yaws
   * instead of sliding around on it.
   *
   * The trim is TEAM colour while the hull is PLAYER colour — that pairing is
   * the whole point: teammates share the frame, and their hulls tell them
   * apart.
   */
  private updateTeamKit(
    entity: Entity,
    mesh: EntityMesh,
    bodyEntry: BodyGeomEntry,
    radius: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    teamTrim: TeamTrimRenderer3D,
  ): void {
    if (mesh.teamTrimSlot === undefined) {
      const slot = teamTrim.allocHostKit(
        ornamentProfileFor(entity, mesh, bodyEntry),
        radius,
        mesh.geometryTier ?? 'close',
      );
      // A full pool just means no kit on this unit; never a broken frame.
      if (slot < 0) return;
      mesh.teamTrimSlot = slot;
    }
    teamTrim.setHostKit(
      mesh.teamTrimSlot,
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
      return;
    }
    const unitBlueprintId = entity.unit?.unitBlueprintId;
    const usesStandingRig = unitBlueprintId !== undefined &&
      getUnitBlueprint(unitBlueprintId).unitLocomotion.type === 'standing';
    if (teamTrim !== null && !usesStandingRig) {
      this.updateTeamKit(
        entity,
        mesh,
        bodyEntry,
        radius,
        parentPosition,
        parentQuaternion,
        teamTrim,
      );
    } else if (teamTrim !== null && mesh.teamTrimSlot !== undefined) {
      teamTrim.hide(mesh.teamTrimSlot);
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
