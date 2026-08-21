import type { Ref } from 'vue';
import type {
  BattleHandoff,
  NetworkResumeContext,
  LobbyMember,
  LobbyMemberRole,
  LobbySettings,
  NetworkManager,
} from '../game/network/NetworkManager';
import type { LobbyBotSeat, NetworkCommunicationEvent } from '../types/network';
import type { PlayerId } from '../game/sim/types';

type GameCanvasNetworkCallbackOptions = {
  network: NetworkManager;
  networkNotice: Ref<string | null>;
  lobbyError: Ref<string | null>;
  lobbyMembers: Ref<LobbyMember[]>;
  lobbyBotSeats: Ref<LobbyBotSeat[]>;
  roomCode: Ref<string>;
  localPlayerId: Ref<PlayerId>;
  localRole: Ref<LobbyMemberRole>;
  activePlayer: Ref<PlayerId>;
  localUsername: Ref<string>;
  gameStarted: Ref<boolean>;
  resolveMemberName: (memberId: number) => string;
  applyLobbySettingsFromHost: (
    settings: LobbySettings,
    options?: { restartPreview?: boolean },
  ) => void;
  currentLobbySettings: () => LobbySettings;
  onCommunication: (event: NetworkCommunicationEvent) => void;
  startGameWithPlayers: (
    playerIds: PlayerId[],
    aiPlayerIds?: PlayerId[],
    handoff?: BattleHandoff,
    resume?: NetworkResumeContext,
  ) => void | Promise<void>;
  /** The host is gone and this client cannot stay in the session. */
  onHostLeft: () => void;
  /** A SEATED player stopped answering. Host-side only. */
  onSeatedPeerSilent: (playerId: PlayerId) => void;
  /** A held seat reconnected and reclaimed its army. Host-side only. */
  onSeatedPeerReturned: (playerId: PlayerId) => void;
};

export function bindGameCanvasNetworkCallbacks({
  network,
  networkNotice,
  lobbyError,
  lobbyMembers,
  lobbyBotSeats,
  roomCode,
  localPlayerId,
  localRole,
  activePlayer,
  localUsername,
  gameStarted,
  resolveMemberName,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onCommunication,
  startGameWithPlayers,
  onHostLeft,
  onSeatedPeerSilent,
  onSeatedPeerReturned,
}: GameCanvasNetworkCallbackOptions): void {
  // One callback, one whole list. There is no join/leave/info trio to apply
  // in the right order, which is what used to let two clients disagree about
  // where the same player was sitting.
  network.onRoster = (members, botSeats) => {
    const previousIds = new Set(lobbyMembers.value.map((member) => member.memberId));
    lobbyMembers.value = members.map((member) => ({ ...member }));
    lobbyBotSeats.value = botSeats.map((bot) => ({ ...bot }));
    if (members.length > 0) networkNotice.value = null;

    const self = members.find((member) => member.memberId === network.getLocalMemberId());
    if (self !== undefined && self.name) localUsername.value = self.name;

    if (!gameStarted.value) return;
    for (const previousId of previousIds) {
      if (members.some((member) => member.memberId === previousId)) continue;
      networkNotice.value = `${resolveMemberName(previousId)} disconnected`;
    }
  };

  // Distinct from a member leaving: any other member going is a roster change
  // the session survives, but losing the host ends it for everyone.
  network.onHostLeft = () => {
    onHostLeft();
  };

  network.onSeatAssignment = (playerId, role) => {
    // Everyone joins as a watcher and only the host seats anybody, so a
    // joiner has to be told which of those just happened — otherwise landing
    // on the bench reads as the lobby being broken.
    networkNotice.value = role === 'spectator'
      ? gameStarted.value
        ? 'Watching this battle — it is already under way, so there are no seats to take.'
        : 'Watching — the host decides who plays.'
      : null;
    localRole.value = role;
    // A watcher keeps whatever seat it was viewing; only a real seat moves
    // the view, because for a player the two are the same thing.
    if (playerId !== undefined) {
      localPlayerId.value = playerId;
      activePlayer.value = playerId;
    }
  };

  network.onSeatedPeerSilent = (playerId) => {
    onSeatedPeerSilent(playerId);
  };

  network.onSeatedPeerReturned = (playerId) => {
    onSeatedPeerReturned(playerId);
  };

  // `resume` is present only when joining a match ALREADY IN PROGRESS. The
  // handoff is the same one the frame-0 peers received either way, so this is
  // one start path rather than two.
  network.onGameStart = (handoff: BattleHandoff, resume) => {
    networkNotice.value = null;
    roomCode.value = handoff.roomCode;
    if (handoff.settings) {
      applyLobbySettingsFromHost(handoff.settings, { restartPreview: false });
    }
    void startGameWithPlayers(handoff.playerIds, undefined, handoff, resume);
  };

  network.onError = (error: string) => {
    lobbyError.value = error;
    networkNotice.value = error;
  };

  network.getLobbySettings = currentLobbySettings;
  network.onLobbySettings = (settings) => {
    applyLobbySettingsFromHost(settings);
  };

  network.onCommunication = (event) => {
    onCommunication(event);
  };
}
