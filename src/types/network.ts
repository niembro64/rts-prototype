// Network types extracted from game/network/NetworkTypes.ts

import {
  STRUCTURE_BLUEPRINT_IDS,
  SHOT_BLUEPRINT_IDS,
  TURRET_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
} from './blueprintIds';
import type {
  ShotBlueprintId,
  StructureBlueprintId,
  TurretBlueprintId,
  UnitBlueprintId,
} from './blueprintIds';
import type { SnapshotRate, TickRate } from './server';
import type { BeamReflectorKind, CombatFireState, CombatTrajectoryMode, EntityType, PlayerId, TurretState, UnitAirIdleState, UnitMoveState } from './sim';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import type { SeatInitialState } from '../game/sim/agentSeat';
import type { TerrainPrecedence } from './terrainPrecedence';
import type {
  LiquidSurfaceMode,
  MetalCoverage,
} from './worldSurfaceMode';
// Single source of truth for the wire codes TS and Rust must agree on.
// Rust generates its constants from this same file via build.rs.
import wireEnums from '../wireEnums.json';

// ── Bit-packed enum codes for the wire format ─────────────────────
// String enums compress poorly even after msgpack — every "tracking"
// is 8 bytes plus a length tag. These ints take 1 byte each.

const TURRET_STATE_IDLE = wireEnums.turretState.idle;
const TURRET_STATE_TRACKING = wireEnums.turretState.tracking;
const TURRET_STATE_ENGAGED = wireEnums.turretState.engaged;
export type TurretStateCode = number;

const _TURRET_STATE_TO_CODE: Record<TurretState, TurretStateCode> = {
  idle: TURRET_STATE_IDLE,
  tracking: TURRET_STATE_TRACKING,
  engaged: TURRET_STATE_ENGAGED,
};
const _CODE_TO_TURRET_STATE: TurretState[] = ['idle', 'tracking', 'engaged'];

export function turretStateToCode(s: TurretState): TurretStateCode {
  return _TURRET_STATE_TO_CODE[s] ?? TURRET_STATE_IDLE;
}
export function codeToTurretState(c: number): TurretState {
  return _CODE_TO_TURRET_STATE[c] ?? 'idle';
}

const ACTION_TYPE_MOVE = 0;
const ACTION_TYPE_PATROL = 1;
const ACTION_TYPE_FIGHT = 2;
const ACTION_TYPE_BUILD = 3;
const ACTION_TYPE_REPAIR = 4;
const ACTION_TYPE_ATTACK = 5;
const ACTION_TYPE_GUARD = 6;
const ACTION_TYPE_RECLAIM = 7;
const ACTION_TYPE_ATTACK_GROUND = 8;
export const ACTION_TYPE_WAIT = 9;
const ACTION_TYPE_CAPTURE = 10;
// code 11 retired; kept as a gap so later codes stay aligned.
const ACTION_TYPE_LOAD_TRANSPORT = 12;
const ACTION_TYPE_UNLOAD_TRANSPORT = 13;
const ACTION_TYPE_SELF_DESTRUCT = 14;
export type ActionTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 | 13 | 14;

const _ACTION_TO_CODE: Record<string, ActionTypeCode> = {
  move: ACTION_TYPE_MOVE,
  patrol: ACTION_TYPE_PATROL,
  fight: ACTION_TYPE_FIGHT,
  build: ACTION_TYPE_BUILD,
  repair: ACTION_TYPE_REPAIR,
  reclaim: ACTION_TYPE_RECLAIM,
  capture: ACTION_TYPE_CAPTURE,
  wait: ACTION_TYPE_WAIT,
  attack: ACTION_TYPE_ATTACK,
  attackGround: ACTION_TYPE_ATTACK_GROUND,
  guard: ACTION_TYPE_GUARD,
  loadTransport: ACTION_TYPE_LOAD_TRANSPORT,
  unloadTransport: ACTION_TYPE_UNLOAD_TRANSPORT,
  selfDestruct: ACTION_TYPE_SELF_DESTRUCT,
};
const _CODE_TO_ACTION: string[] = [
  'move',
  'patrol',
  'fight',
  'build',
  'repair',
  'attack',
  'guard',
  'reclaim',
  'attackGround',
  'wait',
  'capture',
  'move', // code 11 retired; positional gap keeps later codes aligned
  'loadTransport',
  'unloadTransport',
  'selfDestruct',
];

export function actionTypeToCode(s: string): ActionTypeCode {
  return _ACTION_TO_CODE[s] ?? ACTION_TYPE_MOVE;
}
export function codeToActionType(c: number): string {
  return _CODE_TO_ACTION[c] ?? 'move';
}

// ── Unit blueprint codes ───────────────────────────────────────────
// Stable wire codes for every unit blueprint id. Order is append-only:
// new units go at the end so existing replays / cross-version snapshots
// keep decoding correctly. The string form lives at runtime (entity
// .unit.unitBlueprintId) and on the client side after decode — only the
// serializer / deserializer touches the int form.
const _UNIT_BLUEPRINT_IDS = UNIT_BLUEPRINT_IDS;
export type UnitBlueprintCode = number;
export function getNetworkUnitBlueprintIds(): readonly string[] {
  return _UNIT_BLUEPRINT_IDS;
}
const _UNIT_BLUEPRINT_ID_TO_CODE: Record<string, UnitBlueprintCode> = {};
for (let i = 0; i < _UNIT_BLUEPRINT_IDS.length; i++) {
  _UNIT_BLUEPRINT_ID_TO_CODE[_UNIT_BLUEPRINT_IDS[i]] = i;
}
// Sentinel for "blueprint id not in the code table". Decoders return null for
// unknown codes so receivers drop/reject invalid wire data instead of
// silently turning it into a different real gameplay object.
export const UNIT_BLUEPRINT_CODE_UNKNOWN = 0xff;
export function unitBlueprintIdToCode(s: string): UnitBlueprintCode {
  const code = _UNIT_BLUEPRINT_ID_TO_CODE[s];
  return code === undefined ? UNIT_BLUEPRINT_CODE_UNKNOWN : code;
}
export function codeToUnitBlueprintId(c: number): UnitBlueprintId | null {
  return _UNIT_BLUEPRINT_IDS[c] ?? null;
}

// ── Static-structure blueprint codes ───────────────────────────────
// Compatibility name: the historical wire field is
// buildingBlueprintCode, but the code table covers pure buildings and
// peer tower blueprints.
const _BUILDING_BLUEPRINT_IDS = STRUCTURE_BLUEPRINT_IDS;
export type BuildingBlueprintCode = number;
export function getNetworkBuildingBlueprintIds(): readonly string[] {
  return _BUILDING_BLUEPRINT_IDS;
}
const _BUILDING_BLUEPRINT_ID_TO_CODE: Record<string, BuildingBlueprintCode> = {};
for (let i = 0; i < _BUILDING_BLUEPRINT_IDS.length; i++) {
  _BUILDING_BLUEPRINT_ID_TO_CODE[_BUILDING_BLUEPRINT_IDS[i]] = i;
}
export const BUILDING_BLUEPRINT_CODE_UNKNOWN = 0xff;
export function buildingBlueprintIdToCode(s: string): BuildingBlueprintCode {
  const code = _BUILDING_BLUEPRINT_ID_TO_CODE[s];
  return code === undefined ? BUILDING_BLUEPRINT_CODE_UNKNOWN : code;
}
export function codeToBuildingBlueprintId(c: number): StructureBlueprintId | null {
  return _BUILDING_BLUEPRINT_IDS[c] ?? null;
}

// ── Projectile type codes ──────────────────────────────────────────
export const PROJECTILE_TYPE_PROJECTILE = 0;
const PROJECTILE_TYPE_BEAM = 1;
// Wire code 2 was the retired timed-laser path. Keep the gap so recorded
// snapshots cannot silently reinterpret it as another projectile family.
export const PROJECTILE_TYPE_UNKNOWN = 0xff;
export type ProjectileTypeCode = number;
const _PROJECTILE_TYPE_TO_CODE: Record<string, ProjectileTypeCode> = {
  projectile: PROJECTILE_TYPE_PROJECTILE,
  beam: PROJECTILE_TYPE_BEAM,
};
const _CODE_TO_PROJECTILE_TYPE: (('projectile' | 'beam') | null)[] = [
  'projectile', 'beam', null,
];
export function projectileTypeToCode(s: string): ProjectileTypeCode {
  return _PROJECTILE_TYPE_TO_CODE[s] ?? PROJECTILE_TYPE_UNKNOWN;
}
export function codeToProjectileType(c: number): 'projectile' | 'beam' | null {
  return _CODE_TO_PROJECTILE_TYPE[c] ?? null;
}

/** Code-form sibling of `isRayType` from types/sim.ts. */
export function isLineProjectileTypeCode(code: ProjectileTypeCode): boolean {
  return code === PROJECTILE_TYPE_BEAM;
}

// ── Shot blueprint codes ───────────────────────────────────────────
// Append-only, validated against SHOT_BLUEPRINTS at startup.
const _SHOT_BLUEPRINT_IDS = SHOT_BLUEPRINT_IDS;
export type ShotBlueprintCode = number;
export const SHOT_BLUEPRINT_CODE_UNKNOWN = 0xff;
export function getNetworkShotBlueprintIds(): readonly string[] {
  return _SHOT_BLUEPRINT_IDS;
}
const _SHOT_BLUEPRINT_ID_TO_CODE: Record<string, ShotBlueprintCode> = {};
for (let i = 0; i < _SHOT_BLUEPRINT_IDS.length; i++) {
  _SHOT_BLUEPRINT_ID_TO_CODE[_SHOT_BLUEPRINT_IDS[i]] = i;
}
export function shotBlueprintIdToCode(s: string): ShotBlueprintCode {
  const code = _SHOT_BLUEPRINT_ID_TO_CODE[s];
  return code === undefined ? SHOT_BLUEPRINT_CODE_UNKNOWN : code;
}
export function codeToShotBlueprintId(c: number): ShotBlueprintId | null {
  return _SHOT_BLUEPRINT_IDS[c] ?? null;
}

// ── Turret blueprint codes ─────────────────────────────────────────
// Append-only, validated against TURRET_BLUEPRINTS at startup.
const _TURRET_BLUEPRINT_IDS = TURRET_BLUEPRINT_IDS;
export type TurretBlueprintCode = number;
export const TURRET_BLUEPRINT_CODE_UNKNOWN = 0xff;
export function getNetworkTurretBlueprintIds(): readonly string[] {
  return _TURRET_BLUEPRINT_IDS;
}
const _TURRET_BLUEPRINT_ID_TO_CODE: Record<string, TurretBlueprintCode> = {};
for (let i = 0; i < _TURRET_BLUEPRINT_IDS.length; i++) {
  _TURRET_BLUEPRINT_ID_TO_CODE[_TURRET_BLUEPRINT_IDS[i]] = i;
}
export function turretBlueprintIdToCode(s: string): TurretBlueprintCode {
  const code = _TURRET_BLUEPRINT_ID_TO_CODE[s];
  return code === undefined ? TURRET_BLUEPRINT_CODE_UNKNOWN : code;
}
export function codeToTurretBlueprintId(c: number): TurretBlueprintId | null {
  return _TURRET_BLUEPRINT_IDS[c] ?? null;
}
import type {
  SimEventAudioKey,
  ImpactContext,
  SimDeathContext,
  SimEventSourceType,
  ShieldImpactContext,
  WaterSplashContext,
} from './combat';
import type { ShieldReflectionMode } from './shotTypes';
import type { Vec2, Vec3 } from './vec2';
import type { CanonicalMatchInitialization } from '../game/architecture/CanonicalMatchInitialization';
import type { CanonicalServerStateHash } from '../game/architecture/CanonicalStateHash';
import type { LockstepCommandEnvelope } from '../game/architecture/LockstepCommandProtocol';
import type {
  TerrainBuildabilityGrid,
  TerrainTileMap,
} from './terrain';

/**
 * One CONNECTION to a lobby or match.
 *
 * Deliberately not a PlayerId. A member is whoever is attached; a PlayerId is
 * a SEAT in the match, and only seated members hold one. Conflating them is
 * what makes a spectator accidentally gate a lockstep frame, so the two id
 * spaces stay apart: members address connections, seats address the
 * simulation.
 */
export type MemberId = number;

/** Whether a member holds a seat. Fixed at admission — a user joins as a
 *  spectator and only the HOST moves anyone onto a team. */
export type LobbyMemberRole = 'player' | 'spectator';

/**
 * Whether a member is attached, and if not, whether anything is being held
 * for it.
 *
 * A declared lifecycle rather than a pair of booleans, because the questions
 * asked of it — should the match wait, may this seat be reclaimed, has this
 * player already been resigned — were previously answered by reading a flag
 * and a set together, which is exactly the shape that produces "it fired
 * twice" and "it came back after teardown".
 */
export type LobbyMemberPresence =
  /** Attached and answering. */
  | 'live'
  /** Attached, but has not been heard from in a while. Mid-battle this is the
   *  only signal that a peer has gone: a dead socket can take a very long time
   *  to report itself. */
  | 'silent'
  /** Gone, with its seat held open. Its army is still being simulated by
   *  everyone, so nothing about it changes until it returns or is resigned. */
  | 'awaitingRejoin'
  /** Resigned out of the match. Terminal — a resign is a gameplay command and
   *  must never be issued twice for the same seat. */
  | 'dropped';

/** Opaque secret handed to a member when it is seated, and presented back to
 *  reclaim that seat after a disconnect. Without it a returning connection is
 *  just another spectator, because seats are reserved by identity and not by
 *  arrival order. */
export type SeatToken = string;

export type LobbyMemberInfoPayload = {
  ipAddress: string | undefined;
  location: string | undefined;
  timezone: string | undefined;
  localTime: string | undefined;
  name: string | undefined;
};

/**
 * A member as every client renders it.
 *
 * The host is the only writer. Clients receive the whole list atomically on
 * `rosterUpdate` and replace theirs; there is no per-field merge, because
 * merging partial roster deltas is what let two clients disagree about where
 * the same player was sitting.
 */
export type LobbyMember = {
  memberId: MemberId;
  role: LobbyMemberRole;
  /** The seat this member holds. Present exactly when role === 'player'. */
  playerId: PlayerId | undefined;
  /** The side of that seat — the lobby's TEAM N. Present with `playerId`. */
  allyTeamId: number | undefined;
  /** The seat's INITIAL STATE axis (src/game/sim/agentSeat.ts). Present
   *  only while seated; absent means the human default, 'commander'. */
  initialState: SeatInitialState | undefined;
  name: string;
  isHost: boolean;
  /** Whether this member is attached, quiet, or gone. Never reaches the sim:
   *  connection state is session state, and the only thing that removes a
   *  player from the simulation is a frame-scheduled `resign`. */
  presence: LobbyMemberPresence;
  ipAddress: string | undefined;
  location: string | undefined;
  timezone: string | undefined;
  localTime: string | undefined;
};

/** A seat held by NOBODY's connection: the deterministic in-sim policy
 *  drives it (src/game/sim/agentSeat.ts). Travels in the roster because
 *  every client renders it on its team, but it is not a member — members
 *  hold connections, and a bot holds none. */
export type LobbyBotSeat = {
  playerId: PlayerId;
  allyTeamId: number;
  initialState: SeatInitialState;
};

export type NetworkCommunicationDraft = {
  kind: 'chat';
  clientEventId: string;
  text: string;
  /** The room the SENDER wants, BAR-style: 'all' is the public room, 'team'
   *  their own side. Advisory — the host resolves the real channel from the
   *  roster (a watcher's 'team' is the bench), and outside a battle
   *  everything is 'all'. Absent means 'team' for battle compatibility. */
  channel?: 'all' | 'team';
};

/**
 * Who a message reaches.
 *
 * In the LOBBY everybody is in one room — watchers included, because deciding
 * who plays is a conversation everyone is part of. In battle the sender
 * chooses, BAR-style: ALL is a public room everybody hears, spectators
 * included; TEAM is allies only; and a watcher's private room is the bench.
 * The team/bench split is not decoration — a watcher sees the whole map, so
 * a live channel from the bench to one player would be a coaching channel.
 * ALL is fine: everyone hears it, so there is nothing to whisper.
 */
export type NetworkCommunicationChannel =
  /** The whole session: lobby always, and the battle's public room. */
  | 'all'
  /** In battle: one ally team. */
  | 'team'
  /** In battle: the bench. */
  | 'spectators';

export type NetworkCommunicationChatEvent = {
  kind: 'chat';
  id: string;
  /** Which room this was said in, so the UI can label it. */
  channel: NetworkCommunicationChannel;
  senderPlayerId: PlayerId;
  createdAtMs: number;
  text: string;
};

export type NetworkCommunicationEvent = NetworkCommunicationChatEvent;

// There is deliberately NO protocol version here. One build, everywhere:
// the frontends a session connects always agree because they are the same
// deployed bundle, and the backend is always current — see "One build,
// everywhere" in budget_design_philosophy.html. The hashed initialization
// already carries the automatic build fingerprint, so two builds that
// somehow met could never lockstep anyway; a maintained version tag on top
// of that was ceremony.
export type LockstepProtocolBase = {
  gameId: string | undefined;
};

export type LockstepPeerSequenceAck = {
  playerId: PlayerId;
  lastPlayerSequence: number;
};

export type LockstepHelloMessage = LockstepProtocolBase & {
  type: 'lockstepHello';
  playerId: PlayerId;
  initializationHash: string;
  lastReceivedFrame: number;
  receivedPeerSequences: LockstepPeerSequenceAck[];
};

export type LockstepReadyMessage = LockstepProtocolBase & {
  type: 'lockstepReady';
  playerId: PlayerId;
  readyFrame: number;
  initializationHash: string;
};

export type LockstepCommandMessage = LockstepProtocolBase & {
  type: 'lockstepCommand';
  envelope: LockstepCommandEnvelope;
};

export type LockstepCommandFrameMessage = LockstepProtocolBase & {
  type: 'lockstepCommandFrame';
  coordinatorPlayerId: PlayerId;
  frame: number;
  frameSequence: number;
  commands: LockstepCommandEnvelope[];
};

export type LockstepCommandFrameBatchFrame = {
  frame: number;
  frameSequence: number;
  commands: LockstepCommandEnvelope[];
};

export type LockstepCommandFrameBatchMessage = LockstepProtocolBase & {
  type: 'lockstepCommandFrameBatch';
  coordinatorPlayerId: PlayerId;
  frames: LockstepCommandFrameBatchFrame[];
};

/** One peer's simulation progress, as the coordinator last saw it. */
export type LockstepPeerFrame = {
  playerId: PlayerId;
  frame: number;
};

/**
 * The coordinator's periodic report of how far along every peer is.
 *
 * Peers already tell the coordinator their frame through `lockstepAck`, but
 * those acks only ever travel one way — in a hosted session nobody is
 * connected to anybody except the coordinator, so no client can see how any
 * other client is doing. This closes that loop by broadcasting what the
 * coordinator alone knows, which is what lets every player see who is
 * falling behind rather than just feeling the game stutter.
 *
 * Purely informational: it is never fed to the simulation and carries no
 * commands, so it cannot affect determinism.
 */
export type LockstepPeerFramesMessage = LockstepProtocolBase & {
  type: 'lockstepPeerFrames';
  coordinatorPlayerId: PlayerId;
  /** The frame the coordinator itself has reached — the reference every
   *  peer's lag is measured against. */
  coordinatorFrame: number;
  peers: LockstepPeerFrame[];
};

export type LockstepAckMessage = LockstepProtocolBase & {
  type: 'lockstepAck';
  playerId: PlayerId;
  ackFrame: number;
  ackFrameSequence: number;
  receivedPeerSequences: LockstepPeerSequenceAck[];
};

export type LockstepChecksumMessage = LockstepProtocolBase & {
  type: 'lockstepChecksum';
  playerId: PlayerId;
  frame: number;
  stateHash: CanonicalServerStateHash;
};

export type LockstepPauseMessage = LockstepProtocolBase & {
  type: 'lockstepPause';
  requestedByPlayerId: PlayerId;
  frame: number;
  reason: string;
};

export type LockstepResumeMessage = LockstepProtocolBase & {
  type: 'lockstepResume';
  requestedByPlayerId: PlayerId;
  resumeFrame: number;
};

export type LockstepDesyncMessage = LockstepProtocolBase & {
  type: 'lockstepDesync';
  detectedByPlayerId: PlayerId;
  frame: number;
  localHash: CanonicalServerStateHash;
  remotePlayerId: PlayerId | null;
  remoteHash: CanonicalServerStateHash | null;
};

/**
 * A late arrival asking to be let into a running match.
 *
 * Sent once, immediately after admission, when the session is already
 * playing. `haveThroughFrame` is how much history the requester already holds
 * — always -1 for a fresh watcher, and the seam a state-checkpoint baseline
 * would use later without changing this message.
 */
export type LockstepResumeRequestMessage = LockstepProtocolBase & {
  type: 'lockstepResumeRequest';
  memberId: MemberId;
  /** The seat being reclaimed, when a returning player presented a token. */
  playerId: PlayerId | undefined;
  haveThroughFrame: number;
};

/**
 * The coordinator letting one peer in, with everything it needs to arrive.
 *
 * The handoff is byte-identical to what the frame-0 peers received: one
 * contract, one boot path, no separate "late joiner" initialization that
 * could drift from the real one. From this moment the coordinator also
 * unicasts live frames to the joiner, so there is no hole between the end of
 * the archive and the start of the live stream.
 */
export type LockstepResumeGrantMessage = LockstepProtocolBase & {
  type: 'lockstepResumeGrant';
  memberId: MemberId;
  handoff: BattleHandoff;
  /** The frame the joiner must reach before it is part of the match. */
  grantFrame: number;
  /** Highest frame the archive holds. Frames below it that never arrive were
   *  empty, not lost. */
  archiveThroughFrame: number;
  /** The coordinator's canonical state hash at the most recent checksum
   *  frame, and which frame that was. The joiner compares its own replayed
   *  hash there before it is allowed to render: a replay that disagrees is a
   *  desync, and joining anyway would spread it. */
  verifyFrame: number;
  verifyStateHash: CanonicalServerStateHash | null;
};

/**
 * A chunk of match history.
 *
 * Only frames that carried commands are listed; everything else inside
 * `[fromFrame, throughFrame]` was empty, which is information rather than a
 * gap. At 20 Hz a twenty-minute match is 24,000 frames and a few thousand
 * commands, so sending the empties would multiply the transfer for nothing.
 */
export type LockstepHistoryMessage = LockstepProtocolBase & {
  type: 'lockstepHistory';
  fromFrame: number;
  throughFrame: number;
  frames: LockstepCommandFrameBatchFrame[];
  /** True on the last chunk, so the receiver knows the archive is complete
   *  rather than waiting on a chunk that will never come. */
  final: boolean;
};

export type LockstepResyncRequestMessage = LockstepProtocolBase & {
  type: 'lockstepResyncRequest';
  /** The requester's seat, or undefined when a watcher is catching up. The
   *  coordinator answers on the connection the request arrived on, so this is
   *  diagnostic rather than an address. */
  requestedByPlayerId: PlayerId | undefined;
  fromFrame: number;
  reason: string;
};

export type NetworkLockstepMessage =
  | LockstepHelloMessage
  | LockstepReadyMessage
  | LockstepCommandMessage
  | LockstepCommandFrameMessage
  | LockstepCommandFrameBatchMessage
  | LockstepAckMessage
  | LockstepPeerFramesMessage
  | LockstepChecksumMessage
  | LockstepPauseMessage
  | LockstepResumeMessage
  | LockstepDesyncMessage
  | LockstepResyncRequestMessage
  | LockstepResumeRequestMessage
  | LockstepResumeGrantMessage
  | LockstepHistoryMessage;

// Combined transport envelope.
export type NetworkMessage =
  | NetworkLockstepMessage
  // Client -> host communication.
  | { type: 'communication'; gameId: string | undefined; data: NetworkCommunicationDraft }
  // Client reports its own IP / location / timezone / name to the host. The
  // host folds it into its member record and re-announces the whole roster;
  // nothing a client says about itself can move a seat, because seating is
  // the host's alone.
  | {
      type: 'memberInfo';
      gameId: string | undefined;
      ipAddress: string | undefined;
      location: string | undefined;
      timezone: string | undefined;
      localTime: string | undefined;
      /** Optional rename — set when the local user edits their own slot. */
      name: string | undefined;
    }
  // Heartbeat ping. Both directions (client→host AND host→client)
  // — every peer sends one every couple seconds while the session is
  // alive, and every peer monitors what it's received from the others.
  // Clients attach their own latest info; the host attaches the
  // authoritative roster back. A peer that hasn't sent in too long gets its
  // connection closed OUTSIDE a battle; inside one, silence is only
  // reported, because dropping a peer mid-match would strand the lockstep
  // frames the others are waiting on. Catches silent disconnects (frozen
  // tabs, network drops) that don't fire PeerJS's `close` event.
  | {
      type: 'heartbeat';
      gameId: string | undefined;
      memberId: MemberId;
      memberInfo: LobbyMemberInfoPayload | undefined;
      members: LobbyMember[] | undefined;
    }
  // Host -> client communication relay.
  | { type: 'communicationEvent'; gameId: string | undefined; data: NetworkCommunicationEvent }
  // Host -> one client, once, on admission. Tells that connection who it is
  // and — if it reclaimed a seat with a token — which seat it holds.
  | {
      type: 'sessionAssignment';
      gameId: string | undefined;
      memberId: MemberId;
      role: LobbyMemberRole;
      playerId: PlayerId | undefined;
      allyTeamId: number | undefined;
      /** Present exactly when a seat is held. Kept by the client so a
       *  reconnect can reclaim the same seat instead of arriving as a
       *  stranger. */
      seatToken: SeatToken | undefined;
      /** True when this connection landed in a match that is already running.
       *  The joiner answers with a resume request rather than sitting in a
       *  lobby that no longer exists. */
      matchInProgress: boolean;
      /** The running match's sequence within this session (0 = none yet).
       *  Adopted before the resume request rides the lockstep transport. */
      matchSequence: number;
    }
  // Host -> all, the WHOLE member list. Atomic replace rather than a delta:
  // the roster is small, and every disagreement about who sits where came
  // from clients merging partial updates in different orders.
  | {
      type: 'rosterUpdate';
      gameId: string | undefined;
      members: LobbyMember[];
      /** Bot seats beside the members, in the same atomic announcement —
       *  a partial roster is exactly the disagreement this message exists
       *  to prevent. */
      botSeats: LobbyBotSeat[];
      /** Sides the host declared, empty ones included. */
      allyTeamCount: number;
    }
  | {
      type: 'gameStart';
      playerIds: PlayerId[];
      gameId: string;
      /** Which match within the session this is (host-bumped). Clients key
       *  their lockstep wire identity on it, so a rematch shares nothing
       *  with the frames that came before. */
      matchSequence: number;
      handoff: BattleHandoff;
      /** The seat this recipient holds, or undefined when it is watching. */
      assignedPlayerId: PlayerId | undefined;
    }
  // Host -> client farewell, sent once as the host tears its session down.
  //
  // A closing PeerJS connection already tells a client the host is gone, but
  // only eventually and without saying why — a dropped WiFi link looks
  // identical to a host quitting. This says it outright so clients can show
  // the real reason immediately instead of waiting out a socket. It is an
  // optimisation, never the only signal: losing the host connection is
  // treated the same way, so a crashed or unplugged host still ejects
  // everyone.
  | { type: 'hostLeft'; gameId: string | undefined }
  // Host -> all. The battle is over and the whole room returns to its
  // seating screen for a rematch. The SESSION survives — nobody disconnects,
  // seats and roster stay — which is exactly what distinguishes this from
  // `hostLeft`. Only the host may say it; the game-room state is the host's
  // alone, and a client's only exits are its own "exit to home".
  | { type: 'returnToLobby'; gameId: string | undefined }
  | { type: 'lobbySettings'; gameId: string | undefined; settings: LobbySettings }
  // Host -> one client, immediately before closing the connection. A refused
  // join otherwise arrives as a socket that simply died, which reads exactly
  // like a network fault; the commonest real cause is a stale build, and the
  // player can act on that only if they are told.
  | {
      type: 'sessionRefused';
      gameId: string | undefined;
      reason: SessionRefusalReason;
      detail: string;
    };

export type SessionRefusalReason =
  /** No room left on the bench. */
  | 'session-full'
  /** The session is over, or was never open. */
  | 'session-closed';

// Host → Client lobby-settings sync. Carries the host's
// pre-game choices (terrain shape and system toggles) so every connected client sees
// the same map preview and starts the real battle from the same
// configuration. The host broadcasts on every change AND on
// each new player joining (so late-joiners get the current state
// up front, not just future deltas). The whole settings object
// ships every time — small enough that diffing isn't worth the
// complexity, and atomic-replace avoids the "client missed one
// field" failure mode if a future delta protocol drops a packet.
export type LobbySettings = {
  /** What the host called this lobby. Directory metadata rather than a
   *  simulation setting — the canonical match initialization ignores it, so
   *  it can never move a checksum — but it rides the settings contract
   *  because that is already the one host-owned payload every client is
   *  guaranteed to receive, on join and on every change. Empty means the
   *  host never named it; the listing falls back to the host's name. */
  lobbyName: string;
  /** Signed altitude of the central cosine dome/dish (CENTER bar). */
  centerMagnitude: number;
  /** Signed crest altitude of the RING annulus (RING bar). */
  ringMagnitude: number;
  /** Signed altitude of the team-separator ridges (DIVIDERS bar). */
  dividersMagnitude: number;
  /** Signed PERIMETER ring altitude (PERIMETER bar). Negative =
   *  round-island; positive = rim; 0 = flat rim at ground level. */
  perimeterMagnitude: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  terrainPrecedence: TerrainPrecedence;
  /** Plateau lattice step (world units). 0 = NONE (no terracing). */
  terrainDTerrain: number;
  /** D-PLATEAU wall slope angle in degrees from horizontal. */
  plateauWallSlopeDegrees: number;
  /** Metal-extractor pad altitude step (world units). */
  metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off (one triangle
   *  per cell); higher values refine the mesh. */
  terrainDetail: number;
  mapWidthLandCells: number;
  mapLengthLandCells: number;
  /** Match-wide ENTITY COUNT CAP (units + buildings) for real battles. */
  entityCountCap: number;
  /** How many SIDES the lobby splits its seats across — the TEAM N the roster
   *  labels. Host-owned, and carried here rather than derived from the roster
   *  because a side the host declared and left empty is still a side: it takes
   *  a terrain slice, deposits and a spawn arc. Every client needs the number
   *  to render the same empty teams the host sees. */
  allyTeamCount: number;
  /** Number of build squares represented by one path square per axis. */
  pathfindingCellConsolidationMultiplier: number;
  /** Authoritative fixed simulation steps per real-time second. */
  simulationTickRateHz: number;
  converterTax: number;
  /** Whether units brake on approach to their last waypoint. */
  slowDownAtFinalWaypoint: boolean;
  /** Ground material for the whole authoritative world. */
  metalCoverage: MetalCoverage;
  /** Liquid material below the water level. Lava changes simulation damage as
   *  well as rendering. */
  liquidSurfaceMode: LiquidSurfaceMode;
};

export type NetworkServerSnapshotSimEvent = {
  type:
    | 'fire'
    | 'hit'
    | 'death'
    | 'laserStart'
    | 'laserStop'
    | 'shieldStart'
    | 'shieldStop'
    | 'shieldImpact'
    | 'ping'
    | 'attackAlert'
    | 'projectileExpire'
    | 'waterSplash'
    | 'selfDestructArmed'
    | 'selfDestructDisarmed';
  turretBlueprintId: SimEventAudioKey;
  sourceType: SimEventSourceType | null;
  sourceKey: string | null;
  /** Event origin in 3D sim coords. See SimEvent in types/combat.ts. */
  pos: Vec3;
  playerId: PlayerId | null;
  entityId: number | null;
  deathContext: SimDeathContext | null;
  impactContext: ImpactContext | null;
  waterSplash: WaterSplashContext | null;
  shieldImpact: ShieldImpactContext | null;
  /** For 'death' events: playerId of the entity that landed the
   *  killing blow. Carries through serializeAudioEvents' kill-credit
   *  branch (FOW-17) — the audio serializer forwards the
   *  event to this player's snapshot even when the death position
   *  isn't in their vision, so they get the "+1, you got it" hit
   *  even on off-screen kills. */
  killerPlayerId: PlayerId | null;
  /** For 'attackAlert' events: playerId of the victim taking damage.
   *  Drives the FOW-08-followup remainder routing — the alert is
   *  forwarded to this player's snapshot regardless of vision so they
   *  see a marker at the attacker's position when un-homed splash
   *  damage from inside the fog lands on their unit. */
  victimPlayerId: PlayerId | null;
  /** FOW-09 earshot reveal flag. When true, the client should play
   *  the audio side of the event but skip every visual branch —
   *  "distant gunfire from over there" without leaking the position
   *  through an explosion sprite. Server sets it when forwarding an
   *  event outside the recipient's vision but within their earshot
   *  pad; never set in-vision. */
  audioOnly: boolean | null;
};

export const RESOURCE_KIND_ENERGY = 0;
export const RESOURCE_KIND_METAL = 1;
export type ResourceKindCode = typeof RESOURCE_KIND_ENERGY | typeof RESOURCE_KIND_METAL;

export const RESOURCE_FLOW_INBOUND = 0;
export const RESOURCE_FLOW_OUTBOUND = 1;
export type ResourceFlowDirectionCode =
  | typeof RESOURCE_FLOW_INBOUND
  | typeof RESOURCE_FLOW_OUTBOUND;

export type NetworkServerSnapshotResourceMovement = {
  playerId: PlayerId;
  sourceEntityId: number;
  targetEntityId: number | null;
  resource: ResourceKindCode;
  amountPerSecond: number;
  direction: ResourceFlowDirectionCode;
};

/** Wire shape for an active scan pulse (FOW-14). Only the geometric
 *  info the client needs to clear the live fog shade — the
 *  authoritative TTL stays on the server, but a copy of expiresAtTick
 *  rides along so a freshly-joined / reconnected client knows how
 *  much of the sweep is left. */
export type NetworkServerSnapshotScanPulse = {
  playerId: PlayerId;
  x: number;
  y: number;
  z: number;
  radius: number;
  expiresAtTick: number;
};

export type NetworkServerSnapshotProjectileSpawn = {
  id: number;
  /** PROJECTILE_POSITION_WIRE_SCALE fixed-point spawn position. */
  pos: Vec3;
  /** ROTATION_WIRE_SCALE fixed-point heading. */
  rotation: number;
  /** VELOCITY_WIRE_SCALE fixed-point initial velocity. */
  velocity: Vec3;
  /** Bit-packed projectile type code (see PROJECTILE_TYPE_* constants
   *  and projectileTypeToCode / codeToProjectileType helpers). */
  projectileType: ProjectileTypeCode;
  /** Resolved finite runtime timeout in ms, when the projectile has one. */
  maxLifespan: number | null;
  /** Compatibility/source turret blueprint wire code. Prefer sourceTurretBlueprintCode + shotBlueprintCode. */
  turretBlueprintCode: TurretBlueprintCode;
  /** Actual shot blueprint wire code for client hydration. */
  shotBlueprintCode: ShotBlueprintCode | null;
  /** Real turret blueprint wire code that authored this projectile. */
  sourceTurretBlueprintCode: TurretBlueprintCode | null;
  /** Runtime EntityId of the mounted turret instance that fired this projectile. */
  sourceTurretEntityId: number | null;
  playerId: number;
  /** Legacy source-host shortcut. The full immutable source record follows. */
  sourceEntityId: number;
  sourceHostEntityId: number;
  sourceRootEntityId: number;
  sourceTeamId: number;
  spawnTick: number;
  parentShotEntityId: number | null;
  turretIndex: number;
  /** Authoritative QueryWeapon lane selected within the source turret's
   * cluster. This same identity places the shot and routes presentation. */
  barrelIndex: number;
  isDGun: boolean | null;
  /** True when this projectile came from a parent detonation (e.g.
   *  cluster-flak submunitions) rather than a turret launch. */
  fromParentDetonation: boolean | null;
  /** PROJECTILE_POSITION_WIRE_SCALE fixed-point line-shot endpoints. */
  beam: { start: Vec3; end: Vec3 } | null;
  targetEntityId: number | null;
  homingTurnRate: number | null;
};

export type NetworkServerSnapshotProjectileDespawn = {
  id: number;
};

export type NetworkServerSnapshotMotionUpdate = {
  id: number;
  /** PROJECTILE_POSITION_WIRE_SCALE fixed-point position. */
  pos: Vec3;
  /** VELOCITY_WIRE_SCALE fixed-point velocity. */
  velocity: Vec3;
  /** ROTATION_WIRE_SCALE fixed-point authoritative yaw. */
  rotation: number;
  /** ROTATION_WIRE_SCALE fixed-point authoritative yaw rate. */
  angularVelocity: number;
};

/** Wire-format vertex of a beam polyline. The full beam is
 *  `points = [start, ...reflections, end]`. Each vertex carries its
 *  own instantaneous 3D velocity in the world frame. The client applies
 *  the movement position and velocity EMA channels to these authoritative
 *  values but never extrapolates or locally re-traces the path. The reflector
 *  vertices set `reflectorEntityId` to the redirecting reflector entity
 *  (shield panels and spheres both use this slot).
 *  Position uses PROJECTILE_POSITION_WIRE_SCALE, velocity uses
 *  VELOCITY_WIRE_SCALE, and normals use NORMAL_WIRE_SCALE fixed-point
 *  integers. Start leaves reflector metadata undefined; the end can
 *  carry it when the authoritative max-segment cap terminated on a
 *  reflector. */
export type NetworkServerSnapshotBeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Any beam reflector entity — shield panels and spheres both
   *  use this slot. */
  reflectorEntityId: number | null;
  reflectorKind: BeamReflectorKind | null;
  reflectorPlayerId: PlayerId | null;
  normalX: number | null;
  normalY: number | null;
  normalZ: number | null;
};

export type NetworkServerSnapshotBeamUpdate = {
  id: number;
  /** Polyline vertices (≥ 2). Index 0 = selected QueryWeapon origin, last = end
   *  (range / hit / ground / terminal reflector), middles = reflections. Each carries its
   *  own position and velocity from the authoritative every-tick beam trace. */
  points: NetworkServerSnapshotBeamPoint[];
  /** Quantized terminal-segment hit fraction for a physical obstruction;
   *  null when the endpoint is clear or range-limited. */
  obstructionT: number | null;
  /** False when the authoritative path has no physical impact endpoint,
   *  so clients should not render an endpoint damage orb. */
  endpointDamageable: boolean | null;
};

export type NetworkServerSnapshotMeta = {
  ticks: {
    avg: number;
    low: number;
    /** HOST SERVER TARGET TPS — the host runs at this rate without
     *  any adaptive slowdown. */
    rate: TickRate;
  };
  snaps: { rate: SnapshotRate };
  server: { time: string; ip: string };
  units: {
    /** Allowed unit blueprint ids — genuinely about units, unlike the two
     *  counters below. */
    allowed: string[] | undefined;
    /** The match-wide ENTITY COUNT CAP (units + buildings), before it is
     *  divided into per-side pools. */
    max: number | undefined;
    /** Live entities match-wide (units + buildings), so it pairs with `max`. */
    count: number | undefined;
  };
  turretShieldPanelsEnabled: boolean | undefined;
  turretShieldSpheresEnabled: boolean | undefined;
  forceFieldsVisible: boolean | undefined;
  /** Per-player upgrade bits (bit `playerId - 1`): shield-aware
   *  targeting from a completed Shield-Aware Targeting Tech building. */
  shieldAwareTargetingPlayerMask: number | undefined;
  /** Per-player shield-power bits (bit `playerId - 1`): the player's team
   *  holds at least one completed, switched-ON Shield Generator, so every
   *  shield that team owns is raised. */
  shieldPowerPlayerMask: number | undefined;
  shieldReflectionMode: ShieldReflectionMode | undefined;
  fogOfWarEnabled: boolean | undefined;
  /** Tax (fraction in [0, 1)) applied to each resource converter's
   *  per-tick output. Authoritative on the host; mirrored to clients
   *  so the DEMO BATTLE bar can show the active value. */
  converterTax: number | undefined;
  /** Per-player auto-conversion slider points (fractions of storage),
   *  parallel arrays indexed together. Players absent from playerIds are
   *  at the defaults in types/autoConversion. Mirrored so every client's
   *  economy-bar sliders render the sim's authoritative values. */
  autoConversionThresholds: {
    playerIds: number[];
    energyAt: number[];
    metalAt: number[];
  } | undefined;
  /** Host CPU load as a percent of the per-tick budget (1000/tickRate ms).
   *  `avg` = EMA-smoothed steady-state load; `hi` = EMA spike, climbs fast
   *  on spikes and decays slowly. Both can exceed 100 when the server is
   *  falling behind (tick work > tick budget). */
  cpu: { avg: number; hi: number } | undefined;
  wind: {
    x: number;
    y: number;
    z: number;
    speed: number;
    angle: number;
  } | undefined;
  retainedPools?: {
    entitySnapshots: {
      retained: number;
      active: number;
      warm: number;
    };
  };
  /** HOST SERVER unit ground normal EMA mode (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC key).
   *  Bare string on the wire — the value space is just 'snap' / 'fast'
   *  / 'mid' / 'slow'. Remote clients read this so their HOST SERVER
   *  unit ground normal bar reflects the host's setting rather than
   *  their own stale localStorage. */
  unitGroundNormalEma: UnitGroundNormalEmaMode | undefined;
};

export type GamePhase = 'init' | 'battle' | 'paused' | 'gameOver';

export type NetworkServerSnapshotProjectiles = {
  spawns: NetworkServerSnapshotProjectileSpawn[] | undefined;
  despawns: NetworkServerSnapshotProjectileDespawn[] | undefined;
  motionUpdates: NetworkServerSnapshotMotionUpdate[] | undefined;
  /** Authoritative live beam paths. Sent every snapshot so
   *  clients draw reflected segments directly instead of re-tracing
   *  reflector/unit/building intersections in the render frame. */
  beamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
};

export type NetworkServerSnapshotGameState = {
  phase: GamePhase;
  winnerId: PlayerId | undefined;
};

export type NetworkServerSnapshot = {
  tick: number;
  entities: NetworkServerSnapshotEntity[];
  /** Sparse packet carrying entity presentation deltas only.
   *  Clients must process `entities` as sparse rows but must not treat them
   *  as the authoritative visible set when this flag is present. */
  entityDeltaOnly: boolean | undefined;
  /** Sparse packet carrying projectile/audio presentation deltas only.
   *  Clients must not treat `entities` as the authoritative visible set
   *  when this flag is present. */
  projectileDeltaOnly: boolean | undefined;
  minimapEntities: NetworkServerSnapshotMinimapEntity[] | undefined;
  economy: Record<PlayerId, NetworkServerSnapshotEconomy>;
  resourceMovements: NetworkServerSnapshotResourceMovement[] | undefined;
  sprayTargets: NetworkServerSnapshotSprayTarget[] | undefined;
  audioEvents: NetworkServerSnapshotSimEvent[] | undefined;
  /** Active temporary vision pulses (FOW-14 — scanner sweeps) owned
   *  by the recipient or one of their allies, with the tick they
   *  expire on. The client passes these into the live fog shade so
   *  it clears inside the sweep radius the same way it does around
   *  a unit's vision circle. Omitted when no pulses are live for the
   *  recipient's team. */
  scanPulses: NetworkServerSnapshotScanPulse[] | undefined;
  projectiles: NetworkServerSnapshotProjectiles | undefined;
  gameState: NetworkServerSnapshotGameState | undefined;
  serverMeta: NetworkServerSnapshotMeta | undefined;
  terrain: TerrainTileMap | undefined;
  buildability: TerrainBuildabilityGrid | undefined;
  /** True when the presentation snapshot intentionally omits entities
   *  outside the recipient player's current vision. */
  visibilityFiltered: boolean | undefined;
  /** Bitmask of player IDs whose full-vision entities may contribute
   *  to this recipient's live fog presentation. Bit p-1 corresponds
   *  to PlayerId p. Sent by the host so the client consumes the same
   *  recipient+allies visibility contract as snapshot filtering
   *  without guessing from arbitrary visible entities. */
  visionPlayerMask: number | undefined;
  removedEntityIds: number[] | undefined;
};

export type NetworkServerSnapshotMinimapEntity = {
  id: number;
  pos: Vec2;
  type: Exclude<EntityType, 'shot'>;
  playerId: PlayerId;
  /** True when the recipient only learned about this entity through
   *  radar coverage (no full-vision source covers its position). The
   *  client should render it as a generic positional blip — no unit
   *  type / owner-color identification — since the player only has
   *  positional intel. Omitted (treated as false) for entities the
   *  recipient sees in full. */
  radarOnly: boolean | null;
  /** Contact rows only: bit 0 means the team earned an above-water radar
   *  contact and bit 1 means it earned an underwater sonar contact. A
   *  straddling body may carry both. This is sensor provenance, not entity
   *  identity. Null for fully visible entries. */
  contactMediumMask: number | null;
  /** Contact rows only: authoritative world-space observation altitude. Radar
   *  and sonar are three-dimensional sensors, so their anonymous marker must
   *  not be projected onto terrain or the water plane. Null for fully visible
   *  entries; required and finite for contact-only entries. */
  contactZ: number | null;
};

export type NetworkServerSnapshotSprayTarget = {
  source: { id: number; pos: Vec2; z: number | null; playerId: PlayerId };
  target: { id: number; pos: Vec2; z: number | null; dim: Vec2 | null; radius: number | null };
  type: 'build' | 'heal';
  inverse?: boolean;
  intensity: number;
  speed: number | null;
  particleRadius: number | null;
  ballSpawnRate: number | null;
};

export type NetworkServerSnapshotAction = {
  /** Bit-packed action type code (see ACTION_TYPE_* constants and
   *  actionTypeToCode / codeToActionType helpers). String form used
   *  to take 6-12 bytes per action; the int code is one byte. */
  type: ActionTypeCode;
  pos: Vec2 | null;
  /** Altitude (sim.z = three.y) of the action's 3D ground point —
   *  the original click point that produced this action, preserved
   *  so joining clients see waypoint markers at the same altitude
   *  the issuing client did. Sent only when the action carries a
   *  click-derived z (renderers fall back to a terrain sample when
   *  absent). */
  posZ: number | null;
  /** True for resolved active-route points (including the real endpoint).
   *  The client separates these disposable planner points from durable command
   *  actions and shows them only in DETAILED mode. Omitted when false to save bytes
   *  — the renderer treats `undefined` as `false`. */
  pathExp: boolean | null;
  targetId: number | null;
  buildingBlueprintId: string | null;
  grid: Vec2 | null;
  buildingId: number | null;
  waitGather?: boolean | null;
  waitGroupId?: number | null;
  /** Guard target resumed after this sim-authored retaliation Attack. */
  guardReturnTargetId?: number | null;
};

export type NetworkServerSnapshotTurret = {
  turret: {
    /** Turret blueprint wire code for slot validation only. Static authored
     *  data such as ranges/turn acceleration/drag stays client-local
     *  and blueprint-derived. */
    turretBlueprintCode: TurretBlueprintCode;
    /** ROTATION_WIRE_SCALE fixed-point yaw/pitch positions and rates. */
    angular: {
      /** Yaw (horizontal heading, rot around z-axis). */
      rot: number;
      /** Yaw angular velocity (rad/s). */
      vel: number;
      /** Pitch (vertical aim, elevation angle). */
      pitch: number;
      /** Pitch angular velocity (rad/s). */
      pitchVel: number;
      /** Authoritative yaw of the moving host piece that carries this turret. */
      hostYaw?: number;
      /** Angular velocity of the host-piece yaw servo. */
      hostYawVel?: number;
    };
  };
  targetId: number | null;
  /** Bit-packed turret state code (see TURRET_STATE_* constants and
   *  turretStateToCode / codeToTurretState helpers). */
  state: TurretStateCode;
  /** Present only when this mounted turret is inactive/dead/detached.
   *  Absence means "use the blueprint/default live turret state". */
  active: boolean | null;
  /** Server-authored shield activation progress (0..1). This is
   *  not locomotion garnish: the authoritative host uses the same
   *  transition state to decide when a shield barrier exists for
   *  projectile reflection / obstruction, so clients receive it as a
   *  correction target instead of deriving an independent local timer. */
  currentShieldRange: number | null;
};

// Legacy bitmask for sparse entity records. Lockstep presentation
// snapshots emit full records with this absent/null.
// MessagePack decodes own `undefined` properties as null, so network
// clients must accept both absent and null as "full record".
// When set by old fixtures/tools, only flagged field groups are populated.
export const ENTITY_CHANGED_POS       = wireEnums.entityChanged.pos;
export const ENTITY_CHANGED_ROT       = wireEnums.entityChanged.rot;
export const ENTITY_CHANGED_VEL       = wireEnums.entityChanged.vel;
export const ENTITY_CHANGED_HP        = wireEnums.entityChanged.hp;
export const ENTITY_CHANGED_ACTIONS   = wireEnums.entityChanged.actions;
export const ENTITY_CHANGED_TURRETS   = wireEnums.entityChanged.turrets;
export const ENTITY_CHANGED_BUILDING  = wireEnums.entityChanged.building;
export const ENTITY_CHANGED_FACTORY   = wireEnums.entityChanged.factory;
/** Legacy sparse-record bit for the unit's smoothed surface normal. */
export const ENTITY_CHANGED_NORMAL    = wireEnums.entityChanged.normal;
// Bits 1 << 9, 1 << 10, and 1 << 11 were previously assigned to
// retired wire channels (visual suspension, acceleration-on-the-wire,
// and a vertical-launch actuator, respectively). The bits are
// intentionally left empty so COMBAT_MODE keeps its existing position
// rather than renumbering downstream consumers.
/** Player-controlled combat mode such as fire/hold-fire changed. */
export const ENTITY_CHANGED_COMBAT_MODE = wireEnums.entityChanged.combatMode;

export type NetworkServerSnapshotFactory = {
  /** Selected repeat-build unit blueprint wire code, or null for off. */
  selectedUnitBlueprintCode: number | null;
  /** Average fill of the factory's current shell, or zero while idle. */
  progress: number;
  producing: boolean;
  /** False means the selected unit is a one-shot queue item. */
  repeat?: boolean;
  /** BAR Wait command state for factories/labs. */
  paused?: boolean;
  /** Finite production queue after the selected/current item. */
  queue?: number[] | null;
  /** Unit blueprint code/quota pairs for BAR factory quota mode. */
  quotas?: number[] | null;
  /** Unit blueprint code/current-count pairs for BAR factory quota mode. */
  quotaCounts?: number[] | null;
  /** Per-resource transfer-rate fractions for the current work tick. */
  energyRate: number;
  metalRate: number;
  /** Friendly entity this factory will assign eligible output to guard. */
  guardTargetId: number | null;
  /** BAR builder-priority mirror for factory/lab resource priority. */
  lowPriority?: boolean;
  /** BAR MOVE_STATE for factories/labs. */
  moveState?: UnitMoveState;
  /** BAR air-plant LAND_AT state. */
  airIdleState?: UnitAirIdleState;
  /** Static rally point. */
  rally: { pos: Vec2; posZ: number | null; type: string };
  /** Visualization-only multi-leg output route. */
  route: { pos: Vec2; posZ: number | null; type: string }[] | null;
};

export type NetworkServerSnapshotEntity = {
  id: number;
  type: EntityType;
  /** 3D position (x/y plane plus altitude), encoded as
   *  ENTITY_POSITION_WIRE_SCALE fixed-point integers. */
  pos: Vec3 | null;
  /** ROTATION_WIRE_SCALE fixed-point yaw. */
  rotation: number | null;
  playerId: PlayerId;
  changedFields: number | null;
  unit: {
    /** Static fields are present on full records and omitted from
     *  ordinary deltas after the entity has been created.
     *  Numeric wire code — see unitBlueprintIdToCode helpers. */
    unitBlueprintCode: UnitBlueprintCode | null;
    hp: { curr: number; max: number } | null;
    /** Unit radii. Static on full records and omitted from ordinary
     *  deltas unless the unit blueprint/runtime radius changes. */
    radius: { other: number | null; hitbox: number | null; collision: number | null } | null;
    supportPointOffsetZ: number | null;
    mass: number | null;
    /** VELOCITY_WIRE_SCALE fixed-point linear velocity. */
    velocity: Vec3 | null;
    /** Per-unit smoothed surface normal (unit-length nx, ny, nz). The
     *  sim EMA-blends raw → smoothed each tick (see updateUnitGroundNormal) so
     *  the rendered chassis tilt and the slope-tilted turret world
     *  mounts can read the same canonical value here instead of
     *  re-querying the position-keyed terrain cache and getting a
     *  triangle-snapping raw normal. Quantized to 0.001 precision on
     *  the wire (qNormal); ~3 bytes per unit per snapshot after delta
     *  encoding. Omitted on snapshots where the unit's normal didn't
     *  change enough to send, or where visual detail fields are being
     *  throttled between detail-cadence snapshots. */
    surfaceNormal: { nx: number; ny: number; nz: number } | null;
    /** Full 3-DOF orientation triad for units. The scalar `rotation`
     *  remains on the parent snapshot entity as the compact yaw mirror
     *  used by legacy consumers and typed-row dirty detection. */
    orientation: { x: number; y: number; z: number; w: number } | null;
    /** Angular velocity 3-vector in world frame (rad/s). Paired with
     *  `orientation` for authoritative motion diagnostics and snapshot
     *  compatibility. Adjacent fixed-tick presentation reads complete
     *  orientations rather than integrating this value in TypeScript. */
    angularVelocity3: Vec3 | null;
    /** Player-controlled fire state. Omitted/null means unchanged for
     *  deltas and fire-at-will for full records. */
    fireState?: CombatFireState | null;
    /** Host ballistic trajectory override. Null/omitted means unchanged
     *  for deltas and authored turret defaults ("auto") for full records. */
    trajectoryMode?: CombatTrajectoryMode | null;
    /** Unit repeat-queue state. Present with action/private-command
     *  detail rows when enabled, and on deltas that explicitly turn it
     *  off. Omitted/null means "unchanged" for deltas and false for full
     *  records. */
    repeatQueue?: boolean | null;
    /** Unit positioning/move-state enum. Present with private
     *  action-command detail rows when the unit is not in maneuver, and
     *  on deltas that explicitly return it to maneuver. Omitted/null
     *  means "unchanged" for deltas and maneuver for full records. */
    moveState?: UnitMoveState | null;
    /** Private owner command intent for cloak. Present on full private
     *  records when enabled and on deltas that explicitly toggle it. */
    wantCloak?: boolean | null;
    /** Private owner command-state mirror for BAR builder priority. Present
     *  on full private builder records when low, and on deltas that
     *  explicitly toggle it. */
    builderPriorityLow?: boolean | null;
    /** Private owner command-state mirror for BAR carrier spawning. Present
     *  for mobile unit factories when disabled, and on deltas that
     *  explicitly toggle it. */
    carrierSpawnEnabled?: boolean | null;
    /** Private host-owned production workflow for mobile queen factories.
     *  Static Fabricators carry the identical shape on `building.factory`. */
    factory: NetworkServerSnapshotFactory | null;
    /** Public active cloak state. Present when active and on deltas that
     *  explicitly clear it; filtered snapshots hide foreign cloaked units
     *  unless detector coverage reveals them. */
    cloaked?: boolean | null;
    isCommander: boolean | null;
    buildTargetId: number | null;
    buildTargetIdPresent: boolean;
    /** Public articulated QueryWork pose. Target identity remains private;
     * targetActive is sufficient for deterministic piece presentation. */
    workStation?: {
      localYaw: number;
      localPitch: number;
      localYawVelocity: number;
      localPitchVelocity: number;
      targetActive: boolean;
      aligned: boolean;
      targetWorldYaw: number;
      targetWorldPitch: number;
    } | null;
    actions: NetworkServerSnapshotAction[] | null;
    turrets: NetworkServerSnapshotTurret[] | null;
    /** Unit shell construction state. Present while the unit is being
     *  funded, and retained with interrupted=true for cancelled partial
     *  assemblies whose piece records still drive rendering/targeting.
     *  `paid` is dynamic wire state; `required` is deliberately
     *  blueprint-derived on both host and client. A client/host content
     *  version mismatch is outside this wire contract. */
    build: {
      complete: boolean;
      interrupted?: boolean;
      paid: { energy: number; metal: number };
    } | null;
  } | null;
  building: {
    /** buildingBlueprintCode / dim are present on full records and omitted from
     *  ordinary deltas after the entity has been created.
     *  Numeric wire code — see buildingBlueprintIdToCode helpers. */
    buildingBlueprintCode: BuildingBlueprintCode | null;
    /** Footprint in world units — planar xy is dim.x/dim.y. Full
     *  depth (vertical extent) lives on the building entity, not
     *  here — clients re-derive it from the blueprint. */
    dim: Vec2 | null;
    hp: { curr: number; max: number } | null;
    /** `paid` carries the per-resource accumulator so the
     *  client can render independent build bars or an interrupted
     *  partial assembly. `required` is deliberately omitted: host and
     *  client must derive it from the same blueprint data, so a content
     *  version mismatch is unsupported rather than corrected here. */
    build: {
      complete: boolean;
      interrupted?: boolean;
      paid: { energy: number; metal: number };
    } | null;
    /** Extractor output in metal/sec after footprint coverage is applied. */
    metalExtractionRate: number | null;
    solar: {
      open: boolean;
    } | null;
    /** Building-mounted combat turrets use the same compact wire shape
     *  as unit turrets. Static authored data stays blueprint-derived. */
    turrets: NetworkServerSnapshotTurret[] | null;
    factory: NetworkServerSnapshotFactory | null;
  } | null;
};

export type NetworkServerSnapshotEconomy = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number };
    expenditure: number;
  };
};

/**
 * A SEATED member, as the match sees it.
 *
 * The projection of a `LobbyMember` that holds a seat, and the only shape the
 * battle handoff and the simulation ever take. Spectators have no LobbyPlayer
 * because they own nothing to simulate.
 */
export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
  /** True for a seat the sim drives — no member, no connection. */
  isBot?: boolean;
  /** The seat's INITIAL STATE axis; absent means 'commander'. */
  initialState?: SeatInitialState;
  /** Which SIDE this seat plays on — BAR calls it the ally team, the
   *  lobby labels it TEAM N. Host-authoritative: the host assigns one on
   *  join and broadcasts it, and a seat change is a host decision even
   *  when a player requested it. Teammates share a terrain slice, vision,
   *  and immunity from each other. See src/game/sim/teamRoster.ts. */
  allyTeamId: number;
  /** Public IP (v4) — populated lazily after the player's
   *  client-side IP lookup resolves and the host has fanned the
   *  value out to every connected client via
   *  the roster announcement. May be undefined briefly between the
   *  player joining and the lookup completing. */
  ipAddress: string | undefined;
  /** Coarse human-readable location ("Austin, US") from the same
   *  lookup, or a timezone-derived fallback if the IP service
   *  didn't return one. Same staleness window as `ipAddress`. */
  location: string | undefined;
  /** IANA timezone of the player's machine (e.g.
   *  `America/Los_Angeles`). Used by that player to report a
   *  formatted localTime through the host-controlled lobby stream. */
  timezone: string | undefined;
  /** Host-propagated time label last reported by that player's
   *  client heartbeat. UI displays this canonical string instead
   *  of formatting remote player times directly. */
  localTime: string | undefined;
};

export type BattleHandoff = {
  gameId: string;
  roomCode: string;
  initialization: CanonicalMatchInitialization;
  initializationHash: string;
  hostPlayerId: PlayerId;
  playerIds: PlayerId[];
  players: LobbyPlayer[];
  settings: LobbySettings;
};

export type NetworkRole = 'host' | 'client';
