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
      LOCKSTEP_SUPPORT_BOUNDARIES.hostMigration === false &&
      LOCKSTEP_SUPPORT_BOUNDARIES.automaticResync === false &&
      LOCKSTEP_SUPPORT_BOUNDARIES.bots === 'deterministic-sim-only',
    'the remaining support boundaries must stay explicit',
  );

  // BOTS are seats the deterministic sim drives (src/game/sim/agentSeat.ts):
  // in the roster, hashed into the initialization, never in the completion
  // set, and issuing no commands. That is supported — with the shape below.
  assertDeterministicLockstepSupported({
    playerIds: [1 as PlayerId, 2 as PlayerId, 3 as PlayerId],
    aiPlayerIds: [2 as PlayerId, 3 as PlayerId],
    localPlayerId: 1 as PlayerId,
    networkRole: 'host',
    battleKind: 'real',
  });

  // A WATCHER holds no seat. It simulates every frame like anyone else and is
  // simply absent from the roster, so this must be accepted rather than
  // treated as a broken client.
  assertDeterministicLockstepSupported({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    localPlayerId: undefined,
    networkRole: 'client',
    battleKind: 'real',
  });
  // What is NOT supported around bots, each refused at the door:
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: [3 as PlayerId],
      localPlayerId: 1 as PlayerId,
      networkRole: null,
      battleKind: 'real',
    }),
    'a bot outside the frame-0 roster must fail early',
  );
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: [1 as PlayerId, 2 as PlayerId],
      localPlayerId: undefined,
      networkRole: 'host',
      battleKind: 'real',
    }),
    'a match of only bots must fail early — nobody would complete a frame',
  );
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: [1 as PlayerId],
      localPlayerId: 1 as PlayerId,
      networkRole: 'host',
      battleKind: 'real',
    }),
    'a connection holding a bot seat must fail early',
  );
  // Holding a seat that is not in the roster is still a real fault: it means
  // the handoff and this client disagree about who is playing.
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [1 as PlayerId, 2 as PlayerId],
      aiPlayerIds: undefined,
      localPlayerId: 3 as PlayerId,
      networkRole: 'client',
      battleKind: 'real',
    }),
    'a seat outside the frame-0 roster must fail early',
  );
  assertThrows(
    () => assertDeterministicLockstepSupported({
      playerIds: [],
      aiPlayerIds: undefined,
      localPlayerId: undefined,
      networkRole: 'host',
      battleKind: 'real',
    }),
    'a match with nobody seated must fail early',
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
