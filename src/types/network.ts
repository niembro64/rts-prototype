// Network types extracted from game/network/NetworkTypes.ts

import type { PlayerId, TurretRanges } from './sim';
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
  enemyDamageDealt: number;
  enemyDamageReceived: number;
  enemyKills: number;
  friendlyDamageDealt: number;
  friendlyKills: number;
  unitsProduced: number;
  unitsLost: number;
  totalCostSpent: number;
};

export type NetworkCombatStats = {
  players: Record<number, Record<string, NetworkUnitTypeStats>>;
  global: Record<string, NetworkUnitTypeStats>;
};

export type NetworkServerMeta = {
  tpsAvg: number;
  tpsWorst: number;
  tickRate: number;
  snapshotRate: number | 'none';
  keyframeRatio: number | 'ALL' | 'NONE';
  sendGridInfo: boolean;
  serverTime: string;
  ipAddress: string;
  allowedUnitTypes?: string[];
  maxTotalUnits?: number;
  projVelInherit?: boolean;
  ffAccelUnits?: boolean;
  ffAccelShots?: boolean;
};

export type NetworkGameState = {
  tick: number;
  entities: NetworkEntity[];
  economy: Record<PlayerId, NetworkEconomy>;
  sprayTargets?: NetworkSprayTarget[];
  audioEvents?: NetworkSimEvent[];
  projectileSpawns?: NetworkProjectileSpawn[];
  projectileDespawns?: NetworkProjectileDespawn[];
  projectileVelocityUpdates?: NetworkProjectileVelocityUpdate[];
  gameOver?: { winnerId: PlayerId };
  combatStats?: NetworkCombatStats;
  serverMeta?: NetworkServerMeta;
  gridCells?: NetworkGridCell[];
  gridSearchCells?: NetworkGridCell[];
  gridCellSize?: number;
  isDelta?: boolean;
  removedEntityIds?: number[];
};

export type NetworkSprayTarget = {
  sourceId: number;
  targetId: number;
  type: 'build' | 'heal';
  source: Vec2;
  target: Vec2;
  targetWidth?: number;
  targetHeight?: number;
  targetRadius?: number;
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
  configId: string;
  targetId?: number;
  ranges: TurretRanges;
  turretRotation: number;
  turretAngularVelocity: number;
  turretTurnAccel: number;
  turretDrag: number;
  offset: Vec2;
  isTracking: boolean;
  isEngaged: boolean;
  currentForceFieldRange?: number;
};

export type NetworkEntity = {
  id: number;
  type: 'unit' | 'building' | 'projectile';
  pos: Vec2;
  rotation: number;
  playerId?: PlayerId;
  unitType?: string;
  hp?: number;
  maxHp?: number;
  drawScale?: number;
  radiusColliderUnitShot?: number;
  radiusColliderUnitUnit?: number;
  moveSpeed?: number;
  mass?: number;
  velocity?: Vec2;
  turretRotation?: number;
  isCommander?: boolean;
  actions?: NetworkAction[];
  weaponId?: string;
  weapons?: NetworkWeapon[];
  buildTargetId?: number;
  width?: number;
  height?: number;
  buildProgress?: number;
  isComplete?: boolean;
  buildingType?: string;
  projectileType?: string;
  beam?: { start: Vec2; end: Vec2 };
  sourceEntityId?: number;
  weaponIndex?: number;
  buildQueue?: string[];
  factoryProgress?: number;
  isProducing?: boolean;
  rally?: Vec2;
  factoryWaypoints?: { pos: Vec2; type: string }[];
};

export type NetworkEconomy = {
  stockpile: number;
  maxStockpile: number;
  baseIncome: number;
  production: number;
  expenditure: number;
};

export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
};

export type NetworkRole = 'host' | 'client' | 'offline';
