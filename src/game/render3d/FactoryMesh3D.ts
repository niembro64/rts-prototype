import * as THREE from 'three';
import { getConstructionHostMarkingProfile } from '@/constructionVisualConfig';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import { disposeResourcePylonGeometries } from './ResourcePylonMesh3D';
import type { BuildingShape } from './BuildingShape3D';
import {
  detail,
  getActiveBuildingGeometryTier,
  getBuildingCylinderGeometry,
  makeBox,
  teamOrnamentDetail,
} from './BuildingMeshPrimitives3D';
import { fabricatorTorusHoverHeight, fabricatorTorusRingRadius } from '../sim/blueprints';
import {
  buildProductionHoldRingMesh,
  disposeProductionHoldRingGeom,
} from './ProductionHoldRing3D';
import {
  buildConstructionHostMarking,
  disposeConstructionHostMarkingGeometries,
} from './ConstructionHostMarking3D';

/** Factory chassis: the player-colored hovering torus body. Realized
 *  construction work emits from the factory's host-authored work point. */
export function buildFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  // The fabricator is a hovering TORUS, not a body shell — render bodyless and
  // hang the ring in the air.
  const primary = new THREE.Mesh(getBuildingCylinderGeometry(), primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint('towerFabricator');

  // Hovering torus body: a flat (horizontal) player-colored ring at the spawn
  // height, sized to the footprint. The unit shell is held in its center while
  // the factory applies build power.
  const ringRadius = fabricatorTorusRingRadius(width, depth);
  const hoverHeight = fabricatorTorusHoverHeight();
  const torus = buildProductionHoldRingMesh(
    ringRadius,
    primaryMat,
    'horizontal',
    getActiveBuildingGeometryTier(),
  );
  torus.position.y = hoverHeight;
  details.push(detail(torus, 'medium', undefined, 'constructionHostBody'));

  // Six tangential clamp faces break the broad assembly ring into readable
  // work stations. They are team colour because these are the points where
  // this side's construction field grips the unit shell; unlike a roof kit,
  // they are inseparable from the fabricator's circular function.
  const clampWidth = Math.max(8, ringRadius * 0.2);
  const clampHeight = Math.max(3, ringRadius * 0.045);
  const clampDepth = Math.max(5, ringRadius * 0.085);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const clamp = makeBox(
      primaryMat,
      clampWidth,
      clampHeight,
      clampDepth,
      Math.cos(angle) * ringRadius,
      hoverHeight + clampHeight * 0.2,
      Math.sin(angle) * ringRadius,
    );
    clamp.rotation.y = angle + Math.PI / 2;
    details.push(teamOrnamentDetail(clamp, 'fabricatorClamps'));
  }

  const markingProfile = getConstructionHostMarkingProfile('towerFabricator');
  if (markingProfile === null || markingProfile.kind !== 'ringBoxes') {
    throw new Error('towerFabricator requires perimeter-mounted construction clamp boxes');
  }
  const marking = buildConstructionHostMarking(
    markingProfile,
    ringRadius,
    getActiveBuildingGeometryTier(),
  );
  marking.position.y += hoverHeight;
  marking.updateMatrix();
  for (const child of [...marking.children]) {
    if (!(child instanceof THREE.Mesh)) continue;
    marking.remove(child);
    child.applyMatrix4(marking.matrix);
    details.push(detail(child, 'medium', undefined, 'constructionMarking'));
  }

  // The forming-unit ghost orbs that used to sit at the ground-level build
  // bay are retired: the real unit shell is held at the torus center during
  // construction, so the orbs were redundant. The
  return {
    primary,
    details,
    bodyless: true,
    height: blueprint.visualHeight ?? DEFAULT_BUILDING_VISUAL_HEIGHT,
  };
}

export function disposeFactoryMeshGeoms(): void {
  disposeProductionHoldRingGeom();
  disposeResourcePylonGeometries();
  disposeConstructionHostMarkingGeometries();
}
