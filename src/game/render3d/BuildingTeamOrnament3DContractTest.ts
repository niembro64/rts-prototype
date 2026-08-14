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
      }
    }
  } finally {
    placeholderMaterial.dispose();
  }
}
