// ProjectileEntity - Fired weapons (bullets, beams, grenades)
// Does NOT extend GameEntity since projectiles don't have HP

import type {
  Transform,
  Ownership,
  EntityId,
  PlayerId,
  WeaponConfig,
  ProjectileType,
  DGunProjectile,
} from '../types';

export class ProjectileEntity {
  public readonly id: EntityId;
  public transform: Transform;
  public ownership?: Ownership;

  // Owner/source information
  public ownerId: PlayerId;
  public sourceEntityId: EntityId;
  public config: WeaponConfig;

  // Projectile type (instant, traveling, beam)
  public projectileType: ProjectileType;

  // Movement (for traveling projectiles)
  public velocityX: number;
  public velocityY: number;

  // Previous position (for swept collision detection - prevents tunneling)
  public prevX?: number;
  public prevY?: number;

  // Lifespan
  public timeAlive: number = 0;
  public maxLifespan: number;

  // Beam specific
  public startX?: number;
  public startY?: number;
  public endX?: number;
  public endY?: number;
  public targetEntityId?: EntityId;

  // Hit tracking
  public hitEntities: Set<EntityId> = new Set();
  public maxHits: number;

  // AoE tracking
  public hasExploded: boolean = false;

  // Source-entity exit guard
  public hasLeftSource: boolean = false;

  // D-gun marker
  public dgunProjectile?: DGunProjectile;

  constructor(
    id: EntityId,
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: WeaponConfig,
    projectileType: ProjectileType,
    maxLifespan: number,
    maxHits: number = 1
  ) {
    this.id = id;
    this.transform = { x, y, rotation: Math.atan2(velocityY, velocityX) };
    this.ownership = { playerId: ownerId };
    this.ownerId = ownerId;
    this.sourceEntityId = sourceEntityId;
    this.config = config;
    this.projectileType = projectileType;
    this.velocityX = velocityX;
    this.velocityY = velocityY;
    this.maxLifespan = maxLifespan;
    this.maxHits = maxHits;
  }

  get entityType(): 'projectile' {
    return 'projectile';
  }

  // Compatibility layer - return a Projectile-like object for legacy code
  get projectile(): {
    ownerId: PlayerId;
    sourceEntityId: EntityId;
    config: WeaponConfig;
    projectileType: ProjectileType;
    velocityX: number;
    velocityY: number;
    prevX?: number;
    prevY?: number;
    timeAlive: number;
    maxLifespan: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    targetEntityId?: EntityId;
    hitEntities: Set<EntityId>;
    maxHits: number;
    hasExploded?: boolean;
    hasLeftSource?: boolean;
  } {
    return {
      ownerId: this.ownerId,
      sourceEntityId: this.sourceEntityId,
      config: this.config,
      projectileType: this.projectileType,
      velocityX: this.velocityX,
      velocityY: this.velocityY,
      prevX: this.prevX,
      prevY: this.prevY,
      timeAlive: this.timeAlive,
      maxLifespan: this.maxLifespan,
      startX: this.startX,
      startY: this.startY,
      endX: this.endX,
      endY: this.endY,
      targetEntityId: this.targetEntityId,
      hitEntities: this.hitEntities,
      maxHits: this.maxHits,
      hasExploded: this.hasExploded,
      hasLeftSource: this.hasLeftSource,
    };
  }
}
