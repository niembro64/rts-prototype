import {
  getDefaultPlayerName,
  getInitialLocalUsername,
  MAX_NAME_LENGTH,
} from '@/playerNamesConfig';
import type { PlayerId } from '../sim/types';
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

type PlayerInfoResult = {
  player: LobbyPlayer | null;
  changed: boolean;
};

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
    const player: LobbyPlayer = {
      playerId,
      name: getInitialLocalUsername(),
      isHost: true,
    };
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
    const timezone = self?.timezone || getBrowserTimezone();
    return {
      name: self?.name ?? getInitialLocalUsername(),
      ipAddress: self?.ipAddress,
      location: self?.location,
      timezone: timezone || undefined,
      localTime: formatLocalTime(timezone),
    };
  }

  buildReportedLocalPlayerInfo(
    ipAddress: string | undefined,
    location: string | undefined,
    timezone: string | undefined,
  ): LobbyPlayerInfoPayload {
    return {
      ipAddress,
      location,
      timezone,
      localTime: formatLocalTime(timezone || getBrowserTimezone()),
      name: getInitialLocalUsername(),
    };
  }

  buildPlayerInfoUpdateMessage(player: LobbyPlayer, gameId: string): NetworkMessage {
    return {
      type: 'playerInfoUpdate',
      gameId,
      playerId: player.playerId,
      ipAddress: player.ipAddress,
      location: player.location,
      timezone: player.timezone,
      localTime: player.localTime,
      name: player.name,
    };
  }

  getLocalPlayerName(localPlayerId: PlayerId): string {
    return this.players.get(localPlayerId)?.name ?? getDefaultPlayerName(localPlayerId);
  }

  toArray(): LobbyPlayer[] {
    return Array.from(this.players.values()).map((player) => this.copy(player));
  }

  copy(player: LobbyPlayer): LobbyPlayer {
    return { ...player };
  }
}

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function formatLocalTime(timezone: string | undefined): string | undefined {
  if (!timezone) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(new Date());
  } catch {
    return undefined;
  }
}
