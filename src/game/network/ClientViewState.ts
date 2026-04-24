/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: dead-reckon using velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId, BuildingType, ForceShot } from '../sim/types';
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
import { getBarrelTipOffset, getBarrelTipWorldPos, getUnitMuzzleHeight } from '../sim/combat/combatUtils';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_FACTORY,
} from '../../types/network';

import { findBeamPath } from './BeamPathResolver';
import {
  lerp,
  lerpAngle,
  getWeaponWorldPosition,
  applyHomingSteering,
} from '../math';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER, GRAVITY } from '../../config';
import { EntityCacheManager } from '../sim/EntityCacheManager';

/** Frame-rate independent EMA blend factor from a half-life (seconds).
 *  halfLife=0 → instant snap (returns 1). */
function halfLifeBlend(dt: number, halfLife: number): number {
  return halfLife <= 0 ? 1 : 1 - Math.pow(0.5, dt / halfLife);
}

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];

// Gravity imported from config.ts — single value shared with server
// sim and every other falling-thing system.

// Reusable buffer for client-side force field prediction (avoids allocations per frame)
type ActiveForceField = {
  weaponX: number;
  weaponY: number;
  turretAngle: number;
  playerId: PlayerId;
  shot: ForceShot;
  progress: number;
};
const _forceFields: ActiveForceField[] = [];
const _ffZones = { pushInner: 0, pushOuter: 0 };

function getClientForceFieldZones(shot: ForceShot, progress: number) {
  const push = shot.push;
  if (push && push.power != null) {
    _ffZones.pushInner = push.outerRange - (push.outerRange - push.innerRange) * progress;
    _ffZones.pushOuter = push.outerRange;
  } else {
    _ffZones.pushInner = 0;
    _ffZones.pushOuter = 0;
  }
  return _ffZones;
}

// Drift half-lives (seconds). How long to close 50% of the gap to the server value.
// Smaller = snappier correction, larger = smoother/lazier.
// Blend factor per frame: 1 - Math.pow(0.5, dt / halfLife)
import { getDriftMode, getGraphicsConfig } from '@/clientBarConfig';
import type { DriftMode } from '@/types/client';

type DriftAxis = { pos: number; vel: number };
type DriftPreset = { movement: DriftAxis; rotation: DriftAxis };

const DRIFT_PRESETS: Record<DriftMode, DriftPreset> = {
  snap: { movement: { pos: 0, vel: 0 }, rotation: { pos: 0, vel: 0 } },
  fast: {
    movement: { pos: 0.071, vel: 0.040 },
    rotation: { pos: 0.071, vel: 0.040 },
  },
  mid: {
    movement: { pos: 0.849, vel: 0.417 },
    rotation: { pos: 0.849, vel: 0.417 },
  },
  slow: {
    movement: { pos: 4, vel: 2 },
    rotation: { pos: 4, vel: 2 },
  },
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
    pitch: number;
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

  // Capture tile data — Map for delta merge, array cache for rendering
  private captureTileMap: Map<number, import('@/types/capture').NetworkCaptureTile> = new Map();
  private captureTilesCache: import('@/types/capture').NetworkCaptureTile[] = [];
  private captureTilesDirty: boolean = true;
  private captureCellSize: number = 0;

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
      if (isFull || cf! & ENTITY_CHANGED_POS) {
        target.x = netEntity.pos.x;
        target.y = netEntity.pos.y;
      }
      if (isFull || cf! & ENTITY_CHANGED_ROT) {
        target.rotation = netEntity.rotation;
      }
      if (isFull || cf! & ENTITY_CHANGED_VEL) {
        target.velocityX = netEntity.unit?.velocity.x ?? 0;
        target.velocityY = netEntity.unit?.velocity.y ?? 0;
      }
      if (isFull || cf! & ENTITY_CHANGED_TURRETS) {
        const nw = netEntity.unit?.turrets;
        if (nw) {
          while (target.turrets.length < nw.length) {
            target.turrets.push({
              rotation: 0,
              angularVelocity: 0,
              pitch: 0,
              forceFieldRange: undefined,
            });
          }
          target.turrets.length = nw.length;
          for (let i = 0; i < nw.length; i++) {
            target.turrets[i].rotation = nw[i].turret.angular.rot;
            target.turrets[i].angularVelocity = nw[i].turret.angular.vel;
            target.turrets[i].pitch = nw[i].turret.angular.pitch;
            target.turrets[i].forceFieldRange = nw[i].currentForceFieldRange;
          }
        } else if (isFull) {
          target.turrets.length = 0;
        }
      }

      const existing = this.entities.get(netEntity.id);

      if (!existing) {
        // Only create entities from full data (keyframes or new-entity entries).
        // Delta snapshots with changedFields set may be missing unit type, HP, etc.
        // The entity will be created on the next keyframe.
        if (netEntity.changedFields !== undefined) continue;

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

    // Process projectile velocity updates (force field deflection / homing correction)
    // Store as drift targets — client-side prediction should already be close
    if (state.projectiles?.velocityUpdates) {
      for (const vu of state.projectiles.velocityUpdates) {
        const entity = this.entities.get(vu.id);
        if (entity?.projectile) {
          let target = this.serverTargets.get(vu.id);
          if (!target) {
            target = createServerTarget();
            this.serverTargets.set(vu.id, target);
          }
          target.x = vu.pos.x;
          target.y = vu.pos.y;
          target.velocityX = vu.velocity.x;
          target.velocityY = vu.velocity.y;
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
          source: {
            id: st.source.id,
            pos: st.source.pos,
            playerId: st.source.playerId,
          },
          target: {
            id: st.target.id,
            pos: st.target.pos,
            dim: st.target.dim,
            radius: st.target.radius,
          },
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
    if (
      state.gameState?.phase === 'gameOver' &&
      state.gameState.winnerId !== undefined
    ) {
      this.gameOverWinnerId = state.gameState.winnerId;
    }

    // Store spatial grid debug data
    this.gridCells = state.grid?.cells ?? [];
    this.gridSearchCells = state.grid?.searchCells ?? [];
    this.gridCellSize = state.grid?.cellSize ?? 0;

    // Merge capture tile data (delta-aware)
    if (state.capture) {
      this.captureCellSize = state.capture.cellSize;
      if (!state.isDelta) {
        // Keyframe: replace all
        this.captureTileMap.clear();
      }
      for (const tile of state.capture.tiles) {
        const key = ((tile.cx + 32768) & 0xFFFF) << 16 | ((tile.cy + 32768) & 0xFFFF);
        if (Object.keys(tile.heights).length === 0) {
          this.captureTileMap.delete(key);
        } else {
          // Copy heights — tile objects may be pooled/reused by the server
          this.captureTileMap.set(key, { cx: tile.cx, cy: tile.cy, heights: { ...tile.heights } });
        }
      }
      this.captureTilesDirty = true;
    } else if (!state.isDelta) {
      // Keyframe with no capture data: clear
      this.captureTileMap.clear();
      this.captureTilesDirty = true;
    }

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
  private snapNonVisualState(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): void {
    const cf = server.changedFields;
    const isFull = cf === undefined;
    const su = server.unit;
    if (entity.unit && su) {
      if (isFull || cf! & ENTITY_CHANGED_HP) {
        entity.unit.hp = su.hp.curr;
        entity.unit.maxHp = su.hp.max;
      }
      // Static fields only present on keyframes
      if (isFull) {
        entity.unit.unitRadiusCollider.scale = su.collider.scale;
        entity.unit.unitRadiusCollider.shot = su.collider.shot;
        entity.unit.unitRadiusCollider.push = su.collider.push;
        entity.unit.moveSpeed = su.moveSpeed;
      }

      if ((isFull || cf! & ENTITY_CHANGED_ACTIONS) && su.actions) {
        const src = su.actions;
        const actions = entity.unit.actions;
        actions.length = 0;
        for (let i = 0; i < src.length; i++) {
          const na = src[i];
          if (!na.pos) continue;
          actions.push({
            type: na.type as
              | 'move'
              | 'patrol'
              | 'fight'
              | 'build'
              | 'repair'
              | 'attack',
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
      if (
        (isFull || cf! & ENTITY_CHANGED_TURRETS) &&
        su.turrets &&
        su.turrets.length > 0 &&
        entity.turrets
      ) {
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
    if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_HP)) {
      entity.building.hp = sb.hp.curr;
      entity.building.maxHp = sb.hp.max;
    }

    if (entity.buildable && sb && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
      entity.buildable.buildProgress = sb.build.progress;
      entity.buildable.isComplete = sb.build.complete;
    }

    const sf = sb?.factory;
    if (entity.factory && sf && (isFull || cf! & ENTITY_CHANGED_FACTORY)) {
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

    // Frame-rate independent blend factors (driven by drift mode half-lives)
    const preset = DRIFT_PRESETS[getDriftMode()];
    const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
    const movVelDrift = halfLifeBlend(dt, preset.movement.vel);
    const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);
    const rotVelDrift = halfLifeBlend(dt, preset.rotation.vel);

    // Collect active force fields for client-side projectile prediction (Gap 3)
    _forceFields.length = 0;

    for (const entity of this.entities.values()) {
      const target = this.serverTargets.get(entity.id);

      if (entity.type === 'unit' && entity.unit) {
        if (target) {
          // Advance server target using its velocity (so drift target isn't stale)
          target.x += target.velocityX * dt;
          target.y += target.velocityY * dt;
        }

        // Step 1: Dead-reckon entity using current velocity
        const vx = entity.unit.velocityX ?? 0;
        const vy = entity.unit.velocityY ?? 0;
        entity.transform.x += vx * dt;
        entity.transform.y += vy * dt;

        // Step 2: Drift toward server targets
        // Body rotation is set authoritatively by the server (facing command direction),
        // so the client only drifts toward the server target — no local dead-reckoning.
        if (target) {
          entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
          entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
          entity.transform.rotation = lerpAngle(
            entity.transform.rotation,
            target.rotation,
            rotPosDrift,
          );

          const serverVelX = target.velocityX ?? 0;
          const serverVelY = target.velocityY ?? 0;
          entity.unit.velocityX = lerp(vx, serverVelX, movVelDrift);
          entity.unit.velocityY = lerp(vy, serverVelY, movVelDrift);
        }

        // Advance turret rotations using angular velocity + drift toward server
        if (entity.turrets) {
          for (let i = 0; i < entity.turrets.length; i++) {
            const weapon = entity.turrets[i];
            weapon.rotation += weapon.angularVelocity * dt;

            // Drift turret toward server target
            const tw = target?.turrets?.[i];
            if (tw) {
              // Advance turret target rotation using its angular velocity
              tw.rotation += tw.angularVelocity * dt;

              weapon.rotation = lerpAngle(
                weapon.rotation,
                tw.rotation,
                rotPosDrift,
              );
              weapon.angularVelocity = lerp(
                weapon.angularVelocity,
                tw.angularVelocity,
                rotVelDrift,
              );
              // Pitch: the sim sets it each tick from the ballistic
              // solver, no angular velocity to dead-reckon — just drift
              // the current value toward the latest server target using
              // the same rotation-position blend. Without this the
              // visible barrel pitch stays frozen at whatever the turret
              // was at when the entity was first received, so shots
              // launch at their real arc while the barrel visibly
              // points horizontally (or wherever it was last snapped).
              weapon.pitch = lerpAngle(
                weapon.pitch,
                tw.pitch,
                rotPosDrift,
              );
            }

            // Dead-reckon force field expansion/contraction + drift toward server
            if (weapon.config.shot.type === 'force') {
              const fieldShot = weapon.config.shot;
              const cur = weapon.forceField?.range ?? 0;
              const targetProgress = weapon.state === 'engaged' ? 1 : 0;
              const progressDelta = dt / (fieldShot.transitionTime / 1000);
              let next = cur;
              if (cur < targetProgress) {
                next = Math.min(cur + progressDelta, 1);
              } else if (cur > targetProgress) {
                next = Math.max(cur - progressDelta, 0);
              }
              // Drift toward server's authoritative value
              const serverRange = tw?.forceFieldRange;
              if (serverRange !== undefined) {
                next = lerp(next, serverRange, rotPosDrift);
              }
              if (!weapon.forceField) {
                weapon.forceField = { range: next, transition: 0 };
              } else {
                weapon.forceField.range = next;
              }

              // Collect active force fields for projectile prediction
              if (next > 0 && entity.ownership) {
                const unitCos = Math.cos(entity.transform.rotation);
                const unitSin = Math.sin(entity.transform.rotation);
                _forceFields.push({
                  weaponX: entity.transform.x + unitCos * weapon.offset.x - unitSin * weapon.offset.y,
                  weaponY: entity.transform.y + unitSin * weapon.offset.x + unitCos * weapon.offset.y,
                  turretAngle: weapon.rotation,
                  playerId: entity.ownership.playerId,
                  shot: fieldShot,
                  progress: next,
                });
              }
            }
          }
        }
      }

      if (entity.type === 'shot' && entity.projectile) {
        if (
          entity.projectile.projectileType === 'beam' ||
          entity.projectile.projectileType === 'laser'
        ) {
          // Beams: reconstruct from source unit's current position + turret rotation
          // Beam existence is driven by the weapon's state (updated every snapshot),
          // so lost despawn events self-correct on the next snapshot.
          const weaponIndex = entity.projectile.config.turretIndex ?? 0;
          const source = this.entities.get(entity.projectile.sourceEntityId);
          const weapon = source?.turrets?.[weaponIndex];

          if (source && weapon && weapon.state === 'engaged') {
            // Full 3D beam: yaw + pitch → direction; start at barrel
            // tip (shortened by cos(pitch), raised by sin(pitch));
            // end at direction × beamLength. Same construction the
            // server uses in projectileSystem so predicted and
            // authoritative geometry agree.
            const turretAngle = weapon.rotation;
            const turretPitch = weapon.pitch;
            const pitchCos = Math.cos(turretPitch);
            const pitchSin = Math.sin(turretPitch);
            const yawCos = Math.cos(turretAngle);
            const yawSin = Math.sin(turretAngle);

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

            const barrelOffset = getBarrelTipOffset(
              entity.projectile.config,
              source.unit!.unitRadiusCollider.scale,
            );
            const horizBarrel = barrelOffset * pitchCos;
            const startX = wp.x + yawCos * horizBarrel;
            const startY = wp.y + yawSin * horizBarrel;
            const unitGroundZ = source.transform.z - source.unit!.unitRadiusCollider.push;
            const startZ = unitGroundZ + getUnitMuzzleHeight(source) + barrelOffset * pitchSin;

            const dir3X = yawCos * pitchCos;
            const dir3Y = yawSin * pitchCos;
            const dir3Z = pitchSin;
            const beamLength = weapon.ranges.engage.acquire;
            const fullEndX = startX + dir3X * beamLength;
            const fullEndY = startY + dir3Y * beamLength;
            const fullEndZ = startZ + dir3Z * beamLength;

            entity.projectile.startX = startX;
            entity.projectile.startY = startY;
            entity.projectile.startZ = startZ;
            entity.transform.x = startX;
            entity.transform.y = startY;
            entity.transform.z = startZ;
            entity.transform.rotation = turretAngle;

            // Throttle beam path recomputation (client has no spatial grid — full O(N) scan)
            const beamSkip = getGraphicsConfig().beamPathFramesSkip;
            if (
              entity.projectile.endX === undefined ||
              beamSkip === 0 ||
              this.frameCounter % (beamSkip + 1) === 0
            ) {
              const beamPath = findBeamPath(
                this.cache,
                startX, startY, startZ,
                fullEndX, fullEndY, fullEndZ,
                entity.projectile.sourceEntityId,
              );
              entity.projectile.endX = beamPath.endX;
              entity.projectile.endY = beamPath.endY;
              entity.projectile.endZ = beamPath.endZ;
              entity.projectile.obstructionT = beamPath.obstructionT;
              entity.projectile.reflections =
                beamPath.reflections.length > 0
                  ? beamPath.reflections
                  : undefined;
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

          // Client-side force field prediction: apply same deflection physics as server
          if (_forceFields.length > 0 && entity.ownership) {
            const projOwnerId = entity.ownership.playerId;
            const projRadius = proj.config.shot.type === 'projectile'
              ? proj.config.shot.collision.radius : 5;
            const projMass = (proj.config.shot.type === 'projectile'
              ? proj.config.shot.mass : 1) * PROJECTILE_MASS_MULTIPLIER;

            for (let fi = 0; fi < _forceFields.length; fi++) {
              const ff = _forceFields[fi];
              if (ff.playerId === projOwnerId) continue; // Only deflect enemy projectiles

              const zones = getClientForceFieldZones(ff.shot, ff.progress);
              if (zones.pushOuter <= 0) continue;

              const dx = entity.transform.x - ff.weaponX;
              const dy = entity.transform.y - ff.weaponY;
              const distSq = dx * dx + dy * dy;
              const maxDist = zones.pushOuter + projRadius;
              if (distSq > maxDist * maxDist) continue;

              const dist = Math.sqrt(distSq);
              if (zones.pushInner > 0 && dist + projRadius < zones.pushInner) continue;

              const pushPower = ff.shot.push?.power ?? 0;
              const pushAccel = (pushPower * KNOCKBACK.FORCE_FIELD_PULL_MULTIPLIER) / projMass;

              const dirX = dist > 0 ? dx / dist : 0;
              const dirY = dist > 0 ? dy / dist : 0;
              proj.velocityX += dirX * pushAccel * dt;  // push outward
              proj.velocityY += dirY * pushAccel * dt;
              entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
            }
          }

          // Drift projectile position + velocity toward server target
          // (smooth correction). Projectile targets don't carry z yet —
          // updating ServerTarget to Vec3 is a later pass; for now the
          // horizontal lerp smooths out network jitter, and z is
          // purely client-side (gravity-integrated from its fired vz).
          if (target) {
            target.x += target.velocityX * dt;
            target.y += target.velocityY * dt;

            entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
            entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
            proj.velocityX = lerp(proj.velocityX, target.velocityX, movVelDrift);
            proj.velocityY = lerp(proj.velocityY, target.velocityY, movVelDrift);
            entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
          }

          // Traveling projectiles: dead-reckon using (possibly steered)
          // velocity in full 3D. Gravity on vz mirrors the server so
          // mortar arcs and cannon shells fall between snapshots.
          entity.projectile.velocityZ -= GRAVITY * dt;
          entity.transform.x += entity.projectile.velocityX * dt;
          entity.transform.y += entity.projectile.velocityY * dt;
          entity.transform.z += entity.projectile.velocityZ * dt;
          // Don't let the visual sink through the ground — the server
          // will despawn-and-explode the projectile on its next tick,
          // but the client may run a few prediction frames ahead.
          // Clamping vz to 0 at the ground keeps the sphere pinned on
          // the surface for those frames instead of burrowing.
          if (entity.transform.z < 0) {
            entity.transform.z = 0;
            if (entity.projectile.velocityZ < 0) entity.projectile.velocityZ = 0;
          }

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
  private createProjectileFromSpawn(
    spawn: NetworkServerSnapshotProjectileSpawn,
  ): Entity {
    const config = {
      ...getTurretConfig(spawn.turretId),
      turretIndex: spawn.turretIndex,
    };

    // Default to server position; override with client-side muzzle if source is available
    let spawnX = spawn.pos.x;
    let spawnY = spawn.pos.y;
    // z always comes from the server — M9's wire carries it. Beam
    // endpoints (beam.start.z / end.z) also come across the wire, so
    // lasers/beams render at their real altitude too.
    const spawnZ = spawn.pos.z;

    // Submunitions / any projectile that came from a parent detonation
    // must spawn at the explosion point (carried on the wire in
    // `spawn.pos`), NOT at the original shooter's barrel. Without this
    // guard the cluster-flak children would snap to the shooter's
    // turret muzzle even though the server spawned them at the parent
    // shell's detonation.
    if (spawn.projectileType !== 'beam' && !spawn.fromParentDetonation) {
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
          source.unit.unitRadiusCollider.scale,
        );
        spawnX = projBt.x;
        spawnY = projBt.y;
      }
    }

    const entity: Entity = {
      id: spawn.id,
      type: 'shot',
      transform: { x: spawnX, y: spawnY, z: spawnZ, rotation: spawn.rotation },
      ownership: { playerId: spawn.playerId },
      projectile: {
        ownerId: spawn.playerId,
        sourceEntityId: spawn.sourceEntityId,
        config,
        projectileType: spawn.projectileType as 'projectile' | 'beam' | 'laser',
        velocityX: spawn.velocity.x,
        velocityY: spawn.velocity.y,
        velocityZ: spawn.velocity.z,
        timeAlive: 0,
        maxLifespan:
          config.shot.type === 'beam'
            ? Infinity
            : config.shot.type === 'laser'
              ? config.shot.duration
              : config.shot.type === 'projectile'
                ? (config.shot.lifespan ?? 2000)
                : 2000,
        hitEntities: new Set(),
        maxHits: 1,
        startX: spawn.beam?.start.x,
        startY: spawn.beam?.start.y,
        startZ: spawn.beam?.start.z,
        endX: spawn.beam?.end.x,
        endY: spawn.beam?.end.y,
        endZ: spawn.beam?.end.z,
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

      const radius = entity.unit?.unitRadiusCollider.scale ?? 15;
      const dx = entity.transform.x - x;
      const dy = entity.transform.y - y;
      if (dx * dx + dy * dy <= radius * radius) {
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

  // === Capture tile data ===

  getCaptureTiles(): import('@/types/capture').NetworkCaptureTile[] {
    if (this.captureTilesDirty) {
      this.captureTilesCache = Array.from(this.captureTileMap.values());
      this.captureTilesDirty = false;
    }
    return this.captureTilesCache;
  }

  getCaptureCellSize(): number {
    return this.captureCellSize;
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
    this.captureTileMap.clear();
    this.captureTilesCache = [];
    this.captureTilesDirty = true;
    this.captureCellSize = 0;
    this.serverMeta = null;
    this.frameCounter = 0;
    this.invalidateCaches();
  }
}
