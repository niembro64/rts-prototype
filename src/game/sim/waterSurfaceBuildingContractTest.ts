import type { PlayerId } from './types';
import { BUILD_GRID_CELL_SIZE, getBuildingCenterFromGrid } from './buildGrid';
import { getBuildingConfig } from './buildConfigs';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import { ConstructionSystem } from './construction';
import { getCuboidUnderwaterFraction } from './entityMediumOccupancy';
import {
  SEA_ON_SURFACE_ORIGIN_DRAFT_FRACTION,
  getSeaOnSurfaceOriginDraft,
} from './buildingPlacementPolicy';
import { getEntitySensorMedium } from './sensorCoverage';
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
    buildingRadarJammer: ['ground-build-squares-surface'],
    buildingResourceConverter: ['ground-build-squares-surface'],
    buildingSonar: ['water-build-squares-sea-on-surface'],
    buildingSonarJammer: ['water-build-squares-sea-on-surface'],
    buildingMetalStorage: ['ground-build-squares-surface'],
    buildingEnergyStorage: ['ground-build-squares-surface'],
    towerFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    buildingBotFabricator: ['ground-build-squares-surface'],
    buildingVehicleFabricator: ['ground-build-squares-surface'],
    buildingAircraftFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    buildingNavalFabricator: ['water-build-squares-sea-on-surface'],
    buildingAdvancedUniversalFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    buildingExperimentalUniversalFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    buildingAdvancedBotFabricator: ['ground-build-squares-surface'],
    buildingAdvancedVehicleFabricator: ['ground-build-squares-surface'],
    buildingAdvancedAircraftFabricator: ['ground-build-squares-hover', 'water-build-squares-hover-surface'],
    buildingAdvancedNavalFabricator: ['water-build-squares-sea-on-surface'],
    towerBeamMega: ['ground-build-squares-surface'],
    towerBeamLight: ['ground-build-squares-surface'],
    towerCannon: ['ground-build-squares-surface'],
    towerHelios: ['ground-build-squares-surface'],
    towerAntiAir: ['ground-build-squares-surface'],
    towerInterceptor: ['ground-build-squares-surface'],
    towerTorpedo: ['water-build-squares-sea-on-surface'],
    buildingTidalGenerator: ['water-build-squares-sea-on-surface'],
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
  const torpedoConfig = getBuildingConfig('towerTorpedo');
  assertContract(
    torpedoConfig.placementSets.length === 1 &&
      torpedoConfig.placementSets[0] === 'water-build-squares-sea-on-surface',
    'torpedo tower must author only sea-on-surface placement',
  );
  assertContract(
    torpedoConfig.supportSurface.kind === 'none',
    'torpedo tower must not expose an artificial walkable surface',
  );
  assertContract(
    torpedoConfig.visualHeight === torpedoConfig.gridDepth * BUILD_GRID_CELL_SIZE,
    'torpedo tower art must span the complete air/water combat volume',
  );
  assertContract(
    SEA_ON_SURFACE_ORIGIN_DRAFT_FRACTION > 0 && SEA_ON_SURFACE_ORIGIN_DRAFT_FRACTION < 0.5,
    'a floating structure sits a little below the plane, never on it and never fully under it',
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
  const sonarDraft = getSeaOnSurfaceOriginDraft(sonar.building.depth);
  assertContract(
    sonarDraft > 0 && Math.abs(sonar.transform.z - (WATER_LEVEL - sonarDraft)) <= 1e-9,
    'water-surface sonar combat/collision center must float one draft below the waterline',
  );
  assertContract(
    sonar.transform.z < WATER_LEVEL && getEntitySensorMedium(sonar) === 'underwater',
    'a sonar built on the water is a water sensor host by the origin rule alone',
  );
  assertContract(
    Math.abs(
      getCuboidUnderwaterFraction(sonar.transform.z, sonar.building.depth * 0.5) -
        (0.5 + SEA_ON_SURFACE_ORIGIN_DRAFT_FRACTION),
    ) <= 1e-9,
    'water-surface sonar must submerge its lower half plus the draft',
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

  const torpedoWorld = new WorldState(7302, mapWidth, mapHeight);
  const torpedoConstruction = new ConstructionSystem(mapWidth, mapHeight);
  const torpedoTower = torpedoConstruction.startBuilding(
    torpedoWorld,
    'towerTorpedo',
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
  assertContract(
    torpedoTower?.building !== null && torpedoTower?.building !== undefined,
    'torpedo tower must start on the same depth-valid surface-water footprint',
  );
  const torpedoDraft = getSeaOnSurfaceOriginDraft(torpedoTower.building.depth);
  assertContract(
    torpedoDraft > 0 &&
      Math.abs(torpedoTower.transform.z - (WATER_LEVEL - torpedoDraft)) <= 1e-9,
    'torpedo tower combat/collision center must float one draft below the waterline',
  );
  assertContract(
    torpedoTower.transform.z < WATER_LEVEL &&
      getEntitySensorMedium(torpedoTower) === 'underwater',
    'a torpedo tower built on the water is a water sensor host by the origin rule alone',
  );
  assertContract(
    Math.abs(
      getCuboidUnderwaterFraction(
        torpedoTower.transform.z,
        torpedoTower.building.depth * 0.5,
      ) - (0.5 + SEA_ON_SURFACE_ORIGIN_DRAFT_FRACTION)
    ) <= 1e-9,
    'torpedo tower must expose targetable volume to both air and water weapons, more of it to water',
  );
  const torpedoMounts = torpedoTower.combat?.turrets.filter(
    (turret) => turret.mountId === 'torpedoPort' || turret.mountId === 'torpedoStarboard',
  );
  assertContract(
    torpedoMounts?.length === 2,
    'torpedo tower must materialize both launcher heads',
  );
  const towerBaseZ = torpedoTower.transform.z - torpedoTower.building.depth * 0.5;
  for (const torpedoMount of torpedoMounts) {
    const attachment = torpedoMount.config.hostAttachment;
    assertContract(
      attachment?.kind === 'buildingYawPiece' &&
        towerBaseZ + torpedoMount.mount.z + attachment.socketOffset.z < WATER_LEVEL,
      `${torpedoMount.mountId} AimFrom and sonar source must remain below the waterline`,
    );
  }
}
