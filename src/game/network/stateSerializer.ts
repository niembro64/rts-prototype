import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity, NetworkServerSnapshotEconomy, NetworkServerSnapshotSprayTarget, NetworkServerSnapshotSimEvent, NetworkServerSnapshotProjectileSpawn, NetworkServerSnapshotProjectileDespawn, NetworkServerSnapshotVelocityUpdate, NetworkServerSnapshotGridCell, NetworkServerSnapshotTurret, NetworkServerSnapshotAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { Vec2 } from '../../types/vec2';
import type { GamePhase } from '../../types/network';
import {
  ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP, ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY,
  actionTypeToCode, turretStateToCode,
} from '../../types/network';
import { SNAPSHOT_CONFIG } from '../../config';

// === Object pool for NetworkServerSnapshotEntity (eliminates per-frame allocations) ===
// Each frame we reset the pool index and overwrite existing objects.

const INITIAL_ENTITY_POOL = 200; // MAX_TOTAL_UNITS (120) + buildings + headroom
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;

// Pre-allocated weapon objects per entity slot
function createPooledTurret(): NetworkServerSnapshotTurret {
  return {
    turret: {
      id: '',
      ranges: { tracking: { acquire: 0, release: 0 }, engage: { acquire: 0, release: 0 } },
      angular: { rot: 0, vel: 0, acc: 0, drag: 0, pitch: 0 },
      pos: { offset: { x: 0, y: 0 } },
    },
    targetId: undefined,
    state: 0,
    currentForceFieldRange: undefined,
  };
}

function createPooledAction(): NetworkServerSnapshotAction {
  return { type: 0, pos: undefined, posZ: undefined, pathExp: undefined, targetId: undefined, buildingType: undefined, grid: undefined, buildingId: undefined };
}

function createPooledWaypoint(): { pos: Vec2; posZ?: number; type: string } {
  return { pos: { x: 0, y: 0 }, posZ: undefined, type: '' };
}

// Pre-allocated sub-objects for the nested NetworkServerSnapshotEntity shape
type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;
type ShotSub = NonNullable<NetworkServerSnapshotEntity['shot']>;

// Extended pool entry with pre-allocated sub-arrays and sub-objects
type PooledEntry = {
  entity: NetworkServerSnapshotEntity;
  unitSub: UnitSub;
  /** Persistent collider object reused across snapshots — unitSub.collider
   *  swaps between this and undefined depending on whether the entity
   *  needs a static-fields seed. */
  unitCollider: { scale: number; shot: number; push: number };
  /** Persistent building dim reused across snapshots — same swap rule. */
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  factorySub: FactorySub;
  shotSub: ShotSub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  waypoints: { pos: Vec2; posZ?: number; type: string }[];
  buildQueue: string[];
};

/** Position quantization: round to integer world units. The renderer
 *  clamps below 1 px anyway, the sim runs in floats, and JSON shaves
 *  3-6 chars per number off the wire. */
function qPos(n: number): number {
  return Math.round(n);
}

/** Velocity quantization: 1 decimal place (0.1 wu/s). Drift integration
 *  on the client uses this only for dead-reckoning between snapshots,
 *  so 0.1 wu/s precision (~1 cm/s) is well below visible jitter. */
function qVel(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Rotation quantization: ~0.001 rad (~0.06°). Below the threshold for
 *  visible turret jitter and saves several chars per rotation field. */
function qRot(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createPooledTurret());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createPooledAction());
  const waypoints: { pos: Vec2; posZ?: number; type: string }[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createPooledWaypoint());
  return {
    entity: { id: 0, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1 as PlayerId },
    unitSub: {
      unitType: undefined, hp: { curr: 0, max: 0 },
      collider: undefined,
      moveSpeed: undefined, mass: undefined, velocity: { x: 0, y: 0, z: 0 },
      turretRotation: 0,
    },
    unitCollider: { scale: 0, shot: 0, push: 0 },
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      type: undefined, dim: undefined, hp: { curr: 0, max: 0 },
      build: { progress: 0, complete: false },
    },
    factorySub: {
      queue: [], progress: 0, producing: false,
      waypoints: [],
    },
    shotSub: {
      type: '', source: 0,
    },
    turrets,
    actions,
    waypoints,
    buildQueue: [],
  };
}

const _pool: PooledEntry[] = [];
let _poolIndex = 0;

// Initialize pool
for (let i = 0; i < INITIAL_ENTITY_POOL; i++) {
  _pool.push(createPooledEntry());
}

function getPooledEntry(): PooledEntry {
  if (_poolIndex >= _pool.length) {
    _pool.push(createPooledEntry());
  }
  return _pool[_poolIndex++];
}

// === Delta change tracking ===
// Stores lightweight fingerprint of each entity from the previous snapshot.
// Compared against current state to detect changes.

type PrevEntityState = {
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  hp: number;
  actionCount: number;
  actionHash: number;       // cheap hash of action content (types + positions)
  isEngagedBits: number;    // bit-packed isEngaged for all weapons
  targetBits: number;       // bit-packed hasTarget for all weapons
  weaponCount: number;
  turretRots: number[];     // per-weapon turret rotation
  turretAngVels: number[];  // per-weapon angular velocity
  forceFieldRanges: number[]; // per-weapon force field range
  // building
  buildProgress: number;
  solarOpen: number;       // 0 or 1
  factoryProgress: number;
  isProducing: number;      // 0 or 1
  buildQueueLen: number;
};

function createPrevEntityState(): PrevEntityState {
  const turretRots: number[] = [];
  const turretAngVels: number[] = [];
  const forceFieldRanges: number[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) {
    turretRots.push(0);
    turretAngVels.push(0);
    forceFieldRanges.push(0);
  }
  return {
    x: 0, y: 0, rotation: 0,
    velocityX: 0, velocityY: 0,
    hp: 0, actionCount: 0, actionHash: 0,
    isEngagedBits: 0, targetBits: 0,
    weaponCount: 0, turretRots, turretAngVels, forceFieldRanges,
    buildProgress: 0, solarOpen: 0, factoryProgress: 0, isProducing: 0, buildQueueLen: 0,
  };
}

type DeltaTrackingState = {
  prevStates: Map<number, PrevEntityState>;
  prevEntityIds: Set<number>;
  currentEntityIds: Set<number>;
  protocolSeeded: Set<number>;
  prevStatePool: PrevEntityState[];
  prevStatePoolIndex: number;
};

function createDeltaTrackingState(): DeltaTrackingState {
  return {
    prevStates: new Map<number, PrevEntityState>(),
    prevEntityIds: new Set<number>(),
    currentEntityIds: new Set<number>(),
    protocolSeeded: new Set<number>(),
    prevStatePool: [],
    prevStatePoolIndex: 0,
  };
}

const DEFAULT_TRACKING_KEY = 'default';
const _trackingStates = new Map<string, DeltaTrackingState>();
const _removedIdsBuf: number[] = [];
const _dirtyEntityIdsBuf: EntityId[] = [];
const _dirtyEntityFieldsBuf: number[] = [];

const SNAPSHOT_DIRTY_FORCE_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_FACTORY;

/** Entities that have already had their static (never-changes-after-
 *  spawn) fields shipped at least once over this session's protocol.
 *  Delta snapshots use this to avoid re-sending unit type/collider,
 *  building type/dimensions, and turret static config after creation.
 *  Full keyframes remain self-contained so a client that missed an
 *  earlier keyframe can recover. */
function getTrackingKey(key: string | number | undefined): string {
  return key === undefined ? DEFAULT_TRACKING_KEY : String(key);
}

function getDeltaTrackingState(key: string | number | undefined): DeltaTrackingState {
  const trackingKey = getTrackingKey(key);
  let tracking = _trackingStates.get(trackingKey);
  if (!tracking) {
    tracking = createDeltaTrackingState();
    _trackingStates.set(trackingKey, tracking);
  }
  return tracking;
}

function getPrevState(tracking: DeltaTrackingState, entityId: number): PrevEntityState {
  let prev = tracking.prevStates.get(entityId);
  if (!prev) {
    if (tracking.prevStatePoolIndex < tracking.prevStatePool.length) {
      prev = tracking.prevStatePool[tracking.prevStatePoolIndex++];
    } else {
      prev = createPrevEntityState();
      tracking.prevStatePool.push(prev);
      tracking.prevStatePoolIndex++;
    }
    tracking.prevStates.set(entityId, prev);
  }
  return prev;
}

function getChangedFields(entity: Entity, prev: PrevEntityState, next: PrevEntityState): number {
  const posTh = SNAPSHOT_CONFIG.positionThreshold;
  const velTh = SNAPSHOT_CONFIG.velocityThreshold;
  const rotPosTh = SNAPSHOT_CONFIG.rotationPositionThreshold;
  const rotVelTh = SNAPSHOT_CONFIG.rotationVelocityThreshold;

  let mask = 0;

  if (Math.abs(next.x - prev.x) > posTh ||
      Math.abs(next.y - prev.y) > posTh) {
    mask |= ENTITY_CHANGED_POS;
  }
  if (Math.abs(next.rotation - prev.rotation) > rotPosTh) {
    mask |= ENTITY_CHANGED_ROT;
  }

  if (entity.unit) {
    if (Math.abs(next.velocityX - prev.velocityX) > velTh ||
        Math.abs(next.velocityY - prev.velocityY) > velTh) {
      mask |= ENTITY_CHANGED_VEL;
    }
    if (next.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    if (next.actionCount !== prev.actionCount || next.actionHash !== prev.actionHash) {
      mask |= ENTITY_CHANGED_ACTIONS;
    }

    if (entity.turrets) {
      if (next.weaponCount !== prev.weaponCount) {
        mask |= ENTITY_CHANGED_TURRETS;
      } else {
        // Once any turret has crossed a threshold the bit is set; we
        // still need to compute the engaged / target bitmasks for the
        // OTHER turrets on this unit (used as a dirty proxy below) so
        // we can't break out of the loop early — but we CAN skip the
        // 3-abs threshold check on subsequent turrets, which is the
        // expensive part. At many turrets per unit this halves the
        // work for active units (where any one turret moving means
        // the row will be sent anyway).
        let turretsAlreadyChanged = false;
        for (let i = 0; i < next.weaponCount; i++) {
          if (!turretsAlreadyChanged) {
            if (Math.abs(next.turretRots[i] - prev.turretRots[i]) > rotPosTh ||
                Math.abs(next.turretAngVels[i] - prev.turretAngVels[i]) > rotVelTh ||
                Math.abs(next.forceFieldRanges[i] - prev.forceFieldRanges[i]) > 0.001) {
              mask |= ENTITY_CHANGED_TURRETS;
              turretsAlreadyChanged = true;
            }
          }
        }
        if (next.isEngagedBits !== prev.isEngagedBits || next.targetBits !== prev.targetBits) {
          mask |= ENTITY_CHANGED_TURRETS;
        }
      }
    }
  }

  if (entity.building) {
    if (next.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    if (next.buildProgress !== prev.buildProgress || next.solarOpen !== prev.solarOpen) {
      mask |= ENTITY_CHANGED_BUILDING;
    }
    if (entity.factory) {
      if (next.factoryProgress !== prev.factoryProgress ||
          next.isProducing !== prev.isProducing ||
          next.buildQueueLen !== prev.buildQueueLen) {
        mask |= ENTITY_CHANGED_FACTORY;
      }
    }
  }

  return mask;
}

function captureEntityState(entity: Entity, prev: PrevEntityState): void {
  prev.x = entity.transform.x;
  prev.y = entity.transform.y;
  prev.rotation = entity.transform.rotation;
  prev.velocityX = entity.unit?.velocityX ?? 0;
  prev.velocityY = entity.unit?.velocityY ?? 0;
  prev.hp = entity.unit?.hp ?? entity.building?.hp ?? 0;
  {
    const actions = entity.unit?.actions;
    const count = actions?.length ?? 0;
    prev.actionCount = count;
    let hash = count;
    if (actions) {
      for (let i = 0; i < count; i++) {
        const a = actions[i];
        hash = (hash * 31 + a.x * 1000) | 0;
        hash = (hash * 31 + a.y * 1000) | 0;
        hash = (hash * 31 + (a.z !== undefined ? a.z * 1000 : 0)) | 0;
        hash = (hash * 31 + a.type.charCodeAt(0)) | 0;
      }
    }
    prev.actionHash = hash;
  }

  prev.isEngagedBits = 0;
  prev.targetBits = 0;
  prev.weaponCount = entity.turrets?.length ?? 0;
  if (entity.turrets) {
    // Grow turret arrays if needed
    while (prev.turretRots.length < entity.turrets.length) {
      prev.turretRots.push(0);
      prev.turretAngVels.push(0);
      prev.forceFieldRanges.push(0);
    }
    for (let i = 0; i < entity.turrets.length; i++) {
      const w = entity.turrets[i];
      if (w.state === 'engaged') prev.isEngagedBits |= (1 << i);
      if (w.target) prev.targetBits |= (1 << i);
      prev.turretRots[i] = w.rotation;
      prev.turretAngVels[i] = w.angularVelocity;
      prev.forceFieldRanges[i] = w.forceField?.range ?? 0;
    }
  }

  prev.buildProgress = entity.buildable?.buildProgress ?? 0;
  prev.solarOpen = entity.building?.solar?.open === false ? 0 : 1;
  prev.factoryProgress = entity.factory?.currentBuildProgress ?? 0;
  prev.isProducing = entity.factory?.isProducing ? 1 : 0;
  prev.buildQueueLen = entity.factory?.buildQueue.length ?? 0;
}

function copyPrevState(from: PrevEntityState, to: PrevEntityState): void {
  to.x = from.x;
  to.y = from.y;
  to.rotation = from.rotation;
  to.velocityX = from.velocityX;
  to.velocityY = from.velocityY;
  to.hp = from.hp;
  to.actionCount = from.actionCount;
  to.actionHash = from.actionHash;
  to.isEngagedBits = from.isEngagedBits;
  to.targetBits = from.targetBits;
  to.weaponCount = from.weaponCount;
  while (to.turretRots.length < from.weaponCount) {
    to.turretRots.push(0);
    to.turretAngVels.push(0);
    to.forceFieldRanges.push(0);
  }
  for (let i = 0; i < from.weaponCount; i++) {
    to.turretRots[i] = from.turretRots[i];
    to.turretAngVels[i] = from.turretAngVels[i];
    to.forceFieldRanges[i] = from.forceFieldRanges[i];
  }
  to.buildProgress = from.buildProgress;
  to.solarOpen = from.solarOpen;
  to.factoryProgress = from.factoryProgress;
  to.isProducing = from.isProducing;
  to.buildQueueLen = from.buildQueueLen;
}

const _nextStateScratch = createPrevEntityState();

/** Reset delta tracking state (call between game sessions). */
export function resetDeltaTracking(): void {
  _trackingStates.clear();
}

/** Force the next emitted snapshot to re-include static fields for
 *  every entity. Call when a new client joins mid-game so they get the
 *  full picture on their first keyframe; for single-host games this is
 *  not normally needed. */
export function resetProtocolSeeded(): void {
  for (const tracking of _trackingStates.values()) {
    tracking.protocolSeeded.clear();
  }
}

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _sprayBuf: NetworkServerSnapshotSprayTarget[] = [];
const _audioBuf: NetworkServerSnapshotSimEvent[] = [];
const _spawnBuf: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnBuf: NetworkServerSnapshotProjectileDespawn[] = [];
const _velUpdateBuf: NetworkServerSnapshotVelocityUpdate[] = [];
const _economyBuf: Record<PlayerId, NetworkServerSnapshotEconomy> = {} as Record<PlayerId, NetworkServerSnapshotEconomy>;
const _economyKeys: PlayerId[] = [];

// Pre-allocated sub-objects for nested fields (avoids per-frame allocation)
const _projectilesBuf: NonNullable<NetworkServerSnapshot['projectiles']> = {
  spawns: undefined,
  despawns: undefined,
  velocityUpdates: undefined,
};
const _gridBuf: NonNullable<NetworkServerSnapshot['grid']> = {
  cells: [],
  searchCells: [],
  cellSize: 0,
};
const _gameStateBuf: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

// Reusable snapshot object (avoids creating a new object literal every frame)
const _snapshotBuf: NetworkServerSnapshot = {
  tick: 0,
  entities: _entityBuf,
  economy: _economyBuf,
  sprayTargets: undefined,
  audioEvents: undefined,
  projectiles: undefined,
  gameState: undefined,
  grid: undefined,
  isDelta: false,
  removedEntityIds: undefined,
};

export type SnapshotInterest = (entity: Entity) => boolean;

export type SerializeGameStateOptions = {
  /**
   * Delta histories are per recipient. Without this, AOI-filtered
   * snapshots would leak prev-state/removal bookkeeping across players.
   */
  trackingKey?: string | number;
  dirtyEntityIds?: readonly EntityId[];
  dirtyEntityFields?: readonly number[];
  removedEntityIds?: readonly EntityId[];
  interest?: SnapshotInterest;
  /**
   * Entities that may have entered this recipient's interest set even if
   * they did not mutate this tick. Used to discover AOI entrants without
   * hashing the whole world in the serializer.
   */
  candidateEntityIds?: readonly EntityId[];
};

// Serialize WorldState to network format.
// When isDelta=true, only changed/new entities are included plus removedEntityIds.
// When isDelta=false (keyframe), all entities are included (same as before).
export function serializeGameState(
  world: WorldState,
  isDelta: boolean,
  gamePhase: GamePhase,
  winnerId?: PlayerId,
  sprayTargets?: SprayTarget[],
  audioEvents?: SimEvent[],
  projectileSpawns?: ProjectileSpawnEvent[],
  projectileDespawns?: ProjectileDespawnEvent[],
  projectileVelocityUpdates?: ProjectileVelocityUpdateEvent[],
  gridCells?: NetworkServerSnapshotGridCell[],
  gridSearchCells?: NetworkServerSnapshotGridCell[],
  gridCellSize?: number,
  options?: SerializeGameStateOptions
): NetworkServerSnapshot {
  const tracking = getDeltaTrackingState(options?.trackingKey);
  const interest = options?.interest;

  // Reset entity pool for this frame
  _poolIndex = 0;
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;
  const acceptsEntity = (entity: Entity): boolean =>
    (entity.type === 'unit' || entity.type === 'building') &&
    (!interest || interest(entity));

  const forgetTrackedEntity = (id: EntityId, emitRemoval: boolean): void => {
    const wasVisible = tracking.prevEntityIds.delete(id);
    tracking.prevStates.delete(id);
    tracking.protocolSeeded.delete(id);
    if (emitRemoval && wasVisible) {
      _removedIdsBuf.push(id);
    }
  };

  if (deltaEnabled) {
    const removedIds = options?.removedEntityIds;
    if (removedIds) {
      for (let i = 0; i < removedIds.length; i++) {
        forgetTrackedEntity(removedIds[i], true);
      }
    } else {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
      for (const id of _removedIdsBuf) {
        tracking.prevEntityIds.delete(id);
        tracking.prevStates.delete(id);
        // Clear seeded entry too — if the entity ID is reused later
        // we want the next full to re-seed its statics.
        tracking.protocolSeeded.delete(id);
      }
    }

    // AOI departures are client-local removals: the entity still exists
    // in the world, but this recipient should stop retaining it.
    if (interest) {
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity || !acceptsEntity(entity)) {
          forgetTrackedEntity(id, true);
        }
      }
    }

    const dirtyIds = options?.dirtyEntityIds;
    const dirtyFieldsList = options?.dirtyEntityFields;
    if (!dirtyIds) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }
    const sourceDirtyIds = dirtyIds ?? _dirtyEntityIdsBuf;
    const sourceDirtyFields = dirtyFieldsList ?? _dirtyEntityFieldsBuf;

    for (let i = 0; i < sourceDirtyIds.length; i++) {
      const entity = world.getEntity(sourceDirtyIds[i]);
      if (!entity || !acceptsEntity(entity)) continue;
      const dirtyFields = sourceDirtyFields[i] ?? 0;
      const prev = getPrevState(tracking, entity.id);
      const isNew = !tracking.prevEntityIds.has(entity.id);
      tracking.prevEntityIds.add(entity.id);
      captureEntityState(entity, _nextStateScratch);
      const changedFields = isNew
        ? undefined
        : getChangedFields(entity, prev, _nextStateScratch) |
          (dirtyFields & SNAPSHOT_DIRTY_FORCE_FIELDS);
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntity(entity, changedFields, tracking.protocolSeeded);
        if (netEntity) _entityBuf.push(netEntity);
        copyPrevState(_nextStateScratch, prev);
      }
    }

    // New AOI entrants may not be dirty (for example, an idle enemy that
    // became relevant because this player's front line moved). Candidate
    // lists let the server discover those without hashing every entity.
    if (interest && options?.candidateEntityIds) {
      for (let i = 0; i < options.candidateEntityIds.length; i++) {
        const id = options.candidateEntityIds[i];
        if (tracking.prevEntityIds.has(id)) continue;
        const entity = world.getEntity(id);
        if (!entity || !acceptsEntity(entity)) continue;
        tracking.prevEntityIds.add(id);
        const prev = getPrevState(tracking, id);
        captureEntityState(entity, prev);
        const netEntity = serializeEntity(entity, undefined, tracking.protocolSeeded);
        if (netEntity) _entityBuf.push(netEntity);
      }
    }
  } else {
    tracking.currentEntityIds.clear();
    for (const entity of world.getUnits()) {
      if (!acceptsEntity(entity)) continue;
      tracking.currentEntityIds.add(entity.id);
      const netEntity = serializeEntity(entity, undefined, tracking.protocolSeeded);
      if (netEntity) _entityBuf.push(netEntity);
      const prev = getPrevState(tracking, entity.id);
      captureEntityState(entity, prev);
    }
    for (const entity of world.getBuildings()) {
      if (!acceptsEntity(entity)) continue;
      tracking.currentEntityIds.add(entity.id);
      const netEntity = serializeEntity(entity, undefined, tracking.protocolSeeded);
      if (netEntity) _entityBuf.push(netEntity);
      const prev = getPrevState(tracking, entity.id);
      captureEntityState(entity, prev);
    }
    if (!options?.dirtyEntityIds) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }

    if (!options?.removedEntityIds) {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
    }

    // Update previous entity ID set for next frame
    tracking.prevEntityIds.clear();
    for (const id of tracking.currentEntityIds) {
      tracking.prevEntityIds.add(id);
    }
    // Clean up prevStates for entities that no longer exist or are
    // outside this recipient's AOI after a keyframe.
    for (const id of tracking.prevStates.keys()) {
      if (!tracking.currentEntityIds.has(id)) {
        tracking.prevStates.delete(id);
        tracking.protocolSeeded.delete(id);
      }
    }
  }

  // Serialize economy for all players (reuse object to avoid per-snapshot allocation)
  for (const key of _economyKeys) {
    delete _economyBuf[key];
  }
  _economyKeys.length = 0;
  for (let playerId = 1; playerId <= 6; playerId++) {
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (eco) {
      const pid = playerId as PlayerId;
      _economyKeys.push(pid);
      _economyBuf[pid] = {
        stockpile: { curr: eco.stockpile.curr, max: eco.stockpile.max },
        income: { base: eco.income.base, production: eco.income.production },
        expenditure: eco.expenditure,
        mana: {
          stockpile: { curr: eco.mana.stockpile.curr, max: eco.mana.stockpile.max },
          income: { base: eco.mana.income.base, territory: eco.mana.income.territory },
          expenditure: eco.mana.expenditure,
        },
      };
    }
  }

  // Serialize spray targets (reuse buffer)
  let netSprayTargets: NetworkServerSnapshotSprayTarget[] | undefined;
  if (sprayTargets && sprayTargets.length > 0) {
    _sprayBuf.length = 0;
    for (let i = 0; i < sprayTargets.length; i++) {
      const st = sprayTargets[i];
      _sprayBuf.push({
        source: { id: st.source.id, pos: st.source.pos, z: st.source.z, playerId: st.source.playerId },
        target: { id: st.target.id, pos: st.target.pos, z: st.target.z, dim: st.target.dim, radius: st.target.radius },
        type: st.type,
        intensity: st.intensity,
      });
    }
    netSprayTargets = _sprayBuf;
  }

  // Serialize audio events (reuse buffer)
  let netAudioEvents: NetworkServerSnapshotSimEvent[] | undefined;
  if (audioEvents && audioEvents.length > 0) {
    _audioBuf.length = 0;
    for (let i = 0; i < audioEvents.length; i++) {
      const ae = audioEvents[i];
      _audioBuf.push({
        type: ae.type,
        turretId: ae.turretId,
        pos: ae.pos,
        entityId: ae.entityId,
        deathContext: ae.deathContext,
        impactContext: ae.impactContext,
      });
    }
    netAudioEvents = _audioBuf;
  }

  // Serialize projectile spawns (reuse buffer)
  let netProjectileSpawns: NetworkServerSnapshotProjectileSpawn[] | undefined;
  if (projectileSpawns && projectileSpawns.length > 0) {
    _spawnBuf.length = 0;
    for (let i = 0; i < projectileSpawns.length; i++) {
      const ps = projectileSpawns[i];
      _spawnBuf.push({
        id: ps.id,
        pos: ps.pos, rotation: ps.rotation,
        velocity: ps.velocity,
        projectileType: ps.projectileType,
        maxLifespan: ps.maxLifespan,
        turretId: ps.turretId,
        playerId: ps.playerId,
        sourceEntityId: ps.sourceEntityId,
        turretIndex: ps.turretIndex,
        barrelIndex: ps.barrelIndex,
        isDGun: ps.isDGun,
        fromParentDetonation: ps.fromParentDetonation,
        beam: ps.beam,
        targetEntityId: ps.targetEntityId,
        homingTurnRate: ps.homingTurnRate,
      });
    }
    netProjectileSpawns = _spawnBuf;
  }

  // Serialize projectile despawns (reuse buffer)
  let netProjectileDespawns: NetworkServerSnapshotProjectileDespawn[] | undefined;
  if (projectileDespawns && projectileDespawns.length > 0) {
    _despawnBuf.length = 0;
    for (let i = 0; i < projectileDespawns.length; i++) {
      _despawnBuf.push({ id: projectileDespawns[i].id });
    }
    netProjectileDespawns = _despawnBuf;
  }

  // Serialize projectile velocity updates (reuse buffer)
  let netVelocityUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
  if (projectileVelocityUpdates && projectileVelocityUpdates.length > 0) {
    _velUpdateBuf.length = 0;
    for (let i = 0; i < projectileVelocityUpdates.length; i++) {
      const vu = projectileVelocityUpdates[i];
      _velUpdateBuf.push({ id: vu.id, pos: vu.pos, velocity: vu.velocity });
    }
    netVelocityUpdates = _velUpdateBuf;
  }

  // Nest projectile events (undefined when all empty)
  const hasProjectiles = netProjectileSpawns || netProjectileDespawns || netVelocityUpdates;
  if (hasProjectiles) {
    _projectilesBuf.spawns = netProjectileSpawns;
    _projectilesBuf.despawns = netProjectileDespawns;
    _projectilesBuf.velocityUpdates = netVelocityUpdates;
  }

  // Nest grid info (undefined when grid off)
  if (gridCells) {
    _gridBuf.cells = gridCells;
    _gridBuf.searchCells = gridSearchCells ?? [];
    _gridBuf.cellSize = gridCellSize ?? 0;
  }

  // Nest game state
  _gameStateBuf.phase = gamePhase;
  _gameStateBuf.winnerId = winnerId;

  // Reuse snapshot object
  _snapshotBuf.tick = world.getTick();
  _snapshotBuf.entities = _entityBuf;
  _snapshotBuf.economy = _economyBuf;
  _snapshotBuf.sprayTargets = netSprayTargets;
  _snapshotBuf.audioEvents = netAudioEvents;
  _snapshotBuf.projectiles = hasProjectiles ? _projectilesBuf : undefined;
  _snapshotBuf.gameState = _gameStateBuf;
  _snapshotBuf.grid = gridCells ? _gridBuf : undefined;
  _snapshotBuf.isDelta = deltaEnabled;
  _snapshotBuf.removedEntityIds = deltaEnabled && _removedIdsBuf.length > 0 ? _removedIdsBuf : undefined;

  return _snapshotBuf;
}

// Serialize a single entity using pooled objects (zero allocation).
// changedFields: undefined = full (keyframe/new entity), bitmask = only changed groups.
function serializeEntity(
  entity: Entity,
  changedFields: number | undefined,
  protocolSeeded: Set<number>,
): NetworkServerSnapshotEntity | null {
  const pool = getPooledEntry();
  const ne = pool.entity;
  const isFull = changedFields === undefined;

  // Base fields (always set)
  ne.id = entity.id;
  ne.type = entity.type;
  ne.playerId = entity.ownership?.playerId ?? 1 as PlayerId;
  if (isFull) {
    delete ne.changedFields;
  } else {
    ne.changedFields = changedFields;
  }

  // Position — always set for full, only when changed for delta.
  // z is on the wire so 3D clients see altitude; 2D clients ignore it.
  // Quantized to integer world units before going on the wire — keeps
  // JSON encodings short without affecting render precision.
  if (isFull || (changedFields & ENTITY_CHANGED_POS)) {
    ne.pos.x = qPos(entity.transform.x);
    ne.pos.y = qPos(entity.transform.y);
    ne.pos.z = qPos(entity.transform.z);
  }
  // Rotation — always set for full, only when changed for delta
  if (isFull || (changedFields & ENTITY_CHANGED_ROT)) {
    ne.rotation = qRot(entity.transform.rotation);
  }

  // Clear nested sub-objects (prevents stale data from previous frame leaking)
  ne.unit = undefined;
  ne.building = undefined;
  ne.shot = undefined;

  if (entity.type === 'unit' && entity.unit) {
    // Attach the unit sub-object on every delta this entity appears
    // in (any change at all). That way turret rotation can ship in
    // every diff snap, not just the ones where the turret crossed
    // its rotation threshold — keeps client-side turret aim smooth
    // even while the unit is mid-traverse below the change threshold.
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT;
    const hasUnitFields = isFull || (changedFields! & unitFieldMask);

    if (hasUnitFields) {
      const u = pool.unitSub;
      ne.unit = u;

      // Full records must be self-contained. Remote clients can miss
      // the first real-battle keyframe during lobby -> battle handoff;
      // if later keyframes omit unitType/collider/commander statics,
      // the client can never create those entities and renders an
      // empty battlefield even while snapshots keep arriving.
      if (isFull) {
        u.unitType = entity.unit.unitType;
        u.collider = pool.unitCollider;
        u.collider.scale = entity.unit.unitRadiusCollider.scale;
        u.collider.shot = entity.unit.unitRadiusCollider.shot;
        u.collider.push = entity.unit.unitRadiusCollider.push;
        u.moveSpeed = entity.unit.moveSpeed;
        u.mass = entity.unit.mass;
        u.isCommander = entity.commander !== undefined ? true : undefined;
        protocolSeeded.add(entity.id);
      } else {
        u.unitType = undefined;
        u.collider = undefined;
        u.moveSpeed = undefined;
        u.mass = undefined;
        u.isCommander = undefined;
      }

      // Velocity — full keyframes always carry it; on deltas it ships
      // when ENTITY_CHANGED_VEL is set (velocity moved more than the
      // threshold). Quantized to 0.1 wu/s for shorter JSON.
      if (isFull || (changedFields! & ENTITY_CHANGED_VEL)) {
        u.velocity.x = qVel(entity.unit.velocityX ?? 0);
        u.velocity.y = qVel(entity.unit.velocityY ?? 0);
        u.velocity.z = qVel(entity.unit.velocityZ ?? 0);
      }

      // HP
      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        u.hp.curr = entity.unit.hp;
        u.hp.max = entity.unit.maxHp;
      }

      // Turret rotation ships only on full records or turret-dirty
      // deltas. Active combat units mark ENTITY_CHANGED_TURRETS every
      // tick; idle movers no longer resend turret pose just because
      // their body position/velocity changed.
      u.turretRotation = undefined;
      if (isFull || (changedFields! & ENTITY_CHANGED_TURRETS)) {
        let turretRot = entity.transform.rotation;
        const weapons = entity.turrets ?? [];
        for (const weapon of weapons) {
          turretRot = weapon.rotation;
        }
        u.turretRotation = qRot(turretRot);
      }

      // Actions
      u.actions = undefined;
      if (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS)) {
        if (entity.unit.actions && entity.unit.actions.length > 0) {
          const actions = entity.unit.actions;
          const count = actions.length;
          while (pool.actions.length < count) pool.actions.push(createPooledAction());
          pool.actions.length = count;
          for (let i = 0; i < count; i++) {
            const src = actions[i];
            const dst = pool.actions[i];
            dst.type = actionTypeToCode(src.type);
            dst.pos = src.x !== undefined ? { x: src.x, y: src.y } : undefined;
            // src.z is the click-derived altitude (or terrain sample
            // for path-expanded intermediates) — ship it so joining
            // clients render dots at the same altitude as the issuing
            // client, no terrain re-sample needed.
            dst.posZ = src.z;
            // Only send the flag when true — saves bytes; clients
            // treat undefined as false.
            dst.pathExp = src.isPathExpansion ? true : undefined;
            dst.targetId = src.targetId;
            dst.buildingType = src.buildingType;
            dst.grid = src.gridX !== undefined ? { x: src.gridX, y: src.gridY! } : undefined;
            dst.buildingId = src.buildingId;
          }
          u.actions = pool.actions;
        }
      }

      // Turrets. Full records seed the client; deltas only carry this
      // array when combat actually dirtied turret state. This keeps
      // large armies moving without serializing every idle turret.
      u.turrets = undefined;
      if (entity.turrets && entity.turrets.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        const weapons = entity.turrets;
        const count = weapons.length;
        while (pool.turrets.length < count) pool.turrets.push(createPooledTurret());
        pool.turrets.length = count;
        for (let i = 0; i < count; i++) {
          const src = weapons[i];
          const dst = pool.turrets[i];
          const t = dst.turret;
          t.id = src.config.id;
          const sr = src.ranges; const dr = t.ranges;
          dr.tracking.acquire = sr.tracking.acquire; dr.tracking.release = sr.tracking.release;
          dr.engage.acquire = sr.engage.acquire; dr.engage.release = sr.engage.release;
          t.angular.rot = qRot(src.rotation);
          t.angular.vel = qRot(src.angularVelocity);
          t.angular.acc = src.turnAccel;
          t.angular.drag = src.drag;
          t.angular.pitch = qRot(src.pitch);
          t.pos.offset.x = src.offset.x;
          t.pos.offset.y = src.offset.y;
          dst.targetId = src.target ?? undefined;
          dst.state = turretStateToCode(src.state);
          dst.currentForceFieldRange = src.forceField?.range;
        }
        u.turrets = pool.turrets;
      }

      // Serialize builder state (commander)
      u.buildTargetId = undefined;
      if (entity.builder) {
        u.buildTargetId = entity.builder.currentBuildTarget ?? undefined;
      }
    }
  }

  if (entity.type === 'building' && entity.building) {
    // Determine which building-specific field groups changed
    const buildingFieldMask = ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING | ENTITY_CHANGED_FACTORY;
    const hasBuildingFields = isFull || (changedFields! & buildingFieldMask);

    // Only attach building sub-object when at least one building field changed
    if (hasBuildingFields) {
      const b = pool.buildingSub;
      ne.building = b;
      b.solar = undefined;

      // Full records must be self-contained for the same reason as
      // unit records: clients can miss the first keyframe during a
      // network handoff and still need later keyframes to create
      // every entity from scratch.
      if (isFull) {
        b.dim = pool.buildingDim;
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.type = entity.buildingType ?? '';
        protocolSeeded.add(entity.id);
      } else {
        b.dim = undefined;
        b.type = undefined;
      }

      // HP
      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        b.hp.curr = entity.building.hp;
        b.hp.max = entity.building.maxHp;
      }

      // Build progress
      if (isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) {
        if (entity.buildable) {
          b.build.progress = entity.buildable.buildProgress;
          b.build.complete = entity.buildable.isComplete;
        } else {
          b.build.progress = 1;
          b.build.complete = true;
        }
        if (entity.building.solar) {
          const s = pool.solarSub;
          s.open = entity.building.solar.open;
          b.solar = s;
        }
      }

      // Factory
      b.factory = undefined;
      if (isFull || (changedFields! & ENTITY_CHANGED_FACTORY)) {
      if (entity.factory) {
        const f = pool.factorySub;
        b.factory = f;

        const srcQueue = entity.factory.buildQueue;
        pool.buildQueue.length = srcQueue.length;
        for (let i = 0; i < srcQueue.length; i++) {
          pool.buildQueue[i] = srcQueue[i];
        }
        f.queue = pool.buildQueue;

        f.progress = entity.factory.currentBuildProgress;
        f.producing = entity.factory.isProducing;

        // waypoints[0] = rally point, rest = user-set waypoints
        const wps = entity.factory.waypoints;
        const wpCount = 1 + wps.length;
        while (pool.waypoints.length < wpCount) pool.waypoints.push(createPooledWaypoint());
        pool.waypoints.length = wpCount;
        pool.waypoints[0].pos.x = entity.factory.rallyX;
        pool.waypoints[0].pos.y = entity.factory.rallyY;
        pool.waypoints[0].posZ = undefined;
        pool.waypoints[0].type = 'move';
        for (let i = 0; i < wps.length; i++) {
          pool.waypoints[i + 1].pos.x = wps[i].x;
          pool.waypoints[i + 1].pos.y = wps[i].y;
          pool.waypoints[i + 1].posZ = wps[i].z;
          pool.waypoints[i + 1].type = wps[i].type;
        }
        f.waypoints = pool.waypoints;
      }
    }
    }
  }

  return ne;
}
