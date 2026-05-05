/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: dead-reckon using velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Buildable, Entity, PlayerId, EntityId, BuildingType } from '../sim/types';
import { isProjectileShot, isRocketLikeShot } from '../sim/types';
import { isLineShotType, getShotMaxLifespan } from '@/types/sim';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
} from './NetworkManager';
import type { BeamPoint } from '../../types/sim';
import type { ShotId, TurretId } from '../../types/blueprintIds';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { NetworkCaptureTile } from '@/types/capture';
import { economyManager } from '../sim/economy';
import { createEntityFromNetwork, refreshUnitTurretsFromNetwork } from './helpers';
import { TURRET_CONFIGS } from '../sim/turretConfigs';
import { getProjectileConfigForSpawn } from '../sim/projectileConfigs';
import { getUnitBlueprint, getUnitLocomotion } from '../sim/blueprints';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getEntityVelocity3, getTurretMountHeight } from '../sim/combat/combatUtils';
import { resolveTargetAimPoint } from '../sim/combat/aimSolver';
import { getBarrelTip } from '../math';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_FACTORY,
  codeToActionType,
  codeToTurretState,
  codeToUnitType,
  codeToBuildingType,
  codeToProjectileType,
  codeToShotId,
  codeToTurretId,
  PROJECTILE_TYPE_PROJECTILE,
  TURRET_ID_UNKNOWN,
  isLineProjectileTypeCode,
} from '../../types/network';

import {
  lerp,
  lerpAngle,
  applyHomingSteering,
  computeInterceptTime,
} from '../math';
import { COST_MULTIPLIER, GRAVITY, DGUN_TERRAIN_FOLLOW_HEIGHT, SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getTurretWorldMount } from '../math/MountGeometry';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import { getUnitGroundZ } from '../sim/unitGeometry';
import { getDriftPreset, halfLifeBlend, type DriftPreset } from './driftEma';
import { landCellCenterForSize, landCellIndexForSize, packLandCellKey } from '../landGrid';
import { createBuildable } from '../sim/buildableHelpers';

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];

// Gravity imported from config.ts — single value shared with server
// sim and every other falling-thing system.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

type NetworkBuildState = {
  complete: boolean;
  progress?: number;
  paid: Buildable['paid'];
};

function getUnitBuildRequired(unitType: string | undefined): Buildable['required'] | undefined {
  if (!unitType) return undefined;
  try {
    const bp = getUnitBlueprint(unitType);
    return {
      energy: bp.cost.energy * COST_MULTIPLIER,
      mana: bp.cost.mana * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    };
  } catch {
    return undefined;
  }
}

function getBuildingBuildRequired(buildingType: BuildingType | undefined): Buildable['required'] | undefined {
  if (!buildingType) return undefined;
  try {
    return { ...getBuildingConfig(buildingType).cost };
  } catch {
    return undefined;
  }
}

function applyNetworkBuildState(
  entity: Entity,
  build: NetworkBuildState | undefined,
  required: Buildable['required'] | undefined,
): boolean {
  if (!build || build.complete) {
    if (!entity.buildable) return false;
    delete entity.buildable;
    return true;
  }

  if (!required) return false;
  let buildable = entity.buildable;
  if (!buildable) {
    entity.buildable = createBuildable(required, {
      paid: build.paid,
      healthBuildFraction: build.progress,
    });
    return true;
  }

  buildable.required.energy = required.energy;
  buildable.required.mana = required.mana;
  buildable.required.metal = required.metal;
  buildable.paid.energy = build.paid.energy;
  buildable.paid.mana = build.paid.mana;
  buildable.paid.metal = build.paid.metal;
  buildable.isComplete = false;
  buildable.isGhost = false;
  buildable.healthBuildFraction = build.progress;
  return true;
}

const _clientHomingAimPoint = { x: 0, y: 0, z: 0 };
const _clientHomingTargetVelocity = { x: 0, y: 0, z: 0 };

// Drift half-lives (seconds). How long to close 50% of the gap to the server value.
// Smaller = snappier correction, larger = smoother/lazier.
// Blend factor per frame: 1 - Math.pow(0.5, dt / halfLife)
import { getDriftMode } from '@/clientBarConfig';
import { normalizeLodCellSize } from '../lodGridMath';

// Lightweight copy of server state used for per-frame drift in applyPrediction().
// Owns its data (not a reference to pooled serializer objects).
type ServerTarget = {
  x: number;
  y: number;
  /** Server's authoritative altitude. Updated every snapshot that
   *  carries ENTITY_CHANGED_POS or a full keyframe so airborne /
   *  knocked-up / falling units render at their true height instead
   *  of freezing at creation altitude. */
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  /** Server vz for dead-reckoning and gravity-aware drift on airborne
   *  units between snapshots. */
  velocityZ: number;
  turrets: {
    rotation: number;
    angularVelocity: number;
    pitch: number;
    forceFieldRange: number | undefined;
  }[];
};

function createServerTarget(): ServerTarget {
  return { x: 0, y: 0, z: 0, rotation: 0, velocityX: 0, velocityY: 0, velocityZ: 0, turrets: [] };
}

type BeamPathTarget = {
  /** Authoritative per-snapshot polyline (start, ...reflections, end).
   *  Each vertex carries (vx, vy, vz) in world frame; the per-frame
   *  predictor advances every vertex by its own velocity AND eases
   *  toward the snapshot value, mirroring the turret rotation +
   *  angularVelocity prediction pattern. Owned in place — the array
   *  reference is stable, slots get reused/resized as the host's
   *  reflection count changes. */
  points: BeamPoint[];
  obstructionT?: number;
};

function createBeamPathTarget(): BeamPathTarget {
  return { points: [] };
}

function ensureBeamPoint(arr: BeamPoint[], i: number): BeamPoint {
  let p = arr[i];
  if (!p) {
    p = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    arr[i] = p;
  }
  return p;
}

type QueuedProjectileSpawn = {
  spawn: NetworkServerSnapshotProjectileSpawn;
  playAt: number;
};

function createOwnedProjectileSpawn(): NetworkServerSnapshotProjectileSpawn {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_PROJECTILE,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 0,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
  };
}

function copyProjectileSpawnInto(
  src: NetworkServerSnapshotProjectileSpawn,
  dst: NetworkServerSnapshotProjectileSpawn,
): NetworkServerSnapshotProjectileSpawn {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rotation = src.rotation;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.projectileType = src.projectileType;
  dst.maxLifespan = src.maxLifespan;
  dst.turretId = src.turretId;
  dst.shotId = src.shotId;
  dst.sourceTurretId = src.sourceTurretId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.turretIndex = src.turretIndex;
  dst.barrelIndex = src.barrelIndex;
  dst.isDGun = src.isDGun;
  dst.fromParentDetonation = src.fromParentDetonation;
  dst.targetEntityId = src.targetEntityId;
  dst.homingTurnRate = src.homingTurnRate;
  if (src.beam) {
    const beam = dst.beam ?? {
      start: { x: 0, y: 0, z: 0 },
      end: { x: 0, y: 0, z: 0 },
    };
    beam.start.x = src.beam.start.x;
    beam.start.y = src.beam.start.y;
    beam.start.z = src.beam.start.z;
    beam.end.x = src.beam.end.x;
    beam.end.y = src.beam.end.y;
    beam.end.z = src.beam.end.z;
    dst.beam = beam;
  } else {
    dst.beam = undefined;
  }
  return dst;
}

export type PredictionLodTier = 'rich' | 'simple' | 'mass' | 'impostor' | 'marker';

export type PredictionLodContext = {
  /** Three.js/world camera x. */
  cameraX: number;
  /** Three.js/world camera height. */
  cameraY: number;
  /** Three.js/world camera z, equivalent to sim y. */
  cameraZ: number;
  richDistance: number;
  simpleDistance: number;
  massDistance: number;
  impostorDistance: number;
  cellSize: number;
  /** PLAYER CLIENT LOD global cadence: frames to skip before
   *  another client prediction step. 0 means every render frame. */
  physicsPredictionFramesSkip: number;
  /**
   * Optional shared frame resolver. When supplied, prediction uses the
   * same cell/tier cache as rendering instead of recomputing camera
   * sphere membership inside ClientViewState. Coordinates are Three.js
   * world axes: x, height/y, z.
   */
  resolveTier?: (worldX: number, worldY: number, worldZ: number) => PredictionLodTier;
};

type PredictionLodCellKey = number;

type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

type PredictionAccumulator = {
  entityMs: number;
  targetMs: number;
};

const PREDICTION_POS_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_VEL_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_ROT_EPSILON = 0.001;
const PREDICTION_TURRET_EPSILON = 0.001;

function angleDeltaAbs(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function captureHeightsEmpty(heights: NetworkCaptureTile['heights']): boolean {
  for (const _key in heights) return false;
  return true;
}

/** True when this entity is a beam/laser projectile. Thin convenience
 *  wrapper around the canonical {@link isLineShotType} predicate that
 *  also handles the `entity.projectile` undefined case. */
function isLineProjectileEntity(entity: Entity): boolean {
  return entity.projectile !== undefined && isLineShotType(entity.projectile.projectileType);
}

function decodeProjectileSourceTurretId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): TurretId | undefined {
  const sourceTurretId = spawn.sourceTurretId !== undefined
    ? codeToTurretId(spawn.sourceTurretId) ?? undefined
    : undefined;
  if (sourceTurretId) return sourceTurretId;
  return codeToTurretId(spawn.turretId) ?? undefined;
}

function decodeProjectileShotId(
  spawn: NetworkServerSnapshotProjectileSpawn,
): ShotId | undefined {
  return spawn.shotId !== undefined
    ? codeToShotId(spawn.shotId) ?? undefined
    : undefined;
}

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities: Map<EntityId, Entity> = new Map();

  // Server target state — owned copies of drift-relevant fields per entity
  private serverTargets: Map<EntityId, ServerTarget> = new Map();
  private beamPathTargets: Map<EntityId, BeamPathTarget> = new Map();
  private activeBeamPathIds: Set<EntityId> = new Set();
  private projectileSpawnQueue: QueuedProjectileSpawn[] = [];
  private projectileSpawnQueuePool: QueuedProjectileSpawn[] = [];
  private projectileSpawnSnapshotTime = 0;
  private projectileSpawnSnapshotInterval = 100;

  // Current spray targets for rendering
  private sprayTargets: SprayTarget[] = [];
  private sprayTargetPool: SprayTarget[] = [];

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
  private captureTileMap: Map<number, NetworkCaptureTile> = new Map();
  private captureTilesCache: NetworkCaptureTile[] = [];
  private captureDirtyTileMap: Map<number, NetworkCaptureTile> = new Map();
  private captureDirtyTilesScratch: NetworkCaptureTile[] = [];
  private captureTilePool: NetworkCaptureTile[] = [];
  private captureFullDirty: boolean = true;
  private captureTilesDirty: boolean = true;
  private captureVersion: number = 0;
  private captureCellSize: number = 0;

  // Server metadata from latest snapshot
  private serverMeta: NetworkServerSnapshotMeta | null = null;
  private forceFieldsEnabledForPrediction = true;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cache = new EntityCacheManager();
  private entitySetVersion = 0;
  private lineProjectileRenderVersion = 0;
  private projectileCacheDirty = false;

  // Frame counter for beam path throttling (recompute every N frames instead of every frame)
  private frameCounter: number = 0;

  // Client prediction is LOD-stepped by the same camera-centered 3D
  // cells used by rendering. Far entities accumulate elapsed time and
  // run less often instead of paying turret/projectile/beam prediction
  // cost every browser frame.
  private predictionAccums: Map<EntityId, PredictionAccumulator> = new Map();
  private predictionLodCells: Map<PredictionLodCellKey, PredictionLodTier> = new Map();
  private predictionRichDistanceSq = 0;
  private predictionSimpleDistanceSq = 0;
  private predictionMassDistanceSq = 0;
  private predictionImpostorDistanceSq = 0;
  private predictionLodCellSize = 1;
  private activeUnitPredictionIds: Set<EntityId> = new Set();
  private activeProjectilePredictionIds: Set<EntityId> = new Set();
  private dirtyUnitRenderIds: Set<EntityId> = new Set();

  // Per-frame cache of living enemy entities, built lazily the first
  // time a rocket needs to re-acquire this frame. Subsequent rockets
  // losing target in the same frame share the same scan result — so
  // 10 rockets losing lock = 1 entity-map walk, not 10.
  private _rocketEnemyCache: Entity[] = [];
  private _rocketEnemyCacheFrame: number = -1;
  private _rocketEnemyCacheOwnerId: PlayerId | null = null;

  // Map dimensions — needed to evaluate the deterministic terrain
  // heightmap on the client side (server and client share the same
  // pure function so projectile dead-reckoning lifts off raised
  // cube tiles correctly without networking the heightmap).
  private mapWidth: number = 2000;
  private mapHeight: number = 2000;

  constructor() {}

  /** Plumb in the map dimensions so client-side projectile dead-
   *  reckoning can evaluate the same terrain heightmap the server
   *  uses. Call once after constructing. */
  setMapDimensions(mapWidth: number, mapHeight: number): void {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Read map dimensions for renderers / overlays that need to sample
   *  the deterministic terrain heightmap. */
  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  private invalidateCaches(): void {
    this.projectileCacheDirty = false;
    this.cache.invalidate();
  }

  private invalidateProjectileCaches(): void {
    this.projectileCacheDirty = true;
  }

  private markEntitySetChanged(invalidateCaches = true): void {
    this.entitySetVersion++;
    if (invalidateCaches) this.invalidateCaches();
    else this.invalidateProjectileCaches();
  }

  private clearPredictionAccum(id: EntityId): void {
    this.predictionAccums.delete(id);
  }

  private clearTargetPredictionAccum(id: EntityId): void {
    const accum = this.predictionAccums.get(id);
    if (!accum) return;
    accum.targetMs = 0;
    if (accum.entityMs <= 0) this.predictionAccums.delete(id);
  }

  private deleteEntityLocalState(id: EntityId): void {
    const existing = this.entities.get(id);
    const wasLineProjectile = existing ? isLineProjectileEntity(existing) : false;
    const existed = this.entities.delete(id);
    this.serverTargets.delete(id);
    this.beamPathTargets.delete(id);
    this.removeQueuedProjectileSpawn(id);
    this.selectedIds.delete(id);
    this.clearPredictionAccum(id);
    this.activeUnitPredictionIds.delete(id);
    this.activeProjectilePredictionIds.delete(id);
    this.activeBeamPathIds.delete(id);
    this.dirtyUnitRenderIds.delete(id);
    if (existed) {
      if (wasLineProjectile) this.markLineProjectilesChanged();
      this.markEntitySetChanged(existing?.type !== 'shot');
    }
  }

  private markLineProjectilesChanged(): void {
    this.lineProjectileRenderVersion = (this.lineProjectileRenderVersion + 1) & 0x3fffffff;
  }

  private acquireQueuedProjectileSpawn(): QueuedProjectileSpawn {
    const queued = this.projectileSpawnQueuePool.pop();
    if (queued) {
      queued.playAt = 0;
      return queued;
    }
    return {
      spawn: createOwnedProjectileSpawn(),
      playAt: 0,
    };
  }

  private releaseQueuedProjectileSpawn(queued: QueuedProjectileSpawn): void {
    queued.spawn.beam = undefined;
    queued.spawn.maxLifespan = undefined;
    queued.spawn.isDGun = undefined;
    queued.spawn.fromParentDetonation = undefined;
    queued.spawn.targetEntityId = undefined;
    queued.spawn.homingTurnRate = undefined;
    queued.playAt = 0;
    this.projectileSpawnQueuePool.push(queued);
  }

  private removeQueuedProjectileSpawn(id: EntityId): void {
    const q = this.projectileSpawnQueue;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].spawn.id !== id) continue;
      const queued = q[i];
      q[i] = q[q.length - 1];
      q.length--;
      this.releaseQueuedProjectileSpawn(queued);
      return;
    }
  }

  private recordProjectileSpawnSnapshot(now: number): void {
    if (this.projectileSpawnSnapshotTime > 0) {
      const dt = now - this.projectileSpawnSnapshotTime;
      if (dt > 0) {
        this.projectileSpawnSnapshotInterval =
          0.8 * this.projectileSpawnSnapshotInterval + 0.2 * dt;
      }
    }
    this.projectileSpawnSnapshotTime = now;
  }

  private shouldSmoothProjectileSpawn(spawn: NetworkServerSnapshotProjectileSpawn): boolean {
    const sourceTurretId = decodeProjectileSourceTurretId(spawn);
    return spawn.projectileType === PROJECTILE_TYPE_PROJECTILE &&
      !spawn.fromParentDetonation &&
      !!(sourceTurretId && TURRET_CONFIGS[sourceTurretId]?.eventsSmooth);
  }

  private queueProjectileSpawn(spawn: NetworkServerSnapshotProjectileSpawn, now: number): void {
    this.removeQueuedProjectileSpawn(spawn.id);
    const queued = this.acquireQueuedProjectileSpawn();
    copyProjectileSpawnInto(spawn, queued.spawn);
    queued.playAt = now + Math.random() * this.projectileSpawnSnapshotInterval;
    this.projectileSpawnQueue.push(queued);
  }

  private applyProjectileSpawn(spawn: NetworkServerSnapshotProjectileSpawn): boolean {
    if (this.entities.has(spawn.id)) return false;
    try {
      const entity = this.createProjectileFromSpawn(spawn);
      this.markEntitySetChanged(false);
      this.entities.set(spawn.id, entity);
      if (isLineProjectileTypeCode(spawn.projectileType)) {
        this.activeBeamPathIds.add(spawn.id);
        this.markLineProjectilesChanged();
      } else {
        this.activeProjectilePredictionIds.add(spawn.id);
      }
      return true;
    } catch {
      // Skip projectiles with unknown weapon configs (e.g. corrupted by serialization)
      return false;
    }
  }

  private drainQueuedProjectileSpawns(now: number): boolean {
    const q = this.projectileSpawnQueue;
    let changed = false;
    for (let i = q.length - 1; i >= 0; i--) {
      const queued = q[i];
      if (now < queued.playAt) continue;
      if (this.applyProjectileSpawn(queued.spawn)) changed = true;
      q[i] = q[q.length - 1];
      q.length--;
      this.releaseQueuedProjectileSpawn(queued);
    }
    return changed;
  }

  private acquireSprayTarget(): SprayTarget {
    let target = this.sprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0 },
        type: 'build',
        intensity: 0,
      };
    }
    return target;
  }

  private releaseSprayTargets(): void {
    for (let i = 0; i < this.sprayTargets.length; i++) {
      this.sprayTargetPool.push(this.sprayTargets[i]);
    }
    this.sprayTargets.length = 0;
  }

  private markEntityPredictionActive(entity: Entity): void {
    if (entity.unit) {
      this.activeUnitPredictionIds.add(entity.id);
      this.dirtyUnitRenderIds.add(entity.id);
    } else if (entity.projectile && !isLineProjectileEntity(entity)) {
      this.activeProjectilePredictionIds.add(entity.id);
    }
  }

  private markNetworkUnitPredictionActive(
    server: NetworkServerSnapshotEntity,
    entity?: Entity,
  ): void {
    if (server.type !== 'unit') return;
    const cf = server.changedFields;
    if (cf == null && entity && this.unitPredictionIsSettled(entity, this.serverTargets.get(server.id))) {
      return;
    }
    if (
      cf == null ||
      (cf & (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL)) !== 0 ||
      Array.isArray(server.unit?.turrets)
    ) {
      this.activeUnitPredictionIds.add(server.id);
      this.dirtyUnitRenderIds.add(server.id);
    }
  }

  private snapshotAffectsEntityCaches(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const cf = server.changedFields;
    if (entity.unit && (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)))) {
      return this.unitHealthBarCacheMembership(entity) !==
        this.networkUnitHealthBarCacheMembership(entity, server);
    }
    if (
      entity.building &&
      (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)))
    ) {
      return this.buildingHealthBarCacheMembership(entity) !==
        this.networkBuildingHealthBarCacheMembership(entity, server);
    }
    return false;
  }

  private unitHealthBarCacheMembership(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    return unit.hp < unit.maxHp ||
      !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
  }

  private networkUnitHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const hp = server.unit?.hp;
    const build = server.unit?.build;
    const curr = hp?.curr ?? entity.unit?.hp ?? 0;
    const max = hp?.max ?? entity.unit?.maxHp ?? 0;
    const complete = build?.complete ?? entity.buildable?.isComplete ?? true;
    return curr < max ||
      !!(entity.buildable && !entity.buildable.isGhost && !complete);
  }

  private buildingHealthBarCacheMembership(entity: Entity): boolean {
    const building = entity.building;
    if (!building) return false;
    return building.hp < building.maxHp ||
      !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
  }

  private networkBuildingHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const building = entity.building;
    const hp = server.building?.hp;
    const build = server.building?.build;
    const curr = hp?.curr ?? building?.hp ?? 0;
    const max = hp?.max ?? building?.maxHp ?? 0;
    const complete = build?.complete ?? entity.buildable?.isComplete ?? true;
    return curr < max ||
      !!(entity.buildable && !entity.buildable.isGhost && !complete);
  }

  private rebuildCachesIfNeeded(includeProjectileChanges = false): void {
    if (includeProjectileChanges && this.projectileCacheDirty) {
      this.projectileCacheDirty = false;
      this.cache.invalidate();
    }
    if (this.cache.rebuildIfNeeded(this.entities)) {
      this.projectileCacheDirty = false;
    }
  }

  /**
   * Apply received network state — store server targets, snap non-visual state.
   * Visual blending toward these targets happens in applyPrediction() each frame.
   */
  applyNetworkState(state: NetworkServerSnapshot): void {
    this.currentTick = state.tick;
    let cacheNeedsInvalidate = false;
    const now = performance.now();
    this.recordProjectileSpawnSnapshot(now);
    this.drainQueuedProjectileSpawns(now);

    // Process entity updates (present in both delta and keyframe snapshots)
    for (const netEntity of state.entities) {
      const cf = netEntity.changedFields;
      const isFull = cf == null;
      const isBuildingUpdate = netEntity.type === 'building';
      if (isBuildingUpdate) {
        // Buildings are static scene objects. Keep them out of the
        // per-frame prediction maps entirely; their transform is snapped
        // directly in snapNonVisualState() when the network record says
        // it changed.
        this.serverTargets.delete(netEntity.id);
        this.clearPredictionAccum(netEntity.id);
      } else {
        // Copy drift-relevant fields into owned ServerTarget (avoids holding pooled object refs)
        let target = this.serverTargets.get(netEntity.id);
        if (!target) {
          target = createServerTarget();
          this.serverTargets.set(netEntity.id, target);
        }
        // A fresh server target supersedes any sparse-prediction time
        // accumulated before this snapshot. Otherwise far entities can
        // extrapolate the newest target by time that already belonged
        // to an older target and visibly overshoot.
        this.clearTargetPredictionAccum(netEntity.id);
        if (isFull || cf! & ENTITY_CHANGED_POS) {
          target.x = netEntity.pos.x;
          target.y = netEntity.pos.y;
          // netEntity.pos is a Vec3 — altitude must ride along or
          // airborne units render at stale ground-plane z on the client.
          target.z = netEntity.pos.z;
        }
        if (isFull || cf! & ENTITY_CHANGED_ROT) {
          target.rotation = netEntity.rotation;
        }
        // Velocity ships on full records and on deltas where
        // ENTITY_CHANGED_VEL is set. The wire field is still optional
        // (older / future deltas may omit it) so guard with `?.`.
        if (isFull || cf! & ENTITY_CHANGED_VEL) {
          const v = netEntity.unit?.velocity;
          if (v !== undefined) {
            target.velocityX = v.x;
            target.velocityY = v.y;
            target.velocityZ = v.z;
          }
        }
        // Server now ships u.turrets on every delta where the unit is
        // present (not gated by ENTITY_CHANGED_TURRETS) so client-side
        // turret aim stays smooth between threshold-crossing changes.
        // Read whenever it's there.
        {
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
              target.turrets[i].forceFieldRange = nw[i].currentForceFieldRange ?? undefined;
            }
          } else if (isFull) {
            target.turrets.length = 0;
          }
        }
      }

      const existing = this.entities.get(netEntity.id);

      if (!existing) {
        // Only create entities from full data (keyframes or new-entity entries).
        // Delta snapshots with changedFields set may be missing unit type, HP, etc.
        // The entity will be created on the next keyframe.
        if (netEntity.changedFields != null) continue;

        const newEntity = createEntityFromNetwork(netEntity);
        if (newEntity) {
          if (newEntity.selectable && this.selectedIds.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(netEntity.id, newEntity);
          this.markEntityPredictionActive(newEntity);
          this.entitySetVersion++;
          cacheNeedsInvalidate = true;
        }
      } else {
        // Existing entity — snap non-visual state immediately
        if (this.snapshotAffectsEntityCaches(existing, netEntity)) {
          cacheNeedsInvalidate = true;
        }
        this.snapNonVisualState(existing, netEntity);
        this.markNetworkUnitPredictionActive(netEntity, existing);
      }
    }

    if (state.isDelta) {
      // Delta snapshot: only remove entities explicitly listed in removedEntityIds
      if (state.removedEntityIds) {
        for (const id of state.removedEntityIds) {
          this.deleteEntityLocalState(id);
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
          this.deleteEntityLocalState(id);
        }
      }
    }

    // Process projectile spawn events
    if (state.projectiles?.spawns) {
      for (const spawn of state.projectiles.spawns) {
        if (this.shouldSmoothProjectileSpawn(spawn)) {
          this.queueProjectileSpawn(spawn, now);
          continue;
        }
        this.applyProjectileSpawn(spawn);
      }
    }

    // Server-authored live beam/laser paths. These carry current
    // start/end/reflection points so the client can draw beams without
    // running local mirror/unit/building beam traces in applyPrediction.
    if (state.projectiles?.beamUpdates) {
      for (const update of state.projectiles.beamUpdates) {
        this.applyBeamUpdate(update);
      }
    }

    // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
    if (state.projectiles?.despawns) {
      for (const despawn of state.projectiles.despawns) {
        this.deleteEntityLocalState(despawn.id);
      }
    }

    // Process projectile velocity updates (homing / server correction)
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
          target.z = vu.pos.z;
          target.velocityX = vu.velocity.x;
          target.velocityZ = vu.velocity.z;
          target.velocityY = vu.velocity.y;
          this.clearTargetPredictionAccum(vu.id);
          if (isLineProjectileEntity(entity)) this.activeBeamPathIds.add(vu.id);
          else this.activeProjectilePredictionIds.add(vu.id);
        }
      }
    }

    if (cacheNeedsInvalidate) this.invalidateCaches();

    // Update economy state (immediate). Avoid Object.entries here:
    // snapshots arrive frequently and this path should not allocate an
    // intermediate [key,value][] array just to walk up to six players.
    for (const playerIdStr in state.economy) {
      economyManager.setEconomyState(
        Number(playerIdStr) as PlayerId,
        state.economy[Number(playerIdStr) as PlayerId],
      );
    }

    // Store spray targets for rendering. Reuse nested objects instead
    // of retaining pooled snapshot references or allocating a fresh
    // object tree on every construction snapshot.
    this.releaseSprayTargets();
    if (state.sprayTargets && state.sprayTargets.length > 0) {
      const src = state.sprayTargets;
      for (let i = 0; i < src.length; i++) {
        const st = src[i];
        const target = this.acquireSprayTarget();
        target.source.id = st.source.id;
        target.source.pos.x = st.source.pos.x;
        target.source.pos.y = st.source.pos.y;
        target.source.z = st.source.z;
        target.source.playerId = st.source.playerId;
        target.target.id = st.target.id;
        target.target.pos.x = st.target.pos.x;
        target.target.pos.y = st.target.pos.y;
        target.target.z = st.target.z;
        target.target.dim = st.target.dim;
        target.target.radius = st.target.radius;
        target.type = st.type;
        target.intensity = st.intensity;
        this.sprayTargets.push(target);
      }
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

    // Store spatial grid debug data. The server sends this diagnostic
    // payload on a slower cadence than normal snapshots; keep the last
    // received grid payload until a new one arrives. When the server
    // toggle is off, serverMeta.grid clears the client copy.
    if (state.grid) {
      this.gridCells = state.grid.cells;
      this.gridSearchCells = state.grid.searchCells;
      this.gridCellSize = state.grid.cellSize;
    } else if (state.serverMeta?.grid === false) {
      this.gridCells = [];
      this.gridSearchCells = [];
      this.gridCellSize = 0;
    }

    // Merge capture tile data (delta-aware)
    if (state.capture) {
      this.captureCellSize = state.capture.cellSize;
      if (!state.isDelta) {
        // Keyframe: replace all
        this.clearCaptureTileMaps();
        this.captureFullDirty = true;
      }
      for (const tile of state.capture.tiles) {
        const key = ((tile.cx + 32768) & 0xFFFF) << 16 | ((tile.cy + 32768) & 0xFFFF);
        if (captureHeightsEmpty(tile.heights)) {
          const removed = this.captureTileMap.get(key);
          const previousDirty = this.captureDirtyTileMap.get(key);
          if (removed) {
            this.captureTileMap.delete(key);
            this.releaseCaptureTile(removed);
          }
          if (!this.captureFullDirty) {
            const dirty = this.acquireCaptureTile(tile.cx, tile.cy, undefined);
            if (previousDirty && previousDirty !== removed) this.releaseCaptureTile(previousDirty);
            this.captureDirtyTileMap.set(key, dirty);
          }
        } else {
          // Copy heights — tile objects may be pooled/reused by the server
          const copy = this.acquireCaptureTile(tile.cx, tile.cy, tile.heights);
          const previous = this.captureTileMap.get(key);
          const previousDirty = this.captureDirtyTileMap.get(key);
          if (previous) this.releaseCaptureTile(previous);
          this.captureTileMap.set(key, copy);
          if (!this.captureFullDirty) {
            if (previousDirty && previousDirty !== previous) this.releaseCaptureTile(previousDirty);
            this.captureDirtyTileMap.set(key, copy);
          }
        }
      }
      this.captureTilesDirty = true;
      this.captureVersion++;
    } else if (!state.isDelta) {
      // Keyframe with no capture data: clear
      this.clearCaptureTileMaps();
      this.captureFullDirty = true;
      this.captureTilesDirty = true;
      this.captureVersion++;
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
    const isFull = cf == null;
    const su = server.unit;
    let cacheDirty = false;
    if (entity.unit && su) {
      if (isFull || cf! & ENTITY_CHANGED_HP) {
        entity.unit.hp = su.hp.curr;
        entity.unit.maxHp = su.hp.max;
        cacheDirty = true;
      }
      // Buildable means "currently under construction." A full
      // record or BUILDING-bit delta with no incomplete build payload
      // removes stale construction state from completed shells.
      if (isFull || cf! & ENTITY_CHANGED_BUILDING) {
        cacheDirty = applyNetworkBuildState(
          entity,
          su.build,
          getUnitBuildRequired(entity.unit.unitType),
        ) || cacheDirty;
      }
      // Static fields are present on full records and may be omitted
      // from ordinary deltas. Read whenever they're present; they do
      // not change after spawn, so re-applying them is a no-op.
      if (su.radius) {
        if (isFiniteNumber(su.radius.body)) entity.unit.radius.body = su.radius.body;
        if (isFiniteNumber(su.radius.shot)) entity.unit.radius.shot = su.radius.shot;
        if (isFiniteNumber(su.radius.push)) entity.unit.radius.push = su.radius.push;
      }
      if (isFiniteNumber(su.bodyCenterHeight)) {
        entity.unit.bodyCenterHeight = su.bodyCenterHeight;
      }
      if (typeof su.unitType === 'number') {
        const unitType = codeToUnitType(su.unitType);
        if (unitType) {
          entity.unit.unitType = unitType;
          entity.unit.locomotion = getUnitLocomotion(unitType);
        }
      }
      if (isFiniteNumber(su.mass)) entity.unit.mass = su.mass;

      // On full keyframes, turret mounts/configs are static blueprint
      // data. Rebuild them from the unit type + body radius and then
      // apply only dynamic network state. This keeps remote MessagePack
      // full snaps from moving turret mounts if pooled/static wire data
      // gets stale or decoded oddly.
      if (isFull && Array.isArray(su.turrets)) {
        refreshUnitTurretsFromNetwork(
          entity,
          entity.unit.unitType,
          entity.unit.radius.body,
          su.turrets,
        );
      }

      if ((isFull || cf! & ENTITY_CHANGED_ACTIONS) && su.actions) {
        const src = su.actions;
        const actions = entity.unit.actions;
        actions.length = 0;
        for (let i = 0; i < src.length; i++) {
          const na = src[i];
          if (!na.pos) continue;
          actions.push({
            type: codeToActionType(na.type) as
              | 'move'
              | 'patrol'
              | 'fight'
              | 'build'
              | 'repair'
              | 'attack',
            x: na.pos.x,
            y: na.pos.y,
            z: na.posZ,
            isPathExpansion: na.pathExp,
            targetId: na.targetId,
            buildingType: na.buildingType as BuildingType | undefined,
            gridX: na.grid?.x,
            gridY: na.grid?.y,
            buildingId: na.buildingId,
          });
        }
      }

      // Snap turret targeting state (turret rotation/velocity blended in applyPrediction)
      // Now read whenever su.turrets is present, since the server ships it on every delta.
      if (
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
          entity.turrets[i].state = codeToTurretState(su.turrets[i].state);
          // forceField.range is NOT snapped — dead-reckoned + drifted in applyPrediction()
        }
      }

      if (entity.builder && su.buildTargetId !== undefined) {
        entity.builder.currentBuildTarget = su.buildTargetId;
      }
    }

    const sb = server.building;
    if (entity.building) {
      if (isFull || cf! & ENTITY_CHANGED_POS) {
        entity.transform.x = server.pos.x;
        entity.transform.y = server.pos.y;
        entity.transform.z = server.pos.z;
      }
      if (isFull || cf! & ENTITY_CHANGED_ROT) {
        entity.transform.rotation = server.rotation;
      }
    }

    if (entity.building && sb?.type !== undefined && isFull) {
      const buildingType = codeToBuildingType(sb.type);
      if (buildingType) entity.buildingType = buildingType as BuildingType;
    }

    if (entity.building && sb && (isFull || sb.metalExtractionRate !== undefined)) {
      entity.metalExtractionRate = sb.metalExtractionRate;
    }

    if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_HP)) {
      entity.building.hp = sb.hp.curr;
      entity.building.maxHp = sb.hp.max;
      cacheDirty = true;
    }

    if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
      cacheDirty = applyNetworkBuildState(
        entity,
        sb.build,
        getBuildingBuildRequired(entity.buildingType),
      ) || cacheDirty;
    }

    if (entity.building && sb && (isFull || cf! & ENTITY_CHANGED_BUILDING)) {
      if (sb.solar) {
        entity.building.solar = {
          open: sb.solar.open,
          producing: entity.building.solar?.producing ?? false,
          reopenDelayMs: entity.building.solar?.reopenDelayMs ?? 0,
        };
      } else if (isFull && entity.buildingType === 'solar') {
        entity.building.solar = { open: false, producing: false, reopenDelayMs: 0 };
      }
    }

    const sf = sb?.factory;
    if (entity.factory && sf && (isFull || cf! & ENTITY_CHANGED_FACTORY)) {
      // Decode wire codes back to string ids in place — reuses the
      // entity's existing buildQueue array so we don't allocate per
      // factory per delta. UIUpdateManager reads strings from this
      // field so the conversion has to happen on the way in.
      const dst = entity.factory.buildQueue;
      const src = sf.queue;
      dst.length = 0;
      for (let i = 0; i < src.length; i++) {
        const unitType = codeToUnitType(src[i]);
        if (unitType) dst.push(unitType);
      }
      // Wire `progress` is the avg-fill of the factory's currentShellId
      // (server-derived). Client-side currentShellId stays null on the
      // viewstate-projected entity — the shell entity itself is in the
      // world separately, and currentBuildProgress mirrors the wire so
      // the build-queue UI strip can draw without looking up the shell.
      entity.factory.currentShellId = null;
      entity.factory.currentBuildProgress = sf.progress;
      entity.factory.isProducing = sf.producing;
      entity.factory.energyRateFraction = sf.energyRate ?? 0;
      entity.factory.manaRateFraction = sf.manaRate ?? 0;
      entity.factory.metalRateFraction = sf.metalRate ?? 0;
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
          z: wps[i].posZ,
          type: wps[i].type as 'move' | 'fight' | 'patrol',
        };
      }
    }

    if (cacheDirty) this.cache.invalidate();

    // Projectiles are no longer in server snapshots — handled via spawn/despawn events
  }

  private applyBeamUpdate(update: NetworkServerSnapshotBeamUpdate): void {
    const entity = this.entities.get(update.id);
    const proj = entity?.projectile;
    if (!entity || !proj) return;

    let target = this.beamPathTargets.get(update.id);
    if (!target) {
      target = createBeamPathTarget();
      this.beamPathTargets.set(update.id, target);
    }
    target.obstructionT = update.obstructionT;

    // Mirror the host's polyline length and per-vertex fields into the
    // target buffer. Keep the array reference stable (mutate in place)
    // so per-frame prediction can hold onto its own ref between
    // snapshots.
    const srcPts = update.points;
    const dstTarget = target.points;
    dstTarget.length = srcPts.length;
    for (let i = 0; i < srcPts.length; i++) {
      const sp = srcPts[i];
      const dp = ensureBeamPoint(dstTarget, i);
      dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
      dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
      dp.mirrorEntityId = sp.mirrorEntityId;
    }

    // Seed proj.points on first arrival. Subsequent updates ride
    // through applyBeamPathPrediction (per-vertex easing toward target).
    const projPts = proj.points ?? (proj.points = []);
    if (projPts.length === 0) {
      projPts.length = srcPts.length;
      for (let i = 0; i < srcPts.length; i++) {
        const sp = srcPts[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.mirrorEntityId = sp.mirrorEntityId;
      }
      if (srcPts.length > 0) {
        const start = srcPts[0];
        entity.transform.x = start.x;
        entity.transform.y = start.y;
        entity.transform.z = start.z;
      }
    } else if (projPts.length !== srcPts.length) {
      // Length changed (reflection count differs from last snapshot).
      // Pop or grow proj.points so the predictor steps in sync; new
      // slots seed at the snapshot value (no easing for vertices we
      // didn't have last frame).
      const oldLen = projPts.length;
      projPts.length = srcPts.length;
      for (let i = oldLen; i < srcPts.length; i++) {
        const sp = srcPts[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.mirrorEntityId = sp.mirrorEntityId;
      }
    }
    proj.obstructionT = update.obstructionT;
    this.activeBeamPathIds.add(update.id);
    this.clearPredictionAccum(update.id);
    this.markLineProjectilesChanged();
  }

  private applyBeamPathPrediction(
    entity: Entity,
    target: BeamPathTarget,
    deltaMs: number,
    preset: DriftPreset,
  ): boolean {
    const proj = entity.projectile;
    if (!proj) return false;
    const tgtPts = target.points;
    if (tgtPts.length === 0) return false;

    const blend = halfLifeBlend(deltaMs / 1000, preset.movement.pos);
    const dt = deltaMs / 1000;
    let changed = false;

    // Mirror the target's polyline length onto proj.points. Length
    // changes (reflection count drift) snap the new vertices to the
    // target value — easing only applies to vertices we held last
    // frame.
    const projPts = proj.points ?? (proj.points = []);
    const oldLen = projPts.length;
    if (oldLen !== tgtPts.length) {
      projPts.length = tgtPts.length;
      changed = true;
    }

    // Advance every target vertex by its own velocity each frame so the
    // beam tracks the host's anticipated polyline between snapshots —
    // same role the per-turret rotation+angularVelocity prediction
    // plays for turret pose.
    for (let i = 0; i < tgtPts.length; i++) {
      const tp = tgtPts[i];
      tp.x += tp.vx * dt;
      tp.y += tp.vy * dt;
      tp.z += tp.vz * dt;
    }

    for (let i = 0; i < tgtPts.length; i++) {
      const tp = tgtPts[i];
      let pp = projPts[i];
      if (!pp || i >= oldLen) {
        pp = ensureBeamPoint(projPts, i);
        pp.x = tp.x; pp.y = tp.y; pp.z = tp.z;
        pp.vx = tp.vx; pp.vy = tp.vy; pp.vz = tp.vz;
        pp.mirrorEntityId = tp.mirrorEntityId;
        changed = true;
        continue;
      }
      const px = pp.x, py = pp.y, pz = pp.z;
      const nx = lerp(px, tp.x, blend);
      const ny = lerp(py, tp.y, blend);
      const nz = lerp(pz, tp.z, blend);
      if (
        Math.abs(nx - px) > 1e-4 ||
        Math.abs(ny - py) > 1e-4 ||
        Math.abs(nz - pz) > 1e-4 ||
        pp.mirrorEntityId !== tp.mirrorEntityId
      ) {
        changed = true;
      }
      pp.x = nx;
      pp.y = ny;
      pp.z = nz;
      pp.vx = tp.vx; pp.vy = tp.vy; pp.vz = tp.vz;
      pp.mirrorEntityId = tp.mirrorEntityId;
    }
    proj.obstructionT = target.obstructionT;

    // Update entity transform to track the start vertex; rotation
    // points down the first segment so HUD/audio readouts match the
    // beam's outgoing direction.
    const start = projPts[0];
    const second = projPts[1] ?? start;
    const nextRotation = Math.atan2(second.y - start.y, second.x - start.x);
    if (
      Math.abs(entity.transform.x - start.x) > 1e-4 ||
      Math.abs(entity.transform.y - start.y) > 1e-4 ||
      Math.abs(entity.transform.z - start.z) > 1e-4 ||
      angleDeltaAbs(entity.transform.rotation, nextRotation) > 1e-4
    ) {
      changed = true;
    }
    entity.transform.x = start.x;
    entity.transform.y = start.y;
    entity.transform.z = start.z;
    entity.transform.rotation = nextRotation;
    return changed;
  }

  private resolvePredictionLodTier(
    entity: Entity,
    lod: PredictionLodContext | undefined,
  ): PredictionLodTier {
    if (!lod) return 'rich';
    if (lod.resolveTier) {
      return lod.resolveTier(
        entity.transform.x,
        entity.transform.z,
        entity.transform.y,
      );
    }

    const size = this.predictionLodCellSize;
    // LOD grouping is intentionally 2D: sim x/y on the ground plane.
    // Altitude still affects the camera-sphere distance through the
    // camera's height above the ground plane, but not cell identity.
    const ix = landCellIndexForSize(entity.transform.x, size);
    const iy = landCellIndexForSize(entity.transform.y, size);
    const key = packLandCellKey(ix, iy);
    const cached = this.predictionLodCells.get(key);
    if (cached !== undefined) return cached;

    const cellX = landCellCenterForSize(ix, size);
    const cellY = landCellCenterForSize(iy, size);
    const dx = cellX - lod.cameraX;
    const dy = -lod.cameraY;
    const dz = cellY - lod.cameraZ;
    const tier = this.resolvePredictionLodTierForDistanceSq(
      dx * dx + dy * dy + dz * dz,
    );
    this.predictionLodCells.set(key, tier);
    return tier;
  }

  private resolvePredictionLodTierForDistanceSq(
    distanceSq: number,
  ): PredictionLodTier {
    if (this.predictionRichDistanceSq > 0 && distanceSq <= this.predictionRichDistanceSq) return 'rich';
    if (this.predictionSimpleDistanceSq > 0 && distanceSq <= this.predictionSimpleDistanceSq) return 'simple';
    if (this.predictionMassDistanceSq > 0 && distanceSq <= this.predictionMassDistanceSq) return 'mass';
    if (this.predictionImpostorDistanceSq > 0 && distanceSq <= this.predictionImpostorDistanceSq) return 'impostor';
    return 'marker';
  }

  private predictionFrameStrideForTier(
    tier: PredictionLodTier,
    entity: Entity,
    lod: PredictionLodContext | undefined,
  ): number {
    if (entity.selectable?.selected === true) return 1;
    if (
      entity.projectile &&
      this.entities.get(entity.projectile.sourceEntityId)?.selectable?.selected === true
    ) {
      return 1;
    }
    const globalFramesSkip = Math.max(0, Math.floor(lod?.physicsPredictionFramesSkip ?? 0));
    const sphereFramesSkip = this.predictionFramesSkipForTier(tier);
    return Math.max(globalFramesSkip, sphereFramesSkip) + 1;
  }

  private predictionFramesSkipForTier(tier: PredictionLodTier): number {
    switch (tier) {
      case 'rich': return 0;
      case 'simple': return 1;
      case 'mass': return 3;
      case 'impostor': return 7;
      case 'marker': return 15;
    }
  }

  private consumePredictionDeltaMs(
    entity: Entity,
    deltaMs: number,
    stride: number,
  ): PredictionStep | null {
    if (stride <= 1) {
      this.clearPredictionAccum(entity.id);
      return { entityDeltaMs: deltaMs, targetDeltaMs: deltaMs };
    }

    let accum = this.predictionAccums.get(entity.id);
    const accumulatedMs = Math.min(
      (accum?.entityMs ?? 0) + deltaMs,
      250,
    );
    const targetAccumulatedMs = Math.min(
      (accum?.targetMs ?? 0) + deltaMs,
      250,
    );
    if ((this.frameCounter + entity.id) % stride !== 0) {
      if (!accum) {
        accum = { entityMs: accumulatedMs, targetMs: targetAccumulatedMs };
        this.predictionAccums.set(entity.id, accum);
      } else {
        accum.entityMs = accumulatedMs;
        accum.targetMs = targetAccumulatedMs;
      }
      return null;
    }

    this.clearPredictionAccum(entity.id);
    return {
      entityDeltaMs: accumulatedMs,
      targetDeltaMs: targetAccumulatedMs,
    };
  }

  private applyUnitVisualPrediction(
    entity: Entity,
    target: ServerTarget | undefined,
    deltaMs: number,
    preset: DriftPreset,
  ): void {
    if (!entity.unit) return;
    const dt = deltaMs / 1000;
    const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
    const movVelDrift = halfLifeBlend(dt, preset.movement.vel);
    const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);

    if (target) {
      // Unit body motion is a visual contract, not an optional detail.
      // Keep this smooth at render cadence while LOD throttles heavier
      // turret / force-field prediction below.
      target.x += target.velocityX * dt;
      target.y += target.velocityY * dt;
      target.z += target.velocityZ * dt;
    }

    const vx = entity.unit.velocityX ?? 0;
    const vy = entity.unit.velocityY ?? 0;
    const vz = entity.unit.velocityZ ?? 0;
    entity.transform.x += vx * dt;
    entity.transform.y += vy * dt;
    entity.transform.z += vz * dt;

    if (!target) return;

    entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
    entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
    entity.transform.z = lerp(entity.transform.z, target.z, movPosDrift);
    entity.transform.rotation = lerpAngle(
      entity.transform.rotation,
      target.rotation,
      rotPosDrift,
    );

    entity.unit.velocityX = lerp(vx, target.velocityX ?? 0, movVelDrift);
    entity.unit.velocityY = lerp(vy, target.velocityY ?? 0, movVelDrift);
    entity.unit.velocityZ = lerp(vz, target.velocityZ ?? 0, movVelDrift);
  }

  private applyUnitExpensivePrediction(
    entity: Entity,
    target: ServerTarget | undefined,
    predictionStep: PredictionStep,
    preset: DriftPreset,
  ): void {
    if (!entity.unit || !entity.turrets) return;
    const dt = predictionStep.entityDeltaMs / 1000;
    const targetDt = predictionStep.targetDeltaMs / 1000;
    const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);
    const rotVelDrift = halfLifeBlend(dt, preset.rotation.vel);

    for (let i = 0; i < entity.turrets.length; i++) {
      const weapon = entity.turrets[i];
      if (weapon.config.visualOnly) continue;
      weapon.rotation += weapon.angularVelocity * dt;

      const tw = target?.turrets?.[i];
      if (tw) {
        tw.rotation += tw.angularVelocity * targetDt;
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
        weapon.pitch = lerpAngle(
          weapon.pitch,
          tw.pitch,
          rotPosDrift,
        );
      }

      if (weapon.config.shot.type !== 'force') continue;
      if (!this.forceFieldsEnabledForPrediction) {
        if (weapon.forceField) {
          weapon.forceField.range = 0;
          weapon.forceField.transition = 0;
        }
        continue;
      }
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

      const serverRange = tw?.forceFieldRange;
      if (serverRange !== undefined) {
        next = lerp(next, serverRange, rotPosDrift);
      }
      if (!weapon.forceField) {
        weapon.forceField = { range: next, transition: 0 };
      } else {
        weapon.forceField.range = next;
      }

    }
  }

  private unitPredictionIsSettled(
    entity: Entity,
    target: ServerTarget | undefined,
  ): boolean {
    const unit = entity.unit;
    if (!unit) return true;

    const vx = unit.velocityX ?? 0;
    const vy = unit.velocityY ?? 0;
    const vz = unit.velocityZ ?? 0;
    if (vx * vx + vy * vy + vz * vz > PREDICTION_VEL_EPSILON_SQ) return false;

    if (target) {
      const tvx = target.velocityX ?? 0;
      const tvy = target.velocityY ?? 0;
      const tvz = target.velocityZ ?? 0;
      if (tvx * tvx + tvy * tvy + tvz * tvz > PREDICTION_VEL_EPSILON_SQ) return false;

      const dx = entity.transform.x - target.x;
      const dy = entity.transform.y - target.y;
      const dz = entity.transform.z - target.z;
      if (dx * dx + dy * dy + dz * dz > PREDICTION_POS_EPSILON_SQ) return false;
      if (angleDeltaAbs(entity.transform.rotation, target.rotation) > PREDICTION_ROT_EPSILON) return false;
    }

    const weapons = entity.turrets;
    if (!weapons || weapons.length === 0) return true;

    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (weapon.config.visualOnly) continue;
      if (Math.abs(weapon.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;

      const tw = target?.turrets?.[i];
      if (tw) {
        if (Math.abs(tw.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;
        if (angleDeltaAbs(weapon.rotation, tw.rotation) > PREDICTION_TURRET_EPSILON) return false;
        if (angleDeltaAbs(weapon.pitch, tw.pitch) > PREDICTION_TURRET_EPSILON) return false;
        if (this.forceFieldsEnabledForPrediction) {
          const localRange = weapon.forceField?.range ?? 0;
          const targetRange = tw.forceFieldRange ?? 0;
          if (Math.abs(localRange - targetRange) > PREDICTION_TURRET_EPSILON) return false;
        }
      }

      if (this.forceFieldsEnabledForPrediction && weapon.config.shot.type === 'force') {
        if ((weapon.forceField?.range ?? 0) > PREDICTION_TURRET_EPSILON) return false;
        if (weapon.state === 'engaged') return false;
      }
    }

    return true;
  }

  /**
   * Called every frame. Two steps:
   * 1. Dead-reckon: advance positions using velocity
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number, lod?: PredictionLodContext): void {
    this.frameCounter = (this.frameCounter + 1) & 0x3fffffff;
    if (this.frameCounter === 0) {
      this.frameCounter = 1;
    }
    if (!lod?.resolveTier) {
      this.predictionLodCells.clear();
    }

    // Frame-rate independent blend factors (driven by drift mode half-lives)
    const preset = getDriftPreset(getDriftMode());
    this.drainQueuedProjectileSpawns(performance.now());
    if (lod) {
      const rich = Math.max(0, lod.richDistance);
      const simple = Math.max(0, lod.simpleDistance);
      const mass = Math.max(0, lod.massDistance);
      const impostor = Math.max(0, lod.impostorDistance);
      this.predictionLodCellSize = normalizeLodCellSize(lod.cellSize);
      this.predictionRichDistanceSq = rich * rich;
      this.predictionSimpleDistanceSq = simple * simple;
      this.predictionMassDistanceSq = mass * mass;
      this.predictionImpostorDistanceSq = impostor * impostor;
    } else {
      this.predictionRichDistanceSq = 0;
      this.predictionSimpleDistanceSq = 0;
      this.predictionMassDistanceSq = 0;
      this.predictionImpostorDistanceSq = 0;
      this.predictionLodCellSize = 1;
    }

    this.forceFieldsEnabledForPrediction = this.serverMeta?.forceFieldsEnabled ?? true;

    let beamPathsChanged = false;
    for (const id of this.activeBeamPathIds) {
      const entity = this.entities.get(id);
      if (!entity?.projectile || !isLineProjectileEntity(entity)) {
        this.activeBeamPathIds.delete(id);
        this.beamPathTargets.delete(id);
        continue;
      }

      entity.projectile.timeAlive += deltaMs;
      if (
        Number.isFinite(entity.projectile.maxLifespan) &&
        entity.projectile.timeAlive > entity.projectile.maxLifespan + 1000
      ) {
        this.deleteEntityLocalState(entity.id);
        beamPathsChanged = true;
        continue;
      }

      const beamTarget = this.beamPathTargets.get(id);
      if (beamTarget && this.applyBeamPathPrediction(entity, beamTarget, deltaMs, preset)) {
        beamPathsChanged = true;
      }
    }
    if (beamPathsChanged) this.markLineProjectilesChanged();

    // Buildings are intentionally absent here. They are static actor
    // graphs and their network transform is snapped when snapshots are
    // applied, so the render frame should spend prediction time only on
    // units that are still correcting/moving and live shots.
    for (const id of this.activeUnitPredictionIds) {
      const entity = this.entities.get(id);
      if (!entity?.unit) {
        this.activeUnitPredictionIds.delete(id);
        continue;
      }

      const target = this.serverTargets.get(id);
      this.applyUnitVisualPrediction(entity, target, deltaMs, preset);
      this.dirtyUnitRenderIds.add(id);
      if (entity.turrets && entity.turrets.length > 0) {
        const predictionTier = this.resolvePredictionLodTier(entity, lod);
        const predictionStride = this.predictionFrameStrideForTier(predictionTier, entity, lod);
        const predictionStep = this.consumePredictionDeltaMs(entity, deltaMs, predictionStride);
        if (predictionStep) this.applyUnitExpensivePrediction(entity, target, predictionStep, preset);
      }

      if (this.unitPredictionIsSettled(entity, target)) {
        this.activeUnitPredictionIds.delete(id);
      }
    }

    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.entities.get(id);
      if (!entity?.projectile) {
        this.activeProjectilePredictionIds.delete(id);
        continue;
      }

      const target = this.serverTargets.get(id);
      const predictionTier = this.resolvePredictionLodTier(entity, lod);
      const predictionStride = this.predictionFrameStrideForTier(predictionTier, entity, lod);
      const predictionStep = this.consumePredictionDeltaMs(entity, deltaMs, predictionStride);
      if (predictionStep === null) continue;

      const entityDeltaMs = predictionStep.entityDeltaMs;
      const dt = entityDeltaMs / 1000;
      const targetDt = predictionStep.targetDeltaMs / 1000;
      const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
      const movVelDrift = halfLifeBlend(dt, preset.movement.vel);

      if (isLineShotType(entity.projectile.projectileType)) {
        this.activeBeamPathIds.add(id);
        this.activeProjectilePredictionIds.delete(id);
      } else {
        // Homing steering — 3D velocity rotation toward the target,
        // identical math to the server's projectileSystem call so
        // predicted and authoritative paths agree frame-for-frame.
        // Rocket-class shots (ignoresGravity=true) also re-acquire
        // the nearest enemy when their original target dies —
        // mirrors the server's seeker behavior so the predicted
        // trajectory matches until the server's next velocity-
        // update snapshot.
        const proj = entity.projectile;
        if (proj.homingTargetId !== undefined) {
          let homingTarget = this.entities.get(proj.homingTargetId);
          let targetValid = !!(homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0)));
          if (!targetValid) {
            const shotCfg = proj.config.shot;
            const isRocket = isRocketLikeShot(shotCfg);
            if (isRocket && entity.ownership) {
              homingTarget = this.findNearestEnemyForRocketClient(entity, entity.ownership.playerId) ?? undefined;
              if (homingTarget) {
                proj.homingTargetId = homingTarget.id;
                targetValid = true;
              } else {
                proj.homingTargetId = undefined;
              }
            } else {
              proj.homingTargetId = undefined;
            }
          }
          if (targetValid && homingTarget) {
            const aimPoint = resolveTargetAimPoint(
              homingTarget,
              entity.transform.x, entity.transform.y, entity.transform.z,
              _clientHomingAimPoint,
            );
            let steerX = aimPoint.x;
            let steerY = aimPoint.y;
            let steerZ = aimPoint.z;
            const targetVelocity = getEntityVelocity3(homingTarget, _clientHomingTargetVelocity);
            const targetSpeedSq =
              targetVelocity.x * targetVelocity.x +
              targetVelocity.y * targetVelocity.y +
              targetVelocity.z * targetVelocity.z;
            const projectileSpeed = Math.hypot(proj.velocityX, proj.velocityY, proj.velocityZ);
            if (targetSpeedSq > 1e-6 && projectileSpeed > 1e-6) {
              const tLead = computeInterceptTime(
                steerX - entity.transform.x,
                steerY - entity.transform.y,
                steerZ - entity.transform.z,
                targetVelocity.x, targetVelocity.y, targetVelocity.z,
                projectileSpeed,
              );
              if (tLead > 0) {
                const remainingSec = Number.isFinite(proj.maxLifespan)
                  ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
                  : tLead;
                const leadT = remainingSec > 0 ? Math.min(tLead, remainingSec) : tLead;
                steerX += targetVelocity.x * leadT;
                steerY += targetVelocity.y * leadT;
                steerZ += targetVelocity.z * leadT;
              }
            }
            const steered = applyHomingSteering(
              proj.velocityX, proj.velocityY, proj.velocityZ,
              steerX, steerY, steerZ,
              entity.transform.x, entity.transform.y, entity.transform.z,
              proj.homingTurnRate ?? 0, dt,
            );
            proj.velocityX = steered.velocityX;
            proj.velocityY = steered.velocityY;
            proj.velocityZ = steered.velocityZ;
            entity.transform.rotation = steered.rotation;
          }
        }
        // Drift projectile position + velocity toward server target
        // (smooth correction). Z is drifted too now that server
        // velocity updates carry a vz — homing corrections in the
        // vertical axis propagate instead
        // of being lost.
        //
        // The server only emits velocity-update events on homing /
        // knockback, NOT on gravity decay. So `target.velocityZ`
        // would stay frozen at the launch vz between updates; the
        // lerp below would then pull `proj.velocityZ` back up to
        // launch vz every tick, fighting against the local gravity
        // application a few lines down. Apply gravity to the target
        // here so the extrapolated drift target decays exactly the
        // way the server's authoritative state does — high-arc
        // shells stop flying up forever.
        const terrainFollow = entity.dgunProjectile?.terrainFollow === true;
        const groundOffset = entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT;
        if (target) {
          const targetShotCfg = entity.projectile.config.shot;
          const targetIgnoresGravity = isRocketLikeShot(targetShotCfg);
          if (!targetIgnoresGravity && !terrainFollow) {
            target.velocityZ -= GRAVITY * targetDt;
          }
          const targetPrevZ = target.z;
          target.x += target.velocityX * targetDt;
          target.y += target.velocityY * targetDt;
          if (terrainFollow) {
            const nextZ = getSurfaceHeight(target.x, target.y, this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE) + groundOffset;
            target.velocityZ = targetDt > 0 ? (nextZ - targetPrevZ) / targetDt : 0;
            target.z = nextZ;
          } else {
            target.z += target.velocityZ * targetDt;
          }
          entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
          entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
          entity.transform.z = lerp(entity.transform.z, target.z, movPosDrift);
          proj.velocityX = lerp(proj.velocityX, target.velocityX, movVelDrift);
          proj.velocityY = lerp(proj.velocityY, target.velocityY, movVelDrift);
          proj.velocityZ = lerp(proj.velocityZ, target.velocityZ, movVelDrift);
          entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
        }

        // Traveling projectiles: dead-reckon using (possibly steered)
        // velocity in full 3D. Ballistic projectiles take gravity;
        // rockets (shot.ignoresGravity) travel on pure thrust and
        // are bent only by homing — mirrors the server path so
        // predicted arcs match authoritative arcs.
        const shotCfg = entity.projectile.config.shot;
        const ignoresGravity = isRocketLikeShot(shotCfg);
        const prevTerrainFollowZ = entity.transform.z;
        if (!ignoresGravity && !terrainFollow) {
          entity.projectile.velocityZ -= GRAVITY * dt;
        }
        entity.transform.x += entity.projectile.velocityX * dt;
        entity.transform.y += entity.projectile.velocityY * dt;
        if (terrainFollow) {
          const nextZ = getSurfaceHeight(entity.transform.x, entity.transform.y, this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE) + groundOffset;
          entity.projectile.velocityZ = dt > 0 ? (nextZ - prevTerrainFollowZ) / dt : 0;
          entity.transform.z = nextZ;
        } else {
          entity.transform.z += entity.projectile.velocityZ * dt;
        }
        // Terrain impact is terminal for traveling projectiles on the
        // server. Do the same in client prediction: the old clamp kept
        // the shell alive with horizontal velocity until the despawn
        // side-channel arrived, which made fast falling rounds visibly
        // skate along the ground for one frame.
        const groundZ = getSurfaceHeight(entity.transform.x, entity.transform.y, this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE);
        if (!terrainFollow && entity.transform.z <= groundZ && entity.projectile.velocityZ <= 0) {
          entity.transform.z = groundZ;
          this.deleteEntityLocalState(entity.id);
          continue;
        }

        // Auto-remove if projectile has left the map bounds
        entity.projectile.timeAlive += entityDeltaMs;
        if (entity.projectile.timeAlive > (entity.projectile.maxLifespan ?? 10000)) {
          this.deleteEntityLocalState(entity.id);
        }
      }
    }
  }

  /** Find the closest live enemy (unit or building) within rocket
   *  seeker range. Mirrors the server's findNearestEnemyForRocket so
   *  a rocket whose target dies mid-flight re-locks onto the same
   *  fallback target on both sides — keeps predicted + authoritative
   *  trajectories from diverging until the server's next velocity
   *  update. */
  private findNearestEnemyForRocketClient(
    proj: Entity,
    ownerId: PlayerId,
  ): Entity | null {
    const ROCKET_REACQUIRE_RANGE_SQ = 800 * 800;
    // Per-frame enemy cache. The first rocket to lose target walks
    // the entity map and collects every living enemy; any further
    // rockets from the same player that lose target this frame reuse
    // the same list. Rebuilt if the frame counter OR the requesting
    // owner changed (different player → different enemy set).
    if (
      this._rocketEnemyCacheFrame !== this.frameCounter ||
      this._rocketEnemyCacheOwnerId !== ownerId
    ) {
      const list = this._rocketEnemyCache;
      list.length = 0;
      const units = this.getUnits();
      for (let i = 0; i < units.length; i++) {
        const e = units[i];
        if (e.ownership?.playerId === undefined || e.ownership.playerId === ownerId) continue;
        if (!e.unit || e.unit.hp <= 0) continue;
        list.push(e);
      }
      const buildings = this.getBuildings();
      for (let i = 0; i < buildings.length; i++) {
        const e = buildings[i];
        if (e.ownership?.playerId === undefined || e.ownership.playerId === ownerId) continue;
        if (!e.building || e.building.hp <= 0) continue;
        list.push(e);
      }
      this._rocketEnemyCacheFrame = this.frameCounter;
      this._rocketEnemyCacheOwnerId = ownerId;
    }

    let nearest: Entity | null = null;
    let nearestDistSq = ROCKET_REACQUIRE_RANGE_SQ;
    for (const e of this._rocketEnemyCache) {
      const dx = e.transform.x - proj.transform.x;
      const dy = e.transform.y - proj.transform.y;
      const dz = e.transform.z - proj.transform.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = e;
      }
    }
    return nearest;
  }

  /**
   * Create a full Entity from a projectile spawn event.
   * For traveling/dgun projectiles, adjusts spawn position to the client-side muzzle
   * so bullets visually originate from the gun (same approach as beams).
   */
  private createProjectileFromSpawn(
    spawn: NetworkServerSnapshotProjectileSpawn,
  ): Entity {
    const sourceTurretId = decodeProjectileSourceTurretId(spawn);
    const shotId = decodeProjectileShotId(spawn);
    const config = {
      ...getProjectileConfigForSpawn(sourceTurretId, shotId, spawn.turretIndex),
      turretIndex: spawn.turretIndex,
    };

    // Default to server position; override with client-side muzzle if source is available
    let spawnX = spawn.pos.x;
    let spawnY = spawn.pos.y;
    // z always comes from the server — the wire carries it. Beam
    // endpoints (beam.start.z / end.z) also come across the wire, so
    // lasers/beams render at their real altitude too.
    let spawnZ = spawn.pos.z;

    // Projectiles that came from the shooter's own turret (i.e. NOT
    // parent-detonation submunitions) get their spawn position nudged
    // onto the client's local muzzle tip. This hides any small latency
    // drift between the server snapshot and the client's render of the
    // source unit — without it, a shot would pop at the server's
    // slightly-stale position and then the projectile would race to
    // catch up with the visibly-moved barrel cluster. We delegate the
    // turret-rotation chain (unit yaw → turret yaw+pitch) to the shared
    // primitive, including the server's barrelIndex, so multi-barrel
    // shots are corrected to the same physical muzzle on both sides.
    if (
      !isLineProjectileTypeCode(spawn.projectileType) &&
      !spawn.fromParentDetonation
    ) {
      const source = this.entities.get(spawn.sourceEntityId);
      const weapon = source?.turrets?.[spawn.turretIndex];
      if (source && source.unit && weapon) {
        const unitCos = Math.cos(source.transform.rotation);
        const unitSin = Math.sin(source.transform.rotation);
        // Same canonical mount math as the sim's targeting path.
        const sn = getSurfaceNormal(
          source.transform.x, source.transform.y,
          this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE,
        );
        const unitGroundZ = getUnitGroundZ(source);
        const mount = getTurretWorldMount(
          source.transform.x, source.transform.y, unitGroundZ,
          unitCos, unitSin,
          weapon.mount.x, weapon.mount.y, getTurretMountHeight(source, spawn.turretIndex),
          sn,
        );
        const tip = getBarrelTip(
          mount.x, mount.y, mount.z,
          weapon.rotation, weapon.pitch,
          config,
          spawn.barrelIndex,
        );
        spawnX = tip.x;
        spawnY = tip.y;
        spawnZ = tip.z;
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
        shotId: shotId ?? config.shot.id,
        sourceTurretId: sourceTurretId ?? config.sourceTurretId,
        projectileType: (() => {
          const projectileType = codeToProjectileType(spawn.projectileType);
          if (!projectileType) throw new Error(`Unknown projectile type code: ${spawn.projectileType}`);
          return projectileType;
        })(),
        velocityX: spawn.velocity.x,
        velocityY: spawn.velocity.y,
        velocityZ: spawn.velocity.z,
        timeAlive: 0,
        maxLifespan: spawn.maxLifespan ?? getShotMaxLifespan(config.shot),
        hitEntities: new Set(),
        maxHits: 1,
        points: spawn.beam ? [
          {
            x: spawn.beam.start.x, y: spawn.beam.start.y, z: spawn.beam.start.z,
            vx: 0, vy: 0, vz: 0,
          },
          {
            x: spawn.beam.end.x, y: spawn.beam.end.y, z: spawn.beam.end.z,
            vx: 0, vy: 0, vz: 0,
          },
        ] : undefined,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = {
        isDGun: true,
        terrainFollow: true,
        groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
      };
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

  getEntitySetVersion(): number {
    return this.entitySetVersion;
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getAll();
  }

  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnits();
  }

  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsByPlayer(playerId);
  }

  collectActiveUnitRenderEntities(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeUnitPredictionIds) {
      const entity = this.entities.get(id);
      if (entity?.unit) out.push(entity);
    }
    for (const id of this.dirtyUnitRenderIds) {
      if (this.activeUnitPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity?.unit) out.push(entity);
    }
    this.dirtyUnitRenderIds.clear();
    return out;
  }

  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildings();
  }

  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildingsByPlayer(playerId);
  }

  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getProjectiles();
  }

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getTravelingProjectiles();
  }

  getSmokeTrailProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getSmokeTrailProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getLineProjectiles();
  }

  collectTravelingProjectiles(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.entities.get(id);
      if (entity?.projectile?.projectileType === 'projectile') out.push(entity);
    }
    return out;
  }

  collectSmokeTrailProjectiles(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.entities.get(id);
      const shot = entity?.projectile?.config.shot;
      if (entity?.projectile?.projectileType === 'projectile' && shot && isProjectileShot(shot) && shot.smokeTrail) {
        out.push(entity);
      }
    }
    return out;
  }

  collectLineProjectiles(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeBeamPathIds) {
      const entity = this.entities.get(id);
      if (entity?.projectile && isLineProjectileEntity(entity)) out.push(entity);
    }
    return out;
  }

  collectBurnMarkProjectiles(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeBeamPathIds) {
      const entity = this.entities.get(id);
      if (entity?.projectile && isLineProjectileEntity(entity)) out.push(entity);
    }
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.entities.get(id);
      if (entity?.projectile?.projectileType === 'projectile' && entity.dgunProjectile?.isDGun) {
        out.push(entity);
      }
    }
    return out;
  }

  getLineProjectileRenderVersion(): number {
    return this.lineProjectileRenderVersion;
  }

  getForceFieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getForceFieldUnits();
  }

  getDamagedUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDamagedUnits();
  }

  getHealthBarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHealthBarBuildings();
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
    // Reuse the existing Set rather than replacing it — consumers
    // (including the `selectedIds` getter below) hold a stable
    // reference across selection changes.
    this.selectedIds.clear();
    for (const id of ids) this.selectedIds.add(id);
    for (const entity of this.entities.values()) {
      if (entity.selectable) {
        const selected = this.selectedIds.has(entity.id);
        if (entity.selectable.selected !== selected && entity.unit) {
          this.dirtyUnitRenderIds.add(entity.id);
        }
        entity.selectable.selected = selected;
        if (selected) this.markEntityPredictionActive(entity);
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
      if (!entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
      entity.selectable.selected = true;
      this.markEntityPredictionActive(entity);
    }
  }

  deselectEntity(id: EntityId): void {
    this.selectedIds.delete(id);
    const entity = this.entities.get(id);
    if (entity?.selectable) {
      if (entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
      entity.selectable.selected = false;
    }
  }

  clearSelection(): void {
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (entity?.selectable) {
        if (entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
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

      const radius = entity.unit?.radius.body ?? 15;
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

  private acquireCaptureTile(
    cx: number,
    cy: number,
    heights: NetworkCaptureTile['heights'] | undefined,
  ): NetworkCaptureTile {
    const tile = this.captureTilePool.pop() ?? { cx: 0, cy: 0, heights: {} };
    tile.cx = cx;
    tile.cy = cy;
    const dst = tile.heights;
    for (const key in dst) delete dst[key];
    if (heights) {
      for (const key in heights) dst[Number(key)] = heights[key];
    }
    return tile;
  }

  private releaseCaptureTile(tile: NetworkCaptureTile): void {
    for (const key in tile.heights) delete tile.heights[key];
    this.captureTilePool.push(tile);
  }

  private clearCaptureTileMaps(): void {
    for (const [key, tile] of this.captureDirtyTileMap) {
      if (this.captureTileMap.get(key) !== tile) this.releaseCaptureTile(tile);
    }
    this.captureDirtyTileMap.clear();
    for (const tile of this.captureTileMap.values()) this.releaseCaptureTile(tile);
    this.captureTileMap.clear();
    this.captureTilesCache.length = 0;
    this.captureDirtyTilesScratch.length = 0;
  }

  getCaptureTiles(): NetworkCaptureTile[] {
    if (this.captureTilesDirty) {
      this.captureTilesCache.length = 0;
      for (const tile of this.captureTileMap.values()) {
        this.captureTilesCache.push(tile);
      }
      this.captureTilesDirty = false;
    }
    return this.captureTilesCache;
  }

  consumeCaptureTileChanges(): {
    version: number;
    full: boolean;
    tiles: NetworkCaptureTile[];
  } {
    if (this.captureFullDirty) {
      this.captureFullDirty = false;
      this.captureDirtyTileMap.clear();
      return {
        version: this.captureVersion,
        full: true,
        tiles: this.getCaptureTiles(),
      };
    }

    if (this.captureDirtyTileMap.size === 0) {
      return {
        version: this.captureVersion,
        full: false,
        tiles: [],
      };
    }

    const tiles = this.captureDirtyTilesScratch;
    tiles.length = 0;
    for (const tile of this.captureDirtyTileMap.values()) {
      tiles.push(tile);
    }
    this.captureDirtyTileMap.clear();
    return {
      version: this.captureVersion,
      full: false,
      tiles,
    };
  }

  getCaptureCellSize(): number {
    return this.captureCellSize;
  }

  getCaptureVersion(): number {
    return this.captureVersion;
  }

  getServerMeta(): NetworkServerSnapshotMeta | null {
    return this.serverMeta;
  }

  clear(): void {
    this.entities.clear();
    this.serverTargets.clear();
    this.beamPathTargets.clear();
    for (let i = 0; i < this.projectileSpawnQueue.length; i++) {
      this.releaseQueuedProjectileSpawn(this.projectileSpawnQueue[i]);
    }
    this.projectileSpawnQueue.length = 0;
    this.projectileSpawnSnapshotTime = 0;
    this.projectileSpawnSnapshotInterval = 100;
    this.sprayTargets = [];
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.gameOverWinnerId = null;
    this.selectedIds.clear();
    this.gridCells = [];
    this.gridSearchCells = [];
    this.gridCellSize = 0;
    this.clearCaptureTileMaps();
    this.captureFullDirty = true;
    this.captureTilesDirty = true;
    this.captureVersion++;
    this.captureCellSize = 0;
    this.serverMeta = null;
    this.frameCounter = 0;
    this.predictionAccums.clear();
    this.predictionLodCells.clear();
    this.activeUnitPredictionIds.clear();
    this.activeProjectilePredictionIds.clear();
    this.activeBeamPathIds.clear();
    this.dirtyUnitRenderIds.clear();
    this.entitySetVersion++;
    this.invalidateCaches();
  }
}
