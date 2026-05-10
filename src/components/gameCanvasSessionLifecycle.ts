import { nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type {
  LobbyPlayer,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { GameConnection } from '../game/server/GameConnection';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { GameCanvasForegroundGame } from './gameCanvasForegroundGame';
import type { GameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import type { GameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';

type UseGameCanvasSessionLifecycleOptions = {
  gameOverWinner: Ref<PlayerId | null>;
  battleLoading: Ref<boolean>;
  gameStarted: Ref<boolean>;
  showLobby: Ref<boolean>;
  networkRole: Ref<NetworkRole | null>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  roomCode: Ref<string>;
  lobbyError: Ref<string | null>;
  networkNotice: Ref<string | null>;
  hasServer: Ref<boolean>;
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  network: NetworkManager;
  lifecycle: GameCanvasRealBattleLifecycle;
  foregroundSceneBinding: GameCanvasForegroundSceneBinding;
  foregroundGame: GameCanvasForegroundGame;
  getCurrentServer: () => GameServer | null;
  setCurrentServer: (server: GameServer | null) => void;
  setActiveConnection: (connection: GameConnection | null) => void;
  setBattleStartTime: (time: number) => void;
  startBackgroundBattle: () => void | Promise<void>;
  stopBackgroundBattle: () => void;
};

export function useGameCanvasSessionLifecycle({
  gameOverWinner,
  battleLoading,
  gameStarted,
  showLobby,
  networkRole,
  lobbyPlayers,
  roomCode,
  lobbyError,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
  network,
  lifecycle,
  foregroundSceneBinding,
  foregroundGame,
  getCurrentServer,
  setCurrentServer,
  setActiveConnection,
  setBattleStartTime,
  startBackgroundBattle,
  stopBackgroundBattle,
}: UseGameCanvasSessionLifecycleOptions) {
  function stopCurrentServer(): void {
    const currentServer = getCurrentServer();
    if (!currentServer) return;
    lifecycle.clearSnapshotListeners(currentServer);
    currentServer.stop();
    setCurrentServer(null);
  }

  function resetSessionState(): void {
    gameStarted.value = false;
    showLobby.value = true;
    network.disconnect();
    networkRole.value = null;
    lobbyPlayers.value = [];
    roomCode.value = '';
    lobbyError.value = null;
    networkNotice.value = null;
    setActiveConnection(null);
    hasServer.value = false;
    serverMetaFromSnapshot.value = null;
  }

  function restartGame(): void {
    gameOverWinner.value = null;
    setBattleStartTime(0);
    battleLoading.value = false;
    lifecycle.clearTimers();
    foregroundSceneBinding.clear();
    resetSessionState();
    stopCurrentServer();
    foregroundGame.destroy();

    nextTick(() => {
      void startBackgroundBattle();
    });
  }

  onMounted(() => {
    nextTick(() => {
      void startBackgroundBattle();
    });
  });

  onUnmounted(() => {
    lifecycle.clearTimers();
    foregroundSceneBinding.clear();
    stopCurrentServer();
    network.disconnect();
    stopBackgroundBattle();
    foregroundGame.destroy();
  });

  return {
    restartGame,
  };
}
