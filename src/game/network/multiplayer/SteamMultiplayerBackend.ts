/**
 * The Steam backend: Steam owns the lobby list and carries the traffic.
 *
 * Structurally complete and deliberately not pretending. Every Steam call it
 * needs is named in `SteamNetworkingApi` below, and nothing in this repo
 * implements that interface yet — there is no Steam SDK here, and the Tauri
 * wrapper does not expose one. So the backend reports itself unavailable and
 * refuses to operate rather than silently doing nothing, which would look
 * exactly like a lobby nobody can see.
 *
 * The point of writing it now is the shape: it fixes what a second backend
 * has to supply, and it keeps the game's lobby code from growing assumptions
 * that only hold for WebRTC and a REST directory. Two differences it already
 * accounts for, both of which would otherwise leak into callers:
 *
 *   - Steam has no room code to read aloud. A lobby is a 64-bit id, and
 *     joining is "enter this lobby", not "type these four characters". The
 *     shared vocabulary is a `roomCode` string, so the id is carried as its
 *     decimal form and never shown as something to retype.
 *   - Steam advertisements are not leases. Steam keeps a lobby alive while
 *     its owner is connected, so there is no heartbeat to send — publishing
 *     sets metadata once per change instead of on a timer.
 *
 * To finish it: implement `SteamNetworkingApi` over the real SDK (steamworks
 * via a Tauri command, most likely) and hand it to the constructor.
 */

import { MAX_LOBBY_SPECTATORS } from '../LobbyDirectory';
import type {
  MultiplayerBackend,
  MultiplayerBackendId,
  MultiplayerLobbyAdvert,
  MultiplayerLobbySummary,
} from './MultiplayerBackend';

/**
 * The Steamworks surface this backend needs, and nothing more.
 *
 * Kept as an interface so the SDK boundary is one file wide: everything above
 * it is ordinary code that can be read and tested without Steam running.
 */
export interface SteamNetworkingApi {
  /** ISteamMatchmaking::RequestLobbyList + per-lobby metadata reads. */
  requestLobbyList(): Promise<readonly SteamLobbyRecord[]>;
  /** ISteamMatchmaking::CreateLobby, returning the new lobby id. */
  createLobby(maxMembers: number): Promise<string>;
  /** ISteamMatchmaking::SetLobbyData for each advertised field. */
  setLobbyData(lobbyId: string, data: Readonly<Record<string, string>>): Promise<void>;
  /** ISteamMatchmaking::LeaveLobby. */
  leaveLobby(lobbyId: string): Promise<void>;
}

export type SteamLobbyRecord = {
  readonly lobbyId: string;
  readonly memberCount: number;
  readonly maxMembers: number;
  readonly data: Readonly<Record<string, string>>;
};

/** Metadata keys this backend writes, so reads and writes cannot drift. */
/** Steam lobby data is strings only, so a count arrives as text or not at
 *  all. Null means the host never wrote one, which is different from zero. */
function readSteamCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const LOBBY_DATA_KEYS = {
  name: 'ba_name',
  hostName: 'ba_host',
  status: 'ba_status',
  mapName: 'ba_map',
  spectatorCount: 'ba_spectators',
} as const;

export class SteamMultiplayerBackend implements MultiplayerBackend {
  readonly id: MultiplayerBackendId = 'steam';

  private lobbyId: string | null = null;
  private describeLobby: (() => MultiplayerLobbyAdvert | null) | null = null;
  /** Last advert actually written, so unchanged fields are not re-sent.
   *  Steam metadata writes are broadcast to every lobby member. */
  private lastPublished: string | null = null;

  constructor(private readonly api: SteamNetworkingApi | null = null) {}

  isAvailable(): boolean {
    return this.api !== null;
  }

  unavailableReason(): string | null {
    if (this.api !== null) return null;
    return 'no Steam API is attached to this build — implement SteamNetworkingApi and pass it in';
  }

  private requireApi(): SteamNetworkingApi {
    if (this.api === null) {
      throw new Error(`[steam-backend] unavailable: ${this.unavailableReason()}`);
    }
    return this.api;
  }

  async listLobbies(): Promise<readonly MultiplayerLobbySummary[]> {
    // Same best-effort contract as the native backend: discovery failing is
    // never allowed to break joining.
    if (this.api === null) return [];
    let records: readonly SteamLobbyRecord[];
    try {
      records = await this.api.requestLobbyList();
    } catch (error) {
      return [];
    }
    return records.map((record) => ({
      // Steam lobby ids are opaque 64-bit values, carried as decimal text.
      // Never surfaced as something a player types.
      roomCode: record.lobbyId,
      name: record.data[LOBBY_DATA_KEYS.name] ?? '',
      hostName: record.data[LOBBY_DATA_KEYS.hostName] ?? '',
      status: record.data[LOBBY_DATA_KEYS.status] === 'in-game' ? 'in-game' : 'open',
      // Steam counts every attached member, watchers included, so the seat
      // count is what the host wrote rather than what Steam observed.
      playerCount: readSteamCount(record.data[LOBBY_DATA_KEYS.spectatorCount])
        === null
        ? record.memberCount
        : Math.max(0, record.memberCount - (readSteamCount(record.data[LOBBY_DATA_KEYS.spectatorCount]) ?? 0)),
      maxPlayers: record.maxMembers,
      spectatorCount: readSteamCount(record.data[LOBBY_DATA_KEYS.spectatorCount]) ?? 0,
      maxSpectators: MAX_LOBBY_SPECTATORS,
      mapName: record.data[LOBBY_DATA_KEYS.mapName] ?? '',
      // Steam does not report a creation time; callers show relative age, so
      // 0 renders as "unknown" rather than as a bogus timestamp.
      createdAt: 0,
    }));
  }

  publishLobby(describe: () => MultiplayerLobbyAdvert | null): void {
    this.describeLobby = describe;
    void this.pushLobbyData();
  }

  /**
   * Write the current advert to Steam, if anything changed.
   *
   * No timer, unlike the native lease: Steam keeps a lobby alive as long as
   * its owner is connected, so there is nothing to renew. Re-publishing is
   * driven by the caller reporting a change.
   */
  private async pushLobbyData(): Promise<void> {
    const describe = this.describeLobby;
    if (describe === null) return;
    const advert = describe();
    if (advert === null) return;
    const api = this.requireApi();

    if (this.lobbyId === null) {
      this.lobbyId = await api.createLobby(advert.maxPlayers);
    }
    const data: Record<string, string> = {
      [LOBBY_DATA_KEYS.name]: advert.name,
      [LOBBY_DATA_KEYS.hostName]: advert.hostName,
      [LOBBY_DATA_KEYS.status]: advert.status,
      [LOBBY_DATA_KEYS.mapName]: advert.mapName,
      [LOBBY_DATA_KEYS.spectatorCount]: String(advert.spectatorCount),
    };
    const serialized = JSON.stringify(data);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    await api.setLobbyData(this.lobbyId, data);
  }

  withdrawLobby(): void {
    const lobbyId = this.lobbyId;
    this.describeLobby = null;
    this.lobbyId = null;
    this.lastPublished = null;
    if (lobbyId === null || this.api === null) return;
    void this.api.leaveLobby(lobbyId);
  }
}
