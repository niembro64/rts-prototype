import type * as THREE from 'three';
import { ENTITY_LOD_FULL_DETAIL_DISTANCE_SQ } from '@/config';
import type { Entity } from '../sim/types';

export function entityCameraDistanceSq3D(camera: THREE.Camera, entity: Entity): number {
  return simPositionCameraDistanceSq3D(
    camera,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
  );
}

export function simPositionCameraDistanceSq3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
): number {
  const position = camera.position;
  const dx = position.x - simX;
  const dy = position.y - simZ;
  const dz = position.z - simY;
  return dx * dx + dy * dy + dz * dz;
}

export function entityUsesLodProxy3D(camera: THREE.Camera, entity: Entity): boolean {
  return entityCameraDistanceSq3D(camera, entity) > ENTITY_LOD_FULL_DETAIL_DISTANCE_SQ;
}

export function simPositionUsesLodProxy3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
): boolean {
  return simPositionCameraDistanceSq3D(camera, simX, simY, simZ) >
    ENTITY_LOD_FULL_DETAIL_DISTANCE_SQ;
}
