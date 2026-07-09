import * as THREE from 'three';
import { createPrimitiveTorusGeometry } from './PrimitiveGeometryQuality3D';

const productionHoldRingGeom = createPrimitiveTorusGeometry('building', 'close', 1, 0.18);

export function buildProductionHoldRingMesh(
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const ring = new THREE.Mesh(productionHoldRingGeom, material);
  const safeRadius = Math.max(1, radius);
  ring.scale.set(safeRadius, safeRadius, safeRadius);
  ring.rotation.x = Math.PI / 2;
  return ring;
}

export function disposeProductionHoldRingGeom(): void {
  productionHoldRingGeom.dispose();
}
