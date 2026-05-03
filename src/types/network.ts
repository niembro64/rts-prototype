// Network types extracted from game/network/NetworkTypes.ts

import type { EntityType, PlayerId, TurretRanges, TurretState } from './sim';

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
export type ActionTypeCode = 0 | 1 | 2 | 3 | 4 | 5;

const _ACTION_TO_CODE: Record<string, ActionTypeCode> = {
  move: ACTION_TYPE_MOVE,
  patrol: ACTION_TYPE_PATROL,
  fight: ACTION_TYPE_FIGHT,
  build: ACTION_TYPE_BUILD,
  repair: ACTION_TYPE_REPAIR,
  attack: ACTION_TYPE_ATTACK,
};
const _CODE_TO_ACTION: string[] = ['move', 'patrol', 'fight', 'build', 'repair', 'attack'];

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
const _UNIT_TYPES: readonly string[] = [
  'jackal', 'lynx', 'badger', 'mongoose', 'mammoth',
  'tick', 'tarantula', 'loris', 'daddy', 'widow',
  'formik', 'hippo', 'commander',
];
const _UNIT_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _UNIT_TYPES.length; i++) _UNIT_TYPE_TO_CODE[_UNIT_TYPES[i]] = i;
// Sentinel for "type not in the table" — clients fall back to
// 'jackal' when decoding so an unknown id never crashes the renderer.
export const UNIT_TYPE_UNKNOWN = 0xff;
export function unitTypeToCode(s: string): number {
  const code = _UNIT_TYPE_TO_CODE[s];
  return code === undefined ? UNIT_TYPE_UNKNOWN : code;
}
export function codeToUnitType(c: number): string {
  return _UNIT_TYPES[c] ?? 'jackal';
}

// ── Building type codes ────────────────────────────────────────────
const _BUILDING_TYPES: readonly string[] = [
  'solar', 'wind', 'factory', 'extractor',
];
const _BUILDING_TYPE_TO_CODE: Record<string, number> = {};
for (let i = 0; i < _BUILDING_TYPES.length; i++) _BUILDING_TYPE_TO_CODE[_BUILDING_TYPES[i]] = i;
export const BUILDING_TYPE_UNKNOWN = 0xff;
export function buildingTypeToCode(s: string): number {
  const code = _BUILDING_TYPE_TO_CODE[s];
  return code === undefined ? BUILDING_TYPE_UNKNOWN : code;
}
export function codeToBuildingType(c: number): string {
  return _BUILDING_TYPES[c] ?? 'solar';
}

// ── Projectile type codes ──────────────────────────────────────────
export const PROJECTILE_TYPE_PROJECTILE = 0;
export const PROJECTILE_TYPE_BEAM = 1;
export const PROJECTILE_TYPE_LASER = 2;
export type ProjectileTypeCode = 0 | 1 | 2;
const _PROJECTILE_TYPE_TO_CODE: Record<string, ProjectileTypeCode> = {
  projectile: PROJECTILE_TYPE_PROJECTILE,
  beam: PROJECTILE_TYPE_BEAM,
  laser: PROJECTILE_TYPE_LASER,
};
const _CODE_TO_PROJECTILE_TYPE: ('projectile' | 'beam' | 'laser')[] = [
  'projectile', 'beam', 'laser',
];
export function projectileTypeToCode(s: string): ProjectileTypeCode {
  return _PROJECTILE_TYPE_TO_CODE[s] ?? PROJECTILE_TYPE_PROJECTILE;
}
export function codeToProjectileType(c: number): 'projectile' | 'beam' | 'laser' {
  return _CODE_TO_PROJECTILE_TYPE[c] ?? 'projectile';
}
import type { Command } from './commands';
import type { TurretAudioId, ImpactContext, SimDeathContext } from './combat';
import type { Vec2, Vec3 } from './vec2';
import type { TerrainMapShape, TerrainShape } from './terrain';

export const BATTLE_HANDOFF_PROTOCOL = 'ba-battle-handoff-v1' as const;

// Client → Server
export type NetworkPlayerActionMessage =
  | { type: 'command'; gameId?: string; data: Command }
  // Client reports its own IP / location / timezone to the host.
  // The host updates the local LobbyPlayer record and re-broadcasts
  // (see `playerInfoUpdate` below) so every connected client sees
  // the same player list with IP + location columns populated.
  | { type: 'playerInfo'; gameId?: string; ipAddress?: string; location?: string; timezone?: string }
  // Heartbeat ping. Both directions (client→host AND host→client)
  // — every peer sends one every couple seconds while the GAME
  // LOBBY is alive, and every peer monitors what it's received
  // from the others. A peer that hasn't sent in too long gets
  // its connection forcibly closed, which triggers the regular
  // `playerLeft` cleanup. Catches silent disconnects (frozen
  // tabs, network drops) that don't fire PeerJS's `close` event.
  | { type: 'heartbeat'; gameId?: string; playerId: PlayerId };

// Host → Client lobby-settings sync. Carries the host's
// pre-game choices (terrain shape today, extensible to other
// host-only knobs in the future) so every connected client sees
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
  | { type: 'playerInfoUpdate'; gameId?: string; playerId: PlayerId; ipAddress?: string; location?: string; timezone?: string };

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
    | 'projectileExpire';
  turretId: TurretAudioId;
  /** Event origin in 3D sim coords. See SimEvent in types/combat.ts. */
  pos: Vec3;
  entityId?: number;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
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
  turretId: string;
  playerId: number;
  sourceEntityId: number;
  turretIndex: number;
  /** Physical barrel within the source turret's cluster. Client passes
   *  it to getBarrelTip so the spawn visual lines up with the exact
   *  barrel the server picked. */
  barrelIndex: number;
  isDGun?: boolean;
  /** True when this projectile came from a parent detonation (e.g.
   *  cluster-flak submunitions). Client skips the barrel-tip spawn-
   *  position override and uses `pos` as-is. */
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
 *  middles set `mirrorEntityId` to the redirecting mirror unit (start
 *  and end leave it undefined). */
export type NetworkServerSnapshotBeamPoint = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mirrorEntityId?: number;
};

export type NetworkServerSnapshotBeamUpdate = {
  id: number;
  /** Polyline vertices (≥ 2). Index 0 = start (muzzle), last = end
   *  (range / hit / ground), middles = reflections. Each carries its
   *  own (vx, vy, vz) — the start finite-diffs every tick, the end
   *  and reflections finite-diff across the (LOD-strided) re-trace
   *  cadence. */
  points: NetworkServerSnapshotBeamPoint[];
  obstructionT?: number;
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
  ffAccel: { units?: boolean; shots?: boolean };
  mirrorsEnabled?: boolean;
  forceFieldsEnabled?: boolean;
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
};

export type GamePhase = 'init' | 'battle' | 'paused' | 'gameOver';

export type NetworkServerSnapshot = {
  tick: number;
  entities: NetworkServerSnapshotEntity[];
  economy: Record<PlayerId, NetworkServerSnapshotEconomy>;
  sprayTargets?: NetworkServerSnapshotSprayTarget[];
  audioEvents?: NetworkServerSnapshotSimEvent[];
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
  isDelta: boolean;
  removedEntityIds?: number[];
};

export type NetworkServerSnapshotSprayTarget = {
  source: { id: number; pos: Vec2; z?: number; playerId: PlayerId };
  target: { id: number; pos: Vec2; z?: number; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
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
    id: string;
    ranges: TurretRanges;
    angular: {
      /** Yaw (horizontal heading, rot around z-axis). */
      rot: number;
      /** Yaw angular velocity. */
      vel: number;
      acc: number;
      drag: number;
      /** Pitch (vertical aim, elevation angle). */
      pitch: number;
    };
    pos: {
      offset: Vec2;
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

export type NetworkServerSnapshotEntity = {
  id: number;
  type: EntityType;
  /** 3D position (x,y = plane, z = altitude). The 2D client reads only
   *  x/y; the 3D client reads all three. */
  pos: Vec3;
  rotation: number;
  posEnd?: Vec3;
  playerId: PlayerId;
  changedFields?: number | null;
  unit?: {
    /** Static fields are present on full records and omitted from
     *  ordinary deltas after the entity has been created.
     *  Numeric wire ID — see UNIT_TYPE_* / unitTypeToCode helpers. */
    unitType?: number;
    hp: { curr: number; max: number };
    collider?: { shot: number; push: number };
    /** Authored body radius — the unit's visible-chassis size. Drives
     *  turret head defaults, chassis-mount offsets, mirror-panel sizing,
     *  click hit radius, etc. Was historically `collider.scale`; lifted
     *  to its own field so it isn't conflated with collision (`shot` /
     *  `push` stay on `collider`). */
    bodyRadius?: number;
    bodyCenterHeight?: number;
    mass?: number;
    velocity: Vec3;
    turretRotation?: number;
    isCommander?: boolean;
    buildTargetId?: number;
    actions?: NetworkServerSnapshotAction[];
    turrets?: NetworkServerSnapshotTurret[];
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
    build: { progress: number; complete: boolean };
    /** Extractor output in metal/sec after footprint coverage is applied. */
    metalExtractionRate?: number;
    solar?: {
      open: boolean;
    };
    factory?: {
      /** Queue of unit type codes (see UNIT_TYPE_* / unitTypeToCode). */
      queue: number[];
      progress: number;
      producing: boolean;
      /** `posZ` carries the click-altitude of the player-issued
       *  factory waypoint; absent for synthetic / legacy waypoints
       *  (renderers fall back to terrain sample). */
      waypoints: { pos: Vec2; posZ?: number; type: string }[];
    };
  };
  shot?: {
    /** Projectile type code — see PROJECTILE_TYPE_* / projectileTypeToCode. */
    type: ProjectileTypeCode;
    source: number;
    turretId?: string;
    turretIndex?: number;
    velocity?: Vec3;
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
   *  `America/Los_Angeles`). Lets every viewer render the
   *  player's CURRENT local time + timezone abbreviation in
   *  the lobby roster, ticking live in their own browser. */
  timezone?: string;
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
