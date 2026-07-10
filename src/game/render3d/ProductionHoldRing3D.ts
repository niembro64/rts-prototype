import * as THREE from 'three';
import { PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION } from '../sim/productionHoldGeometry';
import {
  createPrimitiveTorusGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const productionHoldRingGeomByTier = new Map<PrimitiveGeometryTier, THREE.TorusGeometry>();

function getProductionHoldRingGeom(tier: PrimitiveGeometryTier): THREE.TorusGeometry {
  let geom = productionHoldRingGeomByTier.get(tier);
  if (!geom) {
    geom = createPrimitiveTorusGeometry(
      'building',
      tier,
      1,
      PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION,
    );
    productionHoldRingGeomByTier.set(tier, geom);
  }
  return geom;
}

export type ProductionHoldRingOrientation = 'horizontal' | 'forward';

export function buildProductionHoldRingMesh(
  radius: number,
  material: THREE.Material,
  orientation: ProductionHoldRingOrientation = 'horizontal',
  tier: PrimitiveGeometryTier = 'close',
): THREE.Mesh {
  const ring = new THREE.Mesh(getProductionHoldRingGeom(tier), material);
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
  for (const geom of productionHoldRingGeomByTier.values()) geom.dispose();
  productionHoldRingGeomByTier.clear();
}
