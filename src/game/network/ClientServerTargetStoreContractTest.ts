import type { EntityId } from '../sim/types';
import {
  createServerTarget,
  resetClientPredictionTargetPools,
  resizeServerTargetTurrets,
} from './ClientPredictionTargets';
import { ClientServerTargetStore } from './ClientServerTargetStore';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[client server target store contract] ${message}`);
  }
}

export function runClientServerTargetStoreContractTest(): void {
  resetClientPredictionTargetPools(0);
  const store = new ClientServerTargetStore();
  const id = 42 as EntityId;
  const first = createServerTarget();
  const second = createServerTarget();
  second.x = 100;

  assertContract(store.set(id, first) === store, 'set returns the store');
  assertContract(store.get(id) === first, 'get returns indexed target');
  assertContract(store.has(id), 'has sees indexed target');

  store.set(id, second);
  assertContract(store.get(id) === second, 'set replaces indexed target');
  assertContract([...store.values()][0] === second, 'Map iteration sees replacement');

  assertContract(store.delete(id), 'delete reports existing target');
  assertContract(store.get(id) === undefined, 'delete clears indexed target');
  assertContract(!store.has(id), 'has clears after delete');
  assertContract(store.delete(id) === false, 'delete reports missing indexed target');

  const highId = 1_000_001 as EntityId;
  const high = createServerTarget();
  high.y = 200;
  store.set(highId, high);
  assertContract(store.get(highId) === high, 'high id falls back to Map storage');
  assertContract(store.delete((highId + 1) as EntityId) === false, 'delete reports missing fallback target');

  store.clear();
  assertContract(store.size === 0, 'clear empties Map storage');
  assertContract(store.get(highId) === undefined, 'clear empties fallback storage');

  const pooled = store.getOrCreate(id);
  pooled.updatedAtMs = 123;
  pooled.x = 10;
  pooled.y = 20;
  pooled.z = 30;
  pooled.rotation = 1.25;
  pooled.velocityX = 2;
  pooled.velocityY = 3;
  pooled.velocityZ = 4;
  pooled.surfaceNormalX = 0.25;
  pooled.surfaceNormalY = 0.5;
  pooled.surfaceNormalZ = 0.75;
  pooled.bodyCenterHeight = 6;
  pooled.predictedGroundContact = false;
  pooled.orientation = { x: 1, y: 2, z: 3, w: 4 };
  pooled.angularVelocityX = 7;
  pooled.angularVelocityY = 8;
  pooled.angularVelocityZ = 9;
  resizeServerTargetTurrets(pooled, 2);
  pooled.turrets[0].rotation = 11;
  pooled.turrets[1].shieldRange = 12;

  assertContract(store.delete(id), 'delete reports pooled target');
  const reused = store.getOrCreate(id);
  assertContract(reused === pooled, 'getOrCreate reuses released pooled target');
  assertContract(reused.updatedAtMs === 0, 'pooled target resets timestamp');
  assertContract(reused.x === 0 && reused.y === 0 && reused.z === 0, 'pooled target resets position');
  assertContract(reused.rotation === 0, 'pooled target resets rotation');
  assertContract(
    reused.velocityX === 0 && reused.velocityY === 0 && reused.velocityZ === 0,
    'pooled target resets velocity',
  );
  assertContract(
    reused.surfaceNormalX === 0 && reused.surfaceNormalY === 0 && reused.surfaceNormalZ === 1,
    'pooled target resets surface normal',
  );
  assertContract(reused.bodyCenterHeight === 0, 'pooled target resets body height');
  assertContract(reused.predictedGroundContact, 'pooled target resets ground contact');
  assertContract(reused.orientation === null, 'pooled target clears orientation');
  assertContract(
    reused.angularVelocityX === null && reused.angularVelocityY === null && reused.angularVelocityZ === null,
    'pooled target clears angular velocity',
  );
  assertContract(reused.turrets.length === 0, 'pooled target releases turret rows');

  resizeServerTargetTurrets(reused, 1);
  reused.turrets[0].rotation = 99;
  store.clear();
  const reusedAfterClear = store.getOrCreate(id);
  assertContract(reusedAfterClear === reused, 'clear releases pooled target');
  assertContract(
    reusedAfterClear.turrets.length === 0,
    'clear releases pooled target turrets',
  );
}
