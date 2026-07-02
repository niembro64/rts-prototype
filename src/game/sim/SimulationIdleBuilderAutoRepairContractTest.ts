import { createBuildable } from './buildableHelpers';
import { CommandQueue } from './commands';
import {
  BAR_IDLE_BUILDER_AUTO_REPAIR_POLL_TICKS,
  SimulationIdleBuilderAutoRepair,
} from './SimulationIdleBuilderAutoRepair';
import { Simulation } from './Simulation';
import { createEnergyBuffers, distributeEnergy } from './energyDistribution';
import { createEconomyState, economyManager } from './economy';
import type { Entity, PlayerId } from './types';
import { setUnitActions } from './unitActions';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[idle builder auto-repair contract] ${message}`);
  }
}

function damageUnit(entity: Entity, damage = 10): Entity {
  assertContract(entity.unit !== null, 'test target must be a unit');
  entity.unit.hp = Math.max(1, entity.unit.maxHp - damage);
  return entity;
}

function createWorld(seed = 1): WorldState {
  return new WorldState(seed, 1024, 1024);
}

function addMobileBuilder(
  world: WorldState,
  x: number,
  y: number,
  playerId: PlayerId,
  unitBlueprintId = 'unitCommander',
): Entity {
  const builder = world.createUnitFromBlueprint(x, y, playerId, unitBlueprintId, {
    allocateSubEntityIds: false,
  });
  assertContract(builder.unit !== null && builder.builder !== null, 'test builder must be a mobile builder');
  world.addEntity(builder);
  return builder;
}

function addDamagedJackal(world: WorldState, x: number, y: number, playerId: PlayerId): Entity {
  const target = damageUnit(world.createUnitFromBlueprint(x, y, playerId, 'unitJackal', {
    allocateSubEntityIds: false,
  }), 40);
  world.addEntity(target);
  return target;
}

function setRepairEconomy(playerId: PlayerId): void {
  economyManager.reset();
  economyManager.setEconomyState(playerId, {
    ...createEconomyState(),
    stockpile: { curr: 1000, max: 1000 },
    metal: {
      ...createEconomyState().metal,
      stockpile: { curr: 1000, max: 1000 },
    },
  });
}

export function runSimulationIdleBuilderAutoRepairContractTest(): void {
  const playerId = 1 as PlayerId;

  const wiredWorld = createWorld(100);
  const wiredBuilder = addMobileBuilder(wiredWorld, 100, 100, playerId);
  const wiredTarget = addDamagedJackal(wiredWorld, 330, 100, playerId);
  assertContract(wiredBuilder.unit !== null, 'wired builder must have a unit component');
  wiredBuilder.unit.moveState = 'maneuver';
  new Simulation(wiredWorld, new CommandQueue()).update(16);
  assertContract(
    wiredBuilder.unit.actions.length === 1 &&
      wiredBuilder.unit.actions[0].type === 'repair' &&
      wiredBuilder.unit.actions[0].targetId === wiredTarget.id,
    'Simulation.update must run BAR idle-builder auto-repair before movement',
  );

  const maneuverWorld = createWorld(101);
  const maneuverRepair = new SimulationIdleBuilderAutoRepair(maneuverWorld);
  const maneuverBuilder = addMobileBuilder(maneuverWorld, 100, 100, playerId);
  const maneuverTarget = addDamagedJackal(maneuverWorld, 330, 100, playerId);
  assertContract(maneuverBuilder.unit !== null, 'maneuver builder must have a unit component');
  maneuverBuilder.unit.moveState = 'maneuver';
  maneuverRepair.update(0);
  assertContract(
    maneuverBuilder.unit.actions.length === 1 &&
      maneuverBuilder.unit.actions[0].type === 'repair' &&
      maneuverBuilder.unit.actions[0].targetId === maneuverTarget.id,
    'maneuver idle builder must auto-repair a damaged ally inside buildRange+100 leash',
  );

  const holdWorld = createWorld(102);
  const holdRepair = new SimulationIdleBuilderAutoRepair(holdWorld);
  const holdBuilder = addMobileBuilder(holdWorld, 100, 100, playerId);
  addDamagedJackal(holdWorld, 330, 100, playerId);
  assertContract(holdBuilder.unit !== null, 'hold builder must have a unit component');
  holdBuilder.unit.moveState = 'holdPosition';
  holdRepair.update(0);
  assertContract(
    holdBuilder.unit.actions.length === 0,
    'hold-position idle builder must not chase beyond its buildRange leash',
  );

  const completeWorld = createWorld(103);
  const completeRepair = new SimulationIdleBuilderAutoRepair(completeWorld);
  const completeBuilder = addMobileBuilder(completeWorld, 120, 120, playerId);
  const completeTarget = addDamagedJackal(completeWorld, 250, 120, playerId);
  assertContract(completeBuilder.unit !== null && completeTarget.unit !== null, 'completion test units must exist');
  completeBuilder.unit.moveState = 'maneuver';
  completeRepair.update(0);
  completeTarget.unit.hp = completeTarget.unit.maxHp;
  completeRepair.update(BAR_IDLE_BUILDER_AUTO_REPAIR_POLL_TICKS);
  assertContract(
    completeBuilder.unit.actions.length === 1 &&
      completeBuilder.unit.actions[0].type === 'move' &&
      completeBuilder.unit.actions[0].x === 120 &&
      completeBuilder.unit.actions[0].y === 120,
    'auto-repair builder must return to its recorded idle point after repair completion',
  );

  const cloakWorld = createWorld(104);
  const cloakRepair = new SimulationIdleBuilderAutoRepair(cloakWorld);
  const cloakBuilder = addMobileBuilder(cloakWorld, 100, 100, playerId);
  addDamagedJackal(cloakWorld, 250, 100, playerId);
  assertContract(cloakBuilder.unit !== null, 'cloak builder must have a unit component');
  cloakBuilder.unit.wantCloak = true;
  cloakRepair.update(0);
  assertContract(
    cloakBuilder.unit.actions.length === 0,
    'idle builder that wants cloak must not be assigned an automatic repair',
  );

  const droneWorld = createWorld(105);
  const drone = addMobileBuilder(droneWorld, 200, 200, playerId, 'unitConstructionDrone');
  const droneTarget = addDamagedJackal(droneWorld, 260, 200, playerId);
  assertContract(drone.unit !== null && droneTarget.unit !== null, 'drone repair test units must exist');
  setRepairEconomy(playerId);
  setUnitActions(drone.unit, [{
    type: 'repair',
    x: droneTarget.transform.x,
    y: droneTarget.transform.y,
    z: droneTarget.transform.z,
    targetId: droneTarget.id,
  }]);
  const hpBeforeRepair = droneTarget.unit.hp;
  distributeEnergy(droneWorld, 1000, createEnergyBuffers());
  assertContract(
    droneTarget.unit.hp > hpBeforeRepair,
    'direct repair funding must work for construction drones, not only commanders',
  );

  const shellWorld = createWorld(106);
  const shellBuilder = addMobileBuilder(shellWorld, 300, 300, playerId, 'unitConstructionDrone');
  const shell = shellWorld.createBuilding(340, 300, 40, 40, 40, playerId);
  shell.buildable = createBuildable({ energy: 10, metal: 10 });
  shellWorld.addEntity(shell);
  assertContract(shellBuilder.unit !== null && shell.buildable !== null, 'shell repair test fixtures must exist');
  setRepairEconomy(playerId);
  setUnitActions(shellBuilder.unit, [{
    type: 'repair',
    x: shell.transform.x,
    y: shell.transform.y,
    z: shell.transform.z,
    targetId: shell.id,
  }]);
  distributeEnergy(shellWorld, 1000, createEnergyBuffers());
  assertContract(
    shell.buildable.paid.energy > 0 || shell.buildable.paid.metal > 0,
    'builder repair actions on incomplete shells must still fund construction',
  );
}
