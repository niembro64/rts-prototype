import * as THREE from 'three';
import { getTurretHeadRadius } from '../math';
import type { Entity, Turret } from '../sim/types';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import {
  entityHeadOnlyTurretHeadColorHex,
  entityShieldSphereTurretHeadColorHex,
} from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import { applyTurretAimPose3D, applyTurretAimWorldDir3D } from './TurretAimPose3D';
import type { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
import type { TurretMesh } from './TurretMesh3D';
import {
  TURRET_BARREL_INPUT_STRIDE,
  UnitTurretBarrelMatrixBatch3D,
} from './UnitTurretBarrelMatrixBatch3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import type { TurretMountCache3D } from './TurretMountCache3D';

export class UnitTurretPose3D {
  private readonly headMat = new THREE.Matrix4();
  private readonly headLocalPos = new THREE.Vector3();
  private readonly headWorldPos = new THREE.Vector3();
  private readonly batch = new UnitTurretBarrelMatrixBatch3D();
  private input = new Float32Array(TURRET_BARREL_INPUT_STRIDE * 2048);
  private count = 0;
  private readonly barrelSlots: number[] = [];
  private readonly barrelUsesCone: boolean[] = [];

  begin(): void {
    this.count = 0;
    this.barrelSlots.length = 0;
    this.barrelUsesCone.length = 0;
  }

  update(
    entity: Entity,
    mesh: EntityMesh,
    turrets: readonly Turret[],
    bodyMaterialized: boolean,
    bodyCenterHeight: number,
    parentPosition: THREE.Vector3,
    parentQuaternion: THREE.Quaternion,
    chassisTiltInverse: THREE.Quaternion | undefined,
    barrelSpinEnabled: boolean,
    barrelSpinState: UnitBarrelSpinState3D,
    currentDtMs: number,
    timeMs: number,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
    turretBeamAimCache: TurretBeamAimCache3D,
    constructionVisuals: ConstructionVisualController3D,
  ): void {
    for (let turretIdx = 0; turretIdx < mesh.turrets.length && turretIdx < turrets.length; turretIdx++) {
      const turretMesh = mesh.turrets[turretIdx];
      const turret = turrets[turretIdx];
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
      const visible = bodyMaterialized;
      turretMesh.root.visible = visible;
      if (!visible) {
        unitDetailInstances.clearTurretSlots(turretMesh);
        continue;
      }

      const turretHeadCenterY = Number.isFinite(turret.mount.z)
        ? turret.mount.z
        : bodyCenterHeight;
      const turretMountY = turretHeadCenterY - (mesh.chassisLift ?? 0) - headRadius;
      turretMesh.root.position.set(turret.mount.x, turretMountY, turret.mount.y);
      this.writeMountCache(entity, turretIdx, mesh, turretMesh, headRadius, parentQuaternion, turretMountCache);

      if (turretMesh.constructionEmitter) {
        turretMesh.root.visible = true;
        applyTurretAimPose3D(
          turretMesh,
          entity.transform.rotation,
          turret.rotation,
          0,
          chassisTiltInverse,
        );
        if (turretMesh.pitchGroup) turretMesh.pitchGroup.rotation.z = 0;
        if (turretMesh.spinGroup) turretMesh.spinGroup.rotation.x = 0;
        constructionVisuals.updateBuilderConstructionEmitter(
          turretMesh.constructionEmitter,
          entity,
          currentDtMs,
        );
        continue;
      }

      if (turretMesh.barrelFollowsBeam) {
        // Beam turret: aim the barrel + head along the last beam fired
        // (frozen at the last direction when not firing). Sim turret aim
        // is pinned to zero on the wire for these, so fall back to the
        // forward idle pose until the first beam is cached.
        const beamDir = turretBeamAimCache.get(entity.id, turretIdx);
        if (beamDir) {
          applyTurretAimWorldDir3D(
            turretMesh,
            entity.transform.rotation,
            beamDir.x,
            beamDir.y,
            beamDir.z,
            chassisTiltInverse,
          );
        } else {
          applyTurretAimPose3D(
            turretMesh,
            entity.transform.rotation,
            turret.rotation,
            turret.pitch,
            chassisTiltInverse,
          );
        }
        // Beam barrels never spin.
        if (turretMesh.spinGroup) turretMesh.spinGroup.rotation.x = 0;
      } else if (!turret.config.headOnly) {
        applyTurretAimPose3D(
          turretMesh,
          entity.transform.rotation,
          turret.rotation,
          turret.pitch,
          chassisTiltInverse,
        );
        if (turretMesh.spinGroup) {
          turretMesh.spinGroup.rotation.x = barrelSpinEnabled
            ? barrelSpinState.angleFor(entity.id, turretIdx) ?? 0
            : 0;
        }
      }

      if (
        turretMesh.headSlot !== undefined &&
        turretMesh.headRadius !== undefined
      ) {
        const headColorOverride = turretMesh.headOnly && !turretMesh.barrelFollowsBeam
          ? entityHeadOnlyTurretHeadColorHex(entity, turret.state)
          : turretMesh.shieldEmitterCore
            ? entityShieldSphereTurretHeadColorHex(entity, turret, timeMs)
            : undefined;
        this.writeHeadInstance(
          entity,
          mesh,
          turretMesh,
          parentQuaternion,
          unitDetailInstances,
          headColorOverride,
        );
      }

      this.writeBarrelInstances(
        turretMesh,
        parentPosition,
        parentQuaternion,
      );
    }
  }

  flush(unitDetailInstances: UnitDetailInstanceRenderer3D): void {
    const count = this.count;
    if (count <= 0) return;

    const input = this.batch.begin(count);
    input.set(this.input.subarray(0, count * TURRET_BARREL_INPUT_STRIDE));
    const output = this.batch.compute(count);
    const outputStride = this.batch.outputStride;

    for (let i = 0; i < count; i++) {
      unitDetailInstances.writeBarrelMatrixArray(
        this.barrelSlots[i],
        output,
        i * outputStride,
        this.barrelUsesCone[i],
      );
    }
  }

  private writeHeadInstance(
    entity: Entity,
    mesh: EntityMesh,
    turretMesh: TurretMesh,
    parentQuaternion: THREE.Quaternion,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    colorOverride: number | undefined,
  ): void {
    const liftPos = mesh.liftGroup?.position;
    const headRadius = turretMesh.headRadius;
    if (headRadius === undefined || turretMesh.headSlot === undefined) return;
    this.headLocalPos.set(
      (liftPos?.x ?? 0) + turretMesh.root.position.x,
      (liftPos?.y ?? (mesh.chassisLift ?? 0)) + turretMesh.root.position.y + headRadius,
      (liftPos?.z ?? 0) + turretMesh.root.position.z,
    );
    this.headLocalPos.applyQuaternion(parentQuaternion);
    this.headWorldPos.copy(mesh.group.position).add(this.headLocalPos);
    this.headMat.makeScale(headRadius, headRadius, headRadius);
    this.headMat.setPosition(this.headWorldPos);
    unitDetailInstances.writeTurretHeadMatrix(
      turretMesh.headSlot,
      this.headMat,
      entity,
      colorOverride,
    );
  }

  private writeMountCache(
    entity: Entity,
    turretIdx: number,
    mesh: EntityMesh,
    turretMesh: TurretMesh,
    headRadius: number,
    parentQuaternion: THREE.Quaternion,
    turretMountCache: TurretMountCache3D,
  ): void {
    const liftPos = mesh.liftGroup?.position;
    this.headLocalPos.set(
      (liftPos?.x ?? 0) + turretMesh.root.position.x,
      (liftPos?.y ?? (mesh.chassisLift ?? 0)) + turretMesh.root.position.y + headRadius,
      (liftPos?.z ?? 0) + turretMesh.root.position.z,
    );
    this.headLocalPos.applyQuaternion(parentQuaternion);
    this.headWorldPos.copy(mesh.group.position).add(this.headLocalPos);
    turretMountCache.write(
      entity.id,
      turretIdx,
      this.headWorldPos.x,
      this.headWorldPos.z,
      this.headWorldPos.y,
    );
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
    const index = this.count;
    this.count++;
    this.ensureInputCapacity(this.count);

    const pitchPos = pitchGroup?.position;
    const pitchQuat = pitchGroup?.quaternion;
    const spinPos = spinGroup?.position;
    const spinQuat = spinGroup?.quaternion;
    const base = index * TURRET_BARREL_INPUT_STRIDE;
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

  private ensureInputCapacity(count: number): void {
    const needed = count * TURRET_BARREL_INPUT_STRIDE;
    if (this.input.length >= needed) return;
    let next = this.input.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.input);
    this.input = expanded;
  }
}
