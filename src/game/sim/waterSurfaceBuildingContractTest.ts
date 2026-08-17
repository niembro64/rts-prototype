import type { PlayerId } from './types';
import { BUILD_GRID_CELL_SIZE, getBuildingCenterFromGrid } from './buildGrid';
import { getBuildingConfig } from './buildConfigs';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import { ConstructionSystem } from './construction';
import { getCuboidUnderwaterFraction } from './entityMediumOccupancy';
import { WATER_LEVEL } from './Terrain';
import { WorldState } from './WorldState';
import { BUILD_CONFIG } from '../../buildConfig';
import type { BuildingPlacementSet } from '../../types/buildingTypes';
import { STRUCTURE_BLUEPRINT_IDS } from '../../types/blueprintIds';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water-surface building] ${message}`);
}

export function runWaterSurfaceBuildingContractTest(): void {
  const expectedPlacementSets: Record<string, readonly BuildingPlacementSet[]> = {
    buildingSolar: ['ground-build-squares-surface'],
    buildingWind: ['ground-build-squares-surface'],
    buildingExtractor: ['ground-build-squares-surface', 'water-build-squares-sea-bed'],
    buildingExtractorT2: ['ground-build-squares-surface', 'water-build-squares-sea-bed'],
    buildingRadar: ['ground-build-squares-surface'],
    buildingResourceConverter: ['ground-build-squares-surface'],
    buildingSonar: ['water-build-squares-sea-on-surface'],
    towerFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    towerBeamMega: ['ground-build-squares-surface'],
    towerCannon: ['ground-build-squares-surface'],
    towerAntiAir: ['ground-build-squares-surface'],
    towerTorpedo: ['water-build-squares-sea-bed'],
    buildingShieldTargetingTech: ['ground-build-squares-surface'],
    buildingShieldTech: ['ground-build-squares-surface'],
    buildingPrecisionTargetingTech: ['ground-build-squares-surface'],
  };
  assertContract(
    BUILD_CONFIG.maxBuildableSlopeAngleDegrees === 10,
    'surface and sea-bed flatness threshold must be exactly 10 degrees',
  );
  for (const id of STRUCTURE_BLUEPRINT_IDS) {
    const expected = expectedPlacementSets[id];
    const actual = getBuildingConfig(id).placementSets;
    assertContract(expected !== undefined, `${id} must have an exhaustive placement-set contract`);
    assertContract(
      actual.length === expected.length &&
        actual.every((placementSet, index) => placementSet === expected[index]),
      `${id} must retain its explicit placement sets`,
    );
  }
  const sonarConfig = getBuildingConfig('buildingSonar');
  assertContract(
    sonarConfig.placementSets.length === 1 &&
      sonarConfig.placementSets[0] === 'water-build-squares-sea-on-surface',
    'sonar must author only sea-on-surface placement',
  );
  assertContract(
    sonarConfig.renderProfile === 'buildingSonar',
    'sonar must use its downward-facing render profile',
  );
  assertContract(
    sonarConfig.supportSurface.kind === 'none',
    'sonar must not expose a walkable top surface',
  );

  const mapWidth = 8192;
  const mapHeight = 8192;
  const world = new WorldState(7301, mapWidth, mapHeight);
  const construction = new ConstructionSystem(mapWidth, mapHeight);
  const mapCellsX = Math.floor(mapWidth / BUILD_GRID_CELL_SIZE);
  const mapCellsY = Math.floor(mapHeight / BUILD_GRID_CELL_SIZE);
  let buildGridX = -1;
  let buildGridY = -1;
  for (let gy = 0; gy < mapCellsY - sonarConfig.placementGridHeight; gy++) {
    for (let gx = 0; gx < mapCellsX - sonarConfig.placementGridWidth; gx++) {
      const diagnostics = getBuildingPlacementDiagnosticsForGrid(
        'buildingSonar',
        gx,
        gy,
        mapWidth,
        mapHeight,
      );
      if (!diagnostics.canPlace) continue;
      buildGridX = gx;
      buildGridY = gy;
      break;
    }
    if (buildGridX >= 0) break;
  }
  assertContract(buildGridX >= 0, 'test map must contain a depth-valid sonar footprint');

  const sonar = construction.startBuilding(
    world,
    'buildingSonar',
    buildGridX,
    buildGridY,
    1 as PlayerId,
    0,
    0,
    {
      skipBuilderAuthorization: true,
      ignoreTerrainForPlacement: false,
    },
  );
  assertContract(sonar?.building !== null && sonar?.building !== undefined, 'sonar must start');
  assertContract(
    Math.abs(sonar.transform.z - WATER_LEVEL) <= 1e-9,
    'water-surface sonar combat/collision center must sit exactly on the waterline',
  );
  assertContract(
    Math.abs(
      getCuboidUnderwaterFraction(sonar.transform.z, sonar.building.depth * 0.5) - 0.5,
    ) <= 1e-9,
    'water-surface sonar must occupy equal above-water and underwater volume',
  );

  const occupiedCenter = getBuildingCenterFromGrid(
    buildGridX,
    buildGridY,
    sonarConfig.placementGridWidth,
    sonarConfig.placementGridHeight,
  );
  assertContract(
    construction.canPlaceAt(
      occupiedCenter.x,
      occupiedCenter.y,
      'buildingSonar',
    ) === false,
    'shared X/Y occupancy must reject a second structure at any height',
  );
}
