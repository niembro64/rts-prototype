// Contract: a structure's turrets are aimed at the middle of the map when the
// site is placed, and they never restore to a rest angle afterwards.
//
// See budget_design_philosophy.html — "A building turret has no rest angle".

import { normalizeAngle } from '../math/MathHelpers';
import { updateTurretRotation } from './combat/turretSystem';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { aimBuildingTurretsAtMapCenter } from './runtimeTurrets';
import type { BuildingBlueprintId, Entity, PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building turret rest] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(normalizeAngle(actual - expected)) > 1e-6) {
    throw new Error(`[building turret rest] ${message}: expected ${expected}, got ${actual}`);
  }
}

function placeTower(
  world: WorldState,
  blueprintId: BuildingBlueprintId,
  x: number,
  y: number,
  rotation: number,
): Entity {
  const tower = world.createBuilding(x, y, 60, 60, 60, 1 as PlayerId, rotation);
  applyBuildingBlueprintRuntime(tower, blueprintId, {
    allocateEntityId: () => world.generateEntityId(),
  });
  aimBuildingTurretsAtMapCenter(tower, world.mapWidth, world.mapHeight);
  world.addEntity(tower);
  return tower;
}

export function runBuildingTurretRestContractTest(): void {
  const world = new WorldState(6337, 1024, 1024);

  // A tower in the south-west corner faces north-east, toward the middle.
  const tower = placeTower(world, 'towerCannon', 200, 200, 0);
  assertContract(tower.combat !== null, 'an armed tower must have a combat component');
  const turret = tower.combat.turrets[0];
  assertNear(
    turret.rotation,
    Math.atan2(512 - 200, 512 - 200),
    'a placed tower must aim its turret at the middle of the map',
  );

  // The host's own facing is not the bearing: a rotated tower still faces the
  // centre, so the local yaw absorbs the host rotation.
  const rotated = placeTower(world, 'towerCannon', 800, 200, Math.PI / 3);
  assertContract(rotated.combat !== null, 'a rotated armed tower must have a combat component');
  const rotatedTurret = rotated.combat.turrets[0];
  assertNear(
    normalizeAngle(rotated.transform.rotation + rotatedTurret.localYaw),
    Math.atan2(512 - 200, 512 - 800),
    'a rotated tower must still aim its turret at the middle of the map',
  );

  // With nothing to shoot at, the turret holds its bearing forever — well past
  // any restore delay a chassis would have obeyed.
  const heldYaw = turret.rotation;
  const restoreDelayMs = turret.config.articulation.restoreDelayMs;
  const stepMs = 100;
  for (let elapsed = 0; elapsed < restoreDelayMs * 3 + stepMs; elapsed += stepMs) {
    updateTurretRotation(world, stepMs, [tower]);
  }
  assertNear(
    turret.rotation,
    heldYaw,
    'an idle building turret must hold its bearing instead of restoring',
  );
  assertContract(
    Math.abs(normalizeAngle(turret.rotation - tower.transform.rotation)) > 1e-3,
    'the held bearing must be the map-centre aim, not the host facing',
  );
}
