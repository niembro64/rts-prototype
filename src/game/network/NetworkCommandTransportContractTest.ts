import type { DataConnection } from 'peerjs';
import type { MoveCommand } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkMessage, NetworkRole } from './NetworkTypes';
import { NetworkCommandTransport } from './NetworkCommandTransport';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[network command transport contract] ${message}`);
  }
}

export function runNetworkCommandTransportContractTest(): void {
  const command: MoveCommand = {
    type: 'move',
    tick: 10,
    entityIds: [7],
    targetX: 42,
    targetY: 84,
    waypointType: 'move',
    queue: true,
    queueFront: false,
    queueInsertIndex: 3,
  };
  let role: NetworkRole | null = 'client';
  const sentMessages: NetworkMessage[] = [];
  const receivedCommands: MoveCommand[] = [];
  const receivedPlayerIds: PlayerId[] = [];
  const hostConnection = { open: true } as DataConnection;
  const transport = new NetworkCommandTransport({
    getGameId: () => 'contract-game',
    getHostConnection: () => hostConnection,
    getLocalPlayerId: () => 1 as PlayerId,
    getRole: () => role,
    isMessageForCurrentGame: (message) => message.gameId === 'contract-game',
    onClientReady: () => undefined,
    onCommandReceived: (received, playerId) => {
      receivedCommands.push(received as MoveCommand);
      receivedPlayerIds.push(playerId);
    },
    onSnapshotResyncRequested: () => undefined,
    send: (_conn, message) => {
      sentMessages.push(message);
      return true;
    },
  });

  transport.sendCommand(command);
  const clientMessage = sentMessages[0];
  if (clientMessage?.type !== 'command') {
    throw new Error('[network command transport contract] client send must emit a command message');
  }
  if (clientMessage.data.type !== 'move') {
    throw new Error('[network command transport contract] client command must stay a move command');
  }
  assertContract(
    clientMessage.data.queue === true &&
      clientMessage.data.queueFront === false &&
      clientMessage.data.queueInsertIndex === 3,
    'client send must preserve queue fields',
  );

  role = 'host';
  const submitted = transport.sendCommand(command);
  assertContract(submitted, 'host-local send must use the same command doorway');
  const receivedCommand = receivedCommands[0];
  assertContract(
    receivedCommand === command &&
      receivedPlayerIds[0] === 1 &&
      receivedCommand.queue === true &&
      receivedCommand.queueInsertIndex === 3,
    'host-local send must preserve the same queued command object and player id',
  );
}
