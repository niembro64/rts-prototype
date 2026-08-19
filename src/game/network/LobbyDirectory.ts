/**
 * Client for the games.niemo.io lobby directory.
 *
 * PeerJS carries the match, and nothing here changes that. The one thing it
 * cannot do is tell a player what else is being played — a room code has to
 * reach them out of band. The directory closes that gap: hosts announce their
 * code and a name, and everyone else reads the list instead of being told.
 * No game traffic passes through it.
 *
 * The single rule this module is built around: **the directory is never
 * allowed to break hosting or joining.** It is a convenience layered on top
 * of the code-based flow that already worked. Every call is best-effort — a
 * backend that is down, slow, or absent (Tauri offline, a LAN with no
 * internet) degrades to exactly the old behaviour, an empty list and a code
 * you can still type. Nothing here rejects into the lobby path.
 *
 * Backend: https://github.com/niembro64/web_games_backend
 */

import { isTauriRuntime } from '../../browserRuntime';

/** Namespaces this game's listings inside a directory shared by every game
 *  on games.niemo.io. Matches the folder the build is deployed to. */
export const LOBBY_DIRECTORY_GAME_ID = 'budget-annihilation';

/** Seats a lobby can hold. The host rejects a 7th SEATING, so the directory
 *  reads this same constant rather than restating the number and drifting
 *  from it. */
export const MAX_LOBBY_PLAYERS = 6;

/** Benched watchers a lobby can hold on top of its seats — twelve people can
 *  be attached to one match. Spectators are counted and advertised
 *  separately: they take no seat, contribute no command frames, and can never
 *  hold the match up. */
export const MAX_LOBBY_SPECTATORS = 6;

/** How often a host renews its listing. The backend expires anything it has
 *  not heard from in 30s, so this tolerates two missed beats. */
const HEARTBEAT_INTERVAL_MS = 10000;

/** Shortest gap between refreshes driven by a change rather than by the beat
 *  timer. The roster changes far more often than a browsing player could
 *  notice, and the listing is a signpost rather than a live feed. */
const MIN_REFRESH_INTERVAL_MS = 1000;

/** How often a browsing player refreshes the list. Fast enough that a lobby
 *  appears while someone is still deciding, slow enough to be invisible. */
export const LOBBY_LIST_POLL_INTERVAL_MS = 5000;

/** No directory call may outlive this. A hung request must never leave the
 *  host waiting — it just means no listing this beat. */
const REQUEST_TIMEOUT_MS = 6000;

export type LobbyDirectoryStatus = 'open' | 'in-game';

export type LobbyDirectoryEntry = {
  readonly game: string;
  readonly roomCode: string;
  readonly name: string;
  readonly hostName: string;
  readonly status: LobbyDirectoryStatus;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly maxSpectators: number;
  readonly mapName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type LobbyDirectoryListing = {
  readonly lobbies: readonly LobbyDirectoryEntry[];
  readonly openCount: number;
  readonly runningCount: number;
};

/** What a host publishes about itself. */
export type LobbyAnnouncement = {
  readonly roomCode: string;
  readonly name: string;
  readonly hostName: string;
  readonly status: LobbyDirectoryStatus;
  readonly playerCount: number;
  /** Watchers attached, counted apart from seats: a running game with no free
   *  seat is still worth showing as watchable. */
  readonly spectatorCount: number;
  readonly mapName: string;
};

/** Reports the host's current state on demand.
 *
 *  A pull rather than a push because the pieces become known at different
 *  times: the room code exists as soon as signaling opens, but the lobby
 *  settings that name the map are bound a moment later. Re-reading on every
 *  beat means a listing completes itself instead of staying half-filled
 *  until something unrelated happens to change. */
export type LobbyAnnouncementProvider = () => LobbyAnnouncement | null;

const EMPTY_LISTING: LobbyDirectoryListing = {
  lobbies: [],
  openCount: 0,
  runningCount: 0,
};

/**
 * Where the directory lives.
 *
 * Same-origin `/api` is correct wherever the game is served over http(s):
 * on games.niemo.io nginx routes it to the backend, and in development the
 * Vite proxy forwards it. Tauri loads from a custom protocol with no backend
 * behind it, so the desktop build addresses the deployed host directly.
 * `VITE_BA_LOBBY_API` overrides both for testing against another instance.
 */
function resolveLobbyApiBaseUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const override = env['VITE_BA_LOBBY_API'];
  if (typeof override === 'string' && override !== '') return override.replace(/\/$/, '');
  if (isTauriRuntime()) return 'https://games.niemo.io/api';
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) return '/api';
  return 'https://games.niemo.io/api';
}

const LOBBY_API_BASE_URL = resolveLobbyApiBaseUrl();

/** One fetch, with a deadline, that resolves to null instead of throwing.
 *  Callers treat null as "the directory is unavailable right now", which is
 *  a normal state and not an error worth surfacing to the player. */
async function requestJson(
  path: string,
  init: RequestInit & { readonly expectedFailures?: readonly number[] } = {},
): Promise<{ status: number; body: unknown } | null> {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${LOBBY_API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function readEntry(raw: unknown): LobbyDirectoryEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const roomCode = typeof value.roomCode === 'string' ? value.roomCode : '';
  if (roomCode === '') return null;
  const status: LobbyDirectoryStatus = value.status === 'in-game' ? 'in-game' : 'open';
  const readCount = (input: unknown, fallback: number): number => {
    const parsed = Math.floor(Number(input));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    game: typeof value.game === 'string' ? value.game : LOBBY_DIRECTORY_GAME_ID,
    roomCode,
    name: typeof value.name === 'string' ? value.name : '',
    hostName: typeof value.hostName === 'string' ? value.hostName : '',
    status,
    playerCount: readCount(value.playerCount, 1),
    maxPlayers: readCount(value.maxPlayers, MAX_LOBBY_PLAYERS),
    spectatorCount: readCount(value.spectatorCount, 0),
    maxSpectators: readCount(value.maxSpectators, MAX_LOBBY_SPECTATORS),
    mapName: typeof value.mapName === 'string' ? value.mapName : '',
    createdAt: readCount(value.createdAt, 0),
    updatedAt: readCount(value.updatedAt, 0),
  };
}

/** Fetch the current directory. Returns an empty listing when the backend is
 *  unreachable, so the caller renders "no lobbies" rather than an error. */
export async function fetchLobbyDirectory(): Promise<LobbyDirectoryListing> {
  const result = await requestJson(
    `/lobbies?game=${encodeURIComponent(LOBBY_DIRECTORY_GAME_ID)}`,
    { method: 'GET' },
  );
  if (result === null || result.status !== 200 || result.body === null) return EMPTY_LISTING;
  const body = result.body as Record<string, unknown>;
  const rawLobbies = Array.isArray(body.lobbies) ? body.lobbies : [];
  const lobbies: LobbyDirectoryEntry[] = [];
  for (const raw of rawLobbies) {
    const entry = readEntry(raw);
    if (entry !== null) lobbies.push(entry);
  }
  return {
    lobbies,
    openCount: lobbies.reduce((total, lobby) => total + (lobby.status === 'open' ? 1 : 0), 0),
    runningCount: lobbies.reduce((total, lobby) => total + (lobby.status === 'in-game' ? 1 : 0), 0),
  };
}

/**
 * Publishes one host's lobby and keeps it alive.
 *
 * Owns a heartbeat timer for as long as the host is listed. The interesting
 * case is a backend restart: the registry holds listings in memory, so it
 * comes back empty and answers the next heartbeat with 404. That is treated
 * as "announce again" rather than an error, which is what makes a restart
 * invisible to a host who is still sitting in their lobby.
 */
export class LobbyPublisher {
  private hostToken = '';
  private provider: LobbyAnnouncementProvider | null = null;
  /** Room code of the listing currently held, so it can be withdrawn even
   *  after the provider has stopped reporting one. */
  private listedRoomCode = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Keeps two publishes from overlapping. */
  private inFlight = false;
  /** A beat that arrived while another was in flight. It is remembered and
   *  run afterwards rather than dropped: the refresh that follows hosting
   *  lands during the opening announce, and discarding it left the listing
   *  stale — missing its map size — until the next heartbeat. */
  private pendingBeat = false;
  /** When the last refresh actually went out, so a churning lobby cannot spam
   *  the lease. */
  private lastBeatAtMs = 0;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Begin publishing, or refresh what is already published.
   *
   *  Safe to call on every change worth showing — and it is called on every
   *  one, because the roster changes whenever anybody joins, leaves, is seated
   *  or reports their clock. Refreshes are therefore rate-limited rather than
   *  sent immediately: the listing only has to be roughly current, and the
   *  lease is not a place to put a stream of edits. A refresh that arrives
   *  during the cooldown is remembered and sent when it lifts, so the last
   *  state always lands. */
  publish(provider: LobbyAnnouncementProvider): void {
    this.provider = provider;
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    }
    const sinceLast = Date.now() - this.lastBeatAtMs;
    if (sinceLast >= MIN_REFRESH_INTERVAL_MS) {
      this.lastBeatAtMs = Date.now();
      void this.beat();
      return;
    }
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      if (this.provider === null) return;
      this.lastBeatAtMs = Date.now();
      void this.beat();
    }, MIN_REFRESH_INTERVAL_MS - sinceLast);
  }

  /** Stop publishing and remove the listing. Withdrawal is fire-and-forget:
   *  if it never lands the lease simply expires, which is the same outcome
   *  a crashed host produces. */
  stop(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.lastBeatAtMs = 0;
    const roomCode = this.listedRoomCode;
    const hostToken = this.hostToken;
    this.provider = null;
    this.pendingBeat = false;
    this.listedRoomCode = '';
    this.hostToken = '';
    if (roomCode === '' || hostToken === '') return;
    void requestJson(
      `/lobbies/${encodeURIComponent(LOBBY_DIRECTORY_GAME_ID)}/${encodeURIComponent(roomCode)}`,
      { method: 'DELETE', body: JSON.stringify({ hostToken }) },
    );
  }

  private async beat(): Promise<void> {
    if (this.inFlight) {
      this.pendingBeat = true;
      return;
    }
    const announcement = this.provider?.() ?? null;
    if (announcement === null || announcement.roomCode === '') return;
    // A host that re-hosts gets a new code; the old listing is a different
    // lease and must be re-announced rather than heartbeated.
    if (announcement.roomCode !== this.listedRoomCode) this.hostToken = '';

    this.inFlight = true;
    try {
      if (this.hostToken === '') {
        await this.announce(announcement);
        return;
      }
      const result = await requestJson(
        `/lobbies/${encodeURIComponent(LOBBY_DIRECTORY_GAME_ID)}/${encodeURIComponent(announcement.roomCode)}/heartbeat`,
        {
          method: 'POST',
          body: JSON.stringify({
            hostToken: this.hostToken,
            maxPlayers: MAX_LOBBY_PLAYERS,
            maxSpectators: MAX_LOBBY_SPECTATORS,
            ...announcement,
          }),
        },
      );
      // 404 = the backend forgot us (restart, or the lease expired while the
      // network was down). Re-announcing is the recovery, not an error.
      if (result !== null && result.status === 404) {
        this.hostToken = '';
        await this.announce(announcement);
      }
    } finally {
      this.inFlight = false;
      if (this.pendingBeat && this.provider !== null) {
        this.pendingBeat = false;
        void this.beat();
      }
    }
  }

  private async announce(announcement: LobbyAnnouncement): Promise<void> {
    const result = await requestJson('/lobbies', {
      method: 'POST',
      body: JSON.stringify({
        game: LOBBY_DIRECTORY_GAME_ID,
        maxPlayers: MAX_LOBBY_PLAYERS,
        maxSpectators: MAX_LOBBY_SPECTATORS,
        ...announcement,
      }),
    });
    if (result === null || result.body === null) return;
    if (result.status !== 200 && result.status !== 201) return;
    const body = result.body as Record<string, unknown>;
    if (typeof body.hostToken !== 'string') return;
    this.hostToken = body.hostToken;
    this.listedRoomCode = announcement.roomCode;
  }
}
