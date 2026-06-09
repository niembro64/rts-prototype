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
import type { KeyframeRatio, SnapshotRate, TickRate } from './server';
import type { BeamReflectorKind, CombatFireState, CombatTrajectoryMode, EntityType, PlayerId, TurretState, UnitMoveState } from './sim';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
// Single source of truth for the wire codes TS and Rust must agree on.
// Rust generates its constants from this same file via build.rs.
import wireEnums from '../wireEnums.json';

// ── Bit-packed enum codes for the wire format ─────────────────────
// String enums compress poorly even after msgpack — every "tracking"
// is 8 bytes plus a length tag. These ints take 1 byte each.

export const TURRET_STATE_IDLE = wireEnums.turretState.idle;
export const TURRET_STATE_TRACKING = wireEnums.turretState.tracking;
export const TURRET_STATE_ENGAGED = wireEnums.turretState.engaged;
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
export const ACTION_TYPE_CAPTURE = 10;
export const ACTION_TYPE_RESURRECT = 11;
export type ActionTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

const _ACTION_TO_CODE: Record<string, ActionTypeCode> = {
  move: ACTION_TYPE_MOVE,
  patrol: ACTION_TYPE_PATROL,
  fight: ACTION_TYPE_FIGHT,
  build: ACTION_TYPE_BUILD,
  repair: ACTION_TYPE_REPAIR,
  reclaim: ACTION_TYPE_RECLAIM,
  capture: ACTION_TYPE_CAPTURE,
  resurrect: ACTION_TYPE_RESURRECT,
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
  'capture',
  'resurrect',
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

/** Code-form sibling of `isRayType` from types/sim.ts — true for
 *  the projectile-type codes that correspond to line shots (beam +
 *  laser). Adding a new line-shot type means extending both
 *  RAY_TYPES (string side) and this code list. */
export function isLineProjectileTypeCode(code: ProjectileTypeCode): boolean {
  return code === PROJECTILE_TYPE_BEAM || code === PROJECTILE_TYPE_LASER;
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
import type { Command } from './commands';
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
import type { SnapshotCompressionFormat } from './config';
import type {
  TerrainBuildabilityGrid,
  TerrainMapShape,
  TerrainTileMap,
} from './terrain';

export const BATTLE_HANDOFF_PROTOCOL = 'ba-battle-handoff-v1' as const;

export type LobbyPlayerInfoPayload = {
  ipAddress: string | undefined;
  location: string | undefined;
  timezone: string | undefined;
  localTime: string | undefined;
  name: string | undefined;
};

export type NetworkCommunicationPoint = {
  x: number;
  y: number;
  z?: number;
};

export type NetworkCommunicationDraft =
  | {
      kind: 'chat';
      clientEventId: string;
      text: string;
    }
  | {
      kind: 'mapDrawing';
      clientEventId: string;
      drawingId: string;
      drawingKind: 'line' | 'label';
      points: NetworkCommunicationPoint[];
      label?: string;
    }
  | {
      kind: 'mapErase';
      clientEventId: string;
      scope: 'all' | 'radius';
      center?: NetworkCommunicationPoint;
      radius?: number;
    };

export type NetworkCommunicationChatEvent = {
  kind: 'chat';
  id: string;
  senderPlayerId: PlayerId;
  createdAtMs: number;
  text: string;
};

export type NetworkCommunicationMapDrawingEvent = {
  kind: 'mapDrawing';
  id: string;
  senderPlayerId: PlayerId;
  createdAtMs: number;
  drawingId: string;
  drawingKind: 'line' | 'label';
  points: NetworkCommunicationPoint[];
  label?: string;
};

export type NetworkCommunicationMapEraseEvent = {
  kind: 'mapErase';
  id: string;
  senderPlayerId: PlayerId;
  createdAtMs: number;
  scope: 'all' | 'radius';
  center?: NetworkCommunicationPoint;
  radius?: number;
};

export type NetworkCommunicationEvent =
  | NetworkCommunicationChatEvent
  | NetworkCommunicationMapDrawingEvent
  | NetworkCommunicationMapEraseEvent;

// Client → Server
export type NetworkPlayerActionMessage =
  | { type: 'command'; gameId: string | undefined; data: Command }
  | { type: 'communication'; gameId: string | undefined; data: NetworkCommunicationDraft }
  | { type: 'clientReady'; gameId: string | undefined }
  | { type: 'snapshotResync'; gameId: string | undefined }
  // Client reports its own IP / location / timezone to the host.
  // The host updates the local LobbyPlayer record and re-broadcasts
  // (see `playerInfoUpdate` below) so every connected client sees
  // the same player list with IP + location columns populated.
  | {
      type: 'playerInfo';
      gameId: string | undefined;
      ipAddress: string | undefined;
      location: string | undefined;
      timezone: string | undefined;
      localTime: string | undefined;
      /** Optional rename — set when the local user edits their own
       *  lobby player slot. Host re-broadcasts via `playerInfoUpdate`. */
      name: string | undefined;
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
      gameId: string | undefined;
      playerId: PlayerId;
      playerInfo: LobbyPlayerInfoPayload | undefined;
      players: LobbyPlayer[] | undefined;
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
  /** Signed altitude of the central ripple (CENTER bar). */
  centerMagnitude: number;
  /** Signed altitude of the team-separator ridges (DIVIDERS bar). */
  dividersMagnitude: number;
  terrainMapShape: TerrainMapShape;
  /** Plateau lattice step (world units). 0 = NONE (no terracing). */
  terrainDTerrain: number | undefined;
  /** Metal-extractor pad altitude step (world units). */
  metalDepositStep: number | undefined;
  /** Fine-triangle subdivisions per land cell. 0 = off (one triangle
   *  per cell); higher values refine the mesh. */
  terrainDetail: number | undefined;
  mapWidthLandCells: number;
  mapLengthLandCells: number;
  converterTax: number | undefined;
};

// Server → Client
export type NetworkServerSnapshotMessage =
  | {
      type: 'state';
      gameId: string | undefined;
      data: Uint8Array | ArrayBuffer;
      isDelta?: boolean;
      compression?: {
        format: SnapshotCompressionFormat;
        rawBytes: number;
      } | null;
    }
  | { type: 'communicationEvent'; gameId: string | undefined; data: NetworkCommunicationEvent }
  | { type: 'playerAssignment'; playerId: PlayerId; gameId: string | undefined }
  | {
      type: 'gameStart';
      playerIds: PlayerId[];
      gameId: string | undefined;
      handoff: BattleHandoff | undefined;
      assignedPlayerId: PlayerId | undefined;
    }
  | { type: 'playerJoined'; gameId: string | undefined; playerId: PlayerId; playerName: string }
  | { type: 'playerLeft'; gameId: string | undefined; playerId: PlayerId }
  | { type: 'lobbySettings'; gameId: string | undefined; settings: LobbySettings }
  // Host fans a player's IP + location out to every connected
  // client (whoever just resolved their ipapi.co lookup, or a
  // back-fill on `playerJoined` for late-joiners). Carries
  // playerId so receivers can match it to their player list.
  | {
      type: 'playerInfoUpdate';
      gameId: string | undefined;
      playerId: PlayerId;
      ipAddress: string | undefined;
      location: string | undefined;
      timezone: string | undefined;
      localTime: string | undefined;
      /** Optional rename. Sent by the host whenever a player's
       *  username changes from their own lobby slot, or when the host
       *  receives a `playerInfo` rename. Receivers update the matching
       *  LobbyPlayer.name in place. */
      name: string | undefined;
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
    | 'shieldStart'
    | 'shieldStop'
    | 'shieldImpact'
    | 'ping'
    | 'attackAlert'
    | 'projectileExpire'
    | 'waterSplash';
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

/** Legacy explored-history shroud payload. The runtime no longer emits
 *  this field; fog presentation is now client-local live shade/clouds
 *  controlled from the PLAYER CLIENT DEBUG section. The type remains
 *  so older encoded snapshots can still be decoded without changing
 *  the envelope schema. */
export type NetworkServerSnapshotShroud = {
  gridW: number;
  gridH: number;
  cellSize: number;
  bitmap: Uint8Array;
};

/** Wire shape for an active scan pulse (FOW-14). Only the geometric
 *  info the client needs to clear live fog shade/clouds — the
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
  /** Barrel selected for visual/audio cadence within the source turret's cluster.
   *  Authoritative shots spawn from the turret mount center. */
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

export type NetworkServerSnapshotVelocityUpdate = {
  id: number;
  /** PROJECTILE_POSITION_WIRE_SCALE fixed-point position. */
  pos: Vec3;
  /** VELOCITY_WIRE_SCALE fixed-point velocity. */
  velocity: Vec3;
  clearHomingTarget: boolean | null;
};

/** Wire-format vertex of a beam/laser polyline. The full beam is
 *  `points = [start, ...reflections, end]`. Each vertex carries its
 *  own instantaneous 3D velocity in the world frame so the client can
 *  extrapolate every vertex independently between snapshots; the
 *  reflector vertices set `reflectorEntityId` to the redirecting reflector
 *  entity (shield panels and spheres both use this slot).
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
  /** Polyline vertices (≥ 2). Index 0 = start (turret mount center), last = end
   *  (range / hit / ground / terminal reflector), middles = reflections. Each carries its
   *  own position and velocity from the authoritative every-tick beam trace. */
  points: NetworkServerSnapshotBeamPoint[];
  obstructionT: number | null;
  /** False when the authoritative path has no physical impact endpoint,
   *  so clients should not render an endpoint damage orb. */
  endpointDamageable: boolean | null;
};

export type NetworkServerSnapshotGridCell = {
  cell: Vec3;
  players: number[];
};

export type NetworkServerSnapshotMeta = {
  ticks: {
    avg: number;
    low: number;
    /** HOST SERVER TARGET TPS — the host runs at this rate without
     *  any adaptive slowdown. */
    rate: TickRate;
  };
  snaps: { rate: SnapshotRate; keyframes: KeyframeRatio };
  server: { time: string; ip: string };
  grid: boolean;
  units: {
    allowed: string[] | undefined;
    max: number | undefined;
    count: number | undefined;
  };
  turretShieldPanelsEnabled: boolean | undefined;
  turretShieldSpheresEnabled: boolean | undefined;
  shieldsObstructSight: boolean | undefined;
  shieldReflectionMode: ShieldReflectionMode | undefined;
  fogOfWarEnabled: boolean | undefined;
  /** Tax (fraction in [0, 1)) applied to each resource converter's
   *  per-tick output. Authoritative on the host; mirrored to clients
   *  so the DEMO BATTLE bar can show the active value. */
  converterTax: number | undefined;
  /** Host CPU load as a percent of the per-tick budget (1000/tickRate ms).
   *  `avg` = EMA-smoothed steady-state load; `hi` = EMA spike, climbs fast
   *  on spikes and decays slowly. Both can exceed 100 when the server is
   *  falling behind (tick work > tick budget). */
  cpu: { avg: number; hi: number } | undefined;
  wind: {
    x: number;
    y: number;
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
  velocityUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
  /** Authoritative live beam/laser paths. Sent every snapshot so
   *  clients draw reflected segments directly instead of re-tracing
   *  reflector/unit/building intersections in the render frame. */
  beamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
};

export type NetworkServerSnapshotGameState = {
  phase: GamePhase;
  winnerId: PlayerId | undefined;
};

export type NetworkServerSnapshotGrid = {
  cells: NetworkServerSnapshotGridCell[];
  searchCells: NetworkServerSnapshotGridCell[];
  cellSize: number;
};

export type NetworkServerSnapshot = {
  tick: number;
  entities: NetworkServerSnapshotEntity[];
  minimapEntities: NetworkServerSnapshotMinimapEntity[] | undefined;
  economy: Record<PlayerId, NetworkServerSnapshotEconomy>;
  resourceMovements: NetworkServerSnapshotResourceMovement[] | undefined;
  sprayTargets: NetworkServerSnapshotSprayTarget[] | undefined;
  audioEvents: NetworkServerSnapshotSimEvent[] | undefined;
  /** Active temporary vision pulses (FOW-14 — scanner sweeps) owned
   *  by the recipient or one of their allies, with the tick they
   *  expire on. The client passes these into live fog renderers so
   *  the shade/clouds clear inside the sweep radius the same way they
   *  do around a unit's vision circle. Omitted when no pulses are live
   *  for the recipient's team. */
  scanPulses: NetworkServerSnapshotScanPulse[] | undefined;
  /** Legacy explored-history shroud slot. Runtime snapshots leave this
   *  undefined. */
  shroud: NetworkServerSnapshotShroud | undefined;
  projectiles: NetworkServerSnapshotProjectiles | undefined;
  gameState: NetworkServerSnapshotGameState | undefined;
  serverMeta: NetworkServerSnapshotMeta | undefined;
  grid: NetworkServerSnapshotGrid | undefined;
  terrain: TerrainTileMap | undefined;
  buildability: TerrainBuildabilityGrid | undefined;
  isDelta: boolean;
  /** True when the authoritative snapshot intentionally omits entities
   *  outside the recipient player's current vision. Clients must keep
   *  absent full-keyframe entities as last-seen state unless an explicit
   *  removal arrives. */
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
};

export type NetworkServerSnapshotSprayTarget = {
  source: { id: number; pos: Vec2; z: number | null; playerId: PlayerId };
  target: { id: number; pos: Vec2; z: number | null; dim: Vec2 | null; radius: number | null };
  type: 'build' | 'heal';
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
  /** True for path-expansion intermediates (cells the planner
   *  inserted along the route). Used by the client renderer to hide
   *  these in SIMPLE waypoint mode. Omitted when false to save bytes
   *  — the renderer treats `undefined` as `false`. */
  pathExp: boolean | null;
  targetId: number | null;
  buildingBlueprintId: string | null;
  grid: Vec2 | null;
  buildingId: number | null;
  waitGather?: boolean | null;
  waitGroupId?: number | null;
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

// Bitmask for per-field delta updates within an entity.
// When absent/null (keyframe or new entity), all fields are present.
// MessagePack decodes own `undefined` properties as null, so network
// clients must accept both absent and null as "full record".
// When set (delta update), only flagged field groups are populated.
export const ENTITY_CHANGED_POS       = wireEnums.entityChanged.pos;
export const ENTITY_CHANGED_ROT       = wireEnums.entityChanged.rot;
export const ENTITY_CHANGED_VEL       = wireEnums.entityChanged.vel;
export const ENTITY_CHANGED_HP        = wireEnums.entityChanged.hp;
export const ENTITY_CHANGED_ACTIONS   = wireEnums.entityChanged.actions;
export const ENTITY_CHANGED_TURRETS   = wireEnums.entityChanged.turrets;
export const ENTITY_CHANGED_BUILDING  = wireEnums.entityChanged.building;
export const ENTITY_CHANGED_FACTORY   = wireEnums.entityChanged.factory;
/** The unit's smoothed surface normal moved past wire precision while
 *  the unit didn't (e.g. EMA still settling after the unit stopped, or
 *  a unit-ground-normal mode change kicked off fresh drift). Without this bit the
 *  normal could only ride POS-bit deltas, so stationary units would
 *  hold a stale normal until they moved or until the next keyframe. */
export const ENTITY_CHANGED_NORMAL    = wireEnums.entityChanged.normal;
// Bits 1 << 9, 1 << 10, and 1 << 11 were previously assigned to
// retired wire channels (visual suspension, acceleration-on-the-wire,
// and a vertical-launch actuator, respectively). The bits are
// intentionally left empty so COMBAT_MODE keeps its existing position
// rather than renumbering downstream consumers.
/** Player-controlled combat mode such as fire/hold-fire changed. */
export const ENTITY_CHANGED_COMBAT_MODE = wireEnums.entityChanged.combatMode;

export type NetworkServerSnapshotEntity = {
  id: number;
  type: EntityType;
  /** 3D position (x,y = plane, z = altitude), encoded as
   *  ENTITY_POSITION_WIRE_SCALE fixed-point integers. The 2D client
   *  reads only x/y; the 3D client reads all three. Present on full
   *  records and on deltas whose changedFields include ENTITY_CHANGED_POS. */
  pos: Vec3 | null;
  /** ROTATION_WIRE_SCALE fixed-point yaw. Present on full records and
   *  on deltas whose changedFields include ENTITY_CHANGED_ROT. */
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
    radius: { visual: number | null; hitbox: number | null; collision: number | null } | null;
    bodyCenterHeight: number | null;
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
    /** Full 3-DOF orientation triad for entities that need roll or
     *  arbitrary orientation (hover drones banking into turns, future
     *  free-flying projectiles with spin). Omitted entirely for
     *  ground units, which continue to ship `rotation` (yaw scalar)
     *  on the parent NetworkServerSnapshotEntity. The client reads
     *  this when present and falls back to the yaw scalar otherwise. */
    orientation: { x: number; y: number; z: number; w: number } | null;
    /** Angular velocity 3-vector in world frame (rad/s). Paired with
     *  `orientation`; PREDICT VEL clients integrate omega forward each
     *  frame between snapshots. Angular acceleration is intentionally
     *  not shipped (see design philosophy: client extrapolates from
     *  velocity, never re-derives server-side forces). */
    angularVelocity3: Vec3 | null;
    /** Legacy two-state fire permission mirror. New code reads
     *  fireState first and falls back to this bit if absent. */
    fireEnabled: boolean | null;
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
    /** Legacy two-state mirror kept for older decoders. New code reads
     *  moveState first and falls back to this bit if absent. */
    holdPosition?: boolean | null;
    /** Private owner command intent for cloak. Present on full private
     *  records when enabled and on deltas that explicitly toggle it. */
    wantCloak?: boolean | null;
    /** Public active cloak state. Present when active and on deltas that
     *  explicitly clear it; filtered snapshots hide foreign cloaked units
     *  unless detector coverage reveals them. */
    cloaked?: boolean | null;
    isCommander: boolean | null;
    buildTargetId: number | null;
    buildTargetIdPresent: boolean;
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
    factory: {
      /** Selected repeat-build unit blueprint wire code, or null for off. */
      selectedUnitBlueprintCode: number | null;
      /** Average fill of the factory's currentShellId, or 0 if
       *  the factory hasn't spawned a shell yet. The client re-derives
       *  construction-progress bars from the shell entity itself; this field is
       *  kept as a convenience for the production progress UI. */
      progress: number;
      producing: boolean;
      /** False means the selected unit is a one-shot queue item; omitted/true
       *  means the selected unit repeats after each completed shell. */
      repeat?: boolean;
      /** Finite production queue after the selected/current item. */
      queue?: number[] | null;
      /** Per-resource transfer rate this tick (0..1 fraction of the
       *  factory's max rate cap). Drives the resource-ball flow at the
       *  factory's pylons. */
      energyRate: number;
      metalRate: number;
      /** Friendly entity this factory will assign produced units to guard. */
      guardTargetId: number | null;
      /** Static rally point. `posZ` carries the click-altitude of the
       *  player-issued rally; null falls back to terrain sample. */
      rally: { pos: Vec2; posZ: number | null; type: string };
      /** Full default-route the factory stamps onto produced units
       *  (e.g. demo fabricators: a `fight` leg then a `patrol` loop).
       *  `rally` is `route[0]`. Null when the factory has no multi-leg
       *  route (player-set single rally) — clients then draw `rally`
       *  alone. Used purely for the rally-line VISUALIZATION so players
       *  can see the patrol legs produced units will follow. */
      route: { pos: Vec2; posZ: number | null; type: string }[] | null;
    } | null;
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

export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
  /** Public IP (v4) — populated lazily after the player's
   *  client-side IP lookup resolves and the host has fanned the
   *  value out to every connected client via
   *  `playerInfoUpdate`. May be undefined briefly between the
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
  protocol: typeof BATTLE_HANDOFF_PROTOCOL;
  gameId: string;
  roomCode: string;
  hostPlayerId: PlayerId;
  playerIds: PlayerId[];
  players: LobbyPlayer[];
  settings: LobbySettings | undefined;
};

export type NetworkRole = 'host' | 'client';
