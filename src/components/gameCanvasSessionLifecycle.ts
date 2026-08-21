import { nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type {
  LobbyMember,
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
  lobbyMembers: Ref<LobbyMember[]>;
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
  /** Forget everything about watching: the view target, the pause banner, and
   *  the catch-up overlay all describe a match that no longer exists. */
  resetSpectatorState: () => void;
};

export function useGameCanvasSessionLifecycle({
  gameOverWinner,
  battleLoading,
  gameStarted,
  showLobby,
  networkRole,
  lobbyMembers,
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
  resetSpectatorState,
}: UseGameCanvasSessionLifecycleOptions) {
  function stopCurrentServer(): void {
    const currentServer = getCurrentServer();
    if (!currentServer) return;
    currentServer.stop();
    setCurrentServer(null);
  }

  function resetSessionState(): void {
    gameStarted.value = false;
    showLobby.value = true;
    network.disconnect();
    networkRole.value = null;
    lobbyMembers.value = [];
    resetSpectatorState();
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

  /**
   * End the battle but keep the session: the host returned the room to its
   * seating screen. Everything `restartGame` tears down EXCEPT the network —
   * room code, roster, role and seat all survive, so the lobby modal reopens
   * over the same session and the preview battle restarts behind it (still in
   * 'real' mode, because the room code is still set).
   */
  function returnToLobby(): void {
    gameOverWinner.value = null;
    setBattleStartTime(0);
    battleLoading.value = false;
    lifecycle.clearTimers();
    foregroundSceneBinding.clear();
    gameStarted.value = false;
    showLobby.value = true;
    // The view target, pause banner and replay bar describe the match that
    // just ended; the caller restores the surviving seat/role on top.
    resetSpectatorState();
    setActiveConnection(null);
    hasServer.value = false;
    serverMetaFromSnapshot.value = null;
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
    musicPlayer.destroy();
    audioManager.destroy();
  });

  return {
    restartGame,
    returnToLobby,
  };
}
