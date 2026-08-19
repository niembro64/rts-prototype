/**
 * The web backend: lobbies live in web_games_backend, peers meet over WebRTC.
 *
 * This is the backend games.niemo.io runs on. It owns no transport code of
 * its own — PeerJS already carries the match — so all it does is translate
 * the shared vocabulary in `MultiplayerBackend` into the directory calls in
 * `LobbyDirectory`, which is where the lease semantics (announce, heartbeat,
 * expire) actually live.
 */

import {
  fetchLobbyDirectory,
  LobbyPublisher,
  MAX_LOBBY_PLAYERS,
} from '../LobbyDirectory';
import type {
  MultiplayerBackend,
  MultiplayerBackendId,
  MultiplayerLobbyAdvert,
  MultiplayerLobbySummary,
} from './MultiplayerBackend';

export class NativeMultiplayerBackend implements MultiplayerBackend {
  readonly id: MultiplayerBackendId = 'native';

  private readonly publisher = new LobbyPublisher();

  isAvailable(): boolean {
    // Needs nothing but the ability to make a request. A directory that is
    // down is handled per-call, not by declaring the backend unusable: the
    // room-code flow keeps working without it.
    return typeof fetch === 'function';
  }

  unavailableReason(): string | null {
    return this.isAvailable() ? null : 'this runtime has no fetch()';
  }

  async listLobbies(): Promise<readonly MultiplayerLobbySummary[]> {
    const listing = await fetchLobbyDirectory();
    return listing.lobbies.map((lobby) => ({
      roomCode: lobby.roomCode,
      name: lobby.name,
      hostName: lobby.hostName,
      status: lobby.status,
      playerCount: lobby.playerCount,
      maxPlayers: lobby.maxPlayers || MAX_LOBBY_PLAYERS,
      mapName: lobby.mapName,
      createdAt: lobby.createdAt,
    }));
  }

  publishLobby(describe: () => MultiplayerLobbyAdvert | null): void {
    this.publisher.publish(() => {
      const advert = describe();
      if (advert === null) return null;
      return {
        roomCode: advert.roomCode,
        name: advert.name,
        hostName: advert.hostName,
        status: advert.status,
        playerCount: advert.playerCount,
        mapName: advert.mapName,
      };
    });
  }

  withdrawLobby(): void {
    this.publisher.stop();
  }
}
