/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: dead-reckon using velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId, BuildingType } from '../sim/types';
import type { NetworkGameState, NetworkEntity, NetworkProjectileSpawn, NetworkGridCell } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import { economyManager } from '../sim/economy';
import { createEntityFromNetwork } from './helpers';
import { getWeaponConfig } from '../sim/weapons';
import { lerp, lerpAngle } from '../math';

// EMA drift rates (per frame at 60fps). Higher = faster correction toward server.
// Frame-rate independent: actual blend = 1 - (1 - RATE)^(dt * 60)
const POSITION_DRIFT = 0.15;
const VELOCITY_DRIFT = 0.25;
const ROTATION_DRIFT = 0.15;

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities: Map<EntityId, Entity> = new Map();

  // Server target state — latest authoritative snapshot per entity
  private serverTargets: Map<EntityId, NetworkEntity> = new Map();

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

  // Reusable Set for snapshot diffing (avoids new Set() per snapshot)
  private _serverIds: Set<EntityId> = new Set();

  // Spatial grid debug visualization data
  private gridCells: NetworkGridCell[] = [];
  private gridCellSize: number = 0;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cachedUnits: Entity[] = [];
  private cachedBuildings: Entity[] = [];
  private cachedProjectiles: Entity[] = [];
  private cachesDirty: boolean = true;

  constructor() {}

  private invalidateCaches(): void {
    this.cachesDirty = true;
  }

  private rebuildCachesIfNeeded(): void {
    if (!this.cachesDirty) return;

    this.cachedUnits.length = 0;
    this.cachedBuildings.length = 0;
    this.cachedProjectiles.length = 0;

    for (const entity of this.entities.values()) {
      switch (entity.type) {
        case 'unit':
          this.cachedUnits.push(entity);
          break;
        case 'building':
          this.cachedBuildings.push(entity);
          break;
        case 'projectile':
          this.cachedProjectiles.push(entity);
          break;
      }
    }

    this.cachesDirty = false;
  }

  /**
   * Apply received network state — store server targets, snap non-visual state.
   * Visual blending toward these targets happens in applyPrediction() each frame.
   */
  applyNetworkState(state: NetworkGameState): void {
    this.currentTick = state.tick;

    // Reuse Set to avoid per-snapshot allocation
    this._serverIds.clear();

    for (const netEntity of state.entities) {
      this._serverIds.add(netEntity.id);

      // Store as server target for per-frame drifting
      this.serverTargets.set(netEntity.id, netEntity);

      const existing = this.entities.get(netEntity.id);

      if (!existing) {
        // New entity — create at server position
        const newEntity = createEntityFromNetwork(netEntity);
        if (newEntity) {
          if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(netEntity.id, newEntity);
        }
      } else {
        // Existing entity — snap non-visual state immediately
        this.snapNonVisualState(existing, netEntity);
      }
    }

    // Remove non-projectile entities no longer on the server
    // Projectiles are managed via spawn/despawn events, not the entity list
    for (const [id, entity] of this.entities) {
      if (entity.type === 'projectile') continue;
      if (!this._serverIds.has(id)) {
        this.entities.delete(id);
        this.serverTargets.delete(id);
      }
    }

    // Process projectile spawn events
    if (state.projectileSpawns) {
      for (const spawn of state.projectileSpawns) {
        try {
          const entity = this.createProjectileFromSpawn(spawn);
          this.entities.set(spawn.id, entity);
        } catch {
          // Skip projectiles with unknown weapon configs (e.g. corrupted by serialization)
        }
      }
    }

    // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
    if (state.projectileDespawns) {
      for (const despawn of state.projectileDespawns) {
        this.entities.delete(despawn.id);
        this.serverTargets.delete(despawn.id);
      }
    }

    // Process projectile velocity updates (force field pull deflection)
    // Snap position to server's authoritative value to correct dead-reckoning drift
    if (state.projectileVelocityUpdates) {
      for (const vu of state.projectileVelocityUpdates) {
        const entity = this.entities.get(vu.id);
        if (entity?.projectile) {
          entity.transform.x = vu.x;
          entity.transform.y = vu.y;
          entity.projectile.velocityX = vu.velocityX;
          entity.projectile.velocityY = vu.velocityY;
          entity.transform.rotation = Math.atan2(vu.velocityY, vu.velocityX);
        }
      }
    }

    this.invalidateCaches();

    // Update economy state (immediate)
    for (const [playerIdStr, eco] of Object.entries(state.economy)) {
      const playerId = parseInt(playerIdStr) as PlayerId;
      economyManager.setEconomyState(playerId, eco);
    }

    // Store spray targets for rendering (reuse array, overwrite in place)
    if (state.sprayTargets && state.sprayTargets.length > 0) {
      const src = state.sprayTargets;
      this.sprayTargets.length = src.length;
      for (let i = 0; i < src.length; i++) {
        const st = src[i];
        this.sprayTargets[i] = {
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
        };
      }
    } else {
      this.sprayTargets.length = 0;
    }

    // Store audio events for processing
    this.pendingAudioEvents = state.audioEvents ?? [];

    // Check game over
    if (state.gameOver) {
      this.gameOverWinnerId = state.gameOver.winnerId;
    }

    // Store spatial grid debug data
    this.gridCells = state.gridCells ?? [];
    this.gridCellSize = state.gridCellSize ?? 0;
  }

  /**
   * Snap non-visual state (hp, actions, targeting, building/factory fields).
   * These don't need smooth blending — they should reflect server truth immediately.
   */
  private snapNonVisualState(entity: Entity, server: NetworkEntity): void {
    if (entity.unit) {
      entity.unit.hp = server.hp ?? entity.unit.hp;
      entity.unit.maxHp = server.maxHp ?? entity.unit.maxHp;
      entity.unit.collisionRadius = server.collisionRadius ?? entity.unit.collisionRadius;
      entity.unit.moveSpeed = server.moveSpeed ?? entity.unit.moveSpeed;

      if (server.actions) {
        const src = server.actions;
        const actions = entity.unit.actions;
        actions.length = 0;
        for (let i = 0; i < src.length; i++) {
          const na = src[i];
          if (na.x === undefined || na.y === undefined) continue;
          actions.push({
            type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair',
            x: na.x,
            y: na.y,
            targetId: na.targetId,
            buildingType: na.buildingType as BuildingType | undefined,
            gridX: na.gridX,
            gridY: na.gridY,
            buildingId: na.buildingId,
          });
        }
      }

      // Snap weapon targeting state (turret rotation/velocity blended in applyPrediction)
      if (server.weapons && server.weapons.length > 0 && entity.weapons) {
        for (let i = 0; i < server.weapons.length && i < entity.weapons.length; i++) {
          entity.weapons[i].targetEntityId = server.weapons[i].targetId ?? null;
          entity.weapons[i].isFiring = server.weapons[i].isFiring;
          entity.weapons[i].currentForceFieldRange = server.weapons[i].currentForceFieldRange;
        }
      }

      if (entity.builder && server.buildTargetId !== undefined) {
        entity.builder.currentBuildTarget = server.buildTargetId;
      }
    }

    if (entity.building) {
      entity.building.hp = server.hp ?? entity.building.hp;
      entity.building.maxHp = server.maxHp ?? entity.building.maxHp;
    }

    if (entity.buildable) {
      entity.buildable.buildProgress = server.buildProgress ?? entity.buildable.buildProgress;
      entity.buildable.isComplete = server.isComplete ?? entity.buildable.isComplete;
    }

    if (entity.factory) {
      entity.factory.buildQueue = server.buildQueue ?? entity.factory.buildQueue;
      entity.factory.currentBuildProgress = server.factoryProgress ?? entity.factory.currentBuildProgress;
      entity.factory.isProducing = server.isProducing ?? entity.factory.isProducing;
      if (server.rallyX !== undefined) entity.factory.rallyX = server.rallyX;
      if (server.rallyY !== undefined) entity.factory.rallyY = server.rallyY;
      if (server.factoryWaypoints) {
        const wps = server.factoryWaypoints;
        entity.factory.waypoints.length = wps.length;
        for (let i = 0; i < wps.length; i++) {
          entity.factory.waypoints[i] = {
            x: wps[i].x,
            y: wps[i].y,
            type: wps[i].type as 'move' | 'fight' | 'patrol',
          };
        }
      }
    }

    // Projectiles are no longer in server snapshots — handled via spawn/despawn events
  }

  /**
   * Called every frame. Two steps:
   * 1. Dead-reckon: advance positions using velocity
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number): void {
    const dt = deltaMs / 1000;

    // Ensure caches are fresh for beam obstruction checks
    this.rebuildCachesIfNeeded();

    // Frame-rate independent blend factors
    const posDrift = 1 - Math.pow(1 - POSITION_DRIFT, dt * 60);
    const velDrift = 1 - Math.pow(1 - VELOCITY_DRIFT, dt * 60);
    const rotDrift = 1 - Math.pow(1 - ROTATION_DRIFT, dt * 60);

    for (const entity of this.entities.values()) {
      const target = this.serverTargets.get(entity.id);

      if (entity.type === 'unit' && entity.unit) {
        // Step 1: Dead-reckon using current velocity
        const vx = entity.unit.velocityX ?? 0;
        const vy = entity.unit.velocityY ?? 0;
        entity.transform.x += vx * dt;
        entity.transform.y += vy * dt;

        // Step 2: Drift toward server targets
        if (target) {
          entity.transform.x = lerp(entity.transform.x, target.x, posDrift);
          entity.transform.y = lerp(entity.transform.y, target.y, posDrift);
          entity.transform.rotation = lerpAngle(entity.transform.rotation, target.rotation, rotDrift);

          const serverVelX = target.velocityX ?? 0;
          const serverVelY = target.velocityY ?? 0;
          entity.unit.velocityX = lerp(vx, serverVelX, velDrift);
          entity.unit.velocityY = lerp(vy, serverVelY, velDrift);
        }

        // Advance turret rotations using angular velocity + drift toward server
        if (entity.weapons) {
          for (let i = 0; i < entity.weapons.length; i++) {
            const weapon = entity.weapons[i];
            weapon.turretRotation += weapon.turretAngularVelocity * dt;

            // Drift turret toward server target
            const tw = target?.weapons?.[i];
            if (tw) {
              weapon.turretRotation = lerpAngle(weapon.turretRotation, tw.turretRotation, rotDrift);
              weapon.turretAngularVelocity = lerp(weapon.turretAngularVelocity, tw.turretAngularVelocity, velDrift);
            }
          }
        }
      }

      if (entity.type === 'projectile' && entity.projectile) {
        if (entity.projectile.projectileType === 'beam') {
          // Beams: reconstruct from source unit's current position + turret rotation
          // Beam existence is driven by the weapon's isFiring state (updated every snapshot),
          // so lost despawn events self-correct on the next snapshot.
          const weaponIndex = (entity.projectile.config as { weaponIndex?: number }).weaponIndex ?? 0;
          const source = this.entities.get(entity.projectile.sourceEntityId);
          const weapon = source?.weapons?.[weaponIndex];

          if (source && weapon && weapon.isFiring) {
            const turretAngle = weapon.turretRotation;
            const dirX = Math.cos(turretAngle);
            const dirY = Math.sin(turretAngle);

            // Calculate weapon position in world coordinates (same math as sim)
            const unitCos = Math.cos(source.transform.rotation);
            const unitSin = Math.sin(source.transform.rotation);
            const weaponX = source.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
            const weaponY = source.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

            // Beam starts 5 units forward from weapon position
            const startX = weaponX + dirX * 5;
            const startY = weaponY + dirY * 5;

            // Full-range beam end
            const fullEndX = startX + dirX * weapon.fireRange;
            const fullEndY = startY + dirY * weapon.fireRange;

            // Truncate at closest obstruction (units or buildings)
            const t = this.findBeamObstruction(
              startX, startY, fullEndX, fullEndY, entity.projectile.sourceEntityId
            );

            entity.projectile.startX = startX;
            entity.projectile.startY = startY;
            entity.projectile.endX = startX + (fullEndX - startX) * t;
            entity.projectile.endY = startY + (fullEndY - startY) * t;

            entity.transform.x = startX;
            entity.transform.y = startY;
            entity.transform.rotation = turretAngle;
          } else {
            // Source unit gone or weapon stopped firing — remove beam
            this.entities.delete(entity.id);
            this.serverTargets.delete(entity.id);
          }
        } else {
          // Traveling projectiles: dead-reckon only (no server target exists)
          entity.transform.x += entity.projectile.velocityX * dt;
          entity.transform.y += entity.projectile.velocityY * dt;

          // Auto-remove if projectile has left the map bounds
          entity.projectile.timeAlive += deltaMs;
          if (entity.projectile.timeAlive > 10000) {
            this.entities.delete(entity.id);
            this.serverTargets.delete(entity.id);
          }
        }
      }

      // Buildings don't move — snap position from target
      if (entity.type === 'building' && target) {
        entity.transform.x = target.x;
        entity.transform.y = target.y;
        entity.transform.rotation = target.rotation;
      }
    }

    this.invalidateCaches();
  }

  /**
   * Create a full Entity from a projectile spawn event.
   * For traveling/dgun projectiles, adjusts spawn position to the client-side muzzle
   * so bullets visually originate from the gun (same approach as beams).
   */
  private createProjectileFromSpawn(spawn: NetworkProjectileSpawn): Entity {
    const config = { ...getWeaponConfig(spawn.weaponId), weaponIndex: spawn.weaponIndex };

    // Default to server position; override with client-side muzzle if source is available
    let spawnX = spawn.x;
    let spawnY = spawn.y;

    if (spawn.projectileType !== 'beam') {
      const source = this.entities.get(spawn.sourceEntityId);
      const weapon = source?.weapons?.[spawn.weaponIndex];
      if (source && weapon) {
        const unitCos = Math.cos(source.transform.rotation);
        const unitSin = Math.sin(source.transform.rotation);
        const weaponX = source.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
        const weaponY = source.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

        // 5 units forward from weapon in firing direction (same as server)
        const turretAngle = weapon.turretRotation;
        spawnX = weaponX + Math.cos(turretAngle) * 5;
        spawnY = weaponY + Math.sin(turretAngle) * 5;
      }
    }

    const entity: Entity = {
      id: spawn.id,
      type: 'projectile',
      transform: { x: spawnX, y: spawnY, rotation: spawn.rotation },
      ownership: { playerId: spawn.playerId },
      projectile: {
        ownerId: spawn.playerId,
        sourceEntityId: spawn.sourceEntityId,
        config,
        projectileType: spawn.projectileType as 'instant' | 'traveling' | 'beam',
        velocityX: spawn.velocityX,
        velocityY: spawn.velocityY,
        timeAlive: 0,
        maxLifespan: config.projectileLifespan ?? config.beamDuration ?? 2000,
        hitEntities: new Set(),
        maxHits: 1,
        startX: spawn.beamStartX,
        startY: spawn.beamStartY,
        endX: spawn.beamEndX,
        endY: spawn.beamEndY,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = { isDGun: true };
    }
    return entity;
  }

  // === Beam obstruction detection ===

  /**
   * Find the closest entity the beam hits. Returns parametric t (0-1) along the beam.
   * 1.0 means no obstruction (full range).
   */
  private findBeamObstruction(
    sx: number, sy: number, ex: number, ey: number, sourceId: number
  ): number {
    let closest = 1.0;
    const dx = ex - sx;
    const dy = ey - sy;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return closest;

    // Check units (line-vs-circle)
    for (const unit of this.cachedUnits) {
      if (unit.id === sourceId) continue;
      const r = unit.unit?.collisionRadius ?? 15;
      const fx = sx - unit.transform.x;
      const fy = sy - unit.transform.y;
      const a = lenSq;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - r * r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && t < closest) closest = t;
    }

    // Check buildings (line-vs-AABB using slab method)
    for (const bldg of this.cachedBuildings) {
      if (bldg.id === sourceId) continue;
      if (!bldg.building) continue;
      const hw = bldg.building.width / 2;
      const hh = bldg.building.height / 2;
      const bx = bldg.transform.x;
      const by = bldg.transform.y;

      let tmin = 0;
      let tmax = 1;

      // X slab
      if (Math.abs(dx) > 0.0001) {
        let t1 = (bx - hw - sx) / dx;
        let t2 = (bx + hw - sx) / dx;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
      } else {
        // Ray is parallel to Y — check if sx is inside x range
        if (sx < bx - hw || sx > bx + hw) continue;
      }

      // Y slab
      if (Math.abs(dy) > 0.0001) {
        let t1 = (by - hh - sy) / dy;
        let t2 = (by + hh - sy) / dy;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
      } else {
        if (sy < by - hh || sy > by + hh) continue;
      }

      if (tmin <= tmax && tmax > 0 && tmin < closest) {
        closest = Math.max(tmin, 0);
      }
    }

    return closest;
  }

  // === Accessors for rendering and input ===

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    // Return concatenation of cached arrays (avoids Array.from on the Map)
    const all = this.cachedUnits.concat(this.cachedBuildings, this.cachedProjectiles);
    return all;
  }

  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedUnits;
  }

  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedBuildings;
  }

  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedProjectiles;
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

  // === Spatial grid debug data ===

  getGridCells(): NetworkGridCell[] {
    return this.gridCells;
  }

  getGridCellSize(): number {
    return this.gridCellSize;
  }

  clear(): void {
    this.entities.clear();
    this.serverTargets.clear();
    this.sprayTargets = [];
    this.pendingAudioEvents = [];
    this.gameOverWinnerId = null;
    this.selectedIds.clear();
    this.gridCells = [];
    this.gridCellSize = 0;
    this.invalidateCaches();
  }
}
