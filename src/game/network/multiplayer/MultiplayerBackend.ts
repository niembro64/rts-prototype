/**
 * The seam between "how players find and reach each other" and everything
 * that depends on it.
 *
 * Two answers are in play. The **native** backend is what runs on
 * games.niemo.io today: lobbies are published to web_games_backend and peers
 * connect over WebRTC through PeerJS. The **Steam** backend is the desktop
 * answer: Steam owns the lobby list and carries the traffic itself, so there
 * is no directory of ours to publish to and no room code to read aloud.
 *
 * Those differ in almost every detail, and the parts of the game that care
 * about lobbies should not have to know which is in play. So the surface here
 * is written in terms of what the game actually needs — advertise a session,
 * find the open ones, keep the advertisement alive, take it down — and each
 * backend answers in its own terms behind that.
 *
 * What deliberately does NOT belong here: the session's own state. Whether a
 * session is open or already playing is a property of the match, not of the
 * matchmaking service, so it is modelled once (`SessionLifecycle`) and handed
 * to whichever backend is active.
 */

import { createStateMachine, type StateMachine } from '../../state/StateMachine';

export type MultiplayerBackendId = 'native' | 'steam';

/** What a browsing player sees about somebody else's session. */
export type MultiplayerLobbySummary = {
  readonly roomCode: string;
  readonly name: string;
  readonly hostName: string;
  readonly status: SessionStatus;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly maxSpectators: number;
  readonly mapName: string;
  /** Epoch ms the session was first advertised. */
  readonly createdAt: number;
};

/** What a host advertises about its own session. */
export type MultiplayerLobbyAdvert = {
  readonly roomCode: string;
  readonly name: string;
  readonly hostName: string;
  readonly status: SessionStatus;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly mapName: string;
};

/**
 * Whether a session is still taking players.
 *
 * Kept to exactly the distinction a browsing player can act on. Richer
 * lifecycle detail belongs to `SessionLifecycle`, which is the game's own
 * business and not something a matchmaking service needs to model.
 */
export type SessionStatus = 'open' | 'in-game';

export interface MultiplayerBackend {
  readonly id: MultiplayerBackendId;

  /**
   * Whether this backend can be used in the current runtime.
   *
   * Honest, not aspirational: the Steam backend reports false in a browser
   * and in a desktop build with no Steam client attached, so callers can pick
   * a working backend instead of discovering the failure at connect time.
   */
  isAvailable(): boolean;

  /** Human-readable reason `isAvailable()` returned false, for diagnostics. */
  unavailableReason(): string | null;

  /**
   * Every session currently advertised, newest first.
   *
   * Best-effort by contract: a backend that cannot reach its directory
   * returns an empty list rather than throwing. Lobby discovery is a
   * convenience layered on top of joining by code, and it must never be able
   * to break the flow that already worked without it.
   */
  listLobbies(): Promise<readonly MultiplayerLobbySummary[]>;

  /**
   * Begin advertising this host's session, and keep it advertised.
   *
   * `describe` is pulled from on a cadence the backend chooses rather than
   * taken once, because the facts drift — seats fill, the match starts, and
   * on the native backend the advert is a lease that must be renewed anyway.
   * Returning null from it means "nothing to advertise right now".
   */
  publishLobby(describe: () => MultiplayerLobbyAdvert | null): void;

  /** Stop advertising and remove the listing. Safe to call when not
   *  publishing — taking down an advert that is already gone is success. */
  withdrawLobby(): void;
}

// ── Session lifecycle ────────────────────────────────────────────────────

/**
 * The states a multiplayer session passes through, on either backend.
 *
 * Written as one explicit machine because the previous shape — a `role`, a
 * `gameStarted` flag, a `hostLeftEmitted` latch, an `isConnecting` ref — put
 * the real states in the combinations of four booleans, including the several
 * that should never occur. The questions that matter ("can a late joiner
 * still be admitted?", "may this session still start?", "has it already
 * ended?") are answered by the table rather than by an audit of the flags.
 */
export type SessionState =
  /** Not in a session at all. */
  | 'idle'
  /** Standing up or dialling into one; no roster yet. */
  | 'connecting'
  /** In the lobby. The only state that admits a new SEATING. */
  | 'lobby'
  /** The match is running: no new seats, but watchers are still admitted. */
  | 'playing'
  /** Over — left, kicked, or the host went away. Terminal until reset. */
  | 'ended';

export type SessionEvent =
  | 'connect'
  | 'connected'
  | 'start'
  | 'end'
  | 'fail';

export type SessionLifecycle = StateMachine<SessionState, SessionEvent>;

export function createSessionLifecycle(
  onTransition?: (change: { from: SessionState; to: SessionState; event: SessionEvent }) => void,
): SessionLifecycle {
  return createStateMachine<SessionState, SessionEvent>({
    name: 'session',
    initial: 'idle',
    transitions: {
      idle: { connect: 'connecting' },
      // A failed connect returns to idle so the player can retry; a
      // successful one opens the lobby.
      connecting: { connected: 'lobby', fail: 'idle', end: 'ended' },
      // Starting is one-way. Nothing returns a running match to the lobby,
      // which is what makes "no new seats once it starts" a state question
      // rather than a separate flag.
      lobby: { start: 'playing', end: 'ended' },
      playing: { end: 'ended' },
      // Terminal. A second `end` — the host's farewell followed by its socket
      // closing, say — is refused rather than re-running teardown.
      ended: {},
    },
    onTransition,
  });
}

/** Whether a session in this state should still be advertised as joinable. */
export function sessionStatusFor(state: SessionState): SessionStatus {
  return state === 'playing' ? 'in-game' : 'open';
}

/**
 * Whether a connection may still be admitted, and as what.
 *
 * Two questions, not one. A running match takes no new PLAYERS — the frame-0
 * roster is hashed into the initialization and cannot grow — but it takes
 * WATCHERS freely, because a spectator holds no seat and gates no frame.
 * Deriving both from the state is what keeps "watch only, once it starts" a
 * property of the machine rather than a check somebody has to remember.
 */
export function admitsSeating(state: SessionState): boolean {
  return state === 'lobby';
}

export function admitsSpectators(state: SessionState): boolean {
  return state === 'lobby' || state === 'playing';
}
