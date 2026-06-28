import * as THREE from 'three';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import { disposeConstructionEmitterGeoms } from './ConstructionEmitterMesh3D';
import type { BuildingShape } from './BuildingShape3D';
import {
  cylinderGeom,
  detail,
} from './BuildingMeshPrimitives3D';
import { fabricatorTorusHoverHeight, fabricatorTorusRingRadius } from '../sim/blueprints';
import { createPrimitiveTorusGeometry } from './PrimitiveGeometryQuality3D';

// Unit torus (ring radius 1, tube 0.22) for the hovering fabricator body. Scaled
// per-instance to the footprint and laid flat (horizontal ring) at hover height.
const fabricatorTorusGeom = createPrimitiveTorusGeometry('building', 'close', 1, 0.22);


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
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint('towerFabricator');

  // Hovering torus body: a flat (horizontal) team-colored ring at the spawn
  // height, sized to the footprint. The unit shell appears in its center and
  // free-falls through the open middle while the down-pointing pylons finish it.
  const torus = new THREE.Mesh(fabricatorTorusGeom, primaryMat);
  const ringRadius = fabricatorTorusRingRadius(width, depth);
  torus.scale.set(ringRadius, ringRadius, ringRadius);
  torus.rotation.x = Math.PI / 2;
  torus.position.y = fabricatorTorusHoverHeight();
  details.push(detail(torus, 'medium', undefined, 'static'));

  // The forming-unit ghost orbs that used to sit at the ground-level build
  // bay are retired: the real unit shell now spawns at the torus centre and
  // visibly free-falls through the ring, so the orbs were redundant. The
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
  fabricatorTorusGeom.dispose();
  disposeConstructionEmitterGeoms();
}
