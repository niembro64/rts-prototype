import type { PlayerId } from '../sim/types';
import { NetworkManager } from './NetworkManager';
import {
  LOCKSTEP_PROTOCOL_VERSION,
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
    handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): void;
  };
  const readyMessage: NetworkLockstepMessage = {
    gameId: undefined,
    protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
    type: 'lockstepReady',
    playerId: 1 as PlayerId,
    readyFrame: 0,
    initializationHash: 'contract-init',
  };

  privateManager.handleMessage(readyMessage, 1 as PlayerId);
  assertContract(
    manager.getPendingLockstepMessageDiagnostics().queued === 1,
    'lockstep messages received before backend registration must be queued',
  );

  const received: Array<{ message: NetworkLockstepMessage; fromPlayerId: PlayerId }> = [];
  manager.onLockstepMessage = (message, fromPlayerId) => {
    received.push({ message, fromPlayerId });
  };

  assertContract(received.length === 1, 'queued lockstep messages must drain on handler registration');
  assertContract(
    received[0].message === readyMessage && received[0].fromPlayerId === 1,
    'drained lockstep message must preserve message and sender',
  );
  assertContract(
    manager.getPendingLockstepMessageDiagnostics().queued === 0,
    'draining must clear the pending lockstep queue',
  );
}
