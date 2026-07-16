import { UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND } from '../../config';
import {
  getLocomotionSurfaceHeight,
  refreshLocomotionSupportSurfaces,
  sampleLocomotionSupportSurface,
} from '../render3d/LocomotionTerrainSampler';
import { PhysicsEngine3D } from '../server/PhysicsEngine3D';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import {
  getTerrainRuntimeConfig,
  getTerrainTeamCount,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
  type TerrainRuntimeConfig,
} from './Terrain';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { BUILD_GRID_CELL_SIZE, BuildingGrid } from './buildGrid';
import {
  fabricatorTorusHoverHeight,
  fabricatorTorusOuterRadius,
  getAllUnitBlueprints,
  getUnitBlueprint,
} from './blueprints';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { getBuildingConfig } from './buildConfigs';
import { ConstructionSystem } from './construction';
import { executeCommand } from './commandExecution';
import {
  factoryProductionSystem,
  getFactoryShellSpawnClearanceAboveSurface,
} from './factoryProduction';
import {
  getFactoryProductionHoldVisual,
  getFactoryProductionPylonVisual,
  productionHoldRingRadiusForProducedUnit,
} from './factoryProductionHold';
import { ForceAccumulator } from './ForceAccumulator';
import { computeExtractorMetalCoverage } from './metalDepositOwnership';
import {
  createWorldSupportSurface,
  SUPPORT_SURFACE_CONTACT_EPSILON,
  type SupportSurfaceMaterialKind,
  type WorldSupportSurface,
} from './supportSurface';
import type {
  BuildingBlueprintId,
  Entity,
  PlayerId,
  Unit,
  UnitLocomotion,
} from './types';
import { WorldState } from './WorldState';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getHighestBuildFootprintGroundZ } from './buildingPlacementPolicy';

const TEST_PLAYER_ID = 1 as PlayerId;
const CONTRACT_EPSILON = 1e-6;
const SUPPORT_SURFACE_CONTRACT_TERRAIN: TerrainRuntimeConfig = {
  centerMagnitude: 0,
  dividersMagnitude: 0,
  // Negative perimeter sinks the outer ring below water so the contract
  // test can find both ground and water support surfaces (round-island).
  perimeterMagnitude: -800,
  terrainDTerrain: 0,
  plateauWallSlopeDegrees: 89,
  watersEdgeBeachSlopeDegrees: 10,
  watersEdgeCliffHeight: 100,
  metalDepositStep: 0,
  terrainDetail: 1,
};

function createAllBuildableTerrainGrid(mapWidth: number, mapHeight: number): TerrainBuildabilityGrid {
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
    configKey: 'support-surface-contract:all-buildable',
    flags: new Array(cellCount).fill(1),
    levels: new Array(cellCount).fill(0),
  };
}

function createNoBuildableTerrainGrid(mapWidth: number, mapHeight: number): TerrainBuildabilityGrid {
  const grid = createAllBuildableTerrainGrid(mapWidth, mapHeight);
  return {
    ...grid,
    configKey: 'support-surface-contract:none-buildable',
    flags: new Array(grid.flags.length).fill(0),
  };
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[support surface contract] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > CONTRACT_EPSILON) {
    throw new Error(
      `[support surface contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function findSurfacePoint(
  world: WorldState,
  materialKind: SupportSurfaceMaterialKind,
  margin: number = 0,
): { x: number; y: number; surface: WorldSupportSurface } {
  const scratch = createWorldSupportSurface();
  const candidates = [
    { x: world.mapWidth / 2, y: world.mapHeight / 2 },
    { x: margin, y: margin },
    { x: world.mapWidth - margin, y: margin },
    { x: margin, y: world.mapHeight - margin },
    { x: world.mapWidth - margin, y: world.mapHeight - margin },
  ];

  for (const candidate of candidates) {
    if (
      candidate.x < margin ||
      candidate.y < margin ||
      candidate.x > world.mapWidth - margin ||
      candidate.y > world.mapHeight - margin
    ) {
      continue;
    }
    const surface = world.sampleSupportSurface(candidate.x, candidate.y, {}, scratch);
    if (surface.materialKind === materialKind) {
      return { x: candidate.x, y: candidate.y, surface: { ...surface } };
    }
  }

  const searchSteps = [
    Math.max(16, Math.min(world.mapWidth, world.mapHeight) / 24),
    Math.max(4, Math.min(world.mapWidth, world.mapHeight) / 96),
  ];
  for (const step of searchSteps) {
    for (let y = margin; y <= world.mapHeight - margin; y += step) {
      for (let x = margin; x <= world.mapWidth - margin; x += step) {
        const surface = world.sampleSupportSurface(x, y, {}, scratch);
        if (surface.materialKind === materialKind) {
          return { x, y, surface: { ...surface } };
        }
      }
    }
  }

  throw new Error(
    `[support surface contract] could not find ${materialKind} terrain sample`,
  );
}

function withKnownSupportSurfaceTerrain(test: () => void): void {
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  const previousTeamCount = getTerrainTeamCount();
  setTerrainTeamCount(0);
  setTerrainRuntimeConfig(SUPPORT_SURFACE_CONTRACT_TERRAIN);
  try {
    test();
  } finally {
    setTerrainRuntimeConfig(previousRuntimeConfig);
    setTerrainTeamCount(previousTeamCount);
  }
}

function getBuildingSupportTopZ(entity: Entity): number {
  const building = entity.building;
  assertContract(building !== null, 'expected building support host');
  const support = building.supportSurface;
  assertContract(support.kind === 'boxTop', 'expected boxTop building support');
  return entity.transform.z - building.depth / 2 + support.topZ;
}

function getUnitSupportTopZ(entity: Entity): number {
  const unit = entity.unit;
  assertContract(unit !== null, 'expected unit support host');
  const support = unit.supportSurface;
  assertContract(support.kind === 'discTop', 'expected discTop unit support');
  return entity.transform.z - unit.bodyCenterHeight + support.topZ;
}

function assertSpawnedOnSupport(
  unitEntity: Entity,
  supportTopZ: number,
  message: string,
): void {
  const unit = unitEntity.unit;
  assertContract(unit !== null, `${message}: spawned entity must be a unit`);
  assertNear(
    unitEntity.transform.z,
    supportTopZ + unit.bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
    message,
  );
}

function assertFactoryShellSpawnedAboveSupport(
  unitEntity: Entity,
  supportTopZ: number,
  message: string,
  clearanceOverride?: number,
): void {
  const unit = unitEntity.unit;
  assertContract(unit !== null, `${message}: spawned entity must be a unit`);
  const clearance = clearanceOverride ?? getFactoryShellSpawnClearanceAboveSurface(unit);
  assertContract(
    clearance > UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
    `${message}: factory shell must use extra hold clearance`,
  );
  assertNear(
    unitEntity.transform.z,
    supportTopZ + unit.bodyCenterHeight + clearance,
    message,
  );
}

function assertFactoryShellPhysicsKeepsRoofSupport(
  world: WorldState,
  factory: Entity,
  shell: Entity,
  supportTopZ: number,
): void {
  assertContract(factory.building !== null, 'factory physics support contract requires a building');
  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  try {
    const building = factory.building;
    const expectsBuildingSupport =
      building.hoveringType === null && building.supportSurface.kind !== 'none';
    if (expectsBuildingSupport) {
      const baseZ = factory.transform.z - building.depth / 2;
      factory.body = {
        physicsBody: physics.createBuildingBody(
          factory.transform.x,
          factory.transform.y,
          building.width,
          building.height,
          building.depth,
          baseZ,
          building.supportSurface,
          `contract_factory_${factory.id}`,
          factory.id,
        ),
      };
    }
    const body = createPhysicsBodyForUnit(world, physics, shell, {
      ignoreOverlappingBuildings: true,
      overlapPadding: undefined,
    });
    assertContract(body !== undefined, 'factory shell physics body must be created');

    const terrainZ = world.getGroundZ(shell.transform.x, shell.transform.y);
    const terrainSurface = world.writeTerrainSupportSurfaceAt(
      shell.transform.x,
      shell.transform.y,
      terrainZ,
      world.getCachedSurfaceNormal(shell.transform.x, shell.transform.y),
    );
    const physicsSurface = physics.sampleSupportSurface(body, terrainSurface);
    if (expectsBuildingSupport) {
      assertContract(
        physicsSurface.supportKind === 'building' &&
          physicsSurface.supportEntityId === factory.id,
        'factory shell physics support must keep the factory roof as support',
      );
    } else {
      assertContract(
        physicsSurface.supportKind === 'terrain',
        'hovering factory shell physics support must stay on terrain',
      );
    }
    assertNear(physicsSurface.groundZ, supportTopZ, 'factory shell physics roof support height');

    const penetration = Math.min(2, Math.max(0.25, body.groundOffset * 0.25));
    body.z = supportTopZ + body.groundOffset - penetration;
    const penetratedPhysicsSurface = physics.sampleSupportSurface(body, terrainSurface);
    if (expectsBuildingSupport) {
      assertContract(
        penetratedPhysicsSurface.supportKind === 'building' &&
          penetratedPhysicsSurface.supportEntityId === factory.id,
        'factory shell physics support must keep roof support during contact penetration',
      );
    } else {
      assertContract(
        penetratedPhysicsSurface.supportKind === 'terrain',
        'hovering factory shell physics support must stay on terrain during contact penetration',
      );
    }
    assertNear(
      penetratedPhysicsSurface.groundZ,
      supportTopZ,
      'factory shell penetrated physics roof support height',
    );
  } finally {
    shell.body = null;
    factory.body = null;
    physics.dispose();
  }
}

function assertUnitActionCount(entity: Entity, count: number, message: string): Unit {
  const unit = entity.unit;
  assertContract(unit !== null, `${message}: entity must be a unit`);
  assertContract(unit.actions.length === count, message);
  return unit;
}

function factoryRepeatProduction(entity: Entity): boolean | undefined {
  return entity.factory?.repeatProduction;
}

function factoryResumeRepeatUnitBlueprintId(entity: Entity): string | null | undefined {
  return entity.factory?.resumeRepeatUnitBlueprintId;
}

function firstBlueprintIdByLocomotionType(): Map<UnitLocomotion['type'], string> {
  const idsByType = new Map<UnitLocomotion['type'], string>();
  for (const bp of getAllUnitBlueprints()) {
    if (!idsByType.has(bp.unitLocomotion.type)) {
      idsByType.set(bp.unitLocomotion.type, bp.unitBlueprintId);
    }
  }
  return idsByType;
}

function assertTerrainAndWaterContract(): void {
  const world = new WorldState(1234, 1024, 1024);
  world.playerCount = 2;

  const dry = findSurfacePoint(world, 'solid');
  assertContract(dry.surface.supportKind === 'terrain', 'solid terrain sample must be terrain support');
  assertContract(dry.surface.supportEntityId === null, 'terrain support must not have an entity id');
  assertContract(dry.surface.walkable, 'solid terrain support must be walkable');

  const water = findSurfacePoint(world, 'water');
  assertContract(water.surface.supportKind === 'water', 'water sample must be water support');
  assertContract(water.surface.supportEntityId === null, 'water support must not have an entity id');
  assertContract(!water.surface.walkable, 'water support must not be walkable');
}

function assertBuildingSupportContract(): void {
  const world = new WorldState(1235, 1024, 1024);
  world.playerCount = 2;
  const dry = findSurfacePoint(world, 'solid', 220);

  const terrainSpawn = world.createUnitFromBlueprint(
    dry.x,
    dry.y,
    TEST_PLAYER_ID,
    'unitJackal',
  );
  assertSpawnedOnSupport(terrainSpawn, dry.surface.groundZ, 'unit spawn on terrain support');

  const building = world.createBuilding(dry.x, dry.y, 320, 220, 48, TEST_PLAYER_ID);
  world.addEntity(building);
  const buildingTopZ = getBuildingSupportTopZ(building);
  const buildingSurface = world.sampleSupportSurface(dry.x, dry.y);
  assertContract(buildingSurface.supportKind === 'building', 'building top must be sampled as building support');
  assertContract(buildingSurface.supportEntityId === building.id, 'building support must identify its host');
  assertNear(buildingSurface.groundZ, buildingTopZ, 'building support height');
  const highAboveRoofSurface = world.sampleSupportSurface(dry.x, dry.y, {
    bodyZ: buildingTopZ + 500,
    groundOffset: 10,
  });
  assertContract(highAboveRoofSurface.supportKind === 'building', 'building top must support units high above it');
  const penetratingRoofSurface = world.sampleSupportSurface(dry.x, dry.y, {
    bodyZ: buildingTopZ + 9,
    groundOffset: 10,
  });
  assertContract(
    penetratingRoofSurface.supportKind === 'building',
    'building top must remain support while locomotion point penetrates the roof',
  );
  const belowRoofSurface = world.sampleSupportSurface(dry.x, dry.y, {
    bodyZ: buildingTopZ - SUPPORT_SURFACE_CONTACT_EPSILON - 0.25,
    groundOffset: 0,
  });
  assertContract(belowRoofSurface.supportKind === 'terrain', 'unit below roof plane must not acquire roof support');

  const buildingSpawn = world.createUnitFromBlueprint(
    dry.x,
    dry.y,
    TEST_PLAYER_ID,
    'unitJackal',
  );
  assertSpawnedOnSupport(buildingSpawn, buildingTopZ, 'unit spawn on building support');

  const locomotionIds = firstBlueprintIdByLocomotionType();
  const requiredTypes: UnitLocomotion['type'][] = [
    'wheels', 'treads', 'legs', 'flippers', 'hover', 'flying', 'swim',
  ];
  for (let i = 0; i < requiredTypes.length; i++) {
    const type = requiredTypes[i];
    const unitBlueprintId = locomotionIds.get(type);
    assertContract(unitBlueprintId !== undefined, `missing test blueprint for ${type} locomotion`);
    const x = dry.x - 120 + i * 60;
    const y = dry.y + 60;
    const spawned = world.createUnitFromBlueprint(x, y, TEST_PLAYER_ID, unitBlueprintId);
    assertSpawnedOnSupport(spawned, buildingTopZ, `${type} spawn must use shared building support`);
  }
}

function assertUnitSupportContract(): void {
  const world = new WorldState(1236, 1024, 1024);
  world.playerCount = 2;
  const dry = findSurfacePoint(world, 'solid', 180);

  const carrier = world.createUnitFromBlueprint(
    dry.x,
    dry.y,
    TEST_PLAYER_ID,
    'unitJackal',
  );
  assertContract(carrier.unit !== null, 'test carrier must be a unit');
  carrier.unit.supportSurface = {
    kind: 'discTop',
    topZ: carrier.unit.bodyCenterHeight + 18,
    radius: carrier.unit.radius.collision * 1.4,
  };
  carrier.transform.z = dry.surface.groundZ + carrier.unit.bodyCenterHeight;
  carrier.unit.velocityX = 3;
  carrier.unit.velocityY = -4;
  carrier.unit.velocityZ = 5;
  world.addEntity(carrier);

  const unitTopZ = getUnitSupportTopZ(carrier);
  const unitSurface = world.sampleSupportSurface(dry.x, dry.y);
  assertContract(unitSurface.supportKind === 'unit', 'authored unit top must be sampled as unit support');
  assertContract(unitSurface.supportEntityId === carrier.id, 'unit support must identify its host');
  assertNear(unitSurface.groundZ, unitTopZ, 'unit support height');
  const penetratingUnitSurface = world.sampleSupportSurface(dry.x, dry.y, {
    bodyZ: unitTopZ + 9,
    groundOffset: 10,
  });
  assertContract(
    penetratingUnitSurface.supportKind === 'unit',
    'authored unit top must remain support while locomotion point penetrates it',
  );
  assertNear(unitSurface.supportVelocityX, carrier.unit.velocityX, 'unit support velocity x');
  assertNear(unitSurface.supportVelocityY, carrier.unit.velocityY, 'unit support velocity y');
  assertNear(unitSurface.supportVelocityZ, carrier.unit.velocityZ, 'unit support velocity z');

  const ignoredSurface = world.sampleSupportSurface(dry.x, dry.y, { ignoreEntityId: carrier.id });
  assertContract(ignoredSurface.supportKind === 'terrain', 'ignored unit support must fall back to terrain');
}

function assertRenderLocomotionContract(): void {
  const world = new WorldState(1237, 1024, 1024);
  world.playerCount = 2;
  const dry = findSurfacePoint(world, 'solid', 200);
  const building = world.createBuilding(dry.x, dry.y, 220, 180, 52, TEST_PLAYER_ID);
  world.addEntity(building);
  const buildingTopZ = getBuildingSupportTopZ(building);

  refreshLocomotionSupportSurfaces(world.getUnitsAndBuildings());
  const renderHeight = getLocomotionSurfaceHeight(
    dry.x,
    dry.y,
    world.mapWidth,
    world.mapHeight,
    null,
  );
  assertNear(renderHeight, buildingTopZ, 'render locomotion support height');

  const renderSurface = sampleLocomotionSupportSurface(
    dry.x,
    dry.y,
    world.mapWidth,
    world.mapHeight,
    buildingTopZ + 8,
    8,
  );
  assertContract(renderSurface.supportKind === 'building', 'render support sample must resolve building top');
  assertContract(renderSurface.supportEntityId === building.id, 'render support sample must preserve support host');
  assertNear(renderSurface.groundZ, buildingTopZ, 'render support surface height');
}

function assertFactoryShellContract(): void {
  const world = new WorldState(1238, 1024, 1024);
  world.playerCount = 2;
  const dry = findSurfacePoint(world, 'solid', 220);
  const hoverUnitBlueprintId = firstBlueprintIdByLocomotionType().get('hover');
  assertContract(hoverUnitBlueprintId !== undefined, 'missing hover unit blueprint for factory shell contract');
  const factoryConfig = getBuildingConfig('towerFabricator');
  assertContract(factoryConfig.hoveringType === 'fabricator', 'fabricator config must author hoveringType');
  assertContract(factoryConfig.hovering === true, 'fabricator hover boolean must derive from hoveringType');
  const factory = world.createBuilding(
    dry.x,
    dry.y,
    factoryConfig.gridWidth * BUILD_GRID_CELL_SIZE,
    factoryConfig.gridHeight * BUILD_GRID_CELL_SIZE,
    factoryConfig.gridDepth * BUILD_GRID_CELL_SIZE,
    TEST_PLAYER_ID,
  );
  applyBuildingBlueprintRuntime(factory, 'towerFabricator', {
    allocateEntityId: () => world.generateEntityId(),
  });
  const factoryBuilding = factory.building;
  assertContract(factoryBuilding !== null, 'fabricator runtime must initialize a building component');
  assertContract(factoryBuilding.hoveringType === 'fabricator', 'fabricator runtime must preserve hoveringType');
  assertContract(factoryBuilding.hovering === true, 'fabricator runtime hover boolean must derive from hoveringType');
  assertNear(
    factoryBuilding.targetRadius,
    fabricatorTorusOuterRadius(factoryBuilding.width, factoryBuilding.height),
    'fabricator target radius must match the visible torus outer radius',
  );
  assertNear(
    getBuildingCombatCenterZ(factory),
    factory.transform.z - factoryBuilding.depth / 2 + fabricatorTorusHoverHeight(),
    'fabricator combat/hitbox center must float above its reserved footprint',
  );
  factory.factory = {
    selectedUnitBlueprintId: hoverUnitBlueprintId,
    lowPriority: true,
    carrierSpawnEnabled: true,
    moveState: 'holdPosition',
    airIdleState: 'land',
    repeatProduction: true,
    paused: false,
    productionQueue: [],
    productionQuotas: {},
    productionQuotaCounts: {},
    resumeRepeatUnitBlueprintId: null,
    currentShellId: null,
    currentBuildProgress: 0,
    defaultWaypoints: [
      { x: dry.x + 120, y: dry.y, z: null, type: 'move' },
      { x: dry.x + 160, y: dry.y + 80, z: null, type: 'patrol' },
    ],
    rallyX: dry.x + 120,
    rallyY: dry.y,
    rallyZ: null,
    rallyType: 'move',
    guardTargetId: null,
    isProducing: false,
    energyRateFraction: 0,
    metalRateFraction: 0,
  };
  world.addEntity(factory);

  const buildingGrid = new BuildingGrid(world.mapWidth, world.mapHeight);
  const forceAccumulator = new ForceAccumulator();
  const originalRoute = factory.factory.defaultWaypoints;
  const originalRallyX = factory.factory.rallyX;
  const originalRallyY = factory.factory.rallyY;
  executeCommand({
    world,
    constructionSystem: null as never,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setFactoryGuard',
    tick: 0,
    factoryId: factory.id,
    targetId: factory.id,
  });
  assertContract(factory.factory.guardTargetId === factory.id, 'self factory guard command must enable factory guard mode');
  assertContract(factory.factory.defaultWaypoints === originalRoute, 'self factory guard must not clear the default rally route');
  assertContract(
    factory.factory.rallyX === originalRallyX && factory.factory.rallyY === originalRallyY,
    'self factory guard must not overwrite the factory rally point',
  );

  const spawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(spawned.length === 1, 'factory must spawn exactly one shell');
  const shell = spawned[0];
  const shellSupport = world.sampleSupportSurface(factory.transform.x, factory.transform.y);
  const fabricatorSpawnClearance = fabricatorTorusHoverHeight();
  assertFactoryShellSpawnedAboveSupport(
    shell,
    shellSupport.groundZ,
    'factory shell spawn must use shared support',
    fabricatorSpawnClearance,
  );
  assertFactoryShellPhysicsKeepsRoofSupport(world, factory, shell, shellSupport.groundZ);
  assertContract(
    shell.heldBy !== null &&
      shell.heldBy.kind === 'production' &&
      shell.heldBy.holderId === factory.id,
    'spawned factory shell must be held by its producer while incomplete',
  );
  assertContract(shell.buildable !== null && !shell.buildable.isComplete, 'spawned shell must be an incomplete buildable');
  assertUnitActionCount(shell, 0, 'incomplete shell must not inherit movement actions');

  shell.buildable.isComplete = true;
  const completed = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(completed.length === 1 && completed[0] === shell, 'factory must complete the funded shell');
  assertContract(factory.factory.currentShellId === null, 'factory must clear current shell after activation');
  assertContract(shell.heldBy === null, 'factory must release the production hold after activation');
  assertContract(
    shell.unit !== null &&
      Math.abs(shell.unit.velocityX) <= CONTRACT_EPSILON &&
      Math.abs(shell.unit.velocityY) <= CONTRACT_EPSILON &&
      Math.abs(shell.unit.velocityZ) <= CONTRACT_EPSILON,
    'fabricator must release the completed shell with zero launch velocity',
  );
  assertContract(factory.factory.selectedUnitBlueprintId === hoverUnitBlueprintId, 'repeat factory must keep its selected unit');
  assertContract(factory.factory.repeatProduction === true, 'repeat factory must keep repeat mode after activation');
  const completedUnit = assertUnitActionCount(shell, 2, 'completed shell must receive high-level rally actions');
  assertContract(completedUnit.activePath === null, 'completed shell must not receive a baked exit path');
  assertContract(completedUnit.actions[0].type === 'move', 'first factory action must be the default move waypoint');
  assertContract(completedUnit.actions[1].type === 'patrol', 'second factory action must be the default patrol waypoint');
  assertNear(
    completedUnit.actions[0].z ?? Number.NaN,
    world.sampleSupportSurface(dry.x + 120, dry.y).groundZ,
    'factory action z must be sampled from shared support',
  );
  factory.factory.moveState = 'roam';
  factory.factory.selectedUnitBlueprintId = 'unitConstructionDrone';
  factory.factory.repeatProduction = false;
  factory.factory.productionQueue.length = 0;
  factory.factory.currentShellId = null;
  factory.factory.isProducing = false;
  const builderSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(builderSpawned.length === 1, 'factory guard mode must still produce builder shells');
  const builderShell = builderSpawned[0];
  assertContract(builderShell.buildable !== null, 'builder shell must be buildable');
  builderShell.buildable.isComplete = true;
  const builderCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(
    builderCompleted.length === 1 && builderCompleted[0] === builderShell,
    'factory guard mode must complete builder shells',
  );
  const completedBuilderUnit = assertUnitActionCount(builderShell, 1, 'builder output must receive factory guard order');
  assertContract(completedBuilderUnit.actions[0].type === 'guard', 'builder output must guard the factory');
  assertContract(
    completedBuilderUnit.actions[0].targetId === factory.id,
    'builder output guard order must target the producing factory',
  );
  assertContract(
    completedBuilderUnit.moveState === 'maneuver',
    'BAR armap/armca air-constructor output must keep the normal maneuver move state instead of inheriting the land-factory MOVE_STATE',
  );

  factory.factory.selectedUnitBlueprintId = 'unitBee';
  factory.factory.repeatProduction = false;
  factory.factory.guardTargetId = null;
  factory.factory.productionQueue.length = 0;
  factory.factory.currentShellId = null;
  factory.factory.currentBuildProgress = 0;
  factory.factory.isProducing = false;
  const airPageSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(airPageSpawned.length === 1, 'air-page factory fixture must spawn one shell');
  const airPageShell = airPageSpawned[0];
  assertContract(airPageShell.buildable !== null, 'air-page shell must be buildable');
  airPageShell.buildable.isComplete = true;
  const airPageCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(
    airPageCompleted.length === 1 && airPageCompleted[0] === airPageShell,
    'air-page factory fixture must complete its shell',
  );
  assertContract(
    airPageShell.unit?.moveState === 'maneuver',
    'BAR air-factory page outputs must keep the normal maneuver move state',
  );

  factory.factory.selectedUnitBlueprintId = hoverUnitBlueprintId;
  factory.factory.repeatProduction = false;
  factory.factory.guardTargetId = null;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQueue.push('unitLynx');
  const oneShotSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(oneShotSpawned.length === 1, 'one-shot factory must spawn one selected shell');
  const oneShotShell = oneShotSpawned[0];
  assertFactoryShellSpawnedAboveSupport(
    oneShotShell,
    shellSupport.groundZ,
    'one-shot shell spawn must use shared support',
    fabricatorSpawnClearance,
  );
  assertContract(oneShotShell.buildable !== null, 'one-shot shell must be buildable');
  oneShotShell.buildable.isComplete = true;
  const oneShotCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(
    oneShotCompleted.length === 1 && oneShotCompleted[0] === oneShotShell,
    'one-shot factory must complete its selected shell',
  );
  const advancedUnitBlueprintId: string | null = factory.factory.selectedUnitBlueprintId;
  assertContract(advancedUnitBlueprintId === 'unitLynx', 'one-shot factory must advance to queued unit');
  assertContract(factory.factory.productionQueue.length === 0, 'one-shot factory must consume the queued unit');
  assertContract(factory.factory.repeatProduction === false, 'queued one-shot factory must remain in finite mode');

  const queuedSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(queuedSpawned.length === 1, 'queued factory must spawn the advanced shell');
  const queuedShell = queuedSpawned[0];
  assertFactoryShellSpawnedAboveSupport(
    queuedShell,
    shellSupport.groundZ,
    'queued shell spawn must use shared support',
    fabricatorSpawnClearance,
  );
  assertContract(queuedShell.buildable !== null, 'queued shell must be buildable');
  queuedShell.buildable.isComplete = true;
  const queuedCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(
    queuedCompleted.length === 1 && queuedCompleted[0] === queuedShell,
    'queued factory must complete the advanced shell',
  );
  assertContract(
    queuedShell.unit?.moveState === 'roam',
    'BAR land-factory page outputs must inherit the selected factory MOVE_STATE',
  );
  assertContract(factory.factory.selectedUnitBlueprintId === null, 'one-shot factory must clear selected unit when queue is empty');
  assertContract(factory.factory.repeatProduction === false, 'one-shot factory must keep repeat off when empty');

  factory.factory.productionQueue.push('unitJackal', 'unitLynx', 'unitLynx');
  assertContract(
    factoryProductionSystem.editQueue(factory, 'setCount', 1, 2, undefined, 1),
    'factory queue setCount edit must apply',
  );
  assertContract(
    factory.factory.productionQueue.join(',') === 'unitJackal,unitLynx',
    'factory queue setCount edit must replace the selected run',
  );
  assertContract(
    factoryProductionSystem.editQueue(factory, 'move', 1, 1, 0),
    'factory queue move edit must apply',
  );
  assertContract(
    factory.factory.productionQueue.join(',') === 'unitLynx,unitJackal',
    'factory queue move edit must reorder the selected run',
  );
  assertContract(
    factoryProductionSystem.editQueue(factory, 'remove', 1, 1),
    'factory queue remove edit must apply',
  );
  assertContract(
    factory.factory.productionQueue.join(',') === 'unitLynx',
    'factory queue remove edit must delete the selected run',
  );

  factory.factory.selectedUnitBlueprintId = 'unitLynx';
  factory.factory.repeatProduction = false;
  factory.factory.currentShellId = null;
  factory.factory.currentBuildProgress = 0;
  factory.factory.isProducing = false;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQueue.push('unitJackal', 'unitLynx');
  assertContract(
    factoryProductionSystem.removeUnitProduction(factory, world, 'unitLynx', 1),
    'BAR factory cell removal must remove matching queued tail before active selection',
  );
  assertContract(
    factory.factory.selectedUnitBlueprintId === 'unitLynx' &&
      factory.factory.productionQueue.join(',') === 'unitJackal',
    'BAR factory cell removal must preserve active selection while a matching tail was removed',
  );

  const removableActiveSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(removableActiveSpawned.length === 1, 'BAR factory removal fixture must spawn the active shell');
  assertContract(
    factoryProductionSystem.removeUnitProduction(factory, world, 'unitLynx', 1),
    'BAR factory cell removal must cancel the active one-shot build when no matching tail remains',
  );
  assertContract(
    factory.factory.selectedUnitBlueprintId === null &&
      factory.factory.currentShellId === null &&
      world.getEntity(removableActiveSpawned[0].id) === undefined,
    'BAR factory cell removal must clear active one-shot selection and remove its shell',
  );

  factory.factory.selectedUnitBlueprintId = null;
  factory.factory.currentShellId = null;
  factory.factory.currentBuildProgress = 0;
  factory.factory.isProducing = false;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQuotas.unitJackal = 2;
  factory.factory.productionQuotaCounts.unitJackal = 1;
  assertContract(
    factoryProductionSystem.stopProduction(factory, world),
    'BAR factory clear queue must apply when only quotas are present',
  );
  assertContract(
    Object.keys(factory.factory.productionQuotas).length === 0 &&
      Object.keys(factory.factory.productionQuotaCounts).length === 0,
    'BAR factory clear queue must clear quota targets and quota counts',
  );

  factory.factory.selectedUnitBlueprintId = hoverUnitBlueprintId;
  factory.factory.currentShellId = null;
  factory.factory.isProducing = false;
  factory.factory.repeatProduction = false;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQueue.push('unitLynx');
  factory.factory.productionQuotas.unitJackal = 1;
  const preQuotaSpawned = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(preQuotaSpawned.length === 1, 'pre-quota finite factory must spawn the active selected unit');
  const preQuotaShell = preQuotaSpawned[0];
  assertContract(preQuotaShell.buildable !== null, 'pre-quota shell must be buildable');
  preQuotaShell.buildable.isComplete = true;
  const preQuotaCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(preQuotaCompleted.length === 1, 'pre-quota finite factory must complete the active selected unit');
  assertContract(factory.factory.selectedUnitBlueprintId === 'unitJackal', 'factory quota must preempt the normal finite queue');
  assertContract(factory.factory.productionQueue.join(',') === 'unitLynx', 'quota preemption must preserve the normal finite queue');
  assertContract(factory.factory.repeatProduction === false, 'factory quota must use finite production');

  for (const key of Object.keys(factory.factory.productionQuotas)) delete factory.factory.productionQuotas[key];
  for (const key of Object.keys(factory.factory.productionQuotaCounts)) delete factory.factory.productionQuotaCounts[key];
  factory.factory.selectedUnitBlueprintId = 'unitLynx';
  factory.factory.currentShellId = null;
  factory.factory.currentBuildProgress = 0;
  factory.factory.isProducing = false;
  factory.factory.repeatProduction = true;
  factory.factory.resumeRepeatUnitBlueprintId = null;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQuotas.unitJackal = 1;
  const repeatPreemptInitial = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(repeatPreemptInitial.length === 1, 'repeat factory must spawn the original shell before quota replacement');
  const repeatPreemptShell = repeatPreemptInitial[0];
  assertContract(repeatPreemptShell.unit?.unitBlueprintId === 'unitLynx', 'repeat preempt fixture must start with the repeat unit');
  assertContract(repeatPreemptShell.buildable !== null, 'repeat preempt shell must be buildable');
  repeatPreemptShell.buildable.paid.energy = repeatPreemptShell.buildable.required.energy * 0.01;
  repeatPreemptShell.buildable.paid.metal = repeatPreemptShell.buildable.required.metal * 0.01;
  const quotaReplacement = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(
    quotaReplacement.length === 1 && quotaReplacement[0].unit?.unitBlueprintId === 'unitJackal',
    'low-progress repeat shell must be replaced by the most-needed quota unit',
  );
  assertContract(world.getEntity(repeatPreemptShell.id) === undefined, 'low-progress replaced shell must be cancelled');
  assertContract(
    factoryResumeRepeatUnitBlueprintId(factory) === 'unitLynx' &&
      factoryRepeatProduction(factory) === false,
    'quota replacement must remember the interrupted repeat selection as a one-shot quota runs',
  );
  const quotaReplacementShell = quotaReplacement[0];
  assertContract(quotaReplacementShell.buildable !== null, 'quota replacement shell must be buildable');
  quotaReplacementShell.buildable.isComplete = true;
  const quotaReplacementCompleted = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).completedUnits;
  assertContract(quotaReplacementCompleted.length === 1, 'quota replacement shell must complete');
  assertContract(
    factory.factory.selectedUnitBlueprintId === 'unitLynx' &&
      factoryRepeatProduction(factory) === true &&
      factoryResumeRepeatUnitBlueprintId(factory) === null,
    'factory must resume the interrupted repeat selection after quota demand is satisfied',
  );

  factory.factory.selectedUnitBlueprintId = 'unitLynx';
  factory.factory.currentShellId = null;
  factory.factory.currentBuildProgress = 0;
  factory.factory.isProducing = false;
  factory.factory.repeatProduction = true;
  factory.factory.resumeRepeatUnitBlueprintId = null;
  factory.factory.productionQueue.length = 0;
  factory.factory.productionQuotas.unitBadger = 1;
  const highProgressInitial = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(highProgressInitial.length === 1, 'high-progress fixture must spawn the repeat shell');
  const highProgressShell = highProgressInitial[0];
  assertContract(highProgressShell.buildable !== null, 'high-progress fixture shell must be buildable');
  highProgressShell.buildable.paid.energy = highProgressShell.buildable.required.energy * 0.2;
  highProgressShell.buildable.paid.metal = highProgressShell.buildable.required.metal * 0.2;
  const highProgressReplacement = factoryProductionSystem.update(world, 16, buildingGrid, forceAccumulator).spawnedUnits;
  assertContract(highProgressReplacement.length === 0, 'high-progress active shell must not be quota-replaced');
  assertContract(
    factory.factory.currentShellId === highProgressShell.id &&
      factory.factory.selectedUnitBlueprintId === 'unitLynx',
    'high-progress shell must remain active while quota waits behind it',
  );
}

function assertQueenProductionRingMountContract(): void {
  const cases: readonly [string, string][] = [
    ['unitQueenBee', 'unitBee'],
    ['unitQueenTick', 'unitTick'],
  ];
  for (const [queenId, producedId] of cases) {
    const world = new WorldState(1240, 512, 512);
    const queenEntity = world.createUnitFromBlueprint(620, 256, TEST_PLAYER_ID, queenId);
    const queen = getUnitBlueprint(queenId);
    const spawnMount = queen.turrets.find((mount) => mount.producedBlueprintId === producedId);
    assertContract(spawnMount !== undefined, `${queenId} must have a spawn mount for ${producedId}`);
    const constructionPylons = queen.turrets.filter((mount) =>
      mount.turretBlueprintId === 'turretResourcePylonConstructionMetal' ||
      mount.turretBlueprintId === 'turretResourcePylonConstructionEnergy');
    assertContract(constructionPylons.length === 2, `${queenId} must have two production-ring pylons`);
    const holdVisual = getFactoryProductionHoldVisual(queenEntity, producedId);
    assertContract(holdVisual !== null, `${queenId} must have a production-ring visual`);
    assertContract(holdVisual.ringOrientation === 'forward', `${queenId} production ring must face forward`);
    assertNear(spawnMount.mount.y, 0, `${queenId} spawn mount must stay on airborne roll-axis y`);
    assertNear(spawnMount.mount.z, 0, `${queenId} spawn mount must stay on airborne roll-axis z`);
    const expectedRing = productionHoldRingRadiusForProducedUnit(producedId);
    for (let i = 0; i < constructionPylons.length; i++) {
      const pylon = constructionPylons[i];
      const turretIndex = queen.turrets.indexOf(pylon);
      const pylonVisual = getFactoryProductionPylonVisual(queenEntity, producedId, turretIndex);
      assertContract(pylonVisual !== null, `${queenId} pylon ${i} must have production-ring visual placement`);
      assertNear(pylon.mount.x, spawnMount.mount.x, `${queenId} pylon x must share the ring center`);
      assertNear(pylon.mount.y, 0, `${queenId} pylon mount must stay on airborne roll-axis y`);
      assertNear(pylon.mount.z, 0, `${queenId} pylon mount must stay on airborne roll-axis z`);
      assertNear(
        pylonVisual.localBaseZ,
        queen.bodyCenterHeight,
        `${queenId} pylon visual must sit at queen body-center height`,
      );
      assertNear(
        Math.abs(pylonVisual.localOffsetY - spawnMount.mount.y * queen.radius.other),
        expectedRing,
        `${queenId} pylon visual must sit on the production ring radius`,
      );
    }
  }
}

function assertFactoryGuardDefaultContract(): void {
  const world = new WorldState(1240, 512, 512);
  world.playerCount = 2;
  const construction = new ConstructionSystem(
    world.mapWidth,
    world.mapHeight,
    createAllBuildableTerrainGrid(world.mapWidth, world.mapHeight),
  );
  const factory = construction.startBuilding(world, 'towerFabricator', 8, 8, TEST_PLAYER_ID, 0, 0, {
    skipBuilderAuthorization: true,
  });
  assertContract(factory !== null, 'factory guard default fixture must place a fabricator');
  assertContract(factory.factory !== null, 'fabricator must initialize a factory component');
  const blockedUnderFabricator = construction.startBuilding(world, 'buildingSolar', 8, 8, TEST_PLAYER_ID, 0, 0, {
    skipBuilderAuthorization: true,
  });
  assertContract(
    blockedUnderFabricator === null,
    'hovering fabricator placement footprint must prevent building underneath it',
  );
  assertContract(
    factory.factory.guardTargetId === factory.id,
    'BAR factory guard widget must default builder-producing factories to self-guard',
  );
  assertContract(
    factory.factory.lowPriority === true,
    'BAR builder-priority widget must default labs/nanos to low priority',
  );
  assertContract(
    factory.factory.repeatProduction === false,
    'BAR factory auto-repeat widget is disabled by default',
  );
  assertContract(
    factory.factory.moveState === 'holdPosition',
    'BAR factory hold-position widget must default new factories to hold-position move state',
  );
}

function assertFabricatorTerrainIndependentPlacementContract(): void {
  const world = new WorldState(1241, 512, 512);
  world.playerCount = 2;
  const construction = new ConstructionSystem(
    world.mapWidth,
    world.mapHeight,
    createNoBuildableTerrainGrid(world.mapWidth, world.mapHeight),
  );
  const gridX = 8;
  const gridY = 8;
  const factory = construction.startBuilding(
    world,
    'towerFabricator',
    gridX,
    gridY,
    TEST_PLAYER_ID,
    0,
    0,
    { skipBuilderAuthorization: true },
  );
  assertContract(factory !== null, 'fabricator placement must ignore terrain buildability and flatness');
  const config = getBuildingConfig('towerFabricator');
  const expectedBaseline = getHighestBuildFootprintGroundZ(
    gridX,
    gridY,
    config.placementGridWidth,
    config.placementGridHeight,
    (x, y) => world.getGroundZ(x, y),
  );
  assertNear(
    factory.transform.z - factory.building!.depth / 2,
    expectedBaseline,
    'fabricator base must use the highest build-square terrain sample',
  );
}

function createSingleCellDeposit(gx: number, gy: number): MetalDeposit {
  const x = (gx + 0.5) * BUILD_GRID_CELL_SIZE;
  const y = (gy + 0.5) * BUILD_GRID_CELL_SIZE;
  return {
    id: 1,
    x,
    y,
    groupId: -1,
    gridX: gx,
    gridY: gy,
    demoAutoExtractor: true,
    originGx: gx,
    originGy: gy,
    resourceCells: 1,
    cells: [{ gx, gy, x, y }],
    resourceCellCount: 1,
    resourceRadiusCells: 1,
    boundsGridX: gx,
    boundsGridY: gy,
    boundsGridW: 1,
    boundsGridH: 1,
    resourceHalfSize: BUILD_GRID_CELL_SIZE / 2,
    resourceRadius: BUILD_GRID_CELL_SIZE / 2,
    flatPadRadius: BUILD_GRID_CELL_SIZE,
    dTerrainLevels: 0,
    height: 0,
    blendRadius: BUILD_GRID_CELL_SIZE,
  };
}

function createExtractorForCoverageTest(
  world: WorldState,
  buildingBlueprintId: BuildingBlueprintId,
  gridX: number,
  gridY: number,
): Entity {
  const cfg = getBuildingConfig(buildingBlueprintId);
  const x = (gridX + cfg.gridWidth / 2) * BUILD_GRID_CELL_SIZE;
  const y = (gridY + cfg.gridHeight / 2) * BUILD_GRID_CELL_SIZE;
  const entity = world.createBuilding(
    x,
    y,
    cfg.gridWidth * BUILD_GRID_CELL_SIZE,
    cfg.gridHeight * BUILD_GRID_CELL_SIZE,
    cfg.gridDepth * BUILD_GRID_CELL_SIZE,
    TEST_PLAYER_ID,
  );
  applyBuildingBlueprintRuntime(entity, buildingBlueprintId);
  return entity;
}

function assertExtractorTierCoverageContract(): void {
  const t1World = new WorldState(1, 512, 512);
  const t2World = new WorldState(1, 512, 512);
  t1World.metalDeposits.push(createSingleCellDeposit(12, 12));
  t2World.metalDeposits.push(createSingleCellDeposit(12, 12));

  const t1 = createExtractorForCoverageTest(t1World, 'buildingExtractor', 10, 10);
  const t2 = createExtractorForCoverageTest(t2World, 'buildingExtractorT2', 10, 10);
  const t1Rate = computeExtractorMetalCoverage(t1World, t1);
  const t2Rate = computeExtractorMetalCoverage(t2World, t2);
  const t1Base = getBuildingConfig('buildingExtractor').metalProduction ?? 0;
  const t2Base = getBuildingConfig('buildingExtractorT2').metalProduction ?? 0;

  assertContract(t1Rate > 0, 'T1 extractor must produce from the covered deposit cell');
  assertNear(
    t2Rate / t1Rate,
    t2Base / t1Base,
    'T2 extractor coverage must scale by the authored production ratio',
  );
}

export function runSupportSurfaceContractTest(): void {
  withKnownSupportSurfaceTerrain(() => {
    assertTerrainAndWaterContract();
    assertBuildingSupportContract();
    assertUnitSupportContract();
    assertRenderLocomotionContract();
    assertFactoryShellContract();
    assertQueenProductionRingMountContract();
    assertFactoryGuardDefaultContract();
    assertFabricatorTerrainIndependentPlacementContract();
    assertExtractorTierCoverageContract();
  });
}
