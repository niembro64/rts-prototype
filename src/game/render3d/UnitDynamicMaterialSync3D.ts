import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import { entityShieldSphereTurretHeadColorHex } from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import type { EntityMaterialPalette3D } from './EntityMaterialPalette3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export function syncUnitDynamicMaterials3D(params: {
  entity: Entity;
  mesh: EntityMesh;
  turrets: readonly Turret[];
  currentTimeMs: number;
  materialPalette: EntityMaterialPalette3D;
  unitDetailInstances: UnitDetailInstanceRenderer3D;
}): void {
  const {
    entity,
    mesh,
    turrets,
    currentTimeMs,
    materialPalette,
    unitDetailInstances,
  } = params;
  unitDetailInstances.syncEntityColors(entity, mesh, turrets);

  const ownerId = entity.ownership?.playerId;
  let headOnlyStates = mesh.unitHeadOnlyTurretEngaged;
  let dynamicHeadColors = mesh.unitDynamicTurretHeadColorHex;
  for (let i = 0; i < mesh.turrets.length; i++) {
    const turretMesh = mesh.turrets[i];
    if (!turretMesh.head) continue;
    if (turretMesh.shieldEmitterCore === true) {
      const colorHex = entityShieldSphereTurretHeadColorHex(
        entity,
        turrets[i],
        currentTimeMs,
      );
      if (dynamicHeadColors !== undefined && dynamicHeadColors[i] === colorHex) continue;
      if (dynamicHeadColors === undefined) {
        dynamicHeadColors = [];
        mesh.unitDynamicTurretHeadColorHex = dynamicHeadColors;
      }
      dynamicHeadColors[i] = colorHex;
      const mat = turretMesh.shieldEmitterPulseMat ?? turretMesh.head.material;
      if (Array.isArray(mat)) continue;
      const colorMat = mat as THREE.Material & { color?: THREE.Color };
      if (colorMat.color instanceof THREE.Color) colorMat.color.set(colorHex);
      continue;
    }
    if (turretMesh.headOnly === true && turretMesh.barrelFollowsBeam !== true) {
      const engaged = turrets[i]?.state === 'engaged';
      if (headOnlyStates !== undefined && headOnlyStates[i] === engaged) continue;
      if (headOnlyStates === undefined) {
        headOnlyStates = [];
        mesh.unitHeadOnlyTurretEngaged = headOnlyStates;
      }
      headOnlyStates[i] = engaged;
      turretMesh.head.material = engaged
        ? materialPalette.getTurretAccentMat(ownerId)
        : materialPalette.getPrimaryMat(ownerId);
    }
  }
}
