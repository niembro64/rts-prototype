import type { NetworkServerSnapshot, NetworkServerSnapshotEntity } from '../network/NetworkTypes';
import {
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendEntitySnapshotWireSourceRow,
  createEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
} from '../network/stateSerializerEntities';
import { reserveFloat64WireRows } from '../network/snapshotWireRows';
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
  appendEntitySnapshotWireSourceRow(source, ENTITY_SNAPSHOT_WIRE_KIND_UNIT, rowIndex, true);
  registerEntitySnapshotWireSource(entities, source);
  return createSnapshot(entities);
}

export function runLocalGameConnectionContractTest(): void {
  const pureTypedDelta = createTypedPlaceholderDeltaSnapshot();
  assertContract(
    canDeliverDirectLocalSnapshotState(pureTypedDelta),
    'pure typed entity delta placeholders may be delivered directly',
  );

  const withProjectileSection = createTypedPlaceholderDeltaSnapshot();
  withProjectileSection.projectiles = {
    spawns: [undefined as never],
    despawns: undefined,
    velocityUpdates: undefined,
    beamUpdates: undefined,
  };
  assertContract(
    !canDeliverDirectLocalSnapshotState(withProjectileSection),
    'direct delivery must reject projectile placeholder sections',
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
