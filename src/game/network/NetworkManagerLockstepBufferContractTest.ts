/**
 * Lockstep messages that arrive before the battle backend exists must be
 * queued, and must arrive with BOTH identities intact when it does.
 *
 * The two ids are not interchangeable. `memberId` addresses the connection —
 * it is how a catch-up answer gets routed back to a watcher that holds no
 * seat. `playerId` is the seat the sender speaks for, and is undefined for a
 * watcher, which is what forces every consumer to decide out loud what an
 * unseated sender may do.
 */

import type { PlayerId } from '../sim/types';
import { NetworkManager } from './NetworkManager';
import { HOST_MEMBER_ID } from './NetworkLobbyMembers';
import {
  type NetworkLockstepMessage,
  type NetworkMessage,
} from './NetworkTypes';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[network manager lockstep buffer contract] ${message}`);
  }
}

export function runNetworkManagerLockstepBufferContractTest(): void {
  const manager = new NetworkManager();
  const privateManager = manager as unknown as {
    handleMessage(message: NetworkMessage, fromMemberId: number): void;
    members: {
      admit(memberId: number, name: string): unknown;
      seat(memberId: number, sideCount: number): unknown;
      get(memberId: number): { playerId: PlayerId | undefined } | undefined;
    };
  };
  const readyMessage: NetworkLockstepMessage = {
    gameId: undefined,
    type: 'lockstepReady',
    playerId: 1 as PlayerId,
    readyFrame: 0,
    initializationHash: 'contract-init',
  };

  // --- a message from a connection holding no seat --------------------------
  privateManager.handleMessage(readyMessage, HOST_MEMBER_ID);
  assertContract(
    manager.getPendingLockstepMessageDiagnostics().queued === 1,
    'lockstep messages received before backend registration must be queued',
  );

  const received: Array<{
    message: NetworkLockstepMessage;
    memberId: number;
    playerId: PlayerId | undefined;
  }> = [];
  manager.onLockstepMessage = (message, from) => {
    received.push({ message, memberId: from.memberId, playerId: from.playerId });
  };

  assertContract(received.length === 1, 'queued lockstep messages must drain on handler registration');
  assertContract(
    received[0].message === readyMessage,
    'drained lockstep message must preserve the message',
  );
  assertContract(
    received[0].memberId === HOST_MEMBER_ID,
    'drained lockstep message must preserve the sending CONNECTION',
  );
  assertContract(
    received[0].playerId === undefined,
    'a sender holding no seat must report no seat, not a default one',
  );
  assertContract(
    manager.getPendingLockstepMessageDiagnostics().queued === 0,
    'draining must clear the pending lockstep queue',
  );

  // --- the same connection, once it holds a seat ----------------------------
  //
  // Member id and seat are deliberately independent: this fixture has no host
  // seeded, so member 2 is handed seat 1. Reading the granted seat rather than
  // assuming it matches the member is the point.
  privateManager.members.admit(2, 'Seated');
  privateManager.members.seat(2, 2);
  const grantedSeat = privateManager.members.get(2)?.playerId;
  assertContract(grantedSeat !== undefined, 'seating must hand out a seat');
  received.length = 0;
  privateManager.handleMessage(readyMessage, 2);
  assertContract(received.length === 1, 'a live handler receives without queueing');
  assertContract(
    received[0].memberId === 2 && received[0].playerId === grantedSeat,
    'a seated sender must report both its connection and its seat',
  );
}
