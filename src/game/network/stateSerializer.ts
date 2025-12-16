import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy, NetworkSprayTarget, NetworkAudioEvent } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { AudioEvent } from '../sim/combat';

// Serialize WorldState to network format
export function serializeGameState(
  world: WorldState,
  gameOverWinnerId?: PlayerId,
  sprayTargets?: SprayTarget[],
  audioEvents?: AudioEvent[]
): NetworkGameState {
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

  // Serialize spray targets
  const netSprayTargets: NetworkSprayTarget[] | undefined = sprayTargets?.map(st => ({
    sourceId: st.sourceId,
    targetId: st.targetId,
    type: st.type,
    sourceX: st.sourceX,
    sourceY: st.sourceY,
    targetX: st.targetX,
    targetY: st.targetY,
    targetWidth: st.targetWidth,
    targetHeight: st.targetHeight,
    targetRadius: st.targetRadius,
    intensity: st.intensity,
  }));

  // Serialize audio events
  const netAudioEvents: NetworkAudioEvent[] | undefined = audioEvents?.map(ae => ({
    type: ae.type,
    weaponId: ae.weaponId,
    x: ae.x,
    y: ae.y,
    entityId: ae.entityId,
  }));

  return {
    tick: world.getTick(),
    entities,
    economy,
    sprayTargets: netSprayTargets,
    audioEvents: netAudioEvents,
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
    netEntity.collisionRadius = entity.unit.collisionRadius;
    netEntity.moveSpeed = entity.unit.moveSpeed;
    netEntity.velocityX = entity.unit.velocityX ?? 0;
    netEntity.velocityY = entity.unit.velocityY ?? 0;
    // Turret rotation for network display - loop through all weapons
    let turretRot = entity.transform.rotation;
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      turretRot = weapon.turretRotation;
    }
    netEntity.turretRotation = turretRot;
    netEntity.isCommander = entity.commander !== undefined;

    // Serialize action queue
    if (entity.unit.actions && entity.unit.actions.length > 0) {
      netEntity.actions = entity.unit.actions.map(action => ({
        type: action.type,
        x: action.x,
        y: action.y,
        targetId: action.targetId,
        // Build action fields
        buildingType: action.buildingType,
        gridX: action.gridX,
        gridY: action.gridY,
        buildingId: action.buildingId,
      }));
    }

    // Serialize all weapons - each weapon operates independently
    if (entity.weapons && entity.weapons.length > 0) {
      netEntity.weapons = entity.weapons.map(w => ({
        configId: w.config.id,
        targetId: w.targetEntityId ?? undefined,
        seeRange: w.seeRange,
        fireRange: w.fireRange,
        turretRotation: w.turretRotation,
        turretTurnRate: w.turretTurnRate,
        offsetX: w.offsetX,
        offsetY: w.offsetY,
        isFiring: w.isFiring,
        currentSliceAngle: w.currentSliceAngle,
      }));
    }

    // Serialize builder state (commander)
    if (entity.builder) {
      netEntity.buildTargetId = entity.builder.currentBuildTarget ?? undefined;
    }
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
      netEntity.rallyX = entity.factory.rallyX;
      netEntity.rallyY = entity.factory.rallyY;
      netEntity.factoryWaypoints = entity.factory.waypoints.map(wp => ({
        x: wp.x,
        y: wp.y,
        type: wp.type,
      }));
    }
  }

  if (entity.type === 'projectile' && entity.projectile) {
    netEntity.velocityX = entity.projectile.velocityX;
    netEntity.velocityY = entity.projectile.velocityY;
    netEntity.projectileType = entity.projectile.projectileType;
    netEntity.weaponId = entity.projectile.config.id;
    // Beam coordinates for laser/railgun rendering
    if (entity.projectile.projectileType === 'beam') {
      netEntity.beamStartX = entity.projectile.startX;
      netEntity.beamStartY = entity.projectile.startY;
      netEntity.beamEndX = entity.projectile.endX;
      netEntity.beamEndY = entity.projectile.endY;
    }
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
      collisionRadius: netEntity.collisionRadius,
      moveSpeed: netEntity.moveSpeed,
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
  collisionRadius?: number;
  moveSpeed?: number;
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
