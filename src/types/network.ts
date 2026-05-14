// Network types extracted from game/network/NetworkTypes.ts

import {
  BUILDING_TYPE_IDS,
  SHOT_IDS,
  TURRET_IDS,
  UNIT_TYPE_IDS,
} from './blueprintIds';
import type { ShotId, TurretId } from './blueprintIds';
import type { BeamReflectorKind, EntityType, PlayerId, TurretState } from './sim';

// ── Bit-packed enum codes for the wire format ─────────────────────
// String enums compress poorly even after msgpack — every "tracking"
// is 8 bytes plus a length tag. These ints take 1 byte each.

export const TURRET_STATE_IDLE = 0;
export const TURRET_STATE_TRACKING = 1;
export const TURRET_STATE_ENGAGED = 2;
export type TurretStateCode = 0 | 1 | 2;

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

export const ACTION_TYPE_MOVE = 0;
export const ACTION_TYPE_PATROL = 1;
export const ACTION_TYPE_FIGHT = 2;
export const ACTION_TYPE_BUILD = 3;
export const ACTION_TYPE_REPAIR = 4;
export const ACTION_TYPE_ATTACK = 5;
export const ACTION_TYPE_GUARD = 6;
export const ACTION_TYPE_RECLAIM = 7;
export const ACTION_TYPE_ATTACK_GROUND = 8;
export const ACTION_TYPE_WAIT = 9;
export type ActionTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const _ACTION_TO_CODE: Record<string, ActionTypeCode> = {
  move: ACTION_TYPE_MOVE,
  patrol: ACTION_TYPE_PATROL,
  fight: ACTION_TYPE_FIGHT,
  build: ACTION_TYPE_BUILD,
  repair: ACTION_TYPE_REPAIR,
  reclaim: ACTION_TYPE_RECLAIM,
  wait: ACTION_TYPE_WAIT,
  attack: ACTION_TYPE_ATTACK,
  attackGround: ACTION_TYPE_ATTACK_GROUND,
  guard: ACTION_TYPE_GUARD,
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
];

export function actionTypeToCode(s: string): ActionTypeCode {
  return _ACTION_TO_CODE[s] ?? ACTION_TYPE_MOVE;
}
export function codeToActionType(c: number): string {
  return _CODE_TO_ACTION[c] ?? 'move';
}

// ── Unit type codes ────────────────────────────────────────────────
// Stable wire IDs for every unit-type string. Order is append-only:
// new units go at the end so existing replays / cross-version snapshots
// keep decoding correctly. The string form lives at runtime (entity
// .unit.unitType) and on the client side after decode — only the
// serializer / deserializer touches the int form.
const _UNIT_TYPES = UNIT_TYPE_IDS;
export function getNetworkUnitTypeIds(): readonly string[] {
  return _UNIT_TYPES;
}
const _UNIT_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _UNIT_TYPES.length; i++) _UNIT_TYPE_TO_CODE[_UNIT_TYPES[i]] = i;
// Sentinel for "type not in the table". Decoders return null for
// unknown codes so receivers drop/reject invalid wire data instead of
// silently turning it into a different real gameplay object.
export const UNIT_TYPE_UNKNOWN = 0xff;
export function unitTypeToCode(s: string): number {
  const code = _UNIT_TYPE_TO_CODE[s];
  return code === undefined ? UNIT_TYPE_UNKNOWN : code;
}
export function codeToUnitType(c: number): string | null {
  return _UNIT_TYPES[c] ?? null;
}

// ── Building type codes ────────────────────────────────────────────
const _BUILDING_TYPES = BUILDING_TYPE_IDS;
export function getNetworkBuildingTypeIds(): readonly string[] {
  return _BUILDING_TYPES;
}
const _BUILDING_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _BUILDING_TYPES.length; i++) _BUILDING_TYPE_TO_CODE[_BUILDING_TYPES[i]] = i;
export const BUILDING_TYPE_UNKNOWN = 0xff;
export function buildingTypeToCode(s: string): number {
  const code = _BUILDING_TYPE_TO_CODE[s];
  return code === undefined ? BUILDING_TYPE_UNKNOWN : code;
}
export function codeToBuildingType(c: number): string | null {
  return _BUILDING_TYPES[c] ?? null;
}

// ── Projectile type codes ──────────────────────────────────────────
export const PROJECTILE_TYPE_PROJECTILE = 0;
export const PROJECTILE_TYPE_BEAM = 1;
export const PROJECTILE_TYPE_LASER = 2;
export const PROJECTILE_TYPE_UNKNOWN = 0xff;
export type ProjectileTypeCode = number;
const _PROJECTILE_TYPE_TO_CODE: Record<string, ProjectileTypeCode> = {
  projectile: PROJECTILE_TYPE_PROJECTILE,
  beam: PROJECTILE_TYPE_BEAM,
  laser: PROJECTILE_TYPE_LASER,
};
const _CODE_TO_PROJECTILE_TYPE: ('projectile' | 'beam' | 'laser')[] = [
  'projectile', 'beam', 'laser',
];
export function projectileTypeToCode(s: string): ProjectileTypeCode {
  return _PROJECTILE_TYPE_TO_CODE[s] ?? PROJECTILE_TYPE_UNKNOWN;
}
export function codeToProjectileType(c: number): 'projectile' | 'beam' | 'laser' | null {
  return _CODE_TO_PROJECTILE_TYPE[c] ?? null;
}

/** Code-form sibling of `isLineShotType` from types/sim.ts — true for
 *  the projectile-type codes that correspond to line shots (beam +
 *  laser). Adding a new line-shot type means extending both
 *  LINE_SHOT_TYPES (string side) and this code list. */
export function isLineProjectileTypeCode(code: ProjectileTypeCode): boolean {
  return code === PROJECTILE_TYPE_BEAM || code === PROJECTILE_TYPE_LASER;
}

// ── Shot blueprint codes ───────────────────────────────────────────
// Append-only, validated against SHOT_BLUEPRINTS at startup.
const _SHOT_TYPES = SHOT_IDS;
export type ShotTypeCode = number;
export const SHOT_ID_UNKNOWN = 0xff;
export function getNetworkShotIds(): readonly string[] {
  return _SHOT_TYPES;
}
const _SHOT_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _SHOT_TYPES.length; i++) _SHOT_TYPE_TO_CODE[_SHOT_TYPES[i]] = i;
export function shotIdToCode(s: string): ShotTypeCode {
  const code = _SHOT_TYPE_TO_CODE[s];
  return code === undefined ? SHOT_ID_UNKNOWN : code;
}
export function codeToShotId(c: number): ShotId | null {
  return _SHOT_TYPES[c] ?? null;
}

// ── Turret blueprint codes ─────────────────────────────────────────
// Append-only, validated against TURRET_BLUEPRINTS at startup.
const _TURRET_TYPES = TURRET_IDS;
export type TurretTypeCode = number;
export const TURRET_ID_UNKNOWN = 0xff;
export function getNetworkTurretIds(): readonly string[] {
  return _TURRET_TYPES;
}
const _TURRET_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _TURRET_TYPES.length; i++) _TURRET_TYPE_TO_CODE[_TURRET_TYPES[i]] = i;
export function turretIdToCode(s: string): TurretTypeCode {
  const code = _TURRET_TYPE_TO_CODE[s];
  return code === undefined ? TURRET_ID_UNKNOWN : code;
}
export function codeToTurretId(c: number): TurretId | null {
  return _TURRET_TYPES[c] ?? null;
}
import type { Command } from './commands';
import type { SimEventAudioKey, ImpactContext, SimDeathContext, SimEventSourceType, ForceFieldImpactContext } from './combat';
import type { ForceFieldReflectionMode } from './shotTypes';
import type { Vec2, Vec3 } from './vec2';
import type {
  TerrainBuildabilityGrid,
  TerrainMapShape,
  TerrainShape,
  TerrainTileMap,
} from './terrain';

export const BATTLE_HANDOFF_PROTOCOL = 'ba-battle-handoff-v1' as const;

export type LobbyPlayerInfoPayload = {
  ipAddress?: string;
  location?: string;
  timezone?: string;
  localTime?: string;
  name?: string;
};

// Client → Server
export type NetworkPlayerActionMessage =
  | { type: 'command'; gameId?: string; data: Command }
  | { type: 'clientReady'; gameId?: string }
  // Client reports its own IP / location / timezone to the host.
  // The host updates the local LobbyPlayer record and re-broadcasts
  // (see `playerInfoUpdate` below) so every connected client sees
  // the same player list with IP + location columns populated.
  | {
      type: 'playerInfo';
      gameId?: string;
      ipAddress?: string;
      location?: string;
      timezone?: string;
      localTime?: string;
      /** Optional rename — set when the local user edits their own
       *  lobby player slot. Host re-broadcasts via `playerInfoUpdate`. */
      name?: string;
    }
  // Heartbeat ping. Both directions (client→host AND host→client)
  // — every peer sends one every couple seconds while the GAME
  // LOBBY is alive, and every peer monitors what it's received
  // from the others. Clients attach their own latest lobby info;
  // the host attaches the authoritative roster back to clients.
  // A peer that hasn't sent in too long gets its connection
  // forcibly closed, which triggers the regular `playerLeft`
  // cleanup. Catches silent disconnects (frozen tabs, network
  // drops) that don't fire PeerJS's `close` event.
  | {
      type: 'heartbeat';
      gameId?: string;
      playerId: PlayerId;
      playerInfo?: LobbyPlayerInfoPayload;
      players?: LobbyPlayer[];
    };

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
  terrainCenter: TerrainShape;
  terrainDividers: TerrainShape;
  terrainMapShape: TerrainMapShape;
  mapWidthLandCells: number;
  mapLengthLandCells: number;
  fogOfWarEnabled?: boolean;
};

// Server → Client
export type NetworkServerSnapshotMessage =
  | { type: 'state'; gameId?: string; data: NetworkServerSnapshot | string | Uint8Array | ArrayBuffer }
  | { type: 'playerAssignment'; playerId: PlayerId; gameId?: string }
  | {
      type: 'gameStart';
      playerIds: PlayerId[];
      gameId?: string;
      handoff?: BattleHandoff;
      assignedPlayerId?: PlayerId;
    }
  | { type: 'playerJoined'; gameId?: string; playerId: PlayerId; playerName: string }
  | { type: 'playerLeft'; gameId?: string; playerId: PlayerId }
  | { type: 'lobbySettings'; gameId?: string; settings: LobbySettings }
  // Host fans a player's IP + location out to every connected
  // client (whoever just resolved their ipapi.co lookup, or a
  // back-fill on `playerJoined` for late-joiners). Carries
  // playerId so receivers can match it to their player list.
  | {
      type: 'playerInfoUpdate';
      gameId?: string;
      playerId: PlayerId;
      ipAddress?: string;
      location?: string;
      timezone?: string;
      localTime?: string;
      /** Optional rename. Sent by the host whenever a player's
       *  username changes from their own lobby slot, or when the host
       *  receives a `playerInfo` rename. Receivers update the matching
       *  LobbyPlayer.name in place. */
      name?: string;
    };

// Combined (transport envelope)
export type NetworkMessage = NetworkPlayerActionMessage | NetworkServerSnapshotMessage;

export type NetworkServerSnapshotSimEvent = {
  type:
    | 'fire'
    | 'hit'
    | 'death'
    | 'laserStart'
    | 'laserStop'
    | 'forceFieldStart'
    | 'forceFieldStop'
    | 'forceFieldImpact'
    | 'ping'
    | 'attackAlert'
    | 'projectileExpire';
  turretId: SimEventAudioKey;
  sourceType?: SimEventSourceType;
  sourceKey?: string;
  /** Event origin in 3D sim coords. See SimEvent in types/combat.ts. */
  pos: Vec3;
  playerId?: PlayerId;
  entityId?: number;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
  forceFieldImpact?: ForceFieldImpactContext;
  /** For 'death' events: playerId of the entity that landed the
   *  killing blow. Carries through serializeAudioEvents' kill-credit
   *  branch (issues.txt FOW-17) — the audio serializer forwards the
   *  event to this player's snapshot even when the death position
   *  isn't in their vision, so they get the "+1, you got it" hit
   *  even on off-screen kills. */
  killerPlayerId?: PlayerId;
  /** For 'attackAlert' events: playerId of the victim taking damage.
   *  Drives the FOW-08-followup remainder routing — the alert is
   *  forwarded to this player's snapshot regardless of vision so they
   *  see a marker at the attacker's position when un-homed splash
   *  damage from inside the fog lands on their unit. */
  victimPlayerId?: PlayerId;
  /** FOW-09 earshot reveal flag. When true, the client should play
   *  the audio side of the event but skip every visual branch —
   *  "distant gunfire from over there" without leaking the position
   *  through an explosion sprite. Server sets it when forwarding an
   *  event outside the recipient's vision but within their earshot
   *  pad; never set in-vision. */
  audioOnly?: boolean;
};

/** Wire shape for the FOW-11 keyframe shroud payload. cellSize is
 *  echoed for forwards-compat — clients can render at any resolution
 *  by resampling. The bitmap is BIT-PACKED row-major
 *  (issues.txt FOW-OPT-02): cell index `i = cy * gridW + cx` lives in
 *  byte `i >> 3` at bit `i & 7`, so the wire array length is
 *  `((gridW * gridH) + 7) >> 3` — 1/8 the byte-per-cell cost. 0 =
 *  never explored, 1 = ever explored. Already team-merged
 *  (recipient + allies) on the server. Skipped on keyframes when the
 *  team's bitmap is unchanged since the last ship to this listener,
 *  so the field stays absent on long static stretches even at
 *  keyframe cadence. */
export type NetworkServerSnapshotShroud = {
  gridW: number;
  gridH: number;
  cellSize: number;
  bitmap: Uint8Array;
};

/** Wire shape for an active scan pulse (FOW-14). Only the geometric
 *  info the client needs to draw vision through the shroud — the
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
  pos: Vec3;
  rotation: number;
  velocity: Vec3;
  /** Bit-packed projectile type code (see PROJECTILE_TYPE_* constants
   *  and projectileTypeToCode / codeToProjectileType helpers). */
  projectileType: ProjectileTypeCode;
  /** Resolved per-instance max lifespan in ms. */
  maxLifespan?: number;
  /** Compatibility/source turret wire code. Prefer sourceTurretId + shotId. */
  turretId: TurretTypeCode;
  /** Actual shot blueprint wire code for client hydration. */
  shotId?: ShotTypeCode;
  /** Real turret blueprint wire code that authored this projectile. */
  sourceTurretId?: TurretTypeCode;
  playerId: number;
  sourceEntityId: number;
  turretIndex: number;
  /** Barrel selected for visual/audio cadence within the source turret's cluster.
   *  Authoritative shots spawn from the turret mount center. */
  barrelIndex: number;
  isDGun?: boolean;
  /** True when this projectile came from a parent detonation (e.g.
   *  cluster-flak submunitions) rather than a turret launch. */
  fromParentDetonation?: boolean;
  beam?: { start: Vec3; end: Vec3 };
  targetEntityId?: number;
  homingTurnRate?: number;
};

export type NetworkServerSnapshotProjectileDespawn = {
  id: number;
};

export type NetworkServerSnapshotVelocityUpdate = {
  id: number;
  pos: Vec3;
  velocity: Vec3;
};

/** Wire-format vertex of a beam/laser polyline. The full beam is
 *  `points = [start, ...reflections, end]`. Each vertex carries its
 *  own instantaneous 3D velocity in the world frame so the client can
 *  extrapolate every vertex independently between snapshots; the
 *  reflector vertices set `mirrorEntityId` to the redirecting reflector
 *  entity (legacy field name; mirrors and force fields both use it).
 *  Start leaves it undefined; the end can carry reflector metadata
 *  when the authoritative max-segment cap terminated on a reflector. */
export type NetworkServerSnapshotBeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  /** Legacy name: any beam reflector entity, not only mirrors. */
  mirrorEntityId?: number;
  reflectorKind?: BeamReflectorKind;
  reflectorPlayerId?: PlayerId;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
};

export type NetworkServerSnapshotBeamUpdate = {
  id: number;
  /** Polyline vertices (≥ 2). Index 0 = start (turret mount center), last = end
   *  (range / hit / ground / terminal reflector), middles = reflections. Each carries its
   *  own position, velocity, and acceleration — the start updates
   *  every tick, while the end and reflections finite-diff across the
   *  (LOD-strided) re-trace cadence. */
  points: NetworkServerSnapshotBeamPoint[];
  obstructionT?: number;
  /** False when the authoritative path has no physical impact endpoint,
   *  so clients should not render an endpoint damage orb. */
  endpointDamageable?: boolean;
};

export type NetworkServerSnapshotGridCell = {
  cell: Vec3;
  players: number[];
};

export type NetworkServerSnapshotMeta = {
  ticks: {
    avg: number;
    low: number;
    /** Effective tick rate after adaptive host throttling. */
    rate: number;
    /** User-selected HOST SERVER TARGET TPS. */
    target: number;
  };
  snaps: { rate: number | 'none'; keyframes: number | 'ALL' | 'NONE' };
  server: { time: string; ip: string };
  grid: boolean;
  units: { allowed?: string[]; max?: number; count?: number };
  mirrorsEnabled?: boolean;
  forceFieldsEnabled?: boolean;
  forceFieldsBlockTargeting?: boolean;
  forceFieldReflectionMode?: ForceFieldReflectionMode;
  fogOfWarEnabled?: boolean;
  /** Host CPU load as a percent of the per-tick budget (1000/tickRate ms).
   *  `avg` = EMA-smoothed steady-state load; `hi` = EMA spike, climbs fast
   *  on jumps and decays slowly. Both can exceed 100 when the server is
   *  falling behind (tick work > tick budget). */
  cpu?: { avg: number; hi: number };
  /** HOST SERVER LOD state. `picked` is the user's choice (auto or a
   *  fixed tier). `effective` is the concrete tier that's actually
   *  driving sim throttling this tick (after the auto resolver
   *  runs). `signals` carries the per-signal tri-state so the host
   *  bar can render off / active / solo on each button — same shape
   *  the client side uses for its own LOD bar. Wire format is bare
   *  strings — keeps msgpack delta-friendly. */
  simLod?: {
    picked: string;
    effective: string;
    signals?: { tps: string; cpu: string; units: string };
  };
  wind?: {
    x: number;
    y: number;
    speed: number;
    angle: number;
  };
  /** HOST SERVER chassis-tilt EMA mode (TILT_EMA_HALF_LIFE_SEC key).
   *  Bare string on the wire — the value space is just 'snap' / 'fast'
   *  / 'mid' / 'slow', matching the same delta-friendly pattern as
   *  simLod.picked. Remote clients read this so their HOST SERVER tilt
   *  bar reflects the host's setting rather than their own stale
   *  localStorage. */
  tiltEma?: string;
};

export type GamePhase = 'init' | 'battle' | 'paused' | 'gameOver';

export type NetworkServerSnapshot = {
  tick: number;
  entities: NetworkServerSnapshotEntity[];
  minimapEntities?: NetworkServerSnapshotMinimapEntity[];
  economy: Record<PlayerId, NetworkServerSnapshotEconomy>;
  sprayTargets?: NetworkServerSnapshotSprayTarget[];
  audioEvents?: NetworkServerSnapshotSimEvent[];
  /** Active temporary vision pulses (FOW-14 — scanner sweeps) owned
   *  by the recipient or one of their allies, with the tick they
   *  expire on. The client passes these into FogOfWarShroudRenderer3D
   *  so the shroud lifts inside the sweep radius the same way it
   *  does around a unit's vision circle. Omitted when no pulses are
   *  live for the recipient's team. */
  scanPulses?: NetworkServerSnapshotScanPulse[];
  /** Authoritative explored-tile bitmap for this recipient
   *  (FOW-11). One byte per (cellSize × cellSize) cell, 0 = never
   *  explored, 1 = ever explored. Sent on keyframes only — the
   *  client OR-s its local bitmap with this so a mid-game join /
   *  reconnect restores the dark-shroud history that local vision
   *  tracking alone can't reconstruct. Already team-merged on the
   *  server (recipient + allies). */
  shroud?: NetworkServerSnapshotShroud;
  projectiles?: {
    spawns?: NetworkServerSnapshotProjectileSpawn[];
    despawns?: NetworkServerSnapshotProjectileDespawn[];
    velocityUpdates?: NetworkServerSnapshotVelocityUpdate[];
    /** Authoritative live beam/laser paths. Sent every snapshot so
     *  clients draw reflected segments directly instead of re-tracing
     *  mirror/unit/building intersections in the render frame. */
    beamUpdates?: NetworkServerSnapshotBeamUpdate[];
  };
  gameState?: { phase: GamePhase; winnerId?: PlayerId };
  serverMeta?: NetworkServerSnapshotMeta;
  grid?: {
    cells: NetworkServerSnapshotGridCell[];
    searchCells: NetworkServerSnapshotGridCell[];
    cellSize: number;
  };
  capture?: {
    tiles: import('./capture').NetworkCaptureTile[];
    cellSize: number;
  };
  terrain?: TerrainTileMap;
  buildability?: TerrainBuildabilityGrid;
  isDelta: boolean;
  /** True when the authoritative snapshot intentionally omits entities
   *  outside the recipient player's current vision. Clients must keep
   *  absent full-keyframe entities as last-seen state unless an explicit
   *  removal arrives. */
  visibilityFiltered?: boolean;
  removedEntityIds?: number[];
};

export type NetworkServerSnapshotMinimapEntity = {
  id: number;
  pos: Vec2;
  type: 'unit' | 'building';
  playerId: PlayerId;
  /** True when the recipient only learned about this entity through
   *  radar coverage (no full-vision source covers its position). The
   *  client should render it as a generic positional blip — no unit
   *  type / owner-color identification — since the player only has
   *  positional intel. Omitted (treated as false) for entities the
   *  recipient sees in full. */
  radarOnly?: boolean;
};

export type NetworkServerSnapshotSprayTarget = {
  source: { id: number; pos: Vec2; z?: number; playerId: PlayerId };
  target: { id: number; pos: Vec2; z?: number; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
  speed?: number;
  particleRadius?: number;
};

export type NetworkServerSnapshotAction = {
  /** Bit-packed action type code (see ACTION_TYPE_* constants and
   *  actionTypeToCode / codeToActionType helpers). String form used
   *  to take 6-12 bytes per action; the int code is one byte. */
  type: ActionTypeCode;
  pos?: Vec2;
  /** Altitude (sim.z = three.y) of the action's 3D ground point —
   *  the original click point that produced this action, preserved
   *  so joining clients see waypoint markers at the same altitude
   *  the issuing client did. Sent only when the action carries a
   *  click-derived z (renderers fall back to a terrain sample when
   *  absent). */
  posZ?: number;
  /** True for path-expansion intermediates (cells the planner
   *  inserted along the route). Used by the client renderer to hide
   *  these in SIMPLE waypoint mode. Omitted when false to save bytes
   *  — the renderer treats `undefined` as `false`. */
  pathExp?: boolean;
  targetId?: number;
  buildingType?: string;
  grid?: Vec2;
  buildingId?: number;
};

export type NetworkServerSnapshotTurret = {
  turret: {
    /** Turret blueprint wire code for slot validation only. Static authored
     *  data such as ranges/turn acceleration/drag stays client-local
     *  and blueprint-derived. */
    id: TurretTypeCode;
    angular: {
      /** Yaw (horizontal heading, rot around z-axis). */
      rot: number;
      /** Yaw angular velocity (rad/s). */
      vel: number;
      /** Yaw angular acceleration (rad/s²) from this tick's
       *  damped-spring step. PREDICT ACC clients integrate
       *  `vel += acc · dt` before stepping `rot`. */
      acc: number;
      /** Pitch (vertical aim, elevation angle). */
      pitch: number;
      /** Pitch angular velocity (rad/s). */
      pitchVel: number;
      /** Pitch angular acceleration (rad/s²); same role as `acc`. */
      pitchAcc: number;
    };
  };
  targetId?: number;
  /** Bit-packed turret state code (see TURRET_STATE_* constants and
   *  turretStateToCode / codeToTurretState helpers). */
  state: TurretStateCode;
  currentForceFieldRange?: number;
};

// Bitmask for per-field delta updates within an entity.
// When absent/null (keyframe or new entity), all fields are present.
// MessagePack decodes own `undefined` properties as null, so network
// clients must accept both absent and null as "full record".
// When set (delta update), only flagged field groups are populated.
export const ENTITY_CHANGED_POS       = 1 << 0;
export const ENTITY_CHANGED_ROT       = 1 << 1;
export const ENTITY_CHANGED_VEL       = 1 << 2;
export const ENTITY_CHANGED_HP        = 1 << 3;
export const ENTITY_CHANGED_ACTIONS   = 1 << 4;
export const ENTITY_CHANGED_TURRETS   = 1 << 5;
export const ENTITY_CHANGED_BUILDING  = 1 << 6;
export const ENTITY_CHANGED_FACTORY   = 1 << 7;
/** The unit's smoothed surface normal moved past wire precision while
 *  the unit didn't (e.g. EMA still settling after the unit stopped, or
 *  a tilt-mode change kicked off fresh drift). Without this bit the
 *  normal could only ride POS-bit deltas, so stationary units would
 *  hold a stale tilt until they moved or until the next keyframe. */
export const ENTITY_CHANGED_NORMAL    = 1 << 8;
/** Visible chassis suspension offset/velocity changed. This is
 *  separate from POS because the locomotion anchor can remain still
 *  while the chassis spring bounces relative to it. */
export const ENTITY_CHANGED_SUSPENSION = 1 << 9;
/** Current server-authored movement acceleration changed. This lets
 *  clients predict powered ground movement with the same force input
 *  the server applied, without cloning the full command planner. */
export const ENTITY_CHANGED_MOVEMENT_ACCEL = 1 << 10;
/** Grounded jump actuator state changed. This is separate from visible
 *  suspension so jump-capable units do not need chassis spring state. */
export const ENTITY_CHANGED_JUMP = 1 << 11;
/** Player-controlled combat mode such as fire/hold-fire changed. */
export const ENTITY_CHANGED_COMBAT_MODE = 1 << 12;

export type NetworkServerSnapshotEntity = {
  id: number;
  type: EntityType;
  /** 3D position (x,y = plane, z = altitude). The 2D client reads only
   *  x/y; the 3D client reads all three. */
  pos: Vec3;
  rotation: number;
  playerId: PlayerId;
  changedFields?: number | null;
  unit?: {
    /** Static fields are present on full records and omitted from
     *  ordinary deltas after the entity has been created.
     *  Numeric wire ID — see UNIT_TYPE_* / unitTypeToCode helpers. */
    unitType?: number;
    hp: { curr: number; max: number };
    /** Unit radii. Static on full records and omitted from ordinary
     *  deltas unless the unit blueprint/runtime radius changes. */
    radius?: { body?: number; shot?: number; push?: number };
    bodyCenterHeight?: number;
    mass?: number;
    velocity: Vec3;
    /** Server-authored movement/traction acceleration for client
     *  prediction. Excludes gravity, terrain spring, damping, jump
     *  actuation, and transient external knockback/recoil forces. */
    movementAccel?: Vec3;
    /** Per-unit smoothed surface normal (unit-length nx, ny, nz). The
     *  sim EMA-blends raw → smoothed each tick (see updateUnitTilt) so
     *  the rendered chassis tilt and the slope-tilted turret world
     *  mounts can read the same canonical value here instead of
     *  re-querying the position-keyed terrain cache and getting a
     *  triangle-snapping raw normal. Quantized to 0.001 precision on
     *  the wire (qNormal); ~3 bytes per unit per snapshot after delta
     *  encoding. Omitted on snapshots where the unit's tilt didn't
     *  change since last keyframe. */
    surfaceNormal?: { nx: number; ny: number; nz: number };
    /** Runtime chassis suspension relative to the locomotion anchor.
     *  Offsets are chassis-local: x = forward, y = lateral, z = up. */
    suspension?: {
      offset: Vec3;
      velocity: Vec3;
      legContact?: boolean;
    };
    jump?: {
      enabled?: boolean;
      active?: boolean;
      launchSeq?: number;
    };
    fireEnabled?: boolean;
    isCommander?: boolean;
    buildTargetId?: number | null;
    actions?: NetworkServerSnapshotAction[];
    turrets?: NetworkServerSnapshotTurret[];
    /** Unit shell construction state. Present whenever the unit was
     *  spawned by a factory and is still being funded by it. Same
     *  shape as `building.build`. Omitted (or `complete: true`) once
     *  the unit becomes active. */
    build?: {
      complete: boolean;
      paid: { energy: number; mana: number; metal: number };
    };
  };
  building?: {
    /** type / dim are present on full records and omitted from
     *  ordinary deltas after the entity has been created.
     *  Numeric wire ID — see BUILDING_TYPE_* / buildingTypeToCode helpers. */
    type?: number;
    /** Footprint in world units — planar xy is dim.x/dim.y. Full
     *  depth (vertical extent) lives on the building entity, not
     *  here — clients re-derive it from the blueprint. */
    dim?: Vec2;
    hp: { curr: number; max: number };
    /** `paid.{e,m,m}` carries the per-resource accumulator so the
     *  client can render three independent build bars; `required` is
     *  omitted because the client re-derives it from the entity's
     *  blueprint. The avg-of-three fill ratio (formerly `progress`)
     *  is computed client-side via `getBuildFraction(buildable)`. */
    build: {
      complete: boolean;
      paid: { energy: number; mana: number; metal: number };
    };
    /** Extractor output in metal/sec after footprint coverage is applied. */
    metalExtractionRate?: number;
    solar?: {
      open: boolean;
    };
    /** Building-mounted combat turrets use the same compact wire shape
     *  as unit turrets. Static authored data stays blueprint-derived. */
    turrets?: NetworkServerSnapshotTurret[];
    factory?: {
      /** Queue of unit type codes (see UNIT_TYPE_* / unitTypeToCode). */
      queue: number[];
      /** Avg-of-three fill of the factory's currentShellId, or 0 if
       *  the factory hasn't spawned a shell yet. The client re-derives
       *  per-resource bars from the shell entity itself; this field is
       *  kept as a convenience for the build-queue UI strip. */
      progress: number;
      producing: boolean;
      /** Per-resource transfer rate this tick (0..1 fraction of the
       *  factory's max rate cap). Drives the three "shower" cylinders
       *  around the factory's pylons. */
      energyRate: number;
      manaRate: number;
      metalRate: number;
      /** `posZ` carries the click-altitude of the player-issued
       *  factory waypoint; absent for synthetic / legacy waypoints
       *  (renderers fall back to terrain sample). */
      waypoints: { pos: Vec2; posZ?: number; type: string }[];
    };
  };
};

export type NetworkServerSnapshotEconomy = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  mana: {
    stockpile: { curr: number; max: number };
    income: { base: number; territory: number };
    expenditure: number;
  };
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number };
    expenditure: number;
  };
};

export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
  /** Public IP (v4) — populated lazily after the player's
   *  client-side IP lookup resolves and the host has fanned the
   *  value out to every connected client via
   *  `playerInfoUpdate`. May be undefined briefly between the
   *  player joining and the lookup completing. */
  ipAddress?: string;
  /** Coarse human-readable location ("Austin, US") from the same
   *  lookup, or a timezone-derived fallback if the IP service
   *  didn't return one. Same staleness window as `ipAddress`. */
  location?: string;
  /** IANA timezone of the player's machine (e.g.
   *  `America/Los_Angeles`). Used by that player to report a
   *  formatted localTime through the host-controlled lobby stream. */
  timezone?: string;
  /** Host-propagated time label last reported by that player's
   *  client heartbeat. UI displays this canonical string instead
   *  of formatting remote player times directly. */
  localTime?: string;
};

export type BattleHandoff = {
  protocol: typeof BATTLE_HANDOFF_PROTOCOL;
  gameId: string;
  roomCode: string;
  hostPlayerId: PlayerId;
  playerIds: PlayerId[];
  players: LobbyPlayer[];
  settings?: LobbySettings;
};

export type NetworkRole = 'host' | 'client';
