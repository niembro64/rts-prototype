import * as THREE from 'three';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import { disposeConstructionEmitterGeoms } from './ConstructionEmitterMesh3D';
import type { BuildingShape } from './BuildingShape3D';
import {
  detail,
  getActiveBuildingGeometryTier,
  getBuildingCylinderGeometry,
} from './BuildingMeshPrimitives3D';
import { fabricatorTorusHoverHeight, fabricatorTorusRingRadius } from '../sim/blueprints';
import {
  buildProductionHoldRingMesh,
  disposeProductionHoldRingGeom,
} from './ProductionHoldRing3D';

/** Factory chassis: the team-colored hovering torus body only. The
 *  factory's construction emitter (towers + sprays) is NOT created here —
 *  it rides on the factory's construction-pylon turrets like any other
 *  turret-mounted emitter, built by the standard TurretMesh3D path. */
export function buildFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  // The fabricator is a hovering TORUS, not a body shell — render bodyless and
  // hang the ring (+ its under-slung spawn / construction pylons) in the air.
  const primary = new THREE.Mesh(getBuildingCylinderGeometry(), primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint('towerFabricator');

  // Hovering torus body: a flat (horizontal) team-colored ring at the spawn
  // height, sized to the footprint. The unit shell is held in its center while
  // the down-pointing pylons finish it.
  const torus = buildProductionHoldRingMesh(
    fabricatorTorusRingRadius(width, depth),
    primaryMat,
    'horizontal',
    getActiveBuildingGeometryTier(),
  );
  torus.position.y = fabricatorTorusHoverHeight();
  details.push(detail(torus, 'medium', undefined, 'static'));

  // The forming-unit ghost orbs that used to sit at the ground-level build
  // bay are retired: the real unit shell is held at the torus center during
  // construction, so the orbs were redundant. The
  // flag below still marks this as a factory construction host so the
  // animation controller registers it for the construction-emitter spray.
  return {
    primary,
    details,
    bodyless: true,
    height: blueprint.visualHeight ?? DEFAULT_BUILDING_VISUAL_HEIGHT,
    isFactoryConstructionHost: true,
  };
}

export function disposeFactoryMeshGeoms(): void {
  disposeProductionHoldRingGeom();
  disposeConstructionEmitterGeoms();
}
