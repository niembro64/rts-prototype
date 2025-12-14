import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy } from './NetworkManager';

// Serialize WorldState to network format
export function serializeGameState(world: WorldState, gameOverWinnerId?: PlayerId): NetworkGameState {
  const entities: NetworkEntity[] = [];

  // Serialize all entities
  for (const entity of world.getAllEntities()) {
    const netEntity = serializeEntity(entity);
    if (netEntity) {
      entities.push(netEntity);
    }
  }

  // Serialize economy for all players
  const economy: Record<PlayerId, NetworkEconomy> = {};
  for (let playerId = 1; playerId <= 6; playerId++) {
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (eco) {
      economy[playerId as PlayerId] = {
        stockpile: eco.stockpile,
        maxStockpile: eco.maxStockpile,
        baseIncome: eco.baseIncome,
        production: eco.production,
        expenditure: eco.expenditure,
      };
    }
  }

  return {
    tick: world.getTick(),
    entities,
    economy,
    gameOver: gameOverWinnerId ? { winnerId: gameOverWinnerId } : undefined,
  };
}

// Serialize a single entity
function serializeEntity(entity: Entity): NetworkEntity | null {
  const netEntity: NetworkEntity = {
    id: entity.id,
    type: entity.type,
    x: entity.transform.x,
    y: entity.transform.y,
    rotation: entity.transform.rotation,
    playerId: entity.ownership?.playerId,
  };

  if (entity.type === 'unit' && entity.unit) {
    netEntity.hp = entity.unit.hp;
    netEntity.maxHp = entity.unit.maxHp;
    netEntity.radius = entity.unit.radius;
    netEntity.velocityX = entity.unit.velocityX ?? 0;
    netEntity.velocityY = entity.unit.velocityY ?? 0;
    netEntity.turretRotation = entity.unit.turretRotation ?? entity.transform.rotation;
    netEntity.isCommander = entity.commander !== undefined;
  }

  if (entity.type === 'building' && entity.building) {
    netEntity.width = entity.building.width;
    netEntity.height = entity.building.height;
    netEntity.hp = entity.building.hp;
    netEntity.maxHp = entity.building.maxHp;
    netEntity.buildingType = entity.buildingType;

    if (entity.buildable) {
      netEntity.buildProgress = entity.buildable.buildProgress;
      netEntity.isComplete = entity.buildable.isComplete;
    }

    if (entity.factory) {
      netEntity.buildQueue = [...entity.factory.buildQueue];
      netEntity.factoryProgress = entity.factory.currentBuildProgress;
      netEntity.isProducing = entity.factory.isProducing;
    }
  }

  if (entity.type === 'projectile' && entity.projectile) {
    netEntity.velocityX = entity.projectile.velocityX;
    netEntity.velocityY = entity.projectile.velocityY;
    netEntity.projectileType = entity.projectile.projectileType;
    netEntity.weaponId = entity.projectile.config.id;
  }

  return netEntity;
}

// Apply network state to a "display-only" world state
// This is used by remote clients who don't run the simulation
export function applyNetworkState(
  state: NetworkGameState,
  existingEntities: Map<number, DisplayEntity>
): Map<number, DisplayEntity> {
  const newEntities = new Map<number, DisplayEntity>();

  for (const netEntity of state.entities) {
    // Check if entity already exists (for interpolation)
    const existing = existingEntities.get(netEntity.id);

    const displayEntity: DisplayEntity = {
      id: netEntity.id,
      type: netEntity.type,
      x: netEntity.x,
      y: netEntity.y,
      rotation: netEntity.rotation,
      playerId: netEntity.playerId,

      // For interpolation
      prevX: existing?.x ?? netEntity.x,
      prevY: existing?.y ?? netEntity.y,
      prevRotation: existing?.rotation ?? netEntity.rotation,

      // Unit fields
      hp: netEntity.hp,
      maxHp: netEntity.maxHp,
      radius: netEntity.radius,
      velocityX: netEntity.velocityX,
      velocityY: netEntity.velocityY,
      turretRotation: netEntity.turretRotation,
      isCommander: netEntity.isCommander,

      // Building fields
      width: netEntity.width,
      height: netEntity.height,
      buildProgress: netEntity.buildProgress,
      isComplete: netEntity.isComplete,
      buildingType: netEntity.buildingType,

      // Projectile fields
      projectileType: netEntity.projectileType,
      weaponId: netEntity.weaponId,

      // Factory fields
      buildQueue: netEntity.buildQueue,
      factoryProgress: netEntity.factoryProgress,
      isProducing: netEntity.isProducing,
    };

    newEntities.set(netEntity.id, displayEntity);
  }

  return newEntities;
}

// Display entity for remote clients (no simulation, just rendering)
export interface DisplayEntity {
  id: number;
  type: 'unit' | 'building' | 'projectile';
  x: number;
  y: number;
  rotation: number;
  playerId?: PlayerId;

  // For interpolation
  prevX: number;
  prevY: number;
  prevRotation: number;

  // Unit fields
  hp?: number;
  maxHp?: number;
  radius?: number;
  velocityX?: number;
  velocityY?: number;
  turretRotation?: number;
  isCommander?: boolean;

  // Building fields
  width?: number;
  height?: number;
  buildProgress?: number;
  isComplete?: boolean;
  buildingType?: string;

  // Projectile fields
  projectileType?: string;
  weaponId?: string;

  // Factory fields
  buildQueue?: string[];
  factoryProgress?: number;
  isProducing?: boolean;

  // Local state (client-side only)
  isSelected?: boolean;
}

// Economy state for display
export interface DisplayEconomy {
  stockpile: number;
  maxStockpile: number;
  baseIncome: number;
  production: number;
  expenditure: number;
}
