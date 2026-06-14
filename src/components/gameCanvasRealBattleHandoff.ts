import type { Ref } from 'vue';
import type { GameScene } from '../game/createGame';
import type {
  LobbyPlayer,
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { GameConnection } from '../game/server/GameConnection';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { CameraFovDegrees } from '../types/client';
import type { BattleHandoff, NetworkCommunicationEvent } from '../types/network';
import { bindGameCanvasNetworkCallbacks } from './gameCanvasNetworkCallbacks';
import type { GameCanvasForegroundGame } from './gameCanvasForegroundGame';
import type { GameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import type { GameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';
import { startRealBattleWithPlayers } from './gameCanvasRealBattleStart';

type ResolvePlayerName = {
  (playerId: PlayerId): string;
  (playerId: PlayerId, fallback: null): string | null;
};

type UseGameCanvasRealBattleHandoffOptions = {
  containerRef: Ref<HTMLDivElement | null>;
  showLobby: Ref<boolean>;
  gameStarted: Ref<boolean>;
  battleLoading: Ref<boolean>;
  activePlayer: Ref<PlayerId>;
  localPlayerId: Ref<PlayerId>;
  networkRole: Ref<NetworkRole | null>;
  playerClientEnabled: Ref<boolean>;
  cameraFovDegrees: Ref<CameraFovDegrees>;
  localIpAddress: Ref<string>;
  hasServer: Ref<boolean>;
  networkNotice: Ref<string | null>;
  lobbyError: Ref<string | null>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  roomCode: Ref<string>;
  localUsername: Ref<string>;
  network: NetworkManager;
  lifecycle: GameCanvasRealBattleLifecycle;
  foregroundGame: GameCanvasForegroundGame;
  foregroundSceneBinding: GameCanvasForegroundSceneBinding;
  stopBackgroundBattle: () => void;
  waitForBackgroundBattleIdle: () => Promise<void>;
  getCurrentServer: () => GameServer | null;
  setCurrentServer: (server: GameServer | null) => void;
  setActiveConnection: (connection: GameConnection | null) => void;
  setBattleStartTime: (time: number) => void;
  resolvePlayerName: ResolvePlayerName;
  upsertLobbyPlayer: (player: LobbyPlayer) => void;
  applyLobbySettingsFromHost: (
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ) => void;
  currentLobbySettings: () => LobbySettings;
  onCommunication: (event: NetworkCommunicationEvent) => void;
  onLoadingProgress: (progress: number, phase?: string) => void;
  bindSceneUi: (scene: GameScene) => void;
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
      getCurrentServer,
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
