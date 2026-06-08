import { UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND } from '../../config';
import {
  getLocomotionSurfaceHeight,
  refreshLocomotionSupportSurfaces,
  sampleLocomotionSupportSurface,
} from '../render3d/LocomotionTerrainSampler';
import { BuildingGrid } from './buildGrid';
import { getAllUnitBlueprints } from './blueprints';
import { factoryProductionSystem } from './factoryProduction';
import {
  createWorldSupportSurface,
  type SupportSurfaceMaterialKind,
  type WorldSupportSurface,
} from './supportSurface';
import type {
  Entity,
  PlayerId,
  Unit,
  UnitLocomotion,
} from './types';
import { WorldState } from './WorldState';

const TEST_PLAYER_ID = 1 as PlayerId;
const CONTRACT_EPSILON = 1e-6;
const FACTORY_SHELL_AIR_SPAWN_HEIGHT = 160;

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

  const step = Math.max(16, Math.min(world.mapWidth, world.mapHeight) / 24);
  for (let y = margin; y <= world.mapHeight - margin; y += step) {
    for (let x = margin; x <= world.mapWidth - margin; x += step) {
      const surface = world.sampleSupportSurface(x, y, {}, scratch);
      if (surface.materialKind === materialKind) {
        return { x, y, surface: { ...surface } };
      }
    }
  }

  throw new Error(
    `[support surface contract] could not find ${materialKind} terrain sample`,
  );
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

function getExpectedSpawnCenterHeight(unit: Unit): number {
  const locomotion = unit.locomotion;
  const isAirborneLocomotion =
    locomotion.type === 'hover' || locomotion.type === 'flying';
  if (
    isAirborneLocomotion &&
    locomotion.gravityCounterUpwardForceRatio !== undefined &&
    Number.isFinite(locomotion.gravityCounterUpwardForceRatio) &&
    locomotion.gravityCounterUpwardForceRatio < 1 &&
    locomotion.hoverHeightUpwardForce !== undefined &&
    Number.isFinite(locomotion.hoverHeightUpwardForce)
  ) {
    return locomotion.hoverHeightUpwardForce /
      (1 - locomotion.gravityCounterUpwardForceRatio);
  }
  return unit.bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND;
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
    supportTopZ + getExpectedSpawnCenterHeight(unit),
    message,
  );
}

function assertUnitActionCount(entity: Entity, count: number, message: string): Unit {
  const unit = entity.unit;
  assertContract(unit !== null, `${message}: entity must be a unit`);
  assertContract(unit.actions.length === count, message);
  return unit;
}

function firstBlueprintIdByLocomotionType(): Map<UnitLocomotion['type'], string> {
  const idsByType = new Map<UnitLocomotion['type'], string>();
  for (const bp of getAllUnitBlueprints()) {
    if (!idsByType.has(bp.locomotion.type)) {
      idsByType.set(bp.locomotion.type, bp.unitBlueprintId);
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

  const buildingSpawn = world.createUnitFromBlueprint(
    dry.x,
    dry.y,
    TEST_PLAYER_ID,
    'unitJackal',
  );
  assertSpawnedOnSupport(buildingSpawn, buildingTopZ, 'unit spawn on building support');

  const locomotionIds = firstBlueprintIdByLocomotionType();
  const requiredTypes: UnitLocomotion['type'][] = ['wheels', 'treads', 'legs', 'hover', 'flying'];
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
  const factory = world.createBuilding(dry.x, dry.y, 180, 180, 60, TEST_PLAYER_ID);
  factory.factory = {
    selectedUnitBlueprintId: 'unitJackal',
    repeatProduction: true,
    productionQueue: [],
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
  const spawned = factoryProductionSystem.update(world, 16, buildingGrid).spawnedUnits;
  assertContract(spawned.length === 1, 'factory must spawn exactly one shell');
  const shell = spawned[0];
  const shellSupport = world.sampleSupportSurface(factory.transform.x, factory.transform.y);
  assertNear(
    shell.transform.z,
    shellSupport.groundZ + FACTORY_SHELL_AIR_SPAWN_HEIGHT,
    'factory shell spawn height must be relative to shared support',
  );
  assertContract(shell.buildable !== null && !shell.buildable.isComplete, 'spawned shell must be an incomplete buildable');
  assertUnitActionCount(shell, 0, 'incomplete shell must not inherit movement actions');

  shell.buildable.isComplete = true;
  const completed = factoryProductionSystem.update(world, 16, buildingGrid).completedUnits;
  assertContract(completed.length === 1 && completed[0] === shell, 'factory must complete the funded shell');
  assertContract(factory.factory.currentShellId === null, 'factory must clear current shell after activation');
  assertContract(factory.factory.selectedUnitBlueprintId === 'unitJackal', 'repeat factory must keep its selected unit');
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

  factory.factory.repeatProduction = false;
  factory.factory.productionQueue.push('unitWolverine');
  const oneShotSpawned = factoryProductionSystem.update(world, 16, buildingGrid).spawnedUnits;
  assertContract(oneShotSpawned.length === 1, 'one-shot factory must spawn one selected shell');
  const oneShotShell = oneShotSpawned[0];
  assertContract(oneShotShell.buildable !== null, 'one-shot shell must be buildable');
  oneShotShell.buildable.isComplete = true;
  const oneShotCompleted = factoryProductionSystem.update(world, 16, buildingGrid).completedUnits;
  assertContract(
    oneShotCompleted.length === 1 && oneShotCompleted[0] === oneShotShell,
    'one-shot factory must complete its selected shell',
  );
  const advancedUnitBlueprintId: string | null = factory.factory.selectedUnitBlueprintId;
  assertContract(advancedUnitBlueprintId === 'unitWolverine', 'one-shot factory must advance to queued unit');
  assertContract(factory.factory.productionQueue.length === 0, 'one-shot factory must consume the queued unit');
  assertContract(factory.factory.repeatProduction === false, 'queued one-shot factory must remain in finite mode');

  const queuedSpawned = factoryProductionSystem.update(world, 16, buildingGrid).spawnedUnits;
  assertContract(queuedSpawned.length === 1, 'queued factory must spawn the advanced shell');
  const queuedShell = queuedSpawned[0];
  assertContract(queuedShell.buildable !== null, 'queued shell must be buildable');
  queuedShell.buildable.isComplete = true;
  const queuedCompleted = factoryProductionSystem.update(world, 16, buildingGrid).completedUnits;
  assertContract(
    queuedCompleted.length === 1 && queuedCompleted[0] === queuedShell,
    'queued factory must complete the advanced shell',
  );
  assertContract(factory.factory.selectedUnitBlueprintId === null, 'one-shot factory must clear selected unit when queue is empty');
  assertContract(Boolean(factory.factory.repeatProduction), 'one-shot factory must reset to repeat mode when empty');
}

export function runSupportSurfaceContractTest(): void {
  assertTerrainAndWaterContract();
  assertBuildingSupportContract();
  assertUnitSupportContract();
  assertRenderLocomotionContract();
  assertFactoryShellContract();
}
