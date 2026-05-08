import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import { getBuildFraction } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity, NetworkServerSnapshotEconomy, NetworkServerSnapshotSprayTarget, NetworkServerSnapshotSimEvent, NetworkServerSnapshotProjectileSpawn, NetworkServerSnapshotProjectileDespawn, NetworkServerSnapshotVelocityUpdate, NetworkServerSnapshotBeamPoint, NetworkServerSnapshotBeamUpdate, NetworkServerSnapshotGridCell, NetworkServerSnapshotTurret, NetworkServerSnapshotAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { Vec2, Vec3 } from '../../types/vec2';
import type { GamePhase } from '../../types/network';
import type { SnapshotDeltaResolutionConfig } from '../../types/config';
import {
  ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP, ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY,
  actionTypeToCode, turretStateToCode,
  unitTypeToCode, buildingTypeToCode, projectileTypeToCode,
  turretIdToCode, shotIdToCode,
  PROJECTILE_TYPE_UNKNOWN, TURRET_ID_UNKNOWN,
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
      id: TURRET_ID_UNKNOWN,
      angular: { rot: 0, vel: 0, pitch: 0 },
    },
    targetId: undefined,
    state: 0,
    currentForceFieldRange: undefined,
  };
}

/** Pooled action carries its own pos/grid sub-objects so the per-snapshot
 *  serialization just mutates them and toggles the action's pos/grid
 *  fields between that persistent reference and undefined — instead of
 *  allocating a fresh `{ x, y }` per action per snapshot. The hidden
 *  `_pos` / `_grid` properties are not on the wire shape; only the
 *  `pos` / `grid` fields above are serialized. */
type PooledActionStorage = NetworkServerSnapshotAction & {
  _pos: { x: number; y: number };
  _grid: { x: number; y: number };
};
function createPooledAction(): NetworkServerSnapshotAction {
  const storage: PooledActionStorage = {
    type: 0,
    pos: undefined,
    posZ: undefined,
    pathExp: undefined,
    targetId: undefined,
    buildingType: undefined,
    grid: undefined,
    buildingId: undefined,
    _pos: { x: 0, y: 0 },
    _grid: { x: 0, y: 0 },
  };
  return storage;
}

function createPooledWaypoint(): { pos: Vec2; posZ?: number; type: string } {
  return { pos: { x: 0, y: 0 }, posZ: undefined, type: '' };
}

// Pre-allocated sub-objects for the nested NetworkServerSnapshotEntity shape
type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;

// Extended pool entry with pre-allocated sub-arrays and sub-objects
type PooledEntry = {
  entity: NetworkServerSnapshotEntity;
  unitSub: UnitSub;
  /** Persistent radius object reused across snapshots — unitSub.radius
   *  swaps between this and undefined depending on whether the entity
   *  needs a static-fields seed. */
  unitRadius: { body: number; shot: number; push: number };
  /** Persistent building dim reused across snapshots — same swap rule. */
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  factorySub: FactorySub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  waypoints: { pos: Vec2; posZ?: number; type: string }[];
  buildQueue: number[];
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

function writeTurretsToPool(
  pool: PooledEntry,
  weapons: NonNullable<Entity['combat']>['turrets'],
): NetworkServerSnapshotTurret[] {
  const count = weapons.length;
  while (pool.turrets.length < count) pool.turrets.push(createPooledTurret());
  pool.turrets.length = count;
  for (let i = 0; i < count; i++) {
    const src = weapons[i];
    const dst = pool.turrets[i];
    const t = dst.turret;
    t.id = turretIdToCode(src.config.id);
    t.angular.rot = qRot(src.rotation);
    t.angular.vel = qRot(src.angularVelocity);
    t.angular.pitch = qRot(src.pitch);
    dst.targetId = src.target ?? undefined;
    dst.state = turretStateToCode(src.state);
    dst.currentForceFieldRange = src.forceField?.range;
  }
  return pool.turrets;
}

/** Surface-normal quantization. Components are unit-vector floats in
 *  [-1, 1]; 0.001 precision (~0.06° of tilt at the rim) is far below
 *  visible chassis-tilt jitter and trims wire bytes vs. raw float64. */
function qNormal(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function createPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: undefined,
    endpointDamageable: undefined,
  };
}

function createPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

type PooledSprayTarget = NetworkServerSnapshotSprayTarget & {
  _sourcePos: Vec2;
  _targetPos: Vec2;
  _targetDim: Vec2;
};

function createPooledSprayTarget(): NetworkServerSnapshotSprayTarget {
  const spray: PooledSprayTarget = {
    source: { id: 0, pos: { x: 0, y: 0 }, z: undefined, playerId: 1 as PlayerId },
    target: { id: 0, pos: { x: 0, y: 0 }, z: undefined, dim: undefined, radius: undefined },
    type: 'build',
    intensity: 0,
    speed: undefined,
    particleRadius: undefined,
    _sourcePos: { x: 0, y: 0 },
    _targetPos: { x: 0, y: 0 },
    _targetDim: { x: 0, y: 0 },
  };
  spray.source.pos = spray._sourcePos;
  spray.target.pos = spray._targetPos;
  return spray;
}

type PooledSimEvent = NetworkServerSnapshotSimEvent & {
  _pos: Vec3;
};

function createPooledSimEvent(): NetworkServerSnapshotSimEvent {
  const event: PooledSimEvent = {
    type: 'fire',
    turretId: '',
    sourceType: undefined,
    sourceKey: undefined,
    pos: { x: 0, y: 0, z: 0 },
    entityId: undefined,
    deathContext: undefined,
    impactContext: undefined,
    forceFieldImpact: undefined,
    _pos: { x: 0, y: 0, z: 0 },
  };
  event.pos = event._pos;
  return event;
}

type PooledProjectileSpawn = NetworkServerSnapshotProjectileSpawn & {
  _pos: Vec3;
  _velocity: Vec3;
  _beamStart: Vec3;
  _beamEnd: Vec3;
  _beam: { start: Vec3; end: Vec3 };
};

function createPooledProjectileSpawn(): NetworkServerSnapshotProjectileSpawn {
  const spawn: PooledProjectileSpawn = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    maxLifespan: undefined,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 1,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
    isDGun: undefined,
    fromParentDetonation: undefined,
    beam: undefined,
    targetEntityId: undefined,
    homingTurnRate: undefined,
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
    _beamStart: { x: 0, y: 0, z: 0 },
    _beamEnd: { x: 0, y: 0, z: 0 },
    _beam: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } },
  };
  spawn.pos = spawn._pos;
  spawn.velocity = spawn._velocity;
  spawn._beam.start = spawn._beamStart;
  spawn._beam.end = spawn._beamEnd;
  return spawn;
}

function createPooledProjectileDespawn(): NetworkServerSnapshotProjectileDespawn {
  return { id: 0 };
}

type PooledVelocityUpdate = NetworkServerSnapshotVelocityUpdate & {
  _pos: Vec3;
  _velocity: Vec3;
};

function createPooledVelocityUpdate(): NetworkServerSnapshotVelocityUpdate {
  const update: PooledVelocityUpdate = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
  };
  update.pos = update._pos;
  update.velocity = update._velocity;
  return update;
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
        radius: undefined,
        bodyCenterHeight: undefined,
        mass: undefined, velocity: { x: 0, y: 0, z: 0 },
    },
    unitRadius: { body: 0, shot: 0, push: 0 },
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      type: undefined, dim: undefined, hp: { curr: 0, max: 0 },
      build: {
        complete: false,
        paid: { energy: 0, mana: 0, metal: 0 },
      },
      metalExtractionRate: undefined,
    },
    factorySub: {
      queue: [], progress: 0, producing: false,
      energyRate: 0, manaRate: 0, metalRate: 0,
      waypoints: [],
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
  turretPitches: number[];  // per-weapon pitch
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
  const turretPitches: number[] = [];
  const forceFieldRanges: number[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) {
    turretRots.push(0);
    turretAngVels.push(0);
    turretPitches.push(0);
    forceFieldRanges.push(0);
  }
  return {
    x: 0, y: 0, rotation: 0,
    velocityX: 0, velocityY: 0,
    hp: 0, actionCount: 0, actionHash: 0,
    isEngagedBits: 0, targetBits: 0,
    weaponCount: 0, turretRots, turretAngVels, turretPitches, forceFieldRanges,
    buildProgress: 0, solarOpen: 0, factoryProgress: 0, isProducing: 0, buildQueueLen: 0,
  };
}

type DeltaTrackingState = {
  prevStates: Map<number, PrevEntityState>;
  prevEntityIds: Set<number>;
  currentEntityIds: Set<number>;
  prevStatePool: PrevEntityState[];
  prevStatePoolIndex: number;
};

function createDeltaTrackingState(): DeltaTrackingState {
  return {
    prevStates: new Map<number, PrevEntityState>(),
    prevEntityIds: new Set<number>(),
    currentEntityIds: new Set<number>(),
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
 *  Delta snapshots use this to avoid re-sending unit type/radius,
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

function getDeltaResolution(
  entity: Entity,
  recipientPlayerId: PlayerId | undefined,
): SnapshotDeltaResolutionConfig {
  if (recipientPlayerId === undefined) return SNAPSHOT_CONFIG.ownedEntityDelta;
  return entity.ownership?.playerId === recipientPlayerId
    ? SNAPSHOT_CONFIG.ownedEntityDelta
    : SNAPSHOT_CONFIG.observedEntityDelta;
}

function shouldSendProjectileSideChannel(
  ownerId: PlayerId | undefined,
  recipientPlayerId: PlayerId | undefined,
  tick: number,
): boolean {
  const rawStride = recipientPlayerId === undefined || ownerId === recipientPlayerId
    ? SNAPSHOT_CONFIG.ownedProjectileUpdateStride
    : SNAPSHOT_CONFIG.observedProjectileUpdateStride;
  const stride = Math.max(1, Math.floor(rawStride));
  return stride <= 1 || tick % stride === 0;
}

function getChangedFields(
  entity: Entity,
  prev: PrevEntityState,
  next: PrevEntityState,
  resolution: SnapshotDeltaResolutionConfig,
): number {
  const posTh = SNAPSHOT_CONFIG.positionThreshold * resolution.positionThresholdMultiplier;
  const velTh = SNAPSHOT_CONFIG.velocityThreshold * resolution.velocityThresholdMultiplier;
  const rotPosTh = SNAPSHOT_CONFIG.rotationPositionThreshold * resolution.rotationPositionThresholdMultiplier;
  const rotVelTh = SNAPSHOT_CONFIG.rotationVelocityThreshold * resolution.rotationVelocityThresholdMultiplier;

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
    // Unit shells need the building-change bit to ship per-tick paid
    // updates. `buildProgress` here is the avg-of-three fill stored in
    // captureEntityState — even small changes cross the != check.
    if (entity.buildable && next.buildProgress !== prev.buildProgress) {
      mask |= ENTITY_CHANGED_BUILDING;
    }
  }

  if (entity.combat) {
    if (next.weaponCount !== prev.weaponCount) {
      mask |= ENTITY_CHANGED_TURRETS;
    } else {
      // Once any turret has crossed a threshold the bit is set; we
      // still need to compute the engaged / target bitmasks for the
      // OTHER turrets on this entity (used as a dirty proxy below) so
      // we can't break out of the loop early — but we CAN skip the
      // 3-abs threshold check on subsequent turrets, which is the
      // expensive part. At many turrets per entity this halves the
      // work for active entities (where any one turret moving means
      // the row will be sent anyway).
      let turretsAlreadyChanged = false;
      for (let i = 0; i < next.weaponCount; i++) {
        if (!turretsAlreadyChanged) {
          if (Math.abs(next.turretRots[i] - prev.turretRots[i]) > rotPosTh ||
              Math.abs(next.turretAngVels[i] - prev.turretAngVels[i]) > rotVelTh ||
              Math.abs(next.turretPitches[i] - prev.turretPitches[i]) > rotPosTh ||
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
  const combatTurrets = entity.combat?.turrets;
  prev.weaponCount = combatTurrets?.length ?? 0;
  if (combatTurrets) {
    // Grow turret arrays if needed
    while (prev.turretRots.length < combatTurrets.length) {
      prev.turretRots.push(0);
      prev.turretAngVels.push(0);
      prev.turretPitches.push(0);
      prev.forceFieldRanges.push(0);
    }
    for (let i = 0; i < combatTurrets.length; i++) {
      const w = combatTurrets[i];
      if (w.state === 'engaged') prev.isEngagedBits |= (1 << i);
      if (w.target) prev.targetBits |= (1 << i);
      prev.turretRots[i] = w.rotation;
      prev.turretAngVels[i] = w.angularVelocity;
      prev.turretPitches[i] = w.pitch;
      prev.forceFieldRanges[i] = w.forceField?.range ?? 0;
    }
  }

  prev.buildProgress = entity.buildable ? getBuildFraction(entity.buildable) : 0;
  prev.solarOpen = entity.building?.solar?.open === false ? 0 : 1;
  // Factory progress is a server-side mirror of the current shell's
  // build fraction. energyDistribution updates it and marks the
  // factory dirty whenever resources flow into that shell.
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

/** Drop delta tracking state for one snapshot stream. Call when that
 *  stream's listener is removed so per-client prev-state pools do not
 *  live until the next full game reset. */
export function resetDeltaTrackingForKey(key: string | number | undefined): void {
  _trackingStates.delete(getTrackingKey(key));
}

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _sprayBuf: NetworkServerSnapshotSprayTarget[] = [];
const _sprayPool: NetworkServerSnapshotSprayTarget[] = [];
const _audioBuf: NetworkServerSnapshotSimEvent[] = [];
const _spawnBuf: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnBuf: NetworkServerSnapshotProjectileDespawn[] = [];
const _velUpdateBuf: NetworkServerSnapshotVelocityUpdate[] = [];
const _audioPool: NetworkServerSnapshotSimEvent[] = [];
const _spawnPool: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnPool: NetworkServerSnapshotProjectileDespawn[] = [];
const _velUpdatePool: NetworkServerSnapshotVelocityUpdate[] = [];
const _beamUpdateBuf: NetworkServerSnapshotBeamUpdate[] = [];
const _beamUpdatePool: NetworkServerSnapshotBeamUpdate[] = [];
const _beamPointPool: NetworkServerSnapshotBeamPoint[] = [];
let _sprayPoolIndex = 0;
let _audioPoolIndex = 0;
let _spawnPoolIndex = 0;
let _despawnPoolIndex = 0;
let _velUpdatePoolIndex = 0;
let _beamUpdatePoolIndex = 0;
let _beamPointPoolIndex = 0;
const _resyncSeenIds = new Set<number>();
const _economyBuf: Record<PlayerId, NetworkServerSnapshotEconomy> = {} as Record<PlayerId, NetworkServerSnapshotEconomy>;
const _economyKeys: PlayerId[] = [];

// Pre-allocated sub-objects for nested fields (avoids per-frame allocation)
const _projectilesBuf: NonNullable<NetworkServerSnapshot['projectiles']> = {
  spawns: undefined,
  despawns: undefined,
  velocityUpdates: undefined,
  beamUpdates: undefined,
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

function getPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  let update = _beamUpdatePool[_beamUpdatePoolIndex];
  if (!update) {
    update = createPooledBeamUpdate();
    _beamUpdatePool[_beamUpdatePoolIndex] = update;
  }
  _beamUpdatePoolIndex++;
  update.points.length = 0;
  update.obstructionT = undefined;
  update.endpointDamageable = undefined;
  return update;
}

function getPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  let point = _beamPointPool[_beamPointPoolIndex];
  if (!point) {
    point = createPooledBeamPoint();
    _beamPointPool[_beamPointPoolIndex] = point;
  }
  _beamPointPoolIndex++;
  point.mirrorEntityId = undefined;
  point.reflectorKind = undefined;
  point.reflectorPlayerId = undefined;
  point.normalX = undefined;
  point.normalY = undefined;
  point.normalZ = undefined;
  return point;
}

function getPooledSprayTarget(): PooledSprayTarget {
  let spray = _sprayPool[_sprayPoolIndex] as PooledSprayTarget | undefined;
  if (!spray) {
    spray = createPooledSprayTarget() as PooledSprayTarget;
    _sprayPool[_sprayPoolIndex] = spray;
  }
  _sprayPoolIndex++;
  return spray;
}

function getPooledSimEvent(): PooledSimEvent {
  let event = _audioPool[_audioPoolIndex] as PooledSimEvent | undefined;
  if (!event) {
    event = createPooledSimEvent() as PooledSimEvent;
    _audioPool[_audioPoolIndex] = event;
  }
  _audioPoolIndex++;
  return event;
}

function getPooledProjectileSpawn(): PooledProjectileSpawn {
  let spawn = _spawnPool[_spawnPoolIndex] as PooledProjectileSpawn | undefined;
  if (!spawn) {
    spawn = createPooledProjectileSpawn() as PooledProjectileSpawn;
    _spawnPool[_spawnPoolIndex] = spawn;
  }
  _spawnPoolIndex++;
  return spawn;
}

function getPooledProjectileDespawn(): NetworkServerSnapshotProjectileDespawn {
  let despawn = _despawnPool[_despawnPoolIndex];
  if (!despawn) {
    despawn = createPooledProjectileDespawn();
    _despawnPool[_despawnPoolIndex] = despawn;
  }
  _despawnPoolIndex++;
  return despawn;
}

function getPooledVelocityUpdate(): PooledVelocityUpdate {
  let update = _velUpdatePool[_velUpdatePoolIndex] as PooledVelocityUpdate | undefined;
  if (!update) {
    update = createPooledVelocityUpdate() as PooledVelocityUpdate;
    _velUpdatePool[_velUpdatePoolIndex] = update;
  }
  _velUpdatePoolIndex++;
  return update;
}

export type SerializeGameStateOptions = {
  /**
   * Delta histories are per recipient so prev-state/removal bookkeeping
   * does not leak across players.
   */
  trackingKey?: string | number;
  dirtyEntityIds?: readonly EntityId[];
  dirtyEntityFields?: readonly number[];
  removedEntityIds?: readonly EntityId[];
  /**
   * Recipient used for owner-aware diff resolution. Owned entities keep
   * baseline precision; observed entities can use coarser thresholds.
   */
  recipientPlayerId?: PlayerId;
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
  const recipientPlayerId = options?.recipientPlayerId;
  const tick = world.getTick();

  // Reset entity pool for this frame
  _poolIndex = 0;
  _sprayPoolIndex = 0;
  _audioPoolIndex = 0;
  _spawnPoolIndex = 0;
  _despawnPoolIndex = 0;
  _velUpdatePoolIndex = 0;
  _beamUpdatePoolIndex = 0;
  _beamPointPoolIndex = 0;
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;
  const acceptsEntity = (entity: Entity): boolean =>
    entity.type === 'unit' || entity.type === 'building';

  const forgetTrackedEntity = (id: EntityId, emitRemoval: boolean): void => {
    const wasVisible = tracking.prevEntityIds.delete(id);
    tracking.prevStates.delete(id);
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
        : getChangedFields(entity, prev, _nextStateScratch, getDeltaResolution(entity, recipientPlayerId)) |
          (dirtyFields & SNAPSHOT_DIRTY_FORCE_FIELDS);
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntity(entity, changedFields, world);
        if (netEntity) _entityBuf.push(netEntity);
        copyPrevState(_nextStateScratch, prev);
      }
    }
  } else {
    tracking.currentEntityIds.clear();
    // Keyframe: serialize every accepted unit + building. Both
    // categories take exactly the same path — pool an entry, capture
    // its prev state for delta tracking — so we walk both source
    // arrays through one body. Adding a new entity-shaped category
    // (e.g. capture-tile entities) means appending one more source
    // here, not duplicating another loop.
    const keyframeSources: ReadonlyArray<readonly Entity[]> = [
      world.getUnits(),
      world.getBuildings(),
    ];
    for (let s = 0; s < keyframeSources.length; s++) {
      const source = keyframeSources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!acceptsEntity(entity)) continue;
        tracking.currentEntityIds.add(entity.id);
        const netEntity = serializeEntity(entity, undefined, world);
        if (netEntity) _entityBuf.push(netEntity);
        const prev = getPrevState(tracking, entity.id);
        captureEntityState(entity, prev);
      }
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
    // Clean up prevStates for entities that no longer exist after a keyframe.
    for (const id of tracking.prevStates.keys()) {
      if (!tracking.currentEntityIds.has(id)) {
        tracking.prevStates.delete(id);
      }
    }
  }

  // Serialize economy (reuse object to avoid per-snapshot allocation).
  // Unscoped/local streams keep the full table for debug/sandbox player
  // toggling. Per-player network streams only need the recipient's
  // economy for the top bar; enemy economy is neither rendered nor a
  // useful thing to leak over the wire every snapshot.
  for (const key of _economyKeys) {
    delete _economyBuf[key];
  }
  _economyKeys.length = 0;
  const economyPlayerCount = Math.max(0, Math.floor(world.playerCount));
  for (let playerId = 1; playerId <= economyPlayerCount; playerId++) {
    if (recipientPlayerId !== undefined && playerId !== recipientPlayerId) continue;
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
        metal: {
          stockpile: { curr: eco.metal.stockpile.curr, max: eco.metal.stockpile.max },
          income: { base: eco.metal.income.base, extraction: eco.metal.income.extraction },
          expenditure: eco.metal.expenditure,
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
      const out = getPooledSprayTarget();
      out.source.id = st.source.id;
      out._sourcePos.x = st.source.pos.x;
      out._sourcePos.y = st.source.pos.y;
      out.source.z = st.source.z;
      out.source.playerId = st.source.playerId;
      out.target.id = st.target.id;
      out._targetPos.x = st.target.pos.x;
      out._targetPos.y = st.target.pos.y;
      out.target.z = st.target.z;
      if (st.target.dim) {
        out._targetDim.x = st.target.dim.x;
        out._targetDim.y = st.target.dim.y;
        out.target.dim = out._targetDim;
      } else {
        out.target.dim = undefined;
      }
      out.target.radius = st.target.radius;
      out.type = st.type;
      out.intensity = st.intensity;
      out.speed = st.speed;
      out.particleRadius = st.particleRadius;
      _sprayBuf.push(out);
    }
    if (_sprayBuf.length > 0) netSprayTargets = _sprayBuf;
  }

  // Serialize audio events (reuse buffer)
  let netAudioEvents: NetworkServerSnapshotSimEvent[] | undefined;
  if (audioEvents && audioEvents.length > 0) {
    _audioBuf.length = 0;
    for (let i = 0; i < audioEvents.length; i++) {
      const ae = audioEvents[i];
      const out = getPooledSimEvent();
      out.type = ae.type;
      out.turretId = ae.turretId;
      out.sourceType = ae.sourceType;
      out.sourceKey = ae.sourceKey;
      out._pos.x = ae.pos.x;
      out._pos.y = ae.pos.y;
      out._pos.z = ae.pos.z;
      out.entityId = ae.entityId;
      out.deathContext = ae.deathContext;
      out.impactContext = ae.impactContext;
      out.forceFieldImpact = ae.forceFieldImpact;
      _audioBuf.push(out);
    }
    if (_audioBuf.length > 0) netAudioEvents = _audioBuf;
  }

  // Serialize projectile spawns (reuse buffer). Full keyframes also
  // synthesize spawns for every live projectile entity so a client that
  // missed the original spawn event can still recover the projectile —
  // delta snapshots only carry units and buildings, and `whole state`
  // messages can be dropped under backpressure in NetworkManager.
  let netProjectileSpawns: NetworkServerSnapshotProjectileSpawn[] | undefined;
  const wantKeyframeProjectileResync = !deltaEnabled;
  const tickSpawnCount = projectileSpawns?.length ?? 0;
  if (tickSpawnCount > 0 || wantKeyframeProjectileResync) {
    _spawnBuf.length = 0;
    if (wantKeyframeProjectileResync) _resyncSeenIds.clear();
    if (projectileSpawns) {
      for (let i = 0; i < tickSpawnCount; i++) {
        const ps = projectileSpawns[i];
        const out = getPooledProjectileSpawn();
        out.id = ps.id;
        out._pos.x = ps.pos.x;
        out._pos.y = ps.pos.y;
        out._pos.z = ps.pos.z;
        out.rotation = ps.rotation;
        out._velocity.x = ps.velocity.x;
        out._velocity.y = ps.velocity.y;
        out._velocity.z = ps.velocity.z;
        out.projectileType = projectileTypeToCode(ps.projectileType);
        out.maxLifespan = ps.maxLifespan;
        out.turretId = turretIdToCode(ps.turretId);
        out.shotId = shotIdToCode(ps.shotId);
        out.sourceTurretId = ps.sourceTurretId !== undefined
          ? turretIdToCode(ps.sourceTurretId)
          : undefined;
        out.playerId = ps.playerId;
        out.sourceEntityId = ps.sourceEntityId;
        out.turretIndex = ps.turretIndex;
        out.barrelIndex = ps.barrelIndex;
        out.isDGun = ps.isDGun;
        out.fromParentDetonation = ps.fromParentDetonation;
        if (ps.beam) {
          out._beamStart.x = ps.beam.start.x;
          out._beamStart.y = ps.beam.start.y;
          out._beamStart.z = ps.beam.start.z;
          out._beamEnd.x = ps.beam.end.x;
          out._beamEnd.y = ps.beam.end.y;
          out._beamEnd.z = ps.beam.end.z;
          out.beam = out._beam;
        } else {
          out.beam = undefined;
        }
        out.targetEntityId = ps.targetEntityId;
        out.homingTurnRate = ps.homingTurnRate;
        _spawnBuf.push(out);
        if (wantKeyframeProjectileResync) _resyncSeenIds.add(ps.id);
      }
    }
    if (wantKeyframeProjectileResync) {
      const liveProjectiles = world.getProjectiles();
      for (let i = 0; i < liveProjectiles.length; i++) {
        const entity = liveProjectiles[i];
        if (_resyncSeenIds.has(entity.id)) continue;
        const proj = entity.projectile;
        if (!proj) continue;
        const out = getPooledProjectileSpawn();
        out.id = entity.id;
        out._pos.x = entity.transform.x;
        out._pos.y = entity.transform.y;
        out._pos.z = entity.transform.z;
        out.rotation = entity.transform.rotation;
        out._velocity.x = proj.velocityX;
        out._velocity.y = proj.velocityY;
        out._velocity.z = proj.velocityZ;
        out.projectileType = projectileTypeToCode(proj.projectileType);
        out.maxLifespan = proj.maxLifespan;
        out.turretId = proj.sourceTurretId !== undefined
          ? turretIdToCode(proj.sourceTurretId)
          : TURRET_ID_UNKNOWN;
        out.shotId = shotIdToCode(proj.shotId);
        out.sourceTurretId = proj.sourceTurretId !== undefined
          ? turretIdToCode(proj.sourceTurretId)
          : undefined;
        out.playerId = proj.ownerId;
        out.sourceEntityId = proj.sourceEntityId;
        out.turretIndex = proj.config.turretIndex ?? 0;
        out.barrelIndex = proj.sourceBarrelIndex ?? 0;
        out.isDGun = entity.dgunProjectile?.isDGun ? true : undefined;
        // Re-sync spawns carry the projectile's CURRENT pos, not its
        // muzzle origin. Setting `fromParentDetonation` tells the client
        // applier to skip the barrel-tip override and treat `pos` as
        // authoritative — same flag submunitions use for the same
        // reason.
        out.fromParentDetonation = true;
        const pts = proj.points;
        if (pts && pts.length >= 2) {
          const start = pts[0];
          const end = pts[pts.length - 1];
          out._beamStart.x = start.x;
          out._beamStart.y = start.y;
          out._beamStart.z = start.z;
          out._beamEnd.x = end.x;
          out._beamEnd.y = end.y;
          out._beamEnd.z = end.z;
          out.beam = out._beam;
        } else {
          out.beam = undefined;
        }
        out.targetEntityId = proj.homingTargetId;
        out.homingTurnRate = proj.homingTurnRate;
        _spawnBuf.push(out);
      }
    }
    if (_spawnBuf.length > 0) netProjectileSpawns = _spawnBuf;
  }

  // Serialize projectile despawns (reuse buffer)
  let netProjectileDespawns: NetworkServerSnapshotProjectileDespawn[] | undefined;
  if (projectileDespawns && projectileDespawns.length > 0) {
    _despawnBuf.length = 0;
    for (let i = 0; i < projectileDespawns.length; i++) {
      const out = getPooledProjectileDespawn();
      out.id = projectileDespawns[i].id;
      _despawnBuf.push(out);
    }
    netProjectileDespawns = _despawnBuf;
  }

  // Serialize projectile velocity updates (reuse buffer)
  let netVelocityUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
  if (projectileVelocityUpdates && projectileVelocityUpdates.length > 0) {
    _velUpdateBuf.length = 0;
    for (let i = 0; i < projectileVelocityUpdates.length; i++) {
      const vu = projectileVelocityUpdates[i];
      const projectile = world.getEntity(vu.id)?.projectile;
      if (!shouldSendProjectileSideChannel(projectile?.ownerId, recipientPlayerId, tick)) continue;
      const out = getPooledVelocityUpdate();
      out.id = vu.id;
      out._pos.x = vu.pos.x;
      out._pos.y = vu.pos.y;
      out._pos.z = vu.pos.z;
      out._velocity.x = vu.velocity.x;
      out._velocity.y = vu.velocity.y;
      out._velocity.z = vu.velocity.z;
      _velUpdateBuf.push(out);
    }
    if (_velUpdateBuf.length > 0) netVelocityUpdates = _velUpdateBuf;
  }

  // Serialize authoritative live beam/laser paths. Spawns only carry
  // the initial line; reflected beams move every tick with turret aim
  // and mirror intersections, so clients need the current path in
  // snapshots to draw without re-running beam tracing locally. Each
  // beam is one polyline (start, ...reflections, end) with per-vertex
  // velocity — clients extrapolate every vertex independently between
  // snapshots, mirroring the turret rotation+angularVelocity pattern.
  let netBeamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
  const lineProjectiles = world.getLineProjectiles();
  if (lineProjectiles.length > 0) {
    _beamUpdateBuf.length = 0;
    for (let i = 0; i < lineProjectiles.length; i++) {
      const entity = lineProjectiles[i];
      const proj = entity.projectile;
      if (!proj) continue;
      if (!shouldSendProjectileSideChannel(proj.ownerId, recipientPlayerId, tick)) continue;
      const srcPts = proj.points;
      if (!srcPts || srcPts.length < 2) continue;

      const update = getPooledBeamUpdate();
      update.id = entity.id;
      update.obstructionT = proj.obstructionT === undefined ? undefined : qRot(proj.obstructionT);
      update.endpointDamageable = proj.endpointDamageable === false ? false : undefined;
      const dstPts = update.points;
      dstPts.length = srcPts.length;
      for (let p = 0; p < srcPts.length; p++) {
        const sp = srcPts[p];
        const out = getPooledBeamPoint();
        out.x = qPos(sp.x);
        out.y = qPos(sp.y);
        out.z = qPos(sp.z);
        // Velocities are quantized at the same precision as projectile
        // velocities (qVel = 0.1 wu/sec). Lets the client extrapolate
        // each vertex between snapshots — same role the turret
        // rotation+angularVelocity pair plays for turret pose.
        //
        // Common case: a vertex anchored to a static structure (mirror
        // panel on a building, or beam endpoint on a stationary unit)
        // has all-zero velocity every tick. Skip the three Math.round
        // calls in that case — qVel(0) === 0.
        if (sp.vx === 0 && sp.vy === 0 && sp.vz === 0) {
          out.vx = 0;
          out.vy = 0;
          out.vz = 0;
        } else {
          out.vx = qVel(sp.vx);
          out.vy = qVel(sp.vy);
          out.vz = qVel(sp.vz);
        }
        out.mirrorEntityId = sp.mirrorEntityId;
        out.reflectorKind = sp.reflectorKind;
        out.reflectorPlayerId = sp.reflectorPlayerId;
        out.normalX = sp.normalX === undefined ? undefined : qNormal(sp.normalX);
        out.normalY = sp.normalY === undefined ? undefined : qNormal(sp.normalY);
        out.normalZ = sp.normalZ === undefined ? undefined : qNormal(sp.normalZ);
        dstPts[p] = out;
      }

      _beamUpdateBuf.push(update);
    }
    if (_beamUpdateBuf.length > 0) netBeamUpdates = _beamUpdateBuf;
  }

  // Nest projectile events (undefined when all empty)
  const hasProjectiles = netProjectileSpawns || netProjectileDespawns || netVelocityUpdates || netBeamUpdates;
  if (hasProjectiles) {
    _projectilesBuf.spawns = netProjectileSpawns;
    _projectilesBuf.despawns = netProjectileDespawns;
    _projectilesBuf.velocityUpdates = netVelocityUpdates;
    _projectilesBuf.beamUpdates = netBeamUpdates;
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
  _snapshotBuf.tick = tick;
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
  world: WorldState,
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

  if (entity.type === 'unit' && entity.unit) {
    // Attach the unit sub-object on every delta this entity appears
    // in (any change at all). That way turret rotation can ship in
    // every diff snap, not just the ones where the turret crossed
    // its rotation threshold — keeps client-side turret aim smooth
    // even while the unit is mid-traverse below the change threshold.
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT |
      // Unit shells now ride the building-change bit so each tick of
      // resource flow into a shell's `paid.{e,m,m}` ships to clients.
      ENTITY_CHANGED_BUILDING;
    const hasUnitFields = isFull || (changedFields! & unitFieldMask);

    if (hasUnitFields) {
      const u = pool.unitSub;
      ne.unit = u;

      // Full records must be self-contained. Remote clients can miss
      // the first real-battle keyframe during lobby -> battle handoff;
      // if later keyframes omit unitType/radius/commander statics,
      // the client can never create those entities and renders an
      // empty battlefield even while snapshots keep arriving.
      if (isFull) {
        u.unitType = unitTypeToCode(entity.unit.unitType);
        u.radius = pool.unitRadius;
        u.radius.body = entity.unit.radius.body;
        u.radius.shot = entity.unit.radius.shot;
        u.radius.push = entity.unit.radius.push;
        u.bodyCenterHeight = entity.unit.bodyCenterHeight;
        u.mass = entity.unit.mass;
        u.isCommander = isCommander(entity) ? true : undefined;
      } else {
        u.unitType = undefined;
        u.radius = undefined;
        u.bodyCenterHeight = undefined;
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

      // Smoothed surface normal — same shape as velocity. Piggybacked
      // on POS bit because the normal is a function of (x, y) and
      // changes when (and only when) the unit moves. Omitted when
      // POS didn't change — the client keeps the last value.
      if (isFull || (changedFields! & ENTITY_CHANGED_POS)) {
        const sn = entity.unit.surfaceNormal;
        if (!u.surfaceNormal) u.surfaceNormal = { nx: 0, ny: 0, nz: 1 };
        u.surfaceNormal.nx = qNormal(sn.nx);
        u.surfaceNormal.ny = qNormal(sn.ny);
        u.surfaceNormal.nz = qNormal(sn.nz);
      } else {
        u.surfaceNormal = undefined;
      }

      // HP
      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        u.hp.curr = entity.unit.hp;
        u.hp.max = entity.unit.maxHp;
      }

      // Unit shell construction state — same shape as building.build,
      // included on full records and on ENTITY_CHANGED_BUILDING deltas
      // so the client can render the three resource bars + HP bar.
      u.build = undefined;
      if ((isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) && entity.buildable) {
        u.build = {
          complete: entity.buildable.isComplete,
          paid: {
            energy: entity.buildable.paid.energy,
            mana: entity.buildable.paid.mana,
            metal: entity.buildable.paid.metal,
          },
        };
      }

      // Actions
      u.actions = undefined;
      if (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS)) {
        const actions = entity.unit.actions ?? [];
        const count = actions.length;
        while (pool.actions.length < count) pool.actions.push(createPooledAction());
        pool.actions.length = count;
        for (let i = 0; i < count; i++) {
          const src = actions[i];
          const dst = pool.actions[i] as PooledActionStorage;
          dst.type = actionTypeToCode(src.type);
          if (src.x !== undefined) {
            dst._pos.x = src.x;
            dst._pos.y = src.y;
            dst.pos = dst._pos;
          } else {
            dst.pos = undefined;
          }
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
          if (src.gridX !== undefined) {
            dst._grid.x = src.gridX;
            dst._grid.y = src.gridY!;
            dst.grid = dst._grid;
          } else {
            dst.grid = undefined;
          }
          dst.buildingId = src.buildingId;
        }
        u.actions = pool.actions;
      }

      // Turrets. Full records seed the client; deltas only carry this
      // array when combat actually dirtied turret state. This keeps
      // large armies moving without serializing every idle turret.
      u.turrets = undefined;
      const weapons0 = entity.combat?.turrets;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        u.turrets = writeTurretsToPool(pool, weapons0);
      }

      // Serialize builder state (commander)
      u.buildTargetId = undefined;
      if (entity.builder) {
        u.buildTargetId = entity.builder.currentBuildTarget ?? null;
      }
    }
  }

  if (entity.type === 'building' && entity.building) {
    // Determine which building-specific field groups changed
    const buildingFieldMask = ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_FACTORY | ENTITY_CHANGED_TURRETS;
    const hasBuildingFields = isFull || (changedFields! & buildingFieldMask);

    // Only attach building sub-object when at least one building field changed
    if (hasBuildingFields) {
      const b = pool.buildingSub;
      ne.building = b;
      b.solar = undefined;
      b.metalExtractionRate = undefined;
      b.turrets = undefined;

      // Full records must be self-contained for the same reason as
      // unit records: clients can miss the first keyframe during a
      // network handoff and still need later keyframes to create
      // every entity from scratch.
      if (isFull) {
        b.dim = pool.buildingDim;
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.type = entity.buildingType !== undefined
          ? buildingTypeToCode(entity.buildingType)
          : undefined;
        b.metalExtractionRate = entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : undefined;
      } else {
        b.dim = undefined;
        b.type = undefined;
        b.metalExtractionRate = undefined;
      }

      // HP
      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        b.hp.curr = entity.building.hp;
        b.hp.max = entity.building.maxHp;
      }

      // Build progress
      if (isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) {
        if (entity.buildable) {
          const buildable = entity.buildable;
          b.build.complete = buildable.isComplete;
          b.build.paid.energy = buildable.paid.energy;
          b.build.paid.mana = buildable.paid.mana;
          b.build.paid.metal = buildable.paid.metal;
        } else {
          b.build.complete = true;
          b.build.paid.energy = 0;
          b.build.paid.mana = 0;
          b.build.paid.metal = 0;
        }
        if (entity.building.solar) {
          const s = pool.solarSub;
          s.open = entity.building.solar.open;
          b.solar = s;
        }
      }

      const weapons0 = entity.combat?.turrets;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        b.turrets = writeTurretsToPool(pool, weapons0);
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
            pool.buildQueue[i] = unitTypeToCode(srcQueue[i]);
          }
          f.queue = pool.buildQueue;

          // Prefer the live shell fraction when present, and keep the
          // mirrored progress as a fallback for delta-state tracking.
          if (entity.factory.currentShellId != null) {
            const shell = world.getEntity(entity.factory.currentShellId);
            f.progress = shell?.buildable
              ? getBuildFraction(shell.buildable)
              : entity.factory.currentBuildProgress;
          } else {
            f.progress = 0;
          }
          f.producing = entity.factory.isProducing;
          f.energyRate = entity.factory.energyRateFraction;
          f.manaRate = entity.factory.manaRateFraction;
          f.metalRate = entity.factory.metalRateFraction;

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
