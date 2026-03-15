/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: dead-reckon using velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId, BuildingType } from '../sim/types';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
} from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import { economyManager } from '../sim/economy';
import { createEntityFromNetwork } from './helpers';
import { getTurretConfig } from '../sim/turretConfigs';
import { getBarrelTipWorldPos } from '../sim/combat/combatUtils';
import {
  ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP, ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY,
} from '../../types/network';


// Reusable result for raySegmentIntersection (avoids per-hit allocations in hot loop)
const _rsHit = { t: 0, x: 0, y: 0 };

// Ray-vs-line-segment intersection (shared with DamageSystem)
// Returns reusable _rsHit on hit — caller must read values before next call
function raySegmentIntersection(
  sx: number, sy: number, ex: number, ey: number,
  ax: number, ay: number, bx: number, by: number,
): typeof _rsHit | null {
  const rdx = ex - sx, rdy = ey - sy;
  const sdx = bx - ax, sdy = by - ay;
  const denom = rdx * sdy - rdy * sdx;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((ax - sx) * sdy - (ay - sy) * sdx) / denom;
  const u = ((ax - sx) * rdy - (ay - sy) * rdx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  _rsHit.t = t; _rsHit.x = sx + t * rdx; _rsHit.y = sy + t * rdy;
  return _rsHit;
}

// Reusable result for findBeamSegmentHit (avoids per-call allocations)
const _segHit = { t: 0, x: 0, y: 0, entityId: 0, isMirror: false, normalX: 0, normalY: 0, panelIndex: -1 };
import {
  lerp,
  lerpAngle,
  magnitude,
  getWeaponWorldPosition,
  lineCircleIntersectionT,
  applyHomingSteering,
} from '../math';
import { EntityCacheManager } from '../sim/EntityCacheManager';

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];

// EMA drift rates (per frame at 60fps). Higher = faster correction toward server.
// Frame-rate independent: actual blend = 1 - (1 - RATE)^(dt * 60)
import { getDriftMode, getGraphicsConfig } from '@/clientBarConfig';
import type { DriftMode } from '@/types/client';

const DRIFT_PRESETS: Record<
  DriftMode,
  { position: number; velocity: number; rotation: number }
> = {
  snap: { position: 1.0, velocity: 1.0, rotation: 1.0 },
  fast: { position: 0.15, velocity: 0.25, rotation: 0.15 },
  slow: { position: 0.04, velocity: 0.08, rotation: 0.04 },
};

// Lightweight copy of server state used for per-frame drift in applyPrediction().
// Owns its data (not a reference to pooled serializer objects).
type ServerTarget = {
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  turrets: {
    rotation: number;
    angularVelocity: number;
    forceFieldRange: number | undefined;
  }[];
};

function createServerTarget(): ServerTarget {
  return { x: 0, y: 0, rotation: 0, velocityX: 0, velocityY: 0, turrets: [] };
}

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities: Map<EntityId, Entity> = new Map();

  // Server target state — owned copies of drift-relevant fields per entity
  private serverTargets: Map<EntityId, ServerTarget> = new Map();

  // Current spray targets for rendering
  private sprayTargets: SprayTarget[] = [];

  // Audio events from last state update
  private pendingAudioEvents: NetworkServerSnapshot['audioEvents'] = [];

  // Game over state
  private gameOverWinnerId: PlayerId | null = null;

  // Current tick from host
  private currentTick: number = 0;

  // Selection state (synced from main view)
  private selectedIds: Set<EntityId> = new Set();

  // Reusable Set for snapshot diffing (avoids new Set() per snapshot)
  private _serverIds: Set<EntityId> = new Set();

  // Spatial grid debug visualization data
  private gridCells: NetworkServerSnapshotGridCell[] = [];
  private gridSearchCells: NetworkServerSnapshotGridCell[] = [];
  private gridCellSize: number = 0;

  // Combat stats from latest snapshot
  private combatStats: NetworkServerSnapshotCombatStats | null = null;

  // Server metadata from latest snapshot
  private serverMeta: NetworkServerSnapshotMeta | null = null;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cache = new EntityCacheManager();

  // Frame counter for beam path throttling (recompute every N frames instead of every frame)
  private frameCounter: number = 0;

  constructor() {}

  private invalidateCaches(): void {
    this.cache.invalidate();
  }

  private rebuildCachesIfNeeded(): void {
    this.cache.rebuildIfNeeded(this.entities);
  }

  /**
   * Apply received network state — store server targets, snap non-visual state.
   * Visual blending toward these targets happens in applyPrediction() each frame.
   */
  applyNetworkState(state: NetworkServerSnapshot): void {
    this.currentTick = state.tick;

    // Process entity updates (present in both delta and keyframe snapshots)
    for (const netEntity of state.entities) {
      // Copy drift-relevant fields into owned ServerTarget (avoids holding pooled object refs)
      let target = this.serverTargets.get(netEntity.id);
      if (!target) {
        target = createServerTarget();
        this.serverTargets.set(netEntity.id, target);
      }
      const cf = netEntity.changedFields;
      const isFull = cf === undefined;
      if (isFull || (cf! & ENTITY_CHANGED_POS)) {
        target.x = netEntity.pos.x;
        target.y = netEntity.pos.y;
      }
      if (isFull || (cf! & ENTITY_CHANGED_ROT)) {
        target.rotation = netEntity.rotation;
      }
      if (isFull || (cf! & ENTITY_CHANGED_VEL)) {
        target.velocityX = netEntity.unit?.velocity.x ?? 0;
        target.velocityY = netEntity.unit?.velocity.y ?? 0;
      }
      if (isFull || (cf! & ENTITY_CHANGED_TURRETS)) {
        const nw = netEntity.unit?.turrets;
        if (nw) {
          while (target.turrets.length < nw.length) {
            target.turrets.push({
              rotation: 0,
              angularVelocity: 0,
              forceFieldRange: undefined,
            });
          }
          target.turrets.length = nw.length;
          for (let i = 0; i < nw.length; i++) {
            target.turrets[i].rotation = nw[i].turret.angular.rot;
            target.turrets[i].angularVelocity = nw[i].turret.angular.vel;
            target.turrets[i].forceFieldRange =
              nw[i].currentForceFieldRange;
          }
        } else if (isFull) {
          target.turrets.length = 0;
        }
      }

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

    if (state.isDelta) {
      // Delta snapshot: only remove entities explicitly listed in removedEntityIds
      if (state.removedEntityIds) {
        for (const id of state.removedEntityIds) {
          this.entities.delete(id);
          this.serverTargets.delete(id);
          this.selectedIds.delete(id);
        }
      }
    } else {
      // Full keyframe: remove non-projectile entities not present in the snapshot
      this._serverIds.clear();
      for (const netEntity of state.entities) {
        this._serverIds.add(netEntity.id);
      }
      for (const [id, entity] of this.entities) {
        if (entity.type === 'shot') continue;
        if (!this._serverIds.has(id)) {
          this.entities.delete(id);
          this.serverTargets.delete(id);
          this.selectedIds.delete(id);
        }
      }
    }

    // Process projectile spawn events
    if (state.projectiles?.spawns) {
      for (const spawn of state.projectiles.spawns) {
        try {
          const entity = this.createProjectileFromSpawn(spawn);
          this.entities.set(spawn.id, entity);
        } catch {
          // Skip projectiles with unknown weapon configs (e.g. corrupted by serialization)
        }
      }
    }

    // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
    if (state.projectiles?.despawns) {
      for (const despawn of state.projectiles.despawns) {
        this.entities.delete(despawn.id);
        this.serverTargets.delete(despawn.id);
      }
    }

    // Process projectile velocity updates (force field pull deflection)
    // Snap position to server's authoritative value to correct dead-reckoning drift
    if (state.projectiles?.velocityUpdates) {
      for (const vu of state.projectiles.velocityUpdates) {
        const entity = this.entities.get(vu.id);
        if (entity?.projectile) {
          entity.transform.x = vu.pos.x;
          entity.transform.y = vu.pos.y;
          entity.projectile.velocityX = vu.velocity.x;
          entity.projectile.velocityY = vu.velocity.y;
          entity.transform.rotation = Math.atan2(vu.velocity.y, vu.velocity.x);
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
          source: { id: st.source.id, pos: st.source.pos, playerId: st.source.playerId },
          target: { id: st.target.id, pos: st.target.pos, dim: st.target.dim, radius: st.target.radius },
          type: st.type,
          intensity: st.intensity,
        };
      }
    } else {
      this.sprayTargets.length = 0;
    }

    // Store audio events for processing (reuse constant for empty case)
    this.pendingAudioEvents = state.audioEvents ?? EMPTY_AUDIO;

    // Check game over
    if (state.gameState?.phase === 'gameOver' && state.gameState.winnerId !== undefined) {
      this.gameOverWinnerId = state.gameState.winnerId;
    }

    // Store spatial grid debug data
    this.gridCells = state.grid?.cells ?? [];
    this.gridSearchCells = state.grid?.searchCells ?? [];
    this.gridCellSize = state.grid?.cellSize ?? 0;

    // Store combat stats
    if (state.combatStats) {
      this.combatStats = state.combatStats;
    }

    // Store server metadata
    if (state.serverMeta) {
      this.serverMeta = state.serverMeta;
    }
  }

  /**
   * Snap non-visual state (hp, actions, targeting, building/factory fields).
   * These don't need smooth blending — they should reflect server truth immediately.
   */
  private snapNonVisualState(entity: Entity, server: NetworkServerSnapshotEntity): void {
    const cf = server.changedFields;
    const isFull = cf === undefined;
    const su = server.unit;
    if (entity.unit && su) {
      if (isFull || (cf! & ENTITY_CHANGED_HP)) {
        entity.unit.hp = su.hp.curr;
        entity.unit.maxHp = su.hp.max;
      }
      // Static fields only present on keyframes
      if (isFull) {
        entity.unit.drawScale = su.drawScale;
        entity.unit.radiusColliderUnitShot = su.collider.unitShot;
        entity.unit.radiusColliderUnitUnit = su.collider.unitUnit;
        entity.unit.moveSpeed = su.moveSpeed;
      }

      if ((isFull || (cf! & ENTITY_CHANGED_ACTIONS)) && su.actions) {
        const src = su.actions;
        const actions = entity.unit.actions;
        actions.length = 0;
        for (let i = 0; i < src.length; i++) {
          const na = src[i];
          if (!na.pos) continue;
          actions.push({
            type: na.type as 'move' | 'patrol' | 'fight' | 'build' | 'repair' | 'attack',
            x: na.pos.x,
            y: na.pos.y,
            targetId: na.targetId,
            buildingType: na.buildingType as BuildingType | undefined,
            gridX: na.grid?.x,
            gridY: na.grid?.y,
            buildingId: na.buildingId,
          });
        }
      }

      // Snap turret targeting state (turret rotation/velocity blended in applyPrediction)
      if ((isFull || (cf! & ENTITY_CHANGED_TURRETS)) && su.turrets && su.turrets.length > 0 && entity.turrets) {
        for (
          let i = 0;
          i < su.turrets.length && i < entity.turrets.length;
          i++
        ) {
          entity.turrets[i].target = su.turrets[i].targetId ?? null;
          entity.turrets[i].state = su.turrets[i].state;
          // forceField.range is NOT snapped — dead-reckoned + drifted in applyPrediction()
        }
      }

      if (entity.builder && su.buildTargetId !== undefined) {
        entity.builder.currentBuildTarget = su.buildTargetId;
      }
    }

    const sb = server.building;
    if (entity.building && sb && (isFull || (cf! & ENTITY_CHANGED_HP))) {
      entity.building.hp = sb.hp.curr;
      entity.building.maxHp = sb.hp.max;
    }

    if (entity.buildable && sb && (isFull || (cf! & ENTITY_CHANGED_BUILDING))) {
      entity.buildable.buildProgress = sb.build.progress;
      entity.buildable.isComplete = sb.build.complete;
    }

    const sf = sb?.factory;
    if (entity.factory && sf && (isFull || (cf! & ENTITY_CHANGED_FACTORY))) {
      entity.factory.buildQueue = sf.queue;
      entity.factory.currentBuildProgress = sf.progress;
      entity.factory.isProducing = sf.producing;
      // waypoints[0] = rally point, rest = user-set waypoints
      const wps = sf.waypoints;
      if (wps.length > 0) {
        entity.factory.rallyX = wps[0].pos.x;
        entity.factory.rallyY = wps[0].pos.y;
      }
      entity.factory.waypoints.length = Math.max(0, wps.length - 1);
      for (let i = 1; i < wps.length; i++) {
        entity.factory.waypoints[i - 1] = {
          x: wps[i].pos.x,
          y: wps[i].pos.y,
          type: wps[i].type as 'move' | 'fight' | 'patrol',
        };
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
    this.frameCounter++;

    // Ensure caches are fresh for beam obstruction checks
    this.rebuildCachesIfNeeded();

    // Frame-rate independent blend factors (driven by drift mode setting)
    const preset = DRIFT_PRESETS[getDriftMode()];
    const posDrift = 1 - Math.pow(1 - preset.position, dt * 60);
    const velDrift = 1 - Math.pow(1 - preset.velocity, dt * 60);
    const rotDrift = 1 - Math.pow(1 - preset.rotation, dt * 60);

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
          entity.transform.rotation = lerpAngle(
            entity.transform.rotation,
            target.rotation,
            rotDrift,
          );

          const serverVelX = target.velocityX ?? 0;
          const serverVelY = target.velocityY ?? 0;
          entity.unit.velocityX = lerp(vx, serverVelX, velDrift);
          entity.unit.velocityY = lerp(vy, serverVelY, velDrift);
        }

        // Advance turret rotations using angular velocity + drift toward server
        if (entity.turrets) {
          for (let i = 0; i < entity.turrets.length; i++) {
            const weapon = entity.turrets[i];
            weapon.rotation += weapon.angularVelocity * dt;

            // Drift turret toward server target
            const tw = target?.turrets?.[i];
            if (tw) {
              weapon.rotation = lerpAngle(
                weapon.rotation,
                tw.rotation,
                rotDrift,
              );
              weapon.angularVelocity = lerp(
                weapon.angularVelocity,
                tw.angularVelocity,
                velDrift,
              );
            }

            // Dead-reckon force field expansion/contraction + drift toward server
            if (weapon.config.shot.type === 'force') {
              const fieldShot = weapon.config.shot;
              const cur = weapon.forceField?.range ?? 0;
              const targetProgress = weapon.state === 'engaged' ? 1 : 0;
              const progressDelta =
                dt / (fieldShot.transitionTime / 1000);
              let next = cur;
              if (cur < targetProgress) {
                next = Math.min(cur + progressDelta, 1);
              } else if (cur > targetProgress) {
                next = Math.max(cur - progressDelta, 0);
              }
              // Drift toward server's authoritative value
              const serverRange = tw?.forceFieldRange;
              if (serverRange !== undefined) {
                next = lerp(next, serverRange, rotDrift);
              }
              if (!weapon.forceField) {
                weapon.forceField = { range: next, transition: 0 };
              } else {
                weapon.forceField.range = next;
              }
            }
          }
        }
      }

      if (entity.type === 'shot' && entity.projectile) {
        if (entity.projectile.projectileType === 'beam' || entity.projectile.projectileType === 'laser') {
          // Beams: reconstruct from source unit's current position + turret rotation
          // Beam existence is driven by the weapon's state (updated every snapshot),
          // so lost despawn events self-correct on the next snapshot.
          const weaponIndex = entity.projectile.config.turretIndex ?? 0;
          const source = this.entities.get(entity.projectile.sourceEntityId);
          const weapon = source?.turrets?.[weaponIndex];

          if (source && weapon && weapon.state === 'engaged') {
            const turretAngle = weapon.rotation;
            const dirX = Math.cos(turretAngle);
            const dirY = Math.sin(turretAngle);

            // Calculate weapon position in world coordinates (same math as sim)
            const unitCos = Math.cos(source.transform.rotation);
            const unitSin = Math.sin(source.transform.rotation);
            const wp = getWeaponWorldPosition(
              source.transform.x,
              source.transform.y,
              unitCos,
              unitSin,
              weapon.offset.x,
              weapon.offset.y,
            );

            // Beam starts at barrel tip
            const bt = getBarrelTipWorldPos(
              wp.x,
              wp.y,
              turretAngle,
              entity.projectile.config,
              source.unit!.drawScale,
            );
            const startX = bt.x;
            const startY = bt.y;

            // Full-range beam end
            const fullEndX = startX + dirX * weapon.ranges.engage.acquire;
            const fullEndY = startY + dirY * weapon.ranges.engage.acquire;

            entity.projectile.startX = startX;
            entity.projectile.startY = startY;
            entity.transform.x = startX;
            entity.transform.y = startY;
            entity.transform.rotation = turretAngle;

            // Throttle beam path recomputation (client has no spatial grid — full O(N) scan)
            const beamSkip = getGraphicsConfig().beamPathFramesSkip;
            if (entity.projectile.endX === undefined || beamSkip === 0 || this.frameCounter % (beamSkip + 1) === 0) {
              const beamPath = this.findBeamPath(
                startX, startY,
                fullEndX, fullEndY,
                entity.projectile.sourceEntityId,
              );
              entity.projectile.endX = beamPath.endX;
              entity.projectile.endY = beamPath.endY;
              entity.projectile.obstructionT = beamPath.obstructionT;
              entity.projectile.reflections = beamPath.reflections.length > 0 ? beamPath.reflections : undefined;
            }
          } else {
            // Source unit gone or weapon stopped firing — remove beam
            this.entities.delete(entity.id);
            this.serverTargets.delete(entity.id);
          }
        } else {
          // Homing steering: turn velocity toward target (same math as server)
          const proj = entity.projectile;
          if (proj.homingTargetId !== undefined) {
            const homingTarget = this.entities.get(proj.homingTargetId);
            if (
              homingTarget &&
              ((homingTarget.unit && homingTarget.unit.hp > 0) ||
                (homingTarget.building && homingTarget.building.hp > 0))
            ) {
              const steered = applyHomingSteering(
                proj.velocityX,
                proj.velocityY,
                homingTarget.transform.x,
                homingTarget.transform.y,
                entity.transform.x,
                entity.transform.y,
                proj.homingTurnRate ?? 0,
                dt,
              );
              proj.velocityX = steered.velocityX;
              proj.velocityY = steered.velocityY;
              entity.transform.rotation = steered.rotation;
            } else {
              proj.homingTargetId = undefined;
            }
          }

          // Traveling projectiles: dead-reckon using (possibly steered) velocity
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
  private createProjectileFromSpawn(spawn: NetworkServerSnapshotProjectileSpawn): Entity {
    const config = {
      ...getTurretConfig(spawn.turretId),
      turretIndex: spawn.turretIndex,
    };

    // Default to server position; override with client-side muzzle if source is available
    let spawnX = spawn.pos.x;
    let spawnY = spawn.pos.y;

    if (spawn.projectileType !== 'beam') {
      const source = this.entities.get(spawn.sourceEntityId);
      const weapon = source?.turrets?.[spawn.turretIndex];
      if (source && source.unit && weapon) {
        const unitCos = Math.cos(source.transform.rotation);
        const unitSin = Math.sin(source.transform.rotation);
        const wp = getWeaponWorldPosition(
          source.transform.x,
          source.transform.y,
          unitCos,
          unitSin,
          weapon.offset.x,
          weapon.offset.y,
        );

        // Forward from weapon in firing direction (same as server)
        const turretAngle = weapon.rotation;
        const projBt = getBarrelTipWorldPos(
          wp.x,
          wp.y,
          turretAngle,
          config,
          source.unit.drawScale,
        );
        spawnX = projBt.x;
        spawnY = projBt.y;
      }
    }

    const entity: Entity = {
      id: spawn.id,
      type: 'shot',
      transform: { x: spawnX, y: spawnY, rotation: spawn.rotation },
      ownership: { playerId: spawn.playerId },
      projectile: {
        ownerId: spawn.playerId,
        sourceEntityId: spawn.sourceEntityId,
        config,
        projectileType: spawn.projectileType as 'projectile' | 'beam' | 'laser',
        velocityX: spawn.velocity.x,
        velocityY: spawn.velocity.y,
        timeAlive: 0,
        maxLifespan: config.shot.type === 'beam'
          ? Infinity
          : config.shot.type === 'laser'
            ? config.shot.duration
            : (config.shot.type === 'projectile' ? (config.shot.lifespan ?? 2000) : 2000),
        hitEntities: new Set(),
        maxHits: 1,
        startX: spawn.beam?.start.x,
        startY: spawn.beam?.start.y,
        endX: spawn.beam?.end.x,
        endY: spawn.beam?.end.y,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = { isDGun: true };
    }
    // Store homing properties so client can predict curved trajectories
    if (spawn.targetEntityId !== undefined && spawn.homingTurnRate) {
      entity.projectile!.homingTargetId = spawn.targetEntityId;
      entity.projectile!.homingTurnRate = spawn.homingTurnRate;
    }
    return entity;
  }

  // === Beam obstruction detection ===

  /**
   * Trace a beam path with reflections off mirror units.
   * Mirror collision uses ray-vs-line-segment (flat mirror surface), not circle colliders.
   * Client-side equivalent of DamageSystem.findBeamPath().
   */
  private findBeamPath(
    startX: number, startY: number,
    endX: number, endY: number,
    sourceId: number,
    maxBounces: number = 3,
  ): {
    endX: number; endY: number;
    obstructionT?: number;
    reflections: { x: number; y: number; mirrorEntityId: number }[];
  } {
    const reflections: { x: number; y: number; mirrorEntityId: number }[] = [];
    let curSX = startX, curSY = startY;
    let curEX = endX, curEY = endY;
    let excludeId = sourceId;
    let excludePanelIndex = -1; // -1 = exclude entire entity (source), >= 0 = exclude only that panel

    for (let bounce = 0; bounce <= maxBounces; bounce++) {
      const hit = this.findBeamSegmentHit(curSX, curSY, curEX, curEY, excludeId, excludePanelIndex);

      if (!hit) {
        return { endX: curEX, endY: curEY, reflections };
      }

      if (!hit.isMirror) {
        if (bounce === 0) return { endX: hit.x, endY: hit.y, obstructionT: hit.t, reflections };
        return { endX: hit.x, endY: hit.y, reflections };
      }

      // Mirror reflection
      reflections.push({ x: hit.x, y: hit.y, mirrorEntityId: hit.entityId });

      const segDx = curEX - curSX, segDy = curEY - curSY;
      const segLen = magnitude(segDx, segDy);
      if (segLen === 0) break;
      const beamDirX = segDx / segLen, beamDirY = segDy / segLen;

      const dotDN = beamDirX * hit.normalX + beamDirY * hit.normalY;
      const reflDirX = beamDirX - 2 * dotDN * hit.normalX;
      const reflDirY = beamDirY - 2 * dotDN * hit.normalY;
      const remaining = segLen * (1 - hit.t);

      curSX = hit.x; curSY = hit.y;
      curEX = hit.x + reflDirX * remaining;
      curEY = hit.y + reflDirY * remaining;
      excludeId = hit.entityId;
      excludePanelIndex = hit.panelIndex; // only exclude the panel we just bounced off
    }

    return { endX: curEX, endY: curEY, reflections };
  }

  /** Find closest beam hit — checks mirror line segments AND regular entity colliders
   *  excludeId: on bounce 0 = source (don't hit self), on bounce N = last mirror hit
   *  excludePanelIndex: -1 = exclude entire entity, >= 0 = exclude only that panel */
  private findBeamSegmentHit(
    sx: number, sy: number, ex: number, ey: number,
    excludeId: number, excludePanelIndex: number,
  ): typeof _segHit | null {
    let bestT = Infinity;
    let found = false;
    const dx = ex - sx, dy = ey - sy;
    const segLenSq = dx * dx + dy * dy;

    for (const unit of this.cache.getUnits()) {
      // Panel-level exclude: if excludePanelIndex >= 0, only skip the specific panel (not the whole entity)
      const isExcludedEntity = unit.id === excludeId;
      if (isExcludedEntity && excludePanelIndex < 0) continue; // full entity exclude (source unit)
      if (!unit.unit || unit.unit.hp <= 0) continue;

      // Early-out: point-to-line distance check (avoids expensive per-unit math for distant units)
      const ux = unit.transform.x - sx, uy = unit.transform.y - sy;
      const crossSq = (ux * dy - uy * dx);
      const panels = unit.unit.mirrorPanels;
      const boundR = panels.length > 0
        ? Math.max(unit.unit.mirrorBoundRadius, unit.unit.radiusColliderUnitShot)
        : unit.unit.radiusColliderUnitShot;
      if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

      if (panels.length > 0) {
        // Mirror unit: test ray vs outer edge of each rectangular panel
        let mirrorRot = unit.transform.rotation;
        if (unit.turrets && unit.turrets.length > 0) {
          mirrorRot = unit.turrets[0].rotation;
        }
        const fwdX = Math.cos(mirrorRot), fwdY = Math.sin(mirrorRot);
        const perpX = -fwdY, perpY = fwdX;

        for (let pi = 0; pi < panels.length; pi++) {
          // Skip only the specific panel we just bounced off
          if (isExcludedEntity && pi === excludePanelIndex) continue;

          const panel = panels[pi];
          const pcx = unit.transform.x + fwdX * panel.offsetX + perpX * panel.offsetY;
          const pcy = unit.transform.y + fwdY * panel.offsetX + perpY * panel.offsetY;

          const panelAngle = mirrorRot + panel.angle;
          const pnx = Math.cos(panelAngle);
          const pny = Math.sin(panelAngle);

          const edx = -pny;
          const edy = pnx;

          const e1x = pcx + edx * panel.halfWidth;
          const e1y = pcy + edy * panel.halfWidth;
          const e2x = pcx - edx * panel.halfWidth;
          const e2y = pcy - edy * panel.halfWidth;

          const faceHit = raySegmentIntersection(sx, sy, ex, ey, e1x, e1y, e2x, e2y);
          if (faceHit && faceHit.t < bestT) {
            bestT = faceHit.t; found = true;
            _segHit.t = faceHit.t; _segHit.x = faceHit.x; _segHit.y = faceHit.y;
            _segHit.entityId = unit.id; _segHit.isMirror = true; _segHit.normalX = pnx; _segHit.normalY = pny;
            _segHit.panelIndex = pi;
          }
        }
      }

      // Circle collision — all units (mirror units can be hit on their body too)
      {
        const r = unit.unit.radiusColliderUnitShot;
        const t = lineCircleIntersectionT(sx, sy, ex, ey, unit.transform.x, unit.transform.y, r);
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          _segHit.t = t; _segHit.x = sx + t * dx; _segHit.y = sy + t * dy;
          _segHit.entityId = unit.id; _segHit.isMirror = false; _segHit.normalX = 0; _segHit.normalY = 0;
          _segHit.panelIndex = -1;
        }
      }
    }

    // Buildings: AABB slab method
    for (const bldg of this.cache.getBuildings()) {
      if (bldg.id === excludeId) continue;
      if (!bldg.building) continue;
      const hw = bldg.building.width / 2, hh = bldg.building.height / 2;
      const bx = bldg.transform.x, by = bldg.transform.y;
      let tmin = 0, tmax = 1;
      if (Math.abs(dx) > 0.0001) {
        let t1 = (bx - hw - sx) / dx, t2 = (bx + hw - sx) / dx;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      } else if (sx < bx - hw || sx > bx + hw) continue;
      if (Math.abs(dy) > 0.0001) {
        let t1 = (by - hh - sy) / dy, t2 = (by + hh - sy) / dy;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      } else if (sy < by - hh || sy > by + hh) continue;
      if (tmin <= tmax && tmax > 0) {
        const t = Math.max(tmin, 0);
        if (t < bestT) {
          bestT = t; found = true;
          _segHit.t = t; _segHit.x = sx + t * dx; _segHit.y = sy + t * dy;
          _segHit.entityId = bldg.id; _segHit.isMirror = false; _segHit.normalX = 0; _segHit.normalY = 0;
        }
      }
    }

    return found ? _segHit : null;
  }

  // === Accessors for rendering and input ===

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getAll();
  }

  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnits();
  }

  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildings();
  }

  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getProjectiles();
  }

  getSprayTargets(): SprayTarget[] {
    return this.sprayTargets;
  }

  getPendingAudioEvents(): NetworkServerSnapshot['audioEvents'] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = EMPTY_AUDIO;
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
      if (playerId !== undefined && entity.ownership?.playerId !== playerId)
        continue;

      const drawScale = entity.unit?.drawScale ?? 15;
      const dx = entity.transform.x - x;
      const dy = entity.transform.y - y;
      if (dx * dx + dy * dy <= drawScale * drawScale) {
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
      if (
        x >= entity.transform.x - hw &&
        x <= entity.transform.x + hw &&
        y >= entity.transform.y - hh &&
        y <= entity.transform.y + hh
      ) {
        return entity;
      }
    }
    return null;
  }

  findEntitiesInRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    playerId?: PlayerId,
  ): Entity[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const results: Entity[] = [];

    for (const entity of this.getUnits()) {
      if (playerId !== undefined && entity.ownership?.playerId !== playerId)
        continue;

      if (
        entity.transform.x >= minX &&
        entity.transform.x <= maxX &&
        entity.transform.y >= minY &&
        entity.transform.y <= maxY
      ) {
        results.push(entity);
      }
    }

    return results;
  }

  // === Spatial grid debug data ===

  getGridCells(): NetworkServerSnapshotGridCell[] {
    return this.gridCells;
  }

  getGridSearchCells(): NetworkServerSnapshotGridCell[] {
    return this.gridSearchCells;
  }

  getGridCellSize(): number {
    return this.gridCellSize;
  }

  getCombatStats(): NetworkServerSnapshotCombatStats | null {
    return this.combatStats;
  }

  getServerMeta(): NetworkServerSnapshotMeta | null {
    return this.serverMeta;
  }

  clear(): void {
    this.entities.clear();
    this.serverTargets.clear();
    this.sprayTargets = [];
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.gameOverWinnerId = null;
    this.selectedIds.clear();
    this.gridCells = [];
    this.gridSearchCells = [];
    this.gridCellSize = 0;
    this.serverMeta = null;
    this.frameCounter = 0;
    this.invalidateCaches();
  }
}
