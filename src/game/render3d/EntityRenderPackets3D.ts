import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import {
  getConstructionPieceOpacity,
  getConstructionPieceRenderFraction,
  isBuildInProgress,
  isConstructionPieceMaterialized,
  isShell,
} from '../sim/buildableHelpers';
import { getUnitGroundZ } from '../sim/unitGeometry';
import type { ClientRenderEntityStateViews } from './ClientRenderEntityStateSlab';
import {
  CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED,
  CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS,
  CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION,
  CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY,
  CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY,
  CLIENT_RENDER_ENTITY_FLAG_SELECTED,
  CLIENT_RENDER_ENTITY_FLAG_SHELL,
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  CLIENT_RENDER_UNIT_FLAG_AIRBORNE,
  CLIENT_RENDER_UNIT_FLAG_HAS_SUSPENSION,
} from './ClientRenderEntityStateSlab';
import {
  entityLodProxyGlyph3D,
  entityLodProxyRadius3D,
} from './EntityLod3D';
import type {
  ClientRenderTurretHostRows,
  ClientRenderTurretStateSlab,
  ClientRenderTurretStateViews,
} from './ClientRenderTurretStateSlab';
import {
  getPassiveTurretIndex,
  NO_PASSIVE_TURRET_INDEX,
} from './turretRenderHelpers3D';

const ENTITY_RENDER_PACKET_INITIAL_CAP = 4096;
const ENTITY_RENDER_REMOVAL_INITIAL_CAP = 256;
const NO_OWNER_ID = 0;

const ENTITY_RENDER_FLAG_SELECTED = CLIENT_RENDER_ENTITY_FLAG_SELECTED;
const ENTITY_RENDER_FLAG_BUILD_IN_PROGRESS = CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS;
const ENTITY_RENDER_FLAG_BODY_MATERIALIZED = CLIENT_RENDER_ENTITY_FLAG_BODY_MATERIALIZED;
const ENTITY_RENDER_FLAG_SHELL = CLIENT_RENDER_ENTITY_FLAG_SHELL;
const ENTITY_RENDER_FLAG_ACTIVE_PREDICTION = CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION;
const ENTITY_RENDER_FLAG_RENDER_DIRTY = CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY;
const ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY = CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY;
const UNIT_RENDER_FLAG_AIRBORNE = CLIENT_RENDER_UNIT_FLAG_AIRBORNE;
const UNIT_RENDER_FLAG_HAS_SUSPENSION = CLIENT_RENDER_UNIT_FLAG_HAS_SUSPENSION;
const ENTITY_RENDER_FLAG_LOD_PROXY = 1 << 9;
const EMPTY_TURRETS: readonly Turret[] = [];

function growFloat32(
  source: Float32Array<ArrayBuffer>,
  nextCapacity: number,
): Float32Array<ArrayBuffer> {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(
  source: Float64Array<ArrayBuffer>,
  nextCapacity: number,
): Float64Array<ArrayBuffer> {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(
  source: Uint8Array<ArrayBuffer>,
  nextCapacity: number,
): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(
  source: Uint16Array<ArrayBuffer>,
  nextCapacity: number,
): Uint16Array<ArrayBuffer> {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint32(
  source: Uint32Array<ArrayBuffer>,
  nextCapacity: number,
): Uint32Array<ArrayBuffer> {
  const next = new Uint32Array(nextCapacity);
  next.set(source);
  return next;
}

function growInt16(
  source: Int16Array<ArrayBuffer>,
  nextCapacity: number,
): Int16Array<ArrayBuffer> {
  const next = new Int16Array(nextCapacity);
  next.set(source);
  return next;
}

function growInt32(
  source: Int32Array<ArrayBuffer>,
  nextCapacity: number,
): Int32Array<ArrayBuffer> {
  const next = new Int32Array(nextCapacity);
  next.set(source);
  return next;
}

function entityRenderFlags(
  entity: Entity,
  activePrediction: boolean,
  renderDirty: boolean,
  lifecycleDirty: boolean,
  lodProxy: boolean,
): number {
  let flags = entity.selectable?.selected === true
    ? ENTITY_RENDER_FLAG_SELECTED
    : 0;
  if (isBuildInProgress(entity.buildable)) flags |= ENTITY_RENDER_FLAG_BUILD_IN_PROGRESS;
  if (isConstructionPieceMaterialized(entity, 'body')) flags |= ENTITY_RENDER_FLAG_BODY_MATERIALIZED;
  if (isShell(entity)) flags |= ENTITY_RENDER_FLAG_SHELL;
  if (activePrediction) flags |= ENTITY_RENDER_FLAG_ACTIVE_PREDICTION;
  if (renderDirty) flags |= ENTITY_RENDER_FLAG_RENDER_DIRTY;
  if (lifecycleDirty) flags |= ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY;
  if (lodProxy) flags |= ENTITY_RENDER_FLAG_LOD_PROXY;
  return flags;
}

function entityRenderFlagsFromState(
  stateFlags: number,
  activePrediction: boolean,
  renderDirty: boolean,
  lifecycleDirty: boolean,
  lodProxy: boolean,
): number {
  let flags = stateFlags;
  if (activePrediction) flags |= ENTITY_RENDER_FLAG_ACTIVE_PREDICTION;
  if (renderDirty) flags |= ENTITY_RENDER_FLAG_RENDER_DIRTY;
  if (lifecycleDirty) flags |= ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY;
  if (lodProxy) flags |= ENTITY_RENDER_FLAG_LOD_PROXY;
  return flags;
}

export class UnitRenderPacket3D {
  private readonly entities: (Entity | undefined)[] = [];
  private readonly turrets: (readonly Turret[] | undefined)[] = [];
  private turretStateViews: ClientRenderTurretStateViews | undefined;
  private turretHostSlots = new Int32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private turretStarts = new Uint32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private turretStateCounts = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private readonly turretRowsScratch: ClientRenderTurretHostRows = {
    hostSlot: -1,
    start: 0,
    count: 0,
    views: undefined as unknown as ClientRenderTurretStateViews,
  };
  unitBlueprintIds: (string | undefined)[] = [];
  removedIds = new Float64Array(ENTITY_RENDER_REMOVAL_INITIAL_CAP);
  ids = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  ownerIds = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  x = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  y = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  z = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  rotation = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  groundY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  radiusOther = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  lodProxyRadius = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  lodProxyGlyph = new Uint8Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalZ = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  yawRate = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  orientationX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  orientationY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  orientationZ = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  orientationW = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  hasFullOrientation = new Uint8Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  bodyOpacity = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  supportPointOffsetZ = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  turretCount = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  passiveTurretIndex = new Int16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  flags = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  count = 0;
  removedCount = 0;

  reset(): void {
    this.count = 0;
    this.removedCount = 0;
    this.entities.length = 0;
    this.turrets.length = 0;
    this.turretStateViews = undefined;
    this.unitBlueprintIds.length = 0;
  }

  pushRemovedEntityId(id: EntityId): void {
    const cursor = this.removedCount;
    this.ensureRemovalCapacity(cursor + 1);
    this.removedIds[cursor] = id;
    this.removedCount = cursor + 1;
  }

  pushEntity(
    entity: Entity,
    activePrediction: boolean = false,
    renderDirty: boolean = false,
    lifecycleDirty: boolean = false,
    lodProxy: boolean = false,
  ): void {
    const unit = entity.unit;
    if (unit === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const combatTurrets = entity.combat?.turrets;
    const turretRows = combatTurrets ?? EMPTY_TURRETS;
    this.entities[cursor] = entity;
    this.turrets[cursor] = turretRows;
    this.turretHostSlots[cursor] = -1;
    this.turretStarts[cursor] = 0;
    this.turretStateCounts[cursor] = 0;
    this.unitBlueprintIds[cursor] = unit.unitBlueprintId;
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = entity.transform.z;
    this.rotation[cursor] = entity.transform.rotation;
    this.groundY[cursor] = getUnitGroundZ(entity);
    this.radiusOther[cursor] = unit.radius.other || unit.radius.hitbox || 15;
    this.lodProxyRadius[cursor] = entityLodProxyRadius3D(entity);
    this.lodProxyGlyph[cursor] = entityLodProxyGlyph3D(entity);
    this.normalX[cursor] = unit.surfaceNormal.nx;
    this.normalY[cursor] = unit.surfaceNormal.ny;
    this.normalZ[cursor] = unit.surfaceNormal.nz;
    this.velocityX[cursor] = unit.velocityX;
    this.velocityY[cursor] = unit.velocityY;
    this.yawRate[cursor] = unit.angularVelocity3?.z ?? 0;
    this.orientationX[cursor] = unit.orientation?.x ?? 0;
    this.orientationY[cursor] = unit.orientation?.y ?? 0;
    this.orientationZ[cursor] = unit.orientation?.z ?? 0;
    this.orientationW[cursor] = unit.orientation?.w ?? 1;
    this.hasFullOrientation[cursor] = unit.orientation !== null ? 1 : 0;
    this.bodyOpacity[cursor] = getConstructionPieceOpacity(entity, 'body');
    this.supportPointOffsetZ[cursor] = unit.supportPointOffsetZ;
    this.turretCount[cursor] = turretRows.length;
    this.passiveTurretIndex[cursor] = getPassiveTurretIndex(turretRows);
    let flags = entityRenderFlags(entity, activePrediction, renderDirty, lifecycleDirty, lodProxy);
    const locomotionType = unit.locomotion.type;
    if (locomotionType === 'hover' || locomotionType === 'flying' || locomotionType === 'dive') {
      flags |= UNIT_RENDER_FLAG_AIRBORNE;
    }
    if (unit.suspension !== null) flags |= UNIT_RENDER_FLAG_HAS_SUSPENSION;
    this.flags[cursor] = flags;
    this.count = cursor + 1;
  }

  pushEntityState(
    entity: Entity,
    state: ClientRenderEntityStateViews,
    slot: number,
    turretState?: ClientRenderTurretStateSlab,
    activePrediction: boolean = false,
    renderDirty: boolean = false,
    lifecycleDirty: boolean = false,
    lodProxy: boolean = false,
  ): void {
    if (state.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return;
    if (!lodProxy && entity.unit === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const flags = entityRenderFlagsFromState(
      state.flags[slot],
      activePrediction,
      renderDirty,
      lifecycleDirty,
      lodProxy,
    );
    if (lodProxy) {
      this.entities[cursor] = undefined;
      this.turrets[cursor] = EMPTY_TURRETS;
      this.turretHostSlots[cursor] = -1;
      this.turretStarts[cursor] = 0;
      this.turretStateCounts[cursor] = 0;
      this.unitBlueprintIds[cursor] = undefined;
      this.ids[cursor] = state.entityIds[slot];
      this.ownerIds[cursor] = state.ownerIds[slot];
      this.x[cursor] = state.x[slot];
      this.y[cursor] = state.y[slot];
      this.z[cursor] = state.z[slot];
      this.lodProxyRadius[cursor] = state.lodProxyRadius[slot];
      this.lodProxyGlyph[cursor] = state.lodProxyGlyph[slot];
      this.turretCount[cursor] = 0;
      this.passiveTurretIndex[cursor] = NO_PASSIVE_TURRET_INDEX;
      this.flags[cursor] = flags;
      this.count = cursor + 1;
      return;
    }
    const combatTurrets = entity.combat?.turrets;
    const turretRows = combatTurrets ?? EMPTY_TURRETS;
    const turretStateRows = turretState?.hostRows(slot);
    this.entities[cursor] = entity;
    this.turrets[cursor] = turretRows;
    if (turretStateRows !== undefined) {
      this.turretStateViews = turretStateRows.views;
      this.turretHostSlots[cursor] = turretStateRows.hostSlot;
      this.turretStarts[cursor] = turretStateRows.start;
      this.turretStateCounts[cursor] = turretStateRows.count;
    } else {
      this.turretHostSlots[cursor] = -1;
      this.turretStarts[cursor] = 0;
      this.turretStateCounts[cursor] = 0;
    }
    this.unitBlueprintIds[cursor] = state.unitBlueprintIds[slot];
    this.ids[cursor] = state.entityIds[slot];
    this.ownerIds[cursor] = state.ownerIds[slot];
    this.x[cursor] = state.x[slot];
    this.y[cursor] = state.y[slot];
    this.z[cursor] = state.z[slot];
    this.rotation[cursor] = state.rotation[slot];
    this.groundY[cursor] = state.groundY[slot];
    this.radiusOther[cursor] = state.radiusOther[slot];
    this.lodProxyRadius[cursor] = state.lodProxyRadius[slot];
    this.lodProxyGlyph[cursor] = state.lodProxyGlyph[slot];
    this.normalX[cursor] = state.normalX[slot];
    this.normalY[cursor] = state.normalY[slot];
    this.normalZ[cursor] = state.normalZ[slot];
    this.velocityX[cursor] = state.velocityX[slot];
    this.velocityY[cursor] = state.velocityY[slot];
    this.yawRate[cursor] = state.yawRate[slot];
    this.orientationX[cursor] = state.orientationX[slot];
    this.orientationY[cursor] = state.orientationY[slot];
    this.orientationZ[cursor] = state.orientationZ[slot];
    this.orientationW[cursor] = state.orientationW[slot];
    this.hasFullOrientation[cursor] = state.hasFullOrientation[slot];
    this.bodyOpacity[cursor] = state.bodyOpacity[slot];
    this.supportPointOffsetZ[cursor] = state.supportPointOffsetZ[slot];
    this.turretCount[cursor] = state.turretCount[slot];
    this.passiveTurretIndex[cursor] = state.passiveTurretIndex[slot];
    this.flags[cursor] = flags;
    this.count = cursor + 1;
  }

  entityAt(row: number): Entity | undefined {
    return this.entities[row];
  }

  turretsAt(row: number): readonly Turret[] {
    return this.turrets[row] ?? EMPTY_TURRETS;
  }

  turretStateAt(row: number): ClientRenderTurretHostRows | undefined {
    const views = this.turretStateViews;
    const hostSlot = this.turretHostSlots[row];
    if (views === undefined || hostSlot < 0) return undefined;
    const rows = this.turretRowsScratch;
    (rows as { hostSlot: number }).hostSlot = hostSlot;
    (rows as { start: number }).start = this.turretStarts[row];
    (rows as { count: number }).count = this.turretStateCounts[row];
    (rows as { views: ClientRenderTurretStateViews }).views = views;
    return rows;
  }

  entityIdAt(row: number): EntityId {
    return this.ids[row] as EntityId;
  }

  removedEntityIdAt(row: number): EntityId {
    return this.removedIds[row] as EntityId;
  }

  ownerIdAt(row: number): PlayerId | undefined {
    const ownerId = this.ownerIds[row];
    return ownerId > 0 ? ownerId as PlayerId : undefined;
  }

  selectedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_SELECTED) !== 0;
  }

  buildInProgressAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_BUILD_IN_PROGRESS) !== 0;
  }

  bodyMaterializedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_BODY_MATERIALIZED) !== 0;
  }

  activePredictionAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_ACTIVE_PREDICTION) !== 0;
  }

  renderDirtyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_RENDER_DIRTY) !== 0;
  }

  lifecycleDirtyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY) !== 0;
  }

  lodProxyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_LOD_PROXY) !== 0;
  }

  airborneAt(row: number): boolean {
    return (this.flags[row] & UNIT_RENDER_FLAG_AIRBORNE) !== 0;
  }

  hasSuspensionAt(row: number): boolean {
    return (this.flags[row] & UNIT_RENDER_FLAG_HAS_SUSPENSION) !== 0;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    let nextCapacity = this.ids.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.ids = growFloat64(this.ids, nextCapacity);
    this.ownerIds = growFloat64(this.ownerIds, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.rotation = growFloat32(this.rotation, nextCapacity);
    this.groundY = growFloat32(this.groundY, nextCapacity);
    this.radiusOther = growFloat32(this.radiusOther, nextCapacity);
    this.lodProxyRadius = growFloat32(this.lodProxyRadius, nextCapacity);
    this.lodProxyGlyph = growUint8(this.lodProxyGlyph, nextCapacity);
    this.normalX = growFloat32(this.normalX, nextCapacity);
    this.normalY = growFloat32(this.normalY, nextCapacity);
    this.normalZ = growFloat32(this.normalZ, nextCapacity);
    this.velocityX = growFloat32(this.velocityX, nextCapacity);
    this.velocityY = growFloat32(this.velocityY, nextCapacity);
    this.yawRate = growFloat32(this.yawRate, nextCapacity);
    this.orientationX = growFloat32(this.orientationX, nextCapacity);
    this.orientationY = growFloat32(this.orientationY, nextCapacity);
    this.orientationZ = growFloat32(this.orientationZ, nextCapacity);
    this.orientationW = growFloat32(this.orientationW, nextCapacity);
    this.hasFullOrientation = growUint8(this.hasFullOrientation, nextCapacity);
    this.bodyOpacity = growFloat32(this.bodyOpacity, nextCapacity);
    this.supportPointOffsetZ = growFloat32(this.supportPointOffsetZ, nextCapacity);
    this.turretCount = growUint16(this.turretCount, nextCapacity);
    this.passiveTurretIndex = growInt16(this.passiveTurretIndex, nextCapacity);
    this.flags = growUint16(this.flags, nextCapacity);
    this.turretHostSlots = growInt32(this.turretHostSlots, nextCapacity);
    this.turretStarts = growUint32(this.turretStarts, nextCapacity);
    this.turretStateCounts = growUint16(this.turretStateCounts, nextCapacity);
  }

  private ensureRemovalCapacity(required: number): void {
    if (required <= this.removedIds.length) return;
    let nextCapacity = this.removedIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.removedIds = growFloat64(this.removedIds, nextCapacity);
  }
}

export class BuildingRenderPacket3D {
  private readonly entities: (Entity | undefined)[] = [];
  private readonly turrets: (readonly Turret[] | undefined)[] = [];
  private turretStateViews: ClientRenderTurretStateViews | undefined;
  private turretHostSlots = new Int32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private turretStarts = new Uint32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private turretStateCounts = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  private readonly turretRowsScratch: ClientRenderTurretHostRows = {
    hostSlot: -1,
    start: 0,
    count: 0,
    views: undefined as unknown as ClientRenderTurretStateViews,
  };
  buildingBlueprintIds: (string | null | undefined)[] = [];
  removedIds = new Float64Array(ENTITY_RENDER_REMOVAL_INITIAL_CAP);
  ids = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  ownerIds = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  x = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  y = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  z = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  rotation = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  baseY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  width = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  footprintDepth = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  progress = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  bodyOpacity = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  lodProxyRadius = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  lodProxyGlyph = new Uint8Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  turretCount = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  flags = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  count = 0;
  removedCount = 0;

  reset(): void {
    this.count = 0;
    this.removedCount = 0;
    this.entities.length = 0;
    this.turrets.length = 0;
    this.turretStateViews = undefined;
    this.buildingBlueprintIds.length = 0;
  }

  pushRemovedEntityId(id: EntityId): void {
    const cursor = this.removedCount;
    this.ensureRemovalCapacity(cursor + 1);
    this.removedIds[cursor] = id;
    this.removedCount = cursor + 1;
  }

  pushEntity(
    entity: Entity,
    activePrediction: boolean = false,
    renderDirty: boolean = false,
    lifecycleDirty: boolean = false,
    lodProxy: boolean = false,
  ): void {
    const building = entity.building;
    if (building === null) return;
    const visualConfig = entity.buildingBlueprintId !== null
      ? getBuildingConfig(entity.buildingBlueprintId)
      : null;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const combatTurrets = entity.combat?.turrets;
    const turretRows = combatTurrets ?? EMPTY_TURRETS;
    this.entities[cursor] = entity;
    this.turrets[cursor] = turretRows;
    this.turretHostSlots[cursor] = -1;
    this.turretStarts[cursor] = 0;
    this.turretStateCounts[cursor] = 0;
    this.buildingBlueprintIds[cursor] = entity.buildingBlueprintId;
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = getBuildingCombatCenterZ(entity);
    this.rotation[cursor] = entity.transform.rotation;
    this.baseY[cursor] = entity.transform.z - building.depth / 2;
    this.width[cursor] = visualConfig !== null
      ? visualConfig.gridWidth * BUILD_GRID_CELL_SIZE
      : building.width;
    this.footprintDepth[cursor] = visualConfig !== null
      ? visualConfig.gridHeight * BUILD_GRID_CELL_SIZE
      : building.height;
    this.progress[cursor] = getConstructionPieceRenderFraction(entity, 'body');
    this.bodyOpacity[cursor] = getConstructionPieceOpacity(entity, 'body');
    this.lodProxyRadius[cursor] = entityLodProxyRadius3D(entity);
    this.lodProxyGlyph[cursor] = entityLodProxyGlyph3D(entity);
    this.turretCount[cursor] = turretRows.length;
    this.flags[cursor] = entityRenderFlags(
      entity,
      activePrediction,
      renderDirty,
      lifecycleDirty,
      lodProxy,
    );
    this.count = cursor + 1;
  }

  pushEntityState(
    entity: Entity,
    state: ClientRenderEntityStateViews,
    slot: number,
    turretState?: ClientRenderTurretStateSlab,
    activePrediction: boolean = false,
    renderDirty: boolean = false,
    lifecycleDirty: boolean = false,
    lodProxy: boolean = false,
  ): void {
    if (state.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_BUILDING) return;
    if (!lodProxy && entity.building === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const flags = entityRenderFlagsFromState(
      state.flags[slot],
      activePrediction,
      renderDirty,
      lifecycleDirty,
      lodProxy,
    );
    if (lodProxy) {
      this.entities[cursor] = undefined;
      this.turrets[cursor] = EMPTY_TURRETS;
      this.turretHostSlots[cursor] = -1;
      this.turretStarts[cursor] = 0;
      this.turretStateCounts[cursor] = 0;
      this.buildingBlueprintIds[cursor] = undefined;
      this.ids[cursor] = state.entityIds[slot];
      this.ownerIds[cursor] = state.ownerIds[slot];
      this.x[cursor] = state.x[slot];
      this.y[cursor] = state.y[slot];
      this.z[cursor] = state.z[slot];
      this.lodProxyRadius[cursor] = state.lodProxyRadius[slot];
      this.lodProxyGlyph[cursor] = state.lodProxyGlyph[slot];
      this.turretCount[cursor] = 0;
      this.flags[cursor] = flags;
      this.count = cursor + 1;
      return;
    }
    const combatTurrets = entity.combat?.turrets;
    const turretRows = combatTurrets ?? EMPTY_TURRETS;
    const turretStateRows = turretState?.hostRows(slot);
    this.entities[cursor] = entity;
    this.turrets[cursor] = turretRows;
    if (turretStateRows !== undefined) {
      this.turretStateViews = turretStateRows.views;
      this.turretHostSlots[cursor] = turretStateRows.hostSlot;
      this.turretStarts[cursor] = turretStateRows.start;
      this.turretStateCounts[cursor] = turretStateRows.count;
    } else {
      this.turretHostSlots[cursor] = -1;
      this.turretStarts[cursor] = 0;
      this.turretStateCounts[cursor] = 0;
    }
    this.buildingBlueprintIds[cursor] = state.buildingBlueprintIds[slot];
    this.ids[cursor] = state.entityIds[slot];
    this.ownerIds[cursor] = state.ownerIds[slot];
    this.x[cursor] = state.x[slot];
    this.y[cursor] = state.y[slot];
    this.z[cursor] = state.z[slot];
    this.rotation[cursor] = state.rotation[slot];
    this.baseY[cursor] = state.buildingBaseY[slot];
    this.width[cursor] = state.buildingWidth[slot];
    this.footprintDepth[cursor] = state.buildingFootprintDepth[slot];
    this.progress[cursor] = state.buildingProgress[slot];
    this.bodyOpacity[cursor] = state.bodyOpacity[slot];
    this.lodProxyRadius[cursor] = state.lodProxyRadius[slot];
    this.lodProxyGlyph[cursor] = state.lodProxyGlyph[slot];
    this.turretCount[cursor] = state.turretCount[slot];
    this.flags[cursor] = flags;
    this.count = cursor + 1;
  }

  entityAt(row: number): Entity | undefined {
    return this.entities[row];
  }

  turretsAt(row: number): readonly Turret[] {
    return this.turrets[row] ?? EMPTY_TURRETS;
  }

  turretStateAt(row: number): ClientRenderTurretHostRows | undefined {
    const views = this.turretStateViews;
    const hostSlot = this.turretHostSlots[row];
    if (views === undefined || hostSlot < 0) return undefined;
    const rows = this.turretRowsScratch;
    (rows as { hostSlot: number }).hostSlot = hostSlot;
    (rows as { start: number }).start = this.turretStarts[row];
    (rows as { count: number }).count = this.turretStateCounts[row];
    (rows as { views: ClientRenderTurretStateViews }).views = views;
    return rows;
  }

  entityIdAt(row: number): EntityId {
    return this.ids[row] as EntityId;
  }

  removedEntityIdAt(row: number): EntityId {
    return this.removedIds[row] as EntityId;
  }

  ownerIdAt(row: number): PlayerId | undefined {
    const ownerId = this.ownerIds[row];
    return ownerId > 0 ? ownerId as PlayerId : undefined;
  }

  selectedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_SELECTED) !== 0;
  }

  buildInProgressAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_BUILD_IN_PROGRESS) !== 0;
  }

  bodyMaterializedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_BODY_MATERIALIZED) !== 0;
  }

  shellAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_SHELL) !== 0;
  }

  activePredictionAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_ACTIVE_PREDICTION) !== 0;
  }

  renderDirtyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_RENDER_DIRTY) !== 0;
  }

  lifecycleDirtyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY) !== 0;
  }

  lodProxyAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_LOD_PROXY) !== 0;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    let nextCapacity = this.ids.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.ids = growFloat64(this.ids, nextCapacity);
    this.ownerIds = growFloat64(this.ownerIds, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.rotation = growFloat32(this.rotation, nextCapacity);
    this.baseY = growFloat32(this.baseY, nextCapacity);
    this.width = growFloat32(this.width, nextCapacity);
    this.footprintDepth = growFloat32(this.footprintDepth, nextCapacity);
    this.progress = growFloat32(this.progress, nextCapacity);
    this.bodyOpacity = growFloat32(this.bodyOpacity, nextCapacity);
    this.lodProxyRadius = growFloat32(this.lodProxyRadius, nextCapacity);
    this.lodProxyGlyph = growUint8(this.lodProxyGlyph, nextCapacity);
    this.turretCount = growUint16(this.turretCount, nextCapacity);
    this.flags = growUint16(this.flags, nextCapacity);
    this.turretHostSlots = growInt32(this.turretHostSlots, nextCapacity);
    this.turretStarts = growUint32(this.turretStarts, nextCapacity);
    this.turretStateCounts = growUint16(this.turretStateCounts, nextCapacity);
  }

  private ensureRemovalCapacity(required: number): void {
    if (required <= this.removedIds.length) return;
    let nextCapacity = this.removedIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.removedIds = growFloat64(this.removedIds, nextCapacity);
  }
}
