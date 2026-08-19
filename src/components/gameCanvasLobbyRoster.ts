import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { BattleMode } from '../battleBarConfig';
import type { LobbyMember, LobbyPlayer, NetworkManager } from '../game/network/NetworkManager';
import type { PlayerId } from '../game/sim/types';
import {
  getDefaultPlayerName,
  getInitialLocalUsername,
  saveUsername,
} from '@/playerNamesConfig';

type UseGameCanvasLobbyRosterOptions = {
  network: NetworkManager;
  currentBattleMode: ComputedRef<BattleMode>;
  /** Everyone attached, watchers included. The one list the UI renders. */
  lobbyMembers: Ref<LobbyMember[]>;
  localPlayerId: Ref<PlayerId>;
};

export function useGameCanvasLobbyRoster({
  network,
  currentBattleMode,
  lobbyMembers,
  localPlayerId,
}: UseGameCanvasLobbyRosterOptions) {
  const localUsername = ref<string>(getInitialLocalUsername());

  /**
   * The seated members, as the match sees them.
   *
   * Derived rather than stored: a second list that has to be kept in step
   * with the member list is a second thing to get wrong, and the seated set
   * is exactly "members with a seat".
   */
  const lobbyPlayers = computed<LobbyPlayer[]>(() => {
    const out: LobbyPlayer[] = [];
    for (const member of lobbyMembers.value) {
      if (member.playerId === undefined) continue;
      out.push({
        playerId: member.playerId,
        name: member.name,
        isHost: member.isHost,
        allyTeamId: member.allyTeamId ?? 1,
        ipAddress: member.ipAddress,
        location: member.location,
        timezone: member.timezone,
        localTime: member.localTime,
      });
    }
    out.sort((a, b) => a.playerId - b.playerId);
    return out;
  });

  /** Members holding no seat, in join order. */
  const lobbySpectators = computed<LobbyMember[]>(() =>
    lobbyMembers.value.filter((member) => member.playerId === undefined),
  );

  function resolvePlayerName(pid: PlayerId): string;
  function resolvePlayerName(pid: PlayerId, fallback: null): string | null;
  function resolvePlayerName(pid: PlayerId, fallback?: string | null): string | null {
    const seated = lobbyPlayers.value.find((p) => p.playerId === pid);
    if (seated && seated.name && seated.name.length > 0) return seated.name;
    if (pid === localPlayerId.value) return localUsername.value;
    return fallback === undefined ? getDefaultPlayerName(pid) : fallback;
  }

  /** A member's name, seated or not — chat and the watcher list need one. */
  function resolveMemberName(memberId: number): string {
    const member = lobbyMembers.value.find((m) => m.memberId === memberId);
    if (member && member.name.length > 0) return member.name;
    if (memberId === network.getLocalMemberId()) return localUsername.value;
    return getDefaultPlayerName(memberId as PlayerId);
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
    lobbyPlayers,
    lobbySpectators,
    resolvePlayerName,
    resolveMemberName,
    onPlayerNameChange,
  };
}
