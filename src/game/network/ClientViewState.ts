/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * This class provides the same abstraction for:
 * 1. Actual network clients receiving state from host
 * 2. Host's "client view" mode (seeing what clients see)
 *
 * It receives serialized NetworkGameState and:
 * - Maintains its own entity state (separate from simulation)
 * - Applies network state updates (snapping to received positions)
 * - Runs velocity-based prediction between updates
 * - Provides entities for rendering
 */

import type { Entity, PlayerId, EntityId, BuildingType } from '../sim/types';
import type { NetworkGameState, NetworkEntity } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import { getWeaponConfig } from '../sim/weapons';
import { economyManager } from '../sim/economy';

export class ClientViewState {
  // Entity storage (separate from simulation WorldState)
  private entities: Map<EntityId, Entity> = new Map();

  // Current spray targets for rendering
  private sprayTargets: SprayTarget[] = [];

  // Audio events from last state update
  private pendingAudioEvents: NetworkGameState['audioEvents'] = [];

  // Game over state
  private gameOverWinnerId: PlayerId | null = null;

  // Current tick from host
  private currentTick: number = 0;

  // Selection state (synced from main view)
  private selectedIds: Set<EntityId> = new Set();

  constructor() {}

  /**
   * Apply received network state - this is called at network tick rate
   * Same logic used by actual clients and host's client view
   */
  applyNetworkState(state: NetworkGameState): void {
    this.currentTick = state.tick;
    const existingIds = new Set<EntityId>();

    // Update or create entities
    for (const netEntity of state.entities) {
      existingIds.add(netEntity.id);
      const existingEntity = this.entities.get(netEntity.id);

      if (!existingEntity) {
        // Create new entity
        const newEntity = this.createEntityFromNetwork(netEntity);
        if (newEntity) {
          // Preserve selection state
          if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(newEntity.id, newEntity);
        }
      } else {
        // Update existing entity (snap to new position)
        this.updateEntityFromNetwork(existingEntity, netEntity);
      }
    }

    // Remove entities that no longer exist
    for (const [id] of this.entities) {
      if (!existingIds.has(id)) {
        this.entities.delete(id);
      }
    }

    // Update economy state
    for (const [playerIdStr, eco] of Object.entries(state.economy)) {
      const playerId = parseInt(playerIdStr) as PlayerId;
      economyManager.setEconomyState(playerId, eco);
    }

    // Store spray targets for rendering
    if (state.sprayTargets && state.sprayTargets.length > 0) {
      this.sprayTargets = state.sprayTargets.map(st => ({
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
    } else {
      this.sprayTargets = [];
    }

    // Store audio events for processing
    this.pendingAudioEvents = state.audioEvents ?? [];

    // Check game over
    if (state.gameOver) {
      this.gameOverWinnerId = state.gameOver.winnerId;
    }
  }

  /**
   * Apply velocity-based prediction between network updates
   * Same logic used by actual clients and host's client view
   */
  applyPrediction(deltaMs: number): void {
    const dtSec = deltaMs / 1000;

    // Predict unit positions using velocity
    for (const entity of this.entities.values()) {
      if (entity.type !== 'unit' || !entity.unit) continue;

      const velX = entity.unit.velocityX ?? 0;
      const velY = entity.unit.velocityY ?? 0;

      // Direct position update (no physics engine)
      entity.transform.x += velX * dtSec;
      entity.transform.y += velY * dtSec;
    }

    // Predict projectile positions
    for (const entity of this.entities.values()) {
      if (entity.type !== 'projectile' || !entity.projectile) continue;

      const proj = entity.projectile;

      // Only predict traveling projectiles (beams snap to host position)
      if (proj.projectileType === 'traveling') {
        entity.transform.x += proj.velocityX * dtSec;
        entity.transform.y += proj.velocityY * dtSec;
      }
    }
  }

  /**
   * Create an entity from network data
   */
  private createEntityFromNetwork(netEntity: NetworkEntity): Entity | null {
    const { id, type, x, y, rotation, playerId } = netEntity;

    if (type === 'unit') {
      // Convert network actions to unit actions
      const actions = netEntity.actions?.filter(na => na.x !== undefined && na.y !== undefined).map(na => ({
        type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair',
        x: na.x!,
        y: na.y!,
        targetId: na.targetId,
        buildingType: na.buildingType as BuildingType | undefined,
        gridX: na.gridX,
        gridY: na.gridY,
        buildingId: na.buildingId,
      })) ?? [];

      const entity: Entity = {
        id,
        type: 'unit',
        transform: { x, y, rotation },
        ownership: playerId !== undefined ? { playerId } : undefined,
        selectable: { selected: false },
        unit: {
          hp: netEntity.hp ?? 100,
          maxHp: netEntity.maxHp ?? 100,
          collisionRadius: netEntity.collisionRadius ?? 15,
          moveSpeed: netEntity.moveSpeed ?? 100,
          actions,
          patrolStartIndex: null,
          velocityX: netEntity.velocityX ?? 0,
          velocityY: netEntity.velocityY ?? 0,
        },
      };

      // Add weapons from network state - all weapons are independent
      if (netEntity.weapons && netEntity.weapons.length > 0) {
        entity.weapons = netEntity.weapons.map(nw => ({
          config: getWeaponConfig(nw.configId),
          currentCooldown: 0,
          targetEntityId: nw.targetId ?? null,
          seeRange: nw.seeRange,
          fireRange: nw.fireRange,
          turretRotation: nw.turretRotation,
          turretTurnRate: nw.turretTurnRate,
          offsetX: nw.offsetX,
          offsetY: nw.offsetY,
          isFiring: nw.isFiring,
        }));
      }

      if (netEntity.isCommander) {
        entity.commander = {
          isDGunActive: false,
          dgunEnergyCost: 100,
        };
        entity.builder = {
          buildRange: 200,
          buildRate: 30,
          currentBuildTarget: netEntity.buildTargetId ?? null,
        };
      }

      return entity;
    }

    if (type === 'building') {
      const entity: Entity = {
        id,
        type: 'building',
        transform: { x, y, rotation },
        ownership: playerId !== undefined ? { playerId } : undefined,
        selectable: { selected: false },
        building: {
          width: netEntity.width ?? 100,
          height: netEntity.height ?? 100,
          hp: netEntity.hp ?? 500,
          maxHp: netEntity.maxHp ?? 500,
        },
        buildable: {
          buildProgress: netEntity.buildProgress ?? 1,
          isComplete: netEntity.isComplete ?? true,
          energyCost: 100,
          maxBuildRate: 20,
          isGhost: false,
        },
        buildingType: netEntity.buildingType as BuildingType | undefined,
      };

      if (netEntity.buildQueue !== undefined) {
        entity.factory = {
          buildQueue: netEntity.buildQueue,
          currentBuildProgress: netEntity.factoryProgress ?? 0,
          currentBuildCost: 0,
          currentBuildRate: 50,
          rallyX: netEntity.rallyX ?? x,
          rallyY: netEntity.rallyY ?? y + 100,
          isProducing: netEntity.isProducing ?? false,
          waypoints: netEntity.factoryWaypoints?.map(wp => ({
            x: wp.x,
            y: wp.y,
            type: wp.type as 'move' | 'fight' | 'patrol',
          })) ?? [],
        };
      }

      return entity;
    }

    if (type === 'projectile') {
      const entity: Entity = {
        id,
        type: 'projectile',
        transform: { x, y, rotation },
        projectile: {
          ownerId: playerId ?? 1,
          sourceEntityId: 0,
          config: netEntity.weaponId ? getWeaponConfig(netEntity.weaponId) : {
            id: 'unknown',
            damage: 10,
            range: 100,
            cooldown: 1000,
          },
          projectileType: (netEntity.projectileType as 'instant' | 'traveling' | 'beam') ?? 'traveling',
          velocityX: netEntity.velocityX ?? 0,
          velocityY: netEntity.velocityY ?? 0,
          timeAlive: 0,
          maxLifespan: 2000,
          hitEntities: new Set(),
          maxHits: 1,
          startX: netEntity.beamStartX,
          startY: netEntity.beamStartY,
          endX: netEntity.beamEndX,
          endY: netEntity.beamEndY,
        },
      };

      return entity;
    }

    return null;
  }

  /**
   * Update an existing entity with network data
   */
  private updateEntityFromNetwork(entity: Entity, netEntity: NetworkEntity): void {
    // Snap position to host position
    entity.transform.x = netEntity.x;
    entity.transform.y = netEntity.y;
    entity.transform.rotation = netEntity.rotation;

    // Update unit-specific fields
    if (entity.unit) {
      entity.unit.hp = netEntity.hp ?? entity.unit.hp;
      entity.unit.maxHp = netEntity.maxHp ?? entity.unit.maxHp;
      entity.unit.collisionRadius = netEntity.collisionRadius ?? entity.unit.collisionRadius;
      entity.unit.moveSpeed = netEntity.moveSpeed ?? entity.unit.moveSpeed;
      entity.unit.velocityX = netEntity.velocityX ?? 0;
      entity.unit.velocityY = netEntity.velocityY ?? 0;
      // Note: turret rotation is per-weapon, updated below in weapon state update

      // Update action queue
      if (netEntity.actions) {
        entity.unit.actions = netEntity.actions.filter(na => na.x !== undefined && na.y !== undefined).map(na => ({
          type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair',
          x: na.x!,
          y: na.y!,
          targetId: na.targetId,
          buildingType: na.buildingType as BuildingType | undefined,
          gridX: na.gridX,
          gridY: na.gridY,
          buildingId: na.buildingId,
        }));
      }
    }

    // Update all weapons from network state - each weapon is independent
    if (netEntity.weapons && netEntity.weapons.length > 0 && entity.weapons) {
      for (let i = 0; i < netEntity.weapons.length && i < entity.weapons.length; i++) {
        entity.weapons[i].targetEntityId = netEntity.weapons[i].targetId ?? null;
        entity.weapons[i].turretRotation = netEntity.weapons[i].turretRotation;
        entity.weapons[i].isFiring = netEntity.weapons[i].isFiring;
      }
    }

    // Update builder state
    if (entity.builder && netEntity.buildTargetId !== undefined) {
      entity.builder.currentBuildTarget = netEntity.buildTargetId;
    }

    // Update building-specific fields
    if (entity.building) {
      entity.building.hp = netEntity.hp ?? entity.building.hp;
      entity.building.maxHp = netEntity.maxHp ?? entity.building.maxHp;
    }

    if (entity.buildable) {
      entity.buildable.buildProgress = netEntity.buildProgress ?? entity.buildable.buildProgress;
      entity.buildable.isComplete = netEntity.isComplete ?? entity.buildable.isComplete;
    }

    if (entity.factory) {
      entity.factory.buildQueue = netEntity.buildQueue ?? entity.factory.buildQueue;
      entity.factory.currentBuildProgress = netEntity.factoryProgress ?? entity.factory.currentBuildProgress;
      entity.factory.isProducing = netEntity.isProducing ?? entity.factory.isProducing;
      if (netEntity.rallyX !== undefined) entity.factory.rallyX = netEntity.rallyX;
      if (netEntity.rallyY !== undefined) entity.factory.rallyY = netEntity.rallyY;
    }

    // Update projectile-specific fields
    if (entity.projectile) {
      entity.projectile.velocityX = netEntity.velocityX ?? entity.projectile.velocityX;
      entity.projectile.velocityY = netEntity.velocityY ?? entity.projectile.velocityY;
      if (netEntity.beamStartX !== undefined) entity.projectile.startX = netEntity.beamStartX;
      if (netEntity.beamStartY !== undefined) entity.projectile.startY = netEntity.beamStartY;
      if (netEntity.beamEndX !== undefined) entity.projectile.endX = netEntity.beamEndX;
      if (netEntity.beamEndY !== undefined) entity.projectile.endY = netEntity.beamEndY;
    }
  }

  // === Accessors for rendering and input ===

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  getUnits(): Entity[] {
    return this.getAllEntities().filter(e => e.type === 'unit');
  }

  getBuildings(): Entity[] {
    return this.getAllEntities().filter(e => e.type === 'building');
  }

  getProjectiles(): Entity[] {
    return this.getAllEntities().filter(e => e.type === 'projectile');
  }

  getSprayTargets(): SprayTarget[] {
    return this.sprayTargets;
  }

  getPendingAudioEvents(): NetworkGameState['audioEvents'] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = [];
    return events;
  }

  getGameOverWinnerId(): PlayerId | null {
    return this.gameOverWinnerId;
  }

  getTick(): number {
    return this.currentTick;
  }

  // === Selection management ===

  setSelectedIds(ids: Set<EntityId>): void {
    this.selectedIds = new Set(ids);
    // Update entity selection state
    for (const entity of this.entities.values()) {
      if (entity.selectable) {
        entity.selectable.selected = this.selectedIds.has(entity.id);
      }
    }
  }

  getSelectedIds(): Set<EntityId> {
    return this.selectedIds;
  }

  selectEntity(id: EntityId): void {
    this.selectedIds.add(id);
    const entity = this.entities.get(id);
    if (entity?.selectable) {
      entity.selectable.selected = true;
    }
  }

  deselectEntity(id: EntityId): void {
    this.selectedIds.delete(id);
    const entity = this.entities.get(id);
    if (entity?.selectable) {
      entity.selectable.selected = false;
    }
  }

  clearSelection(): void {
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (entity?.selectable) {
        entity.selectable.selected = false;
      }
    }
    this.selectedIds.clear();
  }

  // === Entity lookup for input handling ===

  findUnitAt(x: number, y: number, playerId?: PlayerId): Entity | null {
    for (const entity of this.getUnits()) {
      if (playerId !== undefined && entity.ownership?.playerId !== playerId) continue;

      const collisionRadius = entity.unit?.collisionRadius ?? 15;
      const dx = entity.transform.x - x;
      const dy = entity.transform.y - y;
      if (dx * dx + dy * dy <= collisionRadius * collisionRadius) {
        return entity;
      }
    }
    return null;
  }

  findBuildingAt(x: number, y: number): Entity | null {
    for (const entity of this.getBuildings()) {
      if (!entity.building) continue;

      const hw = entity.building.width / 2;
      const hh = entity.building.height / 2;
      if (x >= entity.transform.x - hw && x <= entity.transform.x + hw &&
          y >= entity.transform.y - hh && y <= entity.transform.y + hh) {
        return entity;
      }
    }
    return null;
  }

  findEntitiesInRect(x1: number, y1: number, x2: number, y2: number, playerId?: PlayerId): Entity[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const results: Entity[] = [];

    for (const entity of this.getUnits()) {
      if (playerId !== undefined && entity.ownership?.playerId !== playerId) continue;

      if (entity.transform.x >= minX && entity.transform.x <= maxX &&
          entity.transform.y >= minY && entity.transform.y <= maxY) {
        results.push(entity);
      }
    }

    return results;
  }

  clear(): void {
    this.entities.clear();
    this.sprayTargets = [];
    this.pendingAudioEvents = [];
    this.gameOverWinnerId = null;
    this.selectedIds.clear();
  }
}
