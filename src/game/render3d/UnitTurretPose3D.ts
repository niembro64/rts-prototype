import * as THREE from 'three';
import { getTurretHeadRadius } from '../math';
import type { Entity, Turret } from '../sim/types';
import {
  entityTeamColorHex,
  entityHeadOnlyTurretHeadColorHex,
  entityHeadOnlyTurretHeadColorHexForStateCode,
  entityShieldSphereTurretHeadColorHex,
  entityShieldSphereTurretHeadColorHexForRange,
} from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import type { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretMesh } from './TurretMesh3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import {
  TURRET_BARREL_INPUT_STRIDE,
  UnitTurretBarrelMatrixBatch3D,
} from './UnitTurretBarrelMatrixBatch3D';
import {
  TURRET_HEAD_INPUT_STRIDE,
  UnitTurretHeadMatrixBatch3D,
  writeTurretHeadInput,
} from './UnitTurretHeadMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import type { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import type { TurretMountCache3D } from './TurretMountCache3D';
import {
  resolveBotArmTurretRoot,
} from './BotRig3D';
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
import {
  growFloat32Array,
  writePositionQuaternion,
} from './typedArrayRenderUtils';
import { writeTurretAimInput } from './turretAimInput';
import {
  createTurretAimBuffers,
  ensureTurretAimBufferCapacity,
} from './turretAimCapacity';

export class UnitTurretPose3D {
  private readonly aimBatch = new UnitTurretAimBatch3D();
  private readonly aimBuffers = createTurretAimBuffers(2048);
  private aimCount = 0;
  private readonly aimTurretMeshes: TurretMesh[] = [];
  private readonly aimEntities: Entity[] = [];
  private readonly aimTurretIndexes: number[] = [];
  private readonly aimHeadSlots: number[] = [];
  private readonly aimHeadRadii: number[] = [];
  private readonly aimColorOverrides: (number | undefined)[] = [];
  private readonly aimLocalYaw: number[] = [];
  private readonly aimLocalPitch: number[] = [];
  private readonly aimPilotLightVisible: boolean[] = [];
  private readonly deferredParentPosition = new THREE.Vector3();
  private readonly deferredParentQuaternion = new THREE.Quaternion();
  private readonly anchorPosition = new THREE.Vector3();
  private readonly anchorQuaternion = new THREE.Quaternion();
  private readonly fixedMuzzlePosition = new THREE.Vector3();
  private readonly fixedMuzzleForward = new THREE.Vector3();
  private readonly fixedMuzzleQuaternion = new THREE.Quaternion();
  private readonly scratchZeroPosition = new THREE.Vector3();
  private readonly scratchIdentityQuaternion = new THREE.Quaternion();
  private readonly articulatedMount = new THREE.Vector3();

  private readonly barrelBatch = new UnitTurretBarrelMatrixBatch3D();
  private barrelInput = new Float32Array(TURRET_BARREL_INPUT_STRIDE * 2048);
  private barrelCount = 0;
  private readonly barrelSlots: number[] = [];
  private readonly barrelUsesCone: boolean[] = [];
  private readonly barrelEntityIds: number[] = [];
  private readonly barrelTurretIndexes: number[] = [];
  private readonly barrelLaneIndexes: number[] = [];
  private readonly barrelPilotLightVisible: boolean[] = [];
  private readonly barrelPublishesEmission: boolean[] = [];
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
    this.aimLocalYaw.length = 0;
    this.aimLocalPitch.length = 0;
    this.aimPilotLightVisible.length = 0;
    this.barrelCount = 0;
    this.barrelSlots.length = 0;
    this.barrelUsesCone.length = 0;
    this.barrelEntityIds.length = 0;
    this.barrelTurretIndexes.length = 0;
    this.barrelLaneIndexes.length = 0;
    this.barrelPilotLightVisible.length = 0;
    this.barrelPublishesEmission.length = 0;
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
    supportPointOffsetZ: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    barrelSpinEnabled: boolean,
    barrelSpinState: UnitBarrelSpinState3D,
    timeMs: number,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    teamTrim: TeamTrimRenderer3D | null,
    isBeamPilotLightVisible: (entityId: number, turretIndex: number) => boolean,
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
      let mountX = useState ? stateViews.mountX[stateRow] : turret.mount.x;
      let mountY = useState ? stateViews.mountY[stateRow] : turret.mount.y;
      let mountZ = useState ? stateViews.mountZ[stateRow] : turret.mount.z;
      const aimRotationFromState = useState ? stateViews.rotation[stateRow] : turret.rotation;
      const aimPitchFromState = useState ? stateViews.pitch[stateRow] : turret.pitch;
      const headRadius = turretMesh.headRadius
        ?? (useState ? stateViews.headRadius[stateRow] : getTurretHeadRadius(turret.presentation));
      const visible = bodyVisible;
      setObjectVisibleIfChanged(turretMesh.root, visible);
      if (!visible) {
        unitDetailInstances.clearTurretSlots(turretMesh);
        if (turretMesh.teamCollar?.slot !== undefined) {
          teamTrim?.hide(turretMesh.teamCollar.slot);
        }
        continue;
      }
      const pilotLightVisible =
        turretMesh.barrelUsesCone !== true ||
        isBeamPilotLightVisible(entity.id, turretIdx);
      if (turretMesh.barrelUsesCone === true) {
        for (let barrelIdx = 0; barrelIdx < turretMesh.barrels.length; barrelIdx++) {
          setObjectVisibleIfChanged(turretMesh.barrels[barrelIdx], pilotLightVisible);
        }
      }

      const hostAttachment = turret?.config.hostAttachment;
      if (hostAttachment?.kind === 'botPiece' && entity.unit !== null) {
        const radius = entity.unit.radius.other;
        mountX += hostAttachment.socketOffset.x * radius;
        mountY += hostAttachment.socketOffset.y * radius;
        mountZ += hostAttachment.socketOffset.z * radius;
      }
      const turretHeadCenterY = Number.isFinite(mountZ)
        ? mountZ
        : supportPointOffsetZ;
      const turretMountY = turretHeadCenterY - (mesh.chassisLift ?? 0) - headRadius;
      const articulatedMount = mesh.locomotion?.type === 'bot' &&
        hostAttachment?.kind === 'botArm'
        ? resolveBotArmTurretRoot(
          mesh.locomotion,
          hostAttachment,
          headRadius,
          this.articulatedMount,
        )
        : null;
      if (articulatedMount !== null) {
        setVector3IfChanged(
          turretMesh.root.position,
          articulatedMount.x,
          articulatedMount.y,
          articulatedMount.z,
        );
      } else {
        setVector3IfChanged(
          turretMesh.root.position,
          mountX,
          turretMountY,
          mountY,
        );
      }

      // Yaw belongs to the logical turret even when its host presentation is
      // head-only or supplies no generic barrel. Always enqueue the aim pose
      // so the host-owned physical body beneath yawGroup turns with it;
      // headOnly only suppresses barrel-specific animation.
      if (!(useState ? (flags & CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY) !== 0 : turret.presentation.headOnly)) {
        if (turretMesh.spinGroup) {
          setEulerXIfChanged(
            turretMesh.spinGroup.rotation,
            barrelSpinEnabled
              ? barrelSpinState.angleFor(entity.id, turretIdx) ?? 0
              : 0,
          );
        }
      }

      const instancedHead = turretMesh.headSlot !== undefined &&
        turretMesh.headRadius !== undefined;
      const headSlot = turretMesh.headSlot !== undefined &&
        turretMesh.headRadius !== undefined
        ? turretMesh.headSlot
        : undefined;
      const aimHeadRadius = turretMesh.headSlot !== undefined &&
        turretMesh.headRadius !== undefined
        ? turretMesh.headRadius
        : headRadius;
      const headColorOverride = !instancedHead
        ? undefined
        : turretMesh.headOnly
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

      // Aim remains turret-owned. The host piece chain only supplies the
      // authoritative parent/socket transform, so normal world-to-parent aim
      // conversion keeps the visible barrel and gameplay forward identical.
      this.enqueueAim(
        entity,
        turretIdx,
        turretMesh,
        headSlot,
        aimHeadRadius,
        headColorOverride,
        parentPosition,
        parentQuaternion,
        entity.transform.rotation,
        aimRotationFromState,
        aimPitchFromState,
        Number.NaN,
        Number.NaN,
        pilotLightVisible,
      );
    }
  }

  flush(
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
    teamTrim: TeamTrimRenderer3D | null,
  ): void {
    this.flushAimRecords(teamTrim, turretMountCache);
    this.flushHeadMounts(unitDetailInstances, turretMountCache);
    this.flushBarrels(unitDetailInstances, turretMountCache);
  }

  private flushAimRecords(
    teamTrim: TeamTrimRenderer3D | null,
    turretMountCache: TurretMountCache3D,
  ): void {
    const count = this.aimCount;
    if (count <= 0) return;

    const input = this.aimBatch.begin(count);
    input.set(this.aimBuffers.aimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
    const output = this.aimBatch.compute(count);
    const outputStride = this.aimBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const turretMesh = this.aimTurretMeshes[i];
      const outputBase = i * outputStride;
      // The finite local override remains available for host rigs that publish
      // one explicitly. Bot weapon arms no longer use it: they supply only the
      // parent socket and the logical turret retains yaw/pitch authority.
      const localYaw = this.aimLocalYaw[i];
      const held = Number.isFinite(localYaw);
      setEulerYIfChanged(
        turretMesh.yawGroup.rotation,
        held ? localYaw : output[outputBase],
      );
      if (turretMesh.pitchGroup) {
        setEulerZIfChanged(
          turretMesh.pitchGroup.rotation,
          held ? this.aimLocalPitch[i] : output[outputBase + 1],
        );
      }

      const poseBase = i * 7;
      this.deferredParentPosition.set(
        this.aimBuffers.parentPose[poseBase],
        this.aimBuffers.parentPose[poseBase + 1],
        this.aimBuffers.parentPose[poseBase + 2],
      );
      this.deferredParentQuaternion.set(
        this.aimBuffers.parentPose[poseBase + 3],
        this.aimBuffers.parentPose[poseBase + 4],
        this.aimBuffers.parentPose[poseBase + 5],
        this.aimBuffers.parentPose[poseBase + 6],
      );
      this.enqueueHeadMount(
        this.aimEntities[i],
        this.aimTurretIndexes[i],
        this.aimHeadSlots[i] >= 0 ? this.aimHeadSlots[i] : undefined,
        this.aimColorOverrides[i],
        this.deferredParentPosition,
        this.deferredParentQuaternion,
        turretMesh.root,
        turretMesh.yawGroup,
        this.aimHeadRadii[i],
      );
      this.writeFixedMultiBarrelMuzzle(
        turretMesh,
        this.deferredParentPosition,
        this.deferredParentQuaternion,
        this.aimEntities[i].id,
        this.aimTurretIndexes[i],
        turretMountCache,
      );
      this.writeUnbarrelledTurretEmission(
        turretMesh,
        this.deferredParentPosition,
        this.deferredParentQuaternion,
        this.aimEntities[i].id,
        this.aimTurretIndexes[i],
        turretMountCache,
      );
      this.writeBarrelInstances(
        turretMesh,
        this.deferredParentPosition,
        this.deferredParentQuaternion,
        this.aimEntities[i],
        this.aimTurretIndexes[i],
        teamTrim,
        this.aimPilotLightVisible[i],
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

  private flushBarrels(
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
  ): void {
    const count = this.barrelCount;
    if (count <= 0) return;

    const input = this.barrelBatch.begin(count);
    input.set(this.barrelInput.subarray(0, count * TURRET_BARREL_INPUT_STRIDE));
    const output = this.barrelBatch.compute(count);
    const outputStride = this.barrelBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const offset = i * outputStride;
      unitDetailInstances.writeBarrelMatrixArray(
        this.barrelSlots[i],
        output,
        offset,
        this.barrelUsesCone[i],
        this.barrelPilotLightVisible[i],
      );
      const columnX = output[offset + 4];
      const columnY = output[offset + 5];
      const columnZ = output[offset + 6];
      const length = Math.hypot(columnX, columnY, columnZ);
      if (length <= 1e-9) continue;
      const invLength = 1 / length;
      // A beam's tapered barrel is its idle pilot light. The live ray replaces
      // that cone from the broad base (the turret origin); ordinary barrels
      // continue publishing their forward muzzle tip.
      const emissionEndFactor = this.barrelUsesCone[i] ? -0.5 : 0.5;
      const muzzleThreeX = output[offset + 12] + columnX * emissionEndFactor;
      const muzzleThreeY = output[offset + 13] + columnY * emissionEndFactor;
      const muzzleThreeZ = output[offset + 14] + columnZ * emissionEndFactor;
      if (this.barrelPublishesEmission[i]) {
        turretMountCache.writeEmission(
          this.barrelEntityIds[i],
          this.barrelTurretIndexes[i],
          this.barrelLaneIndexes[i],
          muzzleThreeX,
          muzzleThreeZ,
          muzzleThreeY,
          columnX * invLength,
          columnZ * invLength,
          columnY * invLength,
        );
      }
      if (this.barrelLaneIndexes[i] !== 0) continue;
      turretMountCache.writeForward(
        this.barrelEntityIds[i],
        this.barrelTurretIndexes[i],
        columnX * invLength,
        columnZ * invLength,
        columnY * invLength,
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
    yawGroup: THREE.Group,
    headRadius: number,
  ): void {
    const index = this.headCount;
    this.headCount++;
    this.ensureHeadInputCapacity(this.headCount);

    const base = index * TURRET_HEAD_INPUT_STRIDE;
    const input = this.headInput;
    writeTurretHeadInput(
      input,
      base,
      parentPosition,
      parentQuaternion,
      root.position,
      headRadius,
      yawGroup.quaternion,
    );

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
    aimRotation: number,
    aimPitch: number,
    /** Local yaw/pitch authored by the caller, overriding the batch result.
     *  Held guns on bot hosts use it; every other mount leaves it NaN
     *  and takes the solved turret aim. */
    localYaw = Number.NaN,
    localPitch = Number.NaN,
    pilotLightVisible = true,
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

    this.aimTurretMeshes[index] = turretMesh;
    this.aimEntities[index] = entity;
    this.aimTurretIndexes[index] = turretIdx;
    this.aimHeadSlots[index] = headSlot ?? -1;
    this.aimHeadRadii[index] = headRadius;
    this.aimColorOverrides[index] = colorOverride;
    this.aimLocalYaw[index] = localYaw;
    this.aimLocalPitch[index] = localPitch;
    this.aimPilotLightVisible[index] = pilotLightVisible;
  }

  private writeBarrelInstances(
    turretMesh: TurretMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    entity: Entity,
    turretIdx: number,
    teamTrim: TeamTrimRenderer3D | null,
    pilotLightVisible: boolean,
  ): void {
    this.writeTurretTeamCollar(
      turretMesh,
      parentPosition,
      parentQuaternion,
      entity,
      teamTrim,
    );
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
        turretMesh.yawGroup,
        turretMesh.pitchGroup,
        turretMesh.spinGroup,
        turretMesh.barrels[barrelIdx],
        entity.id,
        turretIdx,
        barrelIdx,
        pilotLightVisible,
        turretMesh.fixedMultiBarrelMuzzle === undefined,
      );
    }
  }

  /**
   * Publish the AimFrom pivot as the QueryWeapon origin for a turret whose
   * barrels never reach the instanced batch.
   *
   * The rendered barrel normally publishes that socket (see flushBarrels),
   * but a host may replace the shared barrel rig with bespoke geometry — the
   * Commander's arm cannon and the Human's weapon both clear `barrels` and
   * build their own — and then nothing published one at all. A live beam
   * whose socket is missing keeps the polyline the presentation snapshot
   * gave it, so it stepped at the snapshot rate while every other unit's
   * beam was re-anchored every render frame.
   *
   * The pivot is the correct answer here, not a stand-in: a beam's socket is
   * the broad base of its pilot-light cone at the turret's AimFrom pivot, so
   * its QueryWeapon offset is zero in turret-local space (see
   * budget_design_philosophy.html, "The beam cone is the beam pilot light
   * and shares the live beam's origin").
   *
   * Only the emission lane is published. `writeForward` mutates the head
   * mount row, which flushHeadMounts has not written yet at this point in
   * the flush; the emission row carries its own forward and is what beam
   * presentation reads.
   */
  private writeUnbarrelledTurretEmission(
    turretMesh: TurretMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    entityId: number,
    turretIdx: number,
    turretMountCache: TurretMountCache3D,
  ): void {
    if (turretMesh.fixedMultiBarrelMuzzle !== undefined) return;
    // Same predicate writeBarrelInstances bails on. When it draws, it also
    // publishes, so this must not double-publish over it.
    const barrelSlots = turretMesh.barrelSlots;
    if (
      barrelSlots !== undefined &&
      turretMesh.barrels.length > 0 &&
      barrelSlots.length === turretMesh.barrels.length
    ) {
      return;
    }

    const pitchGroup = turretMesh.pitchGroup;
    this.fixedMuzzlePosition.set(0, 0, 0);
    if (pitchGroup !== undefined) {
      this.fixedMuzzlePosition
        .applyQuaternion(pitchGroup.quaternion)
        .add(pitchGroup.position);
    }
    this.fixedMuzzlePosition
      .applyQuaternion(turretMesh.yawGroup.quaternion)
      .add(turretMesh.yawGroup.position)
      .applyQuaternion(turretMesh.root.quaternion)
      .add(turretMesh.root.position)
      .applyQuaternion(parentQuaternion)
      .add(parentPosition);
    this.fixedMuzzleQuaternion
      .copy(parentQuaternion)
      .multiply(turretMesh.root.quaternion)
      .multiply(turretMesh.yawGroup.quaternion);
    if (pitchGroup !== undefined) {
      this.fixedMuzzleQuaternion.multiply(pitchGroup.quaternion);
    }
    this.fixedMuzzleForward
      .set(1, 0, 0)
      .applyQuaternion(this.fixedMuzzleQuaternion)
      .normalize();

    turretMountCache.writeEmission(
      entityId,
      turretIdx,
      0,
      this.fixedMuzzlePosition.x,
      this.fixedMuzzlePosition.z,
      this.fixedMuzzlePosition.y,
      this.fixedMuzzleForward.x,
      this.fixedMuzzleForward.z,
      this.fixedMuzzleForward.y,
    );
  }

  /** Publish the one stationary firing socket of a rotating barrel cluster.
   * The spin group is deliberately absent from this transform chain: barrels
   * move through the socket, while bullets and muzzle effects do not orbit. */
  private writeFixedMultiBarrelMuzzle(
    turretMesh: TurretMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    entityId: number,
    turretIdx: number,
    turretMountCache: TurretMountCache3D,
  ): void {
    const muzzle = turretMesh.fixedMultiBarrelMuzzle;
    const pitchGroup = turretMesh.pitchGroup;
    if (muzzle === undefined || pitchGroup === undefined) return;

    this.fixedMuzzlePosition
      .set(muzzle.x, muzzle.y, muzzle.z)
      .applyQuaternion(pitchGroup.quaternion)
      .add(pitchGroup.position)
      .applyQuaternion(turretMesh.yawGroup.quaternion)
      .add(turretMesh.yawGroup.position)
      .applyQuaternion(turretMesh.root.quaternion)
      .add(turretMesh.root.position)
      .applyQuaternion(parentQuaternion)
      .add(parentPosition);
    this.fixedMuzzleQuaternion
      .copy(parentQuaternion)
      .multiply(turretMesh.root.quaternion)
      .multiply(turretMesh.yawGroup.quaternion)
      .multiply(pitchGroup.quaternion);
    this.fixedMuzzleForward
      .set(1, 0, 0)
      .applyQuaternion(this.fixedMuzzleQuaternion)
      .normalize();

    for (let lane = 0; lane < muzzle.laneCount; lane++) {
      turretMountCache.writeEmission(
        entityId,
        turretIdx,
        lane,
        this.fixedMuzzlePosition.x,
        this.fixedMuzzlePosition.z,
        this.fixedMuzzlePosition.y,
        this.fixedMuzzleForward.x,
        this.fixedMuzzleForward.z,
        this.fixedMuzzleForward.y,
      );
    }
    turretMountCache.writeForward(
      entityId,
      turretIdx,
      this.fixedMuzzleForward.x,
      this.fixedMuzzleForward.z,
      this.fixedMuzzleForward.y,
    );
  }

  private writeTurretTeamCollar(
    turretMesh: TurretMesh,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    entity: Entity,
    teamTrim: TeamTrimRenderer3D | null,
  ): void {
    const anchor = turretMesh.teamCollar;
    if (anchor === undefined || teamTrim === null) return;
    if (anchor.slot === undefined) {
      const slot = teamTrim.allocTurretCollar(anchor.radius, anchor.tier);
      if (slot < 0) return;
      anchor.slot = slot;
    }

    const pitchPosition = turretMesh.pitchGroup?.position;
    const pitchQuaternion = turretMesh.pitchGroup?.quaternion;
    this.anchorPosition
      .set(anchor.centerX, anchor.centerY, anchor.centerZ)
      .applyQuaternion(pitchQuaternion ?? this.scratchIdentityQuaternion)
      .add(pitchPosition ?? this.scratchZeroPosition)
      .applyQuaternion(turretMesh.yawGroup.quaternion)
      .add(turretMesh.yawGroup.position)
      .applyQuaternion(turretMesh.root.quaternion)
      .add(turretMesh.root.position)
      .applyQuaternion(parentQuaternion)
      .add(parentPosition);
    this.anchorQuaternion
      .copy(parentQuaternion)
      .multiply(turretMesh.root.quaternion)
      .multiply(turretMesh.yawGroup.quaternion)
      .multiply(pitchQuaternion ?? this.scratchIdentityQuaternion);
    teamTrim.setTurretCollar(
      anchor.slot,
      this.anchorPosition.x,
      this.anchorPosition.y,
      this.anchorPosition.z,
      this.anchorQuaternion,
      anchor.length,
      anchor.radius,
      entityTeamColorHex(entity),
    );
  }

  private enqueueBarrel(
    slot: number,
    useCone: boolean,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    root: THREE.Group,
    yawGroup: THREE.Group,
    pitchGroup: THREE.Group | undefined,
    spinGroup: THREE.Group | undefined,
    barrel: THREE.Mesh,
    entityId: number,
    turretIdx: number,
    laneIdx: number,
    pilotLightVisible: boolean,
    publishesEmission: boolean,
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
    writePositionQuaternion(input, base, parentPosition, parentQuaternion);
    input[base + 7] = root.position.x;
    input[base + 8] = root.position.y;
    input[base + 9] = root.position.z;
    // root supplies the fixed mount translation; yawGroup supplies the
    // logical turret body's rotation. root has no authored rotation, so the
    // batch can represent both scenegraph levels as this single transform.
    input[base + 10] = yawGroup.quaternion.x;
    input[base + 11] = yawGroup.quaternion.y;
    input[base + 12] = yawGroup.quaternion.z;
    input[base + 13] = yawGroup.quaternion.w;
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
    this.barrelEntityIds[index] = entityId;
    this.barrelTurretIndexes[index] = turretIdx;
    this.barrelLaneIndexes[index] = laneIdx;
    this.barrelPilotLightVisible[index] = pilotLightVisible;
    this.barrelPublishesEmission[index] = publishesEmission;
  }

  private ensureBarrelInputCapacity(count: number): void {
    const needed = count * TURRET_BARREL_INPUT_STRIDE;
    if (this.barrelInput.length >= needed) return;
    this.barrelInput = growFloat32Array(this.barrelInput, needed);
  }

  private ensureHeadInputCapacity(count: number): void {
    const needed = count * TURRET_HEAD_INPUT_STRIDE;
    if (this.headInput.length >= needed) return;
    this.headInput = growFloat32Array(this.headInput, needed);
  }

}
