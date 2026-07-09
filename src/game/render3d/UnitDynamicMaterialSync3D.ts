import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import { entityShieldSphereTurretHeadColorHex } from './EntityInstanceColor3D';
import type { EntityMesh } from './EntityMesh3D';
import type { EntityMaterialPalette3D } from './EntityMaterialPalette3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export function unitHasSteadyDynamicMaterialWork3D(mesh: EntityMesh): boolean {
  const cached = mesh.unitHasSteadyDynamicMaterialWork;
  if (cached !== undefined) return cached;
  for (let i = 0; i < mesh.turrets.length; i++) {
    if (mesh.turrets[i].shieldEmitterCore === true) {
      mesh.unitHasSteadyDynamicMaterialWork = true;
      return true;
    }
  }
  mesh.unitHasSteadyDynamicMaterialWork = false;
  return false;
}

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
      const primaryMat = materialPalette.getPrimaryMat(ownerId);
      if (turretMesh.cachedHeadMaterial === primaryMat) continue;
      turretMesh.head.material = primaryMat;
      turretMesh.cachedHeadMaterial = primaryMat;
    }
  }
}
