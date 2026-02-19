import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy, NetworkSprayTarget, NetworkAudioEvent, NetworkProjectileSpawn, NetworkProjectileDespawn, NetworkProjectileVelocityUpdate, NetworkGridCell, NetworkWeapon, NetworkAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { AudioEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
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
    configId: '', targetId: undefined,
    seeRange: 0, fireRange: 0, releaseRange: 0, lockRange: 0, fightstopRange: 0,
    turretRotation: 0, turretAngularVelocity: 0, turretTurnAccel: 0, turretDrag: 0,
    offsetX: 0, offsetY: 0, isFiring: false, inFightstopRange: false,
    currentForceFieldRange: undefined,
  };
}

function createPooledAction(): NetworkAction {
  return { type: '', x: undefined, y: undefined, targetId: undefined, buildingType: undefined, gridX: undefined, gridY: undefined, buildingId: undefined };
}

function createPooledWaypoint(): { x: number; y: number; type: string } {
  return { x: 0, y: 0, type: '' };
}

// Extended pool entry with pre-allocated sub-arrays
interface PooledEntry {
  entity: NetworkEntity;
  weapons: NetworkWeapon[];
  actions: NetworkAction[];
  waypoints: { x: number; y: number; type: string }[];
  buildQueue: string[];
}

function createPooledEntry(): PooledEntry {
  const weapons: NetworkWeapon[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) weapons.push(createPooledWeapon());
  const actions: NetworkAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createPooledAction());
  const waypoints: { x: number; y: number; type: string }[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createPooledWaypoint());
  return {
    entity: { id: 0, type: 'unit', x: 0, y: 0, rotation: 0 },
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

interface PrevEntityState {
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  hp: number;
  actionCount: number;
  isFiringBits: number;    // bit-packed isFiring for all weapons
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
}

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
    isFiringBits: 0, targetBits: 0,
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

      let isFiringBits = 0;
      let targetBits = 0;
      for (let i = 0; i < entity.weapons.length; i++) {
        const w = entity.weapons[i];
        if (w.isFiring) isFiringBits |= (1 << i);
        if (w.targetEntityId) targetBits |= (1 << i);
        if (Math.abs(w.turretRotation - prev.turretRots[i]) > rotTh) return true;
        if (Math.abs(w.turretAngularVelocity - prev.turretAngVels[i]) > velTh) return true;
        if (Math.abs((w.currentForceFieldRange ?? 0) - prev.forceFieldRanges[i]) > 0.001) return true;
      }
      if (isFiringBits !== prev.isFiringBits) return true;
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

  prev.isFiringBits = 0;
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
      if (w.isFiring) prev.isFiringBits |= (1 << i);
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
const _audioBuf: NetworkAudioEvent[] = [];
const _spawnBuf: NetworkProjectileSpawn[] = [];
const _despawnBuf: NetworkProjectileDespawn[] = [];
const _velUpdateBuf: NetworkProjectileVelocityUpdate[] = [];
const _economyBuf: Record<PlayerId, NetworkEconomy> = {} as Record<PlayerId, NetworkEconomy>;
const _economyKeys: PlayerId[] = [];

// Reusable snapshot object (avoids creating a new object literal every frame)
const _snapshotBuf: NetworkGameState = {
  tick: 0,
  entities: _entityBuf,
  economy: _economyBuf,
  sprayTargets: undefined,
  audioEvents: undefined,
  projectileSpawns: undefined,
  projectileDespawns: undefined,
  projectileVelocityUpdates: undefined,
  gameOver: undefined,
  gridCells: undefined,
  gridSearchCells: undefined,
  gridCellSize: undefined,
  isDelta: undefined,
  removedEntityIds: undefined,
};

// Serialize WorldState to network format.
// When isDelta=true, only changed/new entities are included plus removedEntityIds.
// When isDelta=false (keyframe), all entities are included (same as before).
export function serializeGameState(
  world: WorldState,
  isDelta: boolean,
  gameOverWinnerId?: PlayerId,
  sprayTargets?: SprayTarget[],
  audioEvents?: AudioEvent[],
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
        stockpile: eco.stockpile,
        maxStockpile: eco.maxStockpile,
        baseIncome: eco.baseIncome,
        production: eco.production,
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
      });
    }
    netSprayTargets = _sprayBuf;
  }

  // Serialize audio events (reuse buffer)
  let netAudioEvents: NetworkAudioEvent[] | undefined;
  if (audioEvents && audioEvents.length > 0) {
    _audioBuf.length = 0;
    for (let i = 0; i < audioEvents.length; i++) {
      const ae = audioEvents[i];
      _audioBuf.push({
        type: ae.type,
        weaponId: ae.weaponId,
        x: ae.x,
        y: ae.y,
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
        x: ps.x, y: ps.y, rotation: ps.rotation,
        velocityX: ps.velocityX, velocityY: ps.velocityY,
        projectileType: ps.projectileType,
        weaponId: ps.weaponId,
        playerId: ps.playerId,
        sourceEntityId: ps.sourceEntityId,
        weaponIndex: ps.weaponIndex,
        isDGun: ps.isDGun,
        beamStartX: ps.beamStartX, beamStartY: ps.beamStartY,
        beamEndX: ps.beamEndX, beamEndY: ps.beamEndY,
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
      _velUpdateBuf.push({ id: vu.id, x: vu.x, y: vu.y, velocityX: vu.velocityX, velocityY: vu.velocityY });
    }
    netVelocityUpdates = _velUpdateBuf;
  }

  // Reuse snapshot object
  _snapshotBuf.tick = world.getTick();
  _snapshotBuf.entities = _entityBuf;
  _snapshotBuf.economy = _economyBuf;
  _snapshotBuf.sprayTargets = netSprayTargets;
  _snapshotBuf.audioEvents = netAudioEvents;
  _snapshotBuf.projectileSpawns = netProjectileSpawns;
  _snapshotBuf.projectileDespawns = netProjectileDespawns;
  _snapshotBuf.projectileVelocityUpdates = netVelocityUpdates;
  _snapshotBuf.gameOver = gameOverWinnerId ? { winnerId: gameOverWinnerId } : undefined;
  _snapshotBuf.gridCells = gridCells;
  _snapshotBuf.gridSearchCells = gridSearchCells;
  _snapshotBuf.gridCellSize = gridCellSize;
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
  ne.x = entity.transform.x;
  ne.y = entity.transform.y;
  ne.rotation = entity.transform.rotation;
  ne.playerId = entity.ownership?.playerId;

  // Clear all optional fields (prevents stale data from previous frame leaking)
  ne.unitType = undefined;
  ne.hp = undefined;
  ne.maxHp = undefined;
  ne.collisionRadius = undefined;
  ne.physicsRadius = undefined;
  ne.moveSpeed = undefined;
  ne.mass = undefined;
  ne.velocityX = undefined;
  ne.velocityY = undefined;
  ne.turretRotation = undefined;
  ne.isCommander = undefined;
  ne.actions = undefined;
  ne.weaponId = undefined;
  ne.weapons = undefined;
  ne.buildTargetId = undefined;
  ne.width = undefined;
  ne.height = undefined;
  ne.buildProgress = undefined;
  ne.isComplete = undefined;
  ne.buildingType = undefined;
  ne.buildQueue = undefined;
  ne.factoryProgress = undefined;
  ne.isProducing = undefined;
  ne.rallyX = undefined;
  ne.rallyY = undefined;
  ne.factoryWaypoints = undefined;
  ne.projectileType = undefined;
  ne.beamStartX = undefined;
  ne.beamStartY = undefined;
  ne.beamEndX = undefined;
  ne.beamEndY = undefined;
  ne.sourceEntityId = undefined;
  ne.weaponIndex = undefined;

  if (entity.type === 'unit' && entity.unit) {
    ne.unitType = entity.unit.unitType;
    ne.hp = entity.unit.hp;
    ne.maxHp = entity.unit.maxHp;
    ne.collisionRadius = entity.unit.collisionRadius;
    ne.physicsRadius = entity.unit.physicsRadius;
    ne.moveSpeed = entity.unit.moveSpeed;
    ne.mass = entity.unit.mass;
    ne.velocityX = entity.unit.velocityX ?? 0;
    ne.velocityY = entity.unit.velocityY ?? 0;

    // Turret rotation for network display - use last weapon's rotation
    let turretRot = entity.transform.rotation;
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      turretRot = weapon.turretRotation;
    }
    ne.turretRotation = turretRot;
    ne.isCommander = entity.commander !== undefined;

    // Serialize action queue into pooled action objects
    if (entity.unit.actions && entity.unit.actions.length > 0) {
      const actions = entity.unit.actions;
      const count = actions.length;
      while (pool.actions.length < count) pool.actions.push(createPooledAction());
      pool.actions.length = count;
      for (let i = 0; i < count; i++) {
        const src = actions[i];
        const dst = pool.actions[i];
        dst.type = src.type;
        dst.x = src.x;
        dst.y = src.y;
        dst.targetId = src.targetId;
        dst.buildingType = src.buildingType;
        dst.gridX = src.gridX;
        dst.gridY = src.gridY;
        dst.buildingId = src.buildingId;
      }
      ne.actions = pool.actions;
    }

    // Serialize weapons into pooled weapon objects
    if (entity.weapons && entity.weapons.length > 0) {
      const weapons = entity.weapons;
      const count = weapons.length;
      while (pool.weapons.length < count) pool.weapons.push(createPooledWeapon());
      pool.weapons.length = count;
      for (let i = 0; i < count; i++) {
        const src = weapons[i];
        const dst = pool.weapons[i];
        dst.configId = src.config.id;
        dst.targetId = src.targetEntityId ?? undefined;
        dst.seeRange = src.seeRange;
        dst.fireRange = src.fireRange;
        dst.releaseRange = src.releaseRange;
        dst.lockRange = src.lockRange;
        dst.fightstopRange = src.fightstopRange;
        dst.turretRotation = src.turretRotation;
        dst.turretAngularVelocity = src.turretAngularVelocity;
        dst.turretTurnAccel = src.turretTurnAccel;
        dst.turretDrag = src.turretDrag;
        dst.offsetX = src.offsetX;
        dst.offsetY = src.offsetY;
        dst.isFiring = src.isFiring;
        dst.inFightstopRange = src.inFightstopRange;
        dst.currentForceFieldRange = src.currentForceFieldRange;
      }
      ne.weapons = pool.weapons;
    }

    // Serialize builder state (commander)
    if (entity.builder) {
      ne.buildTargetId = entity.builder.currentBuildTarget ?? undefined;
    }
  }

  if (entity.type === 'building' && entity.building) {
    ne.width = entity.building.width;
    ne.height = entity.building.height;
    ne.hp = entity.building.hp;
    ne.maxHp = entity.building.maxHp;
    ne.buildingType = entity.buildingType;

    if (entity.buildable) {
      ne.buildProgress = entity.buildable.buildProgress;
      ne.isComplete = entity.buildable.isComplete;
    }

    if (entity.factory) {
      const srcQueue = entity.factory.buildQueue;
      pool.buildQueue.length = srcQueue.length;
      for (let i = 0; i < srcQueue.length; i++) {
        pool.buildQueue[i] = srcQueue[i];
      }
      ne.buildQueue = pool.buildQueue;

      ne.factoryProgress = entity.factory.currentBuildProgress;
      ne.isProducing = entity.factory.isProducing;
      ne.rallyX = entity.factory.rallyX;
      ne.rallyY = entity.factory.rallyY;

      const wps = entity.factory.waypoints;
      const wpCount = wps.length;
      while (pool.waypoints.length < wpCount) pool.waypoints.push(createPooledWaypoint());
      pool.waypoints.length = wpCount;
      for (let i = 0; i < wpCount; i++) {
        pool.waypoints[i].x = wps[i].x;
        pool.waypoints[i].y = wps[i].y;
        pool.waypoints[i].type = wps[i].type;
      }
      ne.factoryWaypoints = pool.waypoints;
    }
  }

  return ne;
}
