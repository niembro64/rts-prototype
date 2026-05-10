import { ref, type ComputedRef, type Ref } from 'vue';
import type { BattleMode } from '../battleBarConfig';
import type { LobbyPlayer, NetworkManager } from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';
import {
  getDefaultPlayerName,
  getInitialLocalUsername,
  saveUsername,
} from '@/playerNamesConfig';

type UseGameCanvasLobbyRosterOptions = {
  network: NetworkManager;
  currentBattleMode: ComputedRef<BattleMode>;
  lobbyPlayers: Ref<LobbyPlayer[]>;
  localPlayerId: Ref<PlayerId>;
};

export function useGameCanvasLobbyRoster({
  network,
  currentBattleMode,
  lobbyPlayers,
  localPlayerId,
}: UseGameCanvasLobbyRosterOptions) {
  const localUsername = ref<string>(getInitialLocalUsername());

  function resolvePlayerName(pid: PlayerId): string;
  function resolvePlayerName(pid: PlayerId, fallback: null): string | null;
  function resolvePlayerName(pid: PlayerId, fallback?: string | null): string | null {
    const roster = lobbyPlayers.value.find((p) => p.playerId === pid);
    if (roster && roster.name && roster.name.length > 0) return roster.name;
    if (pid === localPlayerId.value) return localUsername.value;
    return fallback === undefined ? getDefaultPlayerName(pid) : fallback;
  }

  function upsertLobbyPlayer(player: LobbyPlayer): void {
    const idx = lobbyPlayers.value.findIndex((p) => p.playerId === player.playerId);
    if (idx === -1) {
      lobbyPlayers.value = [...lobbyPlayers.value, { ...player }];
      return;
    }
    lobbyPlayers.value = lobbyPlayers.value.map((existing, i) => {
      if (i !== idx) return existing;
      return {
        ...existing,
        playerId: player.playerId,
        isHost: player.isHost,
        name: player.name || existing.name,
        ipAddress: player.ipAddress ?? existing.ipAddress,
        location: player.location ?? existing.location,
        timezone: player.timezone ?? existing.timezone,
        localTime: player.localTime ?? existing.localTime,
      };
    });
  }

  function onPlayerNameChange(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    localUsername.value = trimmed;
    saveUsername(trimmed);
    if (currentBattleMode.value === 'real') {
      network.setLocalPlayerName(trimmed);
    }
  }

  return {
    localUsername,
    resolvePlayerName,
    upsertLobbyPlayer,
    onPlayerNameChange,
  };
}
