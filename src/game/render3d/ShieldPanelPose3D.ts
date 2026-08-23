import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import {
  SHIELD_PANEL_INPUT_STRIDE,
  ShieldPanelMatrixBatch3D,
} from './ShieldPanelMatrixBatch3D';
import {
  TURRET_AIM_INPUT_STRIDE,
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
import { writeTurretAimInput } from './turretAimInput';
import {
  createTurretAimBuffers,
  ensureTurretAimBufferCapacity,
} from './turretAimCapacity';

/** The dome's raise/lower ramp, applied to the panel shape of the same
 *  material: alpha reaches full a third of the way through the authored
 *  transition. Kept identical to ShieldRenderer3D's field fade on purpose —
 *  one material must not raise two different ways. */
function shieldFadeForProgress(progress: number): number {
  if (!(progress > 0)) return 0;
  return Math.min(progress * 3, 1);
}

/** Apply shield-state visibility to panels rendered as ordinary child meshes.
 *  Allocated close-detail panels use instance alpha instead; medium/low and
 *  pool-fallback panels must not inherit visibility merely from the LOD root. */
export function applyPerMeshShieldPanelForceVisibility3D(
  mirrors: Pick<ShieldPanelMesh, 'panels' | 'panelSlots'>,
  shieldFade: number,
): void {
  if (mirrors.panelSlots) return;
  const visible = shieldFade > 0;
  for (const panel of mirrors.panels) {
    setObjectVisibleIfChanged(panel, visible);
  }
}

export class ShieldPanelPose3D {
  private readonly aimBatch = new UnitTurretAimBatch3D();
  private readonly aimBuffers = createTurretAimBuffers(256);
  private aimCount = 0;
  private readonly aimEntities: Entity[] = [];
  private readonly aimMirrors: ShieldPanelMesh[] = [];
  private readonly aimShieldFades: number[] = [];
  private readonly parentPositionScratch = new THREE.Vector3();
  private readonly parentQuaternionScratch = new THREE.Quaternion();

  private readonly batch = new ShieldPanelMatrixBatch3D();
  private input = new Float32Array(SHIELD_PANEL_INPUT_STRIDE * 256);
  private count = 0;
  private readonly slots: number[] = [];
  private readonly entities: Entity[] = [];
  private readonly shieldFades: number[] = [];
  /** Mirrors whose plates are down this frame and still hold live instance
   *  matrices. Their slots are released once in flush(); the support arms and
   *  grabbers stay drawn, because those are hardware, not force material. */
  private readonly clearedMirrors: ShieldPanelMesh[] = [];

  begin(): void {
    this.aimCount = 0;
    this.aimEntities.length = 0;
    this.aimMirrors.length = 0;
    this.aimShieldFades.length = 0;
    this.count = 0;
    this.slots.length = 0;
    this.entities.length = 0;
    this.shieldFades.length = 0;
    this.clearedMirrors.length = 0;
  }

  update(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    turretRows: ClientRenderTurretHostRows | undefined,
    shieldPanelTurretIndex: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    /** The panel's barrier progress (turret.shield.range, 0→1). Same
     *  authored transition a dome rides, and it is faded in the same way
     *  ShieldRenderer3D fades a field, so both shapes of the one material
     *  raise and lower alike. */
    shieldProgress: number,
    legacyRotation?: number,
    legacyPitch?: number,
  ): void {
    if (!mirrors.supportVisible) {
      setObjectVisibleIfChanged(mirrors.root, true);
      mirrors.supportVisible = true;
    }

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
      shieldFadeForProgress(shieldProgress),
    );
  }

  flush(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    this.flushAimRecords();
    for (let i = 0; i < this.clearedMirrors.length; i++) {
      const slots = this.clearedMirrors[i].panelSlots;
      if (slots) unitDetailInstances.clearShieldPanelSlots(slots);
    }
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
        this.shieldFades[i],
      );
    }
  }

  private flushAimRecords(): void {
    const count = this.aimCount;
    if (count <= 0) return;

    const input = this.aimBatch.begin(count);
    input.set(this.aimBuffers.aimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
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
        this.aimBuffers.parentPose[poseBase],
        this.aimBuffers.parentPose[poseBase + 1],
        this.aimBuffers.parentPose[poseBase + 2],
      );
      this.parentQuaternionScratch.set(
        this.aimBuffers.parentPose[poseBase + 3],
        this.aimBuffers.parentPose[poseBase + 4],
        this.aimBuffers.parentPose[poseBase + 5],
        this.aimBuffers.parentPose[poseBase + 6],
      );

      this.enqueuePanels(
        this.aimEntities[i],
        mirrors,
        this.parentPositionScratch,
        this.parentQuaternionScratch,
        this.aimShieldFades[i],
      );
    }
  }

  private enqueuePanels(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    shieldFade: number,
  ): void {
    if (!mirrors.panelSlots) {
      applyPerMeshShieldPanelForceVisibility3D(mirrors, shieldFade);
      return;
    }

    // A lowered plate is force material that is not there. Release its
    // instance slots and leave the arms and grabbers posed: the emitter
    // hardware is ordinary mounted machinery and stays visible whether or
    // not the side is running the barrier — the same way an unpowered dome
    // host still draws its chassis.
    if (!(shieldFade > 0)) {
      if (mirrors.panelSlotsActive) {
        mirrors.panelSlotsActive = false;
        this.clearedMirrors.push(mirrors);
      }
      return;
    }
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
        mirrors.root,
        mirrors.panels[panelIdx],
        shieldFade,
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
    shieldFade: number,
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
    this.shieldFades[index] = shieldFade;
  }

  private enqueueAim(
    entity: Entity,
    mirrors: ShieldPanelMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    hostRotation: number,
    aimRotation: number,
    aimPitch: number,
    shieldFade: number,
  ): void {
    const index = this.aimCount;
    this.aimCount++;
    ensureTurretAimBufferCapacity(this.aimBuffers, this.aimCount);

    const base = index * TURRET_AIM_INPUT_STRIDE;
    const input = this.aimBuffers.aimInput;
    writeTurretAimInput(
      input,
      base,
      hostRotation,
      aimRotation,
      aimPitch,
      parentQuaternion,
    );

    const poseBase = index * 7;
    writePositionQuaternion(
      this.aimBuffers.parentPose,
      poseBase,
      parentPosition,
      parentQuaternion,
    );

    this.aimEntities[index] = entity;
    this.aimMirrors[index] = mirrors;
    this.aimShieldFades[index] = shieldFade;
  }

  private ensureInputCapacity(count: number): void {
    const needed = count * SHIELD_PANEL_INPUT_STRIDE;
    if (this.input.length >= needed) return;
    this.input = growFloat32Array(this.input, needed);
  }

}
