import type { Ref } from 'vue';
import { sendAppSurface } from '../appSurfaceMachine';
import { resetRealBattleSettings } from '../battleBarConfig';
import type {
  LobbyMember,
  LobbyMemberRole,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';

type GameCanvasLobbyActions = {
  handleHost(): Promise<void>;
  handleJoin(code: string): Promise<void>;
  handleLobbyStart(): void;
  handleLobbyCancel(): void;
  handleHostLocal(): Promise<void>;
};

type GameCanvasLobbyActionsOptions = {
  network: NetworkManager;
  isConnecting: Ref<boolean>;
  lobbyError: Ref<string | null>;
  networkNotice: Ref<string | null>;
  roomCode: Ref<string>;
  isHost: Ref<boolean>;
  networkRole: Ref<NetworkRole | null>;
  localPlayerId: Ref<PlayerId>;
  localRole: Ref<LobbyMemberRole>;
  lobbyMembers: Ref<LobbyMember[]>;
  battleLoading: Ref<boolean>;
  setupNetworkCallbacks: () => void;
  reportLocalPlayerInfo: () => void;
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
  localRole,
  lobbyMembers,
  battleLoading,
  setupNetworkCallbacks,
  reportLocalPlayerInfo,
}: GameCanvasLobbyActionsOptions): GameCanvasLobbyActions {
  let lobbyActionGeneration = 0;

  function isCurrentLobbyAction(generation: number): boolean {
    return lobbyActionGeneration === generation;
  }

  async function handleHost(): Promise<void> {
    resetRealBattleSettings();
    const generation = ++lobbyActionGeneration;
    try {
      isConnecting.value = true;
      lobbyError.value = null;
      networkNotice.value = null;

      await network.hostGame();
      if (!isCurrentLobbyAction(generation)) return;
      roomCode.value = network.getRoomCode();
      isHost.value = true;
      networkRole.value = 'host';
      // The host creates the lobby, so it is seated from the first moment —
      // the one member nobody has to put on a team. Set here rather than
      // waited for: the seat assignment fires inside hostGame(), before the
      // callbacks below exist to hear it.
      localPlayerId.value = 1;
      localRole.value = 'player';
      lobbyMembers.value = network.getMembers();

      setupNetworkCallbacks();
      // Eagerly report available local info; the async IP lookup can
      // call through again later to fill any missing columns.
      reportLocalPlayerInfo();
      // The public listing was first published the moment signaling opened,
      // which is before the lobby-settings callback above existed — so it went
      // out without a map size. Republish now that it can be read, instead of
      // leaving the directory row incomplete until the next heartbeat.
      network.refreshLobbyListing();

      // Hosting succeeded: the player is now in the game room's seating
      // screen, and the machine records it.
      sendAppSurface('enterLobby');
      isConnecting.value = false;
    } catch (err) {
      if (!isCurrentLobbyAction(generation)) return;
      lobbyError.value = (err as Error).message || 'Failed to host game';
      networkNotice.value = lobbyError.value;
      isConnecting.value = false;
    }
  }

  async function handleJoin(code: string): Promise<void> {
    resetRealBattleSettings();
    const generation = ++lobbyActionGeneration;
    try {
      isConnecting.value = true;
      lobbyError.value = null;
      networkNotice.value = null;

      // Bind callbacks before joining; the host sends the session assignment
      // as soon as the PeerJS connection opens.
      networkRole.value = 'client';
      // A joiner is a watcher until the host says otherwise; the assignment
      // that arrives on admission will say which.
      localRole.value = 'spectator';
      setupNetworkCallbacks();

      await network.joinGame(code);
      if (!isCurrentLobbyAction(generation)) return;
      roomCode.value = network.getRoomCode();
      isHost.value = false;

      // Same eager-report rule as host: timezone is immediate, IP/location
      // may still arrive later and overwrite the partial report.
      reportLocalPlayerInfo();

      // Joining succeeded: seating screen. Joining a RUNNING match may have
      // already jumped straight to the battle via the resume grant, in which
      // case this is refused by the table — which is correct.
      sendAppSurface('enterLobby');
      isConnecting.value = false;
    } catch (err) {
      if (!isCurrentLobbyAction(generation)) return;
      lobbyError.value = (err as Error).message || 'Failed to join game';
      networkNotice.value = lobbyError.value;
      isConnecting.value = false;
    }
  }

  function handleLobbyStart(): void {
    network.startGame();
  }

  function handleLobbyCancel(): void {
    lobbyActionGeneration++;
    // Cancel is the seating screen's own way home. Refused (harmlessly) when
    // the player was never in one — a cancel racing a failed host attempt.
    sendAppSurface('leaveLobby');
    battleLoading.value = false;
    network.disconnect();
    networkRole.value = null;
    roomCode.value = '';
    isHost.value = false;
    lobbyMembers.value = [];
    localRole.value = 'spectator';
    lobbyError.value = null;
    networkNotice.value = null;
    isConnecting.value = false;
  }

  /** A LOCAL skirmish: the same seating screen as hosting, with the session
   *  sealed — no listing, no joiners, no signaling, no internet needed. The
   *  host adds bots and presses Start. This replaces the old dead "offline"
   *  path, which no button reached and whose AI roster the lockstep policy
   *  would have refused anyway. */
  async function handleHostLocal(): Promise<void> {
    resetRealBattleSettings();
    const generation = ++lobbyActionGeneration;
    try {
      isConnecting.value = true;
      lobbyError.value = null;
      networkNotice.value = null;

      await network.hostGame({ visibility: 'local' });
      if (!isCurrentLobbyAction(generation)) return;
      roomCode.value = network.getRoomCode();
      isHost.value = true;
      networkRole.value = 'host';
      localPlayerId.value = 1;
      localRole.value = 'player';
      lobbyMembers.value = network.getMembers();

      setupNetworkCallbacks();
      reportLocalPlayerInfo();

      sendAppSurface('enterLobby');
      isConnecting.value = false;
    } catch (err) {
      if (!isCurrentLobbyAction(generation)) return;
      lobbyError.value = (err as Error).message || 'Failed to start a local skirmish';
      networkNotice.value = lobbyError.value;
      isConnecting.value = false;
    }
  }

  return {
    handleHost,
    handleJoin,
    handleLobbyStart,
    handleLobbyCancel,
    handleHostLocal,
  };
}
