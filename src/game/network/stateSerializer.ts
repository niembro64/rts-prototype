import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy, NetworkSprayTarget, NetworkSimEvent, NetworkProjectileSpawn, NetworkProjectileDespawn, NetworkProjectileVelocityUpdate, NetworkGridCell, NetworkWeapon, NetworkAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { Vec2 } from '../../types/vec2';
import type { GamePhase } from '../../types/network';
import { SNAPSHOT_CONFIG } from '../../config';

// === Object pool for NetworkEntity (eliminates per-frame allocations) ===
// Each frame we reset the pool index and overwrite existing objects.

const INITIAL_ENTITY_POOL = 200; // MAX_TOTAL_UNITS (120) + buildings + headroom
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;

// Pre-allocated weapon objects per entity slot
function createPooledWeapon(): NetworkWeapon {
  return {
    turret: {
      id: '',
      ranges: { tracking: { acquire: 0, release: 0 }, engage: { acquire: 0, release: 0 } },
      angular: { rot: 0, vel: 0, acc: 0, drag: 0 },
      pos: { offset: { x: 0, y: 0 } },
    },
    targetId: undefined,
    isTracking: false, isEngaged: false,
    currentForceFieldRange: undefined,
  };
}

function createPooledAction(): NetworkAction {
  return { type: '', pos: undefined, targetId: undefined, buildingType: undefined, grid: undefined, buildingId: undefined };
}

function createPooledWaypoint(): { pos: Vec2; type: string } {
  return { pos: { x: 0, y: 0 }, type: '' };
}

// Pre-allocated sub-objects for the nested NetworkEntity shape
type UnitSub = NonNullable<NetworkEntity['unit']>;
type BuildingSub = NonNullable<NetworkEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;
type ShotSub = NonNullable<NetworkEntity['shot']>;

// Extended pool entry with pre-allocated sub-arrays and sub-objects
type PooledEntry = {
  entity: NetworkEntity;
  unitSub: UnitSub;
  buildingSub: BuildingSub;
  factorySub: FactorySub;
  shotSub: ShotSub;
  weapons: NetworkWeapon[];
  actions: NetworkAction[];
  waypoints: { pos: Vec2; type: string }[];
  buildQueue: string[];
};

function createPooledEntry(): PooledEntry {
  const weapons: NetworkWeapon[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) weapons.push(createPooledWeapon());
  const actions: NetworkAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createPooledAction());
  const waypoints: { pos: Vec2; type: string }[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createPooledWaypoint());
  return {
    entity: { id: 0, type: 'unit', pos: { x: 0, y: 0 }, rotation: 0 },
    unitSub: {
      unitType: '', hp: 0, maxHp: 0, drawScale: 0,
      collider: { unitShot: 0, unitUnit: 0 },
      moveSpeed: 0, mass: 0, velocity: { x: 0, y: 0 },
      turretRotation: 0,
    },
    buildingSub: {
      type: '', dim: { x: 0, y: 0 }, hp: 0, maxHp: 0,
      build: { progress: 0, complete: false },
    },
    factorySub: {
      queue: [], progress: 0, producing: false,
      rally: { x: 0, y: 0 },
    },
    shotSub: {
      type: '', source: 0,
    },
    weapons,
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
    hp: 0, actionCount: 0,
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

function hasEntityChanged(entity: Entity, prev: PrevEntityState): boolean {
  const posTh = SNAPSHOT_CONFIG.positionThreshold;
  const rotTh = SNAPSHOT_CONFIG.rotationThreshold;
  const velTh = SNAPSHOT_CONFIG.velocityThreshold;

  if (Math.abs(entity.transform.x - prev.x) > posTh) return true;
  if (Math.abs(entity.transform.y - prev.y) > posTh) return true;
  if (Math.abs(entity.transform.rotation - prev.rotation) > rotTh) return true;

  if (entity.unit) {
    if (Math.abs((entity.unit.velocityX ?? 0) - prev.velocityX) > velTh) return true;
    if (Math.abs((entity.unit.velocityY ?? 0) - prev.velocityY) > velTh) return true;
    if (entity.unit.hp !== prev.hp) return true;
    if ((entity.unit.actions?.length ?? 0) !== prev.actionCount) return true;

    // Check weapon state changes
    if (entity.weapons) {
      if (entity.weapons.length !== prev.weaponCount) return true;

      let isEngagedBits = 0;
      let targetBits = 0;
      for (let i = 0; i < entity.weapons.length; i++) {
        const w = entity.weapons[i];
        if (w.isEngaged) isEngagedBits |= (1 << i);
        if (w.targetEntityId) targetBits |= (1 << i);
        if (Math.abs(w.turretRotation - prev.turretRots[i]) > rotTh) return true;
        if (Math.abs(w.turretAngularVelocity - prev.turretAngVels[i]) > velTh) return true;
        if (Math.abs((w.currentForceFieldRange ?? 0) - prev.forceFieldRanges[i]) > 0.001) return true;
      }
      if (isEngagedBits !== prev.isEngagedBits) return true;
      if (targetBits !== prev.targetBits) return true;
    }
  }

  if (entity.building) {
    if (entity.building.hp !== prev.hp) return true;
    if ((entity.buildable?.buildProgress ?? 0) !== prev.buildProgress) return true;
    if (entity.factory) {
      if ((entity.factory.currentBuildProgress ?? 0) !== prev.factoryProgress) return true;
      if ((entity.factory.isProducing ? 1 : 0) !== prev.isProducing) return true;
      if (entity.factory.buildQueue.length !== prev.buildQueueLen) return true;
    }
  }

  return false;
}

function updatePrevState(entity: Entity, prev: PrevEntityState): void {
  prev.x = entity.transform.x;
  prev.y = entity.transform.y;
  prev.rotation = entity.transform.rotation;
  prev.velocityX = entity.unit?.velocityX ?? 0;
  prev.velocityY = entity.unit?.velocityY ?? 0;
  prev.hp = entity.unit?.hp ?? entity.building?.hp ?? 0;
  prev.actionCount = entity.unit?.actions?.length ?? 0;

  prev.isEngagedBits = 0;
  prev.targetBits = 0;
  prev.weaponCount = entity.weapons?.length ?? 0;
  if (entity.weapons) {
    // Grow turret arrays if needed
    while (prev.turretRots.length < entity.weapons.length) {
      prev.turretRots.push(0);
      prev.turretAngVels.push(0);
      prev.forceFieldRanges.push(0);
    }
    for (let i = 0; i < entity.weapons.length; i++) {
      const w = entity.weapons[i];
      if (w.isEngaged) prev.isEngagedBits |= (1 << i);
      if (w.targetEntityId) prev.targetBits |= (1 << i);
      prev.turretRots[i] = w.turretRotation;
      prev.turretAngVels[i] = w.turretAngularVelocity;
      prev.forceFieldRanges[i] = w.currentForceFieldRange ?? 0;
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
const _entityBuf: NetworkEntity[] = [];
const _sprayBuf: NetworkSprayTarget[] = [];
const _audioBuf: NetworkSimEvent[] = [];
const _spawnBuf: NetworkProjectileSpawn[] = [];
const _despawnBuf: NetworkProjectileDespawn[] = [];
const _velUpdateBuf: NetworkProjectileVelocityUpdate[] = [];
const _economyBuf: Record<PlayerId, NetworkEconomy> = {} as Record<PlayerId, NetworkEconomy>;
const _economyKeys: PlayerId[] = [];

// Pre-allocated sub-objects for nested fields (avoids per-frame allocation)
const _projectilesBuf: NonNullable<NetworkGameState['projectiles']> = {
  spawns: undefined,
  despawns: undefined,
  velocityUpdates: undefined,
};
const _gridBuf: NonNullable<NetworkGameState['grid']> = {
  cells: [],
  searchCells: [],
  cellSize: 0,
};
const _gameStateBuf: NonNullable<NetworkGameState['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

// Reusable snapshot object (avoids creating a new object literal every frame)
const _snapshotBuf: NetworkGameState = {
  tick: 0,
  entities: _entityBuf,
  economy: _economyBuf,
  sprayTargets: undefined,
  audioEvents: undefined,
  projectiles: undefined,
  gameState: undefined,
  grid: undefined,
  isDelta: undefined,
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
  gridCells?: NetworkGridCell[],
  gridSearchCells?: NetworkGridCell[],
  gridCellSize?: number
): NetworkGameState {
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
      if (isNew || hasEntityChanged(entity, prev)) {
        const netEntity = serializeEntity(entity);
        if (netEntity) _entityBuf.push(netEntity);
        updatePrevState(entity, prev);
      }
    } else {
      const netEntity = serializeEntity(entity);
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
      if (isNew || hasEntityChanged(entity, prev)) {
        const netEntity = serializeEntity(entity);
        if (netEntity) _entityBuf.push(netEntity);
        updatePrevState(entity, prev);
      }
    } else {
      const netEntity = serializeEntity(entity);
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
      };
    }
  }

  // Serialize spray targets (reuse buffer)
  let netSprayTargets: NetworkSprayTarget[] | undefined;
  if (sprayTargets && sprayTargets.length > 0) {
    _sprayBuf.length = 0;
    for (let i = 0; i < sprayTargets.length; i++) {
      const st = sprayTargets[i];
      _sprayBuf.push({
        source: { id: st.source.id, pos: st.source.pos },
        target: { id: st.target.id, pos: st.target.pos, dim: st.target.dim, radius: st.target.radius },
        type: st.type,
        intensity: st.intensity,
      });
    }
    netSprayTargets = _sprayBuf;
  }

  // Serialize audio events (reuse buffer)
  let netAudioEvents: NetworkSimEvent[] | undefined;
  if (audioEvents && audioEvents.length > 0) {
    _audioBuf.length = 0;
    for (let i = 0; i < audioEvents.length; i++) {
      const ae = audioEvents[i];
      _audioBuf.push({
        type: ae.type,
        weaponId: ae.weaponId,
        pos: ae.pos,
        entityId: ae.entityId,
        deathContext: ae.deathContext,
        impactContext: ae.impactContext,
      });
    }
    netAudioEvents = _audioBuf;
  }

  // Serialize projectile spawns (reuse buffer)
  let netProjectileSpawns: NetworkProjectileSpawn[] | undefined;
  if (projectileSpawns && projectileSpawns.length > 0) {
    _spawnBuf.length = 0;
    for (let i = 0; i < projectileSpawns.length; i++) {
      const ps = projectileSpawns[i];
      _spawnBuf.push({
        id: ps.id,
        pos: ps.pos, rotation: ps.rotation,
        velocity: ps.velocity,
        projectileType: ps.projectileType,
        weaponId: ps.weaponId,
        playerId: ps.playerId,
        sourceEntityId: ps.sourceEntityId,
        weaponIndex: ps.weaponIndex,
        isDGun: ps.isDGun,
        beam: ps.beam,
        targetEntityId: ps.targetEntityId,
        homingTurnRate: ps.homingTurnRate,
      });
    }
    netProjectileSpawns = _spawnBuf;
  }

  // Serialize projectile despawns (reuse buffer)
  let netProjectileDespawns: NetworkProjectileDespawn[] | undefined;
  if (projectileDespawns && projectileDespawns.length > 0) {
    _despawnBuf.length = 0;
    for (let i = 0; i < projectileDespawns.length; i++) {
      _despawnBuf.push({ id: projectileDespawns[i].id });
    }
    netProjectileDespawns = _despawnBuf;
  }

  // Serialize projectile velocity updates (reuse buffer)
  let netVelocityUpdates: NetworkProjectileVelocityUpdate[] | undefined;
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
  _snapshotBuf.isDelta = deltaEnabled ? true : undefined;
  _snapshotBuf.removedEntityIds = deltaEnabled && _removedIdsBuf.length > 0 ? _removedIdsBuf : undefined;

  return _snapshotBuf;
}

// Serialize a single entity using pooled objects (zero allocation)
function serializeEntity(entity: Entity): NetworkEntity | null {
  const pool = getPooledEntry();
  const ne = pool.entity;

  // Base fields (always set)
  ne.id = entity.id;
  ne.type = entity.type;
  ne.pos.x = entity.transform.x;
  ne.pos.y = entity.transform.y;
  ne.rotation = entity.transform.rotation;
  ne.playerId = entity.ownership?.playerId;

  // Clear nested sub-objects (prevents stale data from previous frame leaking)
  ne.unit = undefined;
  ne.building = undefined;
  ne.shot = undefined;

  if (entity.type === 'unit' && entity.unit) {
    const u = pool.unitSub;
    ne.unit = u;

    u.unitType = entity.unit.unitType;
    u.hp = entity.unit.hp;
    u.maxHp = entity.unit.maxHp;
    u.drawScale = entity.unit.drawScale;
    u.collider.unitShot = entity.unit.radiusColliderUnitShot;
    u.collider.unitUnit = entity.unit.radiusColliderUnitUnit;
    u.moveSpeed = entity.unit.moveSpeed;
    u.mass = entity.unit.mass;
    u.velocity.x = entity.unit.velocityX ?? 0;
    u.velocity.y = entity.unit.velocityY ?? 0;

    // Turret rotation for network display - use last weapon's rotation
    let turretRot = entity.transform.rotation;
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      turretRot = weapon.turretRotation;
    }
    u.turretRotation = turretRot;
    u.isCommander = entity.commander !== undefined ? true : undefined;

    // Serialize action queue into pooled action objects
    u.actions = undefined;
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

    // Serialize weapons into pooled weapon objects
    u.weapons = undefined;
    if (entity.weapons && entity.weapons.length > 0) {
      const weapons = entity.weapons;
      const count = weapons.length;
      while (pool.weapons.length < count) pool.weapons.push(createPooledWeapon());
      pool.weapons.length = count;
      for (let i = 0; i < count; i++) {
        const src = weapons[i];
        const dst = pool.weapons[i];
        const t = dst.turret;
        t.id = src.config.id;
        const sr = src.ranges; const dr = t.ranges;
        dr.tracking.acquire = sr.tracking.acquire; dr.tracking.release = sr.tracking.release;
        dr.engage.acquire = sr.engage.acquire; dr.engage.release = sr.engage.release;
        t.angular.rot = src.turretRotation;
        t.angular.vel = src.turretAngularVelocity;
        t.angular.acc = src.turretTurnAccel;
        t.angular.drag = src.turretDrag;
        t.pos.offset.x = src.offsetX;
        t.pos.offset.y = src.offsetY;
        dst.targetId = src.targetEntityId ?? undefined;
        dst.isTracking = src.isTracking;
        dst.isEngaged = src.isEngaged;
        dst.currentForceFieldRange = src.currentForceFieldRange;
      }
      u.weapons = pool.weapons;
    }

    // Serialize builder state (commander)
    u.buildTargetId = undefined;
    if (entity.builder) {
      u.buildTargetId = entity.builder.currentBuildTarget ?? undefined;
    }
  }

  if (entity.type === 'building' && entity.building) {
    const b = pool.buildingSub;
    ne.building = b;

    b.dim.x = entity.building.width;
    b.dim.y = entity.building.height;
    b.hp = entity.building.hp;
    b.maxHp = entity.building.maxHp;
    b.type = entity.buildingType ?? '';

    if (entity.buildable) {
      b.build.progress = entity.buildable.buildProgress;
      b.build.complete = entity.buildable.isComplete;
    } else {
      b.build.progress = 1;
      b.build.complete = true;
    }

    b.factory = undefined;
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
      f.rally.x = entity.factory.rallyX;
      f.rally.y = entity.factory.rallyY;

      const wps = entity.factory.waypoints;
      const wpCount = wps.length;
      while (pool.waypoints.length < wpCount) pool.waypoints.push(createPooledWaypoint());
      pool.waypoints.length = wpCount;
      for (let i = 0; i < wpCount; i++) {
        pool.waypoints[i].pos.x = wps[i].x;
        pool.waypoints[i].pos.y = wps[i].y;
        pool.waypoints[i].type = wps[i].type;
      }
      f.waypoints = pool.waypoints;
    }
  }

  return ne;
}
