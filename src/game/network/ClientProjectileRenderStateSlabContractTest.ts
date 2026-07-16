import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  projectileTypeToCode,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
} from '../../types/network';
import type { NetworkServerSnapshot } from './NetworkTypes';
import { ClientViewState } from './ClientViewState';
import type { ClientProjectileRenderLists } from './ClientProjectileStore';
import { createSpawnDto } from './snapshotDtoCopy';
import {
  quantizeProjectilePosition as qProjPos,
  quantizeRotation as qRot,
  quantizeVelocity as qVel,
} from './snapshotQuantization';
import { decodeNetworkSnapshot } from './snapshotWireCodec';
import {
  getPackedProjectileSnapshotWire,
  packProjectilesForWire,
} from './snapshotProjectileWirePack';
import {
  createProjectileSnapshotWireSource,
  getActiveProjectileSnapshotWireSource,
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_MOTION_WIRE_STRIDE,
  registerProjectileSnapshotWireSource,
  writeBeamPointWireRow,
  writeBeamUpdateWireRow,
  writeProjectileSpawnWireRow,
} from './stateSerializerProjectiles';
import { reserveFloat64WireRows } from './snapshotWireRows';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[client projectile render state contract] ${message}`);
  }
}

function emptyLists(): ClientProjectileRenderLists {
  return {
    traveling: [],
    smokeTrail: [],
    line: [],
    burnMark: [],
  };
}

type BeamTargetDebug = {
  points: Array<{ x: number }>;
};

type ProjectileStoreDebug = {
  beamPathTargets: Map<number, BeamTargetDebug>;
};

function getProjectileStoreDebug(view: ClientViewState): ProjectileStoreDebug {
  return (view as unknown as { projectileStore: ProjectileStoreDebug }).projectileStore;
}

function projectileSnapshot(
  tick: number,
  spawns: ReturnType<typeof createSpawnDto>[] | undefined,
  despawnIds?: readonly number[],
): NetworkServerSnapshot {
  return {
    tick,
    entities: [],
    entityDeltaOnly: undefined,
    projectileDeltaOnly: true,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: {
      spawns,
      despawns: despawnIds !== undefined
        ? despawnIds.map((id) => ({ id }))
        : undefined,
      motionUpdates: undefined,
      beamUpdates: undefined,
    },
    gameState: undefined,
    serverMeta: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
}

function directProjectileMotionSnapshot(
  tick: number,
  id: number,
  x: number,
  y: number,
  angularVelocity: number,
): NetworkServerSnapshot {
  const snapshot = projectileSnapshot(tick, undefined);
  const projectiles = snapshot.projectiles!;
  projectiles.motionUpdates = [undefined as never];
  const source = createProjectileSnapshotWireSource();
  const rowIndex = reserveFloat64WireRows(
    source.motionUpdates,
    1,
    PROJECTILE_MOTION_WIRE_STRIDE,
  );
  const base = rowIndex * PROJECTILE_MOTION_WIRE_STRIDE;
  source.motionUpdates.values[base + 0] = id;
  source.motionUpdates.values[base + 1] = qProjPos(x);
  source.motionUpdates.values[base + 2] = qProjPos(y);
  source.motionUpdates.values[base + 3] = qProjPos(35);
  source.motionUpdates.values[base + 4] = qVel(30);
  source.motionUpdates.values[base + 5] = qVel(5);
  source.motionUpdates.values[base + 6] = qVel(0);
  source.motionUpdates.values[base + 7] = qRot(0.4);
  source.motionUpdates.values[base + 8] = qRot(angularVelocity);
  registerProjectileSnapshotWireSource(projectiles, source);
  return snapshot;
}

function directProjectileSpawnSnapshot(
  tick: number,
  spawn: ReturnType<typeof createSpawnDto>,
): NetworkServerSnapshot {
  const snapshot = projectileSnapshot(tick, undefined);
  const projectiles = snapshot.projectiles!;
  projectiles.spawns = [undefined as never];
  const source = createProjectileSnapshotWireSource();
  const rowIndex = reserveFloat64WireRows(
    source.spawns,
    1,
    PROJECTILE_SPAWN_WIRE_STRIDE,
  );
  writeProjectileSpawnWireRow(
    source.spawns.values,
    rowIndex * PROJECTILE_SPAWN_WIRE_STRIDE,
    spawn,
  );
  registerProjectileSnapshotWireSource(projectiles, source);
  return snapshot;
}

function directBeamUpdateSnapshot(
  tick: number,
  id: number,
): NetworkServerSnapshot {
  const snapshot = projectileSnapshot(tick, undefined);
  const projectiles = snapshot.projectiles!;
  projectiles.beamUpdates = [undefined as never];
  const source = createProjectileSnapshotWireSource();
  const update = {
    id,
    obstructionT: null,
    endpointDamageable: true,
    points: [
      {
        x: qProjPos(300),
        y: qProjPos(300),
        z: qProjPos(25),
        vx: qVel(0),
        vy: qVel(0),
        vz: qVel(0),
        reflectorEntityId: null,
        reflectorKind: null,
        reflectorPlayerId: null,
        normalX: null,
        normalY: null,
        normalZ: null,
      },
      {
        x: qProjPos(375),
        y: qProjPos(325),
        z: qProjPos(28),
        vx: qVel(4),
        vy: qVel(2),
        vz: qVel(0),
        reflectorEntityId: 900,
        reflectorKind: 'shield' as const,
        reflectorPlayerId: 2,
        normalX: 0,
        normalY: qVel(-1),
        normalZ: 0,
      },
      {
        x: qProjPos(420),
        y: qProjPos(390),
        z: qProjPos(29),
        vx: qVel(8),
        vy: qVel(12),
        vz: qVel(0),
        reflectorEntityId: null,
        reflectorKind: null,
        reflectorPlayerId: null,
        normalX: null,
        normalY: null,
        normalZ: null,
      },
    ],
  };
  const updateIndex = reserveFloat64WireRows(
    source.beamUpdates,
    1,
    PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  );
  writeBeamUpdateWireRow(
    source.beamUpdates.values,
    updateIndex * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
    update,
  );
  for (let i = 0; i < update.points.length; i++) {
    const pointIndex = reserveFloat64WireRows(
      source.beamPoints,
      1,
      PROJECTILE_BEAM_POINT_WIRE_STRIDE,
    );
    writeBeamPointWireRow(
      source.beamPoints.values,
      pointIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE,
      update.points[i],
    );
  }
  registerProjectileSnapshotWireSource(projectiles, source);
  return snapshot;
}

function rocketSpawn(id: number, x: number, y: number) {
  const spawn = createSpawnDto();
  spawn.id = id;
  spawn.pos.x = qProjPos(x);
  spawn.pos.y = qProjPos(y);
  spawn.pos.z = qProjPos(20);
  spawn.rotation = qRot(0);
  spawn.velocity.x = qVel(80);
  spawn.velocity.y = qVel(0);
  spawn.velocity.z = qVel(0);
  spawn.projectileType = projectileTypeToCode('projectile');
  spawn.turretBlueprintCode = turretBlueprintIdToCode('turretRocketSlow');
  spawn.sourceTurretBlueprintCode = turretBlueprintIdToCode('turretRocketSlow');
  spawn.shotBlueprintCode = shotBlueprintIdToCode('shotRocketLight');
  spawn.playerId = 1;
  spawn.sourceEntityId = 500;
  spawn.sourceHostEntityId = 500;
  spawn.sourceRootEntityId = 500;
  spawn.sourceTeamId = 1;
  spawn.fromParentDetonation = true;
  spawn.targetEntityId = 999;
  return spawn;
}

function plasmaSpawn(id: number, x: number, y: number) {
  const spawn = createSpawnDto();
  spawn.id = id;
  spawn.pos.x = qProjPos(x);
  spawn.pos.y = qProjPos(y);
  spawn.pos.z = qProjPos(20);
  spawn.rotation = qRot(0);
  spawn.velocity.x = qVel(60);
  spawn.velocity.y = qVel(0);
  spawn.velocity.z = qVel(0);
  spawn.projectileType = projectileTypeToCode('projectile');
  spawn.turretBlueprintCode = turretBlueprintIdToCode('turretGunLight');
  spawn.sourceTurretBlueprintCode = turretBlueprintIdToCode('turretGunLight');
  spawn.shotBlueprintCode = shotBlueprintIdToCode('shotPlasmaLight');
  spawn.playerId = 1;
  spawn.sourceEntityId = 700;
  spawn.sourceHostEntityId = 700;
  spawn.sourceRootEntityId = 700;
  spawn.sourceTeamId = 1;
  return spawn;
}

function beamSpawn(id: number, x: number, y: number) {
  const spawn = createSpawnDto();
  spawn.id = id;
  spawn.pos.x = qProjPos(x);
  spawn.pos.y = qProjPos(y);
  spawn.pos.z = qProjPos(25);
  spawn.rotation = qRot(0);
  spawn.projectileType = projectileTypeToCode('beam');
  spawn.turretBlueprintCode = turretBlueprintIdToCode('turretBeam');
  spawn.sourceTurretBlueprintCode = turretBlueprintIdToCode('turretBeam');
  spawn.shotBlueprintCode = null;
  spawn.playerId = 1;
  spawn.sourceEntityId = 600;
  spawn.sourceHostEntityId = 600;
  spawn.sourceRootEntityId = 600;
  spawn.sourceTeamId = 1;
  spawn.beam = {
    start: { x: qProjPos(x), y: qProjPos(y), z: qProjPos(25) },
    end: { x: qProjPos(x + 250), y: qProjPos(y), z: qProjPos(25) },
  };
  return spawn;
}

export function runClientProjectileRenderStateSlabContractTest(): void {
  const view = new ClientViewState();
  const lists = emptyLists();
  view.applyNetworkState(projectileSnapshot(1, [
    rocketSpawn(301, 100, 100),
    beamSpawn(302, 900, 100),
  ]));

  let current = view.collectProjectileRenderLists(null, lists);
  assertContract(current.traveling.length === 1 && current.traveling[0].id === 301, 'all-mode traveling list resolves rocket slot');
  assertContract(current.smokeTrail.length === 1 && current.smokeTrail[0].id === 301, 'all-mode smoke list resolves rocket slot');
  assertContract(current.line.length === 1 && current.line[0].id === 302, 'all-mode line list resolves beam slot');
  assertContract(current.burnMark.length === 1 && current.burnMark[0].id === 302, 'all-mode burn list resolves beam slot');

  view.collectProjectileRenderLists({ minX: 0, minY: 0, maxX: 300, maxY: 300 }, lists);
  assertContract(lists.traveling.length === 1 && lists.traveling[0].id === 301, 'scoped traveling query keeps nearby rocket');
  assertContract(lists.line.length === 0, 'scoped line query excludes distant beam');
  assertContract(lists.burnMark.length === 0, 'scoped burn query excludes distant beam');

  view.collectProjectileRenderLists({ minX: 0, minY: 0, maxX: 1200, maxY: 300 }, lists);
  assertContract(lists.traveling.length === 1 && lists.traveling[0].id === 301, 'wide scoped query keeps rocket');
  assertContract(lists.line.length === 1 && lists.line[0].id === 302, 'wide scoped query keeps beam');
  assertContract(lists.burnMark.length === 1 && lists.burnMark[0].id === 302, 'wide scoped query keeps beam burn mark');

  const packedMotionSnapshot = projectileSnapshot(2, undefined, [302]);
  packedMotionSnapshot.projectiles!.motionUpdates = [{
    id: 301,
    pos: { x: qProjPos(125), y: qProjPos(140), z: qProjPos(35) },
    velocity: { x: qVel(45), y: qVel(5), z: qVel(0) },
    rotation: qRot(0.4),
    angularVelocity: qRot(0.2),
  }];
  const packedProjectiles = packProjectilesForWire(packedMotionSnapshot.projectiles);
  assertContract(packedProjectiles !== undefined, 'test projectile update must pack for wire');
  const decodedPackedMotionSnapshot = decodeNetworkSnapshot(msgpackEncode({
    ...packedMotionSnapshot,
    projectiles: packedProjectiles,
  }, { ignoreUndefined: true }));
  assertContract(
    getPackedProjectileSnapshotWire(decodedPackedMotionSnapshot.projectiles) !== undefined,
    'decoded packed projectile snapshot must retain packed metadata',
  );
  decodedPackedMotionSnapshot.projectiles!.despawns = undefined;
  decodedPackedMotionSnapshot.projectiles!.motionUpdates = undefined;
  view.applyNetworkState(decodedPackedMotionSnapshot);
  const packedUpdatedProjectile = view.getEntity(301)?.projectile;
  assertContract(
    packedUpdatedProjectile?.homingTargetId === 999,
    'packed projectile motion rows must not mutate the spawn homing target',
  );
  assertContract(
    view.getEntity(302) === undefined,
    'packed projectile despawn metadata must apply without DTO despawn rows',
  );

  view.applyNetworkState(directProjectileMotionSnapshot(3, 301, 145, 155, 0.35));
  const directUpdatedProjectile = view.getEntity(301)?.projectile;
  assertContract(
    directUpdatedProjectile?.homingTargetId === 999,
    'direct projectile motion rows must not mutate the spawn homing target',
  );

  view.applyNetworkState(directProjectileSpawnSnapshot(3, beamSpawn(304, 300, 300)));
  assertContract(
    view.getEntity(304)?.projectile?.projectileType === 'beam',
    'direct projectile spawn wire rows must create projectile entities without DTO spawn rows',
  );
  view.applyNetworkState(directBeamUpdateSnapshot(4, 304));
  const directBeamPoints = view.getEntity(304)?.projectile?.points;
  assertContract(
    directBeamPoints?.length === 3 &&
      directBeamPoints[1].reflectorEntityId === 900 &&
      directBeamPoints[1].reflectorKind === 'shield' &&
      directBeamPoints[2].x === 420,
    'direct projectile beam update wire rows must apply reflected beam paths without DTO beam rows',
  );
  view.collectProjectileRenderLists({ minX: 395, minY: 365, maxX: 430, maxY: 410 }, lists);
  assertContract(
    lists.line.length === 1 &&
      lists.line[0].id === 304 &&
      lists.burnMark.length === 1 &&
      lists.burnMark[0].id === 304,
    'direct projectile beam update wire rows must refresh line render query bounds',
  );
  const lineVersionAfterInitialBeamApply = view.getLineProjectileRenderVersion();
  view.applyPrediction(16);
  const lineVersionAfterInitialBeamMotion = view.getLineProjectileRenderVersion();
  assertContract(
    lineVersionAfterInitialBeamMotion !== lineVersionAfterInitialBeamApply,
    'initial beam target application must invalidate line rendering when it seeds display points',
  );
  view.applyNetworkState(directBeamUpdateSnapshot(5, 304));
  assertContract(
    view.getLineProjectileRenderVersion() === lineVersionAfterInitialBeamMotion,
    'steady beam target snapshots must not invalidate line rendering before display points move',
  );
  const beamTarget = getProjectileStoreDebug(view).beamPathTargets.get(304);
  if (beamTarget === undefined) {
    assertContract(false, 'steady authoritative beam target must remain tracked');
    return;
  }
  const authoritativeEndpointX = beamTarget.points[2].x;
  view.applyPrediction(16);
  assertContract(
    beamTarget.points[2].x === authoritativeEndpointX,
    'beam EMA must not mutate authoritative target points',
  );
  view.applyNetworkState(directBeamUpdateSnapshot(6, 304));
  assertContract(
    beamTarget.points[2].x === authoritativeEndpointX,
    'steady beam target snapshots must not rewrite authoritative target state',
  );

  view.applyNetworkState(directProjectileSpawnSnapshot(7, beamSpawn(305, 360, 300)));
  const packedBeamSnapshot = directBeamUpdateSnapshot(8, 305);
  const packedBeamProjectiles = packProjectilesForWire(packedBeamSnapshot.projectiles);
  assertContract(packedBeamProjectiles !== undefined, 'test beam update must pack for wire');
  const decodedPackedBeamSnapshot = decodeNetworkSnapshot(
    msgpackEncode({
      ...packedBeamSnapshot,
      projectiles: packedBeamProjectiles,
    }, { ignoreUndefined: true }),
    { packedProjectileDeltas: 'metadata-only' },
  );
  const decodedPackedBeamProjectiles = decodedPackedBeamSnapshot.projectiles;
  if (decodedPackedBeamProjectiles === undefined) {
    assertContract(false, 'packed metadata-only beam decode must keep a projectile section');
    return;
  }
  const packedBeamSource = getActiveProjectileSnapshotWireSource(decodedPackedBeamProjectiles);
  assertContract(
    decodedPackedBeamProjectiles.beamUpdates === undefined &&
      packedBeamSource?.beamUpdates.count === 1 &&
      packedBeamSource.beamPoints.count === 3,
    'packed metadata-only beam decode must expose wire rows without DTO beam updates',
  );
  view.applyNetworkState(decodedPackedBeamSnapshot);
  const packedBeamPoints = view.getEntity(305)?.projectile?.points;
  assertContract(
    packedBeamPoints?.length === 3 &&
      packedBeamPoints[1].reflectorEntityId === 900 &&
      packedBeamPoints[2].x === 420,
    'packed metadata-only beam wire rows must apply reflected beam paths without DTO beam rows',
  );

  view.applyNetworkState(projectileSnapshot(9, [plasmaSpawn(303, 700, 700)]));
  assertContract(
    view.getProjectiles().some((entity) => entity.id === 303),
    'projectile spawns must incrementally enter the client entity cache',
  );
  view.collectProjectileRenderLists({ minX: 650, minY: 650, maxX: 750, maxY: 750 }, lists);
  assertContract(
    lists.traveling.length === 1 && lists.traveling[0].id === 303,
    'scoped projectile query must include newly spawned plasma projectile',
  );

  const plasmaMotionSnapshot = projectileSnapshot(10, undefined);
  plasmaMotionSnapshot.projectiles!.motionUpdates = [{
    id: 303,
    pos: { x: qProjPos(1500), y: qProjPos(1500), z: qProjPos(35) },
    velocity: { x: qVel(45), y: qVel(5), z: qVel(0) },
    rotation: qRot(0.4),
    angularVelocity: qRot(0.2),
  }];
  view.applyNetworkState(plasmaMotionSnapshot);
  view.collectProjectileRenderLists({ minX: 650, minY: 650, maxX: 750, maxY: 750 }, lists);
  assertContract(
    lists.traveling.length === 0,
    'projectile motion update must move the render spatial slot out of its old query bounds',
  );
  view.collectProjectileRenderLists({ minX: 1450, minY: 1450, maxX: 1550, maxY: 1550 }, lists);
  assertContract(
    lists.traveling.length === 1 && lists.traveling[0].id === 303,
    'projectile motion update must move the render spatial slot into its new query bounds',
  );

  view.applyNetworkState(projectileSnapshot(11, undefined, [301, 302, 303, 304, 305]));
  assertContract(
    !view.getProjectiles().some((entity) => entity.id === 303),
    'projectile despawns must incrementally leave the client entity cache',
  );
  current = view.collectProjectileRenderLists(null, lists);
  assertContract(
    current.traveling.length === 0 &&
      current.smokeTrail.length === 0 &&
      current.line.length === 0 &&
      current.burnMark.length === 0,
    'despawn removes projectile render slab rows and compatibility lists',
  );
}
