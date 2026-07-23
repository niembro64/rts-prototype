import type { Entity, EntityId } from '../sim/types';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
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
import { canIndexClientEntityId } from '../network/ClientEntityIds';
import {
  entityLodProxyGlyph3D,
  entityLodProxyRadius3D,
} from './EntityLod3D';
import {
  getShieldPanelTurretIndex,
  NO_SHIELD_PANEL_TURRET_INDEX,
} from './turretRenderHelpers3D';

const INITIAL_RENDER_ENTITY_STATE_CAP = 4096;
const SNAPSHOT_PRESENCE_MAX_MARK = 0xffffffff;
const NO_OWNER_ID = 0;

export const CLIENT_RENDER_ENTITY_FLAG_SELECTED = 1;
export const CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS = 1 << 1;
export const CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED = 1 << 2;
export const CLIENT_RENDER_ENTITY_FLAG_SHELL = 1 << 3;
export const CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION = 1 << 4;
export const CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY = 1 << 5;
export const CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY = 1 << 6;
export const CLIENT_RENDER_UNIT_FLAG_AIRBORNE = 1 << 7;
export const CLIENT_RENDER_UNIT_FLAG_HAS_SUSPENSION = 1 << 8;
const CLIENT_RENDER_ENTITY_PACKET_FLAG_MASK =
  CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION |
  CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY |
  CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY;
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
  readonly radiusCollision: Float32Array;
  readonly lodProxyRadius: Float32Array;
  readonly lodProxyGlyph: Uint8Array;
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  readonly velocityX: Float32Array;
  readonly velocityY: Float32Array;
  readonly yawRate: Float32Array;
  readonly orientationX: Float32Array;
  readonly orientationY: Float32Array;
  readonly orientationZ: Float32Array;
  readonly orientationW: Float32Array;
  readonly hasFullOrientation: Uint8Array;
  readonly bodyOpacity: Float32Array;
  readonly supportPointOffsetZ: Float32Array;
  readonly buildingBaseY: Float32Array;
  readonly buildingWidth: Float32Array;
  readonly buildingFootprintDepth: Float32Array;
  readonly buildingProgress: Float32Array;
  readonly bodyHudWidth: Float32Array;
  readonly hudBarsY: Float32Array;
  readonly hudNameY: Float32Array;
  readonly entityShadowWidth: Float32Array;
  readonly entityShadowDepth: Float32Array;
  readonly renderScopePadding: Float32Array;
  readonly hp: Float32Array;
  readonly maxHp: Float32Array;
  readonly buildEnergyRatio: Float32Array;
  readonly buildMetalRatio: Float32Array;
  readonly groundContactEnabled: Uint8Array;
  readonly turretCount: Uint16Array;
  readonly shieldPanelTurretIndex: Int16Array;
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
  private readonly slotByIndexedEntityId: Array<number | undefined> = [];
  private readonly freeSlots: number[] = [];
  private readonly dirtySlots: number[] = [];
  private readonly packetFlagSlots: number[] = [];
  private readonly snapshotPresenceFallbackIds = new Set<EntityId>();
  private dirtySlotMarks: Uint8Array = new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP);
  private packetFlagSlotMarks: Uint8Array = new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP);
  private snapshotPresenceMarks = new Uint32Array(0);
  private snapshotPresenceMark = 1;
  private nextSlot = 0;
  private activeEntityCount = 0;
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
    radiusCollision: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    lodProxyRadius: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    lodProxyGlyph: new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalX: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    normalZ: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    velocityX: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    velocityY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    yawRate: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    orientationX: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    orientationY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    orientationZ: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    orientationW: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hasFullOrientation: new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    bodyOpacity: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    supportPointOffsetZ: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingBaseY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingFootprintDepth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildingProgress: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    bodyHudWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hudBarsY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hudNameY: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    entityShadowWidth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    entityShadowDepth: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    renderScopePadding: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    hp: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    maxHp: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildEnergyRatio: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    buildMetalRatio: new Float32Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    groundContactEnabled: new Uint8Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    turretCount: new Uint16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    shieldPanelTurretIndex: new Int16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    flags: new Uint16Array(INITIAL_RENDER_ENTITY_STATE_CAP),
    unitBlueprintIds: [],
    buildingBlueprintIds: [],
  };

  getViews(): ClientRenderEntityStateViews {
    return this.views;
  }

  getSlot(id: EntityId): number | undefined {
    if (canIndexClientEntityId(id)) return this.slotByIndexedEntityId[id];
    return this.slotByEntityId.get(id);
  }

  markPacketFlags(slot: number, flags: number): void {
    const packetFlags = flags & CLIENT_RENDER_ENTITY_PACKET_FLAG_MASK;
    if (packetFlags === 0 || slot < 0 || slot >= this.views.flags.length) return;
    if (this.packetFlagSlotMarks[slot] === 0) {
      this.packetFlagSlotMarks[slot] = 1;
      this.packetFlagSlots.push(slot);
    }
    this.views.flags[slot] |= packetFlags;
  }

  clearPacketFlags(): void {
    for (let i = 0; i < this.packetFlagSlots.length; i++) {
      const slot = this.packetFlagSlots[i];
      this.views.flags[slot] &= ~CLIENT_RENDER_ENTITY_PACKET_FLAG_MASK;
      this.packetFlagSlotMarks[slot] = 0;
    }
    this.packetFlagSlots.length = 0;
  }

  slotForEntity(entity: Entity): number {
    const existing = this.getSlot(entity.id);
    if (existing !== undefined) return existing;
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    this.ensureCapacity(slot + 1);
    if (canIndexClientEntityId(entity.id)) {
      this.slotByIndexedEntityId[entity.id] = slot;
    } else {
      this.slotByEntityId.set(entity.id, slot);
    }
    this.views.entityIds[slot] = entity.id;
    this.activeEntityCount++;
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
    const slot = this.getSlot(entity.id);
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
    const slot = this.getSlot(entity.id);
    if (slot === undefined) return this.refreshEntity(entity);
    const views = this.views;
    const turrets = entity.combat?.turrets;
    if (entity.unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return this.refreshEntity(entity);
      views.turretCount[slot] = turrets?.length ?? 0;
      views.shieldPanelTurretIndex[slot] = turrets !== undefined
        ? getShieldPanelTurretIndex(turrets)
        : NO_SHIELD_PANEL_TURRET_INDEX;
      this.markSlotDirty(slot);
      return slot;
    }
    if (entity.building !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) return this.refreshEntity(entity);
      views.turretCount[slot] = turrets?.length ?? 0;
      views.shieldPanelTurretIndex[slot] = NO_SHIELD_PANEL_TURRET_INDEX;
      this.markSlotDirty(slot);
      return slot;
    }
    this.unsetEntity(entity.id);
    return undefined;
  }

  refreshBuildState(entity: Entity): number | undefined {
    const slot = this.getSlot(entity.id);
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
    if (locomotionType === 'hover' || locomotionType === 'flying' || locomotionType === 'dive') {
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
    views.radiusCollision[slot] = unit.radius.collision;
    views.lodProxyRadius[slot] = entityLodProxyRadius3D(entity);
    views.lodProxyGlyph[slot] = entityLodProxyGlyph3D(entity);
    views.normalX[slot] = unit.surfaceNormal.nx;
    views.normalY[slot] = unit.surfaceNormal.ny;
    views.normalZ[slot] = unit.surfaceNormal.nz;
    views.velocityX[slot] = unit.velocityX;
    views.velocityY[slot] = unit.velocityY;
    views.yawRate[slot] = unit.angularVelocity3?.z ?? 0;
    const orientation = unit.orientation;
    views.orientationX[slot] = orientation?.x ?? 0;
    views.orientationY[slot] = orientation?.y ?? 0;
    views.orientationZ[slot] = orientation?.z ?? 0;
    views.orientationW[slot] = orientation?.w ?? 1;
    views.hasFullOrientation[slot] = orientation !== null ? 1 : 0;
    views.bodyOpacity[slot] = getConstructionPieceOpacity(entity, 'body');
    views.supportPointOffsetZ[slot] = unit.supportPointOffsetZ;
    views.bodyHudWidth[slot] = unit.radius.other * 2;
    views.hudBarsY[slot] = getUnitHudBarsY(entity);
    views.hudNameY[slot] = getUnitHudNameY(entity);
    views.entityShadowWidth[slot] = 0;
    views.entityShadowDepth[slot] = 0;
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
    views.shieldPanelTurretIndex[slot] = turrets !== undefined
      ? getShieldPanelTurretIndex(turrets)
      : NO_SHIELD_PANEL_TURRET_INDEX;
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
    views.z[slot] = getBuildingCombatCenterZ(entity);
    views.rotation[slot] = entity.transform.rotation;
    views.radiusHitbox[slot] = 0;
    views.radiusCollision[slot] = 0;
    views.lodProxyRadius[slot] = entityLodProxyRadius3D(entity);
    views.lodProxyGlyph[slot] = entityLodProxyGlyph3D(entity);
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
    views.entityShadowWidth[slot] = building.width;
    views.entityShadowDepth[slot] = building.height;
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
    views.shieldPanelTurretIndex[slot] = NO_SHIELD_PANEL_TURRET_INDEX;
    views.flags[slot] = flags;
    views.unitBlueprintIds[slot] = undefined;
    views.buildingBlueprintIds[slot] = entity.buildingBlueprintId;
    this.markSlotDirty(slot);
    return slot;
  }

  unsetEntity(id: EntityId): void {
    const slot = this.getSlot(id);
    if (slot === undefined) return;
    if (canIndexClientEntityId(id)) {
      this.slotByIndexedEntityId[id] = undefined;
    } else {
      this.slotByEntityId.delete(id);
    }
    if (this.views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_NONE) {
      this.activeEntityCount--;
    }
    this.views.kind[slot] = CLIENT_RENDER_ENTITY_KIND_NONE;
    this.views.entityIds[slot] = 0;
    this.views.ownerIds[slot] = NO_OWNER_ID;
    this.views.flags[slot] = 0;
    this.views.turretCount[slot] = 0;
    this.views.shieldPanelTurretIndex[slot] = NO_SHIELD_PANEL_TURRET_INDEX;
    this.views.radiusHitbox[slot] = 0;
    this.views.radiusCollision[slot] = 0;
    this.views.hasFullOrientation[slot] = 0;
    this.views.lodProxyRadius[slot] = 0;
    this.views.lodProxyGlyph[slot] = 0;
    this.views.bodyHudWidth[slot] = 0;
    this.views.hudBarsY[slot] = 0;
    this.views.hudNameY[slot] = 0;
    this.views.entityShadowWidth[slot] = 0;
    this.views.entityShadowDepth[slot] = 0;
    this.views.renderScopePadding[slot] = 0;
    this.views.groundContactEnabled[slot] = 0;
    this.views.unitBlueprintIds[slot] = undefined;
    this.views.buildingBlueprintIds[slot] = undefined;
    this.freeSlots.push(slot);
    this.markSlotDirty(slot);
  }

  collectEntityIdsMissingFrom(
    present: ReadonlySet<EntityId>,
    out: EntityId[] = [],
  ): EntityId[] {
    out.length = 0;
    const views = this.views;
    for (let slot = 0; slot < this.nextSlot; slot++) {
      if (views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_NONE) continue;
      const id = views.entityIds[slot] as EntityId;
      if (!present.has(id)) out.push(id);
    }
    return out;
  }

  collectEntityIdsMissingFromTypedWireRows(
    basicValues: Float64Array,
    basicCount: number,
    basicStride: number,
    unitValues: Float64Array,
    unitCount: number,
    unitStride: number,
    buildingValues: Float64Array,
    buildingCount: number,
    buildingStride: number,
    out: EntityId[] = [],
  ): EntityId[] {
    out.length = 0;
    this.beginSnapshotPresenceMark();
    this.snapshotPresenceFallbackIds.clear();
    const matchedLiveCount =
      this.markSnapshotPresenceRows(basicValues, basicCount, basicStride) +
      this.markSnapshotPresenceRows(unitValues, unitCount, unitStride) +
      this.markSnapshotPresenceRows(buildingValues, buildingCount, buildingStride);
    if (matchedLiveCount === this.activeEntityCount) {
      this.snapshotPresenceFallbackIds.clear();
      return out;
    }

    const views = this.views;
    for (let slot = 0; slot < this.nextSlot; slot++) {
      if (views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_NONE) continue;
      const id = views.entityIds[slot] as EntityId;
      if (!this.snapshotPresenceHas(id)) out.push(id);
    }
    this.snapshotPresenceFallbackIds.clear();
    return out;
  }

  private beginSnapshotPresenceMark(): void {
    if (this.snapshotPresenceMark < SNAPSHOT_PRESENCE_MAX_MARK) {
      this.snapshotPresenceMark++;
      return;
    }
    this.snapshotPresenceMarks.fill(0);
    this.snapshotPresenceMark = 1;
  }

  private markSnapshotPresenceRows(
    values: Float64Array,
    count: number,
    stride: number,
  ): number {
    let matchedLiveCount = 0;
    for (let rowIndex = 0, base = 0; rowIndex < count; rowIndex++, base += stride) {
      if (this.markSnapshotPresenceId(values[base] as EntityId)) matchedLiveCount++;
    }
    return matchedLiveCount;
  }

  private markSnapshotPresenceId(id: EntityId): boolean {
    const slot = this.getSlot(id);
    const isLive =
      slot !== undefined &&
      this.views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_NONE;
    if (!canIndexClientEntityId(id)) {
      const previousSize = this.snapshotPresenceFallbackIds.size;
      this.snapshotPresenceFallbackIds.add(id);
      return isLive && this.snapshotPresenceFallbackIds.size !== previousSize;
    }
    this.ensureSnapshotPresenceCapacity(id + 1);
    const alreadyMarked = this.snapshotPresenceMarks[id] === this.snapshotPresenceMark;
    this.snapshotPresenceMarks[id] = this.snapshotPresenceMark;
    return isLive && !alreadyMarked;
  }

  private snapshotPresenceHas(id: EntityId): boolean {
    if (!canIndexClientEntityId(id)) return this.snapshotPresenceFallbackIds.has(id);
    return id < this.snapshotPresenceMarks.length &&
      this.snapshotPresenceMarks[id] === this.snapshotPresenceMark;
  }

  private ensureSnapshotPresenceCapacity(required: number): void {
    if (this.snapshotPresenceMarks.length >= required) return;
    let next = this.snapshotPresenceMarks.length > 0
      ? this.snapshotPresenceMarks.length
      : INITIAL_RENDER_ENTITY_STATE_CAP;
    while (next < required) next *= 2;
    const marks = new Uint32Array(next);
    marks.set(this.snapshotPresenceMarks);
    this.snapshotPresenceMarks = marks;
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

  clearDirtySlots(): void {
    for (let i = 0; i < this.dirtySlots.length; i++) {
      this.dirtySlotMarks[this.dirtySlots[i]] = 0;
    }
    this.dirtySlots.length = 0;
  }

  clear(): void {
    this.slotByEntityId.clear();
    this.slotByIndexedEntityId.length = 0;
    this.freeSlots.length = 0;
    this.dirtySlots.length = 0;
    this.packetFlagSlots.length = 0;
    this.dirtySlotMarks.fill(0);
    this.packetFlagSlotMarks.fill(0);
    this.nextSlot = 0;
    this.activeEntityCount = 0;
    this.views.kind.fill(CLIENT_RENDER_ENTITY_KIND_NONE);
    this.views.entityIds.fill(0);
    this.views.ownerIds.fill(NO_OWNER_ID);
    this.views.flags.fill(0);
    this.views.turretCount.fill(0);
    this.views.shieldPanelTurretIndex.fill(NO_SHIELD_PANEL_TURRET_INDEX);
    this.views.radiusHitbox.fill(0);
    this.views.radiusCollision.fill(0);
    this.views.lodProxyRadius.fill(0);
    this.views.lodProxyGlyph.fill(0);
    this.views.bodyHudWidth.fill(0);
    this.views.hudBarsY.fill(0);
    this.views.hudNameY.fill(0);
    this.views.entityShadowWidth.fill(0);
    this.views.entityShadowDepth.fill(0);
    this.views.renderScopePadding.fill(0);
    this.views.groundContactEnabled.fill(0);
    this.views.unitBlueprintIds.length = 0;
    this.views.buildingBlueprintIds.length = 0;
  }

  assertParity(entity: Entity): void {
    const slot = this.getSlot(entity.id);
    if (slot === undefined) {
      throw new Error(`[client render entity state] missing slot for entity ${entity.id}`);
    }
    const views = this.views;
    assertNear('entity id', views.entityIds[slot], entity.id, 0);
    assertNear('owner id', views.ownerIds[slot], entity.ownership?.playerId ?? NO_OWNER_ID, 0);
    assertNear('x', views.x[slot], entity.transform.x);
    assertNear('y', views.y[slot], entity.transform.y);
    const expectedZ = entity.building !== null
      ? getBuildingCombatCenterZ(entity)
      : entity.transform.z;
    assertNear('z', views.z[slot], expectedZ);
    assertNear('rotation', views.rotation[slot], entity.transform.rotation);
    const unit = entity.unit;
    if (unit !== null) {
      if (views.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) {
        throw new Error(`[client render entity state] entity ${entity.id} expected unit row`);
      }
      assertNear('groundY', views.groundY[slot], getUnitGroundZ(entity));
      assertNear('radiusOther', views.radiusOther[slot], unit.radius.other || unit.radius.hitbox || 15);
      assertNear('radiusHitbox', views.radiusHitbox[slot], unit.radius.hitbox);
      assertNear('radiusCollision', views.radiusCollision[slot], unit.radius.collision);
      assertNear('lodProxyRadius', views.lodProxyRadius[slot], entityLodProxyRadius3D(entity));
      assertNear('lodProxyGlyph', views.lodProxyGlyph[slot], entityLodProxyGlyph3D(entity), 0);
      assertNear('velocityX', views.velocityX[slot], unit.velocityX);
      assertNear('velocityY', views.velocityY[slot], unit.velocityY);
      assertNear('orientationX', views.orientationX[slot], unit.orientation?.x ?? 0);
      assertNear('orientationY', views.orientationY[slot], unit.orientation?.y ?? 0);
      assertNear('orientationZ', views.orientationZ[slot], unit.orientation?.z ?? 0);
      assertNear('orientationW', views.orientationW[slot], unit.orientation?.w ?? 1);
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
      assertNear('lodProxyRadius', views.lodProxyRadius[slot], entityLodProxyRadius3D(entity));
      assertNear('lodProxyGlyph', views.lodProxyGlyph[slot], entityLodProxyGlyph3D(entity), 0);
      assertNear('buildingBaseY', views.buildingBaseY[slot], entity.transform.z - building.depth / 2);
      assertNear('bodyHudWidth', views.bodyHudWidth[slot], building.width);
      assertNear('hudBarsY', views.hudBarsY[slot], getBuildingHudBarsY(entity));
      assertNear('hudNameY', views.hudNameY[slot], getBuildingHudNameY(entity));
      assertNear('entityShadowWidth', views.entityShadowWidth[slot], building.width);
      assertNear('entityShadowDepth', views.entityShadowDepth[slot], building.height);
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
      radiusCollision: growFloat32(views.radiusCollision, nextCapacity),
      lodProxyRadius: growFloat32(views.lodProxyRadius, nextCapacity),
      lodProxyGlyph: growUint8(views.lodProxyGlyph, nextCapacity),
      normalX: growFloat32(views.normalX, nextCapacity),
      normalY: growFloat32(views.normalY, nextCapacity),
      normalZ: growFloat32(views.normalZ, nextCapacity),
      velocityX: growFloat32(views.velocityX, nextCapacity),
      velocityY: growFloat32(views.velocityY, nextCapacity),
      yawRate: growFloat32(views.yawRate, nextCapacity),
      orientationX: growFloat32(views.orientationX, nextCapacity),
      orientationY: growFloat32(views.orientationY, nextCapacity),
      orientationZ: growFloat32(views.orientationZ, nextCapacity),
      orientationW: growFloat32(views.orientationW, nextCapacity),
      hasFullOrientation: growUint8(views.hasFullOrientation, nextCapacity),
      bodyOpacity: growFloat32(views.bodyOpacity, nextCapacity),
      supportPointOffsetZ: growFloat32(views.supportPointOffsetZ, nextCapacity),
      buildingBaseY: growFloat32(views.buildingBaseY, nextCapacity),
      buildingWidth: growFloat32(views.buildingWidth, nextCapacity),
      buildingFootprintDepth: growFloat32(views.buildingFootprintDepth, nextCapacity),
      buildingProgress: growFloat32(views.buildingProgress, nextCapacity),
      bodyHudWidth: growFloat32(views.bodyHudWidth, nextCapacity),
      hudBarsY: growFloat32(views.hudBarsY, nextCapacity),
      hudNameY: growFloat32(views.hudNameY, nextCapacity),
      entityShadowWidth: growFloat32(views.entityShadowWidth, nextCapacity),
      entityShadowDepth: growFloat32(views.entityShadowDepth, nextCapacity),
      renderScopePadding: growFloat32(views.renderScopePadding, nextCapacity),
      hp: growFloat32(views.hp, nextCapacity),
      maxHp: growFloat32(views.maxHp, nextCapacity),
      buildEnergyRatio: growFloat32(views.buildEnergyRatio, nextCapacity),
      buildMetalRatio: growFloat32(views.buildMetalRatio, nextCapacity),
      groundContactEnabled: growUint8(views.groundContactEnabled, nextCapacity),
      turretCount: growUint16(views.turretCount, nextCapacity),
      shieldPanelTurretIndex: growInt16(views.shieldPanelTurretIndex, nextCapacity),
      flags: growUint16(views.flags, nextCapacity),
      unitBlueprintIds: views.unitBlueprintIds,
      buildingBlueprintIds: views.buildingBlueprintIds,
    };
    this.dirtySlotMarks = growUint8(this.dirtySlotMarks, nextCapacity);
    this.packetFlagSlotMarks = growUint8(this.packetFlagSlotMarks, nextCapacity);
  }

  private markSlotDirty(slot: number): void {
    if (this.dirtySlotMarks[slot] !== 0) return;
    this.dirtySlotMarks[slot] = 1;
    this.dirtySlots.push(slot);
  }
}
