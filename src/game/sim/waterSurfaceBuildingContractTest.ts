import type { PlayerId } from './types';
import { BUILD_GRID_CELL_SIZE, getBuildingCenterFromGrid } from './buildGrid';
import { getBuildingConfig } from './buildConfigs';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import { ConstructionSystem } from './construction';
import { getCuboidUnderwaterFraction } from './entityMediumOccupancy';
import { WATER_LEVEL } from './Terrain';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water-surface building] ${message}`);
}

export function runWaterSurfaceBuildingContractTest(): void {
  const sonarConfig = getBuildingConfig('buildingSonar');
  assertContract(
    sonarConfig.placementType === 'water-surface',
    'sonar must author water-surface placement',
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
