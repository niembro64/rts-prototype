import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { getBuildingConfig } from './buildConfigs';
import { createBuildable } from './buildableHelpers';
import {
  createEnergyBuffers,
  distributeEnergy,
} from './energyDistribution';
import {
  createEconomyState,
  economyManager,
} from './economy';
import { resourceMovementSystem } from './resourceMovement';
import type { BuildingBlueprintId, Entity, EntityId, PlayerId } from './types';
import { setUnitActions } from './unitActions';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[resource movement conformance] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[resource movement conformance] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function makeCompletedOpenBuilding(entity: Entity, hp: number): void {
  if (!entity.building) return;
  entity.building.hp = hp;
  entity.building.maxHp = hp;
  if (entity.building.activeState !== null) {
    entity.building.activeState.open = true;
    entity.building.activeState.damageDelayMs = 0;
    entity.building.activeState.reopenDelayMs = 0;
  }
}

function createCompletedOpenBuilding(
  world: WorldState,
  playerId: PlayerId,
  blueprintId: BuildingBlueprintId,
  x: number,
  y: number,
): Entity {
  const config = getBuildingConfig(blueprintId);
  const entity = world.createBuilding(
    x,
    y,
    config.gridWidth * 20,
    config.gridHeight * 20,
    config.gridDepth * 20,
    playerId,
  );
  applyBuildingBlueprintRuntime(entity, blueprintId);
  makeCompletedOpenBuilding(entity, config.hp);
  entity.buildable = null;
  world.addEntity(entity);
  return entity;
}

export function runResourceMovementConformanceContractTest(): void {
  const playerId = 1 as PlayerId;
  const sourceEntityId = 101 as EntityId;
  const targetEntityId = 202 as EntityId;
  const world = new WorldState(77, 512, 512);
  economyManager.reset();
  economyManager.initPlayer(playerId);

  resourceMovementSystem.beginTick(world);
  economyManager.addStockpile(
    world,
    playerId,
    { energy: 10, metal: 5 },
    sourceEntityId,
    targetEntityId,
    'production',
    { energy: 10, metal: 5 },
  );
  assertContract(world.resourceMovements.length === 2, 'addStockpile must publish one pylon movement per credited resource');
  assertContract(
    world.resourceMovements.every((movement) => movement.direction === 'inbound'),
    'credited stockpile movements must be inbound at the source pylon',
  );
  assertContract(
    world.resourceMovements.every((movement) => movement.sourceEntityId === sourceEntityId),
    'credited stockpile movements must preserve the source host pylon',
  );

  resourceMovementSystem.beginTick(world);
  const spent = economyManager.spendInstant(
    world,
    playerId,
    4,
    sourceEntityId,
    targetEntityId,
    'ability',
  );
  assertContract(spent, 'test economy must afford the instant spend');
  const instantMovementCount: number = world.resourceMovements.length;
  assertContract(instantMovementCount === 1, 'instant spend must publish one pylon movement');
  const instantSpend = world.resourceMovements[0];
  assertContract(instantSpend.resource === 'energy', 'instant spend is an energy movement');
  assertContract(instantSpend.direction === 'outbound', 'instant spend must be outbound at the source pylon');
  assertContract(
    instantSpend.amountPerSecond > 0,
    'instant spend must publish a positive per-second burst rate so it renders as a pylon ball (not dropped by the amountPerSecond<=0 filter)',
  );
  assertContract(instantSpend.sourceEntityId === sourceEntityId, 'instant spend must preserve the source host pylon');
  assertContract(instantSpend.targetEntityId === targetEntityId, 'instant spend must preserve the target endpoint');

  economyManager.reset();
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 0, max: 200 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 0, max: 200 },
    },
  });
  const solar = createCompletedOpenBuilding(world, playerId, 'buildingSolar', 160, 120);
  const wind = createCompletedOpenBuilding(world, playerId, 'buildingWind', 220, 120);
  const extractor = createCompletedOpenBuilding(world, playerId, 'buildingExtractor', 280, 120);
  extractor.metalExtractionRate = getBuildingConfig('buildingExtractor').metalProduction ?? 0;

  resourceMovementSystem.beginTick(world);
  economyManager.update(world, 1000, 1);
  assertContract(
    world.resourceMovements.some((movement) =>
      movement.reason === 'baseIncome' &&
      movement.direction === 'inbound' &&
      movement.sourceEntityId === null
    ),
    'base income must publish an inbound pylon movement from the player pool',
  );
  assertContract(
    world.resourceMovements.some((movement) =>
      movement.reason === 'production' &&
      movement.direction === 'inbound' &&
      movement.sourceEntityId === solar.id
    ),
    'producer income must publish an inbound pylon movement from the producer host',
  );
  assertContract(
    world.resourceMovements.some((movement) =>
      movement.reason === 'production' &&
      movement.resource === 'energy' &&
      movement.direction === 'inbound' &&
      movement.sourceEntityId === wind.id
    ),
    'wind producer income must publish an inbound energy pylon movement from the wind host',
  );
  assertContract(
    world.resourceMovements.some((movement) =>
      movement.reason === 'production' &&
      movement.resource === 'metal' &&
      movement.direction === 'inbound' &&
      movement.sourceEntityId === extractor.id
    ),
    'extractor producer income must publish an inbound metal pylon movement from the extractor host',
  );

  economyManager.reset();
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 100, max: 200 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 100, max: 200 },
    },
  });
  const buildWorld = new WorldState(78, 512, 512);
  const builder = buildWorld.createUnitFromBlueprint(220, 220, playerId, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const buildTarget = buildWorld.createBuilding(235, 220, 40, 40, 40, playerId);
  buildTarget.buildable = createBuildable({ energy: 12, metal: 8 });
  if (builder.builder) builder.builder.currentBuildTarget = buildTarget.id;
  buildWorld.addEntity(builder);
  buildWorld.addEntity(buildTarget);

  resourceMovementSystem.beginTick(buildWorld);
  distributeEnergy(buildWorld, 1000, createEnergyBuffers());
  const constructionMovements = buildWorld.resourceMovements.filter((movement) => movement.reason === 'construction');
  assertContract(constructionMovements.length >= 2, 'construction funding must publish resource movements');
  assertContract(
    constructionMovements.every((movement) => movement.direction === 'outbound'),
    'construction funding must publish outbound movements from builder/factory pylons',
  );
  assertContract(
    constructionMovements.every((movement) => movement.sourceEntityId === builder.id),
    'builder construction spend must preserve the builder host pylon',
  );
  assertContract(
    constructionMovements.every((movement) => movement.targetEntityId === buildTarget.id),
    'builder construction spend must preserve the build target endpoint',
  );

  economyManager.reset();
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 100, max: 200 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 100, max: 200 },
    },
  });
  const repairWorld = new WorldState(79, 512, 512);
  const commander = repairWorld.createUnitFromBlueprint(260, 260, playerId, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const damaged = repairWorld.createUnitFromBlueprint(275, 260, playerId, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  assertContract(commander.unit !== null && damaged.unit !== null, 'repair test units must have unit components');
  damaged.unit.hp = Math.max(1, damaged.unit.maxHp - 20);
  setUnitActions(commander.unit, [{
    type: 'repair',
    x: damaged.transform.x,
    y: damaged.transform.y,
    z: damaged.transform.z,
    targetId: damaged.id,
  }]);
  repairWorld.addEntity(commander);
  repairWorld.addEntity(damaged);

  resourceMovementSystem.beginTick(repairWorld);
  const repairEnergyBefore = economyManager.getEconomy(playerId)?.stockpile.curr;
  const repairMetalBefore = economyManager.getEconomy(playerId)?.metal.stockpile.curr;
  distributeEnergy(repairWorld, 1000, createEnergyBuffers());
  const repairMovement = repairWorld.resourceMovements.find((movement) => movement.reason === 'repair');
  assertContract(repairMovement === undefined, 'BAR repair must not publish a fake resource transfer');
  assertContract(
    economyManager.getEconomy(playerId)?.stockpile.curr === repairEnergyBefore &&
      economyManager.getEconomy(playerId)?.metal.stockpile.curr === repairMetalBefore,
    'BAR repair must consume neither energy nor metal',
  );

  const damagedStructure = createCompletedOpenBuilding(
    repairWorld,
    playerId,
    'buildingSolar',
    278,
    260,
  );
  damagedStructure.building!.maxHp = 10_000;
  damagedStructure.building!.hp = 1;
  const structureHpBeforeRepair = damagedStructure.building!.hp;
  const repairHelper = repairWorld.createUnitFromBlueprint(258, 260, playerId, 'unitConstructionDrone', {
    allocateSubEntityIds: false,
  });
  assertContract(repairHelper.unit !== null, 'multi-builder repair helper must have a unit component');
  repairWorld.addEntity(damagedStructure);
  repairWorld.addEntity(repairHelper);
  setUnitActions(commander.unit, [{
    type: 'repair',
    x: damagedStructure.transform.x,
    y: damagedStructure.transform.y,
    z: damagedStructure.transform.z,
    targetId: damagedStructure.id,
  }]);
  setUnitActions(repairHelper.unit, [{
    type: 'repair',
    x: damagedStructure.transform.x,
    y: damagedStructure.transform.y,
    z: damagedStructure.transform.z,
    targetId: damagedStructure.id,
  }]);
  resourceMovementSystem.beginTick(repairWorld);
  distributeEnergy(repairWorld, 1000, createEnergyBuffers());
  const structureRepairMovements = repairWorld.resourceMovements.filter(
    (movement) => movement.reason === 'repair' && movement.targetEntityId === damagedStructure.id,
  );
  assertContract(
    structureRepairMovements.length === 0,
    'stacked BAR repair must remain resource-free for every contributing builder',
  );
  assertContract(
    damagedStructure.building!.hp > structureHpBeforeRepair,
    'stacked builder repair power must restore HP without duplicated resource spend',
  );

  economyManager.reset();
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 100, max: 200 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 0, max: 200 },
    },
  });
  world.resourceMovements.length = 0;
  world.converterTax = 0.5;
  const converterConfig = getBuildingConfig('buildingResourceConverter');
  const converter = world.createBuilding(
    100,
    100,
    converterConfig.gridWidth * 20,
    converterConfig.gridHeight * 20,
    converterConfig.gridDepth * 20,
    playerId,
  );
  applyBuildingBlueprintRuntime(converter, 'buildingResourceConverter');
  makeCompletedOpenBuilding(converter, converterConfig.hp);
  world.addEntity(converter);

  resourceMovementSystem.beginTick(world);
  economyManager.processConverters(world, 1000);
  const converterMovements = world.resourceMovements.filter((movement) => movement.reason === 'conversion');
  assertContract(converterMovements.length === 2, 'converter must publish consumed and produced pylon movements');
  const consumed = converterMovements.find((movement) => movement.direction === 'outbound');
  const produced = converterMovements.find((movement) => movement.direction === 'inbound');
  assertContract(consumed !== undefined, 'converter must publish an outbound consumed-resource pylon flow');
  assertContract(produced !== undefined, 'converter must publish an inbound produced-resource pylon flow');
  assertContract(consumed.sourceEntityId === converter.id, 'converter consumed flow must use the converter host pylon');
  assertContract(produced.sourceEntityId === converter.id, 'converter produced flow must use the converter host pylon');
  assertContract(consumed.resource === 'energy', 'higher energy stockpile should make energy the consumed converter resource');
  assertContract(produced.resource === 'metal', 'lower metal stockpile should make metal the produced converter resource');
  assertNear(consumed.amountPerSecond, converterConfig.conversionRate ?? 0, 'converter consumed flow rate');
  assertNear(
    produced.amountPerSecond,
    (converterConfig.conversionRate ?? 0) * (1 - world.converterTax),
    'converter produced flow rate after tax',
  );
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 100, max: 200 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 0, max: 200 },
    },
  });
  const converterActiveState = converter.building?.activeState ?? null;
  if (converterActiveState !== null) converterActiveState.open = false;
  resourceMovementSystem.beginTick(world);
  economyManager.processConverters(world, 1000);
  const closedConverterEconomy = economyManager.getEconomy(playerId);
  assertContract(closedConverterEconomy !== undefined, 'closed converter test must keep economy state');
  assertContract(
    !world.resourceMovements.some((movement) => movement.reason === 'conversion'),
    'OFF converter must not publish conversion pylon movements',
  );
  assertNear(closedConverterEconomy.stockpile.curr, 100, 'OFF converter must not consume energy');
  assertNear(closedConverterEconomy.metal.stockpile.curr, 0, 'OFF converter must not produce metal');

  economyManager.reset();
}
