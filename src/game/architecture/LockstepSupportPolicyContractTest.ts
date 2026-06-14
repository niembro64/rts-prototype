import type { PlayerId } from '../sim/types';
import {
  assertDeterministicLockstepSupported,
  LOCKSTEP_SUPPORT_BOUNDARIES,
} from './LockstepSupportPolicy';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[lockstep support policy contract] ${message}`);
  }
}

export function runLockstepSupportPolicyContractTest(): void {
  assertDeterministicLockstepSupported({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    localPlayerId: 1 as PlayerId,
    networkRole: 'host',
    battleKind: 'real',
  });
  assertContract(
    LOCKSTEP_SUPPORT_BOUNDARIES.hostRole === 'coordinator-relay-only' &&
      LOCKSTEP_SUPPORT_BOUNDARIES.lateJoin === false &&
      LOCKSTEP_SUPPORT_BOUNDARIES.automaticResync === false,
    'first release support boundaries must stay explicit',
  );
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: [2 as PlayerId],
      localPlayerId: 1 as PlayerId,
      networkRole: null,
      battleKind: 'real',
    }),
    'AI players must fail early',
  );
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: undefined,
      localPlayerId: 3 as PlayerId,
      networkRole: 'client',
      battleKind: 'real',
    }),
    'spectators/late joins must fail early',
  );
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assertContract(threw, message);
}
