import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity, NetworkServerSnapshotEconomy, NetworkServerSnapshotSprayTarget, NetworkServerSnapshotSimEvent, NetworkServerSnapshotProjectileSpawn, NetworkServerSnapshotProjectileDespawn, NetworkServerSnapshotVelocityUpdate, NetworkServerSnapshotGridCell, NetworkServerSnapshotTurret, NetworkServerSnapshotAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { Vec2 } from '../../types/vec2';
import type { GamePhase } from '../../types/network';
import {
  ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_HP, ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY,
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
    state: 'idle',
    currentForceFieldRange: undefined,
  };
}

function createPooledAction(): NetworkServerSnapshotAction {
  return { type: '', pos: undefined, targetId: undefined, buildingType: undefined, grid: undefined, buildingId: undefined };
}

function createPooledWaypoint(): { pos: Vec2; type: string } {
  return { pos: { x: 0, y: 0 }, type: '' };
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
  /** Persistent velocity object the pool reuses across snapshots.
   *  unitSub.velocity points at this on full records and is left
   *  undefined on deltas — without a separate field we'd lose the
   *  pooled allocation the moment we set unitSub.velocity = undefined. */
  unitVel: { x: number; y: number; z: number };
  buildingSub: BuildingSub;
  factorySub: FactorySub;
  shotSub: ShotSub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  waypoints: { pos: Vec2; type: string }[];
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
  const waypoints: { pos: Vec2; type: string }[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createPooledWaypoint());
  return {
    entity: { id: 0, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1 as PlayerId },
    unitSub: {
      unitType: '', hp: { curr: 0, max: 0 },
      collider: { scale: 0, shot: 0, push: 0 },
      moveSpeed: 0, mass: 0,
      // Pointer to pool.unitVel on full records; undefined on deltas.
      // Initial value here is a placeholder overwritten on first use.
      velocity: undefined,
      turretRotation: 0,
    },
    unitVel: { x: 0, y: 0, z: 0 },
    buildingSub: {
      type: '', dim: { x: 0, y: 0 }, hp: { curr: 0, max: 0 },
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
    buildProgress: 0, factoryProgress: 0, isProducing: 0, buildQueueLen: 0,
  };
}

const _prevStates = new Map<number, PrevEntityState>();
const _prevEntityIds = new Set<number>();
const _currentEntityIds = new Set<number>();
const _removedIdsBuf: number[] = [];

// Pool for PrevEntityState objects (avoid allocating on new entity)
const _prevStatePool: PrevEntityState[] = [];
let _prevStatePoolIndex = 0;

function getPrevState(entityId: number): PrevEntityState {
  let prev = _prevStates.get(entityId);
  if (!prev) {
    if (_prevStatePoolIndex < _prevStatePool.length) {
      prev = _prevStatePool[_prevStatePoolIndex++];
    } else {
      prev = createPrevEntityState();
      _prevStatePool.push(prev);
      _prevStatePoolIndex++;
    }
    _prevStates.set(entityId, prev);
  }
  return prev;
}

function getChangedFields(entity: Entity, prev: PrevEntityState): number {
  const posTh = SNAPSHOT_CONFIG.positionThreshold;
  const rotPosTh = SNAPSHOT_CONFIG.rotationPositionThreshold;
  const rotVelTh = SNAPSHOT_CONFIG.rotationVelocityThreshold;

  let mask = 0;

  if (Math.abs(entity.transform.x - prev.x) > posTh ||
      Math.abs(entity.transform.y - prev.y) > posTh) {
    mask |= ENTITY_CHANGED_POS;
  }
  if (Math.abs(entity.transform.rotation - prev.rotation) > rotPosTh) {
    mask |= ENTITY_CHANGED_ROT;
  }

  if (entity.unit) {
    // ENTITY_CHANGED_VEL is intentionally never set on deltas — velocity
    // ships only on full keyframes / new-entity records. Between
    // keyframes the client uses last-known velocity for dead-reckoning
    // and snap-corrects position from each delta. Skipping velocity on
    // deltas drops ~24 bytes (3 numbers as JSON) per moving unit per
    // snapshot, which dominates a thousand-unit fight at 32 SPS.
    if (entity.unit.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    {
      const actions = entity.unit.actions;
      const count = actions?.length ?? 0;
      let hash = count;
      if (actions) {
        for (let i = 0; i < count; i++) {
          const a = actions[i];
          hash = (hash * 31 + a.x * 1000) | 0;
          hash = (hash * 31 + a.y * 1000) | 0;
          hash = (hash * 31 + a.type.charCodeAt(0)) | 0;
        }
      }
      if (count !== prev.actionCount || hash !== prev.actionHash) {
        mask |= ENTITY_CHANGED_ACTIONS;
      }
    }

    if (entity.turrets) {
      if (entity.turrets.length !== prev.weaponCount) {
        mask |= ENTITY_CHANGED_TURRETS;
      } else {
        let isEngagedBits = 0;
        let targetBits = 0;
        for (let i = 0; i < entity.turrets.length; i++) {
          const w = entity.turrets[i];
          if (w.state === 'engaged') isEngagedBits |= (1 << i);
          if (w.target) targetBits |= (1 << i);
          if (Math.abs(w.rotation - prev.turretRots[i]) > rotPosTh ||
              Math.abs(w.angularVelocity - prev.turretAngVels[i]) > rotVelTh ||
              Math.abs((w.forceField?.range ?? 0) - prev.forceFieldRanges[i]) > 0.001) {
            mask |= ENTITY_CHANGED_TURRETS;
          }
        }
        if (isEngagedBits !== prev.isEngagedBits || targetBits !== prev.targetBits) {
          mask |= ENTITY_CHANGED_TURRETS;
        }
      }
    }
  }

  if (entity.building) {
    if (entity.building.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    if ((entity.buildable?.buildProgress ?? 0) !== prev.buildProgress) {
      mask |= ENTITY_CHANGED_BUILDING;
    }
    if (entity.factory) {
      if ((entity.factory.currentBuildProgress ?? 0) !== prev.factoryProgress ||
          (entity.factory.isProducing ? 1 : 0) !== prev.isProducing ||
          entity.factory.buildQueue.length !== prev.buildQueueLen) {
        mask |= ENTITY_CHANGED_FACTORY;
      }
    }
  }

  return mask;
}

function updatePrevState(entity: Entity, prev: PrevEntityState): void {
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
  prev.factoryProgress = entity.factory?.currentBuildProgress ?? 0;
  prev.isProducing = entity.factory?.isProducing ? 1 : 0;
  prev.buildQueueLen = entity.factory?.buildQueue.length ?? 0;
}

/** Reset delta tracking state (call between game sessions). */
export function resetDeltaTracking(): void {
  _prevStates.clear();
  _prevEntityIds.clear();
  _currentEntityIds.clear();
  _prevStatePoolIndex = 0;
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
  gridCellSize?: number
): NetworkServerSnapshot {
  // Reset entity pool for this frame
  _poolIndex = 0;
  _entityBuf.length = 0;

  // Track current entity IDs for removal detection
  _currentEntityIds.clear();

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;
  for (const entity of world.getUnits()) {
    _currentEntityIds.add(entity.id);
    if (deltaEnabled) {
      const prev = getPrevState(entity.id);
      const isNew = !_prevEntityIds.has(entity.id);
      const changedFields = isNew ? undefined : getChangedFields(entity, prev);
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntity(entity, changedFields);
        if (netEntity) _entityBuf.push(netEntity);
        updatePrevState(entity, prev);
      }
    } else {
      const netEntity = serializeEntity(entity, undefined);
      if (netEntity) _entityBuf.push(netEntity);
      const prev = getPrevState(entity.id);
      updatePrevState(entity, prev);
    }
  }
  for (const entity of world.getBuildings()) {
    _currentEntityIds.add(entity.id);
    if (deltaEnabled) {
      const prev = getPrevState(entity.id);
      const isNew = !_prevEntityIds.has(entity.id);
      const changedFields = isNew ? undefined : getChangedFields(entity, prev);
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntity(entity, changedFields);
        if (netEntity) _entityBuf.push(netEntity);
        updatePrevState(entity, prev);
      }
    } else {
      const netEntity = serializeEntity(entity, undefined);
      if (netEntity) _entityBuf.push(netEntity);
      const prev = getPrevState(entity.id);
      updatePrevState(entity, prev);
    }
  }

  // Detect removed entities (were in previous snapshot but not current)
  _removedIdsBuf.length = 0;
  if (deltaEnabled) {
    for (const prevId of _prevEntityIds) {
      if (!_currentEntityIds.has(prevId)) {
        _removedIdsBuf.push(prevId);
        _prevStates.delete(prevId);
      }
    }
  }

  // Update previous entity ID set for next frame
  _prevEntityIds.clear();
  for (const id of _currentEntityIds) {
    _prevEntityIds.add(id);
  }

  // Clean up prevStates for entities that no longer exist
  if (!deltaEnabled) {
    for (const id of _prevStates.keys()) {
      if (!_currentEntityIds.has(id)) {
        _prevStates.delete(id);
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
        source: { id: st.source.id, pos: st.source.pos, playerId: st.source.playerId },
        target: { id: st.target.id, pos: st.target.pos, dim: st.target.dim, radius: st.target.radius },
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
function serializeEntity(entity: Entity, changedFields: number | undefined): NetworkServerSnapshotEntity | null {
  const pool = getPooledEntry();
  const ne = pool.entity;
  const isFull = changedFields === undefined;

  // Base fields (always set)
  ne.id = entity.id;
  ne.type = entity.type;
  ne.playerId = entity.ownership?.playerId ?? 1 as PlayerId;
  ne.changedFields = changedFields;

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
    // Determine which unit-specific field groups changed.
    // ENTITY_CHANGED_VEL omitted: velocity ships only on full / new-
    // entity records, so a delta whose ONLY change was velocity is
    // dropped entirely (no entity row sent at all).
    const unitFieldMask = ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS;
    const hasUnitFields = isFull || (changedFields! & unitFieldMask);

    // Only attach unit sub-object when at least one unit field changed
    if (hasUnitFields) {
      const u = pool.unitSub;
      ne.unit = u;

      // Static fields (only on keyframes / new entities)
      if (isFull) {
        u.unitType = entity.unit.unitType;
        u.collider.scale = entity.unit.unitRadiusCollider.scale;
        u.collider.shot = entity.unit.unitRadiusCollider.shot;
        u.collider.push = entity.unit.unitRadiusCollider.push;
        u.moveSpeed = entity.unit.moveSpeed;
        u.mass = entity.unit.mass;
        u.isCommander = entity.commander !== undefined ? true : undefined;
      }

      // Velocity ships only on full records (keyframe or new entity).
      // On deltas u.velocity is left undefined and omitted by JSON, so
      // a moving-only entity contributes ~24 fewer bytes per snapshot.
      if (isFull) {
        u.velocity = pool.unitVel;
        u.velocity.x = qVel(entity.unit.velocityX ?? 0);
        u.velocity.y = qVel(entity.unit.velocityY ?? 0);
        u.velocity.z = qVel(entity.unit.velocityZ ?? 0);
      } else {
        u.velocity = undefined;
      }

      // HP
      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        u.hp.curr = entity.unit.hp;
        u.hp.max = entity.unit.maxHp;
      }

      // Turret rotation for network display (only when turrets changed)
      if (isFull || (changedFields! & ENTITY_CHANGED_TURRETS)) {
        let turretRot = entity.transform.rotation;
        const weapons = entity.turrets ?? [];
        for (const weapon of weapons) {
          turretRot = weapon.rotation;
        }
        u.turretRotation = turretRot;
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
            dst.type = src.type;
            dst.pos = src.x !== undefined ? { x: src.x, y: src.y } : undefined;
            dst.targetId = src.targetId;
            dst.buildingType = src.buildingType;
            dst.grid = src.gridX !== undefined ? { x: src.gridX, y: src.gridY! } : undefined;
            dst.buildingId = src.buildingId;
          }
          u.actions = pool.actions;
        }
      }

      // Turrets
      u.turrets = undefined;
      if (isFull || (changedFields! & ENTITY_CHANGED_TURRETS)) {
        if (entity.turrets && entity.turrets.length > 0) {
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
            t.angular.rot = src.rotation;
            t.angular.vel = src.angularVelocity;
            t.angular.acc = src.turnAccel;
            t.angular.drag = src.drag;
            t.angular.pitch = src.pitch;
            t.pos.offset.x = src.offset.x;
            t.pos.offset.y = src.offset.y;
            dst.targetId = src.target ?? undefined;
            dst.state = src.state;
            dst.currentForceFieldRange = src.forceField?.range;
          }
          u.turrets = pool.turrets;
        }
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

      // Static building fields (only on keyframes / new entities)
      if (isFull) {
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.type = entity.buildingType ?? '';
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
        pool.waypoints[0].type = 'move';
        for (let i = 0; i < wps.length; i++) {
          pool.waypoints[i + 1].pos.x = wps[i].x;
          pool.waypoints[i + 1].pos.y = wps[i].y;
          pool.waypoints[i + 1].type = wps[i].type;
        }
        f.waypoints = pool.waypoints;
      }
    }
    }
  }

  return ne;
}
