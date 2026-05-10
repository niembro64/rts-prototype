import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getBuildFraction } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity, NetworkServerSnapshotGridCell, NetworkServerSnapshotTurret, NetworkServerSnapshotAction } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type { GamePhase } from '../../types/network';
import {
  ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP, ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_BUILDING, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_SUSPENSION, ENTITY_CHANGED_JUMP, ENTITY_CHANGED_MOVEMENT_ACCEL,
  turretStateToCode,
  unitTypeToCode, buildingTypeToCode,
  turretIdToCode,
} from '../../types/network';
import { SNAPSHOT_CONFIG } from '../../config';
import {
  createActionDto,
  createTurretDto,
  createWaypointDto,
  type WaypointDto,
} from './snapshotDtoCopy';
import {
  clearNetworkUnitActions,
  clearNetworkUnitJump,
  clearNetworkUnitMovementAccel,
  clearNetworkUnitStaticFields,
  clearNetworkUnitSurfaceNormal,
  clearNetworkUnitSuspension,
  createNetworkUnitSnapshot,
  writeNetworkUnitActions,
  writeNetworkUnitJump,
  writeNetworkUnitMovementAccel,
  writeNetworkUnitStaticFields,
  writeNetworkUnitSurfaceNormal,
  writeNetworkUnitSuspension,
  writeNetworkUnitVelocity,
} from './unitSnapshotFields';
import { serializeAudioEvents } from './stateSerializerAudio';
import { serializeEconomySnapshot } from './stateSerializerEconomy';
import { serializeGridSnapshot } from './stateSerializerGrid';
import { serializeMinimapSnapshotEntities } from './stateSerializerMinimap';
import { serializeProjectileSnapshot } from './stateSerializerProjectiles';
import { serializeSprayTargets } from './stateSerializerSpray';
import {
  SNAPSHOT_DIRTY_FORCE_FIELDS,
  aoiRemovedEntityIdsBuf as _aoiRemovedIdsBuf,
  copyPrevState,
  dirtyEntityFieldsBuf as _dirtyEntityFieldsBuf,
  dirtyEntityIdsBuf as _dirtyEntityIdsBuf,
  getDeltaTrackingState,
  getEntityDeltaChangedFields,
  getNextEntityState,
  getPrevState,
  removedEntityIdsBuf as _removedIdsBuf,
} from './stateSerializerEntityDelta';

export {
  captureSnapshotEntityStates,
  resetDeltaTracking,
  resetDeltaTrackingForKey,
} from './stateSerializerEntityDelta';

// === Object pool for NetworkServerSnapshotEntity (eliminates per-frame allocations) ===
// Each frame we reset the pool index and overwrite existing objects.

const INITIAL_ENTITY_POOL = 200; // MAX_TOTAL_UNITS (120) + buildings + headroom
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;

// Pre-allocated sub-objects for the nested NetworkServerSnapshotEntity shape
type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;

// Extended pool entry with pre-allocated sub-arrays and sub-objects
type PooledEntry = {
  entity: NetworkServerSnapshotEntity;
  unitSub: UnitSub;
  unitMovementAccel: Vec3;
  unitSuspension: NonNullable<UnitSub['suspension']>;
  unitJump: NonNullable<UnitSub['jump']>;
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
  waypoints: WaypointDto[];
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
  while (pool.turrets.length < count) pool.turrets.push(createTurretDto());
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

function qSuspension(n: number): number {
  return Math.round(n * 100) / 100;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createTurretDto());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createActionDto());
  const waypoints: WaypointDto[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createWaypointDto());
  return {
    entity: { id: 0, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1 as PlayerId },
    unitSub: createNetworkUnitSnapshot(),
    unitMovementAccel: { x: 0, y: 0, z: 0 },
    unitSuspension: {
      offset: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    unitJump: {},
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

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];

// Pre-allocated sub-objects for nested fields (avoids per-frame allocation)
const _gameStateBuf: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

// Reusable snapshot object (avoids creating a new object literal every frame)
const _snapshotBuf: NetworkServerSnapshot = {
  tick: 0,
  entities: _entityBuf,
  minimapEntities: undefined,
  economy: serializeEconomySnapshot(0, undefined),
  sprayTargets: undefined,
  audioEvents: undefined,
  projectiles: undefined,
  gameState: undefined,
  grid: undefined,
  isDelta: false,
  removedEntityIds: undefined,
};

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
  aoi?: SnapshotAoiBounds;
};

export type SnapshotAoiBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function getAoiPadding(entity: Entity): number {
  if (entity.unit) return 100;
  const building = entity.building;
  if (!building) return 100;
  return Math.max(building.width, building.height) * 0.5 + 150;
}

function isEntityInsideAoi(
  entity: Entity,
  aoi: SnapshotAoiBounds | undefined,
  recipientPlayerId: PlayerId | undefined,
): boolean {
  if (!aoi) return true;
  // Keep owned entities authoritative even while the camera is away so
  // selections and queued orders do not evaporate as the user pans.
  if (
    recipientPlayerId !== undefined &&
    entity.ownership?.playerId === recipientPlayerId
  ) {
    return true;
  }
  const padding = getAoiPadding(entity);
  const x = entity.transform.x;
  const y = entity.transform.y;
  return (
    x >= aoi.minX - padding &&
    x <= aoi.maxX + padding &&
    y >= aoi.minY - padding &&
    y <= aoi.maxY + padding
  );
}

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
  const aoi = options?.aoi;
  const tick = world.getTick();

  // Reset entity pool for this frame
  _poolIndex = 0;
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;
  const acceptsEntity = (entity: Entity): boolean =>
    (entity.type === 'unit' || entity.type === 'building') &&
    isEntityInsideAoi(entity, aoi, recipientPlayerId);

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

    if (aoi) {
      _aoiRemovedIdsBuf.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity || !acceptsEntity(entity)) {
          _aoiRemovedIdsBuf.push(id);
        }
      }
      for (let i = 0; i < _aoiRemovedIdsBuf.length; i++) {
        forgetTrackedEntity(_aoiRemovedIdsBuf[i], true);
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
      const next = getNextEntityState(entity);
      const dirtyForcedFields = dirtyFields & SNAPSHOT_DIRTY_FORCE_FIELDS;
      const jumpAnchorFields = (dirtyFields & ENTITY_CHANGED_JUMP)
        ? ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL
        : 0;
      const changedFields = isNew
        ? undefined
        : getEntityDeltaChangedFields(entity, prev, next, recipientPlayerId) |
          dirtyForcedFields |
          jumpAnchorFields;
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntity(entity, changedFields, world);
        if (netEntity) _entityBuf.push(netEntity);
        copyPrevState(next, prev);
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
        copyPrevState(getNextEntityState(entity), prev);
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

  const netMinimapEntities = serializeMinimapSnapshotEntities(world, aoi !== undefined);

  const netEconomy = serializeEconomySnapshot(world.playerCount, recipientPlayerId);

  const netSprayTargets = serializeSprayTargets(sprayTargets);

  const netAudioEvents = serializeAudioEvents(audioEvents);

  const netProjectiles = serializeProjectileSnapshot({
    world,
    deltaEnabled,
    tick,
    recipientPlayerId,
    projectileSpawns,
    projectileDespawns,
    projectileVelocityUpdates,
  });

  const netGrid = serializeGridSnapshot(gridCells, gridSearchCells, gridCellSize);

  // Nest game state
  _gameStateBuf.phase = gamePhase;
  _gameStateBuf.winnerId = winnerId;

  // Reuse snapshot object
  _snapshotBuf.tick = tick;
  _snapshotBuf.entities = _entityBuf;
  _snapshotBuf.minimapEntities = netMinimapEntities;
  _snapshotBuf.economy = netEconomy;
  _snapshotBuf.sprayTargets = netSprayTargets;
  _snapshotBuf.audioEvents = netAudioEvents;
  _snapshotBuf.projectiles = netProjectiles;
  _snapshotBuf.gameState = _gameStateBuf;
  _snapshotBuf.grid = netGrid;
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
      ENTITY_CHANGED_BUILDING |
      // Smoothed surface normal can drift past wire precision while
      // POS holds steady (EMA still settling, host tilt-mode flip).
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_SUSPENSION |
      ENTITY_CHANGED_JUMP |
      ENTITY_CHANGED_MOVEMENT_ACCEL;
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
        writeNetworkUnitStaticFields(
          u,
          entity.unit,
          pool.unitRadius,
          isCommander(entity),
        );
      } else {
        clearNetworkUnitStaticFields(u);
      }

      // Velocity — full keyframes always carry it; on deltas it ships
      // when ENTITY_CHANGED_VEL is set (velocity moved more than the
      // threshold). Quantized to 0.1 wu/s for shorter JSON.
      if (isFull || (changedFields! & ENTITY_CHANGED_VEL)) {
        writeNetworkUnitVelocity(u, entity.unit, qVel);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_MOVEMENT_ACCEL)) {
        writeNetworkUnitMovementAccel(u, entity.unit, pool.unitMovementAccel, qVel);
      } else {
        clearNetworkUnitMovementAccel(u);
      }

      // Smoothed surface normal — same shape as velocity. Rides POS
      // when the unit moved AND a dedicated NORMAL bit when the EMA
      // is still settling on a stationary unit (or the host flipped
      // tilt mode). Omitted otherwise; the client keeps the last value.
      if (
        isFull ||
        (changedFields! & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL))
      ) {
        writeNetworkUnitSurfaceNormal(u, entity.unit, qNormal);
      } else {
        clearNetworkUnitSurfaceNormal(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_SUSPENSION)) {
        writeNetworkUnitSuspension(u, entity.unit, pool.unitSuspension, qSuspension, qVel);
      } else {
        clearNetworkUnitSuspension(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_JUMP)) {
        writeNetworkUnitJump(u, entity.unit, pool.unitJump);
      } else {
        clearNetworkUnitJump(u);
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
      clearNetworkUnitActions(u);
      if (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS)) {
        writeNetworkUnitActions(u, entity.unit, pool.actions);
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
          while (pool.waypoints.length < wpCount) pool.waypoints.push(createWaypointDto());
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
