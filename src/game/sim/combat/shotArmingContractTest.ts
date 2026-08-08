import type { BuildingBlueprintId, PlayerId } from '../types';
import type { ShotBlueprintId } from '../../../types/blueprintIds';
import { BUILD_GRID_CELL_SIZE } from '../buildGrid';
import { applyBuildingBlueprintRuntime } from '../buildingEntityRuntime';
import {
  BUILDING_BLUEPRINTS,
  SHOT_BLUEPRINTS,
  UNIT_BLUEPRINTS,
} from '../blueprints';
import {
  createEntityVolume,
  getShotArmingHitVolumeScale,
  SHOT_ARMING_MIN_HIT_VOLUME_SCALE,
  writeArmingVolume,
  writeHitVolume,
} from '../entityVolumes';
import { createProjectileConfigFromShot } from '../projectileConfigs';
import { WorldState } from '../WorldState';
import { updateProjectileArming } from './shotArming';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[shot arming contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`[shot arming contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

function assertShapeMatchedArmVolume(
  label: string,
  entity: Parameters<typeof writeHitVolume>[0],
): void {
  const hit = createEntityVolume();
  const arm = createEntityVolume();
  assertContract(writeHitVolume(entity, hit), `${label} must publish HIT geometry`);
  assertContract(writeArmingVolume(entity, arm), `${label} must publish ARM geometry`);
  assertContract(arm.shape === hit.shape, `${label} ARM must use the HIT shape`);
  assertNear(arm.x, hit.x, `${label} ARM/HIT center x`);
  assertNear(arm.y, hit.y, `${label} ARM/HIT center y`);
  assertNear(arm.z, hit.z, `${label} ARM/HIT center z`);
  const scale = getShotArmingHitVolumeScale(entity);
  assertContract(
    scale >= SHOT_ARMING_MIN_HIT_VOLUME_SCALE,
    `${label} ARM scale must retain the minimum safety margin`,
  );
  assertNear(
    arm.halfX,
    hit.halfX * scale,
    `${label} ARM x extent`,
  );
  assertNear(
    arm.halfY,
    hit.halfY * scale,
    `${label} ARM y extent`,
  );
  assertNear(
    arm.halfZ,
    hit.halfZ * scale,
    `${label} ARM z extent`,
  );
  assertContract(
    arm.halfX > hit.halfX && arm.halfY > hit.halfY && arm.halfZ > hit.halfZ,
    `${label} ARM must strictly contain HIT on every axis`,
  );
}

export function runShotArmingContractTest(): void {
  const world = new WorldState(5323, 2048, 2048);

  // Exhaust the unit roster, not a hand-picked firing subset. New entities
  // automatically enter this contract because ARM is derived from HIT.
  for (const unitBlueprintId of Object.keys(UNIT_BLUEPRINTS)) {
    const host = world.createUnitFromBlueprint(
      512,
      512,
      1 as PlayerId,
      unitBlueprintId,
      { allocateSubEntityIds: false },
    );
    assertShapeMatchedArmVolume(`unit ${unitBlueprintId}`, host);
  }

  // Buildings use combat boxes, so ARM must be an enlarged box rather than
  // the old footprint-diagonal sphere. Include utility-only buildings too.
  for (const [buildingBlueprintId, blueprint] of Object.entries(BUILDING_BLUEPRINTS)) {
    const host = world.createBuilding(
      1024,
      1024,
      blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
      blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
      blueprint.gridDepth * BUILD_GRID_CELL_SIZE,
      1 as PlayerId,
    );
    applyBuildingBlueprintRuntime(host, buildingBlueprintId as BuildingBlueprintId);
    assertShapeMatchedArmVolume(`building ${buildingBlueprintId}`, host);
  }

  // Every authored traveling-shot family—including ground plasma, rockets,
  // both missiles, torpedoes, and submunitions—uses the same factory state.
  for (const shotBlueprintId of Object.keys(SHOT_BLUEPRINTS) as ShotBlueprintId[]) {
    const shot = world.createProjectile(
      512,
      512,
      1,
      0,
      1 as PlayerId,
      1,
      createProjectileConfigFromShot(shotBlueprintId),
      'projectile',
      { shotBlueprintId },
    );
    assertContract(shot.projectile !== null, `${shotBlueprintId} must create a projectile body`);
    assertContract(!shot.projectile.isArmed, `${shotBlueprintId} must begin deactivated`);
  }

  const sphereHost = world.createUnitFromBlueprint(
    120,
    140,
    1 as PlayerId,
    'unitFormik',
    { allocateSubEntityIds: false },
  );
  assertContract(sphereHost.unit !== null, 'sphere ARM fixture must be a unit');
  sphereHost.unit.radius.hitbox = 10 / SHOT_ARMING_MIN_HIT_VOLUME_SCALE;
  sphereHost.unit.radius.collision = sphereHost.unit.radius.hitbox;
  const shotHitboxRadius = 2;
  const sphereProjectile = {
    projectileType: 'projectile',
    isArmed: false,
    collisionStartX: null,
    collisionStartY: null,
    collisionStartZ: null,
  };
  const sphereCenterX = sphereHost.transform.x;
  const sphereCenterY = sphereHost.transform.y;
  const sphereCenterZ = sphereHost.transform.z;

  const armedInsideSphere = updateProjectileArming(
    sphereProjectile,
    sphereHost,
    sphereCenterX, sphereCenterY, sphereCenterZ,
    sphereCenterX + 11, sphereCenterY, sphereCenterZ,
    shotHitboxRadius,
  );
  assertContract(
    !armedInsideSphere && !sphereProjectile.isArmed,
    'shot must remain inert while any hitbox extent overlaps spherical ARM',
  );

  const armedOutsideSphere = updateProjectileArming(
    sphereProjectile,
    sphereHost,
    sphereCenterX + 11, sphereCenterY, sphereCenterZ,
    sphereCenterX + 13, sphereCenterY, sphereCenterZ,
    shotHitboxRadius,
  );
  assertContract(
    armedOutsideSphere && sphereProjectile.isArmed,
    'shot must activate after its full hitbox exits spherical ARM',
  );
  assertNear(
    sphereProjectile.collisionStartX ?? NaN,
    sphereCenterX + 12,
    'first active sphere sweep must begin at the ARM crossing',
  );

  const boxHost = world.createBuilding(300, 320, 40, 20, 10, 1 as PlayerId);
  const boxProjectile = {
    projectileType: 'projectile',
    isArmed: false,
    collisionStartX: null,
    collisionStartY: null,
    collisionStartZ: null,
  };
  const boxCenterZ = boxHost.transform.z;
  const boxArmHalfX = 20 * SHOT_ARMING_MIN_HIT_VOLUME_SCALE;
  const armedInsideBox = updateProjectileArming(
    boxProjectile,
    boxHost,
    300, 320, boxCenterZ,
    300 + boxArmHalfX + shotHitboxRadius - 0.5, 320, boxCenterZ,
    shotHitboxRadius,
  );
  assertContract(
    !armedInsideBox && !boxProjectile.isArmed,
    'ground-fired shot must remain inert while its hitbox overlaps box ARM',
  );
  const armedOutsideBox = updateProjectileArming(
    boxProjectile,
    boxHost,
    300 + boxArmHalfX + shotHitboxRadius - 0.5, 320, boxCenterZ,
    300 + boxArmHalfX + shotHitboxRadius + 0.5, 320, boxCenterZ,
    shotHitboxRadius,
  );
  assertContract(
    armedOutsideBox && boxProjectile.isArmed,
    'ground-fired shot must activate only after fully clearing box ARM',
  );
  assertNear(
    boxProjectile.collisionStartX ?? NaN,
    300 + boxArmHalfX + shotHitboxRadius,
    'first active box sweep must begin at the full-hitbox ARM crossing',
  );
}
