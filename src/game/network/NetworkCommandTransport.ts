import type { DataConnection } from 'peerjs';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type {
  NetworkMessage,
  NetworkRole,
} from './NetworkTypes';

type NetworkCommandTransportOptions = {
  getGameId: () => string;
  getHostConnection: () => DataConnection | undefined;
  getRole: () => NetworkRole | null;
  isMessageForCurrentGame: (message: { gameId?: string }) => boolean;
  onClientReady: (playerId: PlayerId) => void;
  onCommandReceived: (command: Command, fromPlayerId: PlayerId) => void;
  send: (conn: DataConnection, message: NetworkMessage) => boolean;
};

export class NetworkCommandTransport {
  constructor(private readonly options: NetworkCommandTransportOptions) {}

  sendCommand(command: Command): void {
    if (this.options.getRole() !== 'client') return;
    const hostConn = this.options.getHostConnection();
    if (!hostConn) return;
    this.options.send(hostConn, {
      type: 'command',
      gameId: this.options.getGameId(),
      data: command,
    });
  }

  sendClientReady(): void {
    if (this.options.getRole() !== 'client') return;
    const hostConn = this.options.getHostConnection();
    if (!hostConn) return;
    this.options.send(hostConn, {
      type: 'clientReady',
      gameId: this.options.getGameId(),
    });
  }

  handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): boolean {
    switch (message.type) {
      case 'command':
        if (this.options.getRole() !== 'host') return true;
        if (!this.options.isMessageForCurrentGame(message)) return true;
        this.options.onCommandReceived(message.data, fromPlayerId);
        return true;

      case 'clientReady':
        if (this.options.getRole() !== 'host') return true;
        if (!this.options.isMessageForCurrentGame(message)) return true;
        this.options.onClientReady(fromPlayerId);
        return true;

      default:
        return false;
    }
  }
}
