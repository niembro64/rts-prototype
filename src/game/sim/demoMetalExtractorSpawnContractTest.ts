import { getModeDefaultPreset } from '../../components/battlePresets';
import { LAND_CELL_SIZE } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { getBuildingConfig } from './buildConfigs';
import { ConstructionSystem } from './construction';
import { spawnMetalExtractorsOnDeposits } from './spawn';
import type { PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo metal extractor spawn contract] ${message}`);
}

function createNoBuildableTerrainGrid(
  mapWidth: number,
  mapHeight: number,
): TerrainBuildabilityGrid {
  const cellsX = Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE);
  const cellsY = Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE);
  const cellCount = cellsX * cellsY;
  return {
    mapWidth,
    mapHeight,
    cellSize: BUILD_GRID_CELL_SIZE,
    cellsX,
    cellsY,
    version: 1,
    configKey: 'demo-metal-extractor-spawn:none-buildable',
    flags: new Array(cellCount).fill(0),
    levels: new Array(cellCount).fill(0),
  };
}

export function runDemoMetalExtractorSpawnContractTest(): void {
  const preset = getModeDefaultPreset('demo');
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) {
    playerIds.push((i + 1) as PlayerId);
  }
  const deposits = generateMetalDeposits(mapWidth, mapHeight, playerIds.length);
  const expectedDepositIds = new Set<number>();
  const depositById = new Map<number, (typeof deposits)[number]>();
  for (let i = 0; i < deposits.length; i++) {
    depositById.set(deposits[i].id, deposits[i]);
    if (deposits[i].demoAutoExtractor) expectedDepositIds.add(deposits[i].id);
  }

  const world = new WorldState(1242, mapWidth, mapHeight);
  world.playerCount = playerIds.length;
  world.metalDeposits = deposits;
  let underwaterDeposit: (typeof deposits)[number] | null = null;
  for (let i = 0; i < deposits.length; i++) {
    const deposit = deposits[i];
    if (
      deposit.demoAutoExtractor &&
      world.getTerrainBedZ(deposit.x, deposit.y) < world.getGroundZ(deposit.x, deposit.y)
    ) {
      underwaterDeposit = deposit;
      break;
    }
  }
  assertContract(underwaterDeposit !== null, 'authored demo layout must include an underwater deposit');

  const extractorConfig = getBuildingConfig('buildingExtractor');
  const manualConstruction = new ConstructionSystem(
    mapWidth,
    mapHeight,
    createNoBuildableTerrainGrid(mapWidth, mapHeight),
  );
  const manualGrid = manualConstruction.getGrid();
  const snapped = manualGrid.snapToGrid(
    underwaterDeposit.x,
    underwaterDeposit.y,
    extractorConfig.placementGridWidth,
    extractorConfig.placementGridHeight,
  );
  const manualGridPosition = manualGrid.worldToGrid(snapped.x, snapped.y);
  const manualExtractor = manualConstruction.startBuilding(
    world,
    'buildingExtractor',
    manualGridPosition.gx,
    manualGridPosition.gy,
    playerIds[0],
    0,
    0,
    {
      skipBuilderAuthorization: true,
      ignoreTerrainForPlacement: false,
    },
  );
  assertContract(
    manualExtractor !== null,
    'player build placement must allow an extractor on an underwater deposit',
  );
  assertContract(
    Math.abs(
      manualExtractor.transform.z - manualExtractor.building!.depth / 2 -
      world.getTerrainBedZ(underwaterDeposit.x, underwaterDeposit.y),
    ) <= 1e-6,
    'player-built underwater extractor base must sit on the deposit terrain bed',
  );

  const hoveringConfig = getBuildingConfig('towerFabricator');
  assertContract(hoveringConfig.hovering, 'fabricator fixture must be a hovering building');
  const hoveringConstruction = new ConstructionSystem(
    mapWidth,
    mapHeight,
    createNoBuildableTerrainGrid(mapWidth, mapHeight),
  );
  const hoveringGrid = hoveringConstruction.getGrid();
  const hoveringSnapped = hoveringGrid.snapToGrid(
    underwaterDeposit.x,
    underwaterDeposit.y,
    hoveringConfig.placementGridWidth,
    hoveringConfig.placementGridHeight,
  );
  const hoveringGridPosition = hoveringGrid.worldToGrid(hoveringSnapped.x, hoveringSnapped.y);
  const hoveringBuilding = hoveringConstruction.startBuilding(
    world,
    'towerFabricator',
    hoveringGridPosition.gx,
    hoveringGridPosition.gy,
    playerIds[0],
    0,
    0,
    {
      skipBuilderAuthorization: true,
      ignoreTerrainForPlacement: false,
    },
  );
  assertContract(hoveringBuilding !== null, 'hovering building fixture must place over water');
  assertContract(
    hoveringBuilding.transform.z - hoveringBuilding.building!.depth / 2 >=
      world.getGroundZ(hoveringBuilding.transform.x, hoveringBuilding.transform.y),
    'hovering building base must remain at or above the visible water surface',
  );

  const construction = new ConstructionSystem(
    mapWidth,
    mapHeight,
    createNoBuildableTerrainGrid(mapWidth, mapHeight),
  );
  const extractors = spawnMetalExtractorsOnDeposits(world, construction, playerIds);

  assertContract(
    extractors.length === expectedDepositIds.size,
    `expected ${expectedDepositIds.size} demo auto-extractors on the authored layout; got ${extractors.length}`,
  );
  const coveredDepositIds = new Set<number>();
  for (let i = 0; i < extractors.length; i++) {
    const extractor = extractors[i];
    assertContract(
      (extractor.metalExtractionRate ?? 0) > 0,
      `extractor ${extractor.id} must retain positive deposit coverage`,
    );
    const coveredIds = extractor.coveredDepositIds;
    assertContract(coveredIds !== null, `extractor ${extractor.id} must publish covered deposit ids`);
    assertContract(
      coveredIds.length === 1,
      `extractor ${extractor.id} must cover exactly one authored deposit; got ${coveredIds.length}`,
    );
    const deposit = depositById.get(coveredIds[0]);
    assertContract(deposit !== undefined, `extractor ${extractor.id} covered an unknown deposit`);
    assertContract(
      extractor.transform.x === deposit.x && extractor.transform.y === deposit.y,
      `extractor ${extractor.id} must be centered on deposit ${deposit.id}`,
    );
    assertContract(
      Math.abs(
        extractor.transform.z - extractor.building!.depth / 2 -
        world.getTerrainBedZ(deposit.x, deposit.y),
      ) <= 1e-6,
      `extractor ${extractor.id} base must sit on deposit ${deposit.id}'s terrain bed`,
    );
    coveredDepositIds.add(deposit.id);
  }
  for (const depositId of expectedDepositIds) {
    assertContract(
      coveredDepositIds.has(depositId),
      `authored auto-extractor deposit ${depositId} must receive an extractor`,
    );
  }
}
