import { DamageSystem } from '../damage';
import { ForceAccumulator } from '../ForceAccumulator';
import { spatialGrid } from '../SpatialGrid';
import { WorldState } from '../WorldState';
import { createProjectileConfigFromShot } from '../projectileConfigs';
import type { PlayerId } from '../types';
import { WATER_LEVEL } from '../Terrain';
import { checkProjectileCollisions, resetCollisionBuffers } from './ProjectileCollisionHandler';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[projectile terrain contact contract] ${message}`);
}

export function runProjectileTerrainContactContractTest(): void {
  spatialGrid.clear();
  resetCollisionBuffers();

  const world = new WorldState(91827, 1024, 1024);
  const waterSurfaceZ = WATER_LEVEL;
  const terrainBedZ = WATER_LEVEL - 100;

  // Isolate this contract from whichever generated terrain the boot harness
  // currently has installed. The public surface sampler intentionally returns
  // the water plane while the bed sampler returns solid terrain below it.
  world.getGroundZ = () => waterSurfaceZ;
  world.getTerrainBedZ = () => terrainBedZ;
  world.getCachedTerrainBedNormal = () => ({ nx: 0, ny: 0, nz: 1 });

  const torpedo = world.createProjectile(
    512,
    512,
    100,
    0,
    1 as PlayerId,
    70_001,
    createProjectileConfigFromShot('shotTorpedo', 'turretTorpedo'),
  );
  assertContract(torpedo.projectile !== null, 'fixture must create a physical torpedo');
  torpedo.transform.z = WATER_LEVEL - 50;
  torpedo.projectile.isArmed = true;
  torpedo.projectile.hasLeftSource = true;
  torpedo.projectile.collisionStartX = torpedo.transform.x;
  torpedo.projectile.collisionStartY = torpedo.transform.y;
  torpedo.projectile.collisionStartZ = torpedo.transform.z;
  world.addEntity(torpedo);

  const damageSystem = new DamageSystem(world);
  const forces = new ForceAccumulator();
  const waterColumnPass = checkProjectileCollisions(world, 50, damageSystem, forces);
  assertContract(
    world.getEntity(torpedo.id) === torpedo &&
      !waterColumnPass.despawnEvents.some((event) => event.id === torpedo.id),
    'an armed torpedo between the water surface and terrain bed must remain alive',
  );

  torpedo.transform.z = terrainBedZ;
  torpedo.projectile.collisionStartZ = terrainBedZ;
  const seabedPass = checkProjectileCollisions(world, 50, damageSystem, forces);
  assertContract(
    world.getEntity(torpedo.id) === undefined &&
      seabedPass.despawnEvents.some((event) => event.id === torpedo.id),
    'a torpedo that reaches the actual terrain bed must still terminate normally',
  );

  resetCollisionBuffers();
  spatialGrid.clear();
}
