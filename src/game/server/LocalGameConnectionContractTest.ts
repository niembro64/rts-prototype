import type { NetworkServerSnapshot, NetworkServerSnapshotEntity } from '../network/NetworkTypes';
import {
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendEntitySnapshotWireSourceRow,
  createEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
} from '../network/stateSerializerEntities';
import {
  createProjectileSnapshotWireSource,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  registerProjectileSnapshotWireSource,
} from '../network/stateSerializerProjectiles';
import { reserveFloat64WireRows, reserveUint32WireRows } from '../network/snapshotWireRows';
import { canDeliverDirectLocalSnapshotState } from './LocalGameConnection';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[local game connection contract] ${message}`);
  }
}

function createSnapshot(
  entities: NetworkServerSnapshot['entities'],
): NetworkServerSnapshot {
  return {
    tick: 1,
    entities,
    entityDeltaOnly: true,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
}

function createTypedPlaceholderDeltaSnapshot(): NetworkServerSnapshot {
  const entities = new Array<NetworkServerSnapshotEntity>(1);
  const source = createEntitySnapshotWireSource(1);
  const rowIndex = reserveFloat64WireRows(source.unitRows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  source.unitRows.values[base + 0] = 101;
  source.unitRows.values[base + 5] = 1;
  source.unitRows.values[base + 6] = 1;
  source.unitRows.values[base + 7] = 1;
  appendEntitySnapshotWireSourceRow(source, ENTITY_SNAPSHOT_WIRE_KIND_UNIT, rowIndex, true, 1);
  registerEntitySnapshotWireSource(entities, source);
  return createSnapshot(entities);
}

function attachDirectProjectileMotionRows(snapshot: NetworkServerSnapshot): void {
  const projectiles = {
    spawns: undefined,
    despawns: new Array(1),
    velocityUpdates: new Array(1),
    beamUpdates: undefined,
  } as NonNullable<NetworkServerSnapshot['projectiles']>;
  const source = createProjectileSnapshotWireSource();
  const despawnIndex = reserveUint32WireRows(source.despawns, 1, 1);
  source.despawns.values[despawnIndex] = 301;
  const velocityIndex = reserveFloat64WireRows(
    source.velocityUpdates,
    1,
    PROJECTILE_VELOCITY_WIRE_STRIDE,
  );
  const velocityBase = velocityIndex * PROJECTILE_VELOCITY_WIRE_STRIDE;
  source.velocityUpdates.values[velocityBase + 0] = 302;
  source.velocityUpdates.values[velocityBase + 1] = 10;
  source.velocityUpdates.values[velocityBase + 2] = 20;
  source.velocityUpdates.values[velocityBase + 3] = 30;
  source.velocityUpdates.values[velocityBase + 4] = 1;
  source.velocityUpdates.values[velocityBase + 5] = 2;
  source.velocityUpdates.values[velocityBase + 6] = 3;
  source.velocityUpdates.values[velocityBase + 8] = 401;
  registerProjectileSnapshotWireSource(projectiles, source);
  snapshot.projectiles = projectiles;
}

function attachDirectProjectileSpawnRows(snapshot: NetworkServerSnapshot): void {
  const projectiles = {
    spawns: new Array(1),
    despawns: undefined,
    velocityUpdates: undefined,
    beamUpdates: undefined,
  } as NonNullable<NetworkServerSnapshot['projectiles']>;
  const source = createProjectileSnapshotWireSource();
  reserveFloat64WireRows(source.spawns, 1, PROJECTILE_SPAWN_WIRE_STRIDE);
  registerProjectileSnapshotWireSource(projectiles, source);
  snapshot.projectiles = projectiles;
}

function attachDirectProjectileBeamUpdateRows(snapshot: NetworkServerSnapshot): void {
  const projectiles = {
    spawns: undefined,
    despawns: undefined,
    velocityUpdates: undefined,
    beamUpdates: new Array(1),
  } as NonNullable<NetworkServerSnapshot['projectiles']>;
  const source = createProjectileSnapshotWireSource();
  reserveFloat64WireRows(source.beamUpdates, 1, PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  registerProjectileSnapshotWireSource(projectiles, source);
  snapshot.projectiles = projectiles;
}

export function runLocalGameConnectionContractTest(): void {
  const pureTypedDelta = createTypedPlaceholderDeltaSnapshot();
  assertContract(
    canDeliverDirectLocalSnapshotState(pureTypedDelta),
    'pure typed entity delta placeholders may be delivered directly',
  );

  const withProjectileMotionRows = createTypedPlaceholderDeltaSnapshot();
  attachDirectProjectileMotionRows(withProjectileMotionRows);
  assertContract(
    canDeliverDirectLocalSnapshotState(withProjectileMotionRows),
    'typed entity delta plus projectile motion rows may be delivered directly',
  );

  const pureProjectileMotionRows = createSnapshot([]);
  pureProjectileMotionRows.entityDeltaOnly = undefined;
  pureProjectileMotionRows.projectileDeltaOnly = true;
  attachDirectProjectileMotionRows(pureProjectileMotionRows);
  assertContract(
    canDeliverDirectLocalSnapshotState(pureProjectileMotionRows),
    'pure projectile motion rows may be delivered directly',
  );

  const withProjectileSpawnRows = createTypedPlaceholderDeltaSnapshot();
  attachDirectProjectileSpawnRows(withProjectileSpawnRows);
  assertContract(
    canDeliverDirectLocalSnapshotState(withProjectileSpawnRows),
    'projectile spawn rows may be delivered directly',
  );

  const withProjectileBeamRows = createTypedPlaceholderDeltaSnapshot();
  attachDirectProjectileBeamUpdateRows(withProjectileBeamRows);
  assertContract(
    canDeliverDirectLocalSnapshotState(withProjectileBeamRows),
    'projectile beam update rows may be delivered directly',
  );

  const fullSnapshot = createTypedPlaceholderDeltaSnapshot();
  fullSnapshot.entityDeltaOnly = undefined;
  assertContract(
    !canDeliverDirectLocalSnapshotState(fullSnapshot),
    'full/detail-bearing snapshots must decode before local delivery',
  );

  const materializedDelta = createSnapshot([
    {
      id: 101,
      type: 'unit',
      playerId: 1,
      changedFields: 1,
      pos: null,
      rotation: null,
      unit: null,
      building: null,
    },
  ]);
  assertContract(
    !canDeliverDirectLocalSnapshotState(materializedDelta),
    'materialized entity rows should stay on the normal DTO path',
  );
}
