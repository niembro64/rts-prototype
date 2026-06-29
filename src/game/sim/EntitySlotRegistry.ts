import type { Entity, EntityId } from './types';
import {
  getBuildFraction,
  hasMaterializedLiveUnitPiece,
  isEntityActive,
} from './buildableHelpers';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import {
  BUILDING_BLUEPRINT_CODE_UNKNOWN,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  PROJECTILE_TYPE_UNKNOWN,
  SHOT_BLUEPRINT_CODE_UNKNOWN,
  UNIT_BLUEPRINT_CODE_UNKNOWN,
  buildingBlueprintIdToCode,
  projectileTypeToCode,
  shotBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import {
  ENTITY_STATE_BLUEPRINT_NONE,
  ENTITY_STATE_KIND_BUILDING,
  ENTITY_STATE_KIND_SHOT,
  ENTITY_STATE_KIND_TOWER,
  ENTITY_STATE_KIND_UNIT,
  ENTITY_STATE_NO_BODY_SLOT,
  SPATIAL_KIND_BUILDING,
  SPATIAL_KIND_PROJECTILE,
  SPATIAL_KIND_UNIT,
  getSimWasm,
  type SimWasm,
} from '../sim-wasm/init';

export const ENTITY_SLOT_FLAG_ALIVE = 1 << 0;
export const ENTITY_SLOT_FLAG_ACTIVE = 1 << 1;
export const ENTITY_SLOT_FLAG_HAS_BODY = 1 << 2;
export const ENTITY_SLOT_FLAG_HAS_UNIT = 1 << 3;
export const ENTITY_SLOT_FLAG_HAS_BUILDING = 1 << 4;
export const ENTITY_SLOT_FLAG_HAS_PROJECTILE = 1 << 5;
export const ENTITY_SLOT_FLAG_HAS_COMBAT = 1 << 6;

export const ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE = 1 << 0;
export const ENTITY_SLOT_BUILD_FLAG_COMPLETE = 1 << 1;
export const ENTITY_SLOT_BUILD_FLAG_GHOST = 1 << 2;
export const ENTITY_SLOT_BUILD_FLAG_INTERRUPTED = 1 << 3;

export const ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL = 1 << 0;
export const ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION = 1 << 1;
export const ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY = 1 << 2;

const INITIAL_KIND_CAPACITY = 1024;
const EPSILON = 1e-9;
const HOT_MOTION_DIRTY_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;

export type EntityStateViews = {
  capacity: number;
  entityId: Int32Array;
  kind: Uint8Array;
  flags: Uint32Array;
  ownerPlayerId: Uint32Array;
  teamId: Uint32Array;
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  rotation: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  surfaceNormalX: Float64Array;
  surfaceNormalY: Float64Array;
  surfaceNormalZ: Float64Array;
  orientationX: Float64Array;
  orientationY: Float64Array;
  orientationZ: Float64Array;
  orientationW: Float64Array;
  angularVelocityX: Float64Array;
  angularVelocityY: Float64Array;
  angularVelocityZ: Float64Array;
  unitMotionFlags: Uint32Array;
  hp: Float64Array;
  maxHp: Float64Array;
  radiusCollision: Float64Array;
  radiusHitbox: Float64Array;
  radiusOther: Float64Array;
  aabbHx: Float64Array;
  aabbHy: Float64Array;
  aabbHz: Float64Array;
  bodySlot: Int32Array;
  unitBlueprintCode: Uint32Array;
  buildingBlueprintCode: Uint32Array;
  shotBlueprintCode: Uint32Array;
  projectileTypeCode: Uint32Array;
  buildProgress: Float64Array;
  buildFlags: Uint32Array;
  dirtyMask: Uint32Array;
};

type EntityStateExpectation = {
  kind: number;
  flags: number;
  ownerPlayerId: number;
  teamId: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  vx: number;
  vy: number;
  vz: number;
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  orientationX: number;
  orientationY: number;
  orientationZ: number;
  orientationW: number;
  angularVelocityX: number;
  angularVelocityY: number;
  angularVelocityZ: number;
  unitMotionFlags: number;
  hp: number;
  maxHp: number;
  radiusCollision: number;
  radiusHitbox: number;
  radiusOther: number;
  aabbHx: number;
  aabbHy: number;
  aabbHz: number;
  bodySlot: number;
  unitBlueprintCode: number;
  buildingBlueprintCode: number;
  shotBlueprintCode: number;
  projectileTypeCode: number;
  buildProgress: number;
  buildFlags: number;
};

export class EntitySlotRegistry {
  private readonly slotByEntityId = new Map<EntityId, number>();
  private readonly entityBySlot: (Entity | undefined)[] = [];
  private spatialKindBySlot = new Uint8Array(INITIAL_KIND_CAPACITY);
  private readonly unitSlots = new Set<EntityId>();
  private readonly buildingSlots = new Set<EntityId>();
  private readonly projectileSlots = new Set<EntityId>();
  private dirtyDrainSlots = new Uint32Array(INITIAL_KIND_CAPACITY);
  private dirtyDrainMasks = new Uint32Array(INITIAL_KIND_CAPACITY);
  private views: EntityStateViews | null = null;
  private viewsBuffer: ArrayBuffer | null = null;

  private sim(): SimWasm | undefined {
    return getSimWasm();
  }

  private ensureLocalCapacity(slot: number): void {
    if (slot < this.spatialKindBySlot.length) return;
    let capacity = this.spatialKindBySlot.length;
    while (capacity <= slot) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.spatialKindBySlot);
    this.spatialKindBySlot = next;
  }

  private ensureStateCapacity(sim: SimWasm, slot: number): void {
    const previousCapacity = this.views?.capacity ?? sim.entityState.capacity();
    sim.entityState.ensureCapacity(slot);
    if (slot >= previousCapacity) this.refreshViews();
  }

  slotForEntity(entity: Entity): number {
    const sim = this.sim();
    if (sim === undefined) return -1;
    let slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) {
      slot = sim.spatial.allocSlot();
      this.slotByEntityId.set(entity.id, slot);
      if (slot >= this.entityBySlot.length) this.entityBySlot.length = slot + 1;
      this.entityBySlot[slot] = entity;
      entity.entitySlotId = slot;
      this.ensureLocalCapacity(slot);
      this.ensureStateCapacity(sim, slot);
      sim.spatial.setEntityId(slot, entity.id);
      sim.entityState.ensureCapacity(slot);
    } else if (this.entityBySlot[slot] !== entity) {
      this.entityBySlot[slot] = entity;
      entity.entitySlotId = slot;
      sim.spatial.setEntityId(slot, entity.id);
    } else if (entity.entitySlotId !== slot) {
      entity.entitySlotId = slot;
    }
    return slot;
  }

  getSlot(entityId: EntityId): number {
    const slot = this.slotByEntityId.get(entityId);
    return slot === undefined ? -1 : slot;
  }

  getEntitySlot(entity: Entity): number {
    const slot = entity.entitySlotId;
    if (slot >= 0) return slot;
    return this.getSlot(entity.id);
  }

  resolveSlot(slot: number): Entity | undefined {
    return this.entityBySlot[slot];
  }

  clear(): void {
    const sim = this.sim();
    if (sim !== undefined) {
      sim.spatial.clear();
      sim.entityState.clear();
      sim.turretPool.clear();
    }
    for (let slot = 0; slot < this.entityBySlot.length; slot++) {
      const entity = this.entityBySlot[slot];
      if (entity !== undefined) entity.entitySlotId = -1;
    }
    this.slotByEntityId.clear();
    this.entityBySlot.length = 0;
    this.spatialKindBySlot.fill(0);
    this.unitSlots.clear();
    this.buildingSlots.clear();
    this.projectileSlots.clear();
    this.refreshViews();
  }

  unsetEntity(entityId: EntityId): void {
    const slot = this.slotByEntityId.get(entityId);
    if (slot === undefined) return;
    const entity = this.entityBySlot[slot];
    const sim = this.sim();
    if (sim !== undefined) {
      sim.spatial.freeSlot(slot);
      sim.entityState.unsetSlot(slot);
      sim.turretPool.unsetEntity(slot);
      sim.combatTargeting.unsetEntity(slot);
    }
    this.slotByEntityId.delete(entityId);
    if (entity !== undefined && entity.id === entityId) entity.entitySlotId = -1;
    this.entityBySlot[slot] = undefined;
    if (slot < this.spatialKindBySlot.length) this.spatialKindBySlot[slot] = 0;
    this.unitSlots.delete(entityId);
    this.buildingSlots.delete(entityId);
    this.projectileSlots.delete(entityId);
  }

  removeUnit(entityId: EntityId): void {
    if (!this.unitSlots.delete(entityId)) return;
    this.unsetSpatialKind(entityId, SPATIAL_KIND_UNIT);
  }

  removeBuilding(entityId: EntityId): void {
    if (!this.buildingSlots.delete(entityId)) return;
    this.unsetSpatialKind(entityId, SPATIAL_KIND_BUILDING);
  }

  removeProjectile(entityId: EntityId): void {
    if (!this.projectileSlots.delete(entityId)) return;
    this.unsetSpatialKind(entityId, SPATIAL_KIND_PROJECTILE);
  }

  private unsetSpatialKind(entityId: EntityId, kind: number): void {
    const slot = this.slotByEntityId.get(entityId);
    if (slot === undefined) return;
    if (this.spatialKindBySlot[slot] !== kind) return;
    const sim = this.sim();
    if (sim !== undefined) sim.spatial.unsetSlot(slot);
    this.spatialKindBySlot[slot] = 0;
  }

  setUnit(entity: Entity, teamId?: number): number {
    const slot = this.refreshEntityState(entity, 0, teamId);
    const sim = this.sim();
    if (slot < 0 || sim === undefined) return slot;
    if (!entity.unit || !hasMaterializedLiveUnitPiece(entity)) {
      this.removeUnit(entity.id);
      return slot;
    }
    this.spatialKindBySlot[slot] = SPATIAL_KIND_UNIT;
    this.unitSlots.add(entity.id);
    const playerId = entity.ownership !== null ? entity.ownership.playerId : 0;
    sim.spatial.setUnit(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      entity.unit.radius.collision, entity.unit.radius.hitbox,
      playerId,
      entity.unit.hp > 0 ? 1 : 0,
    );
    return slot;
  }

  setUnitSpatial(entity: Entity, teamId?: number): number {
    const sim = this.sim();
    if (sim === undefined) return -1;
    let slot = entity.entitySlotId;
    if (slot < 0 || this.entityBySlot[slot] !== entity) {
      slot = this.slotForEntity(entity);
    }
    if (slot < 0) return slot;
    const unit = entity.unit;
    if (unit === null || !hasMaterializedLiveUnitPiece(entity)) {
      this.refreshEntityState(entity, 0, teamId);
      this.removeUnit(entity.id);
      return slot;
    }
    if (!this.hasCurrentEntityStateRow(sim, slot, entity.id)) {
      this.refreshEntityState(entity, 0, teamId);
    }
    if (this.spatialKindBySlot[slot] !== SPATIAL_KIND_UNIT) {
      this.spatialKindBySlot[slot] = SPATIAL_KIND_UNIT;
      this.unitSlots.add(entity.id);
    }
    const playerId = entity.ownership !== null ? entity.ownership.playerId : 0;
    sim.spatial.setUnit(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      unit.radius.collision, unit.radius.hitbox,
      playerId,
      unit.hp > 0 ? 1 : 0,
    );
    return slot;
  }

  setBuilding(entity: Entity, teamId?: number): number {
    const slot = this.refreshEntityState(entity, 0, teamId);
    const sim = this.sim();
    if (slot < 0 || sim === undefined) return slot;
    const building = entity.building;
    if (!building) {
      this.removeBuilding(entity.id);
      return slot;
    }
    this.spatialKindBySlot[slot] = SPATIAL_KIND_BUILDING;
    this.buildingSlots.add(entity.id);
    const playerId = entity.ownership !== null ? entity.ownership.playerId : 0;
    sim.spatial.setBuilding(
      slot,
      entity.transform.x, entity.transform.y, getBuildingCombatCenterZ(entity),
      building.width / 2, building.height / 2, building.depth / 2,
      playerId,
      building.hp > 0 ? 1 : 0,
      isEntityActive(entity) ? 1 : 0,
    );
    return slot;
  }

  setProjectile(entity: Entity, teamId?: number): number {
    const slot = this.refreshEntityState(entity, 0, teamId);
    const sim = this.sim();
    if (slot < 0 || sim === undefined) return slot;
    const projectile = entity.projectile;
    if (!projectile) {
      this.removeProjectile(entity.id);
      return slot;
    }
    this.spatialKindBySlot[slot] = SPATIAL_KIND_PROJECTILE;
    this.projectileSlots.add(entity.id);
    sim.spatial.setProjectile(
      slot,
      entity.transform.x, entity.transform.y, entity.transform.z,
      projectile.ownerId ?? 0,
      projectile.projectileType === 'projectile' ? 1 : 0,
      projectile.config.shotProfile.runtime.radius.collision,
      projectile.config.shotProfile.runtime.radius.hitbox,
    );
    return slot;
  }

  setProjectilesHotBatch(
    count: number,
    slots: Uint32Array,
    xs: Float64Array,
    ys: Float64Array,
    zs: Float64Array,
    vxs: Float64Array,
    vys: Float64Array,
    vzs: Float64Array,
    hps: Float64Array,
    maxHps: Float64Array,
    flags: Uint32Array,
    ownerPlayerIds: Uint32Array,
    projectileTypeCodes: Uint32Array,
    radiusCollision: Float64Array,
    radiusHitbox: Float64Array,
  ): number {
    const sim = this.sim();
    if (sim === undefined || count === 0) return 0;
    const updated = sim.entityState.setProjectilesHotBatch(
      count,
      slots,
      xs,
      ys,
      zs,
      vxs,
      vys,
      vzs,
      hps,
      maxHps,
      flags,
      ownerPlayerIds,
      projectileTypeCodes,
      radiusCollision,
      radiusHitbox,
    );
    this.refreshViewsIfStale();
    return updated;
  }

  bindProjectileForBatch(entity: Entity, teamId?: number): number {
    const slot = this.slotForEntity(entity);
    if (slot < 0) return slot;
    this.ensureLocalCapacity(slot);
    this.spatialKindBySlot[slot] = SPATIAL_KIND_PROJECTILE;
    this.projectileSlots.add(entity.id);
    const views = this.ensureViews();
    if (views === null || slot >= views.capacity || views.entityId[slot] !== entity.id) {
      this.refreshEntityState(entity, 0, teamId);
    }
    return slot;
  }

  projectileHotFlags(entity: Entity): number {
    const projectile = entity.projectile;
    if (projectile === null) return 0;
    let flags = ENTITY_SLOT_FLAG_HAS_PROJECTILE | ENTITY_SLOT_FLAG_ACTIVE;
    if (entity.body !== null) flags |= ENTITY_SLOT_FLAG_HAS_BODY;
    if (projectile.projectileType !== 'projectile' || projectile.hp > 0 || projectile.maxHp <= 0) {
      flags |= ENTITY_SLOT_FLAG_ALIVE;
    }
    return flags;
  }

  refreshEntityState(entity: Entity, dirtyMask = 0, teamId?: number): number {
    const sim = this.sim();
    if (sim === undefined) return -1;
    const slot = this.slotForEntity(entity);
    if (slot < 0) return slot;
    this.ensureStateCapacity(sim, slot);
    const expected = this.expectedState(entity, slot, teamId);
    sim.entityState.setLifecycle(
      slot,
      entity.id,
      expected.kind,
      expected.ownerPlayerId,
      expected.teamId,
      expected.flags,
    );
    sim.entityState.setTransform(
      slot,
      expected.x,
      expected.y,
      expected.z,
      expected.rotation,
    );
    sim.entityState.setVelocity(slot, expected.vx, expected.vy, expected.vz);
    sim.entityState.setUnitMotion(
      slot,
      expected.surfaceNormalX,
      expected.surfaceNormalY,
      expected.surfaceNormalZ,
      expected.orientationX,
      expected.orientationY,
      expected.orientationZ,
      expected.orientationW,
      expected.angularVelocityX,
      expected.angularVelocityY,
      expected.angularVelocityZ,
      expected.unitMotionFlags,
    );
    sim.entityState.setHpBuild(
      slot,
      expected.hp,
      expected.maxHp,
      expected.buildProgress,
      expected.buildFlags,
    );
    sim.entityState.setStaticShape(
      slot,
      expected.radiusCollision,
      expected.radiusHitbox,
      expected.radiusOther,
      expected.aabbHx,
      expected.aabbHy,
      expected.aabbHz,
    );
    sim.entityState.setBodySlot(slot, expected.bodySlot);
    sim.entityState.setBlueprints(
      slot,
      expected.unitBlueprintCode,
      expected.buildingBlueprintCode,
      expected.shotBlueprintCode,
      expected.projectileTypeCode,
    );
    if (dirtyMask !== 0) sim.entityState.markDirty(slot, dirtyMask);
    this.refreshViewsIfStale();
    return slot;
  }

  markDirty(entity: Entity, fields: number, teamId?: number): void {
    if (fields === 0) return;
    if ((fields & ~HOT_MOTION_DIRTY_FIELDS) === 0) {
      this.refreshHotMotionState(entity, fields, teamId);
      return;
    }
    this.refreshEntityState(entity, fields, teamId);
  }

  drainDirtySnapshotEntities(outIds: EntityId[], outFields: number[]): boolean {
    const sim = this.sim();
    if (sim === undefined) return false;
    const views = this.ensureViews();
    if (views === null) return false;

    let count = sim.entityState.collectDirtySlots(
      this.dirtyDrainSlots,
      this.dirtyDrainMasks,
      true,
    );
    if (count < 0) {
      this.ensureDirtyDrainCapacity(-count);
      count = sim.entityState.collectDirtySlots(
        this.dirtyDrainSlots,
        this.dirtyDrainMasks,
        true,
      );
    }
    if (count < 0) return false;

    outIds.length = 0;
    outFields.length = 0;
    for (let i = 0; i < count; i++) {
      const slot = this.dirtyDrainSlots[i];
      if (slot >= views.capacity) continue;
      const id = views.entityId[slot];
      if (id < 0) continue;
      outIds.push(id);
      outFields.push(this.dirtyDrainMasks[i]);
    }
    return true;
  }

  private ensureDirtyDrainCapacity(required: number): void {
    if (required <= this.dirtyDrainSlots.length) return;
    let capacity = this.dirtyDrainSlots.length;
    while (capacity < required) capacity *= 2;
    this.dirtyDrainSlots = new Uint32Array(capacity);
    this.dirtyDrainMasks = new Uint32Array(capacity);
  }

  private refreshHotMotionState(entity: Entity, dirtyMask: number, teamId?: number): number {
    const sim = this.sim();
    if (sim === undefined) return -1;
    const slot = this.slotForEntity(entity);
    if (slot < 0) return slot;
    this.ensureStateCapacity(sim, slot);
    const views = this.ensureViews();
    if (
      views === null ||
      slot >= views.capacity ||
      views.entityId[slot] !== entity.id
    ) {
      return this.refreshEntityState(entity, dirtyMask, teamId);
    }

    if ((dirtyMask & (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT)) !== 0) {
      views.posX[slot] = entity.transform.x;
      views.posY[slot] = entity.transform.y;
      views.posZ[slot] = entity.transform.z;
      views.rotation[slot] = entity.transform.rotation;
    }

    if ((dirtyMask & ENTITY_CHANGED_VEL) !== 0) {
      const unit = entity.unit;
      const projectile = entity.projectile;
      views.velX[slot] = unit !== null
        ? unit.velocityX
        : projectile !== null ? projectile.velocityX : 0;
      views.velY[slot] = unit !== null
        ? unit.velocityY
        : projectile !== null ? projectile.velocityY : 0;
      views.velZ[slot] = unit !== null
        ? unit.velocityZ
        : projectile !== null ? projectile.velocityZ : 0;
    }

    if ((dirtyMask & (ENTITY_CHANGED_NORMAL | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL)) !== 0) {
      this.writeUnitMotionViews(views, slot, entity);
    }

    sim.entityState.markDirty(slot, dirtyMask);
    return slot;
  }

  setOwnership(entity: Entity, teamId?: number): void {
    const sim = this.sim();
    if (sim === undefined) return;
    const slot = this.refreshEntityState(entity, 0, teamId);
    if (slot < 0) return;
    const ownerPlayerId = entity.ownership !== null ? entity.ownership.playerId : 0;
    sim.entityState.setOwnership(slot, ownerPlayerId, this.resolveTeamId(slot, ownerPlayerId, teamId));
  }

  refreshViews(): EntityStateViews | null {
    const sim = this.sim();
    if (sim === undefined) {
      this.views = null;
      this.viewsBuffer = null;
      return null;
    }
    const capacity = sim.entityState.capacity();
    const buffer = sim.memory.buffer;
    this.views = {
      capacity,
      entityId: new Int32Array(buffer, sim.entityState.entityIdPtr(), capacity),
      kind: new Uint8Array(buffer, sim.entityState.kindPtr(), capacity),
      flags: new Uint32Array(buffer, sim.entityState.flagsPtr(), capacity),
      ownerPlayerId: new Uint32Array(buffer, sim.entityState.ownerPlayerIdPtr(), capacity),
      teamId: new Uint32Array(buffer, sim.entityState.teamIdPtr(), capacity),
      posX: new Float64Array(buffer, sim.entityState.posXPtr(), capacity),
      posY: new Float64Array(buffer, sim.entityState.posYPtr(), capacity),
      posZ: new Float64Array(buffer, sim.entityState.posZPtr(), capacity),
      rotation: new Float64Array(buffer, sim.entityState.rotationPtr(), capacity),
      velX: new Float64Array(buffer, sim.entityState.velXPtr(), capacity),
      velY: new Float64Array(buffer, sim.entityState.velYPtr(), capacity),
      velZ: new Float64Array(buffer, sim.entityState.velZPtr(), capacity),
      surfaceNormalX: new Float64Array(buffer, sim.entityState.surfaceNormalXPtr(), capacity),
      surfaceNormalY: new Float64Array(buffer, sim.entityState.surfaceNormalYPtr(), capacity),
      surfaceNormalZ: new Float64Array(buffer, sim.entityState.surfaceNormalZPtr(), capacity),
      orientationX: new Float64Array(buffer, sim.entityState.orientationXPtr(), capacity),
      orientationY: new Float64Array(buffer, sim.entityState.orientationYPtr(), capacity),
      orientationZ: new Float64Array(buffer, sim.entityState.orientationZPtr(), capacity),
      orientationW: new Float64Array(buffer, sim.entityState.orientationWPtr(), capacity),
      angularVelocityX: new Float64Array(buffer, sim.entityState.angularVelocityXPtr(), capacity),
      angularVelocityY: new Float64Array(buffer, sim.entityState.angularVelocityYPtr(), capacity),
      angularVelocityZ: new Float64Array(buffer, sim.entityState.angularVelocityZPtr(), capacity),
      unitMotionFlags: new Uint32Array(buffer, sim.entityState.unitMotionFlagsPtr(), capacity),
      hp: new Float64Array(buffer, sim.entityState.hpPtr(), capacity),
      maxHp: new Float64Array(buffer, sim.entityState.maxHpPtr(), capacity),
      radiusCollision: new Float64Array(buffer, sim.entityState.radiusCollisionPtr(), capacity),
      radiusHitbox: new Float64Array(buffer, sim.entityState.radiusHitboxPtr(), capacity),
      radiusOther: new Float64Array(buffer, sim.entityState.radiusOtherPtr(), capacity),
      aabbHx: new Float64Array(buffer, sim.entityState.aabbHxPtr(), capacity),
      aabbHy: new Float64Array(buffer, sim.entityState.aabbHyPtr(), capacity),
      aabbHz: new Float64Array(buffer, sim.entityState.aabbHzPtr(), capacity),
      bodySlot: new Int32Array(buffer, sim.entityState.bodySlotPtr(), capacity),
      unitBlueprintCode: new Uint32Array(buffer, sim.entityState.unitBlueprintCodePtr(), capacity),
      buildingBlueprintCode: new Uint32Array(buffer, sim.entityState.buildingBlueprintCodePtr(), capacity),
      shotBlueprintCode: new Uint32Array(buffer, sim.entityState.shotBlueprintCodePtr(), capacity),
      projectileTypeCode: new Uint32Array(buffer, sim.entityState.projectileTypeCodePtr(), capacity),
      buildProgress: new Float64Array(buffer, sim.entityState.buildProgressPtr(), capacity),
      buildFlags: new Uint32Array(buffer, sim.entityState.buildFlagsPtr(), capacity),
      dirtyMask: new Uint32Array(buffer, sim.entityState.dirtyMaskPtr(), capacity),
    };
    this.viewsBuffer = buffer;
    return this.views;
  }

  getViews(): EntityStateViews | null {
    return this.ensureViews();
  }

  assertParity(entity: Entity, teamId?: number): void {
    const slot = this.getEntitySlot(entity);
    if (slot < 0) {
      throw new Error(`EntitySlotRegistry.assertParity: entity ${entity.id} has no slot`);
    }
    const views = this.ensureViews();
    if (views === null || slot >= views.capacity) {
      throw new Error(`EntitySlotRegistry.assertParity: slot ${slot} is outside entity state capacity`);
    }
    const expected = this.expectedState(entity, slot, teamId);
    this.assertEqual(views.entityId[slot], entity.id, entity.id, 'entityId');
    this.assertEqual(views.kind[slot], expected.kind, entity.id, 'kind');
    this.assertEqual(views.flags[slot], expected.flags, entity.id, 'flags');
    this.assertEqual(views.ownerPlayerId[slot], expected.ownerPlayerId, entity.id, 'ownerPlayerId');
    this.assertEqual(views.teamId[slot], expected.teamId, entity.id, 'teamId');
    this.assertNear(views.posX[slot], expected.x, entity.id, 'posX');
    this.assertNear(views.posY[slot], expected.y, entity.id, 'posY');
    this.assertNear(views.posZ[slot], expected.z, entity.id, 'posZ');
    this.assertNear(views.rotation[slot], expected.rotation, entity.id, 'rotation');
    this.assertNear(views.velX[slot], expected.vx, entity.id, 'velX');
    this.assertNear(views.velY[slot], expected.vy, entity.id, 'velY');
    this.assertNear(views.velZ[slot], expected.vz, entity.id, 'velZ');
    this.assertNear(views.surfaceNormalX[slot], expected.surfaceNormalX, entity.id, 'surfaceNormalX');
    this.assertNear(views.surfaceNormalY[slot], expected.surfaceNormalY, entity.id, 'surfaceNormalY');
    this.assertNear(views.surfaceNormalZ[slot], expected.surfaceNormalZ, entity.id, 'surfaceNormalZ');
    this.assertNear(views.orientationX[slot], expected.orientationX, entity.id, 'orientationX');
    this.assertNear(views.orientationY[slot], expected.orientationY, entity.id, 'orientationY');
    this.assertNear(views.orientationZ[slot], expected.orientationZ, entity.id, 'orientationZ');
    this.assertNear(views.orientationW[slot], expected.orientationW, entity.id, 'orientationW');
    this.assertNear(views.angularVelocityX[slot], expected.angularVelocityX, entity.id, 'angularVelocityX');
    this.assertNear(views.angularVelocityY[slot], expected.angularVelocityY, entity.id, 'angularVelocityY');
    this.assertNear(views.angularVelocityZ[slot], expected.angularVelocityZ, entity.id, 'angularVelocityZ');
    this.assertEqual(views.unitMotionFlags[slot], expected.unitMotionFlags, entity.id, 'unitMotionFlags');
    this.assertNear(views.hp[slot], expected.hp, entity.id, 'hp');
    this.assertNear(views.maxHp[slot], expected.maxHp, entity.id, 'maxHp');
    this.assertNear(views.radiusCollision[slot], expected.radiusCollision, entity.id, 'radiusCollision');
    this.assertNear(views.radiusHitbox[slot], expected.radiusHitbox, entity.id, 'radiusHitbox');
    this.assertNear(views.radiusOther[slot], expected.radiusOther, entity.id, 'radiusOther');
    this.assertNear(views.aabbHx[slot], expected.aabbHx, entity.id, 'aabbHx');
    this.assertNear(views.aabbHy[slot], expected.aabbHy, entity.id, 'aabbHy');
    this.assertNear(views.aabbHz[slot], expected.aabbHz, entity.id, 'aabbHz');
    this.assertEqual(views.bodySlot[slot], expected.bodySlot, entity.id, 'bodySlot');
    this.assertEqual(views.unitBlueprintCode[slot], expected.unitBlueprintCode, entity.id, 'unitBlueprintCode');
    this.assertEqual(views.buildingBlueprintCode[slot], expected.buildingBlueprintCode, entity.id, 'buildingBlueprintCode');
    this.assertEqual(views.shotBlueprintCode[slot], expected.shotBlueprintCode, entity.id, 'shotBlueprintCode');
    this.assertEqual(views.projectileTypeCode[slot], expected.projectileTypeCode, entity.id, 'projectileTypeCode');
    this.assertNear(views.buildProgress[slot], expected.buildProgress, entity.id, 'buildProgress');
    this.assertEqual(views.buildFlags[slot], expected.buildFlags, entity.id, 'buildFlags');
  }

  private ensureViews(): EntityStateViews | null {
    const sim = this.sim();
    if (sim === undefined) return null;
    const views = this.views;
    if (
      views === null ||
      this.viewsBuffer !== sim.memory.buffer ||
      views.entityId.byteLength === 0 ||
      views.capacity !== sim.entityState.capacity()
    ) {
      return this.refreshViews();
    }
    return views;
  }

  private refreshViewsIfStale(): void {
    const sim = this.sim();
    if (sim === undefined) return;
    const views = this.views;
    if (
      views === null ||
      this.viewsBuffer !== sim.memory.buffer ||
      views.entityId.byteLength === 0 ||
      views.capacity !== sim.entityState.capacity()
    ) {
      this.refreshViews();
    }
  }

  private hasCurrentEntityStateRow(sim: SimWasm, slot: number, entityId: EntityId): boolean {
    const views = this.views;
    if (
      views !== null &&
      this.viewsBuffer === sim.memory.buffer &&
      views.entityId.byteLength !== 0 &&
      slot < views.capacity
    ) {
      return views.entityId[slot] === entityId;
    }

    const refreshedViews = this.ensureViews();
    return (
      refreshedViews !== null &&
      slot < refreshedViews.capacity &&
      refreshedViews.entityId[slot] === entityId
    );
  }

  private writeUnitMotionViews(views: EntityStateViews, slot: number, entity: Entity): void {
    const unit = entity.unit;
    if (unit === null) {
      views.surfaceNormalX[slot] = 0;
      views.surfaceNormalY[slot] = 0;
      views.surfaceNormalZ[slot] = 1;
      views.orientationX[slot] = 0;
      views.orientationY[slot] = 0;
      views.orientationZ[slot] = 0;
      views.orientationW[slot] = 1;
      views.angularVelocityX[slot] = 0;
      views.angularVelocityY[slot] = 0;
      views.angularVelocityZ[slot] = 0;
      views.unitMotionFlags[slot] = 0;
      return;
    }

    views.surfaceNormalX[slot] = unit.surfaceNormal.nx;
    views.surfaceNormalY[slot] = unit.surfaceNormal.ny;
    views.surfaceNormalZ[slot] = unit.surfaceNormal.nz;
    let flags = ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL;
    const orientation = unit.orientation;
    const angularVelocity = unit.angularVelocity3;
    if (orientation !== null) {
      flags |= ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION;
      views.orientationX[slot] = orientation.x;
      views.orientationY[slot] = orientation.y;
      views.orientationZ[slot] = orientation.z;
      views.orientationW[slot] = orientation.w;
      if (angularVelocity !== null && angularVelocity !== undefined) {
        flags |= ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY;
        views.angularVelocityX[slot] = angularVelocity.x;
        views.angularVelocityY[slot] = angularVelocity.y;
        views.angularVelocityZ[slot] = angularVelocity.z;
      } else {
        views.angularVelocityX[slot] = 0;
        views.angularVelocityY[slot] = 0;
        views.angularVelocityZ[slot] = 0;
      }
    } else {
      views.orientationX[slot] = 0;
      views.orientationY[slot] = 0;
      views.orientationZ[slot] = 0;
      views.orientationW[slot] = 1;
      views.angularVelocityX[slot] = 0;
      views.angularVelocityY[slot] = 0;
      views.angularVelocityZ[slot] = 0;
    }
    views.unitMotionFlags[slot] = flags;
  }

  private expectedState(entity: Entity, slot: number, teamId?: number): EntityStateExpectation {
    const ownerPlayerId = entity.ownership !== null ? entity.ownership.playerId : 0;
    const resolvedTeamId = this.resolveTeamId(slot, ownerPlayerId, teamId);
    const unit = entity.unit;
    const building = entity.building;
    const projectile = entity.projectile;
    const buildable = entity.buildable;
    let flags = 0;
    let hp = 0;
    let maxHp = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let surfaceNormalX = 0;
    let surfaceNormalY = 0;
    let surfaceNormalZ = 1;
    let orientationX = 0;
    let orientationY = 0;
    let orientationZ = 0;
    let orientationW = 1;
    let angularVelocityX = 0;
    let angularVelocityY = 0;
    let angularVelocityZ = 0;
    let unitMotionFlags = 0;
    let radiusCollision = 0;
    let radiusHitbox = 0;
    let radiusOther = 0;
    let aabbHx = 0;
    let aabbHy = 0;
    let aabbHz = 0;
    let unitBlueprintCode = ENTITY_STATE_BLUEPRINT_NONE;
    let buildingBlueprintCode = ENTITY_STATE_BLUEPRINT_NONE;
    let shotBlueprintCode = ENTITY_STATE_BLUEPRINT_NONE;
    let projectileTypeCode = ENTITY_STATE_BLUEPRINT_NONE;

    if (unit !== null) {
      flags |= ENTITY_SLOT_FLAG_HAS_UNIT;
      if (unit.hp > 0) flags |= ENTITY_SLOT_FLAG_ALIVE;
      hp = unit.hp;
      maxHp = unit.maxHp;
      vx = unit.velocityX;
      vy = unit.velocityY;
      vz = unit.velocityZ;
      surfaceNormalX = unit.surfaceNormal.nx;
      surfaceNormalY = unit.surfaceNormal.ny;
      surfaceNormalZ = unit.surfaceNormal.nz;
      unitMotionFlags = ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL;
      const orientation = unit.orientation;
      const angularVelocity = unit.angularVelocity3;
      if (orientation !== null) {
        orientationX = orientation.x;
        orientationY = orientation.y;
        orientationZ = orientation.z;
        orientationW = orientation.w;
        unitMotionFlags |= ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION;
        if (angularVelocity !== null && angularVelocity !== undefined) {
          angularVelocityX = angularVelocity.x;
          angularVelocityY = angularVelocity.y;
          angularVelocityZ = angularVelocity.z;
          unitMotionFlags |= ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY;
        }
      }
      radiusCollision = unit.radius.collision;
      radiusHitbox = unit.radius.hitbox;
      radiusOther = unit.radius.other;
      aabbHx = unit.radius.hitbox;
      aabbHy = unit.radius.hitbox;
      aabbHz = unit.bodyCenterHeight;
      unitBlueprintCode = unitBlueprintIdToCode(unit.unitBlueprintId);
    } else if (building !== null) {
      flags |= ENTITY_SLOT_FLAG_HAS_BUILDING;
      if (building.hp > 0) flags |= ENTITY_SLOT_FLAG_ALIVE;
      hp = building.hp;
      maxHp = building.maxHp;
      radiusCollision = building.targetRadius;
      radiusHitbox = building.targetRadius;
      radiusOther = Math.max(building.width, building.height) * 0.5;
      aabbHx = building.width / 2;
      aabbHy = building.height / 2;
      aabbHz = building.depth / 2;
      buildingBlueprintCode = entity.buildingBlueprintId !== null
        ? buildingBlueprintIdToCode(entity.buildingBlueprintId)
        : BUILDING_BLUEPRINT_CODE_UNKNOWN;
    } else if (projectile !== null) {
      flags |= ENTITY_SLOT_FLAG_HAS_PROJECTILE | ENTITY_SLOT_FLAG_ACTIVE;
      if (projectile.projectileType !== 'projectile' || projectile.hp > 0 || projectile.maxHp <= 0) {
        flags |= ENTITY_SLOT_FLAG_ALIVE;
      }
      hp = projectile.hp;
      maxHp = projectile.maxHp;
      vx = projectile.velocityX;
      vy = projectile.velocityY;
      vz = projectile.velocityZ;
      radiusCollision = projectile.config.shotProfile.runtime.radius.collision;
      radiusHitbox = projectile.config.shotProfile.runtime.radius.hitbox;
      radiusOther = radiusHitbox;
      shotBlueprintCode = shotBlueprintIdToCode(projectile.shotBlueprintId);
      projectileTypeCode = projectileTypeToCode(projectile.projectileType);
    }

    if (entity.body !== null) flags |= ENTITY_SLOT_FLAG_HAS_BODY;
    if (entity.combat !== null) flags |= ENTITY_SLOT_FLAG_HAS_COMBAT;
    if ((unit !== null || building !== null) && isEntityActive(entity)) {
      flags |= ENTITY_SLOT_FLAG_ACTIVE;
    }

    return {
      kind: this.entityKindCode(entity),
      flags,
      ownerPlayerId,
      teamId: resolvedTeamId,
      x: entity.transform.x,
      y: entity.transform.y,
      z: entity.transform.z,
      rotation: entity.transform.rotation,
      vx,
      vy,
      vz,
      surfaceNormalX,
      surfaceNormalY,
      surfaceNormalZ,
      orientationX,
      orientationY,
      orientationZ,
      orientationW,
      angularVelocityX,
      angularVelocityY,
      angularVelocityZ,
      unitMotionFlags,
      hp,
      maxHp,
      radiusCollision,
      radiusHitbox,
      radiusOther,
      aabbHx,
      aabbHy,
      aabbHz,
      bodySlot: entity.body !== null ? entity.body.physicsBody.slot : ENTITY_STATE_NO_BODY_SLOT,
      unitBlueprintCode: unit !== null ? unitBlueprintCode : UNIT_BLUEPRINT_CODE_UNKNOWN,
      buildingBlueprintCode: building !== null ? buildingBlueprintCode : BUILDING_BLUEPRINT_CODE_UNKNOWN,
      shotBlueprintCode: projectile !== null ? shotBlueprintCode : SHOT_BLUEPRINT_CODE_UNKNOWN,
      projectileTypeCode: projectile !== null ? projectileTypeCode : PROJECTILE_TYPE_UNKNOWN,
      buildProgress: buildable !== null ? getBuildFraction(buildable) : 1,
      buildFlags: this.buildFlags(entity),
    };
  }

  private resolveTeamId(slot: number, ownerPlayerId: number, teamId: number | undefined): number {
    if (ownerPlayerId === 0) return 0;
    if (teamId !== undefined) return teamId;
    const views = this.ensureViews();
    if (
      views !== null &&
      slot >= 0 &&
      slot < views.capacity &&
      views.ownerPlayerId[slot] === ownerPlayerId &&
      views.teamId[slot] !== 0
    ) {
      return views.teamId[slot];
    }
    return ownerPlayerId;
  }

  private entityKindCode(entity: Entity): number {
    switch (entity.type) {
      case 'unit':
        return ENTITY_STATE_KIND_UNIT;
      case 'building':
        return ENTITY_STATE_KIND_BUILDING;
      case 'tower':
        return ENTITY_STATE_KIND_TOWER;
      case 'shot':
        return ENTITY_STATE_KIND_SHOT;
    }
  }

  private buildFlags(entity: Entity): number {
    const buildable = entity.buildable;
    if (buildable === null) return ENTITY_SLOT_BUILD_FLAG_COMPLETE;
    let flags = ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE;
    if (buildable.isComplete) flags |= ENTITY_SLOT_BUILD_FLAG_COMPLETE;
    if (buildable.isGhost) flags |= ENTITY_SLOT_BUILD_FLAG_GHOST;
    if (buildable.isInterrupted) flags |= ENTITY_SLOT_BUILD_FLAG_INTERRUPTED;
    return flags;
  }

  private assertEqual(actual: number, expected: number, entityId: EntityId, field: string): void {
    if (actual === expected) return;
    throw new Error(
      `EntitySlotRegistry parity failed for entity ${entityId} field ${field}: expected ${expected}, got ${actual}`,
    );
  }

  private assertNear(actual: number, expected: number, entityId: EntityId, field: string): void {
    if (Object.is(actual, expected)) return;
    if (Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= EPSILON) {
      return;
    }
    throw new Error(
      `EntitySlotRegistry parity failed for entity ${entityId} field ${field}: expected ${expected}, got ${actual}`,
    );
  }
}

export const entitySlotRegistry = new EntitySlotRegistry();
