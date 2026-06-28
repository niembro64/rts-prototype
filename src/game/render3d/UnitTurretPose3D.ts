import * as THREE from 'three';
import { getTurretHeadRadius } from '../math';
import type { Entity, Turret } from '../sim/types';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import {
  entityHeadOnlyTurretHeadColorHex,
  entityHeadOnlyTurretHeadColorHexForStateCode,
  entityShieldSphereTurretHeadColorHex,
  entityShieldSphereTurretHeadColorHexForRange,
} from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import type { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
import type { TurretMesh } from './TurretMesh3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  TURRET_AIM_MODE_POSE,
  TURRET_AIM_MODE_WORLD_DIR,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import {
  TURRET_BARREL_INPUT_STRIDE,
  UnitTurretBarrelMatrixBatch3D,
} from './UnitTurretBarrelMatrixBatch3D';
import {
  TURRET_HEAD_INPUT_STRIDE,
  UnitTurretHeadMatrixBatch3D,
} from './UnitTurretHeadMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import type { TurretMountCache3D } from './TurretMountCache3D';
import {
  CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY,
  CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD,
  type ClientRenderTurretHostRows,
} from './ClientRenderTurretStateSlab';
import {
  setEulerXIfChanged,
  setEulerYIfChanged,
  setEulerZIfChanged,
  setObjectVisibleIfChanged,
  setVector3IfChanged,
} from './threeTransformWriteUtils';

export class UnitTurretPose3D {
  private readonly aimBatch = new UnitTurretAimBatch3D();
  private aimInput = new Float32Array(TURRET_AIM_INPUT_STRIDE * 2048);
  private aimParentPose = new Float32Array(7 * 2048);
  private aimCount = 0;
  private readonly aimTurretMeshes: TurretMesh[] = [];
  private readonly aimEntities: Entity[] = [];
  private readonly aimTurretIndexes: number[] = [];
  private readonly aimHeadSlots: number[] = [];
  private readonly aimHeadRadii: number[] = [];
  private readonly aimColorOverrides: (number | undefined)[] = [];
  private readonly deferredParentPosition = new THREE.Vector3();
  private readonly deferredParentQuaternion = new THREE.Quaternion();

  private readonly barrelBatch = new UnitTurretBarrelMatrixBatch3D();
  private barrelInput = new Float32Array(TURRET_BARREL_INPUT_STRIDE * 2048);
  private barrelCount = 0;
  private readonly barrelSlots: number[] = [];
  private readonly barrelUsesCone: boolean[] = [];
  private readonly headBatch = new UnitTurretHeadMatrixBatch3D();
  private headInput = new Float32Array(TURRET_HEAD_INPUT_STRIDE * 2048);
  private headCount = 0;
  private readonly headSlots: number[] = [];
  private readonly headEntities: Entity[] = [];
  private readonly headColorOverrides: (number | undefined)[] = [];
  private readonly headEntityIds: number[] = [];
  private readonly headTurretIndexes: number[] = [];

  begin(): void {
    this.aimCount = 0;
    this.aimTurretMeshes.length = 0;
    this.aimEntities.length = 0;
    this.aimTurretIndexes.length = 0;
    this.aimHeadSlots.length = 0;
    this.aimHeadRadii.length = 0;
    this.aimColorOverrides.length = 0;
    this.barrelCount = 0;
    this.barrelSlots.length = 0;
    this.barrelUsesCone.length = 0;
    this.headCount = 0;
    this.headSlots.length = 0;
    this.headEntities.length = 0;
    this.headColorOverrides.length = 0;
    this.headEntityIds.length = 0;
    this.headTurretIndexes.length = 0;
  }

  update(
    entity: Entity,
    mesh: EntityMesh,
    turretRows: ClientRenderTurretHostRows | undefined,
    turrets: readonly Turret[],
    bodyVisible: boolean,
    bodyCenterHeight: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    chassisTiltInverse: THREE.Quaternion | undefined,
    barrelSpinEnabled: boolean,
    barrelSpinState: UnitBarrelSpinState3D,
    currentDtMs: number,
    timeMs: number,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretBeamAimCache: TurretBeamAimCache3D,
    constructionVisuals: ConstructionVisualController3D,
  ): void {
    const stateViews = turretRows?.views;
    const stateStart = turretRows?.start ?? 0;
    const turretCount = turretRows !== undefined ? turretRows.count : turrets.length;
    for (let turretIdx = 0; turretIdx < mesh.turrets.length && turretIdx < turretCount; turretIdx++) {
      const turretMesh = mesh.turrets[turretIdx];
      const turret = turrets[turretIdx];
      const stateRow = stateStart + turretIdx;
      const useState = stateViews !== undefined && turretIdx < (turretRows?.count ?? 0);
      if (!useState && turret === undefined) continue;
      const flags = useState ? stateViews.flags[stateRow] : 0;
      const mountX = useState ? stateViews.mountX[stateRow] : turret.mount.x;
      const mountY = useState ? stateViews.mountY[stateRow] : turret.mount.y;
      const mountZ = useState ? stateViews.mountZ[stateRow] : turret.mount.z;
      const aimRotationFromState = useState ? stateViews.rotation[stateRow] : turret.rotation;
      const aimPitchFromState = useState ? stateViews.pitch[stateRow] : turret.pitch;
      const headRadius = turretMesh.headRadius
        ?? (useState ? stateViews.headRadius[stateRow] : getTurretHeadRadius(turret.config));
      const visible = bodyVisible;
      setObjectVisibleIfChanged(turretMesh.root, visible);
      if (!visible) {
        unitDetailInstances.clearTurretSlots(turretMesh);
        continue;
      }

      const turretHeadCenterY = Number.isFinite(mountZ)
        ? mountZ
        : bodyCenterHeight;
      const turretMountY = turretHeadCenterY - (mesh.chassisLift ?? 0) - headRadius;
      setVector3IfChanged(
        turretMesh.root.position,
        mountX,
        turretMountY,
        mountY,
      );

      if (turretMesh.constructionEmitter) {
        setEulerZIfChanged(
          turretMesh.constructionEmitter.group.rotation,
          entity.unit?.unitBlueprintId === 'unitConstructionDrone' ? Math.PI : 0,
        );
        this.enqueueHeadMount(
          entity,
          turretIdx,
          undefined,
          undefined,
          parentPosition,
          parentQuaternion,
          turretMesh.root,
          headRadius,
        );
        setObjectVisibleIfChanged(turretMesh.root, true);
        applyTurretAimPose3D(
          turretMesh,
          entity.transform.rotation,
          aimRotationFromState,
          0,
          chassisTiltInverse,
        );
        if (turretMesh.pitchGroup) setEulerZIfChanged(turretMesh.pitchGroup.rotation, 0);
        if (turretMesh.spinGroup) setEulerXIfChanged(turretMesh.spinGroup.rotation, 0);
        constructionVisuals.updateBuilderConstructionEmitter(
          turretMesh.constructionEmitter,
          entity,
          currentDtMs,
        );
        continue;
      }

      let deferAim = false;
      let aimMode = TURRET_AIM_MODE_POSE;
      let aimRotation = aimRotationFromState;
      let aimPitch = aimPitchFromState;
      let aimDirX = 0;
      let aimDirY = 0;
      let aimDirZ = 0;
      if (turretMesh.barrelFollowsBeam) {
        // Beam turret: aim the head along the last beam fired (frozen at
        // the last direction when not firing). Sim turret aim is pinned to
        // zero on the wire for these, so fall back to the forward idle pose
        // until the first beam is cached.
        const beamDir = turretBeamAimCache.get(entity.id, turretIdx);
        if (beamDir) {
          aimMode = TURRET_AIM_MODE_WORLD_DIR;
          aimDirX = beamDir.x;
          aimDirY = beamDir.y;
          aimDirZ = beamDir.z;
        }
        deferAim = true;
        // Beam barrels never spin.
        if (turretMesh.spinGroup) setEulerXIfChanged(turretMesh.spinGroup.rotation, 0);
      } else if (!(useState ? (flags & CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY) !== 0 : turret.config.headOnly)) {
        deferAim = true;
        if (turretMesh.spinGroup) {
          setEulerXIfChanged(
            turretMesh.spinGroup.rotation,
            barrelSpinEnabled
              ? barrelSpinState.angleFor(entity.id, turretIdx) ?? 0
              : 0,
          );
        }
      }

      if (
        turretMesh.headSlot !== undefined &&
        turretMesh.headRadius !== undefined
      ) {
        const headColorOverride = turretMesh.headOnly && !turretMesh.barrelFollowsBeam
          ? useState
            ? entityHeadOnlyTurretHeadColorHexForStateCode(entity, stateViews.stateCode[stateRow])
            : entityHeadOnlyTurretHeadColorHex(entity, turret.state)
          : turretMesh.shieldEmitterCore
            ? useState
              ? entityShieldSphereTurretHeadColorHexForRange(
                entity,
                (flags & CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD) !== 0,
                stateViews.shieldRange[stateRow],
                timeMs,
              )
              : entityShieldSphereTurretHeadColorHex(entity, turret, timeMs)
            : undefined;
        if (deferAim) {
          this.enqueueAim(
            entity,
            turretIdx,
            turretMesh,
            turretMesh.headSlot,
            turretMesh.headRadius,
            headColorOverride,
            parentPosition,
            parentQuaternion,
            entity.transform.rotation,
            aimMode,
            aimRotation,
            aimPitch,
            aimDirX,
            aimDirY,
            aimDirZ,
            chassisTiltInverse,
          );
          continue;
        }
        this.enqueueHeadMount(
          entity,
          turretIdx,
          turretMesh.headSlot,
          headColorOverride,
          parentPosition,
          parentQuaternion,
          turretMesh.root,
          turretMesh.headRadius,
        );
      } else {
        if (deferAim) {
          this.enqueueAim(
            entity,
            turretIdx,
            turretMesh,
            undefined,
            headRadius,
            undefined,
            parentPosition,
            parentQuaternion,
            entity.transform.rotation,
            aimMode,
            aimRotation,
            aimPitch,
            aimDirX,
            aimDirY,
            aimDirZ,
            chassisTiltInverse,
          );
          continue;
        }
        this.enqueueHeadMount(
          entity,
          turretIdx,
          undefined,
          undefined,
          parentPosition,
          parentQuaternion,
          turretMesh.root,
          headRadius,
        );
      }

      this.writeBarrelInstances(
        turretMesh,
        parentPosition,
        parentQuaternion,
      );
    }
  }

  flush(
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
  ): void {
    this.flushAimRecords();
    this.flushHeadMounts(unitDetailInstances, turretMountCache);
    this.flushBarrels(unitDetailInstances);
  }

  private flushAimRecords(): void {
    const count = this.aimCount;
    if (count <= 0) return;

    const input = this.aimBatch.begin(count);
    input.set(this.aimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
    const output = this.aimBatch.compute(count);
    const outputStride = this.aimBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const turretMesh = this.aimTurretMeshes[i];
      const outputBase = i * outputStride;
      setEulerYIfChanged(turretMesh.root.rotation, output[outputBase]);
      if (turretMesh.pitchGroup) {
        setEulerZIfChanged(turretMesh.pitchGroup.rotation, output[outputBase + 1]);
      }

      const poseBase = i * 7;
      this.deferredParentPosition.set(
        this.aimParentPose[poseBase],
        this.aimParentPose[poseBase + 1],
        this.aimParentPose[poseBase + 2],
      );
      this.deferredParentQuaternion.set(
        this.aimParentPose[poseBase + 3],
        this.aimParentPose[poseBase + 4],
        this.aimParentPose[poseBase + 5],
        this.aimParentPose[poseBase + 6],
      );
      this.enqueueHeadMount(
        this.aimEntities[i],
        this.aimTurretIndexes[i],
        this.aimHeadSlots[i] >= 0 ? this.aimHeadSlots[i] : undefined,
        this.aimColorOverrides[i],
        this.deferredParentPosition,
        this.deferredParentQuaternion,
        turretMesh.root,
        this.aimHeadRadii[i],
      );
      this.writeBarrelInstances(
        turretMesh,
        this.deferredParentPosition,
        this.deferredParentQuaternion,
      );
    }
  }

  private flushHeadMounts(
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
  ): void {
    const count = this.headCount;
    if (count <= 0) return;

    const input = this.headBatch.begin(count);
    input.set(this.headInput.subarray(0, count * TURRET_HEAD_INPUT_STRIDE));
    const output = this.headBatch.compute(count);
    const outputStride = this.headBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const offset = i * outputStride;
      const headX = output[offset + 12];
      const headY = output[offset + 13];
      const headZ = output[offset + 14];
      turretMountCache.write(
        this.headEntityIds[i],
        this.headTurretIndexes[i],
        headX,
        headZ,
        headY,
      );
      const slot = this.headSlots[i];
      if (slot < 0) continue;
      unitDetailInstances.writeTurretHeadMatrixArray(
        slot,
        output,
        offset,
        this.headEntities[i],
        this.headColorOverrides[i],
      );
    }
  }

  private flushBarrels(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    const count = this.barrelCount;
    if (count <= 0) return;

    const input = this.barrelBatch.begin(count);
    input.set(this.barrelInput.subarray(0, count * TURRET_BARREL_INPUT_STRIDE));
    const output = this.barrelBatch.compute(count);
    const outputStride = this.barrelBatch.outputStride;

    for (let i = 0; i < count; i++) {
      unitDetailInstances.writeBarrelMatrixArray(
        this.barrelSlots[i],
        output,
        i * outputStride,
        this.barrelUsesCone[i],
      );
    }
  }

  private enqueueHeadMount(
    entity: Entity,
    turretIdx: number,
    headSlot: number | undefined,
    colorOverride: number | undefined,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    root: THREE.Group,
    headRadius: number,
  ): void {
    const index = this.headCount;
    this.headCount++;
    this.ensureHeadInputCapacity(this.headCount);

    const base = index * TURRET_HEAD_INPUT_STRIDE;
    const input = this.headInput;
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
    input[base + 10] = headRadius;

    this.headSlots[index] = headSlot ?? -1;
    this.headEntities[index] = entity;
    this.headColorOverrides[index] = colorOverride;
    this.headEntityIds[index] = entity.id;
    this.headTurretIndexes[index] = turretIdx;
  }

  private enqueueAim(
    entity: Entity,
    turretIdx: number,
    turretMesh: TurretMesh,
    headSlot: number | undefined,
    headRadius: number,
    colorOverride: number | undefined,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    hostRotation: number,
    mode: number,
    aimRotation: number,
    aimPitch: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    chassisTiltInverse: THREE.Quaternion | undefined,
  ): void {
    const index = this.aimCount;
    this.aimCount++;
    this.ensureAimInputCapacity(this.aimCount);

    const base = index * TURRET_AIM_INPUT_STRIDE;
    const input = this.aimInput;
    input[base] = hostRotation;
    input[base + 1] = mode;
    input[base + 2] = aimRotation;
    input[base + 3] = aimPitch;
    input[base + 4] = dirX;
    input[base + 5] = dirY;
    input[base + 6] = dirZ;
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

    this.aimTurretMeshes[index] = turretMesh;
    this.aimEntities[index] = entity;
    this.aimTurretIndexes[index] = turretIdx;
    this.aimHeadSlots[index] = headSlot ?? -1;
    this.aimHeadRadii[index] = headRadius;
    this.aimColorOverrides[index] = colorOverride;
  }

  private writeBarrelInstances(
    turretMesh: TurretMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
  ): void {
    if (
      !turretMesh.barrelSlots ||
      turretMesh.barrels.length === 0 ||
      turretMesh.barrelSlots.length !== turretMesh.barrels.length
    ) {
      return;
    }

    for (let barrelIdx = 0; barrelIdx < turretMesh.barrels.length; barrelIdx++) {
      this.enqueueBarrel(
        turretMesh.barrelSlots[barrelIdx],
        turretMesh.barrelUsesCone === true,
        parentPosition,
        parentQuaternion,
        turretMesh.root,
        turretMesh.pitchGroup,
        turretMesh.spinGroup,
        turretMesh.barrels[barrelIdx],
      );
    }
  }

  private enqueueBarrel(
    slot: number,
    useCone: boolean,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    root: THREE.Group,
    pitchGroup: THREE.Group | undefined,
    spinGroup: THREE.Group | undefined,
    barrel: THREE.Mesh,
  ): void {
    const index = this.barrelCount;
    this.barrelCount++;
    this.ensureBarrelInputCapacity(this.barrelCount);

    const pitchPos = pitchGroup?.position;
    const pitchQuat = pitchGroup?.quaternion;
    const spinPos = spinGroup?.position;
    const spinQuat = spinGroup?.quaternion;
    const base = index * TURRET_BARREL_INPUT_STRIDE;
    const input = this.barrelInput;
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
    input[base + 14] = pitchPos?.x ?? 0;
    input[base + 15] = pitchPos?.y ?? 0;
    input[base + 16] = pitchPos?.z ?? 0;
    input[base + 17] = pitchQuat?.x ?? 0;
    input[base + 18] = pitchQuat?.y ?? 0;
    input[base + 19] = pitchQuat?.z ?? 0;
    input[base + 20] = pitchQuat?.w ?? 1;
    input[base + 21] = spinPos?.x ?? 0;
    input[base + 22] = spinPos?.y ?? 0;
    input[base + 23] = spinPos?.z ?? 0;
    input[base + 24] = spinQuat?.x ?? 0;
    input[base + 25] = spinQuat?.y ?? 0;
    input[base + 26] = spinQuat?.z ?? 0;
    input[base + 27] = spinQuat?.w ?? 1;
    input[base + 28] = barrel.position.x;
    input[base + 29] = barrel.position.y;
    input[base + 30] = barrel.position.z;
    input[base + 31] = barrel.quaternion.x;
    input[base + 32] = barrel.quaternion.y;
    input[base + 33] = barrel.quaternion.z;
    input[base + 34] = barrel.quaternion.w;
    input[base + 35] = barrel.scale.x;
    input[base + 36] = barrel.scale.y;
    input[base + 37] = barrel.scale.z;

    this.barrelSlots[index] = slot;
    this.barrelUsesCone[index] = useCone;
  }

  private ensureBarrelInputCapacity(count: number): void {
    const needed = count * TURRET_BARREL_INPUT_STRIDE;
    if (this.barrelInput.length >= needed) return;
    let next = this.barrelInput.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.barrelInput);
    this.barrelInput = expanded;
  }

  private ensureHeadInputCapacity(count: number): void {
    const needed = count * TURRET_HEAD_INPUT_STRIDE;
    if (this.headInput.length >= needed) return;
    let next = this.headInput.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.headInput);
    this.headInput = expanded;
  }

  private ensureAimInputCapacity(count: number): void {
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
