// Network types extracted from game/network/NetworkTypes.ts

import type { EntityType, PlayerId, TurretRanges } from './sim';
import type { Command } from './commands';
import type { WeaponAudioId, ImpactContext, SimDeathContext } from './combat';
import type { Vec2 } from './vec2';

export type NetworkMessage =
  | { type: 'state'; data: NetworkGameState | string }
  | { type: 'command'; data: Command }
  | { type: 'playerAssignment'; playerId: PlayerId }
  | { type: 'gameStart'; playerIds: PlayerId[] }
  | { type: 'playerJoined'; playerId: PlayerId; playerName: string }
  | { type: 'playerLeft'; playerId: PlayerId };

export type NetworkSimEvent = {
  type:
    | 'fire'
    | 'hit'
    | 'death'
    | 'laserStart'
    | 'laserStop'
    | 'forceFieldStart'
    | 'forceFieldStop'
    | 'projectileExpire';
  weaponId: WeaponAudioId;
  pos: Vec2;
  entityId?: number;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
};

export type NetworkProjectileSpawn = {
  id: number;
  pos: Vec2;
  rotation: number;
  velocity: Vec2;
  projectileType: string;
  weaponId: string;
  playerId: number;
  sourceEntityId: number;
  weaponIndex: number;
  isDGun?: boolean;
  beam?: { start: Vec2; end: Vec2 };
  targetEntityId?: number;
  homingTurnRate?: number;
};

export type NetworkProjectileDespawn = {
  id: number;
};

export type NetworkProjectileVelocityUpdate = {
  id: number;
  pos: Vec2;
  velocity: Vec2;
};

export type NetworkGridCell = {
  cell: Vec2;
  players: number[];
};

export type NetworkUnitTypeStats = {
  damage: { dealt: { enemy: number; friendly: number }; received: number };
  kills: { enemy: number; friendly: number };
  units: { produced: number; lost: number; cost: number };
};

export type NetworkCombatStats = {
  players: Record<number, Record<string, NetworkUnitTypeStats>>;
  global: Record<string, NetworkUnitTypeStats>;
};

export type NetworkServerMeta = {
  ticks: { avg: number; low: number; rate: number };
  snaps: { rate: number | 'none'; keyframes: number | 'ALL' | 'NONE' };
  server: { time: string; ip: string };
  grid: boolean;
  units: { allowed?: string[]; max?: number };
  projVelInherit?: boolean;
  ffAccel: { units?: boolean; shots?: boolean };
};

export type GamePhase = 'init' | 'battle' | 'paused' | 'gameOver';

export type NetworkGameState = {
  tick: number;
  entities: NetworkEntity[];
  economy: Record<PlayerId, NetworkEconomy>;
  sprayTargets?: NetworkSprayTarget[];
  audioEvents?: NetworkSimEvent[];
  projectiles?: {
    spawns?: NetworkProjectileSpawn[];
    despawns?: NetworkProjectileDespawn[];
    velocityUpdates?: NetworkProjectileVelocityUpdate[];
  };
  gameState?: { phase: GamePhase; winnerId?: PlayerId };
  combatStats?: NetworkCombatStats;
  serverMeta?: NetworkServerMeta;
  grid?: {
    cells: NetworkGridCell[];
    searchCells: NetworkGridCell[];
    cellSize: number;
  };
  isDelta?: boolean;
  removedEntityIds?: number[];
};

export type NetworkSprayTarget = {
  source: { id: number; pos: Vec2 };
  target: { id: number; pos: Vec2; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
};

export type NetworkAction = {
  type: string;
  pos?: Vec2;
  targetId?: number;
  buildingType?: string;
  grid?: Vec2;
  buildingId?: number;
};

export type NetworkWeapon = {
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
  isTracking: boolean;
  isEngaged: boolean;
  currentForceFieldRange?: number;
};

export type NetworkEntity = {
  id: number;
  type: EntityType;
  pos: Vec2;
  rotation: number;
  posEnd?: Vec2;
  playerId?: PlayerId;
  unit?: {
    unitType: string;
    hp: number;
    maxHp: number;
    drawScale: number;
    collider: { unitShot: number; unitUnit: number };
    moveSpeed: number;
    mass: number;
    velocity: Vec2;
    turretRotation: number;
    isCommander?: boolean;
    buildTargetId?: number;
    actions?: NetworkAction[];
    weapons?: NetworkWeapon[];
  };
  building?: {
    type: string;
    dim: Vec2;
    hp: number;
    maxHp: number;
    build: { progress: number; complete: boolean };
    factory?: {
      queue: string[];
      progress: number;
      producing: boolean;
      rally: Vec2;
      waypoints?: { pos: Vec2; type: string }[];
    };
  };
  shot?: {
    type: string;
    source: number;
    weaponId?: string;
    weaponIndex?: number;
    velocity?: Vec2;
  };
};

export type NetworkEconomy = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
};

export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
};

export type NetworkRole = 'host' | 'client';
