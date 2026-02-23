// Network types extracted from game/network/NetworkTypes.ts

import type { PlayerId, TurretRanges } from './sim';
import type { Command } from './commands';
import type { WeaponAudioId } from './combat';

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
  x: number;
  y: number;
  entityId?: number;
  deathContext?: {
    unitVelX: number;
    unitVelY: number;
    hitDirX: number;
    hitDirY: number;
    projectileVelX: number;
    projectileVelY: number;
    attackMagnitude: number;
    radius: number;
    color: number;
    unitType?: string;
    rotation?: number;
  };
  impactContext?: {
    collisionRadius: number;
    primaryRadius: number;
    secondaryRadius: number;
    projectileVelX: number;
    projectileVelY: number;
    projectileX: number;
    projectileY: number;
    entityVelX: number;
    entityVelY: number;
    entityCollisionRadius: number;
    penetrationDirX: number;
    penetrationDirY: number;
  };
};

export type NetworkProjectileSpawn = {
  id: number;
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  projectileType: string;
  weaponId: string;
  playerId: number;
  sourceEntityId: number;
  weaponIndex: number;
  isDGun?: boolean;
  beamStartX?: number;
  beamStartY?: number;
  beamEndX?: number;
  beamEndY?: number;
  targetEntityId?: number;
  homingTurnRate?: number;
};

export type NetworkProjectileDespawn = {
  id: number;
};

export type NetworkProjectileVelocityUpdate = {
  id: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
};

export type NetworkGridCell = {
  cx: number;
  cy: number;
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
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  targetWidth?: number;
  targetHeight?: number;
  targetRadius?: number;
  intensity: number;
};

export type NetworkAction = {
  type: string;
  x?: number;
  y?: number;
  targetId?: number;
  buildingType?: string;
  gridX?: number;
  gridY?: number;
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
  offsetX: number;
  offsetY: number;
  isTracking: boolean;
  isEngaged: boolean;
  currentForceFieldRange?: number;
};

export type NetworkEntity = {
  id: number;
  type: 'unit' | 'building' | 'projectile';
  x: number;
  y: number;
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
  velocityX?: number;
  velocityY?: number;
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
  beamStartX?: number;
  beamStartY?: number;
  beamEndX?: number;
  beamEndY?: number;
  sourceEntityId?: number;
  weaponIndex?: number;
  buildQueue?: string[];
  factoryProgress?: number;
  isProducing?: boolean;
  rallyX?: number;
  rallyY?: number;
  factoryWaypoints?: { x: number; y: number; type: string }[];
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
