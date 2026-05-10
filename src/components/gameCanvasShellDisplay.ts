import { computed, type Ref } from 'vue';
import type { BattleMode } from '../battleBarConfig';
import { BAR_THEMES, barVars } from '../barThemes';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import type {
  LobbyPlayer,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';

type UseGameCanvasShellDisplayOptions = {
  isMobile: boolean;
  showLobby: Ref<boolean>;
  spectateMode: Ref<boolean>;
  gameStarted: Ref<boolean>;
  roomCode: Ref<string>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  localPlayerId: Ref<PlayerId>;
  networkRole: Ref<NetworkRole | null>;
  networkNotice: Ref<string | null>;
  hasServer: Ref<boolean>;
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
};

export function useGameCanvasShellDisplay({
  isMobile,
  showLobby,
  spectateMode,
  gameStarted,
  roomCode,
  lobbyPlayers,
  localPlayerId,
  networkRole,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
}: UseGameCanvasShellDisplayOptions) {
  const lobbyPlayerCount = computed(() => lobbyPlayers.value.length);

  const networkStatus = computed(() => {
    if (networkRole.value === 'host') {
      const players = lobbyPlayerCount.value > 0 ? ` ${lobbyPlayerCount.value}P` : '';
      return roomCode.value ? `HOST ${roomCode.value}${players}` : `HOST${players}`;
    }
    if (networkRole.value === 'client') {
      return roomCode.value ? `CLIENT ${roomCode.value}` : 'CLIENT';
    }
    if (gameStarted.value) return 'OFFLINE';
    return networkNotice.value ? 'NETWORK' : '';
  });

  const currentBattleMode = computed<BattleMode>(
    () => (gameStarted.value || roomCode.value !== '' ? 'real' : 'demo'),
  );

  const localLobbyPlayer = computed(
    () => lobbyPlayers.value.find((p) => p.playerId === localPlayerId.value) ?? null,
  );

  const showPlayerToggle = computed(() => {
    if (!gameStarted.value) return true;
    return networkRole.value === null ||
      (networkRole.value === 'host' && lobbyPlayerCount.value === 1);
  });

  const lobbyModalVisible = computed(
    () => !isMobile && showLobby.value && !spectateMode.value,
  );

  const showServerControls = computed(
    () => hasServer.value || serverMetaFromSnapshot.value !== null,
  );

  const serverBarReadonly = computed(() => !hasServer.value);

  const battleBarVars = computed(() =>
    barVars(serverBarReadonly.value
      ? BAR_THEMES.disabled
      : gameStarted.value ? BAR_THEMES.realBattle : BAR_THEMES.battle),
  );
  const serverBarVars = computed(() =>
    barVars(serverBarReadonly.value ? BAR_THEMES.disabled : BAR_THEMES.server),
  );
  const clientBarVars = computed(() => barVars(BAR_THEMES.client));

  const battleLabel = computed(() => gameStarted.value ? 'REAL BATTLE' : 'DEMO BATTLE');
  const battleLoadingTitle = computed(() =>
    networkRole.value === 'client' ? 'Receiving Terrain' : 'Generating Terrain',
  );
  const battleLoadingDetail = computed(() =>
    networkRole.value === 'host'
      ? 'Waiting for every player to install the authoritative map.'
      : 'Installing the authoritative map before simulation starts.',
  );

  return {
    lobbyPlayerCount,
    networkStatus,
    currentBattleMode,
    localLobbyPlayer,
    showPlayerToggle,
    lobbyModalVisible,
    showServerControls,
    serverBarReadonly,
    battleBarVars,
    serverBarVars,
    clientBarVars,
    battleLabel,
    battleLoadingTitle,
    battleLoadingDetail,
  };
}
