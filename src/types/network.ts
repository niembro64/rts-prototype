// Network types extracted from game/network/NetworkTypes.ts

import type { EntityType, PlayerId, TurretRanges, TurretState } from './sim';
import type { Command } from './commands';
import type { TurretAudioId, ImpactContext, SimDeathContext } from './combat';
import type { Vec2 } from './vec2';

// Client → Server
export type NetworkPlayerActionMessage = { type: 'command'; data: Command };

// Server → Client
export type NetworkServerSnapshotMessage =
  | { type: 'state'; data: NetworkServerSnapshot | string }
  | { type: 'playerAssignment'; playerId: PlayerId }
  | { type: 'gameStart'; playerIds: PlayerId[] }
  | { type: 'playerJoined'; playerId: PlayerId; playerName: string }
  | { type: 'playerLeft'; playerId: PlayerId };

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
  pos: Vec2;
  entityId?: number;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
};

export type NetworkServerSnapshotProjectileSpawn = {
  id: number;
  pos: Vec2;
  rotation: number;
  velocity: Vec2;
  projectileType: string;
  turretId: string;
  playerId: number;
  sourceEntityId: number;
  turretIndex: number;
  isDGun?: boolean;
  beam?: { start: Vec2; end: Vec2 };
  targetEntityId?: number;
  homingTurnRate?: number;
};

export type NetworkServerSnapshotProjectileDespawn = {
  id: number;
};

export type NetworkServerSnapshotVelocityUpdate = {
  id: number;
  pos: Vec2;
  velocity: Vec2;
};

export type NetworkServerSnapshotGridCell = {
  cell: Vec2;
  players: number[];
};

export type NetworkServerSnapshotUnitTypeStats = {
  damage: { dealt: { enemy: number; friendly: number }; received: number };
  kills: { enemy: number; friendly: number };
  units: { produced: number; lost: number; energyCost: number; manaCost: number };
};

export type NetworkServerSnapshotCombatStats = {
  players: Record<number, Record<string, NetworkServerSnapshotUnitTypeStats>>;
  global: Record<string, NetworkServerSnapshotUnitTypeStats>;
};

export type NetworkServerSnapshotMeta = {
  ticks: { avg: number; low: number; rate: number };
  snaps: { rate: number | 'none'; keyframes: number | 'ALL' | 'NONE' };
  server: { time: string; ip: string };
  grid: boolean;
  units: { allowed?: string[]; max?: number; count?: number };
  projVelInherit?: boolean;
  ffAccel: { units?: boolean; shots?: boolean; dmgUnits?: boolean };
  /** Host CPU load as a percent of the per-tick budget (1000/tickRate ms).
   *  `avg` = EMA-smoothed steady-state load; `hi` = EMA spike, climbs fast
   *  on jumps and decays slowly. Both can exceed 100 when the server is
   *  falling behind (tick work > tick budget). */
  cpu?: { avg: number; hi: number };
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
  };
  gameState?: { phase: GamePhase; winnerId?: PlayerId };
  combatStats?: NetworkServerSnapshotCombatStats;
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
  source: { id: number; pos: Vec2; playerId: PlayerId };
  target: { id: number; pos: Vec2; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
};

export type NetworkServerSnapshotAction = {
  type: string;
  pos?: Vec2;
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
      rot: number;
      vel: number;
      acc: number;
      drag: number;
    };
    pos: {
      offset: Vec2;
    };
  };
  targetId?: number;
  state: TurretState;
  currentForceFieldRange?: number;
};

// Bitmask for per-field delta updates within an entity.
// When undefined (keyframe or new entity), all fields are present.
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
  pos: Vec2;
  rotation: number;
  posEnd?: Vec2;
  playerId: PlayerId;
  changedFields?: number;
  unit?: {
    unitType: string;
    hp: { curr: number; max: number };
    collider: { scale: number; shot: number; push: number };
    moveSpeed: number;
    mass: number;
    velocity: Vec2;
    turretRotation: number;
    isCommander?: boolean;
    buildTargetId?: number;
    actions?: NetworkServerSnapshotAction[];
    turrets?: NetworkServerSnapshotTurret[];
  };
  building?: {
    type: string;
    dim: Vec2;
    hp: { curr: number; max: number };
    build: { progress: number; complete: boolean };
    factory?: {
      queue: string[];
      progress: number;
      producing: boolean;
      waypoints: { pos: Vec2; type: string }[];
    };
  };
  shot?: {
    type: string;
    source: number;
    turretId?: string;
    turretIndex?: number;
    velocity?: Vec2;
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
};

export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
};

export type NetworkRole = 'host' | 'client';
