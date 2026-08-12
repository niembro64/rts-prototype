import type { Ref } from 'vue';
import type {
  LobbyPlayer,
  LobbySettings,
} from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';
import type { BattleHandoff, NetworkCommunicationEvent } from '../types/network';
import { bindGameCanvasNetworkCallbacks } from './gameCanvasNetworkCallbacks';
import {
  startRealBattleWithPlayers,
  type StartRealBattleWithPlayersOptions,
} from './gameCanvasRealBattleStart';

type ResolvePlayerName = {
  (playerId: PlayerId): string;
  (playerId: PlayerId, fallback: null): string | null;
};

type UseGameCanvasRealBattleHandoffOptions = Omit<
  StartRealBattleWithPlayersOptions,
  'lookupPlayerName' | 'battleHandoff'
> & {
  networkNotice: Ref<string | null>;
  lobbyError: Ref<string | null>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  roomCode: Ref<string>;
  localUsername: Ref<string>;
  resolvePlayerName: ResolvePlayerName;
  upsertLobbyPlayer: (player: LobbyPlayer) => void;
  applyLobbySettingsFromHost: (
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ) => void;
  currentLobbySettings: () => LobbySettings;
  onCommunication: (event: NetworkCommunicationEvent) => void;
};

export function useGameCanvasRealBattleHandoff({
  containerRef,
  showLobby,
  gameStarted,
  battleLoading,
  activePlayer,
  localPlayerId,
  networkRole,
  playerClientEnabled,
  cameraFovDegrees,
  localIpAddress,
  hasServer,
  networkNotice,
  lobbyError,
  lobbyPlayers,
  roomCode,
  localUsername,
  network,
  lifecycle,
  foregroundGame,
  foregroundSceneBinding,
  stopBackgroundBattle,
  waitForBackgroundBattleIdle,
  getCurrentServer,
  setCurrentServer,
  setActiveConnection,
  setBattleStartTime,
  resolvePlayerName,
  upsertLobbyPlayer,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onCommunication,
  onLoadingProgress,
  bindSceneUi,
}: UseGameCanvasRealBattleHandoffOptions) {
  async function startGameWithPlayers(
    playerIds: PlayerId[],
    aiPlayerIds?: PlayerId[],
    handoff?: BattleHandoff,
  ): Promise<void> {
    await startRealBattleWithPlayers(playerIds, aiPlayerIds, {
      containerRef,
      showLobby,
      gameStarted,
      battleLoading,
      activePlayer,
      localPlayerId,
      networkRole,
      playerClientEnabled,
      cameraFovDegrees,
      localIpAddress,
      hasServer,
      network,
      lifecycle,
      foregroundGame,
      foregroundSceneBinding,
      stopBackgroundBattle,
      waitForBackgroundBattleIdle,
      getCurrentServer,
      setCurrentServer,
      setActiveConnection,
      setBattleStartTime,
      lookupPlayerName: (pid) => resolvePlayerName(pid, null),
      battleHandoff: handoff,
      onLoadingProgress,
      bindSceneUi,
    });
  }

  function setupNetworkCallbacks(): void {
    bindGameCanvasNetworkCallbacks({
      network,
      networkNotice,
      lobbyError,
      lobbyPlayers,
      roomCode,
      localPlayerId,
      activePlayer,
      localUsername,
      gameStarted,
      resolvePlayerName: (playerId) => resolvePlayerName(playerId),
      upsertLobbyPlayer,
      applyLobbySettingsFromHost,
      currentLobbySettings,
      onCommunication,
      startGameWithPlayers,
    });
  }

  return {
    setupNetworkCallbacks,
    startGameWithPlayers,
  };
}
