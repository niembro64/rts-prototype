import * as THREE from 'three';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingBlueprint } from '../sim/blueprints';
import {
  BUILDING_CLOSED_DAMAGE_MULTIPLIER,
  buildingBlueprintHasActiveState,
  isBuildingActiveStateFortified,
} from '../sim/buildingActiveState';
import type { Entity } from '../sim/types';
import { STRUCTURE_BLUEPRINT_IDS } from '@/types/blueprintIds';
import {
  FABRICATOR_INNER_RING_RADIUS_FRACTION,
  FABRICATOR_INNER_RING_TUBE_RADIUS_FRACTION,
  FABRICATOR_OUTER_RING_RADIUS_FRACTION,
  FABRICATOR_OUTER_RING_TUBE_RADIUS_FRACTION,
  fabricatorConstructionRingPhase,
} from '../sim/fabricatorConstructionRing';
import { buildBuildingShape, type BuildingShape } from './BuildingShape3D';
import { applyBuildingOperationalPose } from './BuildingOperationalRig3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import { WIND_HUB_NAME } from './WindTurbineMesh3D';
import {
  WIND_BLADE_ROOT_HALF_CHORD,
  WIND_BLADE_ROOT_HALF_THICKNESS,
  WIND_BLADE_TIP_HALF_CHORD,
  WIND_BLADE_TIP_HALF_THICKNESS,
  getWindBladeGeometry,
} from './BuildingMeshPrimitives3D';
import {
  applyFabricatorConstructionRingPose,
  clockwiseExtractorRotorYaw,
} from './BuildingAnimationController3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building operational visual contract] ${message}`);
}

function transformSignature(object: THREE.Object3D): readonly number[] {
  return [
    object.position.x,
    object.position.y,
    object.position.z,
    object.quaternion.x,
    object.quaternion.y,
    object.quaternion.z,
    object.quaternion.w,
    object.scale.x,
    object.scale.y,
    object.scale.z,
    ...object.matrix.elements,
  ];
}

function signaturesDiffer(
  left: readonly number[],
  right: readonly number[],
  epsilon = 1e-5,
): boolean {
  return left.some((value, index) => Math.abs(value - right[index]) > epsilon);
}

function assertSpecializedOperationalRig(
  id: string,
  shape: BuildingShape,
): void {
  if (id === 'buildingSolar') {
    assertContract(shape.solarRig !== undefined, 'solar must retain its resource-flow rig');
    const photovoltaicMaterial = shape.primary.material;
    const petalCellMaterials = shape.details
      .filter((entry) => entry.role === 'solarPanel')
      .map((entry) => Array.isArray(entry.mesh.material)
        ? entry.mesh.material[0]
        : entry.mesh.material);
    assertContract(
      photovoltaicMaterial instanceof THREE.MeshStandardMaterial &&
        photovoltaicMaterial.metalness === 1 &&
        photovoltaicMaterial.roughness <= 0.02 &&
        photovoltaicMaterial.envMapIntensity >= 1.45 &&
        petalCellMaterials.length === 4 &&
        petalCellMaterials.every((material) => material === photovoltaicMaterial),
      'the four pyramid faces and four exposed petal faces must share the glossy environment-reflecting photovoltaic finish',
    );
    const open = shape.details.map((entry) => transformSignature(entry.mesh));
    assertContract(
      applySolarCollectorPetalPose(shape.details, 0),
      'solar must expose a closeable four-petal pose',
    );
    const closed = shape.details.map((entry) => transformSignature(entry.mesh));
    assertContract(
      open.some((signature, index) => signaturesDiffer(signature, closed[index])),
      'solar OFF pose must seal its collector petals',
    );
    applySolarCollectorPetalPose(shape.details, 0.5);
    const midpoint = shape.details.map((entry) => transformSignature(entry.mesh));
    assertContract(
      open.some((signature, index) => signaturesDiffer(signature, midpoint[index])) &&
        closed.some((signature, index) => signaturesDiffer(signature, midpoint[index])),
      'solar must pass through a distinct eased petal transition pose',
    );
    return;
  }
  if (id === 'buildingWind') {
    assertContract(shape.windRig !== undefined, 'wind must retain its wind-tracking rotor rig');
    assertContract(
      Math.abs(shape.windRig.closedPitch) > 0.01 && shape.windRig.rotor.children.some((child) => {
        const blade = child.userData.windBlade as
          | { openQuat?: THREE.Quaternion; closedQuat?: THREE.Quaternion }
          | undefined;
        return blade?.openQuat !== undefined && blade.closedQuat !== undefined &&
          blade.openQuat.angleTo(blade.closedQuat) > 0.01;
      }),
      'wind OFF pose must pitch and feather its rotor blades',
    );
    // The hub must swallow the pitched blade roots: a root twisted by the
    // authored pitch spans chord·sin(pitch) + thickness·cos(pitch) across the
    // rotor axis, and a hub thinner than that lets the roots poke out.
    const hub = shape.windRig.rotor.getObjectByName(WIND_HUB_NAME);
    const blade = shape.windRig.rotor.children.find((child) => child.userData.windBlade !== undefined);
    assertContract(hub !== undefined && blade !== undefined, 'wind rotor must carry a named hub and blades');
    const pitch = Math.abs(blade.rotation.y);
    const rootSweptThickness = 2 * (
      WIND_BLADE_ROOT_HALF_CHORD * blade.scale.x * Math.sin(pitch) +
      WIND_BLADE_ROOT_HALF_THICKNESS * blade.scale.z * Math.cos(pitch)
    );
    assertContract(
      pitch > 0.01 && hub.scale.y >= rootSweptThickness,
      `wind hub (${hub.scale.y.toFixed(2)}) must be at least as thick as the pitched blade root sweep (${rootSweptThickness.toFixed(2)})`,
    );
    // Blades end in a real chopped section, never a zero-area point.
    for (const tier of ['close', 'mid', 'far'] as const) {
      const positions = getWindBladeGeometry(tier).getAttribute('position');
      const tipBase = positions.count - 4;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = tipBase; i < positions.count; i++) {
        minX = Math.min(minX, positions.getX(i)); maxX = Math.max(maxX, positions.getX(i));
        minZ = Math.min(minZ, positions.getZ(i)); maxZ = Math.max(maxZ, positions.getZ(i));
      }
      assertContract(
        WIND_BLADE_TIP_HALF_CHORD > 0 && WIND_BLADE_TIP_HALF_THICKNESS > 0 &&
          Math.abs((maxX - minX) - 2 * WIND_BLADE_TIP_HALF_CHORD) < 1e-6 &&
          Math.abs((maxZ - minZ) - 2 * WIND_BLADE_TIP_HALF_THICKNESS) < 1e-6,
        `wind blade ${tier} tip must be a chopped section, not a point`,
      );
    }
    return;
  }
  if (id === 'buildingExtractor' || id === 'buildingExtractorT2') {
    assertContract(shape.extractorRig !== undefined, `${id} must retain its throughput rotor rig`);
    assertContract(
      shape.extractorRig.rotors.some((rotor) => rotor.children.some((child) => {
        const blade = child.userData.extractorBlade as
          | { openQuat?: THREE.Quaternion; closedQuat?: THREE.Quaternion }
          | undefined;
        return blade?.openQuat !== undefined && blade.closedQuat !== undefined &&
          blade.openQuat.angleTo(blade.closedQuat) > 0.01;
      })),
      `${id} OFF pose must fold its extraction blades into armor`,
    );
  }
}

function assertGenericOperationalRig(id: string, shape: BuildingShape): void {
  const rig = shape.operationalRig;
  assertContract(rig !== undefined, `${id} must carry a deploy/hunker operational rig`);
  const chassis = new THREE.Group();

  applyBuildingOperationalPose(rig, chassis, 1, 0.35);
  const open = [
    ...transformSignature(chassis),
    ...rig.parts.flatMap((part) => transformSignature(part.object)),
  ];
  if (rig.hasContinuousMotion) {
    applyBuildingOperationalPose(rig, chassis, 1, 1.4);
    const laterOpen = [
      ...transformSignature(chassis),
      ...rig.parts.flatMap((part) => transformSignature(part.object)),
    ];
    assertContract(
      signaturesDiffer(open, laterOpen),
      `${id} ON pose must visibly move as animation time advances`,
    );
  }
  applyBuildingOperationalPose(rig, chassis, 0, 4.2);
  const closed = [
    ...transformSignature(chassis),
    ...rig.parts.flatMap((part) => transformSignature(part.object)),
  ];
  assertContract(
    signaturesDiffer(open, closed),
    `${id} OFF pose must be visibly more compact than its deployed pose`,
  );

  applyBuildingOperationalPose(rig, chassis, 0.5, 4.2);
  const midpoint = [
    ...transformSignature(chassis),
    ...rig.parts.flatMap((part) => transformSignature(part.object)),
  ];
  assertContract(
    signaturesDiffer(open, midpoint) && signaturesDiffer(closed, midpoint),
    `${id} must have a distinct eased transition pose between ON and OFF`,
  );

  // At amount zero active motion has no influence: a fortified structure is
  // a genuinely static hunkered silhouette, not an animation paused mid-cycle.
  applyBuildingOperationalPose(rig, chassis, 0, 19.7);
  const laterClosed = [
    ...transformSignature(chassis),
    ...rig.parts.flatMap((part) => transformSignature(part.object)),
  ];
  assertContract(
    !signaturesDiffer(closed, laterClosed),
    `${id} OFF pose must remain static regardless of animation time`,
  );

  if (id === 'buildingResourceConverter' || id.startsWith('buildingShield')) {
    assertContract(rig.hasContinuousMotion, `${id} ON pose must have powered continuous motion`);
  }
}

export function runBuildingOperationalVisual3DContractTest(): void {
  const activeIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasActiveState);
  assertContract(
    BUILDING_CLOSED_DAMAGE_MULTIPLIER > 0 && BUILDING_CLOSED_DAMAGE_MULTIPLIER < 1,
    'the shared OFF damage multiplier must reduce incoming damage',
  );
  const extractorStartYaw = clockwiseExtractorRotorYaw(0.37);
  const extractorLaterYaw = clockwiseExtractorRotorYaw(0.91);
  assertContract(
    extractorLaterYaw < extractorStartYaw && extractorLaterYaw < 0,
    'every advancing extractor phase must rotate clockwise when viewed from above',
  );

  const placeholderMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  try {
    for (const id of activeIds) {
      const blueprint = getBuildingBlueprint(id);
      const shape = buildBuildingShape(
        blueprint.renderProfile,
        blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
        blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
        placeholderMaterial,
        id,
        'close',
      );

      if (
        id === 'buildingSolar' ||
        id === 'buildingWind' ||
        id === 'buildingExtractor' ||
        id === 'buildingExtractorT2'
      ) {
        assertSpecializedOperationalRig(id, shape);
      } else {
        assertGenericOperationalRig(id, shape);
      }
      if (
        id === 'buildingRadar'
        || id === 'buildingSonar'
        || id === 'buildingRadarJammer'
        || id === 'buildingSonarJammer'
      ) {
        assertContract(shape.radarRig !== undefined, `${id} ON pose must scan continuously`);
      }
      if (id === 'buildingResourceConverter') {
        assertContract(shape.converterRig !== undefined, 'converter ON pose must show both resource flows');
      }

      const entity = {
        buildingBlueprintId: id,
        building: {
          activeState: { open: true, wantOpen: true, damageDelayMs: 0, reopenDelayMs: 0 },
        },
      } as Entity;
      assertContract(!isBuildingActiveStateFortified(entity), `${id} must take normal damage while ON`);
      if (entity.building?.activeState !== null && entity.building?.activeState !== undefined) {
        entity.building.activeState.open = false;
      }
      assertContract(isBuildingActiveStateFortified(entity), `${id} must receive OFF damage resistance`);
    }

    const universalFabricators = [
      ['towerFabricator', 1],
      ['buildingAdvancedUniversalFabricator', 2],
      ['buildingExperimentalUniversalFabricator', 3],
    ] as const;
    assertContract(
      FABRICATOR_INNER_RING_TUBE_RADIUS_FRACTION <
        FABRICATOR_OUTER_RING_TUBE_RADIUS_FRACTION &&
        FABRICATOR_INNER_RING_RADIUS_FRACTION +
          FABRICATOR_INNER_RING_TUBE_RADIUS_FRACTION <
        FABRICATOR_OUTER_RING_RADIUS_FRACTION -
          FABRICATOR_OUTER_RING_TUBE_RADIUS_FRACTION,
      'fabricator bearing must have a thinner stationary inner race nested inside the outer race',
    );
    for (const [id, expectedBoxCount] of universalFabricators) {
      const blueprint = getBuildingBlueprint(id);
      const shape = buildBuildingShape(
        blueprint.renderProfile,
        blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
        blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
        placeholderMaterial,
        id,
        'close',
      );
      const rig = shape.fabricatorConstructionRingRig;
      assertContract(
        rig !== undefined &&
          rig.boxCount === expectedBoxCount &&
          rig.extensionHeads.length === expectedBoxCount &&
          rig.extensionShafts.length === expectedBoxCount &&
          rig.outerRing.parent === rig.root,
        `${id} must expose its outer race and ${expectedBoxCount} telescoping construction boxes`,
      );
      const idleY = rig.root.position.y;
      const idleYaw = rig.root.rotation.y;
      const idleHeadY = rig.extensionHeadBaseY;
      applyFabricatorConstructionRingPose(rig, true, 40, 20, 17);
      const expectedActiveYaw = -fabricatorConstructionRingPhase(40, 20, 17);
      assertContract(
        Math.abs(rig.root.position.y - idleY) <= 1e-9 &&
          Math.abs(rig.root.rotation.y - expectedActiveYaw) <= 1e-9 &&
          Math.abs(rig.root.rotation.y - idleYaw) > 1e-3 &&
          rig.extensionHeads.every((head) =>
            Math.abs(head.position.y - (idleHeadY + rig.activeLiftY)) <= 1e-9) &&
          rig.extensionShafts.every((shaft) =>
            shaft.visible &&
              Math.abs(shaft.position.y -
                (rig.extensionShaftBaseY + rig.activeLiftY * 0.5)) <= 1e-9 &&
              Math.abs(shaft.scale.y - rig.activeLiftY) <= 1e-9),
        `${id} outer race must rotate in place while only its box heads telescope upward`,
      );
      const activeYaw = rig.root.rotation.y;
      applyFabricatorConstructionRingPose(rig, true, 40.5, 20, 17);
      assertContract(
        Math.abs(
          rig.root.rotation.y + fabricatorConstructionRingPhase(40.5, 20, 17),
        ) <= 1e-9 &&
          Math.abs(rig.root.rotation.y - activeYaw) > 1e-3,
        `${id} outer race must accept fractional presentation ticks between fixed snapshots`,
      );
      const fractionalActiveYaw = rig.root.rotation.y;
      applyFabricatorConstructionRingPose(rig, false, 60, 20, 17);
      assertContract(
        Math.abs(rig.root.position.y - idleY) <= 1e-9 &&
          rig.root.rotation.y === fractionalActiveYaw &&
          rig.extensionHeads.every((head) =>
            Math.abs(head.position.y - idleHeadY) <= 1e-9) &&
          rig.extensionShafts.every((shaft) => !shaft.visible),
        `${id} emitter heads must reseat and the outer race must stop while idle`,
      );
    }
  } finally {
    placeholderMaterial.dispose();
  }
}
