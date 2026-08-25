import * as THREE from 'three';
import { PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION } from '../sim/productionHoldGeometry';
import {
  createPrimitiveTorusGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const productionHoldRingGeomByKey = new Map<string, THREE.TorusGeometry>();

function getProductionHoldRingGeom(
  tier: PrimitiveGeometryTier,
  tubeRadiusFraction: number,
): THREE.TorusGeometry {
  const safeTubeRadiusFraction = THREE.MathUtils.clamp(tubeRadiusFraction, 0.01, 0.45);
  const key = `${tier}:${safeTubeRadiusFraction.toFixed(5)}`;
  return getOrCreate(productionHoldRingGeomByKey, key, () => createPrimitiveTorusGeometry(
    'building',
    tier,
    1,
    safeTubeRadiusFraction,
  ));
}

export type ProductionHoldRingOrientation = 'horizontal' | 'forward';

export function buildProductionHoldRingMesh(
  radius: number,
  material: THREE.Material,
  orientation: ProductionHoldRingOrientation = 'horizontal',
  tier: PrimitiveGeometryTier = 'close',
  tubeRadiusFraction = PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION,
): THREE.Mesh {
  const ring = new THREE.Mesh(
    getProductionHoldRingGeom(tier, tubeRadiusFraction),
    material,
  );
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
  for (const geom of productionHoldRingGeomByKey.values()) geom.dispose();
  productionHoldRingGeomByKey.clear();
}
