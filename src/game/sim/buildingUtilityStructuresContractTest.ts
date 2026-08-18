import { MAX_METAL, MAX_STOCKPILE } from '../../config';
import { TURRET_BLUEPRINTS } from './blueprints';
import { getBuildingConfig } from './buildConfigs';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { buildingBlueprintHasActiveState } from './buildingActiveState';
import {
  applyCompletedBuildingEffects,
  removeCompletedBuildingEffects,
  transferCompletedBuildingStorageCapacity,
} from './buildingCompletion';
import { economyManager } from './economy';
import { getMaximumSensorMatrixRadius } from './sensorConfig';
import type { BuildingBlueprintId, Entity, PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[utility structures] ${message}`);
}

function createCompletedBuilding(
  world: WorldState,
  blueprintId: BuildingBlueprintId,
  playerId: PlayerId,
  x: number,
): Entity {
  const config = getBuildingConfig(blueprintId);
  const entity = world.createBuilding(
    x,
    100,
    config.gridWidth * 20,
    config.gridHeight * 20,
    config.gridDepth * 20,
    playerId,
  );
  applyBuildingBlueprintRuntime(entity, blueprintId);
  assertContract(entity.building !== null, `${blueprintId} must create a building host`);
  entity.building.hp = config.hp;
  entity.building.maxHp = config.hp;
  entity.buildable = null;
  world.addEntity(entity);
  return entity;
}

function assertJammerSuite(
  turretId: 'turretSensorBuildingRadarJammer' | 'turretSensorBuildingSonarJammer',
  medium: 'radar' | 'sonar',
): void {
  const sensors = TURRET_BLUEPRINTS[turretId].targeting.observation.sensors;
  assertContract(
    getMaximumSensorMatrixRadius(sensors.fullSight) === 0
      && getMaximumSensorMatrixRadius(sensors.contactSight) === 0
      && sensors.detectorRadius === 0,
    `${turretId} must be a jammer-only observation source`,
  );
  assertContract(
    (medium === 'radar' ? sensors.radarJamRadius : sensors.sonarJamRadius) === 3000,
    `${turretId} must author a 3000-unit ${medium} denial radius`,
  );
  assertContract(
    (medium === 'radar' ? sensors.sonarJamRadius : sensors.radarJamRadius) === 0,
    `${turretId} must not jam the other medium`,
  );
}

export function runBuildingUtilityStructuresContractTest(): void {
  assertJammerSuite('turretSensorBuildingRadarJammer', 'radar');
  assertJammerSuite('turretSensorBuildingSonarJammer', 'sonar');
  assertContract(
    buildingBlueprintHasActiveState('buildingRadarJammer')
      && buildingBlueprintHasActiveState('buildingSonarJammer'),
    'both powered jammer buildings must use the shared ON/OFF fortify lifecycle',
  );

  const metalStorage = getBuildingConfig('buildingMetalStorage');
  const energyStorage = getBuildingConfig('buildingEnergyStorage');
  assertContract(
    metalStorage.metalStorage === 3000 && metalStorage.energyStorage === null,
    'Metal Storage must add only 3000 metal capacity',
  );
  assertContract(
    energyStorage.energyStorage === 5000 && energyStorage.metalStorage === null,
    'Energy Storage must add only 5000 energy capacity',
  );

  const playerOne = 1 as PlayerId;
  const playerTwo = 2 as PlayerId;
  const world = new WorldState(9137, 1024, 1024);
  economyManager.reset();
  economyManager.initPlayer(playerOne);
  economyManager.initPlayer(playerTwo);

  try {
    const radarJammer = createCompletedBuilding(
      world,
      'buildingRadarJammer',
      playerOne,
      40,
    );
    applyCompletedBuildingEffects(world, radarJammer);
    assertContract(
      world.getActiveStateBuildings().includes(radarJammer)
        && radarJammer.building?.activeState?.open === false
        && radarJammer.building.activeState.wantOpen,
      'completed jammer buildings must enter the powered activation/debounce driver',
    );

    const metalA = createCompletedBuilding(world, 'buildingMetalStorage', playerOne, 100);
    const metalB = createCompletedBuilding(world, 'buildingMetalStorage', playerOne, 220);
    applyCompletedBuildingEffects(world, metalA);
    applyCompletedBuildingEffects(world, metalA);
    applyCompletedBuildingEffects(world, metalB);
    const playerOneEconomy = economyManager.getOrCreateEconomy(playerOne);
    assertContract(
      playerOneEconomy.metal.stockpile.max === MAX_METAL + 6000,
      'completed Metal Storage capacity must stack exactly and apply idempotently',
    );
    playerOneEconomy.metal.stockpile.curr = MAX_METAL + 5500;
    removeCompletedBuildingEffects(world, metalA);
    assertContract(
      playerOneEconomy.metal.stockpile.max === MAX_METAL + 3000
        && playerOneEconomy.metal.stockpile.curr === MAX_METAL + 3000,
      'destroying storage must remove one contribution and clamp excess metal',
    );
    removeCompletedBuildingEffects(world, metalB);
    assertContract(
      playerOneEconomy.metal.stockpile.max === MAX_METAL
        && playerOneEconomy.metal.stockpile.curr === MAX_METAL,
      'destroying the last Metal Storage must restore the base pool',
    );

    const energy = createCompletedBuilding(world, 'buildingEnergyStorage', playerOne, 340);
    applyCompletedBuildingEffects(world, energy);
    assertContract(
      playerOneEconomy.stockpile.max === MAX_STOCKPILE + 5000,
      'completed Energy Storage must add its capacity to the owner',
    );
    transferCompletedBuildingStorageCapacity(energy, playerOne, playerTwo);
    world.setEntityOwner(energy, playerTwo);
    const playerTwoEconomy = economyManager.getOrCreateEconomy(playerTwo);
    assertContract(
      playerOneEconomy.stockpile.max === MAX_STOCKPILE
        && playerTwoEconomy.stockpile.max === MAX_STOCKPILE + 5000,
      'capture must transfer storage capacity between owners in the same tick',
    );
    removeCompletedBuildingEffects(world, energy);
    assertContract(
      playerTwoEconomy.stockpile.max === MAX_STOCKPILE,
      'destroying captured storage must remove capacity from its current owner',
    );
  } finally {
    economyManager.reset();
  }
}
