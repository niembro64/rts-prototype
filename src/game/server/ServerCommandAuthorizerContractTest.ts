import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CaptureCommand,
  EditFactoryQueueCommand,
  FireDGunCommand,
  GuardCommand,
  LoadTransportCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  SetBuilderPriorityCommand,
  SetCarrierSpawnCommand,
  SetCloakStateCommand,
  SetFactoryAirIdleStateCommand,
  SetFireEnabledCommand,
  SetFactoryGuardCommand,
  SetFactoryOutputGuardCommand,
  SetTowerTargetCommand,
  SetUnitMoveStateCommand,
  WaitCommand,
} from '../sim/commands';
import { WorldState } from '../sim/WorldState';
import type { Entity } from '../sim/types';
import { authorizeGameServerGameplayCommand } from './ServerCommandAuthorizer';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[server command authorizer contract] ${message}`);
  }
}

function createResurrectableWreck(world: WorldState): Entity {
  const wreck = world.createBuilding(320, 80, 24, 24, 12, 1);
  wreck.wreck = {
    source: { kind: 'unit', unitBlueprintId: 'unitJackal' },
    originalOwnerId: 2,
    resurrectProgressMs: 0,
    resurrectRequiredMs: 1000,
  } as NonNullable<Entity['wreck']>;
  world.addEntity(wreck);
  return wreck;
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
  const badger = world.createUnitFromBlueprint(142, 80, 1, 'unitBadger', {
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
  const eagle = world.createUnitFromBlueprint(156, 80, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  });
  const albatros = world.createUnitFromBlueprint(157, 80, 1, 'unitAlbatros', {
    allocateSubEntityIds: false,
  });
  const loris = world.createUnitFromBlueprint(158, 80, 1, 'unitLoris', {
    allocateSubEntityIds: false,
  });
  const transport = world.createUnitFromBlueprint(170, 80, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const enemyTransport = world.createUnitFromBlueprint(172, 80, 2, 'unitTransport', {
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
  fabricator.type = 'building';
  fabricator.buildingBlueprintId = 'towerFabricator';
  fabricator.factory = { guardTargetId: null, moveState: 'holdPosition', airIdleState: 'land' } as typeof fabricator.factory;
  const cannonTower = world.createBuilding(300, 80, 80, 80, 40, 1);
  cannonTower.type = 'building';
  cannonTower.buildingBlueprintId = 'towerCannon';
  cannonTower.combat = {
    turrets: [
      {
        config: {
          kind: 'attack',
          passive: false,
          turretRange: { range: 160 },
          shot: { type: 'plasma' },
        },
      },
    ],
  } as unknown as NonNullable<Entity['combat']>;
  const enemyCannonTower = world.createBuilding(340, 80, 80, 80, 40, 2);
  enemyCannonTower.type = 'building';
  enemyCannonTower.buildingBlueprintId = 'towerCannon';
  enemyCannonTower.combat = cannonTower.combat;
  const antiAirTower = world.createBuilding(380, 80, 80, 80, 40, 1);
  antiAirTower.type = 'building';
  antiAirTower.buildingBlueprintId = 'towerAntiAir';
  antiAirTower.combat = {
    turrets: [
      {
        config: {
          kind: 'attack',
          passive: false,
          turretRange: { range: 240 },
          shot: { type: 'rocket' },
        },
      },
    ],
  } as unknown as NonNullable<Entity['combat']>;
  const t2Extractor = world.createBuilding(420, 80, 64, 64, 40, 1);
  t2Extractor.type = 'building';
  t2Extractor.buildingBlueprintId = 'buildingExtractorT2';
  const solar = world.createBuilding(450, 80, 64, 64, 40, 1);
  solar.type = 'building';
  solar.buildingBlueprintId = 'buildingSolar';
  world.addEntity(commander);
  world.addEntity(jackal);
  world.addEntity(mongoose);
  world.addEntity(badger);
  world.addEntity(constructionDrone);
  world.addEntity(bee);
  world.addEntity(dragonfly);
  world.addEntity(eagle);
  world.addEntity(albatros);
  world.addEntity(loris);
  world.addEntity(transport);
  world.addEntity(enemyTransport);
  world.addEntity(enemyCommander);
  world.addEntity(queen);
  world.addEntity(enemyQueen);
  world.addEntity(fabricator);
  world.addEntity(cannonTower);
  world.addEntity(enemyCannonTower);
  world.addEntity(antiAirTower);
  world.addEntity(t2Extractor);
  world.addEntity(solar);

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

  const dgunTargetCommand: FireDGunCommand = {
    type: 'fireDGun',
    tick: 1,
    commanderId: commander.id,
    targetId: enemyCommander.id,
    targetX: 200,
    targetY: 200,
  };
  const authorizedDgunTarget = authorizeGameServerGameplayCommand(world, dgunTargetCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedDgunTarget?.type === 'fireDGun' &&
      authorizedDgunTarget.commanderId === commander.id &&
      authorizedDgunTarget.targetId === enemyCommander.id,
    'fireDGun must authorize BAR unit-or-map target ids when the commander is owned and the target exists',
  );
  const rejectedMissingDgunTarget = authorizeGameServerGameplayCommand(world, {
    ...dgunTargetCommand,
    targetId: 999999,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedMissingDgunTarget === null,
    'fireDGun must reject missing target ids while preserving ground-only D-Gun commands',
  );
  const sanitizedOwnedDgunTarget = authorizeGameServerGameplayCommand(world, {
    ...dgunTargetCommand,
    targetId: jackal.id,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    sanitizedOwnedDgunTarget?.type === 'fireDGun' &&
      sanitizedOwnedDgunTarget.commanderId === commander.id &&
      !('targetId' in sanitizedOwnedDgunTarget) &&
      sanitizedOwnedDgunTarget.targetX === dgunTargetCommand.targetX &&
      sanitizedOwnedDgunTarget.targetY === dgunTargetCommand.targetY,
    'fireDGun must mirror BAR cmd_dgun_no_ally by stripping owned/allied target ids and keeping the ground fallback point',
  );

  const alliedDgunWorld = new WorldState(9104, 512, 512);
  alliedDgunWorld.alliesByPlayer.set(1, new Set([2]));
  alliedDgunWorld.alliesByPlayer.set(2, new Set([1]));
  const alliedDgunCommander = alliedDgunWorld.createUnitFromBlueprint(80, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const alliedDgunTarget = alliedDgunWorld.createUnitFromBlueprint(120, 80, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const neutralDgunTarget = alliedDgunWorld.createUnitFromBlueprint(160, 80, 3, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  alliedDgunWorld.addEntity(alliedDgunCommander);
  alliedDgunWorld.addEntity(alliedDgunTarget);
  alliedDgunWorld.addEntity(neutralDgunTarget);
  const sanitizedAlliedDgunTarget = authorizeGameServerGameplayCommand(alliedDgunWorld, {
    type: 'fireDGun',
    tick: 1,
    commanderId: alliedDgunCommander.id,
    targetId: alliedDgunTarget.id,
    targetX: 210,
    targetY: 215,
    targetZ: 11,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    sanitizedAlliedDgunTarget?.type === 'fireDGun' &&
      !('targetId' in sanitizedAlliedDgunTarget) &&
      sanitizedAlliedDgunTarget.targetX === 210 &&
      sanitizedAlliedDgunTarget.targetY === 215 &&
      sanitizedAlliedDgunTarget.targetZ === 11,
    'fireDGun must strip allied target ids server-side so BAR no-ally D-Gun behavior cannot be bypassed',
  );
  const authorizedNeutralDgunTarget = authorizeGameServerGameplayCommand(alliedDgunWorld, {
    type: 'fireDGun',
    tick: 1,
    commanderId: alliedDgunCommander.id,
    targetId: neutralDgunTarget.id,
    targetX: 210,
    targetY: 215,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedNeutralDgunTarget?.type === 'fireDGun' &&
      authorizedNeutralDgunTarget.targetId === neutralDgunTarget.id,
    'fireDGun must preserve non-allied target ids like BAR cmd_dgun_no_ally preserves enemy unit snaps',
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

  const waitCommand: WaitCommand = {
    type: 'wait',
    tick: 1,
    entityIds: [jackal.id, fabricator.id, enemyCommander.id],
    queue: false,
  };
  const authorizedWait = authorizeGameServerGameplayCommand(world, waitCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedWait?.type === 'wait' &&
      authorizedWait.entityIds.length === 2 &&
      authorizedWait.entityIds[0] === jackal.id &&
      authorizedWait.entityIds[1] === fabricator.id,
    'normal Wait must authorize owned units and owned factories so BAR factory wait reaches the server',
  );

  const gatherWaitCommand: WaitCommand = {
    type: 'wait',
    tick: 1,
    entityIds: [jackal.id, fabricator.id],
    queue: false,
    gather: true,
    waitGroupId: 7,
  };
  const authorizedGatherWait = authorizeGameServerGameplayCommand(world, gatherWaitCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedGatherWait?.type === 'wait' &&
      authorizedGatherWait.entityIds.length === 1 &&
      authorizedGatherWait.entityIds[0] === jackal.id,
    'gather Wait must remain unit-only even though normal Wait accepts factories',
  );

  const stopCommand = {
    type: 'stop' as const,
    tick: 1,
    entityIds: [jackal.id, cannonTower.id, t2Extractor.id, solar.id, fabricator.id, enemyCannonTower.id],
  };
  const authorizedStop = authorizeGameServerGameplayCommand(world, stopCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedStop?.type === 'stop' &&
      authorizedStop.entityIds.length === 3 &&
      authorizedStop.entityIds[0] === jackal.id &&
      authorizedStop.entityIds[1] === cannonTower.id &&
      authorizedStop.entityIds[2] === t2Extractor.id,
    'Stop must authorize owned units, owned armed buildings, and armamex/T2 mex buildings, but not removestop buildings, pure factories, or enemy buildings',
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
      authorizedAreaAttack.entityIds.length === 1 &&
      authorizedAreaAttack.entityIds[0] === mongoose.id,
    'attackArea must authorize only owned BAR-equivalent canareaattack units',
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

  const attackGroundCommand: AttackGroundCommand = {
    type: 'attackGround',
    tick: 1,
    entityIds: [jackal.id, eagle.id, bee.id, enemyCommander.id],
    targetX: 200,
    targetY: 200,
    targetZ: 0,
    queue: false,
  };
  const authorizedAttackGround = authorizeGameServerGameplayCommand(
    world,
    attackGroundCommand,
    { mode: 'player', playerId: 1 },
  );
  assertContract(
    authorizedAttackGround?.type === 'attackGround' &&
      authorizedAttackGround.entityIds.length === 1 &&
      authorizedAttackGround.entityIds[0] === jackal.id,
    'Attack Point must authorize only owned ground-capable BAR weapon units',
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

  const authorizedDragonflyGroundAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [dragonfly.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedDragonflyGroundAttack?.type === 'attack' &&
      authorizedDragonflyGroundAttack.entityIds.length === 1 &&
      authorizedDragonflyGroundAttack.entityIds[0] === dragonfly.id,
    'BAR bomber no-air-target rule must still allow Dragonfly attacks against ground units',
  );

  const authorizedAirTargetAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [dragonfly.id, jackal.id],
    targetId: enemyTransport.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAirTargetAttack?.type === 'attack' &&
      authorizedAirTargetAttack.entityIds.length === 1 &&
      authorizedAirTargetAttack.entityIds[0] === jackal.id,
    'BAR bomber no-air-target rule must strip Dragonfly from Attack commands against air targets while preserving other weapon units',
  );

  const rejectedDragonflyAirTargetAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [dragonfly.id],
    targetId: enemyTransport.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedDragonflyAirTargetAttack === null,
    'BAR bomber no-air-target rule must reject selections containing only Dragonfly attacking air targets',
  );
  const authorizedSurfaceOnlyGroundAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [mongoose.id, badger.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedSurfaceOnlyGroundAttack?.type === 'attack' &&
      authorizedSurfaceOnlyGroundAttack.entityIds.length === 2 &&
      authorizedSurfaceOnlyGroundAttack.entityIds.includes(mongoose.id) &&
      authorizedSurfaceOnlyGroundAttack.entityIds.includes(badger.id),
    'BAR armart/unitMongoose and armjanus/unitBadger attack authorization must still allow ground targets',
  );
  const rejectedSurfaceOnlyAirTargetAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [mongoose.id, badger.id],
    targetId: enemyTransport.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedSurfaceOnlyAirTargetAttack === null,
    'BAR armart/unitMongoose and armjanus/unitBadger attack authorization must reject air targets',
  );
  const rejectedAlbatrosAirTargetAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [albatros.id],
    targetId: enemyTransport.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAlbatrosAirTargetAttack === null,
    'BAR armkam/unitAlbatros attack authorization must reject air targets',
  );

  const rejectedScoutAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [bee.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedScoutAttack === null,
    'BAR armpeep/unitBee scout analogue must not authorize Attack because BAR armpeep has no weapons',
  );

  const rejectedFighterGroundAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [bee.id, eagle.id, dragonfly.id, jackal.id],
    targetId: enemyCommander.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedFighterGroundAttack?.type === 'attack' &&
      rejectedFighterGroundAttack.entityIds.join(',') === `${dragonfly.id},${jackal.id}`,
    'BAR armfig/unitEagle fighter analogue must be stripped from Attack commands against ground-role targets',
  );

  const authorizedFighterAirAttack = authorizeGameServerGameplayCommand(world, {
    type: 'attack',
    tick: 1,
    entityIds: [bee.id, dragonfly.id, jackal.id, eagle.id],
    targetId: enemyTransport.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedFighterAirAttack?.type === 'attack' &&
      authorizedFighterAirAttack.entityIds.length === 2 &&
      authorizedFighterAirAttack.entityIds.includes(jackal.id) &&
      authorizedFighterAirAttack.entityIds.includes(eagle.id),
    'BAR armfig/unitEagle fighter analogue must authorize Attack against air targets while scout and bomber are stripped',
  );

  const setFireCommand: SetFireEnabledCommand = {
    type: 'setFireEnabled',
    tick: 1,
    entityIds: [bee.id, jackal.id],
    fireState: 'holdFire',
  };
  const authorizedSetFire = authorizeGameServerGameplayCommand(world, setFireCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedSetFire?.type === 'setFireEnabled' &&
      authorizedSetFire.entityIds.length === 1 &&
      authorizedSetFire.entityIds[0] === jackal.id,
    'setFireEnabled must strip unitBee because BAR armpeep has no Fire State command',
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

  const rejectedAntiAirGroundTarget = authorizeGameServerGameplayCommand(world, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [antiAirTower.id],
    targetId: enemyCommander.id,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAntiAirGroundTarget === null,
    'towerAntiAir/armrl Set Target must reject ground-role targets because BAR armrl has canattackground=false',
  );
  const rejectedAntiAirGroundPoint = authorizeGameServerGameplayCommand(world, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [antiAirTower.id],
    targetId: null,
    targetX: 240,
    targetY: 240,
    targetZ: 0,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAntiAirGroundPoint === null,
    'towerAntiAir/armrl Set Target must reject ground points because BAR armrl has canattackground=false',
  );
  const authorizedAntiAirTarget = authorizeGameServerGameplayCommand(world, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [antiAirTower.id],
    targetId: enemyTransport.id,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAntiAirTarget?.type === 'setTowerTarget' &&
      authorizedAntiAirTarget.entityIds.length === 1 &&
      authorizedAntiAirTarget.entityIds[0] === antiAirTower.id,
    'towerAntiAir/armrl Set Target must still authorize air targets',
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

  const resurrectableWreck = createResurrectableWreck(world);
  const resurrectCommand: ResurrectCommand = {
    type: 'resurrect',
    tick: 1,
    commanderId: constructionDrone.id,
    targetId: resurrectableWreck.id,
    queue: false,
  };
  const authorizedResurrect = authorizeGameServerGameplayCommand(world, resurrectCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedResurrect === null,
    'resurrect must reject unitConstructionDrone because it maps to BAR armcv constructor slots, not armrectr',
  );

  const commanderResurrectCommand: ResurrectCommand = {
    type: 'resurrect',
    tick: 1,
    commanderId: commander.id,
    targetId: resurrectableWreck.id,
    queue: false,
  };
  const authorizedCommanderResurrect = authorizeGameServerGameplayCommand(world, commanderResurrectCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedCommanderResurrect?.type === 'resurrect' &&
      authorizedCommanderResurrect.commanderId === commander.id,
    'resurrect must preserve the prototype commander resurrect command outside BAR presets',
  );

  const rejectedNonResurrectSource = authorizeGameServerGameplayCommand(world, {
    type: 'resurrect',
    tick: 1,
    commanderId: jackal.id,
    targetId: resurrectableWreck.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedNonResurrectSource === null,
    'resurrect must reject owned units without prototype or BAR-equivalent resurrect capability',
  );

  const resurrectAreaCommand: ResurrectAreaCommand = {
    type: 'resurrectArea',
    tick: 1,
    commanderId: constructionDrone.id,
    targetX: 320,
    targetY: 80,
    radius: 96,
    queue: false,
  };
  const authorizedResurrectArea = authorizeGameServerGameplayCommand(world, resurrectAreaCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedResurrectArea === null,
    'resurrectArea must reject unitConstructionDrone because the current BAR-equivalent roster has no armrectr analogue',
  );

  const commanderResurrectAreaCommand: ResurrectAreaCommand = {
    type: 'resurrectArea',
    tick: 1,
    commanderId: commander.id,
    targetX: 320,
    targetY: 80,
    radius: 96,
    queue: false,
  };
  const authorizedCommanderResurrectArea = authorizeGameServerGameplayCommand(world, commanderResurrectAreaCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedCommanderResurrectArea?.type === 'resurrectArea' &&
      authorizedCommanderResurrectArea.commanderId === commander.id,
    'resurrectArea must preserve the prototype commander resurrect command outside BAR presets',
  );

  const loadTransportCommand: LoadTransportCommand = {
    type: 'loadTransport',
    tick: 1,
    transportId: transport.id,
    targetId: jackal.id,
    queue: false,
  };
  const authorizedLoadTransport = authorizeGameServerGameplayCommand(world, loadTransportCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedLoadTransport?.type === 'loadTransport' &&
      'targetId' in authorizedLoadTransport &&
      authorizedLoadTransport.transportId === transport.id &&
      authorizedLoadTransport.targetId === jackal.id,
    'owned transport must authorize targeted Load units for a loadable friendly passenger',
  );

  const loadTransportAreaCommand: LoadTransportCommand = {
    type: 'loadTransport',
    tick: 1,
    transportIds: [transport.id, enemyTransport.id],
    targetX: 120,
    targetY: 80,
    radius: 96,
    queue: true,
  };
  const authorizedLoadTransportArea = authorizeGameServerGameplayCommand(world, loadTransportAreaCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedLoadTransportArea?.type === 'loadTransport' &&
      !('targetId' in authorizedLoadTransportArea) &&
      authorizedLoadTransportArea.transportIds.join(',') === `${transport.id}` &&
      authorizedLoadTransportArea.radius === 96,
    'owned transport IDs must authorize and enemy transport IDs must be filtered from BAR-style area Load units commands',
  );

  const rejectedEnemyLoadTransportArea = authorizeGameServerGameplayCommand(world, {
    ...loadTransportAreaCommand,
    transportIds: [enemyTransport.id],
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedEnemyLoadTransportArea === null,
    'enemy transport must not authorize area Load units commands',
  );

  const moveStateCommand: SetUnitMoveStateCommand = {
    type: 'setUnitMoveState',
    tick: 1,
    entityIds: [jackal.id, dragonfly.id, enemyCommander.id, fabricator.id],
    moveState: 'roam',
  };
  const authorizedMoveState = authorizeGameServerGameplayCommand(world, moveStateCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedMoveState?.type === 'setUnitMoveState' &&
      authorizedMoveState.entityIds.join(',') === `${jackal.id},${fabricator.id}`,
    'setUnitMoveState must keep owned BAR units and factories while stripping bombers whose move-state command descriptor is hidden',
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

  const airIdleCommand: SetFactoryAirIdleStateCommand = {
    type: 'setFactoryAirIdleState',
    tick: 1,
    factoryId: fabricator.id,
    airIdleState: 'fly',
  };
  const authorizedAirIdle = authorizeGameServerGameplayCommand(world, airIdleCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAirIdle?.type === 'setFactoryAirIdleState' &&
      authorizedAirIdle.factoryId === fabricator.id &&
      authorizedAirIdle.airIdleState === 'fly',
    'setFactoryAirIdleState must authorize only owned BAR air-plant factory analogues',
  );
  const rejectedQueenAirIdle = authorizeGameServerGameplayCommand(world, {
    ...airIdleCommand,
    factoryId: queen.id,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedQueenAirIdle === null,
    'setFactoryAirIdleState must reject prototype mobile factories because BAR LAND_AT is inserted only on air plants',
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

  const alliedGuardWorld = new WorldState(1, 512, 512);
  alliedGuardWorld.alliesByPlayer.set(1, new Set([2]));
  alliedGuardWorld.alliesByPlayer.set(2, new Set([1]));
  const alliedGuardSource = alliedGuardWorld.createUnitFromBlueprint(80, 120, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const alliedGuardTarget = alliedGuardWorld.createUnitFromBlueprint(120, 120, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const nonAlliedGuardTarget = alliedGuardWorld.createUnitFromBlueprint(160, 120, 3, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  alliedGuardWorld.addEntity(alliedGuardSource);
  alliedGuardWorld.addEntity(alliedGuardTarget);
  alliedGuardWorld.addEntity(nonAlliedGuardTarget);
  const authorizedAlliedGuard = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'guard',
    tick: 1,
    entityIds: [alliedGuardSource.id],
    targetId: alliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAlliedGuard?.type === 'guard' &&
      authorizedAlliedGuard.targetId === alliedGuardTarget.id,
    'BAR no-enemy-guard must authorize guard commands targeting allied units',
  );
  alliedGuardTarget.unit!.hp = alliedGuardTarget.unit!.maxHp - 1;
  const authorizedAlliedRepair = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'repair',
    tick: 1,
    commanderId: alliedGuardSource.id,
    targetId: alliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedAlliedRepair?.type === 'repair' &&
      authorizedAlliedRepair.targetId === alliedGuardTarget.id,
    'BAR Repair must authorize an owned builder working on an allied unit',
  );
  const rejectedNonBuilderRepair = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'repair',
    tick: 1,
    commanderId: alliedGuardTarget.id,
    targetId: alliedGuardSource.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 2,
  });
  assertContract(
    rejectedNonBuilderRepair === null,
    'Repair must reject an owned unit that has no builder capability',
  );
  const rejectedAlliedCapture = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'capture',
    tick: 1,
    commanderId: alliedGuardSource.id,
    targetId: alliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAlliedCapture === null,
    'BAR Capture must reject allied targets rather than treating every other player as hostile',
  );
  const authorizedNonAlliedCapture = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'capture',
    tick: 1,
    commanderId: alliedGuardSource.id,
    targetId: nonAlliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedNonAlliedCapture?.type === 'capture' &&
      authorizedNonAlliedCapture.targetId === nonAlliedGuardTarget.id,
    'BAR Capture must continue to authorize a genuinely hostile target',
  );
  const rejectedAlliedAttack = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'attack',
    tick: 1,
    entityIds: [alliedGuardSource.id],
    targetId: alliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedAlliedAttack === null,
    'BAR allied targets must not authorize direct Attack commands',
  );
  const rejectedNonAlliedGuard = authorizeGameServerGameplayCommand(alliedGuardWorld, {
    type: 'guard',
    tick: 1,
    entityIds: [alliedGuardSource.id],
    targetId: nonAlliedGuardTarget.id,
    queue: false,
  }, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    rejectedNonAlliedGuard === null,
    'BAR no-enemy-guard must still reject guard commands targeting non-allied units',
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
  const factoryOutputGuardCommand: SetFactoryOutputGuardCommand = {
    type: 'setFactoryOutputGuard',
    tick: 1,
    factoryId: fabricator.id,
    targetId: queen.id,
    queue: false,
  };
  const authorizedFactoryOutputGuard = authorizeGameServerGameplayCommand(
    world,
    factoryOutputGuardCommand,
    { mode: 'player', playerId: 1 },
  );
  assertContract(
    authorizedFactoryOutputGuard?.type === 'setFactoryOutputGuard' &&
      authorizedFactoryOutputGuard.targetId === queen.id,
    'factory output Guard must authorize an allied target independently of Factory Guard state',
  );

  const editFactoryQueueCommand: EditFactoryQueueCommand = {
    type: 'editFactoryQueue',
    tick: 1,
    factoryId: fabricator.id,
    operation: 'remove',
    index: 0,
  };
  const authorizedEditFactoryQueue = authorizeGameServerGameplayCommand(world, editFactoryQueueCommand, {
    mode: 'player',
    playerId: 1,
  });
  assertContract(
    authorizedEditFactoryQueue?.type === 'editFactoryQueue' &&
      authorizedEditFactoryQueue.factoryId === fabricator.id,
    'editFactoryQueue must authorize the factory owner so queue-edit UI is never dead',
  );

  const rejectedEditFactoryQueue = authorizeGameServerGameplayCommand(world, editFactoryQueueCommand, {
    mode: 'player',
    playerId: 2,
  });
  assertContract(
    rejectedEditFactoryQueue === null,
    'editFactoryQueue must reject players who do not own the factory',
  );
}
