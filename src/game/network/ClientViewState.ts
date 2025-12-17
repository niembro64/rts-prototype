/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses SNAPSHOT INTERPOLATION for smooth rendering:
 * - Buffers recent snapshots from host
 * - Renders entities interpolated between past snapshots
 * - Units appear ~100-150ms behind host but motion is perfectly smooth
 * - This is the industry standard (Source Engine, Overwatch, etc.)
 */

import type { Entity, PlayerId, EntityId, BuildingType } from '../sim/types';
import type { NetworkGameState, NetworkEntity } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import { getWeaponConfig } from '../sim/weapons';
import { economyManager } from '../sim/economy';

// Snapshot buffer entry
interface Snapshot {
  timestamp: number;  // When this snapshot was received (client time)
  tick: number;       // Host tick number
  entities: Map<EntityId, NetworkEntity>;
}

// How far behind real-time to render (ms)
// Higher = more buffer for network jitter, smoother but more latency
// Lower = less latency but may run out of snapshots on lag spikes
const INTERPOLATION_DELAY = 100;  // Render 100ms in the past

// Maximum snapshots to buffer (oldest get dropped)
const MAX_SNAPSHOTS = 30;

export class ClientViewState {
  // Snapshot buffer for interpolation (sorted by timestamp, oldest first)
  private snapshots: Snapshot[] = [];

  // Current render timestamp (client time - INTERPOLATION_DELAY)
  private renderTimestamp: number = 0;

  // Entity storage for rendering (interpolated positions)
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

  // Client time when we started (for timestamp calculation)
  private startTime: number = performance.now();

  constructor() {}

  /**
   * Get current client time in ms
   */
  private getClientTime(): number {
    return performance.now() - this.startTime;
  }

  /**
   * Apply received network state - stores snapshot in buffer
   */
  applyNetworkState(state: NetworkGameState): void {
    this.currentTick = state.tick;

    // Create snapshot with current timestamp
    const snapshot: Snapshot = {
      timestamp: this.getClientTime(),
      tick: state.tick,
      entities: new Map(),
    };

    // Store all entity data
    for (const netEntity of state.entities) {
      snapshot.entities.set(netEntity.id, netEntity);
    }

    // Add to buffer
    this.snapshots.push(snapshot);

    // Trim old snapshots
    while (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    // Update economy state (immediate, not interpolated)
    for (const [playerIdStr, eco] of Object.entries(state.economy)) {
      const playerId = parseInt(playerIdStr) as PlayerId;
      economyManager.setEconomyState(playerId, eco);
    }

    // Store spray targets for rendering (immediate)
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
   * Update interpolated entity positions for rendering
   * Called every frame with delta time
   */
  applyPrediction(_deltaMs: number): void {
    // Advance render timestamp (deltaMs not used - we use wall clock time)
    this.renderTimestamp = this.getClientTime() - INTERPOLATION_DELAY;

    // Need at least 2 snapshots to interpolate
    if (this.snapshots.length < 2) {
      // Not enough data - just use latest snapshot if available
      if (this.snapshots.length === 1) {
        this.applySnapshotDirect(this.snapshots[0]);
      }
      return;
    }

    // Find the two snapshots to interpolate between
    // We want: snapshot1.timestamp <= renderTimestamp <= snapshot2.timestamp
    let snapshot1: Snapshot | null = null;
    let snapshot2: Snapshot | null = null;

    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].timestamp <= this.renderTimestamp &&
          this.snapshots[i + 1].timestamp >= this.renderTimestamp) {
        snapshot1 = this.snapshots[i];
        snapshot2 = this.snapshots[i + 1];
        break;
      }
    }

    // If render time is before all snapshots, use oldest
    if (!snapshot1 && this.renderTimestamp < this.snapshots[0].timestamp) {
      this.applySnapshotDirect(this.snapshots[0]);
      return;
    }

    // If render time is after all snapshots, extrapolate from last two
    if (!snapshot1) {
      snapshot1 = this.snapshots[this.snapshots.length - 2];
      snapshot2 = this.snapshots[this.snapshots.length - 1];
    }

    // Calculate interpolation factor (0 = snapshot1, 1 = snapshot2)
    const timeDiff = snapshot2!.timestamp - snapshot1!.timestamp;
    let t = timeDiff > 0 ? (this.renderTimestamp - snapshot1!.timestamp) / timeDiff : 0;

    // Clamp to [0, 1.5] - allow slight extrapolation if we're ahead
    t = Math.max(0, Math.min(1.5, t));

    // Interpolate all entities
    this.interpolateSnapshots(snapshot1!, snapshot2!, t);
  }

  /**
   * Apply a snapshot directly (no interpolation)
   */
  private applySnapshotDirect(snapshot: Snapshot): void {
    const existingIds = new Set<EntityId>();

    for (const [id, netEntity] of snapshot.entities) {
      existingIds.add(id);
      const existing = this.entities.get(id);

      if (!existing) {
        const newEntity = this.createEntityFromNetwork(netEntity);
        if (newEntity) {
          if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(id, newEntity);
        }
      } else {
        this.updateEntityDirect(existing, netEntity);
      }
    }

    // Remove entities no longer in snapshot
    for (const [id] of this.entities) {
      if (!existingIds.has(id)) {
        this.entities.delete(id);
      }
    }
  }

  /**
   * Interpolate between two snapshots
   */
  private interpolateSnapshots(snap1: Snapshot, snap2: Snapshot, t: number): void {
    const existingIds = new Set<EntityId>();

    // Process all entities that exist in either snapshot
    const allEntityIds = new Set([...snap1.entities.keys(), ...snap2.entities.keys()]);

    for (const id of allEntityIds) {
      existingIds.add(id);
      const net1 = snap1.entities.get(id);
      const net2 = snap2.entities.get(id);

      const existing = this.entities.get(id);

      if (!net1 && net2) {
        // Entity appeared in snap2 - create it at snap2 position
        if (!existing) {
          const newEntity = this.createEntityFromNetwork(net2);
          if (newEntity) {
            if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
              newEntity.selectable.selected = true;
            }
            this.entities.set(id, newEntity);
          }
        } else {
          this.updateEntityDirect(existing, net2);
        }
      } else if (net1 && !net2) {
        // Entity disappeared in snap2 - keep showing at snap1 position until it's gone
        if (!existing) {
          const newEntity = this.createEntityFromNetwork(net1);
          if (newEntity) {
            this.entities.set(id, newEntity);
          }
        } else {
          this.updateEntityDirect(existing, net1);
        }
      } else if (net1 && net2) {
        // Entity exists in both - interpolate!
        if (!existing) {
          const newEntity = this.createEntityFromNetwork(net2);
          if (newEntity) {
            if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
              newEntity.selectable.selected = true;
            }
            this.entities.set(id, newEntity);
            this.interpolateEntity(newEntity, net1, net2, t);
          }
        } else {
          this.interpolateEntity(existing, net1, net2, t);
        }
      }
    }

    // Remove entities no longer in either snapshot
    for (const [id] of this.entities) {
      if (!existingIds.has(id)) {
        this.entities.delete(id);
      }
    }
  }

  /**
   * Interpolate a single entity between two network states
   */
  private interpolateEntity(entity: Entity, net1: NetworkEntity, net2: NetworkEntity, t: number): void {
    // Interpolate position
    entity.transform.x = net1.x + (net2.x - net1.x) * t;
    entity.transform.y = net1.y + (net2.y - net1.y) * t;

    // Interpolate rotation (handle angle wrapping)
    let rotDiff = net2.rotation - net1.rotation;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    entity.transform.rotation = net1.rotation + rotDiff * t;

    // Update unit fields (use snap2 for non-interpolated values)
    if (entity.unit) {
      entity.unit.hp = net2.hp ?? entity.unit.hp;
      entity.unit.maxHp = net2.maxHp ?? entity.unit.maxHp;
      entity.unit.collisionRadius = net2.collisionRadius ?? entity.unit.collisionRadius;
      entity.unit.moveSpeed = net2.moveSpeed ?? entity.unit.moveSpeed;

      // Interpolate velocity for smooth visual effects
      const vel1X = net1.velocityX ?? 0;
      const vel1Y = net1.velocityY ?? 0;
      const vel2X = net2.velocityX ?? 0;
      const vel2Y = net2.velocityY ?? 0;
      entity.unit.velocityX = vel1X + (vel2X - vel1X) * t;
      entity.unit.velocityY = vel1Y + (vel2Y - vel1Y) * t;

      // Update action queue (use latest)
      if (net2.actions) {
        entity.unit.actions = net2.actions.filter(na => na.x !== undefined && na.y !== undefined).map(na => ({
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

    // Update weapons (use latest, interpolate turret rotation)
    if (net2.weapons && net2.weapons.length > 0 && entity.weapons) {
      for (let i = 0; i < net2.weapons.length && i < entity.weapons.length; i++) {
        const w1 = net1.weapons?.[i];
        const w2 = net2.weapons[i];

        entity.weapons[i].targetEntityId = w2.targetId ?? null;
        entity.weapons[i].isFiring = w2.isFiring;
        entity.weapons[i].currentSliceAngle = w2.currentSliceAngle;

        // Interpolate turret rotation
        if (w1 && w2) {
          let turretDiff = w2.turretRotation - w1.turretRotation;
          while (turretDiff > Math.PI) turretDiff -= Math.PI * 2;
          while (turretDiff < -Math.PI) turretDiff += Math.PI * 2;
          entity.weapons[i].turretRotation = w1.turretRotation + turretDiff * t;
        } else {
          entity.weapons[i].turretRotation = w2.turretRotation;
        }
      }
    }

    // Update builder state
    if (entity.builder && net2.buildTargetId !== undefined) {
      entity.builder.currentBuildTarget = net2.buildTargetId;
    }

    // Update building fields
    if (entity.building) {
      entity.building.hp = net2.hp ?? entity.building.hp;
      entity.building.maxHp = net2.maxHp ?? entity.building.maxHp;
    }

    if (entity.buildable) {
      // Interpolate build progress for smooth construction visual
      const prog1 = net1.buildProgress ?? 0;
      const prog2 = net2.buildProgress ?? 0;
      entity.buildable.buildProgress = prog1 + (prog2 - prog1) * t;
      entity.buildable.isComplete = net2.isComplete ?? entity.buildable.isComplete;
    }

    if (entity.factory) {
      entity.factory.buildQueue = net2.buildQueue ?? entity.factory.buildQueue;
      // Interpolate factory progress
      const fProg1 = net1.factoryProgress ?? 0;
      const fProg2 = net2.factoryProgress ?? 0;
      entity.factory.currentBuildProgress = fProg1 + (fProg2 - fProg1) * t;
      entity.factory.isProducing = net2.isProducing ?? entity.factory.isProducing;
      if (net2.rallyX !== undefined) entity.factory.rallyX = net2.rallyX;
      if (net2.rallyY !== undefined) entity.factory.rallyY = net2.rallyY;
      // Update factory waypoints
      if (net2.factoryWaypoints) {
        entity.factory.waypoints = net2.factoryWaypoints.map(wp => ({
          x: wp.x,
          y: wp.y,
          type: wp.type as 'move' | 'fight' | 'patrol',
        }));
      }
    }

    // Update projectile fields
    if (entity.projectile) {
      // Interpolate projectile velocity
      const pVel1X = net1.velocityX ?? 0;
      const pVel1Y = net1.velocityY ?? 0;
      const pVel2X = net2.velocityX ?? 0;
      const pVel2Y = net2.velocityY ?? 0;
      entity.projectile.velocityX = pVel1X + (pVel2X - pVel1X) * t;
      entity.projectile.velocityY = pVel1Y + (pVel2Y - pVel1Y) * t;

      // Interpolate beam positions
      if (net1.beamStartX !== undefined && net2.beamStartX !== undefined) {
        entity.projectile.startX = net1.beamStartX + (net2.beamStartX - net1.beamStartX) * t;
      } else if (net2.beamStartX !== undefined) {
        entity.projectile.startX = net2.beamStartX;
      }
      if (net1.beamStartY !== undefined && net2.beamStartY !== undefined) {
        entity.projectile.startY = net1.beamStartY + (net2.beamStartY - net1.beamStartY) * t;
      } else if (net2.beamStartY !== undefined) {
        entity.projectile.startY = net2.beamStartY;
      }
      if (net1.beamEndX !== undefined && net2.beamEndX !== undefined) {
        entity.projectile.endX = net1.beamEndX + (net2.beamEndX - net1.beamEndX) * t;
      } else if (net2.beamEndX !== undefined) {
        entity.projectile.endX = net2.beamEndX;
      }
      if (net1.beamEndY !== undefined && net2.beamEndY !== undefined) {
        entity.projectile.endY = net1.beamEndY + (net2.beamEndY - net1.beamEndY) * t;
      } else if (net2.beamEndY !== undefined) {
        entity.projectile.endY = net2.beamEndY;
      }
    }
  }

  /**
   * Update entity directly from network data (no interpolation)
   */
  private updateEntityDirect(entity: Entity, netEntity: NetworkEntity): void {
    entity.transform.x = netEntity.x;
    entity.transform.y = netEntity.y;
    entity.transform.rotation = netEntity.rotation;

    if (entity.unit) {
      entity.unit.hp = netEntity.hp ?? entity.unit.hp;
      entity.unit.maxHp = netEntity.maxHp ?? entity.unit.maxHp;
      entity.unit.collisionRadius = netEntity.collisionRadius ?? entity.unit.collisionRadius;
      entity.unit.moveSpeed = netEntity.moveSpeed ?? entity.unit.moveSpeed;
      entity.unit.velocityX = netEntity.velocityX ?? 0;
      entity.unit.velocityY = netEntity.velocityY ?? 0;

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

    if (netEntity.weapons && netEntity.weapons.length > 0 && entity.weapons) {
      for (let i = 0; i < netEntity.weapons.length && i < entity.weapons.length; i++) {
        entity.weapons[i].targetEntityId = netEntity.weapons[i].targetId ?? null;
        entity.weapons[i].turretRotation = netEntity.weapons[i].turretRotation;
        entity.weapons[i].isFiring = netEntity.weapons[i].isFiring;
        entity.weapons[i].currentSliceAngle = netEntity.weapons[i].currentSliceAngle;
      }
    }

    if (entity.builder && netEntity.buildTargetId !== undefined) {
      entity.builder.currentBuildTarget = netEntity.buildTargetId;
    }

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
      // Update factory waypoints
      if (netEntity.factoryWaypoints) {
        entity.factory.waypoints = netEntity.factoryWaypoints.map(wp => ({
          x: wp.x,
          y: wp.y,
          type: wp.type as 'move' | 'fight' | 'patrol',
        }));
      }
    }

    if (entity.projectile) {
      entity.projectile.velocityX = netEntity.velocityX ?? entity.projectile.velocityX;
      entity.projectile.velocityY = netEntity.velocityY ?? entity.projectile.velocityY;
      if (netEntity.beamStartX !== undefined) entity.projectile.startX = netEntity.beamStartX;
      if (netEntity.beamStartY !== undefined) entity.projectile.startY = netEntity.beamStartY;
      if (netEntity.beamEndX !== undefined) entity.projectile.endX = netEntity.beamEndX;
      if (netEntity.beamEndY !== undefined) entity.projectile.endY = netEntity.beamEndY;
    }
  }

  /**
   * Create an entity from network data
   */
  private createEntityFromNetwork(netEntity: NetworkEntity): Entity | null {
    const { id, type, x, y, rotation, playerId } = netEntity;

    if (type === 'unit') {
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
          mass: netEntity.mass ?? 25,
          actions,
          patrolStartIndex: null,
          velocityX: netEntity.velocityX ?? 0,
          velocityY: netEntity.velocityY ?? 0,
        },
      };

      if (netEntity.weapons && netEntity.weapons.length > 0) {
        entity.weapons = netEntity.weapons.map(nw => ({
          config: getWeaponConfig(nw.configId),
          currentCooldown: 0,
          targetEntityId: nw.targetId ?? null,
          targetingMode: nw.targetingMode ?? 'nearest',
          seeRange: nw.seeRange,
          fireRange: nw.fireRange,
          fightstopRange: nw.fightstopRange,
          turretRotation: nw.turretRotation,
          turretAngularVelocity: nw.turretAngularVelocity,
          turretTurnAccel: nw.turretTurnAccel,
          turretDrag: nw.turretDrag,
          offsetX: nw.offsetX,
          offsetY: nw.offsetY,
          isFiring: nw.isFiring,
          inFightstopRange: nw.inFightstopRange,
          currentSliceAngle: nw.currentSliceAngle,
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
    this.snapshots = [];
    this.sprayTargets = [];
    this.pendingAudioEvents = [];
    this.gameOverWinnerId = null;
    this.selectedIds.clear();
    this.renderTimestamp = 0;
  }
}
