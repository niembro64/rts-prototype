import type { Entity, EntityId, Turret } from '../sim/types';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import {
  getConstructionPieceOpacity,
  getConstructionPieceRenderFraction,
  getResourceFillRatio,
  isBuildInProgress,
  isConstructionPieceMaterialized,
  isShell,
} from '../sim/buildableHelpers';
import { getUnitGroundZ } from '../sim/unitGeometry';
import {
  getBuildingHudBarsY,
  getBuildingHudNameY,
  getUnitHudBarsY,
  getUnitHudNameY,
} from './HudAnchor';

const INITIAL_RENDER_ENTITY_STATE_CAP = 4096;
const NO_OWNER_ID = 0;
const NO_PASSIVE_TURRET_INDEX = -1;

export const CLIENT_RENDER_ENTITY_FLAG_SELECTED = 1;
export const CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS = 1 << 1;
export const CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED = 1 << 2;
export const CLIENT_RENDER_ENTITY_FLAG_SHELL = 1 << 3;
export const CLIENT_RENDER_UNIT_FLAG_AIRBORNE = 1 << 7;
export const CLIENT_RENDER_UNIT_FLAG_HAS_SUSPENSION = 1 << 8;
const CLIENT_RENDER_ENTITY_CONSTRUCTION_FLAG_MASK =
  CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS |
  CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED |
  CLIENT_RENDER_ENTITY_FLAG_SHELL;

export const CLIENT_RENDER_ENTITY_KIND_NONE = 0;
export const CLIENT_RENDER_ENTITY_KIND_UNIT = 1;
export const CLIENT_RENDER_ENTITY_KIND_BUILDING = 2;

export type ClientRenderEntityStateViews = {
  readonly kind: Uint8Array;
  readonly entityIds: Float64Array;
  readonly ownerIds: Float64Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly rotation: Float32Array;
  readonly groundY: Float32Array;
  readonly radiusOther: Float32Array;
  readonly radiusHitbox: Float32Array;
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  readonly velocityX: Float32Array;
  readonly velocityY: Float32Array;
  readonly yawRate: Float32Array;
  readonly bodyOpacity: Float32Array;
  readonly bodyCenterHeight: Float32Array;
  readonly buildingBaseY: Float32Array;
  readonly buildingWidth: Float32Array;
  readonly buildingFootprintDepth: Float32Array;
  readonly buildingProgress: Float32Array;
  readonly bodyHudWidth: Float32Array;
  readonly hudBarsY: Float32Array;
  readonly hudNameY: Float32Array;
  readonly contactShadowWidth: Float32Array;
  readonly contactShadowDepth: Float32Array;
  readonly renderScopePadding: Float32Array;
  readonly hp: Float32Array;
  readonly maxHp: Float32Array;
  readonly buildEnergyRatio: Float32Array;
  readonly buildMetalRatio: Float32Array;
  readonly groundContactEnabled: Uint8Array;
  readonly turretCount: Uint16Array;
  readonly passiveTurretIndex: Int16Array;
  readonly flags: Uint16Array;
  readonly unitBlueprintIds: (string | undefined)[];
  readonly buildingBlueprintIds: (string | null | undefined)[];
};

function growFloat32(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(source: Uint8Array, nextCapacity: number): Uint8Array {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, nextCapacity: number): Uint16Array {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

function growInt16(source: Int16Array, nextCapacity: number): Int16Array {
  const next = new Int16Array(nextCapacity);
  next.set(source);
  return next;
}

const passiveTurretIndexCache = new WeakMap<readonly Turret[], number>();

function passiveTurretIndex(turrets: readonly Turret[]): number {
  if (turrets.length === 0) return NO_PASSIVE_TURRET_INDEX;
  const cached = passiveTurretIndexCache.get(turrets);
  if (cached !== undefined) return cached;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].config.passive) {
      passiveTurretIndexCache.set(turrets, i);
      return i;
    }
  }
  passiveTurretIndexCache.set(turrets, NO_PASSIVE_TURRET_INDEX);
  return NO_PASSIVE_TURRET_INDEX;
}

function assertNear(label: string, actual: number, expected: number, tolerance = 1e-3): void {
  if (Math.abs(actual - expected) <= tolerance) return;
  throw new Error(
    `[client render entity state] ${label} mismatch: slab=${actual}, entity=${expected}`,
  );
}

function refreshConstructionFlags(entity: Entity, flags: number): number {
  let nextFlags = flags & ~CLIENT_RENDER_ENTITY_CONSTRUCTION_FLAG_MASK;
  if (isBuildInProgress(entity.buildable)) {
    nextFlags |= CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS;
  }
  if (isConstructionPieceMaterialized(entity, 'body')) {
    nextFlags |= CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED;
  }
  if (isShell(entity)) nextFlags |= CLIENT_RENDER_ENTITY_FLAG_SHELL;
  return nextFlags;
}

function assertFlag(
  label: string,
  actualFlags: number,
  flag: number,
  expected: boolean,
): void {
  const actual = (actualFlags & flag) !== 0;
  if (actual === expected) return;
  throw new Error(
    `[client render entity state] ${label} mismatch: slab=${actual}, entity=${expected}`,
  );
}

export class ClientRenderEntityStateSlab {
  private readonly slotByEntityId = new Map<EntityId, number>();
  private readonly freeSlots: number[] = [];
  private readonly dirtySlots: number[] = [];
  private dirtySlotMarks: Uint8Array = new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP);
  private nextSlot = 0;
  private views: ClientRenderEntityStateViews = {
    kind: new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    entityIds: new Float64Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    ownerIds: new Float64Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    x: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    y: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    z: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    rotation: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    groundY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    radiusOther: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    radiusHitbox: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalX: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalZ: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    velocityX: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    velocityY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    yawRate: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    bodyOpacity: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    bodyCenterHeight: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingBaseY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingFootprintDepth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingProgress: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    bodyHudWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hudBarsY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hudNameY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    contactShadowWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    contactShadowDepth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    renderScopePadding: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hp: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    maxHp: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildEnergyRatio: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildMetalRatio: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    groundContactEnabled: new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    turretCount: new Uint16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    passiveTurretIndex: new Int16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    flags: new Uint16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    unitBlueprintIds: [],
    buildingBlueprintIds: [],
  };

  getViews(): ClientRenderEntityStateViews {
    return this.views;
  }

  getSlot(id: EntityId): number | undefined {
    return this.slotByEntityId.get(id);
  }

  slotForEntity(entity: Entity): number {
    const existing = this.slotByEntityId.get(entity.id);
    if (existing !== undefined) return existing;
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    this.ensureCapacity(slot + 1);
    this.slotByEntityId.set(entity.id, slot);
    this.views.entityIds[slot] = entity.id;
    this.markSlotDirty(slot);
    return slot;
  }

  refreshEntity(entity: Entity): number | undefined {
    if (entity.unit !== null) return this.refreshUnit(entity);
    if (entity.building !== null) return this.refreshBuilding(entity);
    this.unsetEntity(entity.id);
    return undefined;
  }

  refreshHealth(entity: Entity): number | undefined {
    const slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) return this.refreshEntity(entity);
    const views = this.views;
    const unit = entity.unit;
    if (unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return this.refreshEntity(entity);
      views.hp[slot] = unit.hp;
      views.maxHp[slot] = unit.maxHp;
      this.markSlotDirty(slot);
      return slot;
    }
    const building = entity.building;
    if (building !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) return this.refreshEntity(entity);
      views.hp[slot] = building.hp;
      views.maxHp[slot] = building.maxHp;
      this.markSlotDirty(slot);
      return slot;
    }
    this.unsetEntity(entity.id);
    return undefined;
  }

  refreshTurretMetadata(entity: Entity): number | undefined {
    const slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) return this.refreshEntity(entity);
    const views = this.views;
    const turrets = entity.combat?.turrets;
    if (entity.unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return this.refreshEntity(entity);
      views.turretCount[slot] = turrets?.length ?? 0;
      views.passiveTurretIndex[slot] = turrets !== undefined
        ? passiveTurretIndex(turrets)
        : NO_PASSIVE_TURRET_INDEX;
      this.markSlotDirty(slot);
      return slot;
    }
    if (entity.building !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) return this.refreshEntity(entity);
      views.turretCount[slot] = turrets?.length ?? 0;
      views.passiveTurretIndex[slot] = NO_PASSIVE_TURRET_INDEX;
      this.markSlotDirty(slot);
      return slot;
    }
    this.unsetEntity(entity.id);
    return undefined;
  }

  refreshBuildState(entity: Entity): number | undefined {
    const slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) return this.refreshEntity(entity);
    const views = this.views;
    const buildable = isBuildInProgress(entity.buildable) ? entity.buildable : null;
    if (entity.unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return this.refreshEntity(entity);
      views.flags[slot] = refreshConstructionFlags(entity, views.flags[slot]);
      views.bodyOpacity[slot] = getConstructionPieceOpacity(entity, 'body');
      views.buildEnergyRatio[slot] = buildable !== null
        ? getResourceFillRatio(buildable, 'energy')
        : 0;
      views.buildMetalRatio[slot] = buildable !== null
        ? getResourceFillRatio(buildable, 'metal')
        : 0;
      this.markSlotDirty(slot);
      return slot;
    }
    if (entity.building !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) return this.refreshEntity(entity);
      views.flags[slot] = refreshConstructionFlags(entity, views.flags[slot]);
      views.buildingProgress[slot] = getConstructionPieceRenderFraction(entity, 'body');
      views.bodyOpacity[slot] = getConstructionPieceOpacity(entity, 'body');
      views.buildEnergyRatio[slot] = buildable !== null
        ? getResourceFillRatio(buildable, 'energy')
        : 0;
      views.buildMetalRatio[slot] = buildable !== null
        ? getResourceFillRatio(buildable, 'metal')
        : 0;
      this.markSlotDirty(slot);
      return slot;
    }
    this.unsetEntity(entity.id);
    return undefined;
  }

  refreshUnit(entity: Entity): number | undefined {
    const unit = entity.unit;
    if (unit === null) return undefined;
    const slot = this.slotForEntity(entity);
    const views = this.views;
    const turrets = entity.combat?.turrets;
    const buildable = isBuildInProgress(entity.buildable) ? entity.buildable : null;
    let flags = entity.selectable?.selected === true
      ? CLIENT_RENDER_ENTITY_FLAG_SELECTED
      : 0;
    if (buildable !== null) flags |= CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS;
    if (isConstructionPieceMaterialized(entity, 'body')) {
      flags |= CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED;
    }
    if (isShell(entity)) flags |= CLIENT_RENDER_ENTITY_FLAG_SHELL;
    const locomotionType = unit.locomotion.type;
    if (locomotionType === 'hover' || locomotionType === 'flying') {
      flags |= CLIENT_RENDER_UNIT_FLAG_AIRBORNE;
    }
    if (unit.suspension !== null) flags |= CLIENT_RENDER_UNIT_FLAG_HAS_SUSPENSION;

    views.kind[slot] = CLIENT_RENDER_ENTITY_KIND_UNIT;
    views.ownerIds[slot] = entity.ownership?.playerId ?? NO_OWNER_ID;
    views.x[slot] = entity.transform.x;
    views.y[slot] = entity.transform.y;
    views.z[slot] = entity.transform.z;
    views.rotation[slot] = entity.transform.rotation;
    views.groundY[slot] = getUnitGroundZ(entity);
    views.radiusOther[slot] = unit.radius.other || unit.radius.hitbox || 15;
    views.radiusHitbox[slot] = unit.radius.hitbox;
    views.normalX[slot] = unit.surfaceNormal.nx;
    views.normalY[slot] = unit.surfaceNormal.ny;
    views.normalZ[slot] = unit.surfaceNormal.nz;
    views.velocityX[slot] = unit.velocityX;
    views.velocityY[slot] = unit.velocityY;
    views.yawRate[slot] = unit.angularVelocity3?.z ?? 0;
    views.bodyOpacity[slot] = getConstructionPieceOpacity(entity, 'body');
    views.bodyCenterHeight[slot] = unit.bodyCenterHeight;
    views.bodyHudWidth[slot] = unit.radius.other * 2;
    views.hudBarsY[slot] = getUnitHudBarsY(entity);
    views.hudNameY[slot] = getUnitHudNameY(entity);
    views.contactShadowWidth[slot] = 0;
    views.contactShadowDepth[slot] = 0;
    views.renderScopePadding[slot] = Math.max(350, views.radiusOther[slot]);
    views.hp[slot] = unit.hp;
    views.maxHp[slot] = unit.maxHp;
    views.buildEnergyRatio[slot] = buildable !== null
      ? getResourceFillRatio(buildable, 'energy')
      : 0;
    views.buildMetalRatio[slot] = buildable !== null
      ? getResourceFillRatio(buildable, 'metal')
      : 0;
    views.groundContactEnabled[slot] = unit.suspension?.legContact === false ? 0 : 1;
    views.turretCount[slot] = turrets?.length ?? 0;
    views.passiveTurretIndex[slot] = turrets !== undefined
      ? passiveTurretIndex(turrets)
      : NO_PASSIVE_TURRET_INDEX;
    views.flags[slot] = flags;
    views.unitBlueprintIds[slot] = unit.unitBlueprintId;
    views.buildingBlueprintIds[slot] = undefined;
    this.markSlotDirty(slot);
    return slot;
  }

  refreshBuilding(entity: Entity): number | undefined {
    const building = entity.building;
    if (building === null) return undefined;
    const slot = this.slotForEntity(entity);
    const views = this.views;
    const turrets = entity.combat?.turrets;
    const buildable = isBuildInProgress(entity.buildable) ? entity.buildable : null;
    const visualConfig = entity.buildingBlueprintId !== null
      ? getBuildingConfig(entity.buildingBlueprintId)
      : null;
    let flags = entity.selectable?.selected === true
      ? CLIENT_RENDER_ENTITY_FLAG_SELECTED
      : 0;
    if (buildable !== null) flags |= CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS;
    if (isConstructionPieceMaterialized(entity, 'body')) {
      flags |= CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED;
    }
    if (isShell(entity)) flags |= CLIENT_RENDER_ENTITY_FLAG_SHELL;

    views.kind[slot] = CLIENT_RENDER_ENTITY_KIND_BUILDING;
    views.ownerIds[slot] = entity.ownership?.playerId ?? NO_OWNER_ID;
    views.x[slot] = entity.transform.x;
    views.y[slot] = entity.transform.y;
    views.z[slot] = entity.transform.z;
    views.rotation[slot] = entity.transform.rotation;
    views.radiusHitbox[slot] = 0;
    views.buildingBaseY[slot] = entity.transform.z - building.depth / 2;
    views.buildingWidth[slot] = visualConfig !== null
      ? visualConfig.gridWidth * BUILD_GRID_CELL_SIZE
      : building.width;
    views.buildingFootprintDepth[slot] = visualConfig !== null
      ? visualConfig.gridHeight * BUILD_GRID_CELL_SIZE
      : building.height;
    views.buildingProgress[slot] = getConstructionPieceRenderFraction(entity, 'body');
    views.bodyOpacity[slot] = getConstructionPieceOpacity(entity, 'body');
    views.bodyHudWidth[slot] = building.width;
    views.hudBarsY[slot] = getBuildingHudBarsY(entity);
    views.hudNameY[slot] = getBuildingHudNameY(entity);
    views.contactShadowWidth[slot] = building.width;
    views.contactShadowDepth[slot] = building.height;
    views.renderScopePadding[slot] = Math.max(
      200,
      Math.max(building.width, building.height) * 0.75,
    );
    views.hp[slot] = building.hp;
    views.maxHp[slot] = building.maxHp;
    views.buildEnergyRatio[slot] = buildable !== null
      ? getResourceFillRatio(buildable, 'energy')
      : 0;
    views.buildMetalRatio[slot] = buildable !== null
      ? getResourceFillRatio(buildable, 'metal')
      : 0;
    views.groundContactEnabled[slot] = 0;
    views.turretCount[slot] = turrets?.length ?? 0;
    views.passiveTurretIndex[slot] = NO_PASSIVE_TURRET_INDEX;
    views.flags[slot] = flags;
    views.unitBlueprintIds[slot] = undefined;
    views.buildingBlueprintIds[slot] = entity.buildingBlueprintId;
    this.markSlotDirty(slot);
    return slot;
  }

  unsetEntity(id: EntityId): void {
    const slot = this.slotByEntityId.get(id);
    if (slot === undefined) return;
    this.slotByEntityId.delete(id);
    this.views.kind[slot] = CLIENT_RENDER_ENTITY_KIND_NONE;
    this.views.entityIds[slot] = 0;
    this.views.ownerIds[slot] = NO_OWNER_ID;
    this.views.flags[slot] = 0;
    this.views.turretCount[slot] = 0;
    this.views.passiveTurretIndex[slot] = NO_PASSIVE_TURRET_INDEX;
    this.views.radiusHitbox[slot] = 0;
    this.views.bodyHudWidth[slot] = 0;
    this.views.hudBarsY[slot] = 0;
    this.views.hudNameY[slot] = 0;
    this.views.contactShadowWidth[slot] = 0;
    this.views.contactShadowDepth[slot] = 0;
    this.views.renderScopePadding[slot] = 0;
    this.views.groundContactEnabled[slot] = 0;
    this.views.unitBlueprintIds[slot] = undefined;
    this.views.buildingBlueprintIds[slot] = undefined;
    this.freeSlots.push(slot);
    this.markSlotDirty(slot);
  }

  consumeDirtySlots(out: number[] = []): number[] {
    out.length = 0;
    for (let i = 0; i < this.dirtySlots.length; i++) {
      const slot = this.dirtySlots[i];
      out.push(slot);
      this.dirtySlotMarks[slot] = 0;
    }
    this.dirtySlots.length = 0;
    return out;
  }

  clear(): void {
    this.slotByEntityId.clear();
    this.freeSlots.length = 0;
    this.dirtySlots.length = 0;
    this.dirtySlotMarks.fill(0);
    this.nextSlot = 0;
    this.views.kind.fill(CLIENT_RENDER_ENTITY_KIND_NONE);
    this.views.entityIds.fill(0);
    this.views.ownerIds.fill(NO_OWNER_ID);
    this.views.flags.fill(0);
    this.views.turretCount.fill(0);
    this.views.passiveTurretIndex.fill(NO_PASSIVE_TURRET_INDEX);
    this.views.radiusHitbox.fill(0);
    this.views.bodyHudWidth.fill(0);
    this.views.hudBarsY.fill(0);
    this.views.hudNameY.fill(0);
    this.views.contactShadowWidth.fill(0);
    this.views.contactShadowDepth.fill(0);
    this.views.renderScopePadding.fill(0);
    this.views.groundContactEnabled.fill(0);
    this.views.unitBlueprintIds.length = 0;
    this.views.buildingBlueprintIds.length = 0;
  }

  assertParity(entity: Entity): void {
    const slot = this.slotByEntityId.get(entity.id);
    if (slot === undefined) {
      throw new Error(`[client render entity state] missing slot for entity ${entity.id}`);
    }
    const views = this.views;
    assertNear('entity id', views.entityIds[slot], entity.id, 0);
    assertNear('owner id', views.ownerIds[slot], entity.ownership?.playerId ?? NO_OWNER_ID, 0);
    assertNear('x', views.x[slot], entity.transform.x);
    assertNear('y', views.y[slot], entity.transform.y);
    assertNear('z', views.z[slot], entity.transform.z);
    assertNear('rotation', views.rotation[slot], entity.transform.rotation);
    const unit = entity.unit;
    if (unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) {
        throw new Error(`[client render entity state] entity ${entity.id} expected unit row`);
      }
      assertNear('groundY', views.groundY[slot], getUnitGroundZ(entity));
      assertNear('radiusOther', views.radiusOther[slot], unit.radius.other || unit.radius.hitbox || 15);
      assertNear('radiusHitbox', views.radiusHitbox[slot], unit.radius.hitbox);
      assertNear('velocityX', views.velocityX[slot], unit.velocityX);
      assertNear('velocityY', views.velocityY[slot], unit.velocityY);
      assertNear('bodyHudWidth', views.bodyHudWidth[slot], unit.radius.other * 2);
      assertNear('hudBarsY', views.hudBarsY[slot], getUnitHudBarsY(entity));
      assertNear('hudNameY', views.hudNameY[slot], getUnitHudNameY(entity));
      assertNear(
        'renderScopePadding',
        views.renderScopePadding[slot],
        Math.max(350, views.radiusOther[slot]),
      );
      assertNear(
        'groundContactEnabled',
        views.groundContactEnabled[slot],
        unit.suspension?.legContact === false ? 0 : 1,
        0,
      );
      assertNear('hp', views.hp[slot], unit.hp);
      assertNear('maxHp', views.maxHp[slot], unit.maxHp);
      const buildable = isBuildInProgress(entity.buildable) ? entity.buildable : null;
      assertNear('bodyOpacity', views.bodyOpacity[slot], getConstructionPieceOpacity(entity, 'body'));
      assertNear(
        'buildEnergyRatio',
        views.buildEnergyRatio[slot],
        buildable !== null ? getResourceFillRatio(buildable, 'energy') : 0,
      );
      assertNear(
        'buildMetalRatio',
        views.buildMetalRatio[slot],
        buildable !== null ? getResourceFillRatio(buildable, 'metal') : 0,
      );
      assertFlag(
        'buildInProgress flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS,
        buildable !== null,
      );
      assertFlag(
        'bodyMaterialized flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED,
        isConstructionPieceMaterialized(entity, 'body'),
      );
      assertFlag(
        'shell flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_SHELL,
        isShell(entity),
      );
      if (views.unitBlueprintIds[slot] !== unit.unitBlueprintId) {
        throw new Error(`[client render entity state] unit blueprint mismatch for ${entity.id}`);
      }
      return;
    }
    const building = entity.building;
    if (building !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) {
        throw new Error(`[client render entity state] entity ${entity.id} expected building row`);
      }
      assertNear('buildingBaseY', views.buildingBaseY[slot], entity.transform.z - building.depth / 2);
      assertNear('bodyHudWidth', views.bodyHudWidth[slot], building.width);
      assertNear('hudBarsY', views.hudBarsY[slot], getBuildingHudBarsY(entity));
      assertNear('hudNameY', views.hudNameY[slot], getBuildingHudNameY(entity));
      assertNear('contactShadowWidth', views.contactShadowWidth[slot], building.width);
      assertNear('contactShadowDepth', views.contactShadowDepth[slot], building.height);
      assertNear(
        'renderScopePadding',
        views.renderScopePadding[slot],
        Math.max(200, Math.max(building.width, building.height) * 0.75),
      );
      assertNear('hp', views.hp[slot], building.hp);
      assertNear('maxHp', views.maxHp[slot], building.maxHp);
      const buildable = isBuildInProgress(entity.buildable) ? entity.buildable : null;
      assertNear('buildingProgress', views.buildingProgress[slot], getConstructionPieceRenderFraction(entity, 'body'));
      assertNear('bodyOpacity', views.bodyOpacity[slot], getConstructionPieceOpacity(entity, 'body'));
      assertNear(
        'buildEnergyRatio',
        views.buildEnergyRatio[slot],
        buildable !== null ? getResourceFillRatio(buildable, 'energy') : 0,
      );
      assertNear(
        'buildMetalRatio',
        views.buildMetalRatio[slot],
        buildable !== null ? getResourceFillRatio(buildable, 'metal') : 0,
      );
      assertFlag(
        'buildInProgress flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS,
        buildable !== null,
      );
      assertFlag(
        'bodyMaterialized flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED,
        isConstructionPieceMaterialized(entity, 'body'),
      );
      assertFlag(
        'shell flag',
        views.flags[slot],
        CLIENT_RENDER_ENTITY_FLAG_SHELL,
        isShell(entity),
      );
    }
  }

  private ensureCapacity(required: number): void {
    if (required <= this.views.entityIds.length) return;
    let nextCapacity = this.views.entityIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    const views = this.views;
    this.views = {
      kind: growUint8(views.kind, nextCapacity),
      entityIds: growFloat64(views.entityIds, nextCapacity),
      ownerIds: growFloat64(views.ownerIds, nextCapacity),
      x: growFloat32(views.x, nextCapacity),
      y: growFloat32(views.y, nextCapacity),
      z: growFloat32(views.z, nextCapacity),
      rotation: growFloat32(views.rotation, nextCapacity),
      groundY: growFloat32(views.groundY, nextCapacity),
      radiusOther: growFloat32(views.radiusOther, nextCapacity),
      radiusHitbox: growFloat32(views.radiusHitbox, nextCapacity),
      normalX: growFloat32(views.normalX, nextCapacity),
      normalY: growFloat32(views.normalY, nextCapacity),
      normalZ: growFloat32(views.normalZ, nextCapacity),
      velocityX: growFloat32(views.velocityX, nextCapacity),
      velocityY: growFloat32(views.velocityY, nextCapacity),
      yawRate: growFloat32(views.yawRate, nextCapacity),
      bodyOpacity: growFloat32(views.bodyOpacity, nextCapacity),
      bodyCenterHeight: growFloat32(views.bodyCenterHeight, nextCapacity),
      buildingBaseY: growFloat32(views.buildingBaseY, nextCapacity),
      buildingWidth: growFloat32(views.buildingWidth, nextCapacity),
      buildingFootprintDepth: growFloat32(views.buildingFootprintDepth, nextCapacity),
      buildingProgress: growFloat32(views.buildingProgress, nextCapacity),
      bodyHudWidth: growFloat32(views.bodyHudWidth, nextCapacity),
      hudBarsY: growFloat32(views.hudBarsY, nextCapacity),
      hudNameY: growFloat32(views.hudNameY, nextCapacity),
      contactShadowWidth: growFloat32(views.contactShadowWidth, nextCapacity),
      contactShadowDepth: growFloat32(views.contactShadowDepth, nextCapacity),
      renderScopePadding: growFloat32(views.renderScopePadding, nextCapacity),
      hp: growFloat32(views.hp, nextCapacity),
      maxHp: growFloat32(views.maxHp, nextCapacity),
      buildEnergyRatio: growFloat32(views.buildEnergyRatio, nextCapacity),
      buildMetalRatio: growFloat32(views.buildMetalRatio, nextCapacity),
      groundContactEnabled: growUint8(views.groundContactEnabled, nextCapacity),
      turretCount: growUint16(views.turretCount, nextCapacity),
      passiveTurretIndex: growInt16(views.passiveTurretIndex, nextCapacity),
      flags: growUint16(views.flags, nextCapacity),
      unitBlueprintIds: views.unitBlueprintIds,
      buildingBlueprintIds: views.buildingBlueprintIds,
    };
    this.dirtySlotMarks = growUint8(this.dirtySlotMarks, nextCapacity);
  }

  private markSlotDirty(slot: number): void {
    if (this.dirtySlotMarks[slot] !== 0) return;
    this.dirtySlotMarks[slot] = 1;
    this.dirtySlots.push(slot);
  }
}
