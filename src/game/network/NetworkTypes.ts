// Network type definitions

import type { PlayerId } from '../sim/types';
import type { Command } from '../sim/commands';
import type { WeaponAudioId } from '../audio/AudioManager';

// Network message types
export type NetworkMessage =
  | { type: 'state'; data: NetworkGameState | string }
  | { type: 'command'; data: Command }
  | { type: 'playerAssignment'; playerId: PlayerId }
  | { type: 'gameStart'; playerIds: PlayerId[] }
  | { type: 'playerJoined'; playerId: PlayerId; playerName: string }
  | { type: 'playerLeft'; playerId: PlayerId };

// Audio event for network sync
export interface NetworkAudioEvent {
  type: 'fire' | 'hit' | 'death' | 'laserStart' | 'laserStop' | 'projectileExpire';
  weaponId: WeaponAudioId;
  x: number;
  y: number;
  entityId?: number;

  // Death context (only for 'death' events) - for directional explosion effects
  deathContext?: {
    // Unit's velocity when it died (from physics body)
    unitVelX: number;
    unitVelY: number;
    // Hit direction: from hit point through unit center (normalized)
    hitDirX: number;
    hitDirY: number;
    // Projectile/beam velocity (actual velocity for projectiles, direction*magnitude for beams)
    projectileVelX: number;
    projectileVelY: number;
    // Magnitude of the attack damage
    attackMagnitude: number;
    radius: number;       // Unit's collision radius for explosion size
    color: number;        // Player color for explosion
  };
}

// Projectile spawn event - sent once when projectile is created
export interface NetworkProjectileSpawn {
  id: number;
  x: number; y: number; rotation: number;
  velocityX: number; velocityY: number;
  projectileType: string;
  weaponId: string;
  playerId: number;
  sourceEntityId: number;
  weaponIndex: number;
  isDGun?: boolean;
  beamStartX?: number; beamStartY?: number;
  beamEndX?: number; beamEndY?: number;
}

// Projectile despawn event - sent once when projectile is removed
export interface NetworkProjectileDespawn {
  id: number;
}

// Projectile velocity update - sent when a projectile's velocity changes (e.g. force field pull)
// Includes server position so clients can correct dead-reckoned drift
export interface NetworkProjectileVelocityUpdate {
  id: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

// Serialized game state sent over network
export interface NetworkGameState {
  tick: number;
  entities: NetworkEntity[];
  economy: Record<PlayerId, NetworkEconomy>;
  sprayTargets?: NetworkSprayTarget[];
  audioEvents?: NetworkAudioEvent[];
  projectileSpawns?: NetworkProjectileSpawn[];
  projectileDespawns?: NetworkProjectileDespawn[];
  projectileVelocityUpdates?: NetworkProjectileVelocityUpdate[];
  gameOver?: { winnerId: PlayerId };
}

// Spray target for commander building effect
export interface NetworkSprayTarget {
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
}

// Unit action for network sync
export interface NetworkAction {
  type: string;
  x?: number;
  y?: number;
  targetId?: number;
  // Build action fields
  buildingType?: string;
  gridX?: number;
  gridY?: number;
  buildingId?: number;  // Entity ID of the building being constructed
}

// Weapon data for network sync (supports multi-weapon units)
// Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
export interface NetworkWeapon {
  configId: string;
  targetId?: number;
  seeRange: number;
  fireRange: number;
  releaseRange: number;    // Lock release boundary (hysteresis)
  lockRange: number;       // Lock acquisition range (innermost commitment zone)
  fightstopRange: number;  // Unit stops in fight mode when enemy within this range
  turretRotation: number;
  turretAngularVelocity: number;  // Current angular velocity (rad/sec)
  turretTurnAccel: number;        // Turret acceleration (rad/sec²)
  turretDrag: number;             // Turret drag coefficient (0-1)
  offsetX: number;
  offsetY: number;
  isFiring: boolean;       // Whether weapon is actively firing at target in range
  inFightstopRange: boolean; // Whether target is within fightstop range
  currentForceFieldRange?: number;  // Dynamic outer radius for force field weapons
}

export interface NetworkEntity {
  id: number;
  type: 'unit' | 'building' | 'projectile';
  x: number;
  y: number;
  rotation: number;
  playerId?: PlayerId;

  // Unit fields
  unitType?: string;         // Unit type identifier (jackal, lynx, daddy, etc.)
  hp?: number;
  maxHp?: number;
  collisionRadius?: number;  // Hitbox size for physics
  moveSpeed?: number;
  mass?: number;             // Physics mass for force-based movement
  velocityX?: number;
  velocityY?: number;
  turretRotation?: number;
  isCommander?: boolean;

  // Unit action queue
  actions?: NetworkAction[];

  // Weapon ID - used for projectile type identification
  weaponId?: string;
  // All unit weapons - each weapon is independent
  weapons?: NetworkWeapon[];

  // Builder fields (commander)
  buildTargetId?: number;

  // Building fields
  width?: number;
  height?: number;
  buildProgress?: number;
  isComplete?: boolean;
  buildingType?: string;

  // Projectile fields
  projectileType?: string;
  beamStartX?: number;
  beamStartY?: number;
  beamEndX?: number;
  beamEndY?: number;
  sourceEntityId?: number;  // Which unit fired this (for beam reconstruction)
  weaponIndex?: number;     // Which weapon on the source unit

  // Factory fields
  buildQueue?: string[];
  factoryProgress?: number;
  isProducing?: boolean;
  rallyX?: number;
  rallyY?: number;
  factoryWaypoints?: { x: number; y: number; type: string }[];
}

export interface NetworkEconomy {
  stockpile: number;
  maxStockpile: number;
  baseIncome: number;
  production: number;
  expenditure: number;
}

// Player info in lobby
export interface LobbyPlayer {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
}

export type NetworkRole = 'host' | 'client' | 'offline';
