import * as THREE from 'three';
import { getConstructionHostMarkingProfiles } from '@/constructionVisualConfig';
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
  factoryFrameMat,
  makeBox,
  makeCylinder,
  playerColorDetail,
  teamOrnamentDetail,
} from './BuildingMeshPrimitives3D';
import {
  fabricatorProductionPlaneHeight,
  isRadialFabricatorBuildingBlueprintId,
} from '../sim/blueprints';
import { fabricatorTorusRingRadius } from '../sim/fabricatorGeometry';
import type { BuildingBlueprintId } from '../sim/types';
import {
  buildProductionHoldRingMesh,
  disposeProductionHoldRingGeom,
} from './ProductionHoldRing3D';
import {
  buildConstructionHostMarking,
  disposeConstructionHostMarkingGeometries,
} from './ConstructionHostMarking3D';
import type { BuildingTeamOrnamentKind } from './BuildingTeamOrnament3D';

function fabricatorOrnamentKind(
  buildingBlueprintId: BuildingBlueprintId,
): BuildingTeamOrnamentKind {
  switch (buildingBlueprintId) {
    case 'buildingBotFabricator': return 'botFabricatorClamps';
    case 'buildingVehicleFabricator': return 'vehicleFabricatorClamps';
    case 'buildingAircraftFabricator': return 'aircraftFabricatorClamps';
    case 'buildingNavalFabricator': return 'navalFabricatorClamps';
    case 'buildingAdvancedUniversalFabricator': return 'advancedUniversalFabricatorClamps';
    case 'buildingExperimentalUniversalFabricator': return 'experimentalUniversalFabricatorClamps';
    case 'buildingAdvancedBotFabricator': return 'advancedBotFabricatorClamps';
    case 'buildingAdvancedVehicleFabricator': return 'advancedVehicleFabricatorClamps';
    case 'buildingAdvancedAircraftFabricator': return 'advancedAircraftFabricatorClamps';
    case 'buildingAdvancedNavalFabricator': return 'advancedNavalFabricatorClamps';
    default: return 'fabricatorClamps';
  }
}

/** Factory chassis: the player-colored hovering torus body. Realized
 *  construction work emits from the factory's host-authored work point. */
function buildRadialFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
  buildingBlueprintId: BuildingBlueprintId,
): BuildingShape {
  // The fabricator is a hovering TORUS, not a body shell — render bodyless and
  // hang the ring in the air.
  const primary = new THREE.Mesh(getBuildingCylinderGeometry(), primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint(buildingBlueprintId);

  // Hovering torus body: a flat (horizontal) player-colored ring at the spawn
  // height, sized to the footprint. The unit shell is held in its center while
  // the factory applies build power.
  const ringRadius = fabricatorTorusRingRadius(width, depth);
  const hoverHeight = fabricatorProductionPlaneHeight(buildingBlueprintId);
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
  const ornamentKind = fabricatorOrnamentKind(buildingBlueprintId);
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
    details.push(teamOrnamentDetail(clamp, ornamentKind));
  }

  const markingProfiles = getConstructionHostMarkingProfiles(buildingBlueprintId);
  if (!markingProfiles.some((profile) => profile.kind === 'ringBoxes')) {
    throw new Error(`${buildingBlueprintId} requires perimeter-mounted construction clamp boxes`);
  }
  for (const markingProfile of markingProfiles) {
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

/** Directional specialist factory. Local +X is the output direction: the
 * rear machine block and paired side rails form a U-shaped yard whose open
 * mouth, hazard deck, emitters, held shell, and exit waypoint all agree. */
function buildDirectionalFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
  buildingBlueprintId: BuildingBlueprintId,
): BuildingShape {
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const factory = blueprint.factory;
  if (factory === null || factory.domain === 'universal') {
    throw new Error(`${buildingBlueprintId} is not a directional specialist factory`);
  }
  const details: BuildingShape['details'] = [];
  const primary = new THREE.Mesh(getBuildingCylinderGeometry(), primaryMat);
  const tierTwo = factory.techLevel === 2;
  const floating = blueprint.hoveringType === 'directionalFabricator';
  const deckY = floating
    ? fabricatorProductionPlaneHeight(buildingBlueprintId) - 7
    : 4;
  const railHeight = Math.max(18, Math.min(blueprint.visualHeight * 0.24, depth * 0.2));
  const rearHeight = Math.max(42, Math.min(blueprint.visualHeight * 0.62, depth * 0.55));
  const rearX = -width * 0.41;
  const railZ = depth * 0.41;
  const ornamentKind = fabricatorOrnamentKind(buildingBlueprintId);

  const addPlayerBox = (
    boxWidth: number,
    boxHeight: number,
    boxDepth: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = makeBox(primaryMat, boxWidth, boxHeight, boxDepth, x, y, z);
    details.push(playerColorDetail(mesh));
    return mesh;
  };
  const addFrameBox = (
    boxWidth: number,
    boxHeight: number,
    boxDepth: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = makeBox(factoryFrameMat, boxWidth, boxHeight, boxDepth, x, y, z);
    details.push(detail(mesh, 'medium', undefined, 'constructionHostBody'));
    return mesh;
  };

  // Common open-front build yard. The thin floor communicates the lane while
  // the mass sits at the rear and sides, so +X remains unmistakably open.
  addPlayerBox(width * 0.86, 8, depth * 0.58, -width * 0.04, deckY, 0);
  addPlayerBox(width * 0.13, rearHeight, depth * 0.84, rearX, deckY + rearHeight * 0.5, 0);
  addPlayerBox(width * 0.76, railHeight, depth * 0.13, -width * 0.04, deckY + railHeight * 0.5, -railZ);
  addPlayerBox(width * 0.76, railHeight, depth * 0.13, -width * 0.04, deckY + railHeight * 0.5, railZ);
  addFrameBox(width * 0.62, 5, depth * 0.08, width * 0.03, deckY + 5, -depth * 0.24);
  addFrameBox(width * 0.62, 5, depth * 0.08, width * 0.03, deckY + 5, depth * 0.24);

  // A dark chevron in the mouth gives rotation a readable arrow even from
  // strategic zoom. It points along the same +X used by production output.
  const arrowA = addFrameBox(width * 0.18, 4, 7, width * 0.31, deckY + 7, -depth * 0.07);
  arrowA.rotation.y = -0.62;
  const arrowB = addFrameBox(width * 0.18, 4, 7, width * 0.31, deckY + 7, depth * 0.07);
  arrowB.rotation.y = 0.62;

  // Each production domain keeps the same functional yard grammar while
  // owning a distinct silhouette, like BAR's lab/plant/airpad/shipyard split.
  if (factory.domain === 'bot') {
    const towerRadius = Math.max(10, depth * 0.075);
    for (const z of [-depth * 0.3, depth * 0.3]) {
      const tower = makeCylinder(
        primaryMat,
        towerRadius,
        rearHeight * 0.92,
        -width * 0.2,
        deckY + rearHeight * 0.46,
        z,
      );
      details.push(playerColorDetail(tower));
    }
    addFrameBox(width * 0.18, 8, depth * 0.7, -width * 0.2, deckY + rearHeight * 0.86, 0);
  } else if (factory.domain === 'vehicle') {
    addPlayerBox(width * 0.62, railHeight * 0.46, depth * 0.12, width * 0.03, deckY + railHeight * 0.23, -depth * 0.27);
    addPlayerBox(width * 0.62, railHeight * 0.46, depth * 0.12, width * 0.03, deckY + railHeight * 0.23, depth * 0.27);
    for (const x of [-width * 0.24, width * 0.04, width * 0.3]) {
      addFrameBox(width * 0.055, 9, depth * 0.72, x, deckY + 9, 0);
    }
  } else if (factory.domain === 'aircraft') {
    const leftWing = addPlayerBox(width * 0.42, 7, depth * 0.22, -width * 0.04, deckY + 5, -depth * 0.34);
    leftWing.rotation.y = -0.12;
    const rightWing = addPlayerBox(width * 0.42, 7, depth * 0.22, -width * 0.04, deckY + 5, depth * 0.34);
    rightWing.rotation.y = 0.12;
    addFrameBox(width * 0.1, rearHeight * 0.8, depth * 0.1, rearX + width * 0.07, deckY + rearHeight * 0.4, 0);
  } else {
    // Naval yards read as a long flooded slip with paired raised pontoons.
    addPlayerBox(width * 0.72, railHeight * 0.72, depth * 0.17, 0, deckY + railHeight * 0.14, -depth * 0.34);
    addPlayerBox(width * 0.72, railHeight * 0.72, depth * 0.17, 0, deckY + railHeight * 0.14, depth * 0.34);
    addFrameBox(width * 0.66, 6, depth * 0.07, width * 0.04, deckY + 10, 0);
  }

  // Advanced yards add a second transverse gantry and four forward nano-arm
  // shoulders, matching their authored four work emitters.
  if (tierTwo) {
    addFrameBox(width * 0.12, 9, depth * 0.78, width * 0.12, deckY + rearHeight * 0.72, 0);
    for (const x of [-width * 0.18, width * 0.16]) {
      for (const z of [-depth * 0.38, depth * 0.38]) {
        const shoulder = makeCylinder(
          primaryMat,
          Math.max(7, depth * 0.04),
          railHeight * 1.35,
          x,
          deckY + railHeight * 0.67,
          z,
        );
        details.push(teamOrnamentDetail(shoulder, ornamentKind));
      }
    }
  } else {
    for (const z of [-depth * 0.38, depth * 0.38]) {
      const shoulder = makeBox(
        primaryMat,
        width * 0.11,
        railHeight * 0.72,
        depth * 0.1,
        -width * 0.08,
        deckY + railHeight * 0.72,
        z,
      );
      details.push(teamOrnamentDetail(shoulder, ornamentKind));
    }
  }

  const markingProfiles = getConstructionHostMarkingProfiles(buildingBlueprintId);
  if (!markingProfiles.some((profile) => profile.kind === 'panel')) {
    throw new Error(`${buildingBlueprintId} requires a directional hazard-deck marking`);
  }
  for (const markingProfile of markingProfiles) {
    const marking = buildConstructionHostMarking(
      markingProfile,
      Math.min(width, depth),
      getActiveBuildingGeometryTier(),
    );
    marking.position.y += deckY + 5;
    marking.updateMatrix();
    for (const child of [...marking.children]) {
      if (!(child instanceof THREE.Mesh)) continue;
      marking.remove(child);
      child.applyMatrix4(marking.matrix);
      details.push(detail(child, 'medium', undefined, 'constructionMarking'));
    }
  }

  return {
    primary,
    details,
    bodyless: true,
    height: blueprint.visualHeight ?? DEFAULT_BUILDING_VISUAL_HEIGHT,
  };
}

export function buildFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
  buildingBlueprintId: BuildingBlueprintId,
): BuildingShape {
  return isRadialFabricatorBuildingBlueprintId(buildingBlueprintId)
    ? buildRadialFactoryMesh(width, depth, primaryMat, buildingBlueprintId)
    : buildDirectionalFactoryMesh(width, depth, primaryMat, buildingBlueprintId);
}

export function disposeFactoryMeshGeoms(): void {
  disposeProductionHoldRingGeom();
  disposeResourcePylonGeometries();
  disposeConstructionHostMarkingGeometries();
}
