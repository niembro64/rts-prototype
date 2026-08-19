import {
  getDefaultPlayerName,
  getInitialLocalUsername,
  MAX_NAME_LENGTH,
} from '@/playerNamesConfig';
import type { PlayerId } from '../sim/types';
import { FIRST_ALLY_TEAM_ID } from '../sim/teamRoster';
import { formatBrowserClockTime, getBrowserTimezone } from '../browserLocale';
import type {
  LobbyPlayer,
  LobbyPlayerInfoPayload,
  BattleHandoff,
  NetworkMessage,
} from './NetworkTypes';

type PlayerMergeResult = {
  player: LobbyPlayer;
  joined: boolean;
};

export type PlayerInfoResult = {
  player: LobbyPlayer | null;
  changed: boolean;
};

export function createLobbyPlayer(
  playerId: PlayerId,
  name: string,
  isHost: boolean,
  allyTeamId: number = FIRST_ALLY_TEAM_ID,
): LobbyPlayer {
  return {
    playerId,
    name,
    isHost,
    allyTeamId,
    ipAddress: undefined,
    location: undefined,
    timezone: undefined,
    localTime: undefined,
  };
}

export class NetworkLobbyRoster {
  private players: Map<PlayerId, LobbyPlayer> = new Map();

  clear(): void {
    this.players.clear();
  }

  delete(playerId: PlayerId): void {
    this.players.delete(playerId);
  }

  get(playerId: PlayerId): LobbyPlayer | undefined {
    return this.players.get(playerId);
  }

  get size(): number {
    return this.players.size;
  }

  values(): IterableIterator<LobbyPlayer> {
    return this.players.values();
  }

  asReadonlyMap(): ReadonlyMap<PlayerId, LobbyPlayer> {
    return this.players;
  }

  seedHost(playerId: PlayerId): LobbyPlayer {
    const player = createLobbyPlayer(playerId, getInitialLocalUsername(), true);
    this.players.set(playerId, player);
    return player;
  }

  set(player: LobbyPlayer): LobbyPlayer {
    const copy = this.copy(player);
    this.players.set(copy.playerId, copy);
    return copy;
  }

  applyBattleHandoff(handoff: BattleHandoff): void {
    for (const player of handoff.players) {
      this.set(player);
    }
  }

  merge(player: LobbyPlayer): PlayerMergeResult {
    const existing = this.players.get(player.playerId);
    if (!existing) {
      return {
        player: this.set(player),
        joined: true,
      };
    }

    existing.isHost = player.isHost;
    // The host owns side assignment. An incoming value replaces ours; an
    // absent one leaves the seat where the host last put it, so a client
    // announcing itself cannot knock itself back to a default team.
    if (Number.isFinite(player.allyTeamId) && player.allyTeamId > 0) {
      existing.allyTeamId = player.allyTeamId;
    }
    this.applyPlayerInfo(existing, player);
    return {
      player: existing,
      joined: false,
    };
  }

  applyPlayerInfo(player: LobbyPlayer, info: LobbyPlayerInfoPayload): boolean {
    let changed = false;
    const setIfChanged = <K extends keyof LobbyPlayer>(key: K, value: LobbyPlayer[K] | undefined): void => {
      if (value === undefined || player[key] === value) return;
      player[key] = value;
      changed = true;
    };

    if (
      info.allyTeamId !== undefined &&
      Number.isFinite(info.allyTeamId) &&
      info.allyTeamId >= FIRST_ALLY_TEAM_ID &&
      player.allyTeamId !== Math.floor(info.allyTeamId)
    ) {
      player.allyTeamId = Math.floor(info.allyTeamId);
      changed = true;
    }
    setIfChanged('ipAddress', info.ipAddress);
    setIfChanged('location', info.location);
    setIfChanged('timezone', info.timezone);
    setIfChanged('localTime', info.localTime);
    if (info.name !== undefined && info.name.length > 0) {
      const trimmed = info.name.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed.length > 0 && player.name !== trimmed) {
        player.name = trimmed;
        changed = true;
      }
    }
    return changed;
  }

  /** Apply info a CLIENT reported about ITSELF, minus anything the host owns.
   *
   *  `playerInfo` is a client describing its own name, IP and timezone, but it
   *  shares a payload type with the host's outbound update — which also
   *  carries the seat's SIDE. Side assignment belongs to the host alone, so it
   *  is stripped on the way in. Living here rather than at the call sites
   *  means the rule is stated once and cannot be forgotten by the next
   *  inbound path (it already arrives on both `playerInfo` and `heartbeat`). */
  applyClientReportedInfo(playerId: PlayerId, info: LobbyPlayerInfoPayload): PlayerInfoResult {
    return this.applyInfo(playerId, { ...info, allyTeamId: undefined });
  }

  applyInfo(playerId: PlayerId, info: LobbyPlayerInfoPayload): PlayerInfoResult {
    const player = this.players.get(playerId);
    if (!player) return { player: null, changed: false };
    return {
      player,
      changed: this.applyPlayerInfo(player, info),
    };
  }

  refreshLocalPlayerInfo(localPlayerId: PlayerId): PlayerInfoResult {
    return this.applyInfo(localPlayerId, this.buildLocalPlayerInfo(localPlayerId));
  }

  buildLocalPlayerInfo(localPlayerId: PlayerId): LobbyPlayerInfoPayload {
    const self = this.players.get(localPlayerId);
    const timezone = self !== undefined && self.timezone
      ? self.timezone
      : getBrowserTimezone();
    return {
      name: self !== undefined ? self.name : getInitialLocalUsername(),
      ipAddress: self !== undefined ? self.ipAddress : undefined,
      location: self !== undefined ? self.location : undefined,
      timezone: timezone || undefined,
      localTime: timezone ? formatBrowserClockTime(timezone) : undefined,
    };
  }

  buildReportedLocalPlayerInfo(
    ipAddress: string | undefined,
    location: string | undefined,
    timezone: string | undefined,
  ): LobbyPlayerInfoPayload {
    const resolvedTimezone = timezone || getBrowserTimezone();
    return {
      ipAddress,
      location,
      timezone,
      localTime: resolvedTimezone
        ? formatBrowserClockTime(resolvedTimezone)
        : undefined,
      name: getInitialLocalUsername(),
    };
  }

  buildPlayerInfoUpdateMessage(player: LobbyPlayer, gameId: string): NetworkMessage {
    return {
      type: 'playerInfoUpdate',
      gameId,
      playerId: player.playerId,
      allyTeamId: player.allyTeamId,
      ipAddress: player.ipAddress,
      location: player.location,
      timezone: player.timezone,
      localTime: player.localTime,
      name: player.name,
    };
  }

  getLocalPlayerName(localPlayerId: PlayerId): string {
    const player = this.players.get(localPlayerId);
    return player !== undefined ? player.name : getDefaultPlayerName(localPlayerId);
  }

  toArray(): LobbyPlayer[] {
    const players = new Array<LobbyPlayer>(this.players.size);
    let index = 0;
    for (const player of this.players.values()) {
      players[index++] = this.copy(player);
    }
    return players;
  }

  copy(player: LobbyPlayer): LobbyPlayer {
    return { ...player };
  }

  /** Put a seat on a side. Host-only in practice; clients receive the
   *  result through the roster broadcast. Returns false for an unknown
   *  seat or a side id that is not a positive integer. */
  setAllyTeam(playerId: PlayerId, allyTeamId: number): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (!Number.isFinite(allyTeamId) || allyTeamId < FIRST_ALLY_TEAM_ID) return false;
    const next = Math.floor(allyTeamId);
    if (player.allyTeamId === next) return false;
    player.allyTeamId = next;
    return true;
  }

  /**
   * Side for a newly joined seat: the emptiest of `sideCount` sides, ties
   * going to the lowest id. That is how a lobby fills — a joiner lands on
   * the short-handed team rather than piling onto TEAM 1 — and it keeps a
   * 2v2v2 balanced without anyone touching a control.
   */
  defaultAllyTeamForJoin(sideCount: number): number {
    const sides = Math.max(1, Math.floor(sideCount) || 1);
    const counts = new Array<number>(sides).fill(0);
    for (const player of this.players.values()) {
      const index = player.allyTeamId - FIRST_ALLY_TEAM_ID;
      if (index >= 0 && index < sides) counts[index]++;
    }
    let best = 0;
    for (let i = 1; i < sides; i++) {
      if (counts[i] < counts[best]) best = i;
    }
    return FIRST_ALLY_TEAM_ID + best;
  }

  /** Seat -> side, for handing the match's roster to the sim. */
  allyTeamByPlayerId(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const player of this.players.values()) {
      out[player.playerId] = player.allyTeamId;
    }
    return out;
  }
}
