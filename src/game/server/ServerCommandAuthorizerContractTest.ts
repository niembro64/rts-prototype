import type {
  AttackAreaCommand,
  AttackCommand,
  CaptureCommand,
  GuardCommand,
  SetBuilderPriorityCommand,
  SetCarrierSpawnCommand,
  SetCloakStateCommand,
  SetFactoryGuardCommand,
  SetTowerTargetCommand,
  SetUnitMoveStateCommand,
} from '../sim/commands';
import { WorldState } from '../sim/WorldState';
import { authorizeGameServerGameplayCommand } from './ServerCommandAuthorizer';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[server command authorizer contract] ${message}`);
  }
}

export function runServerCommandAuthorizerContractTest(): void {
  const world = new WorldState(1, 512, 512);
  const commander = world.createUnitFromBlueprint(80, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const jackal = world.createUnitFromBlueprint(120, 80, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const mongoose = world.createUnitFromBlueprint(140, 80, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  const constructionDrone = world.createUnitFromBlueprint(145, 80, 1, 'unitConstructionDrone', {
    allocateSubEntityIds: false,
  });
  const bee = world.createUnitFromBlueprint(150, 80, 1, 'unitBee', {
    allocateSubEntityIds: false,
  });
  const dragonfly = world.createUnitFromBlueprint(155, 80, 1, 'unitDragonfly', {
    allocateSubEntityIds: false,
  });
  const loris = world.createUnitFromBlueprint(158, 80, 1, 'unitLoris', {
    allocateSubEntityIds: false,
  });
  const enemyCommander = world.createUnitFromBlueprint(160, 80, 2, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const queen = world.createUnitFromBlueprint(200, 80, 1, 'unitQueenBee', {
    allocateSubEntityIds: false,
  });
  const enemyQueen = world.createUnitFromBlueprint(240, 80, 2, 'unitQueenBee', {
    allocateSubEntityIds: false,
  });
  const fabricator = world.createBuilding(280, 80, 80, 80, 40, 1);
  fabricator.type = 'tower';
  fabricator.buildingBlueprintId = 'towerFabricator';
  fabricator.factory = { guardTargetId: null } as typeof fabricator.factory;
  world.addEntity(commander);
  world.addEntity(jackal);
  world.addEntity(mongoose);
  world.addEntity(constructionDrone);
  world.addEntity(bee);
  world.addEntity(dragonfly);
  world.addEntity(loris);
  world.addEntity(enemyCommander);
  world.addEntity(queen);
  world.addEntity(enemyQueen);
  world.addEntity(fabricator);

  const command: SetCloakStateCommand = {
    type: 'setCloakState',
    tick: 1,
    entityIds: [commander.id, jackal.id, enemyCommander.id],
    enabled: true,
  };
  const authorized = authorizeGameServerGameplayCommand(world, command, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorized?.type === 'setCloakState' &&
      authorized.entityIds.length === 1 &&
      authorized.entityIds[0] === commander.id,
    'setCloakState must authorize only owned BAR-equivalent cloak-capable units',
  );

  const rejected = authorizeGameServerGameplayCommand(world, {
    type: 'setCloakState',
    tick: 1,
    entityIds: [jackal.id],
    enabled: true,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejected === null,
    'setCloakState must reject owned units without a BAR-equivalent cloak command',
  );

  const priorityCommand: SetBuilderPriorityCommand = {
    type: 'setBuilderPriority',
    tick: 1,
    entityIds: [commander.id, queen.id, jackal.id, enemyCommander.id],
    lowPriority: true,
  };
  const authorizedPriority = authorizeGameServerGameplayCommand(world, priorityCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedPriority?.type === 'setBuilderPriority' &&
      authorizedPriority.entityIds.length === 1 &&
      authorizedPriority.entityIds[0] === commander.id,
    'setBuilderPriority must authorize only owned BAR-equivalent builder-priority command entities',
  );

  const carrierSpawnCommand: SetCarrierSpawnCommand = {
    type: 'setCarrierSpawn',
    tick: 1,
    entityIds: [queen.id, jackal.id, enemyQueen.id],
    enabled: false,
  };
  const authorizedCarrierSpawn = authorizeGameServerGameplayCommand(world, carrierSpawnCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedCarrierSpawn === null,
    'setCarrierSpawn must reject prototype mobile factories with no BAR carrier-spawner analogue',
  );

  const areaAttackCommand: AttackAreaCommand = {
    type: 'attackArea',
    tick: 1,
    entityIds: [jackal.id, mongoose.id, bee.id, enemyQueen.id],
    targetX: 200,
    targetY: 200,
    radius: 96,
    queue: false,
  };
  const authorizedAreaAttack = authorizeGameServerGameplayCommand(world, areaAttackCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAreaAttack?.type === 'attackArea' &&
      authorizedAreaAttack.entityIds.length === 2 &&
      authorizedAreaAttack.entityIds[0] === mongoose.id &&
      authorizedAreaAttack.entityIds[1] === bee.id,
    'attackArea must authorize only owned BAR-equivalent area-attack units',
  );

  const rejectedAreaAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attackArea',
    tick: 1,
    entityIds: [jackal.id],
    targetX: 200,
    targetY: 200,
    radius: 96,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAreaAttack === null,
    'attackArea must reject selections without BAR-equivalent area-attack units',
  );

  const attackCommand: AttackCommand = {
    type: 'attack',
    tick: 1,
    entityIds: [constructionDrone.id, jackal.id, enemyCommander.id],
    targetId: enemyCommander.id,
    queue: false,
  };
  const authorizedAttack = authorizeGameServerGameplayCommand(world, attackCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAttack?.type === 'attack' &&
      authorizedAttack.entityIds.length === 1 &&
      authorizedAttack.entityIds[0] === jackal.id,
    'attack must authorize only owned BAR-equivalent weapon units',
  );

  const rejectedAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [constructionDrone.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAttack === null,
    'attack must reject selections containing only noncombat builder units',
  );

  const setTargetCommand: SetTowerTargetCommand = {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [loris.id, jackal.id, enemyCommander.id],
    targetId: enemyCommander.id,
  };
  const authorizedSetTarget = authorizeGameServerGameplayCommand(world, setTargetCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedSetTarget?.type === 'setTowerTarget' &&
      authorizedSetTarget.entityIds.length === 1 &&
      authorizedSetTarget.entityIds[0] === jackal.id,
    'setTowerTarget must authorize only owned BAR-equivalent non-shield active weapon hosts',
  );

  const rejectedSetTarget = authorizeGameServerGameplayCommand(world, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [loris.id],
    targetId: enemyCommander.id,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedSetTarget === null,
    'setTowerTarget must reject selections containing only shield/passive hosts',
  );

  const captureCommand: CaptureCommand = {
    type: 'capture',
    tick: 1,
    commanderId: commander.id,
    targetId: enemyCommander.id,
    queue: false,
  };
  const authorizedCapture = authorizeGameServerGameplayCommand(world, captureCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedCapture?.type === 'capture' &&
      authorizedCapture.commanderId === commander.id &&
      authorizedCapture.targetId === enemyCommander.id,
    'capture must authorize the owned BAR-equivalent capture-capable commander',
  );

  const rejectedNonCaptureSource = authorizeGameServerGameplayCommand(world, {
    type: 'capture',
    tick: 1,
    commanderId: jackal.id,
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedNonCaptureSource === null,
    'capture must reject owned units without a BAR-equivalent capture command',
  );

  const moveStateCommand: SetUnitMoveStateCommand = {
    type: 'setUnitMoveState',
    tick: 1,
    entityIds: [jackal.id, dragonfly.id, enemyCommander.id],
    moveState: 'roam',
  };
  const authorizedMoveState = authorizeGameServerGameplayCommand(world, moveStateCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedMoveState?.type === 'setUnitMoveState' &&
      authorizedMoveState.entityIds.length === 1 &&
      authorizedMoveState.entityIds[0] === jackal.id,
    'setUnitMoveState must strip BAR bomber units whose move-state command descriptor is hidden',
  );

  const rejectedMoveState = authorizeGameServerGameplayCommand(world, {
    type: 'setUnitMoveState',
    tick: 1,
    entityIds: [dragonfly.id],
    moveState: 'roam',
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedMoveState === null,
    'setUnitMoveState must reject selections containing only BAR move-state-hidden bombers',
  );

  const selfGuardCommand: GuardCommand = {
    type: 'guard',
    tick: 1,
    entityIds: [commander.id, jackal.id],
    targetId: jackal.id,
    queue: false,
  };
  const authorizedSelfGuard = authorizeGameServerGameplayCommand(world, selfGuardCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedSelfGuard?.type === 'guard' &&
      authorizedSelfGuard.entityIds.length === 1 &&
      authorizedSelfGuard.entityIds[0] === commander.id,
    'BAR self-guard prevention must strip the target unit from mixed guard selections',
  );

  const rejectedOnlySelfGuard = authorizeGameServerGameplayCommand(world, {
    type: 'guard',
    tick: 1,
    entityIds: [jackal.id],
    targetId: jackal.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedOnlySelfGuard === null,
    'BAR self-guard prevention must reject guard commands where every source is the target',
  );

  const rejectedEnemyGuard = authorizeGameServerGameplayCommand(world, {
    type: 'guard',
    tick: 1,
    entityIds: [commander.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedEnemyGuard === null,
    'BAR no-enemy-guard prevention must reject guard commands targeting enemies',
  );

  const prototypeQueenFactoryGuardCommand: SetFactoryGuardCommand = {
    type: 'setFactoryGuard',
    tick: 1,
    factoryId: queen.id,
    targetId: queen.id,
  };
  const rejectedPrototypeQueenFactoryGuard = authorizeGameServerGameplayCommand(world, prototypeQueenFactoryGuardCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedPrototypeQueenFactoryGuard === null,
    'setFactoryGuard must reject prototype queen mobile factories because BAR only exposes factory guard on builder-producing factories',
  );

  const fabricatorFactorySelfGuardCommand: SetFactoryGuardCommand = {
    type: 'setFactoryGuard',
    tick: 1,
    factoryId: fabricator.id,
    targetId: fabricator.id,
  };
  const authorizedFactorySelfGuard = authorizeGameServerGameplayCommand(world, fabricatorFactorySelfGuardCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedFactorySelfGuard?.type === 'setFactoryGuard' &&
      authorizedFactorySelfGuard.factoryId === fabricator.id &&
      authorizedFactorySelfGuard.targetId === fabricator.id,
    'setFactoryGuard must authorize owned BAR-equivalent builder-producing factories',
  );
}
