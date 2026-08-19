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
import { spawnInitialBases, spawnMetalExtractorsOnDeposits } from './spawn';
import { buildTeamRosterFromSeatCounts } from './teamRoster';
import type { Entity, PlayerId } from './types';
import { BUILDING_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { WorldState } from './WorldState';
import {
  getTerrainRuntimeConfig,
  isWaterAt,
  setTerrainPerimeterMagnitude,
  setTerrainRuntimeConfig,
} from './Terrain';
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

function assertDryPerimeterFactoryFallback(
  mapWidth: number,
  mapHeight: number,
  playerIds: readonly PlayerId[],
): void {
  const previousPerimeterMagnitude =
    getTerrainRuntimeConfig().perimeterMagnitude;
  const waterUnitBlueprintIds = new Set<string>(
    DEMO_CONFIG.waterFabricators.unitBlueprintIds,
  );
  const factoryBuildingBlueprintIds = new Set<string>(['towerFabricator']);
  const noBuildableTerrainGrid = createNoBuildableTerrainGrid(
    mapWidth,
    mapHeight,
  );

  try {
    for (const perimeterMagnitude of [0, 800]) {
      setTerrainPerimeterMagnitude(perimeterMagnitude);
      const world = new WorldState(
        1243 + perimeterMagnitude,
        mapWidth,
        mapHeight,
      );
      const construction = new ConstructionSystem(
        mapWidth,
        mapHeight,
        noBuildableTerrainGrid,
      );
      const entities = spawnInitialBases(
        world,
        construction,
        [...playerIds],
        'demo',
        waterUnitBlueprintIds,
        factoryBuildingBlueprintIds,
      );
      let factoryCount = 0;
      let dryFactoryCount = 0;
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (entity.buildingBlueprintId !== 'towerFabricator') continue;
        factoryCount++;
        const factory = entity.factory;
        assertContract(
          factory !== null &&
            factory.selectedUnitBlueprintId !== null &&
            waterUnitBlueprintIds.has(factory.selectedUnitBlueprintId),
          `dry perimeter ${perimeterMagnitude} Fabricator must retain its water-unit repeat line`,
        );
        // The outer ring is MIXED at these magnitudes, not uniformly dry, so a
        // per-Fabricator dryness demand is simply false: one that found water
        // took the primary offshore path and belongs there. What must hold is
        // that the dry-arc fallback works at all, asserted over the set below.
        if (!isWaterAt(entity.transform.x, entity.transform.y, mapWidth, mapHeight)) {
          dryFactoryCount++;
        }
        assertContract(
          factory.defaultWaypoints?.length === 2 &&
            factory.defaultWaypoints.every(
              (waypoint) => waypoint.type === 'patrol',
            ),
          `dry perimeter ${perimeterMagnitude} fallback Fabricator must retain its outer patrol route`,
        );
      }
      assertContract(
        factoryCount === playerIds.length * waterUnitBlueprintIds.size,
        `dry perimeter ${perimeterMagnitude} must spawn one Fabricator per water unit per player`,
      );
      assertContract(
        dryFactoryCount > 0,
        `dry perimeter ${perimeterMagnitude} must place at least one Fabricator on the authored dry outer arc, ` +
          'proving the fallback that bypasses terrain suitability still runs',
      );
    }
  } finally {
    setTerrainPerimeterMagnitude(previousPerimeterMagnitude);
  }
}

/** LIQUID = LAVA turns off everything that belongs in or on the water: the
 * offshore water-unit Fabricator arc and its Sonar ring must not spawn, and
 * every Fabricator that does spawn must be a land production line placed
 * over land. The baseline assertions above prove LIQUID = WATER keeps the
 * authored offshore installation on this same terrain. */
function assertLavaWorldSpawnExcludesWaterRoster(
  mapWidth: number,
  mapHeight: number,
  playerIds: readonly PlayerId[],
): void {
  const world = new WorldState(1245, mapWidth, mapHeight);
  world.liquidSurfaceMode = 'lava';
  const construction = new ConstructionSystem(mapWidth, mapHeight, null);
  const entities = spawnInitialBases(
    world,
    construction,
    [...playerIds],
    'demo',
  );
  const waterUnitBlueprintIds = new Set<string>(
    DEMO_CONFIG.waterFabricators.unitBlueprintIds,
  );
  const expectedLandUnitBlueprintIds =
    getStructureFactoryAllowedUnitBlueprintIds('towerFabricator').filter(
      (unitBlueprintId) => !waterUnitBlueprintIds.has(unitBlueprintId),
    );
  const selectionsByPlayer = new Map<PlayerId, Set<string>>();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    assertContract(
      entity.buildingBlueprintId !== 'buildingSonar',
      'LIQUID = LAVA demo must not spawn the water-surface Sonar ring',
    );
    if (entity.buildingBlueprintId !== 'towerFabricator') continue;
    const playerId = entity.ownership?.playerId;
    const selected = entity.factory?.selectedUnitBlueprintId;
    assertContract(playerId !== undefined, 'lava demo Fabricator must have an owner');
    assertContract(
      selected !== null && selected !== undefined &&
        !waterUnitBlueprintIds.has(selected),
      `LIQUID = LAVA demo must not seed water production line ${selected}`,
    );
    assertContract(
      !isWaterAt(entity.transform.x, entity.transform.y, mapWidth, mapHeight),
      `LIQUID = LAVA demo Fabricator ${entity.id} must be placed over land`,
    );
    let selections = selectionsByPlayer.get(playerId);
    if (selections === undefined) {
      selections = new Set<string>();
      selectionsByPlayer.set(playerId, selections);
    }
    selections.add(selected);
  }
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const selections = selectionsByPlayer.get(playerId);
    assertContract(
      selections?.size === expectedLandUnitBlueprintIds.length,
      `LIQUID = LAVA player ${playerId} must keep every land repeat line; ` +
        `expected ${expectedLandUnitBlueprintIds.length}, got ${selections?.size ?? 0}`,
    );
  }
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

/** The smallest stock map with the authored [1,2,0,3] roster is the packing
 * stress case. It must retain exact coverage even though genuinely constrained
 * custom maps use best-effort placement. The MODE DEFAULT preset is asserted
 * too: it is the map the demo actually boots, so a base row that only fits in
 * an idealized world is caught here. Both runs install the generated metal
 * deposits BEFORE the base spawn, mirroring ServerBootstrap — deposit pads
 * block non-extractor placement, and a deposit-free test world quietly passes
 * layouts that fail in the real demo. */
function assertCompactAuthoredRosterFactoryCoverage(): void {
  let compactPreset = BATTLE_PRESETS[0];
  for (let i = 1; i < BATTLE_PRESETS.length; i++) {
    const candidate = BATTLE_PRESETS[i];
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

function assertAuthoredRosterCoverageForPreset(
  compactPreset: BattlePreset,
  seed: number,
): void {
  setTerrainRuntimeConfig({
    centerMagnitude: compactPreset.centerMagnitude,
    dividersMagnitude: compactPreset.dividersMagnitude,
    perimeterMagnitude: compactPreset.perimeterMagnitude,
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
  const expectedUnitBlueprintIds =
    getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
  const expectedUnitBlueprintIdSet = new Set<string>(expectedUnitBlueprintIds);
  const coverage = new Map<PlayerId, Set<string>>();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.buildingBlueprintId !== 'towerFabricator') continue;
    const playerId = entity.ownership?.playerId;
    const factory = entity.factory;
    const selected = factory?.selectedUnitBlueprintId;
    assertContract(playerId !== undefined, 'compact demo Fabricator must have an owner');
    assertContract(
      factory?.repeatProduction === true && selected !== null && selected !== undefined,
      `compact demo Fabricator ${entity.id} must start in repeat production`,
    );
    assertContract(
      expectedUnitBlueprintIdSet.has(selected),
      `compact demo Fabricator ${entity.id} selected unexpected unit ${selected}`,
    );
    let selectedByPlayer = coverage.get(playerId);
    if (selectedByPlayer === undefined) {
      selectedByPlayer = new Set<string>();
      coverage.set(playerId, selectedByPlayer);
    }
    assertContract(
      !selectedByPlayer.has(selected),
      `compact demo player ${playerId} must not duplicate repeat line ${selected}`,
    );
    selectedByPlayer.add(selected);
  }
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    assertContract(
      coverage.get(playerId)?.size === expectedUnitBlueprintIds.length,
      `${compactPreset.name} player ${playerId} must retain all ` +
        `${expectedUnitBlueprintIds.length} repeat Fabricator lines`,
    );
  }

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
    const missing = BUILDING_BLUEPRINT_IDS.filter((id) => !coverage.has(id));
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
 * line. Missing optional placements are allowed there; startup itself is not.
 * This tiny map fits one 14x14-cell Fabricator footprint but not six. */
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
    new Set<string>(['towerFabricator']),
  );
  const factories = entities.filter(
    (entity) => entity.buildingBlueprintId === 'towerFabricator',
  );
  assertContract(
    factories.length < playerIds.length,
    'constrained map must allow a partial or empty, nonfatal Fabricator placement',
  );
  assertContract(
    factories.every(
      (entity) =>
        entity.factory?.repeatProduction === true &&
        entity.factory.selectedUnitBlueprintId === 'unitBadger',
    ),
    'every constrained-map Fabricator that fits must repeat-produce unitBadger',
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
  const expectedFactoryUnitBlueprintIds =
    getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
  const expectedFactoryUnitBlueprintIdSet =
    new Set<string>(expectedFactoryUnitBlueprintIds);
  const waterFactoryUnitBlueprintIdSet =
    new Set<string>(DEMO_CONFIG.waterFabricators.unitBlueprintIds);
  assertContract(
    waterFactoryUnitBlueprintIdSet.has('unitConstructionSubmarine'),
    'the construction submarine must use an outer-water demo Fabricator',
  );
  const factorySelectionsByPlayer = new Map<PlayerId, Map<string, number>>();
  const sonarByPlayer = new Map<PlayerId, number>();
  for (let i = 0; i < baseEntities.length; i++) {
    const entity = baseEntities[i];
    if (entity.buildingBlueprintId === 'towerFabricator') {
      const playerId = entity.ownership?.playerId;
      const factory = entity.factory;
      assertContract(playerId !== undefined, 'demo Fabricator must have an owning player');
      assertContract(factory !== null, 'demo Fabricator must have factory state');
      assertContract(
        factory.repeatProduction === true &&
          factory.selectedUnitBlueprintId !== null,
        `demo Fabricator ${entity.id} must start repeat-producing one unit`,
      );
      const selectedUnitBlueprintId = factory.selectedUnitBlueprintId;
      assertContract(
        expectedFactoryUnitBlueprintIdSet.has(selectedUnitBlueprintId),
        `demo Fabricator ${entity.id} selected unexpected unit ${selectedUnitBlueprintId}`,
      );
      let selectionCounts = factorySelectionsByPlayer.get(playerId);
      if (selectionCounts === undefined) {
        selectionCounts = new Map<string, number>();
        factorySelectionsByPlayer.set(playerId, selectionCounts);
      }
      selectionCounts.set(
        selectedUnitBlueprintId,
        (selectionCounts.get(selectedUnitBlueprintId) ?? 0) + 1,
      );
      if (waterFactoryUnitBlueprintIdSet.has(selectedUnitBlueprintId)) {
        assertContract(
          isWaterAt(
            entity.transform.x,
            entity.transform.y,
            baseWorld.mapWidth,
            baseWorld.mapHeight,
          ),
          `${selectedUnitBlueprintId} demo Fabricator must be on the outer-water ring`,
        );
      }
    }
    if (entity.buildingBlueprintId !== 'buildingSonar') continue;
    const playerId = entity.ownership?.playerId;
    assertContract(playerId !== undefined, 'demo Sonar must have an owning player');
    sonarByPlayer.set(playerId, (sonarByPlayer.get(playerId) ?? 0) + 1);
  }
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const selectionCounts = factorySelectionsByPlayer.get(playerId);
    assertContract(
      selectionCounts !== undefined,
      `demo base must spawn Fabricators for player ${playerId}`,
    );
    assertContract(
      selectionCounts.size === expectedFactoryUnitBlueprintIds.length,
      `demo player ${playerId} must have one repeat Fabricator for every unit; ` +
        `expected ${expectedFactoryUnitBlueprintIds.length}, got ${selectionCounts.size}`,
    );
    for (let j = 0; j < expectedFactoryUnitBlueprintIds.length; j++) {
      const unitBlueprintId = expectedFactoryUnitBlueprintIds[j];
      assertContract(
        selectionCounts.get(unitBlueprintId) === 1,
        `demo player ${playerId} must have exactly one repeat Fabricator for ${unitBlueprintId}`,
      );
    }
    assertContract(
      sonarByPlayer.get(playerId) === DEMO_CONFIG.buildingSonarCount,
      `demo base must spawn ${DEMO_CONFIG.buildingSonarCount} Sonar for player ${playerId}`,
    );
  }
  assertDryPerimeterFactoryFallback(mapWidth, mapHeight, playerIds);
  assertLavaWorldSpawnExcludesWaterRoster(mapWidth, mapHeight, playerIds);
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
    dividersMagnitude: preset.dividersMagnitude,
    perimeterMagnitude: preset.perimeterMagnitude,
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
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    // The baseline assertions exercise the authored offshore layout even if
    // the current demo preset has deliberately selected a dry perimeter.
    perimeterMagnitude: CONTRACT_WATER_PERIMETER_MAGNITUDE,
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
    setTerrainRuntimeConfig(previousRuntimeConfig);
  }
}
