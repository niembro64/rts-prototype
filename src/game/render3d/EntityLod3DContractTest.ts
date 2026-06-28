import type * as THREE from 'three';
import type { Entity } from '../sim/types';
import {
  EntityLodHysteresis3D,
  entityEmissionUsesLowLodDistance3D,
  simPositionUsesLowEmissionLod3D,
} from './EntityLod3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity lod 3d contract] ${message}`);
  }
}

function cameraAt(x: number, y: number, z: number): THREE.Camera {
  return { position: { x, y, z } } as unknown as THREE.Camera;
}

function entityAt(id: number, x: number, y: number, z: number): Entity {
  return {
    id,
    transform: { x, y, z, rotation: 0 },
    unit: null,
    building: null,
    projectile: null,
  } as Entity;
}

function assertEmissionParity(
  lod: EntityLodHysteresis3D,
  camera: THREE.Camera,
  entity: Entity,
  highToLowDistance: number | null,
  label: string,
): void {
  const direct = entityEmissionUsesLowLodDistance3D(camera, entity, highToLowDistance);
  const cached = lod.entityEmissionUsesLowLodDistance(camera, entity, highToLowDistance);
  assertContract(cached === direct, `${label} cached emission LOD matches direct distance`);
}

export function runEntityLod3DContractTest(): void {
  const lod = new EntityLodHysteresis3D();
  const camera = cameraAt(0, 0, 0);
  const entity = entityAt(101, 3, 4, 0);

  lod.beginFrame();
  assertEmissionParity(lod, camera, entity, null, 'null threshold');
  assertEmissionParity(lod, camera, entity, Number.NaN, 'nan threshold');
  assertEmissionParity(lod, camera, entity, -1, 'negative threshold');
  assertEmissionParity(lod, camera, entity, 4.99, 'outside threshold');
  assertEmissionParity(lod, camera, entity, 5, 'on threshold');
  assertEmissionParity(lod, camera, entity, 5.01, 'inside threshold');

  entity.transform.y = 100;
  lod.beginFrame();
  assertEmissionParity(lod, camera, entity, 50, 'new frame refreshes cached distance');
  assertContract(
    lod.entityEmissionUsesLowLodDistance(camera, entity, 50) ===
      simPositionUsesLowEmissionLod3D(
        camera,
        entity.transform.x,
        entity.transform.y,
        entity.transform.z,
        50,
      ),
    'cached emission LOD matches explicit sim-position calculation',
  );
}
