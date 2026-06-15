import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import {
  getConstructionPieceOpacity,
  getConstructionPieceRenderFraction,
  isBuildInProgress,
  isConstructionPieceMaterialized,
  isShell,
} from '../sim/buildableHelpers';
import { getUnitGroundZ } from '../sim/unitGeometry';

const ENTITY_RENDER_PACKET_INITIAL_CAP = 4096;
const ENTITY_RENDER_REMOVAL_INITIAL_CAP = 256;
const NO_OWNER_ID = 0;
const NO_PASSIVE_TURRET_INDEX = -1;

const ENTITY_RENDER_FLAG_SELECTED = 1;
const ENTITY_RENDER_FLAG_BUILD_IN_PROGRESS = 1 << 1;
const ENTITY_RENDER_FLAG_BODY_MATERIALIZED = 1 << 2;
const ENTITY_RENDER_FLAG_SHELL = 1 << 3;
const ENTITY_RENDER_FLAG_ACTIVE_PREDICTION = 1 << 4;
const ENTITY_RENDER_FLAG_RENDER_DIRTY = 1 << 5;
const ENTITY_RENDER_FLAG_LIFECYCLE_DIRTY = 1 << 6;
const UNIT_RENDER_FLAG_AIRBORNE = 1 << 7;
const UNIT_RENDER_FLAG_HAS_SUSPENSION = 1 << 8;
const EMPTY_TURRETS: readonly Turret[] = [];
const passiveTurretIndexCache = new WeakMap<readonly Turret[], number>();

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

function growUint16(
  source: Uint16Array<ArrayBuffer>,
  nextCapacity: number,
): Uint16Array<ArrayBuffer> {
  const next = new Uint16Array(nextCapacity);
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

function entityRenderFlags(
  entity: Entity,
  activePrediction: boolean,
  renderDirty: boolean,
  lifecycleDirty: boolean,
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
  return flags;
}

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

export class UnitRenderPacket3D {
  private readonly entities: (Entity | undefined)[] = [];
  private readonly turrets: (readonly Turret[] | undefined)[] = [];
  unitBlueprintIds: (string | undefined)[] = [];
  removedIds = new Float64Array(ENTITY_RENDER_REMOVAL_INITIAL_CAP);
  ids = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  ownerIds = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  x = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  y = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  z = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  rotation = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  groundY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  radiusVisual = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalZ = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  yawRate = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  bodyOpacity = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  bodyCenterHeight = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
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
  ): void {
    const unit = entity.unit;
    if (unit === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const combatTurrets = entity.combat?.turrets;
    const turretRows = combatTurrets ?? EMPTY_TURRETS;
    this.entities[cursor] = entity;
    this.turrets[cursor] = turretRows;
    this.unitBlueprintIds[cursor] = unit.unitBlueprintId;
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = entity.transform.z;
    this.rotation[cursor] = entity.transform.rotation;
    this.groundY[cursor] = getUnitGroundZ(entity);
    this.radiusVisual[cursor] = unit.radius.visual || unit.radius.hitbox || 15;
    this.normalX[cursor] = unit.surfaceNormal.nx;
    this.normalY[cursor] = unit.surfaceNormal.ny;
    this.normalZ[cursor] = unit.surfaceNormal.nz;
    this.velocityX[cursor] = unit.velocityX;
    this.velocityY[cursor] = unit.velocityY;
    this.yawRate[cursor] = unit.angularVelocity3?.z ?? 0;
    this.bodyOpacity[cursor] = getConstructionPieceOpacity(entity, 'body');
    this.bodyCenterHeight[cursor] = unit.bodyCenterHeight;
    this.turretCount[cursor] = turretRows.length;
    this.passiveTurretIndex[cursor] = passiveTurretIndex(turretRows);
    let flags = entityRenderFlags(entity, activePrediction, renderDirty, lifecycleDirty);
    const locomotionType = unit.locomotion.type;
    if (locomotionType === 'hover' || locomotionType === 'flying') {
      flags |= UNIT_RENDER_FLAG_AIRBORNE;
    }
    if (unit.suspension !== null) flags |= UNIT_RENDER_FLAG_HAS_SUSPENSION;
    this.flags[cursor] = flags;
    this.count = cursor + 1;
  }

  entityAt(row: number): Entity | undefined {
    return this.entities[row];
  }

  turretsAt(row: number): readonly Turret[] {
    return this.turrets[row] ?? EMPTY_TURRETS;
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
    this.radiusVisual = growFloat32(this.radiusVisual, nextCapacity);
    this.normalX = growFloat32(this.normalX, nextCapacity);
    this.normalY = growFloat32(this.normalY, nextCapacity);
    this.normalZ = growFloat32(this.normalZ, nextCapacity);
    this.velocityX = growFloat32(this.velocityX, nextCapacity);
    this.velocityY = growFloat32(this.velocityY, nextCapacity);
    this.yawRate = growFloat32(this.yawRate, nextCapacity);
    this.bodyOpacity = growFloat32(this.bodyOpacity, nextCapacity);
    this.bodyCenterHeight = growFloat32(this.bodyCenterHeight, nextCapacity);
    this.turretCount = growUint16(this.turretCount, nextCapacity);
    this.passiveTurretIndex = growInt16(this.passiveTurretIndex, nextCapacity);
    this.flags = growUint16(this.flags, nextCapacity);
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
  turretCount = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  flags = new Uint16Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  count = 0;
  removedCount = 0;

  reset(): void {
    this.count = 0;
    this.removedCount = 0;
    this.entities.length = 0;
    this.turrets.length = 0;
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
    this.buildingBlueprintIds[cursor] = entity.buildingBlueprintId;
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = entity.transform.z;
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
    this.turretCount[cursor] = turretRows.length;
    this.flags[cursor] = entityRenderFlags(entity, activePrediction, renderDirty, lifecycleDirty);
    this.count = cursor + 1;
  }

  entityAt(row: number): Entity | undefined {
    return this.entities[row];
  }

  turretsAt(row: number): readonly Turret[] {
    return this.turrets[row] ?? EMPTY_TURRETS;
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
    this.turretCount = growUint16(this.turretCount, nextCapacity);
    this.flags = growUint16(this.flags, nextCapacity);
  }

  private ensureRemovalCapacity(required: number): void {
    if (required <= this.removedIds.length) return;
    let nextCapacity = this.removedIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.removedIds = growFloat64(this.removedIds, nextCapacity);
  }
}
