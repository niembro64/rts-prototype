import {
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { createProjectileConfigFromShot } from './projectileConfigs';
import { spatialGrid } from './SpatialGrid';
import { WorldState } from './WorldState';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { createBuildable } from './buildableHelpers';
import {
  ENTITY_SLOT_BUILD_FLAG_COMPLETE,
  ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE,
  entitySlotRegistry,
} from './EntitySlotRegistry';
import type { BuildingBlueprintId, Entity, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity slot registry] ${message}`);
  }
}

function requireViews() {
  const views = entitySlotRegistry.getViews();
  assertContract(views !== null, 'entity-state views must be available after sim-wasm init');
  return views;
}

function assertParity(entity: Entity): void {
  entitySlotRegistry.assertParity(entity);
}

export function runEntitySlotRegistryContractTest(): void {
  spatialGrid.clear();

  const world = new WorldState(9901, 512, 512);
  world.playerCount = 2;

  const first = world.createUnitFromBlueprint(100, 120, 1 as PlayerId, 'unitJackal');
  world.addEntity(first);
  spatialGrid.updateUnit(first);
  const firstSlot = entitySlotRegistry.getSlot(first.id);
  assertContract(firstSlot >= 0, 'added unit must receive a stable slot');
  assertContract(first.entitySlotId === firstSlot, 'added unit must cache its stable slot');
  assertContract(entitySlotRegistry.getEntitySlot(first) === firstSlot, 'entity slot helper must read cached slot');
  assertParity(first);

  world.setEntityOwner(first, 2 as PlayerId);
  const viewsAfterOwner = requireViews();
  assertContract(viewsAfterOwner.ownerPlayerId[firstSlot] === 2, 'owner transfer must update owner column');
  assertContract(viewsAfterOwner.teamId[firstSlot] === 2, 'owner transfer must update team column');
  assertParity(first);

  world.removeEntity(first.id);
  assertContract(entitySlotRegistry.getSlot(first.id) === -1, 'removed entity must clear id->slot mapping');
  assertContract(first.entitySlotId === -1, 'removed entity must clear cached stable slot');
  const viewsAfterRemove = requireViews();
  assertContract(viewsAfterRemove.entityId[firstSlot] === -1, 'removed entity must clear slab entity id');

  const reused = world.createUnitFromBlueprint(140, 120, 1 as PlayerId, 'unitJackal');
  world.addEntity(reused);
  spatialGrid.updateUnit(reused);
  assertContract(
    entitySlotRegistry.getSlot(reused.id) === firstSlot,
    'slot allocator must reuse freed spatial/entity slots',
  );
  assertContract(reused.entitySlotId === firstSlot, 'reused entity must cache reused stable slot');
  assertParity(reused);

  assertContract(reused.unit !== null, 'reused unit must have a unit component');
  reused.transform.x = 165;
  reused.transform.y = 145;
  reused.transform.z = 22;
  reused.transform.rotation = 0.75;
  reused.unit.velocityX = 4.5;
  reused.unit.velocityY = -2.25;
  reused.unit.velocityZ = 1.5;
  reused.unit.surfaceNormal.nx = 0.25;
  reused.unit.surfaceNormal.ny = -0.5;
  reused.unit.surfaceNormal.nz = 0.82915619758885;
  reused.unit.orientation = { x: 0.1, y: 0.2, z: 0.3, w: 0.9273618495495703 };
  reused.unit.angularVelocity3 = { x: 0.01, y: -0.02, z: 0.03 };
  world.markSnapshotDirty(
    reused.id,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
  );
  const motionViews = requireViews();
  assertContract(motionViews.posX[firstSlot] === 165, 'motion dirty update must refresh position x');
  assertContract(motionViews.velY[firstSlot] === -2.25, 'motion dirty update must refresh velocity y');
  assertContract(motionViews.surfaceNormalX[firstSlot] === 0.25, 'motion dirty update must refresh normal x');
  assertContract(motionViews.orientationZ[firstSlot] === 0.3, 'motion dirty update must refresh orientation z');
  assertContract(
    motionViews.angularVelocityY[firstSlot] === -0.02,
    'motion dirty update must refresh angular velocity y',
  );
  assertParity(reused);

  const building = world.createBuilding(
    220,
    160,
    80,
    100,
    60,
    1 as PlayerId,
  );
  building.buildingBlueprintId = 'buildingSolar' as BuildingBlueprintId;
  building.buildable = createBuildable({ energy: 100, metal: 100 });
  building.buildable.paid.energy = 50;
  building.buildable.paid.metal = 100;
  world.addEntity(building);
  spatialGrid.addBuilding(building);
  const buildingSlot = entitySlotRegistry.getSlot(building.id);
  assertContract(buildingSlot >= 0, 'building must receive a slot');
  assertContract(building.entitySlotId === buildingSlot, 'building must cache its stable slot');
  const buildingViews = requireViews();
  assertContract(
    buildingViews.posZ[buildingSlot] === getBuildingCombatCenterZ(building),
    'building slab z must mirror combat center z',
  );
  assertContract(
    buildingViews.aabbHx[buildingSlot] === 40 &&
    buildingViews.aabbHy[buildingSlot] === 50 &&
    buildingViews.aabbHz[buildingSlot] === 30,
    'building slab AABB half extents must mirror building dimensions',
  );
  const buildingLineQuery = spatialGrid.queryBuildingSlotsAlongLine(
    0, 160, getBuildingCombatCenterZ(building),
    400, 160, getBuildingCombatCenterZ(building),
    1,
  );
  let foundBuildingSlot = false;
  for (let i = 0; i < buildingLineQuery.count; i++) {
    if (buildingLineQuery.slots[i] === buildingSlot) {
      foundBuildingSlot = true;
      break;
    }
  }
  assertContract(foundBuildingSlot, 'building line query must expose stable building slots');
  assertContract(
    Math.abs(buildingViews.buildProgress[buildingSlot] - 0.75) < 1e-9,
    'building build progress must mirror paid resource fraction',
  );
  assertContract(
    (buildingViews.buildFlags[buildingSlot] & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0,
    'incomplete building must carry buildable flag',
  );
  assertParity(building);

  assertContract(building.building !== null, 'test building must have a building component');
  building.buildable = null;
  building.building.hp = building.building.maxHp;
  world.markSnapshotDirty(building.id, ENTITY_CHANGED_BUILDING | ENTITY_CHANGED_HP);
  const completedViews = requireViews();
  assertContract(
    (completedViews.buildFlags[buildingSlot] & ENTITY_SLOT_BUILD_FLAG_COMPLETE) !== 0,
    'completed building must carry complete build flag',
  );
  assertContract(
    (completedViews.buildFlags[buildingSlot] & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) === 0,
    'completed building must clear buildable flag',
  );
  assertParity(building);

  const projectileConfig = createProjectileConfigFromShot('shotPlasmaLight');
  const projectile = world.createProjectile(
    40,
    60,
    20,
    10,
    1 as PlayerId,
    reused.id,
    projectileConfig,
  );
  world.addEntity(projectile);
  spatialGrid.updateProjectile(projectile);
  const projectileSlot = entitySlotRegistry.getSlot(projectile.id);
  assertContract(projectileSlot >= 0, 'projectile must receive a slot');
  assertContract(projectile.entitySlotId === projectileSlot, 'projectile must cache its stable slot');
  assertParity(projectile);

  projectile.transform.x = 70;
  projectile.transform.y = 90;
  projectile.transform.z = 12;
  projectile.projectile!.velocityX = 4;
  projectile.projectile!.velocityY = -3;
  projectile.projectile!.velocityZ = 2;
  spatialGrid.updateProjectiles([projectile]);
  const projectileViews = requireViews();
  assertContract(projectileViews.posX[projectileSlot] === 70, 'projectile batch must update x');
  assertContract(projectileViews.velY[projectileSlot] === -3, 'projectile batch must update velocity');
  const enemyProjectileSlots = spatialGrid.queryEnemyProjectileSlotsInRadius(
    70, 90, 12, 100, 2 as PlayerId,
  );
  let foundEnemyProjectileSlot = false;
  for (let i = 0; i < enemyProjectileSlots.count; i++) {
    if (enemyProjectileSlots.slots[i] === projectileSlot) {
      foundEnemyProjectileSlot = true;
      break;
    }
  }
  assertContract(foundEnemyProjectileSlot, 'enemy projectile radius query must expose stable projectile slots');
  const alliedProjectileSlots = spatialGrid.queryEnemyProjectileSlotsInRadius(
    70, 90, 12, 100, 1 as PlayerId,
  );
  for (let i = 0; i < alliedProjectileSlots.count; i++) {
    assertContract(
      alliedProjectileSlots.slots[i] !== projectileSlot,
      'enemy projectile radius query must exclude the requesting player projectiles',
    );
  }
  assertParity(projectile);

  spatialGrid.removeProjectile(projectile.id);
  assertContract(
    entitySlotRegistry.getSlot(projectile.id) === projectileSlot,
    'spatial projectile removal must keep canonical entity slot until world removal',
  );
  world.removeEntity(projectile.id);
  assertContract(entitySlotRegistry.getSlot(projectile.id) === -1, 'projectile world removal must free slot');
  assertContract(projectile.entitySlotId === -1, 'projectile world removal must clear cached slot');
}
