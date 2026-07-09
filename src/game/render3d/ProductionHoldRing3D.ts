import * as THREE from 'three';
import { PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION } from '../sim/productionHoldGeometry';
import { createPrimitiveTorusGeometry } from './PrimitiveGeometryQuality3D';

const productionHoldRingGeom = createPrimitiveTorusGeometry(
  'building',
  'close',
  1,
  PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION,
);

export type ProductionHoldRingOrientation = 'horizontal' | 'forward';

export function buildProductionHoldRingMesh(
  radius: number,
  material: THREE.Material,
  orientation: ProductionHoldRingOrientation = 'horizontal',
): THREE.Mesh {
  const ring = new THREE.Mesh(productionHoldRingGeom, material);
  const safeRadius = Math.max(1, radius);
  ring.scale.set(safeRadius, safeRadius, safeRadius);
  if (orientation === 'forward') {
    ring.rotation.y = Math.PI / 2;
  } else {
    ring.rotation.x = Math.PI / 2;
  }
  return ring;
}

export function disposeProductionHoldRingGeom(): void {
  productionHoldRingGeom.dispose();
}
