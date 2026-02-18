import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy, NetworkSprayTarget, NetworkAudioEvent, NetworkProjectileSpawn, NetworkProjectileDespawn, NetworkProjectileVelocityUpdate, NetworkGridCell, NetworkWeapon, NetworkAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { AudioEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';

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
};

// Serialize WorldState to network format
export function serializeGameState(
  world: WorldState,
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

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  // Uses cached getUnits()/getBuildings() to avoid Array.from() allocation from getAllEntities()
  for (const entity of world.getUnits()) {
    const netEntity = serializeEntity(entity);
    if (netEntity) _entityBuf.push(netEntity);
  }
  for (const entity of world.getBuildings()) {
    const netEntity = serializeEntity(entity);
    if (netEntity) _entityBuf.push(netEntity);
  }

  // Serialize economy for all players (reuse object to avoid per-snapshot allocation)
  // Clear previous entries
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

      // Grow pooled actions array if needed
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

      // Grow pooled weapons array if needed
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
      // Reuse pooled buildQueue array
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

      // Serialize waypoints into pooled objects
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
