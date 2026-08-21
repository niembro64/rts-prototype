import PeerDefault, * as PeerJsModule from 'peerjs';
import type {
  DataConnection,
  Peer as PeerInstance,
  PeerOptions,
  Util,
} from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { SeatInitialState } from '../sim/agentSeat';
import {
  getDefaultPlayerName,
  saveUsername,
  MAX_NAME_LENGTH,
} from '@/playerNamesConfig';

// Public network type facade used by callers that also construct NetworkManager.
export type {

  
  
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshot,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotResourceMovement,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotMotionUpdate,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotMeta,
  LobbyPlayer,
  LobbyMember,
  LobbyMemberRole,
  LobbySettings,
  NetworkRole,
  BattleHandoff,
} from './NetworkTypes';

import type { CanonicalServerStateHash } from '../architecture/CanonicalStateHash';
import {
  type BattleHandoff,
  type LobbyBotSeat,
  type LobbyMember,
  type LobbyMemberRole,
  type MemberId,
  type NetworkCommunicationChannel,
  type NetworkCommunicationDraft,
  type NetworkCommunicationEvent,
  type LockstepResumeGrantMessage,
  type SessionRefusalReason,
  type NetworkLockstepMessage,
  type LobbySettings,
  type SeatToken,
} from '@/types/network';
import type {
  LobbyPlayer,
  NetworkMessage,
  NetworkRole,
} from './NetworkTypes';
import { LOCKSTEP_PROTOCOL_VERSION } from './NetworkTypes';
import {
  buildBattleHandoff,
  normalizeBattleHandoffMessage,
} from './NetworkBattleHandoff';
import { NetworkHeartbeatTracker } from './NetworkHeartbeatTracker';
import { NetworkLockstepTransport } from './NetworkLockstepTransport';
import {
  HOST_MEMBER_ID,
  NetworkLobbyMembers,
  normalizeWireOptional,
} from './NetworkLobbyMembers';
import { FIRST_ALLY_TEAM_ID, MAX_ALLY_TEAM_COUNT } from '../sim/teamRoster';
import { BATTLE_CONFIG } from '@/battleBarConfig';
import {
  generateRoomCode,
  normalizeRoomCode,
  roomCodeToGameId,
} from './NetworkRoomCode';
import {
  NetworkSendBudget,
  type NetworkSendBudgetTelemetry,
} from './NetworkSendBudget';
import { assertCurrentLobbySettings } from './LobbySettingsContract';
import { resolveLobbyDisplayName } from './lobbyName';
import { MAX_LOBBY_PLAYERS } from './LobbyDirectory';
import { getMultiplayerBackend } from './multiplayer/multiplayerBackendRegistry';
import { isTauriRuntime } from '../../browserRuntime';
import {
  admitsSeating,
  admitsSpectators,
  createSessionLifecycle,
  sessionStatusFor,
  type SessionLifecycle,
} from './multiplayer/MultiplayerBackend';

// Player-name policy lives in @/playerNamesConfig — single source of
// truth for both seeding (random funny name keyed by playerId) and the
// LOCAL player's persisted username (saved to localStorage on every
// edit, restored on next page load).

type PeerRuntimePackage = {
  default?: unknown;
  Peer?: unknown;
  util?: Util;
};

const PEER_MODULE = PeerJsModule as unknown as PeerRuntimePackage;
const PEER_DEFAULT = PeerDefault as unknown as PeerRuntimePackage;
const Peer = (
  typeof PEER_MODULE.Peer === 'function'
    ? PEER_MODULE.Peer
    : typeof PEER_DEFAULT.Peer === 'function'
      ? PEER_DEFAULT.Peer
      : typeof PEER_MODULE.default === 'function'
        ? PEER_MODULE.default
        : typeof PEER_DEFAULT.default === 'function'
          ? PEER_DEFAULT.default
          : PeerDefault
) as typeof PeerDefault;
type Peer = PeerInstance;
const peerUtil = PEER_MODULE.util ?? PEER_DEFAULT.util;
if (peerUtil === undefined) {
  throw new Error('PeerJS util.defaultConfig is unavailable');
}

/** The signaling server a session dials: host/port/path/secure for the
 *  `Peer` constructor, or `null` for the public PeerJS cloud. */
type PeerServerTarget = Pick<PeerOptions, 'host' | 'port' | 'path' | 'secure'>;

/** Dev/test override for the PeerJS signaling server. Set
 *  VITE_BA_PEER_HOST (plus optional VITE_BA_PEER_PORT,
 *  VITE_BA_PEER_PATH, VITE_BA_PEER_SECURE) to point the lobby at a
 *  self-hosted `peerjs --port N` server. Wins over both the same-origin
 *  relay and the public cloud, so automated two-page tests keep their
 *  private signaling regardless of what a backend answers. */
function readPeerServerOverride(): PeerServerTarget | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const host = env['VITE_BA_PEER_HOST'];
  if (typeof host !== 'string' || host === '') return null;
  const secure = env['VITE_BA_PEER_SECURE'] === '1' || env['VITE_BA_PEER_SECURE'] === 'true';
  const portRaw = Number(env['VITE_BA_PEER_PORT']);
  const path = typeof env['VITE_BA_PEER_PATH'] === 'string' && env['VITE_BA_PEER_PATH'] !== ''
    ? env['VITE_BA_PEER_PATH']
    : '/';
  return {
    host,
    port: Number.isFinite(portRaw) ? portRaw : (secure ? 443 : 80),
    path,
    secure,
  };
}

/** ICE and debug settings shared by every signaling choice. */
const PEER_BASE_OPTIONS: PeerOptions = {
  debug: 0,
  // Keep PeerJS's default TURN fallback. The previous STUN-only
  // override worked on easy local networks but could fail for real
  // internet peers behind stricter NATs.
  config: {
    ...peerUtil.defaultConfig,
    iceServers: [
      ...peerUtil.defaultConfig.iceServers,
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

/** The peerjs client appends `peerjs` to this to form the socket URL, so on
 *  games.niemo.io the socket is wss://…/api/signal/peerjs — the same nginx
 *  and the same backend that serve the game and the lobby directory. */
const SELF_HOSTED_SIGNAL_PATH = '/api/signal/';

/** Where a build with no same-origin backend (the Tauri desktop app, a
 *  file:// open) finds the relay. Matches LobbyDirectory's fallback host. */
const DEPLOYED_SIGNAL_HOST = 'games.niemo.io';

/** How long the relay probe may take before the session settles for the
 *  public cloud. Same-origin answers in tens of milliseconds; this exists
 *  so a dead backend costs one short pause, never a hang. */
const SIGNAL_PROBE_TIMEOUT_MS = 2500;

/** The self-hosted relay this page would use, plus the URL that proves it
 *  is alive. Same-origin wherever the game is served over http(s) — nginx
 *  in production, the Vite proxy in dev — and the deployed host for Tauri,
 *  which loads from a custom protocol with no backend behind it. */
function selfHostedSignalCandidate(): { target: PeerServerTarget; probeUrl: string } {
  if (
    !isTauriRuntime() &&
    typeof window !== 'undefined' &&
    /^https?:$/.test(window.location.protocol)
  ) {
    const secure = window.location.protocol === 'https:';
    const port = window.location.port !== ''
      ? Number(window.location.port)
      : secure ? 443 : 80;
    return {
      target: { host: window.location.hostname, port, path: SELF_HOSTED_SIGNAL_PATH, secure },
      probeUrl: `${window.location.origin}/api/signal/health`,
    };
  }
  return {
    target: { host: DEPLOYED_SIGNAL_HOST, port: 443, path: SELF_HOSTED_SIGNAL_PATH, secure: true },
    probeUrl: `https://${DEPLOYED_SIGNAL_HOST}/api/signal/health`,
  };
}

/**
 * Decide where this session signals, once, before its peer is created.
 *
 * The public PeerJS cloud used to be the only choice, and it is why online
 * play "worked sometimes": a free shared EU box that throttles repeated
 * connections from one IP and drops sockets mid-OFFER, which surfaced as
 * "Connection timeout - room may not exist" with a perfectly healthy lobby
 * listing. The self-hosted relay on games.niemo.io shares nginx — and
 * therefore availability — with the game itself, so it is preferred
 * whenever its health probe answers.
 *
 * The probe, not a constant, is what keeps every launch working: a dev
 * server without the backend running, an outdated deployed backend, or an
 * outage all fail the probe and degrade to exactly the old cloud behavior.
 * Host and joiner run the same probe against the same URL, which is what
 * keeps them dialing the same server.
 */
async function resolvePeerServerTarget(): Promise<PeerServerTarget | null> {
  const override = readPeerServerOverride();
  if (override !== null) return override;
  const candidate = selfHostedSignalCandidate();
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SIGNAL_PROBE_TIMEOUT_MS);
    const response = await fetch(candidate.probeUrl, { signal: abort.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!response.ok) return null;
    const health = (await response.json()) as { peerSignal?: string };
    return health.peerSignal === 'ready' ? candidate.target : null;
  } catch {
    return null;
  }
}

/** The host always seats itself first, so player 1 IS the host. Clients use
 *  this to tell "the host vanished" apart from "some other player left". */

const SIGNALING_RECONNECT_INITIAL_DELAY_MS = 1000;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 10000;
const COMMUNICATION_CHAT_MAX_LENGTH = 220;
const LOCKSTEP_PENDING_MESSAGE_QUEUE_MAX = 512;
/**
 * Who a lockstep message came from, at both levels.
 *
 * `memberId` always addresses the connection — that is how a catch-up answer
 * is routed back to a watcher. `playerId` is the SEAT it speaks for and is
 * undefined for a watcher, which forces every consumer to say out loud what
 * an unseated sender is allowed to do.
 */
/** What a peer needs to replay its way into a running match. Mirrors the
 *  resume grant, minus the transport envelope. */
export type NetworkResumeContext = {
  readonly grantFrame: number;
  readonly archiveThroughFrame: number;
  readonly verifyFrame: number;
  readonly verifyStateHash: CanonicalServerStateHash | null;
};

type LockstepMessageSource = {
  readonly memberId: MemberId;
  readonly playerId: PlayerId | undefined;
};

type QueuedLockstepMessage = {
  readonly message: NetworkLockstepMessage;
  readonly from: LockstepMessageSource;
};

function sanitizeCommunicationText(value: string, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.slice(0, maxLength);
}

function shiftQueuedLockstepMessage(queue: QueuedLockstepMessage[]): QueuedLockstepMessage | undefined {
  if (queue.length === 0) return undefined;
  const message = queue[0];
  for (let i = 1; i < queue.length; i++) queue[i - 1] = queue[i];
  queue.length--;
  return message;
}

/**
 * What a connecting peer says about itself, carried on the connection itself.
 *
 * PeerJS delivers `metadata` with the connection, which is the only channel
 * that arrives before the host has to decide anything — and the host must know
 * the protocol version, and whether a seat is being reclaimed, at exactly that
 * moment. Read defensively: this is the one payload that has not been through
 * any version check yet.
 */
type ConnectionMetadata = {
  readonly protocolVersion: string | undefined;
  readonly seatToken: SeatToken | undefined;
};

/**
 * Where a seat token lives between connections.
 *
 * sessionStorage rather than localStorage on purpose: a reload is the ordinary
 * way a player vanishes mid-match and must come back to its own army, but a
 * token surviving the tab would try to reclaim a seat in a match that ended
 * hours ago.
 */
const SEAT_TOKEN_STORAGE_KEY = 'ba-seat-token';

function readStoredSeatToken(): SeatToken | undefined {
  try {
    const stored = globalThis.sessionStorage?.getItem(SEAT_TOKEN_STORAGE_KEY);
    return stored === null || stored === undefined || stored === '' ? undefined : stored;
  } catch {
    // Private browsing, a sandboxed frame, a non-browser runtime. Losing a
    // rejoin is a far smaller problem than failing to connect at all.
    return undefined;
  }
}

function writeStoredSeatToken(token: SeatToken | undefined): void {
  try {
    if (token === undefined) globalThis.sessionStorage?.removeItem(SEAT_TOKEN_STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(SEAT_TOKEN_STORAGE_KEY, token);
  } catch {
    // Same reasoning as above.
  }
}

function readConnectionMetadata(raw: unknown): ConnectionMetadata {
  if (typeof raw !== 'object' || raw === null) {
    return { protocolVersion: undefined, seatToken: undefined };
  }
  const value = raw as Record<string, unknown>;
  return {
    protocolVersion:
      typeof value.protocolVersion === 'string' ? value.protocolVersion : undefined,
    seatToken:
      typeof value.seatToken === 'string' && value.seatToken.length > 0
        ? value.seatToken
        : undefined,
  };
}

/** Sides a lobby may declare. One is a free-for-all of one; the ceiling is
 *  the seat cap, because a side per seat is already the most any roster can
 *  occupy. */
function clampLobbyAllyTeamCount(count: number): number {
  return Math.max(1, Math.min(MAX_ALLY_TEAM_COUNT, Math.floor(count) || 1));
}

export class NetworkManager {
  /** How many SIDES this lobby splits its seats across — the TEAM N the
   *  roster labels. Host-owned and authored, not derived: a side the host
   *  declares and leaves empty is a real side that still takes a terrain
   *  slice, deposits and a spawn arc. It rides `lobbySettings` to clients so
   *  every roster renders the same empty teams the host sees.
   *  See src/game/sim/teamRoster.ts. */
  private allyTeamCount: number = clampLobbyAllyTeamCount(
    BATTLE_CONFIG.allyTeamCount.default,
  );

  lobbyAllyTeamCount(): number {
    return this.allyTeamCount;
  }

  /** Host: change how many sides the lobby offers. Seats sitting on a side
   *  that no longer exists are pulled back onto the emptiest remaining one,
   *  so the roster is always internally consistent. */
  setLobbyAllyTeamCount(count: number): void {
    if (this.role !== 'host') return;
    if (!this.applyLobbyAllyTeamCount(count)) return;
    this.broadcastLobbyRoster();
  }

  /**
   * Host: delete one declared side, closing the gap behind it.
   *
   * Only an EMPTY side. A side with a commander on it is somebody's game, and
   * a control that silently relocated them would make the roster change under
   * their feet — so the host benches or moves the players first and the
   * removal is refused until they have.
   */
  removeLobbyAllyTeam(allyTeamId: number): boolean {
    if (this.role !== 'host') return false;
    if (this.allyTeamCount <= 1) return false;
    if (allyTeamId < FIRST_ALLY_TEAM_ID) return false;
    if (allyTeamId >= FIRST_ALLY_TEAM_ID + this.allyTeamCount) return false;
    if (!this.members.collapseAllyTeam(allyTeamId)) return false;
    this.allyTeamCount--;
    this.broadcastLobbyRoster();
    return true;
  }

  /** Client: adopt the host's side count, arriving on `lobbySettings`. Never
   *  re-announces — a client that answered back would be a second writer for
   *  a value the host owns. */
  applyLobbyAllyTeamCount(count: number): boolean {
    const next = clampLobbyAllyTeamCount(count);
    if (next === this.allyTeamCount) return false;
    this.allyTeamCount = next;
    this.members.reseatOutOfRangeSides(next);
    return true;
  }

  /** Move one seat to another side, then re-announce the roster.
   *
   *  Host only, and enforced here rather than only in the UI that calls it:
   *  the roster the host broadcasts is the one every client renders, so a
   *  client changing its local copy would just be overwritten by the next
   *  announcement. Refusing outright keeps one writer instead of two, and
   *  makes the disagreement impossible rather than merely short-lived. */
  setMemberAllyTeam(memberId: MemberId, allyTeamId: number): void {
    if (this.role !== 'host') return;
    if (!this.members.setAllyTeam(memberId, allyTeamId, this.allyTeamCount)) return;
    this.broadcastLobbyRoster();
  }

  /**
   * Host: put a watcher on a team, or take a player off one.
   *
   * The ONLY route between the bench and a seat. A user cannot move
   * themselves — they join as a watcher and stay one until the host says
   * otherwise — because seating decides the frame-0 roster, and a roster that
   * two people can edit is a roster two clients can disagree about. Refused
   * once the match is running: the seated roster is hashed into the
   * initialization and cannot grow or shrink after frame 0.
   */
  setMemberSeated(memberId: MemberId, seated: boolean): boolean {
    if (this.role !== 'host') return false;
    if (!admitsSeating(this.session.state)) return false;
    const changed = seated
      ? this.members.seat(memberId, this.allyTeamCount).seated
      : this.members.unseat(memberId);
    if (!changed) return false;
    if (memberId === this.localMemberId) this.syncLocalSeat();
    this.broadcastLobbyRoster();
    this.refreshLobbyListing();
    return true;
  }

  /** Host: seat a bot on a team, or remove one. The same rules as human
   *  seating — lobby only, one writer — with one less ceremony: a bot has
   *  no member to ask, so the host's click is the whole gesture. */
  addBotSeat(preferredAllyTeamId?: number): boolean {
    if (this.role !== 'host') return false;
    if (!admitsSeating(this.session.state)) return false;
    const bot = this.members.addBotSeat(this.allyTeamCount, preferredAllyTeamId);
    if (bot === null) return false;
    this.broadcastLobbyRoster();
    this.refreshLobbyListing();
    return true;
  }

  removeBotSeat(playerId: PlayerId): boolean {
    if (this.role !== 'host') return false;
    if (!admitsSeating(this.session.state)) return false;
    if (!this.members.removeBotSeat(playerId)) return false;
    this.broadcastLobbyRoster();
    this.refreshLobbyListing();
    return true;
  }

  /** Host: flip one seat's INITIAL STATE ('commander' <-> 'base') — the
   *  other seat axis, member-held seats and bots alike. */
  setSeatInitialState(playerId: PlayerId, initialState: SeatInitialState): boolean {
    if (this.role !== 'host') return false;
    if (!admitsSeating(this.session.state)) return false;
    if (!this.members.setSeatInitialState(playerId, initialState)) return false;
    this.broadcastLobbyRoster();
    return true;
  }

  setBotSeatAllyTeam(playerId: PlayerId, allyTeamId: number): boolean {
    if (this.role !== 'host') return false;
    if (!this.members.setBotSeatAllyTeam(playerId, allyTeamId, this.allyTeamCount)) return false;
    this.broadcastLobbyRoster();
    return true;
  }

  /** Re-announce the WHOLE member list to every client, and hand the same
   *  list to the local UI. Atomic replace, not a delta: the roster is small,
   *  and every disagreement about who sits where came from clients merging
   *  partial updates in different orders. */
  private broadcastLobbyRoster(): void {
    const members = this.members.toArray();
    const botSeats = this.members.botSeatsList();
    this.broadcast({
      type: 'rosterUpdate',
      gameId: this.getUniversalGameId(),
      members,
      botSeats,
      allyTeamCount: this.allyTeamCount,
    });
    this.emitRoster(members, botSeats);
  }

  /** Seat -> side for handing this lobby's roster to the sim. */
  getAllyTeamByPlayerId(): Record<number, number> {
    return this.members.allyTeamByPlayerId();
  }

  private setLocalSeatToken(token: SeatToken | undefined): void {
    this.localSeatToken = token;
    writeStoredSeatToken(token);
  }

  /** Keep the local seat/role in step with whatever the roster now says. */
  private syncLocalSeat(): void {
    const self = this.members.get(this.localMemberId);
    const nextSeat = self?.playerId;
    const nextRole: LobbyMemberRole = self?.role ?? 'spectator';
    const seatChanged = this.localPlayerId !== nextSeat;
    this.localPlayerId = nextSeat;
    this.localRole = nextRole;
    if (self !== undefined && self.playerId !== undefined) {
      const token = this.members.seatTokenFor(self.playerId);
      if (token !== undefined) this.setLocalSeatToken(token);
    }
    if (seatChanged) this.emitSeatAssignment(nextSeat, nextRole);
  }

  private peer: Peer | null = null;
  /** Keyed by MEMBER, not by seat. Every connection has a member id from the
   *  moment it is admitted; only some of them ever hold a seat, and a
   *  spectator has to be reachable exactly like a player. */
  private connections: Map<MemberId, DataConnection> = new Map();
  private role: NetworkRole | null = null;
  /** 'local' seals the session: no signaling peer, no directory listing,
   *  no joiners — a skirmish for this machine alone. 'online' is the open
   *  lobby everything else documents. */
  private sessionVisibility: 'online' | 'local' = 'online';
  private roomCode: string = '';
  /** Where this build advertises and discovers sessions — the web directory
   *  or Steam. Resolved once by the registry; nothing here knows which. */
  private readonly multiplayer = getMultiplayerBackend();
  /** Latches `emitHostLeft` so the message and the closing socket, which a
   *  graceful host sends both of, only eject the client once. */
  private hostLeftEmitted = false;
  private localMemberId: MemberId = HOST_MEMBER_ID;
  /** The SEAT this client holds, or undefined while it is watching. Not a
   *  default of 1: a spectator with a default seat would command somebody
   *  else's army. */
  private localPlayerId: PlayerId | undefined = undefined;
  private localRole: LobbyMemberRole = 'spectator';
  /** Handed to us when we were seated; presented on reconnect to reclaim the
   *  same seat. Persisted for the browser SESSION so a reload — the ordinary
   *  way a player disappears — comes back to its own army rather than arriving
   *  as a stranger. Deliberately not localStorage: a token outliving the tab
   *  would try to reclaim a seat in a match that is long over. */
  private localSeatToken: SeatToken | undefined = readStoredSeatToken();
  private members = new NetworkLobbyMembers();
  /** The session's own lifecycle. Replaces a `gameStarted` boolean: the
   *  questions asked of it — may a late joiner be admitted, should the lobby
   *  still be advertised as open, has this session already ended — are all
   *  answered from one declared table instead of from a flag plus the
   *  implicit assumptions around it. */
  private readonly session: SessionLifecycle = createSessionLifecycle();

  /** Retained as a read-only view because several call sites read it as a
   *  plain condition; the single writer is now the machine above. */
  private get gameStarted(): boolean {
    return this.session.is('playing');
  }
  /**
   * The lockstep transport addresses two different sets, deliberately:
   *
   *   DELIVERY   every connected member — command frames must reach watchers
   *              too, or they cannot simulate.
   *   COMPLETION seated players only — see `seatedConnections`, which is what
   *              a per-seat resend or ack lookup resolves through.
   *
   * `getConnections` is the delivery set. Nothing here may use it to decide
   * whether a frame is complete.
   */
  private lockstepTransport = new NetworkLockstepTransport({
    getGameId: () => this.getUniversalGameId(),
    getHostConnection: () => this.connections.get(HOST_MEMBER_ID),
    getConnections: () => this.connections,
    getSeatedConnections: () => this.seatedConnections(),
    getLocalPlayerId: () => this.localPlayerId,
    isMessageForCurrentGame: (message) => this.isMessageForCurrentGame(message.gameId),
    onMessage: (message, fromPlayerId) =>
      this.emitLockstepMessage(message, {
        memberId: this.pendingLockstepSenderMemberId,
        playerId: fromPlayerId,
      }),
    send: (conn, message) => this.safeSend(conn, message),
  });

  /** Seat -> connection, for anything addressed to a PLAYER rather than to a
   *  connection: per-seat command-frame resends, ack bookkeeping, and the
   *  pause policy's subject. */
  private seatedConnections(): Map<PlayerId, DataConnection> {
    const out = new Map<PlayerId, DataConnection>();
    for (const [memberId, conn] of this.connections) {
      const seat = this.members.get(memberId)?.playerId;
      if (seat !== undefined) out.set(seat, conn);
    }
    return out;
  }

  /** The seat a connection speaks for, or undefined when it is watching. A
   *  spectator's lockstep traffic is telemetry: it may ack and checksum, but
   *  it can never carry a command or complete a frame. */
  private seatForMember(memberId: MemberId): PlayerId | undefined {
    return this.members.get(memberId)?.playerId;
  }
  private lockstepMessageHandler:
    | ((message: NetworkLockstepMessage, from: LockstepMessageSource) => void)
    | undefined = undefined;
  /** Which connection the message currently being routed arrived on. Set for
   *  the duration of one `handleMessage` call so the transport's callback,
   *  which only knows seats, can still report the member. */
  private pendingLockstepSenderMemberId: MemberId = HOST_MEMBER_ID;
  private readonly pendingLockstepMessages: QueuedLockstepMessage[] = [];
  private droppedPendingLockstepMessages = 0;
  private readonly rawSendCallback = (conn: DataConnection, message: NetworkMessage): boolean =>
    this.rawSend(conn, message);
  private sendBudget = new NetworkSendBudget({
    onPendingQueued: () => this.scheduleSendBudgetFlush(),
  });
  private heartbeatTracker = new NetworkHeartbeatTracker({
    buildHeartbeat: () => this.buildHeartbeatMessage(),
    closeConnection: (memberId) => {
      const conn = this.connections.get(memberId);
      if (conn !== undefined) conn.close();
    },
    getConnections: () => this.connections,
    isGameStarted: () => this.gameStarted,
    // A host that dies without closing its connection — a killed tab, a
    // yanked cable — sends no farewell, and PeerJS may take a very long time
    // to notice the socket is dead. Its heartbeat stopping is the earliest
    // reliable sign, and during a battle it is the only one: nothing else
    // distinguishes a departed host from one that is merely slow.
    onPeerSilent: (memberId) => {
      if (this.role === 'client' && memberId === HOST_MEMBER_ID) {
        this.emitHostLeft();
        return;
      }
      // Host side: a member has gone quiet. Noticing and acting stay separate
      // — the socket is still open, so this is `silent`, not gone. For a
      // SEATED member it is also the only mid-battle signal there is, so the
      // match is told to stop waiting on them silently.
      if (this.role !== 'host') return;
      if (!this.members.markSilent(memberId)) return;
      this.broadcastLobbyRoster();
      const seat = this.seatForMember(memberId);
      if (seat !== undefined) this.emitSeatedPeerSilent(seat);
    },
    send: (conn, message) => this.safeSend(conn, message),
    sendIntervalMs: undefined,
    timeoutMs: undefined,
  });
  private signalingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendBudgetFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
  private communicationSequence = 0;
  private sessionGeneration = 0;
  /** 10s connection-setup deadline created by hostGame/joinGame. Held
   *  here so disconnect() can cancel it — otherwise a stale timeout
   *  can fire after the user retries and destroy the new peer. */
  private setupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pendingSetupReject: ((error: Error) => void) | null = null;

  // Callbacks
  /** The whole member list changed. One callback, one atomic list — there is
   *  no join/leave/info trio to apply in the right order. */
  public onRoster:
    | ((members: readonly LobbyMember[], botSeats: readonly LobbyBotSeat[]) => void)
    | undefined = undefined;
  /** The host is gone and this session cannot continue. Clients only. */
  public onHostLeft: (() => void) | undefined = undefined;
  /** The host ended the battle back into the seating screen. The session
   *  SURVIVES — roster, seats and connections all stay — so the receiver
   *  tears down only the battle presentation and reopens the lobby. Fires on
   *  the host too, after its own broadcast, so both sides ride one path. */
  public onReturnToLobby: (() => void) | undefined = undefined;
  /** `resume` is present only when joining a match already in progress: the
   *  frame to replay up to, and the hash to verify against on arrival. */
  public onGameStart:
    | ((handoff: BattleHandoff, resume?: NetworkResumeContext) => void)
    | undefined = undefined;
  /** This client's seat changed — it was seated, unseated, or reclaimed one.
   *  `playerId` is undefined while watching. */
  public onSeatAssignment:
    | ((playerId: PlayerId | undefined, role: LobbyMemberRole) => void)
    | undefined = undefined;
  /** Host-side: a SEATED player has stopped answering. Its seat is reserved
   *  and the match should hold for it. Never fires for a watcher. */
  public onSeatedPeerSilent: ((playerId: PlayerId) => void) | undefined = undefined;
  /** Host-side: a seat that was being held has reconnected and reclaimed it.
   *  It still has to replay its way back before the match resumes, but it is
   *  no longer gone. */
  public onSeatedPeerReturned: ((playerId: PlayerId) => void) | undefined = undefined;
  public onError: ((error: string) => void) | undefined = undefined;
  public onConnected: (() => void) | undefined = undefined;
  /** Client-side: invoked when the host's lobby settings arrive
   *  (initial snapshot on connect AND every change while the
   *  lobby is open). The host runs the local copy of these
   *  settings as the source of truth and never receives this
   *  callback itself. */
  public onLobbySettings: ((settings: LobbySettings) => void) | undefined = undefined;
  /** Host-side: read the current lobby settings on demand. The
   *  network layer pulls fresh values whenever it needs to ship
   *  them (e.g. a new player just connected) so the host's
   *  GameCanvas stays the single source of truth — no shadow
   *  copy in the network layer that could drift. */
  public getLobbySettings: (() => LobbySettings) | undefined = undefined;
  public onCommunication: ((event: NetworkCommunicationEvent) => void) | undefined = undefined;
  public get onLockstepMessage():
    | ((message: NetworkLockstepMessage, from: LockstepMessageSource) => void)
    | undefined {
    return this.lockstepMessageHandler;
  }

  public set onLockstepMessage(
    callback:
      | ((message: NetworkLockstepMessage, from: LockstepMessageSource) => void)
      | undefined,
  ) {
    this.lockstepMessageHandler = callback;
    if (callback !== undefined) this.drainPendingLockstepMessages(callback);
  }

  private emitRoster(
    members: readonly LobbyMember[],
    botSeats: readonly LobbyBotSeat[] = this.members.botSeatsList(),
  ): void {
    this.refreshLobbyListing();
    const callback = this.onRoster;
    if (callback !== undefined) callback(members, botSeats);
  }

  /** Announce that the host is gone, once.
   *
   *  Both the explicit `hostLeft` message and the host connection closing
   *  land here, and a graceful host produces both — the message first, then
   *  the socket closing behind it. Latching means the client tears down on
   *  whichever arrives first and ignores the echo, so it never restarts a
   *  teardown that is already running. */
  private emitHostLeft(): void {
    if (this.role !== 'client' || this.hostLeftEmitted) return;
    this.hostLeftEmitted = true;
    const callback = this.onHostLeft;
    if (callback !== undefined) callback();
  }


  /** Publish this host's lobby to the public directory, and keep it fresh.
   *
   *  Public because the host's lobby-settings callback is bound just AFTER
   *  hostGame() resolves, so the first publish (fired the moment signaling
   *  opens) cannot know the map yet. The lobby flow calls this once more once
   *  the callbacks exist, which fills the listing in immediately rather than
   *  on the next heartbeat.
   *
   *  Handed to the publisher as a callback rather than a snapshot: the room
   *  code exists as soon as signaling opens, but the lobby settings that name
   *  the map are bound a moment later, so a snapshot taken at host time would
   *  advertise a lobby with no map and never correct itself.
   *
   *  Status is derived from `gameStarted` rather than passed in, so a roster
   *  change arriving after launch cannot flip a running game back to "open"
   *  and advertise a lobby that already rejects late joiners. */
  refreshLobbyListing(): void {
    if (this.role !== 'host' || this.roomCode === '') return;
    this.multiplayer.publishLobby(() => {
      if (this.role !== 'host' || this.roomCode === '') return null;
      // A host whose signaling socket is gone is undialable: a listing for it
      // is a door painted on a wall. Withholding the announcement stops the
      // heartbeat, the lease expires, and the room leaves the list — while a
      // successful reconnect resumes beating and the 404 recovery re-lists
      // it. This is what kept dead rooms visible "for a long time": the
      // publisher kept beating for a peer nobody could reach.
      const peer = this.peer;
      if (peer === null || peer.destroyed || peer.disconnected) return null;
      const hostName = this.getLocalPlayerName();
      // Map size is the one setting a browsing player can act on.
      const settings = this.readLobbySettings();
      const mapName =
        settings === undefined
          ? ''
          : `${settings.mapWidthLandCells}x${settings.mapLengthLandCells}`;
      return {
        roomCode: this.roomCode,
        // Whatever the host typed, falling back to their name — one rule,
        // shared with the lobby screen that shows the same title.
        name: resolveLobbyDisplayName(settings?.lobbyName ?? '', hostName),
        hostName,
        // Read off the lifecycle, so a roster change arriving after launch
        // cannot advertise a running match as joinable.
        status: sessionStatusFor(this.session.state),
        // Seats and benches are advertised apart: a running game with every
        // seat taken is still worth showing as watchable.
        playerCount: this.members.seatedPlayerIds().length,
        maxPlayers: MAX_LOBBY_PLAYERS,
        spectatorCount: this.members.spectatorCount(),
        mapName,
      };
    });
  }

  private emitLockstepMessage(
    message: NetworkLockstepMessage,
    from: LockstepMessageSource,
  ): void {
    const callback = this.lockstepMessageHandler;
    if (callback !== undefined) {
      callback(message, from);
      return;
    }
    if (this.pendingLockstepMessages.length >= LOCKSTEP_PENDING_MESSAGE_QUEUE_MAX) {
      shiftQueuedLockstepMessage(this.pendingLockstepMessages);
      this.droppedPendingLockstepMessages++;
    }
    this.pendingLockstepMessages.push({ message, from });
  }

  private drainPendingLockstepMessages(
    callback: (message: NetworkLockstepMessage, from: LockstepMessageSource) => void,
  ): void {
    if (this.pendingLockstepMessages.length === 0) return;
    const queued = this.pendingLockstepMessages.splice(0);
    for (const { message, from } of queued) {
      callback(message, from);
    }
  }

  getPendingLockstepMessageDiagnostics(): {
    readonly queued: number;
    readonly dropped: number;
  } {
    return {
      queued: this.pendingLockstepMessages.length,
      dropped: this.droppedPendingLockstepMessages,
    };
  }

  private emitGameStart(handoff: BattleHandoff, resume?: NetworkResumeContext): void {
    const callback = this.onGameStart;
    if (callback !== undefined) callback(handoff, resume);
  }

  private emitSeatAssignment(
    playerId: PlayerId | undefined,
    role: LobbyMemberRole,
  ): void {
    const callback = this.onSeatAssignment;
    if (callback !== undefined) callback(playerId, role);
  }

  private emitSeatedPeerSilent(playerId: PlayerId): void {
    const callback = this.onSeatedPeerSilent;
    if (callback !== undefined) callback(playerId);
  }

  private emitError(error: string): void {
    const callback = this.onError;
    if (callback !== undefined) callback(error);
  }

  private emitConnected(): void {
    const callback = this.onConnected;
    if (callback !== undefined) callback();
  }

  private emitLobbySettings(settings: LobbySettings): void {
    const callback = this.onLobbySettings;
    if (callback !== undefined) callback(settings);
  }


  private emitCommunication(event: NetworkCommunicationEvent): void {
    const callback = this.onCommunication;
    if (callback !== undefined) callback(event);
  }

  private readLobbySettings(): LobbySettings | undefined {
    const callback = this.getLobbySettings;
    return callback !== undefined ? callback() : undefined;
  }

  private createPeer(peerId: string, serverTarget: PeerServerTarget | null): Peer {
    return new Peer(peerId, { ...PEER_BASE_OPTIONS, ...(serverTarget ?? {}) });
  }

  private clearSignalingReconnect(): void {
    if (this.signalingReconnectTimer !== null) {
      clearTimeout(this.signalingReconnectTimer);
      this.signalingReconnectTimer = null;
    }
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeoutId !== null) {
      clearTimeout(this.setupTimeoutId);
      this.setupTimeoutId = null;
    }
  }

  private clearSendBudgetFlush(): void {
    if (this.sendBudgetFlushTimer !== null) {
      clearTimeout(this.sendBudgetFlushTimer);
      this.sendBudgetFlushTimer = null;
    }
  }

  private cancelPendingSetup(reason: string): void {
    const reject = this.pendingSetupReject;
    this.pendingSetupReject = null;
    if (reject !== null) reject(new Error(reason));
  }

  private beginNetworkSetup(): number {
    this.cancelPendingSetup('Network setup canceled');
    this.clearSignalingReconnect();
    this.clearSetupTimeout();
    this.clearSendBudgetFlush();
    this.signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
    this.sessionGeneration++;
    this.heartbeatTracker.stop();
    this.sendBudget.clear();
    this.lockstepTransport.clear();
    this.pendingLockstepMessages.length = 0;
    this.droppedPendingLockstepMessages = 0;
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    const existingPeer = this.peer;
    if (existingPeer !== null) existingPeer.destroy();
    this.peer = null;
    // A fresh session, not an edge: re-hosting, joining someone else and
    // disconnecting all land here, and each starts the lifecycle over.
    this.session.reset();
    this.hostLeftEmitted = false;
    // Withdraw before the peer is gone: every teardown path (disconnect,
    // re-host, joining someone else) passes through here, so the listing
    // never outlives the peer that backs it.
    this.multiplayer.withdrawLobby();
    return this.sessionGeneration;
  }

  private isCurrentSession(generation: number): boolean {
    return this.sessionGeneration === generation;
  }

  private markSignalingOpen(): void {
    this.clearSignalingReconnect();
    this.signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
  }

  private scheduleHostSignalingReconnect(reason: string): void {
    if (this.role !== 'host' || this.gameStarted) return;
    const peer = this.peer;
    if (!peer || peer.destroyed || !peer.disconnected) return;
    if (this.signalingReconnectTimer !== null) return;

    const delay = this.signalingReconnectDelayMs;
    console.warn(`[NET] Host signaling disconnected while lobby is open (${reason}); reconnecting in ${delay}ms`);
    this.signalingReconnectTimer = setTimeout(() => {
      this.signalingReconnectTimer = null;
      const currentPeer = this.peer;
      if (
        this.role !== 'host' ||
        this.gameStarted ||
        !currentPeer ||
        currentPeer.destroyed ||
        !currentPeer.disconnected
      ) {
        return;
      }

      try {
        currentPeer.reconnect();
        this.signalingReconnectDelayMs = Math.min(
          this.signalingReconnectDelayMs * 2,
          SIGNALING_RECONNECT_MAX_DELAY_MS,
        );
      } catch (err) {
        console.warn('[NET] Host signaling reconnect failed:', err);
        this.scheduleHostSignalingReconnect('reconnect failed');
      }
    }, delay);
  }

  /** Refresh what we know about OURSELVES (clock, stored name) and, on the
   *  host, re-announce if it changed. */
  private refreshLocalMemberInfo(announce = true): boolean {
    const changed = this.members.refreshLocalMemberInfo(this.localMemberId);
    if (changed && announce && this.role === 'host') this.broadcastLobbyRoster();
    return changed;
  }

  // Host a new game
  async hostGame(options: { visibility?: 'online' | 'local' } = {}): Promise<string> {
    const generation = this.beginNetworkSetup();
    this.sessionVisibility = options.visibility ?? 'online';
    this.session.send('connect');
    this.roomCode = generateRoomCode();
    this.role = 'host';
    this.members.clear();

    // The host creates the lobby, so the host is member 1 AND seat 1 on
    // TEAM 1 — the one member that never has to be seated by anybody. Its
    // name comes from whatever username is persisted locally (or a fresh
    // random pick on a first visit, persisted immediately so later loads are
    // stable); setLocalPlayerName edits and re-announces it.
    this.members.seedHost();
    this.localMemberId = HOST_MEMBER_ID;
    this.syncLocalSeat();

    // A LOCAL skirmish opens no signaling at all: nothing to dial, nothing
    // to list, nothing that needs the internet. The publisher's provider
    // already reports nothing while the peer is absent, so the directory
    // never hears about it, and with no peer there is no door to knock on.
    // Same lobby, same seating screen, same lockstep — just sealed.
    if (this.sessionVisibility === 'local') {
      this.roomCode = 'LOCAL';
      this.session.send('connected');
      this.emitRoster(this.members.toArray());
      return this.roomCode;
    }

    // Decided before the peer exists so the unavailable-id retry below
    // recreates its peer against the same server; a joiner resolving the
    // same probe is what lets it find this room.
    const serverTarget = await resolvePeerServerTarget();
    if (!this.isCurrentSession(generation)) throw new Error('Network setup canceled');

    return new Promise((resolve, reject) => {
      let resolved = false;
      const isCurrentPeer = (peer: Peer): boolean =>
        this.isCurrentSession(generation) && this.peer === peer;
      const settleResolve = (roomCode: string): void => {
        if (resolved) return;
        resolved = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        resolve(roomCode);
      };
      const settleReject = (error: Error): void => {
        if (resolved) return;
        resolved = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        reject(error);
      };
      this.pendingSetupReject = settleReject;

      const installHostPeerHandlers = (peer: Peer): void => {
        peer.on('open', () => {
          if (!isCurrentPeer(peer)) return;
          this.markSignalingOpen();
          this.heartbeatTracker.start();
          console.log('Host peer opened with ID:', peer.id);
          // Signaling has accepted us: the lobby is now real and can take
          // players, which is also what makes it worth advertising.
          this.session.send('connected');
          // Only list the lobby once the signaling server has actually
          // accepted us: before this point the room code is not dialable,
          // and advertising it would send joiners to a dead code.
          this.refreshLobbyListing();
          settleResolve(this.roomCode);
        });

        peer.on('connection', (conn) => {
          if (!isCurrentPeer(peer)) {
            conn.close();
            return;
          }
          this.handleIncomingConnection(conn, generation);
        });

        // While the lobby is open, the host must stay registered with
        // the signaling server so new computers can dial ba-ROOM.
        // Once a real battle starts, existing WebRTC data channels no
        // longer need the signaling socket.
        peer.on('disconnected', () => {
          if (!isCurrentPeer(peer)) return;
          console.log('Disconnected from signaling server');
          this.scheduleHostSignalingReconnect('host peer disconnected');
        });

        peer.on('error', (err) => {
          if (!isCurrentPeer(peer)) return;
          console.error('Peer error:', err);
          if (err.type === 'unavailable-id') {
            // Room code already in use, try another
            peer.destroy();
            this.roomCode = generateRoomCode();
            const retryPeer = this.createPeer(this.getUniversalGameId(), serverTarget);
            this.peer = retryPeer;
            installHostPeerHandlers(retryPeer);
          } else if (
            err.type === 'disconnected' ||
            err.type === 'network' ||
            err.type === 'server-error' ||
            err.type === 'socket-error' ||
            err.type === 'socket-closed'
          ) {
            settleReject(new Error('Could not connect to game server. Please try again.'));
          } else {
            this.emitError(err.message);
            settleReject(err);
          }
        });
      };

      // Timeout after 10 seconds. Stored on `this` so disconnect()
      // can cancel a setup attempt that's still in flight; without
      // that, a retry creates a fresh peer and the old timer fires
      // 10s later destroying the new one.
      this.clearSetupTimeout();
      this.setupTimeoutId = setTimeout(() => {
        this.setupTimeoutId = null;
        if (resolved || !this.isCurrentSession(generation)) return;
        const currentPeer = this.peer;
        if (currentPeer !== null) currentPeer.destroy();
        this.peer = null;
        settleReject(new Error('Connection timeout - signaling server may be unavailable'));
      }, 10000);

      // Use room code as peer ID prefix for discoverability.
      const peer = this.createPeer(this.getUniversalGameId(), serverTarget);
      this.peer = peer;
      installHostPeerHandlers(peer);
    });
  }

  // Join an existing game
  async joinGame(roomCode: string): Promise<void> {
    const generation = this.beginNetworkSetup();
    this.session.send('connect');
    this.roomCode = normalizeRoomCode(roomCode);
    this.role = 'client';
    this.members.clear();
    // A joiner is a WATCHER until the host seats it. Nobody joins straight
    // into a team, which is what makes the seated roster the host's alone
    // and makes "watch only, once it starts" fall out for free.
    this.localPlayerId = undefined;
    this.localRole = 'spectator';

    // The same probe the host ran: matching answers are what put joiner and
    // host on the same signaling server.
    const serverTarget = await resolvePeerServerTarget();
    if (!this.isCurrentSession(generation)) throw new Error('Network setup canceled');

    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const isCurrentPeer = (peer: Peer): boolean =>
        this.isCurrentSession(generation) && this.peer === peer;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        reject(error);
      };
      this.pendingSetupReject = settleReject;

      // Generate a random ID for the client
      const clientId = `ba-client-${Math.random().toString(36).substring(2, 10)}`;
      const peer = this.createPeer(clientId, serverTarget);
      this.peer = peer;

      peer.on('open', () => {
        if (!isCurrentPeer(peer)) return;
        console.log('Client peer opened, connecting to host...');

        // Everything the host has to know BEFORE it grants anything rides
        // the connection itself: there is no earlier channel. A seat token
        // from a previous connection is how a returning player reclaims its
        // army instead of arriving as a stranger.
        const conn = peer.connect(this.getUniversalGameId(), {
          reliable: true,
          metadata: {
            protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
            seatToken: this.localSeatToken,
          },
        });

        this.connections.set(HOST_MEMBER_ID, conn); // The host is always member 1
        this.setupConnectionHandlers(conn, HOST_MEMBER_ID, generation);

        conn.on('open', () => {
          if (
            !this.isCurrentSession(generation) ||
            this.connections.get(HOST_MEMBER_ID) !== conn
          ) {
            return;
          }
          opened = true;
          this.session.send('connected');
          console.log('Connected to host');
          // Track host's heartbeats — if the host stops sending
          // for too long, the check loop closes our side of the
          // connection and the host-left path fires.
          this.heartbeatTracker.track(HOST_MEMBER_ID);
          this.heartbeatTracker.start();
          this.emitConnected();
          settleResolve();
        });

        conn.on('error', (err) => {
          if (
            !this.isCurrentSession(generation) ||
            this.connections.get(HOST_MEMBER_ID) !== conn
          ) {
            return;
          }
          console.error('Connection error:', err);
          this.emitError('Failed to connect to host');
          settleReject(err);
        });
      });

      // Handle disconnection from signaling server (OK once connected to host)
      peer.on('disconnected', () => {
        if (!isCurrentPeer(peer)) return;
        console.log('Client disconnected from signaling server (P2P still works)');
      });

      peer.on('error', (err) => {
        if (!isCurrentPeer(peer)) return;
        console.error('Peer error:', err);
        // Ignore signaling server disconnection errors
        if (err.type === 'disconnected' || err.type === 'network') {
          console.log('Signaling server issue (P2P connections still work)');
          return;
        }
        if (err.type === 'peer-unavailable') {
          this.emitError('Game not found - check the code and try again');
          peer.destroy();
          if (this.peer === peer) this.peer = null;
          settleReject(new Error('Game not found'));
          return;
        }
        this.emitError(err.message);
        settleReject(err);
      });

      // Timeout after 10 seconds. Stored on `this` (see hostGame for
      // the same pattern) so disconnect() can cancel an in-flight
      // attempt and avoid destroying a newly-created peer 10s later.
      this.clearSetupTimeout();
      this.setupTimeoutId = setTimeout(() => {
        this.setupTimeoutId = null;
        if (opened || settled || !isCurrentPeer(peer)) return;
        peer.destroy();
        if (this.peer === peer) this.peer = null;
        settleReject(new Error('Connection timeout - room may not exist'));
      }, 10000);
    });
  }

  /**
   * Admit a connection (host only).
   *
   * Everyone is admitted as a WATCHER. The host is the only one who can put
   * anybody on a team, so admission never has to decide a seat — which is
   * also why a running match can keep taking connections: a watcher holds no
   * seat, contributes no command frames, and can never hold the match up.
   *
   * The one exception is a returning player MID-MATCH: a connection
   * presenting a seat token this session issued reclaims that exact seat,
   * army and side, because its army is still being simulated and the match
   * may be holding for it. In the LOBBY the exception does not apply — the
   * host is the only seater there, so every arrival lands on the bench and
   * the host decides, token or no token.
   */
  private handleIncomingConnection(
    conn: DataConnection,
    generation = this.sessionGeneration,
  ): void {
    if (!this.isCurrentSession(generation)) {
      conn.close();
      return;
    }
    if (!admitsSpectators(this.session.state)) {
      // Not a lobby and not a running match — nothing to attach to.
      this.refuseConnection(conn, 'session-closed', 'This session is no longer accepting anyone.');
      return;
    }

    const metadata = readConnectionMetadata(conn.metadata);
    if (metadata.protocolVersion !== LOCKSTEP_PROTOCOL_VERSION) {
      // One build, one contract. A version mismatch is refused at the door
      // rather than half-working — see "No legacy fallbacks". Saying so is
      // the difference between "update your game" and an evening spent
      // blaming the network.
      this.refuseConnection(
        conn,
        'protocol-mismatch',
        'That build speaks a different version of this game. Reload to update.',
      );
      return;
    }

    // Tokens reclaim only while the match RUNS. In the lobby the host is the
    // only seater, so a token from the last match cannot silently take a
    // seat the host is in the middle of handing out.
    const reclaimedSeat = this.gameStarted
      ? this.members.seatForToken(metadata.seatToken)
      : null;
    if (reclaimedSeat === null && !this.members.canAdmitSpectator()) {
      // The bench is full. Seats are capped separately, by the seat table.
      this.refuseConnection(conn, 'session-full', 'This game has no room left to watch.');
      return;
    }

    const memberId = this.members.nextFreeMemberId();
    if (memberId === null) {
      this.refuseConnection(conn, 'session-full', 'This game is full.');
      return;
    }

    this.connections.set(memberId, conn);
    this.setupConnectionHandlers(conn, memberId, generation);

    conn.on('open', () => {
      if (!this.isCurrentSession(generation) || this.connections.get(memberId) !== conn) return;

      this.heartbeatTracker.track(memberId);
      this.heartbeatTracker.start();

      const member = this.members.admit(memberId, getDefaultPlayerName(memberId as PlayerId));
      if (reclaimedSeat !== null) {
        this.members.reclaimSeat(memberId, reclaimedSeat);
        // They are back. Tell whoever is holding the match for them, so the
        // pause can lift once they have actually caught up.
        this.onSeatedPeerReturned?.(reclaimedSeat);
      }
      console.log(
        `[NET] member ${memberId} attached as ${member.role}` +
          (member.playerId === undefined ? '' : ` (seat ${member.playerId})`),
      );

      // Tell that one connection who it is. The seat token goes only here —
      // it is that member's handle on its own seat and belongs to nobody
      // else, so it never appears in the roster everyone receives.
      this.sendTo(memberId, {
        type: 'sessionAssignment',
        gameId: this.getUniversalGameId(),
        memberId,
        role: member.role,
        playerId: member.playerId,
        allyTeamId: member.allyTeamId,
        seatToken: member.playerId === undefined
          ? undefined
          : this.members.seatTokenFor(member.playerId),
        matchInProgress: this.gameStarted,
      });

      this.refreshLocalMemberInfo(false);
      // One announcement, whole list, everyone — including the joiner, which
      // is how it learns about members that were already here.
      this.broadcastLobbyRoster();

      // Bring the new member up to date on the host's current lobby settings.
      // Without this initial push it would render its own stored terrain in
      // the preview pane until the host happened to change something.
      const settings = this.readLobbySettings();
      if (settings) {
        this.sendTo(memberId, {
          type: 'lobbySettings',
          gameId: this.getUniversalGameId(),
          settings,
        });
      }
    });
  }

  /**
   * Turn a connection away with a reason it can show.
   *
   * The message has to wait for `open` — there is no channel before that —
   * and the socket closes immediately behind it. A refusal that arrives as a
   * dead socket is indistinguishable from a network fault, and the commonest
   * real cause is a stale build, which is exactly the thing a player can fix
   * if anybody tells them.
   */
  private refuseConnection(
    conn: DataConnection,
    reason: SessionRefusalReason,
    detail: string,
  ): void {
    console.warn(`[NET] refusing connection (${reason}): ${detail}`);
    conn.on('open', () => {
      this.rawSend(conn, {
        type: 'sessionRefused',
        gameId: this.getUniversalGameId(),
        reason,
        detail,
      });
      // Give the message a tick to leave before the socket goes.
      setTimeout(() => conn.close(), 250);
    });
  }

  // Setup handlers for a connection
  private setupConnectionHandlers(
    conn: DataConnection,
    memberId: MemberId,
    generation = this.sessionGeneration,
  ): void {
    conn.on('data', (data) => {
      if (!this.isCurrentSession(generation) || this.connections.get(memberId) !== conn) return;
      const message = data as NetworkMessage;
      this.handleMessage(message, memberId);
    });

    conn.on('close', () => {
      if (!this.isCurrentSession(generation) || this.connections.get(memberId) !== conn) return;
      console.warn(`[NET] member ${memberId} connection CLOSED (role=${this.role})`);
      this.connections.delete(memberId);
      this.sendBudget.clearConnection(conn);
      this.heartbeatTracker.untrack(memberId);

      if (this.role === 'host') {
        const seat = this.seatForMember(memberId);
        if (seat !== undefined && this.gameStarted) {
          // A SEATED player leaving mid-match does not vacate anything. Its
          // army is still being simulated by everyone, so the seat is held
          // open for a rejoin and the simulation is never told. The only way
          // a player leaves the match is an explicit, frame-scheduled
          // `resign` (see the flow-control policy).
          this.members.markAwaitingRejoin(memberId);
          this.emitSeatedPeerSilent(seat);
        } else {
          this.members.delete(memberId);
        }
        this.broadcastLobbyRoster();
      }

      // A client that loses member 1 has lost the host, and with it the
      // frame coordinator and every route to the other members. There is no
      // session left to sit in, so eject rather than leave the player in a
      // lobby or battle that can no longer progress.
      if (this.role === 'client' && memberId === HOST_MEMBER_ID) {
        this.emitHostLeft();
      }
    });

    conn.on('error', (err) => {
      if (!this.isCurrentSession(generation) || this.connections.get(memberId) !== conn) return;
      console.error(`[NET] Connection error with member ${memberId}:`, err);
    });
  }

  private isMessageForCurrentGame(gameId: string | undefined): boolean {
    return gameId === undefined || gameId === this.getUniversalGameId();
  }

  private nextCommunicationEventId(memberId: MemberId, clientEventId: string): string {
    this.communicationSequence++;
    return `${this.getUniversalGameId()}:${memberId}:${this.communicationSequence}:${clientEventId}`;
  }

  /**
   * Which room a member is speaking in.
   *
   * In the lobby everybody shares one — deciding who plays is a conversation
   * everyone is part of. In battle the sender chooses, BAR-style: ALL is the
   * public room everybody hears, watchers included; TEAM resolves by roster
   * (allies for a seat, the bench for a watcher). The team/bench split is not
   * a style preference — a watcher sees the whole map, so a live channel from
   * the bench to one player would be a coaching channel. ALL is public, so
   * there is nothing to whisper.
   */
  private communicationChannelFor(
    memberId: MemberId,
    requested: 'all' | 'team',
  ): NetworkCommunicationChannel {
    if (!this.gameStarted) return 'all';
    if (requested === 'all') return 'all';
    return this.members.get(memberId)?.playerId === undefined ? 'spectators' : 'team';
  }

  /** Whether a member should receive something said in `channel` by `sender`. */
  private receivesCommunication(
    memberId: MemberId,
    channel: NetworkCommunicationChannel,
    senderMemberId: MemberId,
  ): boolean {
    if (channel === 'all') return true;
    const listener = this.members.get(memberId);
    if (listener === undefined) return false;
    if (channel === 'spectators') return listener.playerId === undefined;
    const sender = this.members.get(senderMemberId);
    if (sender === undefined || listener.playerId === undefined) return false;
    return listener.allyTeamId === sender.allyTeamId;
  }

  private sanitizeCommunicationDraft(
    data: NetworkCommunicationDraft,
    fromPlayerId: PlayerId,
    channel: NetworkCommunicationChannel,
  ): NetworkCommunicationEvent | null {
    if (data.kind !== 'chat') return null;
    const createdAtMs = Date.now();
    const clientEventId = typeof data.clientEventId === 'string'
      ? data.clientEventId.slice(0, 64)
      : 'event';
    const id = this.nextCommunicationEventId(fromPlayerId, clientEventId);
    const text = sanitizeCommunicationText(data.text, COMMUNICATION_CHAT_MAX_LENGTH);
    if (text === null) return null;
    return {
      kind: 'chat',
      id,
      channel,
      senderPlayerId: fromPlayerId,
      createdAtMs,
      text,
    };
  }

  private relayCommunicationDraft(
    data: NetworkCommunicationDraft,
    fromMemberId: MemberId,
  ): void {
    const channel = this.communicationChannelFor(
      fromMemberId,
      data.kind === 'chat' && data.channel === 'all' ? 'all' : 'team',
    );
    // Attributed by SEAT where there is one, so a player's name resolves the
    // way it does everywhere else. A watcher has none; the bench is its own
    // room and the member id is enough to name a speaker inside it.
    const senderPlayerId = this.seatForMember(fromMemberId) ?? (fromMemberId as PlayerId);
    const event = this.sanitizeCommunicationDraft(data, senderPlayerId, channel);
    if (event === null) return;

    // The host is a member too, so it only hears what it is in the room for.
    if (this.receivesCommunication(this.localMemberId, channel, fromMemberId)) {
      this.emitCommunication(event);
    }
    const message: NetworkMessage = {
      type: 'communicationEvent',
      gameId: this.getUniversalGameId(),
      data: event,
    };
    for (const [memberId, conn] of this.connections) {
      if (!this.receivesCommunication(memberId, channel, fromMemberId)) continue;
      this.safeSend(conn, message);
    }
  }

  // Handle incoming message
  private handleMessage(message: NetworkMessage, fromMemberId: MemberId): void {
    // Any inbound message is also a sign of life — refresh the
    // heartbeat-received timestamp for this peer regardless of
    // type. That prevents the timeout sweep from kicking peers
    // who are sending plenty of lockstep or communication traffic but
    // happen to skip a heartbeat tick.
    this.heartbeatTracker.markReceived(fromMemberId);
    // Heard from again: a peer that missed a couple of beats under load was
    // never really gone.
    if (this.role === 'host' && this.members.markHeard(fromMemberId)) {
      this.broadcastLobbyRoster();
      const seat = this.seatForMember(fromMemberId);
      if (seat !== undefined) this.onSeatedPeerReturned?.(seat);
    }

    // The resume grant is the one lockstep message that must NOT go to the
    // battle backend, because the point of it is that this client does not
    // have one yet. It carries the handoff we boot from, so it is handled
    // here and turns into an ordinary game start.
    if (
      message.type === 'lockstepResumeGrant' &&
      this.role === 'client' &&
      this.isMessageForCurrentGame(message.gameId)
    ) {
      this.beginResumeFromGrant(message);
      return;
    }

    this.pendingLockstepSenderMemberId = fromMemberId;
    if (this.lockstepTransport.handleMessage(message, this.seatForMember(fromMemberId))) {
      return;
    }
    switch (message.type) {
      case 'heartbeat':
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        if (this.role === 'host' && message.memberInfo) {
          if (this.members.applyMemberInfo(fromMemberId, message.memberInfo)) {
            this.broadcastLobbyRoster();
          }
        } else if (this.role === 'client' && message.members) {
          // Heartbeats echo the member list for freshness but do not carry
          // bot seats; keep the ones the last full rosterUpdate announced.
          this.adoptRoster(message.members, this.members.botSeatsList());
        }
        return;

      case 'communication':
        if (this.role !== 'host') return;
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        this.relayCommunicationDraft(message.data, fromMemberId);
        break;

      case 'communicationEvent':
        if (this.role !== 'client') return;
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        this.emitCommunication(message.data);
        break;

      case 'memberInfo':
        // Host: a member is reporting its own IP/location/tz lookup and/or a
        // rename. Nothing it can say moves a seat — the payload has no field
        // for one — so this folds straight into the record and re-announces.
        if (this.role === 'host') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          if (this.members.applyMemberInfo(fromMemberId, message)) {
            this.broadcastLobbyRoster();
          }
        }
        break;

      case 'sessionAssignment':
        // Client learns who it is. Arrives once, on admission.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          this.localMemberId = message.memberId;
          // Absent arrives as null, not undefined — see normalizeWireOptional.
          this.localPlayerId = normalizeWireOptional(message.playerId);
          this.localRole = message.role;
          if (message.seatToken !== undefined) this.setLocalSeatToken(message.seatToken);
          this.emitSeatAssignment(message.playerId, message.role);
          if (message.matchInProgress) {
            // We joined a battle already under way. Ask to be let in; the
            // grant carries the handoff we boot from and the frame we must
            // replay up to. Nothing is rendered until we get there.
            this.session.send('start');
            this.lockstepTransport.sendResumeRequest(
              this.localMemberId,
              this.localPlayerId,
              -1,
            );
          }
        }
        break;

      case 'rosterUpdate':
        if (this.role !== 'client') return;
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        this.applyLobbyAllyTeamCount(message.allyTeamCount);
        this.adoptRoster(message.members, message.botSeats ?? []);
        break;

      case 'gameStart':
        // Client receives game start signal
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          const assignedSeat = normalizeWireOptional(message.assignedPlayerId);
          this.localPlayerId = assignedSeat;
          this.localRole = assignedSeat === undefined ? 'spectator' : 'player';
          this.emitSeatAssignment(this.localPlayerId, this.localRole);
          const handoff = normalizeBattleHandoffMessage(
            {
              gameId: message.gameId,
              playerIds: message.playerIds,
              handoff: message.handoff,
            },
          );
          this.session.send('start');
          console.log(
            `[NET] Game start as ${this.localRole}` +
              (this.localPlayerId === undefined ? '' : ` (seat ${this.localPlayerId})`) +
              `; players=${handoff.playerIds.join(',')}`,
          );
          this.emitGameStart(handoff);
        }
        break;

      case 'hostLeft':
        // Only the host can say this, and only to a client.
        if (this.role !== 'client' || fromMemberId !== HOST_MEMBER_ID) return;
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        this.emitHostLeft();
        break;

      case 'returnToLobby':
        // Only the host controls the game-room state, so only the host
        // connection may say this — and the machine is the second guard: a
        // client whose battle never started has nothing to return from.
        if (this.role !== 'client' || fromMemberId !== HOST_MEMBER_ID) return;
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        if (!this.session.send('returnToLobby')) return;
        this.onReturnToLobby?.();
        break;

      case 'lobbySettings':
        // Only meaningful client-side — the host owns the source
        // of truth and never broadcasts to itself.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          assertCurrentLobbySettings(message.settings, 'lobby settings packet');
          this.emitLobbySettings(message.settings);
        }
        break;

      case 'sessionRefused':
        // The host turned us away and said why. Report it before the socket
        // closes behind it, or the player sees a generic connection failure.
        if (this.role === 'client') {
          this.emitError(message.detail);
        }
        break;
    }
  }

  /**
   * Boot into a match that is already running.
   *
   * The handoff inside the grant is byte-identical to the one the frame-0
   * peers received, so this hands it to the ORDINARY start path — there is no
   * separate late-joiner initialization that could drift from the real one.
   * What is different rides alongside as the resume context: the frame to
   * replay up to, and the coordinator's checksum to verify against before
   * this client is allowed to render.
   */
  private beginResumeFromGrant(message: LockstepResumeGrantMessage): void {
    let handoff: BattleHandoff;
    try {
      handoff = normalizeBattleHandoffMessage({
        gameId: message.handoff.gameId,
        playerIds: [...message.handoff.playerIds],
        handoff: message.handoff,
      });
    } catch (err) {
      // A handoff we cannot reproduce means we would simulate a different
      // match. Refuse rather than join and desync.
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[NET] refusing resume grant:', detail);
      this.emitError(`Could not join the battle in progress: ${detail}`);
      return;
    }
    console.log(
      `[NET] resuming into a running battle as ${this.localRole}` +
        (this.localPlayerId === undefined ? '' : ` (seat ${this.localPlayerId})`) +
        `; replaying to frame ${message.grantFrame}`,
    );
    this.emitGameStart(handoff, {
      grantFrame: message.grantFrame,
      archiveThroughFrame: message.archiveThroughFrame,
      verifyFrame: message.verifyFrame,
      verifyStateHash: message.verifyStateHash,
    });
  }

  /** Client: take the host's announcement whole. There is nothing to merge,
   *  which is the point — a partial roster applied in the wrong order is how
   *  two clients came to disagree about where the same player sat. */
  private adoptRoster(
    members: readonly LobbyMember[],
    botSeats: readonly LobbyBotSeat[],
  ): void {
    this.members.replaceAll(members, botSeats);
    this.syncLocalSeat();
    this.emitRoster(this.members.toArray(), this.members.botSeatsList());
  }

  /** Host: ship the current lobby settings to every connected
   *  client. Caller invokes this whenever a host-controlled lobby
   *  setting changes (terrain shape today, future knobs later).
   *  No-op on clients. */
  broadcastLobbySettings(settings: LobbySettings): void {
    if (this.role !== 'host') return;
    this.broadcast({
      type: 'lobbySettings',
      gameId: this.getUniversalGameId(),
      settings,
    });
  }

  private buildHeartbeatMessage(): NetworkMessage {
    this.refreshLocalMemberInfo(false);
    return {
      type: 'heartbeat',
      gameId: this.getUniversalGameId(),
      memberId: this.localMemberId,
      memberInfo: this.members.buildLocalMemberInfo(this.localMemberId),
      members: this.role === 'host' ? this.members.toArray() : undefined,
    };
  }

  /** Report the LOCAL member's IP / location / timezone and current username.
   *  On the host this updates its own record and re-announces the roster; on
   *  a client it ships a `memberInfo` to the host, which does the
   *  announcing. Called once the IP lookup resolves; timezone is available
   *  immediately so it rides along on the same call. */
  reportLocalPlayerInfo(
    ipAddress: string | undefined,
    location: string | undefined,
    timezone: string | undefined,
  ): void {
    const payload = this.members.buildReportedLocalMemberInfo(
      ipAddress,
      location,
      timezone,
    );
    const changed = this.members.applyMemberInfo(this.localMemberId, payload);
    if (this.role === 'host') {
      if (changed) this.broadcastLobbyRoster();
      return;
    }
    if (this.role !== 'client') return;
    if (changed) this.emitRoster(this.members.toArray());
    const hostConn = this.connections.get(HOST_MEMBER_ID);
    if (hostConn) {
      this.safeSend(hostConn, {
        type: 'memberInfo',
        gameId: this.getUniversalGameId(),
        ...payload,
      });
    }
  }

  /** Set the LOCAL member's username. Persists to localStorage so it survives
   *  reloads, updates the local record, and (when networked) reaches everyone
   *  through the host's roster announcement. Trims and length-caps to match
   *  what saveUsername stores. */
  setLocalPlayerName(name: string): void {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed.length === 0) return;
    saveUsername(trimmed);
    const payload = this.members.buildLocalMemberInfo(this.localMemberId);
    payload.name = trimmed;
    const changed = this.members.applyMemberInfo(this.localMemberId, payload);

    if (this.role === 'host') {
      if (changed) this.broadcastLobbyRoster();
      // The listing is titled after the host, so renaming retitles it.
      this.refreshLobbyListing();
      return;
    }
    if (this.role !== 'client') return;
    if (changed) this.emitRoster(this.members.toArray());
    const hostConn = this.connections.get(HOST_MEMBER_ID);
    if (hostConn) {
      this.safeSend(hostConn, {
        type: 'memberInfo',
        gameId: this.getUniversalGameId(),
        ...payload,
      });
    }
  }

  /** Whatever the local member is currently called, falling back to the
   *  deterministic-by-id default if the roster has not populated yet. */
  getLocalPlayerName(): string {
    return this.members.getLocalMemberName(this.localMemberId);
  }

  // Send a message to one member (host only)
  private sendTo(memberId: MemberId, message: NetworkMessage): boolean {
    const conn = this.connections.get(memberId);
    return conn ? this.safeSend(conn, message) : false;
  }

  // Send to every connected member — watchers included. This is the DELIVERY
  // set; nothing may use it to decide whether a lockstep frame is complete.
  private broadcast(message: NetworkMessage, excludeMemberId: MemberId | undefined = undefined): void {
    for (const [memberId, conn] of this.connections) {
      if (memberId !== excludeMemberId) {
        this.safeSend(conn, message);
      }
    }
  }

  private safeSend(conn: DataConnection, message: NetworkMessage): boolean {
    return this.sendBudget.send(conn, message, this.rawSendCallback);
  }

  private rawSend(conn: DataConnection, message: NetworkMessage): boolean {
    if (!conn.open) return false;
    try {
      conn.send(message);
      return true;
    } catch (err) {
      console.warn('[NET] Failed to send message:', err);
      return false;
    }
  }

  private scheduleSendBudgetFlush(): void {
    if (this.sendBudgetFlushTimer !== null) return;
    this.sendBudgetFlushTimer = setTimeout(() => {
      this.sendBudgetFlushTimer = null;
      const hasPending = this.sendBudget.flushPending(
        this.connections.values(),
        this.rawSendCallback,
      );
      if (hasPending) this.scheduleSendBudgetFlush();
    }, 100);
  }

  getSendBudgetTelemetry(): NetworkSendBudgetTelemetry {
    return this.sendBudget.getTelemetry();
  }

  getLockstepTransport(): NetworkLockstepTransport {
    return this.lockstepTransport;
  }

  sendCommunication(data: NetworkCommunicationDraft): void {
    if (this.role === 'host') {
      this.relayCommunicationDraft(data, this.localMemberId);
      return;
    }
    if (this.role !== 'client') return;
    const hostConn = this.connections.get(HOST_MEMBER_ID);
    if (!hostConn) return;
    this.safeSend(hostConn, {
      type: 'communication',
      gameId: this.getUniversalGameId(),
      data,
    });
  }

  // Start the game (host only)
  startGame(): void {
    if (this.role !== 'host') return;
    // The transition IS the guard. `start` is only legal from `lobby`, so a
    // second Start click, or one arriving before signaling opened, is refused
    // here rather than by a separate already-started flag.
    if (!this.session.send('start')) return;
    this.clearSignalingReconnect();

    // SEAT truth, bots included. The old connection-derived list was the
    // wrong universe under the member/seat model: member ids are not seat
    // ids, and a connected WATCHER would have been counted as a player.
    const playerIds = this.members.seatedPlayers().map((player) => player.playerId);

    // 1-player real games are first-class — they spawn exactly one
    // commander, one base, one team. The same code path that handles
    // 2/4/6/N players runs here too; no fork that injects a fake
    // second team / second commander.

    const settings = this.readLobbySettings();
    if (settings === undefined) {
      throw new Error('[network] current battle handoff requires lobby settings');
    }
    const handoff = buildBattleHandoff({
      gameId: this.getUniversalGameId(),
      roomCode: this.getRoomCode(),
      playerIds,
      players: this.members.seatedPlayers(),
      // The two seat axes (src/game/sim/agentSeat.ts), straight from the
      // roster into the HASHED initialization: who the sim drives, and who
      // opens with a base.
      aiPlayerIds: this.members.botSeatPlayerIds(),
      baseSeatPlayerIds: this.members.baseSeatPlayerIds(),
      // The lobby's TEAM assignment decides terrain slices, spawn arcs and
      // who may shoot whom, so it travels inside the HASHED initialization.
      // Leaving it out here is what used to make every online match a
      // free-for-all no matter what the roster showed.
      allyTeamByPlayerId: this.members.allyTeamByPlayerId(),
      allyTeamCount: this.allyTeamCount,
      settings,
    });

    // The lobby stops accepting joiners here but stays in the directory as a
    // running game — that is the other half of what the directory shows.
    this.refreshLobbyListing();

    for (const [memberId, conn] of this.connections) {
      this.safeSend(conn, {
        type: 'gameStart',
        gameId: handoff.gameId,
        playerIds: handoff.playerIds,
        handoff,
        // The member's SEAT, not its member id — the two number spaces are
        // separate, and a member whose id drifted from its seat used to be
        // handed somebody else's army here. Watchers get undefined.
        assignedPlayerId: this.members.get(memberId)?.playerId,
      });
    }
    this.emitGameStart(handoff);
  }

  /**
   * End the battle and return the WHOLE room to its seating screen
   * (host only). The mirror of startGame(): the transition is the guard —
   * `returnToLobby` is only legal from `playing`, so a stray click in a
   * lobby, or a stale one after the session ended, is refused by the table.
   *
   * The session survives. Nobody disconnects, seats and roster stay, and the
   * lobby re-advertises as open; what does NOT survive is a seat being HELD
   * for a mid-match rejoin — the match it was reserved for is over, and in
   * the lobby the host is the only seater.
   */
  returnToLobby(): void {
    if (this.role !== 'host') return;
    if (!this.session.send('returnToLobby')) return;

    const connected = new Set(this.connections.keys());
    this.members.resetPresenceForLobby(connected, this.localMemberId);

    // Say it while the battle handlers are still attached, then re-announce
    // the (possibly pruned) roster and re-open the directory listing.
    this.broadcast({ type: 'returnToLobby', gameId: this.getUniversalGameId() });
    this.broadcastLobbyRoster();
    this.refreshLobbyListing();
    this.onReturnToLobby?.();
  }

  // Getters
  getRole(): NetworkRole | null {
    return this.role;
  }

  getRoomCode(): string {
    return this.roomCode;
  }

  getUniversalGameId(): string {
    return roomCodeToGameId(this.roomCode);
  }

  /** The SEAT this client holds, or undefined while it is watching. */
  getLocalPlayerId(): PlayerId | undefined {
    return this.localPlayerId;
  }

  getLocalMemberId(): MemberId {
    return this.localMemberId;
  }

  getLocalRole(): LobbyMemberRole {
    return this.localRole;
  }

  /** Everyone attached, watchers included. */
  getMembers(): LobbyMember[] {
    return this.members.toArray();
  }

  /** Only the members that hold a seat, as the match sees them. */
  getPlayers(): LobbyPlayer[] {
    return this.members.seatedPlayers();
  }

  // Disconnect and cleanup
  disconnect(): void {
    // Tell the clients why, while there is still a connection to say it on.
    // beginNetworkSetup closes every connection, so this cannot wait: after
    // it, clients would only learn from the socket dropping and could not
    // tell a deliberate exit from a network failure.
    if (this.role === 'host') {
      this.broadcast({ type: 'hostLeft', gameId: this.getUniversalGameId() });
    }
    this.beginNetworkSetup();
    this.role = null;
    this.members.clear();
    this.localMemberId = HOST_MEMBER_ID;
    this.localPlayerId = undefined;
    this.localRole = 'spectator';
    // The token belonged to a seat in a session that no longer exists.
    this.setLocalSeatToken(undefined);

    // Clear all callbacks to release closure references
    this.onRoster = undefined;
    this.onHostLeft = undefined;
    this.onReturnToLobby = undefined;
    this.onGameStart = undefined;
    this.onSeatAssignment = undefined;
    this.onSeatedPeerSilent = undefined;
    this.onSeatedPeerReturned = undefined;
    this.onError = undefined;
    this.onConnected = undefined;
    this.onLobbySettings = undefined;
    this.getLobbySettings = undefined;
    this.onCommunication = undefined;
    this.onLockstepMessage = undefined;
  }

}

// Singleton instance
export const networkManager = new NetworkManager();
