import * as THREE from 'three';
import { getTurretHeadRadius } from '../math';
import { isConstructionPieceMaterialized } from '../sim/buildableHelpers';
import { getTurretMountHeight } from '../sim/combat/combatUtils';
import type { Entity, Turret } from '../sim/types';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import { entityHeadOnlyTurretHeadColorHex } from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import type { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretMesh } from './TurretMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import type { TurretMountCache3D } from './TurretMountCache3D';

export class UnitTurretPose3D {
  private readonly headMat = new THREE.Matrix4();
  private readonly barrelParentMat = new THREE.Matrix4();
  private readonly barrelStepMat = new THREE.Matrix4();
  private readonly barrelWorldMat = new THREE.Matrix4();
  private readonly headLocalPos = new THREE.Vector3();
  private readonly headWorldPos = new THREE.Vector3();
  private readonly oneVec = new THREE.Vector3(1, 1, 1);

  update(
    entity: Entity,
    mesh: EntityMesh,
    turrets: readonly Turret[],
    parentQuaternion: THREE.Quaternion,
    unitChainMat: THREE.Matrix4,
    chassisTiltInverse: THREE.Quaternion | undefined,
    barrelSpinEnabled: boolean,
    barrelSpinState: UnitBarrelSpinState3D,
    currentDtMs: number,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
    turretMountCache: TurretMountCache3D,
    constructionVisuals: ConstructionVisualController3D,
  ): void {
    for (let turretIdx = 0; turretIdx < mesh.turrets.length && turretIdx < turrets.length; turretIdx++) {
      const turretMesh = mesh.turrets[turretIdx];
      const turret = turrets[turretIdx];
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
      const visible = turret.hp > 0 && isConstructionPieceMaterialized(entity, 'turret', turretIdx);
      turretMesh.root.visible = visible;
      if (!visible) {
        unitDetailInstances.clearTurretSlots(turretMesh);
        continue;
      }

      const turretHeadCenterY = getTurretMountHeight(entity, turretIdx);
      const turretMountY = turretHeadCenterY - (mesh.chassisLift ?? 0) - headRadius;
      turretMesh.root.position.set(turret.mount.x, turretMountY, turret.mount.y);
      this.writeMountCache(entity, turretIdx, mesh, turretMesh, headRadius, parentQuaternion, turretMountCache);

      if (turretMesh.constructionEmitter) {
        turretMesh.root.visible = true;
        turretMesh.root.rotation.y = 0;
        if (turretMesh.pitchGroup) turretMesh.pitchGroup.rotation.z = 0;
        if (turretMesh.spinGroup) turretMesh.spinGroup.rotation.x = 0;
        constructionVisuals.updateBuilderConstructionEmitter(
          turretMesh.constructionEmitter,
          entity,
          currentDtMs,
        );
        continue;
      }

      if (!turret.config.headOnly) {
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
        const headColorOverride = turretMesh.headOnly
          ? entityHeadOnlyTurretHeadColorHex(entity, turret.state)
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
        unitChainMat,
        unitDetailInstances,
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
    unitChainMat: THREE.Matrix4,
    unitDetailInstances: UnitDetailInstanceRenderer3D,
  ): void {
    if (
      !turretMesh.barrelSlots ||
      turretMesh.barrels.length === 0 ||
      turretMesh.barrelSlots.length !== turretMesh.barrels.length
    ) {
      return;
    }

    this.barrelParentMat.copy(unitChainMat);
    this.barrelStepMat.compose(
      turretMesh.root.position,
      turretMesh.root.quaternion,
      this.oneVec,
    );
    this.barrelParentMat.multiply(this.barrelStepMat);

    if (turretMesh.pitchGroup) {
      this.barrelStepMat.compose(
        turretMesh.pitchGroup.position,
        turretMesh.pitchGroup.quaternion,
        this.oneVec,
      );
      this.barrelParentMat.multiply(this.barrelStepMat);
    }
    if (turretMesh.spinGroup) {
      this.barrelStepMat.compose(
        turretMesh.spinGroup.position,
        turretMesh.spinGroup.quaternion,
        this.oneVec,
      );
      this.barrelParentMat.multiply(this.barrelStepMat);
    }

    for (let barrelIdx = 0; barrelIdx < turretMesh.barrels.length; barrelIdx++) {
      const barrel = turretMesh.barrels[barrelIdx];
      const slot = turretMesh.barrelSlots[barrelIdx];
      this.barrelStepMat.compose(
        barrel.position,
        barrel.quaternion,
        barrel.scale,
      );
      this.barrelWorldMat.multiplyMatrices(this.barrelParentMat, this.barrelStepMat);
      unitDetailInstances.writeBarrelMatrix(
        slot,
        this.barrelWorldMat,
        turretMesh.barrelUsesCone === true,
      );
    }
  }
}
