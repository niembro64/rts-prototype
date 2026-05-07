import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfigFor } from '@/clientBarConfig';
import {
  buildBuildingShape,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  buildTurretMesh3D,
  type TurretMesh,
} from './TurretMesh3D';

export type BuildingEntityMeshFactoryOptions = {
  entity: Entity;
  width: number;
  depth: number;
  ownerId: PlayerId | undefined;
  globalGraphicsTier: ConcreteGraphicsQuality;
  lodKey: string;
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
};

export function createBuildingEntityMesh3D(options: BuildingEntityMeshFactoryOptions): EntityMesh {
  const {
    entity,
    width,
    depth,
    ownerId,
    globalGraphicsTier,
    lodKey,
    world,
    turretHeadGeom,
    barrelGeom,
    barrelMat,
    getPrimaryMat,
  } = options;
  const shapeType: BuildingShapeType = entity.buildingType
    ? getBuildingConfig(entity.buildingType).renderProfile
    : 'unknown';
  const group = new THREE.Group();
  group.userData.entityId = entity.id;

  const shape = buildBuildingShape(shapeType, width, depth, getPrimaryMat(ownerId));
  shape.primary.userData.entityId = entity.id;

  const chassis = new THREE.Group();
  chassis.userData.entityId = entity.id;
  chassis.add(shape.primary);
  group.add(chassis);

  for (const detail of shape.details) {
    detail.mesh.userData.entityId = entity.id;
    group.add(detail.mesh);
  }

  if (shape.factoryRig?.group) {
    shape.factoryRig.group.userData.entityId = entity.id;
    shape.factoryRig.group.traverse((obj) => {
      obj.userData.entityId = entity.id;
    });
    group.add(shape.factoryRig.group);
  }

  const buildingTurretMeshes: TurretMesh[] = [];
  const buildingTurrets = entity.combat?.turrets;
  if (buildingTurrets) {
    // Use the GLOBAL gfx tier, not the per-entity distance tier, when
    // building the turret. Distance-LOD can briefly drop a tower to
    // marker/min while the camera is framing in, and the building mesh
    // is cached forever after that.
    const buildingTurretTier =
      shapeType === 'megaBeamTower' && globalGraphicsTier === 'min'
        ? 'low'
        : globalGraphicsTier;
    const buildingGfx = getGraphicsConfigFor(buildingTurretTier);
    for (let ti = 0; ti < buildingTurrets.length; ti++) {
      const turret = buildingTurrets[ti];
      if (turret.config.constructionEmitter) {
        // Construction emitter renders via factoryRig. Push an empty
        // placeholder so building turret indices stay aligned with
        // combat.turrets indices.
        buildingTurretMeshes.push({ root: new THREE.Group(), barrels: [] });
        continue;
      }
      const turretMesh = buildTurretMesh3D(group, turret, buildingGfx, {
        headGeom: turretHeadGeom,
        barrelGeom,
        barrelMat,
        primaryMat: getPrimaryMat(ownerId),
      });
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      for (const barrel of turretMesh.barrels) barrel.userData.entityId = entity.id;
      buildingTurretMeshes.push(turretMesh);
    }
  }

  world.add(group);

  return {
    group,
    chassis,
    chassisMeshes: [shape.primary],
    // Buildings don't use unit body-shape pools (they have their own
    // BuildingShape3D path), so the field is unused here.
    bodyShapeKey: '',
    turrets: buildingTurretMeshes,
    lodKey,
    buildingDetails: shape.details,
    factoryRig: shape.factoryRig,
    windRig: shape.windRig,
    extractorRig: shape.extractorRig,
    solarRig: shape.solarRig,
    buildingHeight: shape.height,
    buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
    solarOpenAmount: entity.building?.solar?.open === false ? 0 : 1,
  };
}
