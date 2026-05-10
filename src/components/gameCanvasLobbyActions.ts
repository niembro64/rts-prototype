import { nextTick, type Ref } from 'vue';
import type {
  LobbyPlayer,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';

export type GameCanvasLobbyActions = {
  handleHost(): Promise<void>;
  handleJoin(code: string): Promise<void>;
  handleLobbyStart(): void;
  handleLobbyCancel(): void;
  handleOffline(): void;
};

export type GameCanvasLobbyActionsOptions = {
  network: NetworkManager;
  isConnecting: Ref<boolean>;
  lobbyError: Ref<string | null>;
  networkNotice: Ref<string | null>;
  roomCode: Ref<string>;
  isHost: Ref<boolean>;
  networkRole: Ref<NetworkRole | null>;
  localPlayerId: Ref<PlayerId>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  battleLoading: Ref<boolean>;
  setupNetworkCallbacks: () => void;
  reportLocalPlayerInfo: () => void;
  startGameWithPlayers: (
    playerIds: PlayerId[],
    aiPlayerIds?: PlayerId[],
  ) => void | Promise<void>;
};

export function useGameCanvasLobbyActions({
  network,
  isConnecting,
  lobbyError,
  networkNotice,
  roomCode,
  isHost,
  networkRole,
  localPlayerId,
  lobbyPlayers,
  battleLoading,
  setupNetworkCallbacks,
  reportLocalPlayerInfo,
  startGameWithPlayers,
}: GameCanvasLobbyActionsOptions): GameCanvasLobbyActions {
  async function handleHost(): Promise<void> {
    try {
      isConnecting.value = true;
      lobbyError.value = null;
      networkNotice.value = null;

      await network.hostGame();
      roomCode.value = network.getRoomCode();
      isHost.value = true;
      networkRole.value = 'host';
      localPlayerId.value = 1;
      lobbyPlayers.value = network.getPlayers().map((player) => ({ ...player }));

      setupNetworkCallbacks();
      // Eagerly report available local info; the async IP lookup can
      // call through again later to fill any missing columns.
      reportLocalPlayerInfo();

      isConnecting.value = false;
    } catch (err) {
      lobbyError.value = (err as Error).message || 'Failed to host game';
      networkNotice.value = lobbyError.value;
      isConnecting.value = false;
    }
  }

  async function handleJoin(code: string): Promise<void> {
    try {
      isConnecting.value = true;
      lobbyError.value = null;
      networkNotice.value = null;

      // Bind callbacks before joining; the host can send playerAssignment
      // as soon as the PeerJS connection opens.
      networkRole.value = 'client';
      setupNetworkCallbacks();

      await network.joinGame(code);
      roomCode.value = network.getRoomCode();
      isHost.value = false;

      // Same eager-report rule as host: timezone is immediate, IP/location
      // may still arrive later and overwrite the partial report.
      reportLocalPlayerInfo();

      isConnecting.value = false;
    } catch (err) {
      lobbyError.value = (err as Error).message || 'Failed to join game';
      networkNotice.value = lobbyError.value;
      isConnecting.value = false;
    }
  }

  function handleLobbyStart(): void {
    network.startGame();
  }

  function handleLobbyCancel(): void {
    battleLoading.value = false;
    network.disconnect();
    networkRole.value = null;
    roomCode.value = '';
    isHost.value = false;
    lobbyPlayers.value = [];
    lobbyError.value = null;
    networkNotice.value = null;
    isConnecting.value = false;
  }

  function handleOffline(): void {
    networkRole.value = null;
    networkNotice.value = null;
    battleLoading.value = true;
    localPlayerId.value = 1;

    nextTick(() => {
      void startGameWithPlayers(
        [1, 2, 3, 4] as PlayerId[],
        [2, 3, 4] as PlayerId[],
      );
    });
  }

  return {
    handleHost,
    handleJoin,
    handleLobbyStart,
    handleLobbyCancel,
    handleOffline,
  };
}
