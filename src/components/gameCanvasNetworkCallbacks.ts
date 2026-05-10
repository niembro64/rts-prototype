import type { Ref } from 'vue';
import type {
  BattleHandoff,
  LobbyPlayer,
  LobbySettings,
  NetworkManager,
} from '../game/network/NetworkManager';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { GameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';

export type GameCanvasNetworkCallbackOptions = {
  network: NetworkManager;
  realBattleLifecycle: GameCanvasRealBattleLifecycle;
  networkNotice: Ref<string | null>;
  lobbyError: Ref<string | null>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  roomCode: Ref<string>;
  localPlayerId: Ref<PlayerId>;
  activePlayer: Ref<PlayerId>;
  localUsername: Ref<string>;
  gameStarted: Ref<boolean>;
  getCurrentServer: () => GameServer | null;
  resolvePlayerName: (playerId: PlayerId) => string;
  upsertLobbyPlayer: (player: LobbyPlayer) => void;
  applyLobbySettingsFromHost: (
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ) => void;
  currentLobbySettings: () => LobbySettings;
  startGameWithPlayers: (playerIds: PlayerId[]) => void | Promise<void>;
};

export function bindGameCanvasNetworkCallbacks({
  network,
  realBattleLifecycle,
  networkNotice,
  lobbyError,
  lobbyPlayers,
  roomCode,
  localPlayerId,
  activePlayer,
  localUsername,
  gameStarted,
  getCurrentServer,
  resolvePlayerName,
  upsertLobbyPlayer,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  startGameWithPlayers,
}: GameCanvasNetworkCallbackOptions): void {
  network.onPlayerJoined = (player: LobbyPlayer) => {
    networkNotice.value = null;
    upsertLobbyPlayer(player);
  };

  network.onPlayerLeft = (playerId: PlayerId) => {
    const playerName = resolvePlayerName(playerId);
    lobbyPlayers.value = lobbyPlayers.value.filter(
      (player) => player.playerId !== playerId,
    );
    realBattleLifecycle.removeSnapshotListener(getCurrentServer(), playerId);
    if (gameStarted.value) {
      networkNotice.value = `${playerName} disconnected`;
    }
  };

  network.onPlayerAssignment = (playerId: PlayerId) => {
    networkNotice.value = null;
    localPlayerId.value = playerId;
    activePlayer.value = playerId;
  };

  network.onGameStart = (handoff: BattleHandoff) => {
    networkNotice.value = null;
    roomCode.value = handoff.roomCode;
    lobbyPlayers.value = handoff.players.map((player) => ({ ...player }));
    if (handoff.settings) {
      applyLobbySettingsFromHost(handoff.settings, { restartPreview: false });
    }
    void startGameWithPlayers(handoff.playerIds);
  };

  network.onClientReady = (playerId: PlayerId) => {
    getCurrentServer()?.markPlayerReady(playerId);
  };

  network.onError = (error: string) => {
    lobbyError.value = error;
    networkNotice.value = error;
  };

  network.onPlayerInfoUpdate = (player) => {
    if (player.playerId === localPlayerId.value && player.name) {
      localUsername.value = player.name;
    }
    upsertLobbyPlayer(player);
  };

  network.getLobbySettings = currentLobbySettings;
  network.onLobbySettings = (settings) => {
    applyLobbySettingsFromHost(settings);
  };
}
