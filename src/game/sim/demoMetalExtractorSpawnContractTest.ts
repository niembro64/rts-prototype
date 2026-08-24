import {
  BATTLE_PRESETS,
  getModeDefaultPreset,
  type BattlePreset,
} from '../../components/battlePresets';
import { LAND_CELL_SIZE } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from './buildGrid';
import { getBuildingPlacementDiagnostics } from './buildPlacementValidation';
import { getBuildingConfig } from './buildConfigs';
import { ConstructionSystem } from './construction';
import { getStructureFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import {
  FABRICATOR_BLUEPRINT_IDS,
  getBuildingBlueprint,
  getFabricatorBuildingBlueprintId,
  getUnitBlueprint,
} from './blueprints';
import { getLiquidSurfaceMode, setLiquidSurfaceMode } from './worldSurfaceState';
import { spawnInitialBases, spawnMetalExtractorsOnDeposits } from './spawn';
import { buildTeamRosterFromSeatCounts } from './teamRoster';
import type { Entity, PlayerId } from './types';
import {
  BUILDING_BLUEPRINT_IDS,
  type UnitBlueprintId,
} from '../../types/blueprintIds';
import { WorldState } from './WorldState';
import {
  getTerrainRuntimeConfig,
  getTerrainTeamCount,
  isWaterAt,
  setAuthoritativeTerrainTileMap,
  setMetalDepositFlatZones,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from './Terrain';
import { getAuthoritativeTerrainTileMap } from './terrain/terrainState';
import { getMetalDepositFlatZones } from './terrain/terrainFlatZones';
import {
  GROUND_BUILD_SQUARE_FLAG,
  TERRAIN_BUILDABLE_FLAG,
  WATER_BUILD_SQUARE_FLAG,
} from './terrain/terrainBuildability';
import { expandPathPlan } from './Pathfinder';
import {
  applyLiquidHazardPathPolicy,
  pathTerrainFilterForLocomotion,
} from './pathfindingTraversal';
import {
  configurePathfindingCellConsolidationMultiplier,
  getPathfindingCellConsolidationMultiplier,
  registerPathfinderBuildingOccupancy,
} from './pathfinderTerrainCache';
import {
  DEFAULT_PATHFINDING_CELL_CONSOLIDATION_MULTIPLIER,
} from '../../types/pathfinding';

const CONTRACT_WATER_PERIMETER_MAGNITUDE = -800;
const CONTRACT_NEGATIVE_METAL_DEPOSIT_STEPS = [-100, -200, -400] as const;

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo metal extractor spawn contract] ${message}`);
}

const FABRICATOR_BLUEPRINT_ID_SET = new Set<string>(FABRICATOR_BLUEPRINT_IDS);

function isFabricatorEntity(entity: Entity): boolean {
  return entity.buildingBlueprintId !== null &&
    FABRICATOR_BLUEPRINT_ID_SET.has(entity.buildingBlueprintId);
}

function isSeededDemoFabricator(entity: Entity): boolean {
  return isFabricatorEntity(entity) &&
    entity.factory?.repeatProduction === true &&
    entity.factory.selectedUnitBlueprintId !== null;
}

function allStructureFactoryUnitBlueprintIds(): string[] {
  return [...new Set(
    FABRICATOR_BLUEPRINT_IDS.flatMap((buildingBlueprintId) =>
      getStructureFactoryAllowedUnitBlueprintIds(buildingBlueprintId)),
  )];
}

function assertSeededUniversalRepeatLine(entity: Entity): string {
  const buildingBlueprintId = entity.buildingBlueprintId;
  assertContract(
    buildingBlueprintId !== null && entity.factory !== null,
    `demo Fabricator ${entity.id} must identify its host and factory state`,
  );
  const factory = getBuildingBlueprint(buildingBlueprintId).factory;
  assertContract(
    factory !== null && factory.domain === 'universal',
    `demo Fabricator ${buildingBlueprintId} must be radial Universal production`,
  );
  const unitBlueprintId = entity.factory.selectedUnitBlueprintId;
  assertContract(
    entity.factory.repeatProduction === true && unitBlueprintId !== null,
    `demo Fabricator ${buildingBlueprintId} must repeat one selected unit`,
  );
  const production = getUnitBlueprint(unitBlueprintId).production;
  assertContract(
    production !== null &&
      buildingBlueprintId === getFabricatorBuildingBlueprintId(
        production.techLevel,
        'universal',
      ),
    `${buildingBlueprintId} must be the same-tier Universal required by ${unitBlueprintId}`,
  );
  assertContract(
    entity.factory.productionQueue.length === 0,
    `${buildingBlueprintId} repeat line must begin with an empty production queue`,
  );
  assertContract(
    Object.keys(entity.factory.productionQuotas).length === 0 &&
      Object.keys(entity.factory.productionQuotaCounts).length === 0,
    `${buildingBlueprintId} repeat line must not retain quota production state`,
  );
  assertContract(
    getStructureFactoryAllowedUnitBlueprintIds(buildingBlueprintId).includes(
      unitBlueprintId as UnitBlueprintId,
    ),
    `${buildingBlueprintId} must be allowed to produce ${unitBlueprintId}`,
  );
  return unitBlueprintId;
}

function assertDemoCommanderBuildingExclusions(
  entities: readonly Entity[],
  construction: ConstructionSystem,
): void {
  const commanders = entities.filter((entity) => entity.commander !== null);
  const buildings = entities.filter((entity) => entity.building !== null);
  const grid = construction.getGrid();
  const radius = DEMO_CONFIG.commanderBuildingExclusionRadius;
  const radiusSquared = radius * radius;
  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex++) {
    const building = buildings[buildingIndex];
    const blueprintId = building.buildingBlueprintId;
    assertContract(blueprintId !== null, `demo building ${building.id} must have a blueprint id`);
    const config = getBuildingConfig(blueprintId);
    const footprint = getRotatedBuildingPlacementFootprint(
      config.placementFootprint,
      0,
    );
    const snapped = grid.snapToGrid(
      building.transform.x,
      building.transform.y,
      config.placementGridWidth,
      config.placementGridHeight,
    );
    const baseGrid = grid.worldToGrid(snapped.x, snapped.y);
    for (let commanderIndex = 0; commanderIndex < commanders.length; commanderIndex++) {
      const commander = commanders[commanderIndex];
      for (let cellIndex = 0; cellIndex < footprint.cells.length; cellIndex++) {
        const cell = footprint.cells[cellIndex];
        const left = (baseGrid.gx + cell.dx) * BUILD_GRID_CELL_SIZE;
        const top = (baseGrid.gy + cell.dy) * BUILD_GRID_CELL_SIZE;
        const right = left + BUILD_GRID_CELL_SIZE;
        const bottom = top + BUILD_GRID_CELL_SIZE;
        const nearestX = Math.max(left, Math.min(commander.transform.x, right));
        const nearestY = Math.max(top, Math.min(commander.transform.y, bottom));
        const dx = commander.transform.x - nearestX;
        const dy = commander.transform.y - nearestY;
        assertContract(
          dx * dx + dy * dy >= radiusSquared,
          `demo building ${building.id} footprint must stay ${radius}wu from ` +
            `commander ${commander.id}`,
        );
      }
    }
  }
}

function assertDemoCommandersHavePathEgress(
  world: WorldState,
  entities: readonly Entity[],
  construction: ConstructionSystem,
): void {
  const previousMultiplier = getPathfindingCellConsolidationMultiplier();
  const grid = construction.getGrid();
  configurePathfindingCellConsolidationMultiplier(
    DEFAULT_PATHFINDING_CELL_CONSOLIDATION_MULTIPLIER,
  );
  const restoreBuildingOccupancy = registerPathfinderBuildingOccupancy({
    getVersion: () => grid.getVersion(),
    forEachBlockedCell: (visit) => {
      for (const { gx, gy } of grid.occupiedCells()) visit(gx, gy);
    },
  });
  try {
    const commanders = entities.filter((entity) => entity.commander !== null);
    for (let i = 0; i < commanders.length; i++) {
      const commander = commanders[i];
      const unit = commander.unit;
      assertContract(unit !== null, `commander ${commander.id} must have unit state`);
      const terrainFilter = applyLiquidHazardPathPolicy(
        pathTerrainFilterForLocomotion(
          unit.locomotion,
          unit.mass,
          unit.supportPointOffsetZ,
        ),
        world.liquidSurfaceMode,
      );
      const plan = expandPathPlan(
        commander.transform.x,
        commander.transform.y,
        world.mapWidth / 2,
        world.mapHeight / 2,
        world.mapWidth,
        world.mapHeight,
        null,
        terrainFilter,
        unit.radius.collision,
        world.slopePathMode === 'symmetric',
      );
      assertContract(
        plan.resolution !== 'unreachable' && plan.points.some((point) =>
          Math.hypot(
            point.x - commander.transform.x,
            point.y - commander.transform.y,
          ) > unit.radius.collision),
        `default consolidated path grid must provide egress for commander ${commander.id}`,
      );
    }
  } finally {
    restoreBuildingOccupancy();
    configurePathfindingCellConsolidationMultiplier(previousMultiplier);
  }
}

function createNoBuildableTerrainGrid(
  mapWidth: number,
  mapHeight: number,
  terrainBuildable = false,
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
    flags: Array.from({ length: cellCount }, (_, index) => {
      const gx = index % cellsX;
      const gy = Math.floor(index / cellsX);
      const x = (gx + 0.5) * BUILD_GRID_CELL_SIZE;
      const y = (gy + 0.5) * BUILD_GRID_CELL_SIZE;
      return isWaterAt(x, y, mapWidth, mapHeight)
        ? WATER_BUILD_SQUARE_FLAG | (terrainBuildable ? TERRAIN_BUILDABLE_FLAG : 0)
        : GROUND_BUILD_SQUARE_FLAG | (terrainBuildable ? TERRAIN_BUILDABLE_FLAG : 0);
    }),
    levels: new Array(cellCount).fill(0),
  };
}

function assertNegativeMetalDepositStepDemoSpawn(
  mapWidth: number,
  mapHeight: number,
  playerIds: readonly PlayerId[],
): void {
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  const disabledUnitBlueprintIds = new Set<string>();
  const disabledBuildingBlueprintIds = new Set<string>();

  try {
    for (const metalDepositStep of CONTRACT_NEGATIVE_METAL_DEPOSIT_STEPS) {
      setTerrainRuntimeConfig({
        ...previousRuntimeConfig,
        metalDepositStep,
      });
      assertContract(
        getTerrainRuntimeConfig().metalDepositStep === metalDepositStep,
        `terrain runtime must retain D-DEPOSIT ${metalDepositStep}`,
      );

      const deposits = generateMetalDeposits(
        mapWidth,
        mapHeight,
        playerIds.length,
      );
      const commanderDeposits = deposits.filter(
        (deposit) => deposit.dTerrainLevels === 1,
      );
      assertContract(
        commanderDeposits.length === playerIds.length * 3,
        `D-DEPOSIT ${metalDepositStep} must retain the authored commander deposit triangles`,
      );
      assertContract(
        commanderDeposits.every(
          (deposit) => deposit.height === metalDepositStep,
        ),
        `D-DEPOSIT ${metalDepositStep} must lower every level-one commander deposit`,
      );

      const world = new WorldState(
        1700 - metalDepositStep,
        mapWidth,
        mapHeight,
      );
      world.playerCount = playerIds.length;
      world.metalDeposits = commanderDeposits;
      const construction = new ConstructionSystem(
        mapWidth,
        mapHeight,
        createNoBuildableTerrainGrid(mapWidth, mapHeight),
      );
      const baseEntities = spawnInitialBases(
        world,
        construction,
        [...playerIds],
        'demo',
        disabledUnitBlueprintIds,
        disabledBuildingBlueprintIds,
      );
      const commanders = baseEntities.filter(
        (entity) => entity.unit?.unitBlueprintId === 'unitCommander',
      );
      assertContract(
        commanders.length === playerIds.length,
        `D-DEPOSIT ${metalDepositStep} demo base must spawn every commander`,
      );
      for (let i = 0; i < commanders.length; i++) {
        const commander = commanders[i];
        const bedZ = world.getTerrainBedZ(
          commander.transform.x,
          commander.transform.y,
        );
        const groundZ = world.getGroundZ(
          commander.transform.x,
          commander.transform.y,
        );
        assertContract(
          Math.abs(bedZ - metalDepositStep) <= 1e-6,
          `D-DEPOSIT ${metalDepositStep} commander ${commander.id} must spawn over the lowered commander pad`,
        );
        assertContract(
          commander.transform.z > groundZ,
          `D-DEPOSIT ${metalDepositStep} commander ${commander.id} must spawn above its support surface`,
        );
      }

      const extractors = spawnMetalExtractorsOnDeposits(
        world,
        construction,
        [...playerIds],
      );
      assertContract(
        extractors.length < commanderDeposits.length,
        `D-DEPOSIT ${metalDepositStep} must skip commander-pad extractors inside the no-building zones`,
      );
      for (let i = 0; i < extractors.length; i++) {
        const extractor = extractors[i];
        for (let j = 0; j < commanders.length; j++) {
          const commander = commanders[j];
          assertContract(
            Math.hypot(
              extractor.transform.x - commander.transform.x,
              extractor.transform.y - commander.transform.y,
            ) >= DEMO_CONFIG.commanderBuildingExclusionRadius,
            `D-DEPOSIT ${metalDepositStep} extractor ${extractor.id} must stay outside ` +
              `commander ${commander.id}'s no-building zone`,
          );
        }
      }
    }
  } finally {
    setTerrainRuntimeConfig(previousRuntimeConfig);
  }
}

/** The smallest stock map with an authored outer-water ring is the offshore
 * packing stress case. A dry-perimeter preset can still contain a small lake,
 * but its demo placement is deliberately best-effort: it must not be forced to
 * pack all fifty naval production lines into that shared interior pocket. The
 * MODE DEFAULT preset is asserted too: it is the map the demo actually boots,
 * so a base row that only fits in an idealized world is caught here. Both runs
 * install the generated metal deposits BEFORE the base spawn, mirroring
 * ServerBootstrap — deposit pads block non-extractor placement, and a
 * deposit-free test world quietly passes layouts that fail in the real demo. */
function assertCompactAuthoredRosterFactoryCoverage(): void {
  const offshorePresets = BATTLE_PRESETS.filter(
    (preset) => preset.liquidSurfaceMode === 'water' && preset.perimeterMagnitude < 0,
  );
  assertContract(
    offshorePresets.length > 0,
    'stock presets must retain at least one authored outer-water showcase',
  );
  let compactPreset = offshorePresets[0]!;
  for (let i = 1; i < offshorePresets.length; i++) {
    const candidate = offshorePresets[i];
    if (
      candidate.mapWidthLandCells * candidate.mapLengthLandCells <
      compactPreset.mapWidthLandCells * compactPreset.mapLengthLandCells
    ) {
      compactPreset = candidate;
    }
  }
  assertAuthoredRosterCoverageForPreset(getModeDefaultPreset('demo'), 1240);
  assertAuthoredRosterCoverageForPreset(compactPreset, 1241);
}

function assertUniversalFactoryCoverageByPlayer(
  entities: readonly Entity[],
  playerIds: readonly PlayerId[],
  expectedUnitBlueprintIds: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedUnitBlueprintIds);
  const factoriesByPlayer = new Map<PlayerId, Entity[]>();
  for (const entity of entities) {
    if (!isFabricatorEntity(entity)) continue;
    assertSeededUniversalRepeatLine(entity);
    assertContract(
      entity.buildingBlueprintId === 'towerFabricator' ||
        entity.buildingBlueprintId === 'buildingAdvancedUniversalFabricator',
      `${label} initialized production must never use directional specialist ${entity.buildingBlueprintId}`,
    );
    assertContract(
      entity.transform.rotation === 0,
      `${label} initialized Universal ${entity.id} must keep its radial authored pose`,
    );
    const playerId = entity.ownership?.playerId;
    assertContract(playerId !== undefined, `${label} Universal must have an owner`);
    const rows = factoriesByPlayer.get(playerId) ?? [];
    rows.push(entity);
    factoriesByPlayer.set(playerId, rows);
  }
  for (const playerId of playerIds) {
    const factories = factoriesByPlayer.get(playerId) ?? [];
    assertContract(
      factories.length === expectedUnitBlueprintIds.length,
      `${label} player ${playerId} must have one Universal per active unit; ` +
        `expected ${expectedUnitBlueprintIds.length}, got ${factories.length}`,
    );
    const coverage = new Set<string>();
    for (const factoryEntity of factories) {
      const unitBlueprintId = assertSeededUniversalRepeatLine(factoryEntity);
      assertContract(
        !coverage.has(unitBlueprintId),
        `${label} must not duplicate repeat line ${unitBlueprintId}`,
      );
      coverage.add(unitBlueprintId);
    }
    const missing = expectedUnitBlueprintIds.filter((id) => !coverage.has(id));
    const unexpected = [...coverage].filter((id) => !expected.has(id));
    assertContract(
      coverage.size === expected.size && missing.length === 0 && unexpected.length === 0,
      `${label} player ${playerId} Universal quotas must cover the full roster; ` +
        `missing ${missing.join(', ') || 'none'}, unexpected ${unexpected.join(', ') || 'none'}`,
    );
  }
}

function assertAuthoredRosterCoverageForPreset(
  compactPreset: BattlePreset,
  seed: number,
): void {
  setTerrainRuntimeConfig({
    centerMagnitude: compactPreset.centerMagnitude,
    ringMagnitude: compactPreset.ringMagnitude,
    dividersMagnitude: compactPreset.dividersMagnitude,
    perimeterMagnitude: compactPreset.perimeterMagnitude,
    terrainPrecedence: compactPreset.terrainPrecedence,
    terrainDTerrain: compactPreset.terrainDTerrain,
    plateauWallSlopeDegrees: compactPreset.plateauWallSlopeDegrees,
    metalDepositStep: compactPreset.metalDepositStep,
    terrainDetail: compactPreset.terrainDetail,
  });
  const mapWidth = compactPreset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = compactPreset.mapLengthLandCells * LAND_CELL_SIZE;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) {
    playerIds.push((i + 1) as PlayerId);
  }
  const world = new WorldState(seed, mapWidth, mapHeight);
  world.setTeamRoster(buildTeamRosterFromSeatCounts(
    playerIds,
    DEMO_CONFIG.allyTeamSeats,
  ));
  // Real boot order: deposits exist before any base row places.
  world.metalDeposits = generateMetalDeposits(mapWidth, mapHeight, playerIds.length);
  const construction = new ConstructionSystem(mapWidth, mapHeight, null);
  const entities = spawnInitialBases(world, construction, playerIds, 'demo');
  entities.push(...spawnMetalExtractorsOnDeposits(
    world,
    construction,
    playerIds,
  ));
  assertDemoCommanderBuildingExclusions(entities, construction);
  assertDemoCommandersHavePathEgress(world, entities, construction);
  const expectedUnitBlueprintIds = allStructureFactoryUnitBlueprintIds();
  assertUniversalFactoryCoverageByPlayer(
    entities,
    playerIds,
    expectedUnitBlueprintIds,
    compactPreset.name,
  );

  // End-to-end Demo visibility contract. This inspects entities returned by
  // the real base/deposit spawning path, not toggle defaults or a duplicate
  // expected list. Adding a registry blueprint that fails to instantiate for
  // even one seat therefore fails immediately in development.
  const buildingCoverageByPlayer = new Map<PlayerId, Set<string>>();
  for (const entity of entities) {
    const buildingBlueprintId = entity.buildingBlueprintId;
    const playerId = entity.ownership?.playerId;
    if (buildingBlueprintId === null || playerId === undefined) continue;
    let coverage = buildingCoverageByPlayer.get(playerId);
    if (coverage === undefined) {
      coverage = new Set<string>();
      buildingCoverageByPlayer.set(playerId, coverage);
    }
    coverage.add(buildingBlueprintId);
  }
  for (const playerId of playerIds) {
    const coverage = buildingCoverageByPlayer.get(playerId) ?? new Set<string>();
    const missing = BUILDING_BLUEPRINT_IDS.filter((id) =>
      !coverage.has(id) && !(
        FABRICATOR_BLUEPRINT_ID_SET.has(id) &&
        id !== 'towerFabricator' &&
        id !== 'buildingAdvancedUniversalFabricator'
      ));
    assertContract(
      missing.length === 0,
      `${compactPreset.name} Demo seat ${playerId} must instantiate every current building; ` +
        `missing ${missing.join(', ')}`,
    );
  }

  // The radar↔beam band packs six evenly spaced rows (tech pair,
  // anti-air, converter, solar, cannon) between its fixed endpoints.
  // Placement is best-effort by design, so a footprint collision on the
  // tightened spacing would silently remove or displace a row without
  // failing startup — assert every seat actually received every band
  // building at its configured count, endpoints included.
  const expectedBandCounts: ReadonlyArray<readonly [string, number]> = [
    ['buildingRadar', DEMO_CONFIG.buildingRadarCount],
    ['buildingShieldTargetingTech', DEMO_CONFIG.buildingShieldTargetingTechCount],
    ['buildingShieldTech', DEMO_CONFIG.buildingShieldTechCount],
    ['towerAntiAir', DEMO_CONFIG.towerAntiAirCount],
    ['buildingResourceConverter', DEMO_CONFIG.buildingResourceConverterCount],
    ['buildingSolar', DEMO_CONFIG.buildingSolarCount],
    ['towerCannon', DEMO_CONFIG.towerCannonCount],
    ['towerHelios', DEMO_CONFIG.towerHeliosCount],
    ['towerBeamMega', DEMO_CONFIG.towerBeamMegaCount],
  ];
  for (const [bandBlueprintId, expectedCount] of expectedBandCounts) {
    const countByPlayer = new Map<PlayerId, number>();
    for (const entity of entities) {
      if (entity.buildingBlueprintId !== bandBlueprintId) continue;
      const playerId = entity.ownership?.playerId;
      assertContract(playerId !== undefined, `demo ${bandBlueprintId} must have an owner`);
      countByPlayer.set(playerId, (countByPlayer.get(playerId) ?? 0) + 1);
    }
    for (const playerId of playerIds) {
      assertContract(
        (countByPlayer.get(playerId) ?? 0) === expectedCount,
        `${compactPreset.name} player ${playerId} must spawn ${expectedCount} ` +
          `${bandBlueprintId} (got ${countByPlayer.get(playerId) ?? 0})`,
      );
    }
  }
}

/** A user-authored map can be physically too small for every requested demo
 * Universal. Missing optional placements are allowed there; startup itself is
 * not. */
function assertConstrainedFactoryPlacementIsNonFatal(): void {
  const mapWidth = 600;
  const mapHeight = 600;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) {
    playerIds.push((i + 1) as PlayerId);
  }
  const world = new WorldState(1244, mapWidth, mapHeight);
  world.setTeamRoster(buildTeamRosterFromSeatCounts(
    playerIds,
    DEMO_CONFIG.allyTeamSeats,
  ));
  const construction = new ConstructionSystem(mapWidth, mapHeight, null);
  const entities = spawnInitialBases(
    world,
    construction,
    playerIds,
    'demo',
    new Set<string>(['unitBadger']),
    new Set<string>(['buildingAdvancedUniversalFabricator']),
  );
  const factories = entities.filter(
    isSeededDemoFabricator,
  );
  assertContract(
    factories.length < playerIds.length,
    'constrained map must allow a partial or empty, nonfatal Universal placement',
  );
  assertContract(
    factories.every(
      (entity) =>
        entity.buildingBlueprintId === 'buildingAdvancedUniversalFabricator' &&
        entity.factory?.repeatProduction === true &&
        entity.factory.selectedUnitBlueprintId === 'unitBadger' &&
        Object.keys(entity.factory.productionQuotas).length === 0 &&
        Object.keys(entity.factory.productionQuotaCounts).length === 0,
    ),
    'every constrained-map Universal that fits must repeat-build unitBadger',
  );
}

function runDemoMetalExtractorSpawnContractTestForPreset(
  preset: BattlePreset,
): void {
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) {
    playerIds.push((i + 1) as PlayerId);
  }

  const baseWorld = new WorldState(1241, mapWidth, mapHeight);
  const baseConstruction = new ConstructionSystem(mapWidth, mapHeight, null);
  const baseEntities = spawnInitialBases(
    baseWorld,
    baseConstruction,
    playerIds,
    'demo',
  );
  const expectedFactoryUnitBlueprintIds = allStructureFactoryUnitBlueprintIds();
  assertUniversalFactoryCoverageByPlayer(
    baseEntities,
    playerIds,
    expectedFactoryUnitBlueprintIds,
    preset.name,
  );
  const sonarByPlayer = new Map<PlayerId, number>();
  for (let i = 0; i < baseEntities.length; i++) {
    const entity = baseEntities[i];
    if (entity.buildingBlueprintId !== 'buildingSonar') continue;
    const playerId = entity.ownership?.playerId;
    assertContract(playerId !== undefined, 'demo Sonar must have an owning player');
    sonarByPlayer.set(playerId, (sonarByPlayer.get(playerId) ?? 0) + 1);
  }
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    assertContract(
      sonarByPlayer.get(playerId) === DEMO_CONFIG.buildingSonarCount,
      `demo base must spawn ${DEMO_CONFIG.buildingSonarCount} Sonar for player ${playerId}`,
    );
  }
  assertNegativeMetalDepositStepDemoSpawn(mapWidth, mapHeight, playerIds);

  const deposits = generateMetalDeposits(mapWidth, mapHeight, playerIds.length);
  const expectedDepositIds = new Set<number>();
  const depositById = new Map<number, (typeof deposits)[number]>();
  for (let i = 0; i < deposits.length; i++) {
    const deposit = deposits[i];
    assertContract(
      deposit.cells.every(
        (cell) =>
          cell.x >= 0 &&
          cell.x < mapWidth &&
          cell.y >= 0 &&
          cell.y < mapHeight,
      ),
      `authored metal deposit ${deposit.id} must stay inside the map footprint`,
    );
    depositById.set(deposit.id, deposit);
    if (deposit.demoAutoExtractor) expectedDepositIds.add(deposit.id);
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

  let aboveWaterSensorPoint: { x: number; y: number } | null = null;
  let underwaterSensorPoint: { x: number; y: number } | null = null;
  const sensorPlacementOptions = {
    includeMetalDiagnostics: false,
    ignoreTerrain: true,
  };
  for (
    let y = BUILD_GRID_CELL_SIZE * 4;
    y < mapHeight - BUILD_GRID_CELL_SIZE * 4 &&
    (aboveWaterSensorPoint === null || underwaterSensorPoint === null);
    y += BUILD_GRID_CELL_SIZE
  ) {
    for (
      let x = BUILD_GRID_CELL_SIZE * 4;
      x < mapWidth - BUILD_GRID_CELL_SIZE * 4 &&
      (aboveWaterSensorPoint === null || underwaterSensorPoint === null);
      x += BUILD_GRID_CELL_SIZE
    ) {
      const snappedX =
        Math.round(x / BUILD_GRID_CELL_SIZE) * BUILD_GRID_CELL_SIZE;
      const snappedY =
        Math.round(y / BUILD_GRID_CELL_SIZE) * BUILD_GRID_CELL_SIZE;
      if (
        aboveWaterSensorPoint === null &&
        getBuildingPlacementDiagnostics(
          'buildingRadar',
          snappedX,
          snappedY,
          mapWidth,
          mapHeight,
          [],
          [],
          new Set(),
          null,
          0,
          sensorPlacementOptions,
        ).canPlace
      ) {
        aboveWaterSensorPoint = { x: snappedX, y: snappedY };
      }
      if (
        underwaterSensorPoint === null &&
        getBuildingPlacementDiagnostics(
          'buildingSonar',
          snappedX,
          snappedY,
          mapWidth,
          mapHeight,
          [],
          [],
          new Set(),
          null,
          0,
          sensorPlacementOptions,
        ).canPlace
      ) {
        underwaterSensorPoint = { x: snappedX, y: snappedY };
      }
    }
  }
  assertContract(
    aboveWaterSensorPoint !== null && underwaterSensorPoint !== null,
    'demo terrain must expose both sensor source media',
  );
  const radarAbove = getBuildingPlacementDiagnostics(
    'buildingRadar',
    aboveWaterSensorPoint.x,
    aboveWaterSensorPoint.y,
    mapWidth,
    mapHeight,
    [],
    [],
    new Set(),
    null,
    0,
    sensorPlacementOptions,
  );
  const sonarAbove = getBuildingPlacementDiagnostics(
    'buildingSonar',
    aboveWaterSensorPoint.x,
    aboveWaterSensorPoint.y,
    mapWidth,
    mapHeight,
    [],
    [],
    new Set(),
    null,
    0,
    sensorPlacementOptions,
  );
  const radarUnderwater = getBuildingPlacementDiagnostics(
    'buildingRadar',
    underwaterSensorPoint.x,
    underwaterSensorPoint.y,
    mapWidth,
    mapHeight,
    [],
    [],
    new Set(),
    null,
    0,
    sensorPlacementOptions,
  );
  const sonarUnderwater = getBuildingPlacementDiagnostics(
    'buildingSonar',
    underwaterSensorPoint.x,
    underwaterSensorPoint.y,
    mapWidth,
    mapHeight,
    [],
    [],
    new Set(),
    null,
    0,
    sensorPlacementOptions,
  );
  assertContract(radarAbove.canPlace, 'radar placement must accept an above-water source center');
  assertContract(!sonarAbove.canPlace, 'sonar placement must reject an above-water source center');
  assertContract(!radarUnderwater.canPlace, 'radar placement must reject an underwater source center');
  assertContract(sonarUnderwater.canPlace, 'sonar placement must accept an underwater source center');

  const extractorConfig = getBuildingConfig('buildingExtractor');
  const manualConstruction = new ConstructionSystem(
    mapWidth,
    mapHeight,
    createNoBuildableTerrainGrid(mapWidth, mapHeight, true),
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
      coveredIds.length >= 1,
      `extractor ${extractor.id} must cover an authored deposit`,
    );
    // The authored centre pieces are deliberately huge and deliberately
    // overlap, so a footprint can straddle two ore bodies and which of them
    // claims a shared cell is arbitrary. Income does not care — it counts ore
    // cells, not deposits. What must hold is that the extractor is centred on
    // a deposit it actually covers.
    const deposit = coveredIds
      .map((coveredId) => depositById.get(coveredId))
      .find((covered) =>
        covered !== undefined &&
        extractor.transform.x === covered.x &&
        extractor.transform.y === covered.y);
    assertContract(
      deposit !== undefined,
      `extractor ${extractor.id} must be centered on a deposit it covers`,
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

/** Every authored demo row must actually land on the map for every seat. The
 *  tech labs are the ones this keeps catching: they are the newest rows, they
 *  sit on tight rings inside the base, and a row that silently fails to place
 *  looks exactly like a row nobody wired up. A count of zero here is the bug
 *  "the building is not automatically built in the demo battle". */
function assertDemoTechLabsSpawnForEverySeat(preset: BattlePreset): void {
  // Run on the preset's OWN terrain, not the wet perimeter the offshore
  // assertions force: the tech labs sit on the outer base rings, and under a
  // -800 perimeter those rings are sea. This asserts what the demo actually
  // ships, which is the thing a player sees.
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    ringMagnitude: preset.ringMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    perimeterMagnitude: preset.perimeterMagnitude,
    terrainPrecedence: preset.terrainPrecedence,
    terrainDTerrain: preset.terrainDTerrain,
    plateauWallSlopeDegrees: preset.plateauWallSlopeDegrees,
    metalDepositStep: preset.metalDepositStep,
    terrainDetail: preset.terrainDetail,
  });
  try {
    assertDemoTechLabsSpawnOnCurrentTerrain(preset);
  } finally {
    setTerrainRuntimeConfig(previousRuntimeConfig);
  }
}

function assertDemoTechLabsSpawnOnCurrentTerrain(preset: BattlePreset): void {
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) playerIds.push((i + 1) as PlayerId);
  const world = new WorldState(1246, mapWidth, mapHeight);
  // Same world the demo boots: seats split across ally teams, and deposits
  // installed before any base row places. Without the roster every seat
  // resolves to ally team 0's spoke and all five bases pile onto one arc,
  // which is a placement fight the shipped demo never has.
  world.setTeamRoster(buildTeamRosterFromSeatCounts(
    playerIds,
    DEMO_CONFIG.allyTeamSeats,
  ));
  world.metalDeposits = generateMetalDeposits(mapWidth, mapHeight, playerIds.length);
  const construction = new ConstructionSystem(mapWidth, mapHeight, null);
  const entities = spawnInitialBases(world, construction, [...playerIds], 'demo');
  const expectedCounts: readonly (readonly [string, number])[] = [
    ['buildingShieldTargetingTech', DEMO_CONFIG.buildingShieldTargetingTechCount],
    ['buildingShieldTech', DEMO_CONFIG.buildingShieldTechCount],
    ['buildingPrecisionTargetingTech', DEMO_CONFIG.buildingPrecisionTargetingTechCount],
  ];
  const shortfalls: string[] = [];
  for (const [buildingBlueprintId, expected] of expectedCounts) {
    if (expected <= 0) continue;
    for (const playerId of playerIds) {
      const placed = entities.filter((entity) =>
        entity.buildingBlueprintId === buildingBlueprintId
        && entity.ownership?.playerId === playerId).length;
      if (placed !== expected) {
        shortfalls.push(`${buildingBlueprintId}@seat${playerId}=${placed}/${expected}`);
      }
    }
  }
  assertContract(
    shortfalls.length === 0,
    `every authored demo tech lab must place for every seat; missing ${shortfalls.join(' ')}`,
  );
}

export function runDemoMetalExtractorSpawnContractTest(): void {
  const preset = getModeDefaultPreset('demo');
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  const previousTeamCount = getTerrainTeamCount();
  const previousTerrain = getAuthoritativeTerrainTileMap();
  const previousLiquidSurfaceMode = getLiquidSurfaceMode();
  const previousMetalDepositFlatZones = getMetalDepositFlatZones();
  // Procedural test fixtures must not inherit the live/background battle's
  // installed terrain mesh or divider count. An authoritative tile map wins
  // over runtime magnitudes, which otherwise makes this contract depend on
  // whichever map-oriented test happened to run immediately before it.
  setAuthoritativeTerrainTileMap(null);
  // Deposit pads are another process-wide layer of terrain truth. The lobby's
  // long-running background battle may have installed pads for a different
  // map by the time this late contract starts; those pads must not flatten the
  // procedural water search used by these fixtures.
  setMetalDepositFlatZones([], false);
  setTerrainTeamCount(DEMO_CONFIG.allyTeamSeats.length);
  setLiquidSurfaceMode(preset.liquidSurfaceMode);
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    ringMagnitude: preset.ringMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    // The baseline assertions exercise the authored offshore layout even if
    // the current demo preset has deliberately selected a dry perimeter.
    perimeterMagnitude: CONTRACT_WATER_PERIMETER_MAGNITUDE,
    terrainPrecedence: preset.terrainPrecedence,
    terrainDTerrain: preset.terrainDTerrain,
    plateauWallSlopeDegrees: preset.plateauWallSlopeDegrees,
    metalDepositStep: preset.metalDepositStep,
    terrainDetail: preset.terrainDetail,
  });
  try {
    runDemoMetalExtractorSpawnContractTestForPreset(preset);
    assertCompactAuthoredRosterFactoryCoverage();
    assertDemoTechLabsSpawnForEverySeat(preset);
    assertConstrainedFactoryPlacementIsNonFatal();
  } finally {
    setMetalDepositFlatZones(previousMetalDepositFlatZones, false);
    setTerrainRuntimeConfig(previousRuntimeConfig);
    setTerrainTeamCount(previousTeamCount);
    setAuthoritativeTerrainTileMap(previousTerrain);
    setLiquidSurfaceMode(previousLiquidSurfaceMode);
  }
}
