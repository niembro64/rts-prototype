import * as THREE from 'three';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingBlueprint } from '../sim/blueprints';
import {
  BUILDING_BLUEPRINT_IDS,
  type StructureBlueprintId,
} from '@/types/blueprintIds';
import { buildBuildingShape } from './BuildingShape3D';
import {
  buildingTeamOrnamentKind,
  collectBuildingTeamOrnaments,
  type BuildingTeamOrnamentKind,
} from './BuildingTeamOrnament3D';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building team ornament contract] ${message}`);
}

const EXPECTED_KIND: Record<StructureBlueprintId, BuildingTeamOrnamentKind> = {
  buildingSolar: 'solarPetalInlay',
  buildingWind: 'windNacelleBand',
  towerFabricator: 'fabricatorClamps',
  buildingExtractor: 'extractorIntakeSeam',
  towerBeamMega: 'beamPairedCrowns',
  towerBeamLight: 'beamEmitterCrown',
  towerCannon: 'cannonYoke',
  towerHelios: 'heliosYoke',
  buildingRadar: 'radarDishRim',
  buildingResourceConverter: 'converterPylonBridge',
  towerAntiAir: 'antiAirPedestalBrace',
  buildingExtractorT2: 'extractorRotorPlate',
  buildingSonar: 'sonarBuoyCollar',
  towerTorpedo: 'torpedoWaterlineBand',
  buildingShieldTargetingTech: 'targetingSpireHalo',
  buildingShieldTech: 'shieldForgeCrest',
  buildingPrecisionTargetingTech: 'precisionGimbalRing',
  buildingRadarJammer: 'radarJammerCoil',
  buildingSonarJammer: 'sonarJammerBaffle',
  buildingMetalStorage: 'metalStorageBrace',
  buildingEnergyStorage: 'energyStorageBusbar',
};

const TIERS: readonly PrimitiveGeometryTier[] = ['close', 'mid', 'far'];
const ROUND_PROFILE_STRUCTURES = new Set<StructureBlueprintId>([
  'towerBeamMega',
  'towerBeamLight',
  'towerCannon',
  'towerAntiAir',
  'buildingRadar',
  'buildingSonar',
  // The containment lab is authored as a disc — circular foundation polygon,
  // lathe dome, revolved shell plates — and its footprint mask is the matching
  // circle of cells. Pin that: the silo wings and window panels it used to
  // carry are exactly the kind of boxy trim that broke the silhouette.
  'buildingShieldTech',
]);

function isVisibleSolid(mesh: THREE.Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => (
    material.visible && (!material.transparent || material.opacity > 0)
  ));
}

function assertRoundedProfile(
  root: THREE.Object3D,
  buildingBlueprintId: StructureBlueprintId,
  tier: PrimitiveGeometryTier,
): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !isVisibleSolid(object)) return;
    assertContract(
      object.geometry.name !== 'buildingBox',
      `${buildingBlueprintId}/${tier} must not expose visible cubic segments`,
    );
    const parameters = object.geometry.parameters as
      | { radialSegments?: number; tubularSegments?: number; tube?: number }
      | undefined;
    // A square-section extruded torus is the repo's authored ring shape, and
    // its `radialSegments` is the deliberate four-point TUBE cross-section
    // (SQUARE_TORUS_CROSS_SECTION_SEGMENTS) — not a four-sided barrel. Its
    // round profile is the major path, so judge that one instead.
    const roundProfileSegments = parameters?.tube !== undefined
      ? parameters.tubularSegments
      : parameters?.radialSegments;
    assertContract(
      roundProfileSegments !== 4,
      `${buildingBlueprintId}/${tier} must not expose four-sided cylindrical foundations`,
    );
  });
}

function geometryPlanSpan(
  mesh: THREE.Mesh,
  footprintWidth: number,
  footprintDepth: number,
): { x: number; z: number } {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  assertContract(bounds !== null, 'building primary geometry must expose local bounds');
  return {
    x: (bounds.max.x - bounds.min.x) * footprintWidth,
    z: (bounds.max.z - bounds.min.z) * footprintDepth,
  };
}

function assertUtilityDetailsEscapePrimaryShell(
  shape: ReturnType<typeof buildBuildingShape>,
  buildingBlueprintId: StructureBlueprintId,
  tier: PrimitiveGeometryTier,
  footprintWidth: number,
  footprintDepth: number,
): void {
  if (
    buildingBlueprintId !== 'buildingRadarJammer' &&
    buildingBlueprintId !== 'buildingMetalStorage' &&
    buildingBlueprintId !== 'buildingEnergyStorage'
  ) return;

  const primarySpan = geometryPlanSpan(shape.primary, footprintWidth, footprintDepth);
  if (buildingBlueprintId === 'buildingRadarJammer') {
    assertContract(shape.radarRig !== undefined, `buildingRadarJammer/${tier} needs its ECM rig`);
    const rigBounds = new THREE.Box3().setFromObject(shape.radarRig.head);
    const rigSpan = Math.max(
      rigBounds.max.x - rigBounds.min.x,
      rigBounds.max.z - rigBounds.min.z,
    );
    assertContract(
      rigSpan > Math.max(primarySpan.x, primarySpan.z) * 1.8,
      `buildingRadarJammer/${tier} phased array must visibly escape its mast shell`,
    );
    return;
  }

  const detailBounds = new THREE.Box3();
  for (const entry of shape.details) detailBounds.expandByObject(entry.mesh);
  const expectedStorageHeight = buildingBlueprintId === 'buildingMetalStorage' ? 240 : 270;
  assertContract(
    shape.height === expectedStorageHeight,
    `${buildingBlueprintId}/${tier} chassis must use its 3x visual height`,
  );
  assertContract(
    detailBounds.max.y > expectedStorageHeight * 0.7,
    `${buildingBlueprintId}/${tier} exposed hardware must scale into the 3x-taller volume`,
  );
  const detailSpanX = detailBounds.max.x - detailBounds.min.x;
  const detailSpanZ = detailBounds.max.z - detailBounds.min.z;
  assertContract(
    detailSpanX > primarySpan.x * 1.2 || detailSpanZ > primarySpan.z * 1.2,
    `${buildingBlueprintId}/${tier} storage hardware must remain exposed outside its core shell`,
  );
}

export function runBuildingTeamOrnament3DContractTest(): void {
  assertContract(
    new Set(Object.values(EXPECTED_KIND)).size === BUILDING_BLUEPRINT_IDS.length,
    'each building blueprint must own a distinct ornament vocabulary',
  );

  const placeholderMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  try {
    for (const buildingBlueprintId of BUILDING_BLUEPRINT_IDS) {
      const blueprint = getBuildingBlueprint(buildingBlueprintId);
      for (const tier of TIERS) {
        const shape = buildBuildingShape(
          blueprint.renderProfile,
          blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
          blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
          placeholderMaterial,
          buildingBlueprintId,
          tier,
        );
        const footprintWidth = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
        const footprintDepth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
        assertUtilityDetailsEscapePrimaryShell(
          shape,
          buildingBlueprintId,
          tier,
          footprintWidth,
          footprintDepth,
        );
        const root = new THREE.Group();
        root.add(shape.primary);
        for (const detail of shape.details) root.add(detail.mesh);
        const ornaments = collectBuildingTeamOrnaments(root);
        assertContract(
          ornaments.length > 0,
          `${buildingBlueprintId}/${tier} must retain authored team-colour geometry`,
        );
        const kinds = new Set(ornaments.map(buildingTeamOrnamentKind));
        assertContract(
          kinds.size === 1 && kinds.has(EXPECTED_KIND[buildingBlueprintId]),
          `${buildingBlueprintId}/${tier} must use only its authored ornament kind `
            + `${EXPECTED_KIND[buildingBlueprintId]} (got ${[...kinds].join(', ')})`,
        );
        if (ROUND_PROFILE_STRUCTURES.has(buildingBlueprintId)) {
          assertRoundedProfile(root, buildingBlueprintId, tier);
        }
        if (buildingBlueprintId === 'buildingSolar') {
          assertContract(
            shape.details.filter((entry) => entry.role === 'solarPanel').length === 4,
            `buildingSolar/${tier} must retain one photovoltaic face per petal `
              + 'without duplicate surface overlays',
          );
          assertContract(
            shape.details.every((entry) => entry.role !== 'tinyTrim'),
            `buildingSolar/${tier} hinge frame must not add close-only corner blobs`,
          );
        }
      }
    }
  } finally {
    placeholderMaterial.dispose();
  }
}
