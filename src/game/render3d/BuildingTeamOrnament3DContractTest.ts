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
  towerBeamMega: 'beamEmitterCrown',
  towerCannon: 'cannonYoke',
  buildingRadar: 'radarDishRim',
  buildingResourceConverter: 'converterPylonBridge',
  towerAntiAir: 'antiAirPedestalBrace',
  buildingExtractorT2: 'extractorRotorPlate',
  buildingSonar: 'sonarBuoyCollar',
  towerTorpedo: 'torpedoWaterlineBand',
  buildingShieldTargetingTech: 'targetingSpireHalo',
  buildingShieldTech: 'shieldForgeCrest',
};

const TIERS: readonly PrimitiveGeometryTier[] = ['close', 'mid', 'far'];
const ROUND_PROFILE_STRUCTURES = new Set<StructureBlueprintId>([
  'towerBeamMega',
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
    const parameters = (object.geometry as THREE.CylinderGeometry).parameters as
      | { radialSegments?: number }
      | undefined;
    assertContract(
      parameters?.radialSegments !== 4,
      `${buildingBlueprintId}/${tier} must not expose four-sided cylindrical foundations`,
    );
  });
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
        }
      }
    }
  } finally {
    placeholderMaterial.dispose();
  }
}
