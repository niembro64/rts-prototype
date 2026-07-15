import type { PlayerId } from '../types';
import { WorldState } from '../WorldState';
import {
  getShotArmingClearanceRadius,
  updateProjectileArming,
} from './shotArming';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[shot arming contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`[shot arming contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

export function runShotArmingContractTest(): void {
  const world = new WorldState(5323, 512, 512);
  const host = world.createUnitFromBlueprint(120, 140, 1 as PlayerId, 'unitFormik');
  assertContract(host.unit !== null, 'ARM fixture must be a unit');

  const hostRadius = 10;
  const shotHitboxRadius = 2;
  assertNear(
    getShotArmingClearanceRadius(hostRadius, shotHitboxRadius),
    12,
    'activation distance must include the complete projectile hitbox',
  );

  const projectile = {
    projectileType: 'projectile',
    isArmed: false,
    shotArmingRadius: hostRadius,
    collisionStartX: null,
    collisionStartY: null,
    collisionStartZ: null,
  };
  const centerX = host.transform.x;
  const centerY = host.transform.y;
  const centerZ = host.transform.z;

  const armedInside = updateProjectileArming(
    projectile,
    host,
    centerX, centerY, centerZ,
    centerX + 11, centerY, centerZ,
    shotHitboxRadius,
  );
  assertContract(
    !armedInside && !projectile.isArmed,
    'shot must remain inert while any hitbox extent is inside ARM',
  );

  const armedOutside = updateProjectileArming(
    projectile,
    host,
    centerX + 11, centerY, centerZ,
    centerX + 13, centerY, centerZ,
    shotHitboxRadius,
  );
  assertContract(
    armedOutside && projectile.isArmed,
    'shot must activate after its full hitbox exits ARM',
  );
  assertNear(
    projectile.collisionStartX ?? NaN,
    centerX + 12,
    'first active collision sweep must begin at the exact ARM crossing',
  );
  assertNear(projectile.collisionStartY ?? NaN, centerY, 'ARM crossing y must stay on swept segment');
  assertNear(projectile.collisionStartZ ?? NaN, centerZ, 'ARM crossing z must stay on swept segment');
}
