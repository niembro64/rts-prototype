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
import { buildBuildingShape, type BuildingShape } from './BuildingShape3D';
import { applyBuildingOperationalPose } from './BuildingOperationalRig3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import { clockwiseExtractorRotorYaw } from './BuildingAnimationController3D';

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
  } finally {
    placeholderMaterial.dispose();
  }
}
