import type { Ref } from 'vue';
import type {
  LobbyMember,
  LobbySettings,
} from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';
import type { BattleHandoff, NetworkCommunicationEvent } from '../types/network';
import { bindGameCanvasNetworkCallbacks } from './gameCanvasNetworkCallbacks';
import {
  startRealBattleWithPlayers,
  type StartRealBattleWithPlayersOptions,
} from './gameCanvasRealBattleStart';
import type { RealBattleResumeContext } from './gameCanvasRealBattleStartup';

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
  lobbyMembers: Ref<LobbyMember[]>;
  roomCode: Ref<string>;
  localUsername: Ref<string>;
  resolvePlayerName: ResolvePlayerName;
  resolveMemberName: (memberId: number) => string;
  /** A SEATED player stopped answering; the match should hold for it. */
  onSeatedPeerSilent: (playerId: PlayerId) => void;
  /** A held seat reconnected. It still has to replay its way back. */
  onSeatedPeerReturned: (playerId: PlayerId) => void;
  applyLobbySettingsFromHost: (
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ) => void;
  currentLobbySettings: () => LobbySettings;
  onCommunication: (event: NetworkCommunicationEvent) => void;
  /** Eject this client — the host has left and the session is over. */
  onHostLeft: () => void;
};

export function useGameCanvasRealBattleHandoff({
  containerRef,
  showLobby,
  gameStarted,
  battleLoading,
  activePlayer,
  localPlayerId,
  localRole,
  networkRole,
  playerClientEnabled,
  cameraFovDegrees,
  localIpAddress,
  hasServer,
  networkNotice,
  lobbyError,
  lobbyMembers,
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
  resolveMemberName,
  onSeatedPeerSilent,
  onSeatedPeerReturned,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onCommunication,
  onHostLeft,
  onLoadingProgress,
  onPeerFrameReport,
  onFlowControlChange,
  onCatchUpProgress,
  registerSilentPlayer,
  bindSceneUi,
}: UseGameCanvasRealBattleHandoffOptions) {
  async function startGameWithPlayers(
    playerIds: PlayerId[],
    aiPlayerIds?: PlayerId[],
    handoff?: BattleHandoff,
    resume?: RealBattleResumeContext,
  ): Promise<void> {
    await startRealBattleWithPlayers(playerIds, aiPlayerIds, {
      containerRef,
      showLobby,
      gameStarted,
      battleLoading,
      activePlayer,
      localPlayerId,
      localRole,
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
      resume,
      onCatchUpProgress,
      onLoadingProgress,
      onPeerFrameReport,
      onFlowControlChange,
      registerSilentPlayer,
      bindSceneUi,
    });
  }

  function setupNetworkCallbacks(): void {
    bindGameCanvasNetworkCallbacks({
      network,
      networkNotice,
      lobbyError,
      lobbyMembers,
      roomCode,
      localPlayerId,
      localRole,
      activePlayer,
      localUsername,
      gameStarted,
      resolveMemberName,
      onSeatedPeerSilent,
      onSeatedPeerReturned,
      applyLobbySettingsFromHost,
      currentLobbySettings,
      onCommunication,
      startGameWithPlayers,
      onHostLeft,
    });
  }

  return {
    setupNetworkCallbacks,
    startGameWithPlayers,
  };
}
