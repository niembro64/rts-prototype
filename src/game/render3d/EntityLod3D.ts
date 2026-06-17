import type * as THREE from 'three';
import { ENTITY_LOD_FULL_DETAIL_DISTANCE_SQ } from '@/config';
import type { Entity } from '../sim/types';

export function entityCameraDistanceSq3D(camera: THREE.Camera, entity: Entity): number {
  const position = camera.position;
  const dx = position.x - entity.transform.x;
  const dy = position.y - entity.transform.z;
  const dz = position.z - entity.transform.y;
  return dx * dx + dy * dy + dz * dz;
}

export function entityUsesLodProxy3D(camera: THREE.Camera, entity: Entity): boolean {
  return entityCameraDistanceSq3D(camera, entity) > ENTITY_LOD_FULL_DETAIL_DISTANCE_SQ;
}
