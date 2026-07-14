import type { Entity, EntityId, PlayerId, ProjectileConfig } from '../sim/types';
import { createEmptyEntityComponentSlots, createTransform, getEmissionBlueprintId, isProjectileShot, NO_ENTITY_ID, PROJECTILE_ABSENCE_SLOTS } from '../sim/types';
import type { FootprintBounds } from '../ViewportFootprint';
import type {
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkManager';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { getProjectileConfigForSpawn } from '../sim/projectileConfigs';
import {
  codeToShotBlueprintId,
  codeToProjectileType,
  codeToTurretBlueprintId,
  isLineProjectileTypeCode,
} from '../../types/network';
import {
  decodeProjectileSourceTurretBlueprintId,
  ProjectileSpawnQueue,
} from './ProjectileSpawnQueue';
import {
  createBeamPathTarget,
  ensureBeamPoint,
  shrinkBeamPoints,
  snapBeamPathDisplayToTarget,
  type BeamPathTarget,
} from './ClientPredictionTargets';
import {
  decodeProjectileShotBlueprintId,
  isLineProjectileEntity,
} from './ClientProjectileUtils';
import {
  dequantizeNormal as deqNormal,
  dequantizeProjectilePosition as deqProjPos,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from './snapshotQuantization';
import {
  ClientProjectileRenderSpatialIndex,
  type ClientProjectileRenderLists,
  type ClientProjectileRenderSlotLists,
} from './ClientProjectileRenderSpatialIndex';
import {
  CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK,
  CLIENT_PROJECTILE_RENDER_FLAG_LINE,
  CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL,
  CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING,
  ClientProjectileRenderStateSlab,
  type ClientProjectileRenderStateViews,
} from './ClientProjectileRenderStateSlab';
import { ClientEntityIdSet } from './ClientEntityIdSet';
import {
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
} from './stateSerializerProjectiles';

export type { ClientProjectileRenderLists } from './ClientProjectileRenderSpatialIndex';

type ClientProjectileStoreOptions = {
  entities: Map<EntityId, Entity>;
  handleEntityAdded: (entity: Entity) => void;
};

const PROJECTILE_RENDER_SCOPE_PADDING = 250;
const PROJECTILE_CONFIG_CACHE_UNSET = '~';
const projectileConfigCache = new Map<string, ProjectileConfig>();

function projectileConfigWithTurretIndex(
  sourceTurretBlueprintId: string | undefined,
  shotBlueprintId: string | undefined,
  turretIndex: number,
): ProjectileConfig {
  const cacheKey = `${sourceTurretBlueprintId ?? PROJECTILE_CONFIG_CACHE_UNSET}|${shotBlueprintId ?? PROJECTILE_CONFIG_CACHE_UNSET}|${turretIndex}`;
  const cached = projectileConfigCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const config = getProjectileConfigForSpawn(sourceTurretBlueprintId, shotBlueprintId, turretIndex);
  const resolved = config.turretIndex === turretIndex ? config : { ...config, turretIndex };
  projectileConfigCache.set(cacheKey, resolved);
  return resolved;
}

export class ClientProjectileStore {
  readonly beamPathTargets = new Map<EntityId, BeamPathTarget>();
  readonly activeBeamPathIds = new ClientEntityIdSet();
  readonly activeProjectileMotionIds = new ClientEntityIdSet();
  readonly projectileSpawns = new ProjectileSpawnQueue();

  private lineProjectileRenderVersion = 0;
  private renderListsDirty = true;
  private cachedTravelingProjectiles: Entity[] = [];
  private cachedSmokeTrailProjectiles: Entity[] = [];
  private cachedLineProjectiles: Entity[] = [];
  private cachedBurnMarkProjectiles: Entity[] = [];
  private cachedTravelingProjectileSlots: number[] = [];
  private cachedSmokeTrailProjectileSlots: number[] = [];
  private cachedLineProjectileSlots: number[] = [];
  private cachedBurnMarkProjectileSlots: number[] = [];
  private cachedRenderLists: ClientProjectileRenderLists = {
    traveling: this.cachedTravelingProjectiles,
    smokeTrail: this.cachedSmokeTrailProjectiles,
    line: this.cachedLineProjectiles,
    burnMark: this.cachedBurnMarkProjectiles,
  };
  private cachedRenderSlotLists: ClientProjectileRenderSlotLists = {
    traveling: this.cachedTravelingProjectileSlots,
    smokeTrail: this.cachedSmokeTrailProjectileSlots,
    line: this.cachedLineProjectileSlots,
    burnMark: this.cachedBurnMarkProjectileSlots,
  };
  private renderState = new ClientProjectileRenderStateSlab();
  private renderSpatialIndex = new ClientProjectileRenderSpatialIndex();

  constructor(private readonly options: ClientProjectileStoreOptions) {}

  getLineProjectileRenderVersion(): number {
    return this.lineProjectileRenderVersion;
  }

  markLineProjectilesChanged(): void {
    this.lineProjectileRenderVersion = (this.lineProjectileRenderVersion + 1) & 0x3fffffff;
  }

  private markRenderListsDirty(): void {
    this.renderListsDirty = true;
  }

  getRenderScopePadding(): number {
    return PROJECTILE_RENDER_SCOPE_PADDING;
  }

  private releaseBeamPointsForEntity(entity: Entity | undefined): void {
    const points = entity?.projectile?.points;
    if (points !== null && points !== undefined && points.length > 0) {
      shrinkBeamPoints(points, 0);
    }
  }

  private releaseBeamTarget(id: EntityId): void {
    const target = this.beamPathTargets.get(id);
    if (target !== undefined) {
      shrinkBeamPoints(target.points, 0);
      target.wirePointRowLength = 0;
      this.beamPathTargets.delete(id);
    }
  }

  remove(id: EntityId, wasLineProjectile: boolean, entity?: Entity): void {
    this.releaseBeamTarget(id);
    this.releaseBeamPointsForEntity(entity ?? this.options.entities.get(id));
    this.projectileSpawns.remove(id);
    this.activeProjectileMotionIds.delete(id);
    this.activeBeamPathIds.delete(id);
    this.renderSpatialIndex.remove(id);
    this.renderState.unsetEntity(id);
    this.markRenderListsDirty();
    if (wasLineProjectile) this.markLineProjectilesChanged();
  }

  applySpawn(spawn: NetworkServerSnapshotProjectileSpawn): boolean {
    const { entities } = this.options;
    if (entities.has(spawn.id)) return false;
    try {
      const entity = this.createProjectileFromSpawn(spawn);
      entities.set(spawn.id, entity);
      this.options.handleEntityAdded(entity);
      this.refreshRenderStateAndSpatialIndex(entity);
      if (isLineProjectileTypeCode(spawn.projectileType)) {
        this.activeBeamPathIds.add(spawn.id);
        this.markLineProjectilesChanged();
      } else {
        this.activeProjectileMotionIds.add(spawn.id);
      }
      this.markRenderListsDirty();
      return true;
    } catch {
      return false;
    }
  }

  applySpawnWireFields(values: Float64Array, base: number): boolean {
    const id = values[base + 0] as EntityId;
    const { entities } = this.options;
    if (entities.has(id)) return false;
    try {
      const entity = this.createProjectileFromSpawnWireFields(values, base);
      entities.set(id, entity);
      this.options.handleEntityAdded(entity);
      this.refreshRenderStateAndSpatialIndex(entity);
      if (isLineProjectileTypeCode(values[base + 8])) {
        this.activeBeamPathIds.add(id);
        this.markLineProjectilesChanged();
      } else {
        this.activeProjectileMotionIds.add(id);
      }
      this.markRenderListsDirty();
      return true;
    } catch {
      return false;
    }
  }

  private getBeamUpdateTarget(
    entity: Entity,
    id: EntityId,
    now: number,
  ): BeamPathTarget | null {
    const proj = entity.projectile;
    if (proj === null) return null;

    let target = this.beamPathTargets.get(id);
    if (!target) {
      target = createBeamPathTarget();
      this.beamPathTargets.set(id, target);
    }
    target.updatedAtMs = now;
    return target;
  }

  private applyBeamUpdateHeader(
    target: BeamPathTarget,
    obstructionT: number | null,
    endpointDamageable: boolean | null,
    pointCount: number,
  ): boolean {
    const nextObstructionT = obstructionT === null ? null : deqRot(obstructionT);
    let changed = target.obstructionT !== nextObstructionT ||
      target.endpointDamageable !== endpointDamageable;
    target.obstructionT = nextObstructionT;
    target.endpointDamageable = endpointDamageable;

    const dstTarget = target.points;
    if (dstTarget.length > pointCount) {
      shrinkBeamPoints(dstTarget, pointCount);
      changed = true;
    } else if (dstTarget.length < pointCount) {
      dstTarget.length = pointCount;
      changed = true;
    }
    return changed;
  }

  private finishBeamUpdate(entity: Entity, id: EntityId, target: BeamPathTarget): void {
    const proj = entity.projectile;
    if (proj === null) return;
    const projPts = proj.points ?? (proj.points = []);
    let displayChanged = false;
    if (target.initialSnapPending || projPts.length === 0) {
      displayChanged = snapBeamPathDisplayToTarget(entity, target) || displayChanged;
    }
    const previousEndpointDamageable = proj.endpointDamageable !== false;
    const nextEndpointDamageable = target.endpointDamageable !== false;
    proj.obstructionT = target.obstructionT;
    proj.endpointDamageable = nextEndpointDamageable;
    displayChanged = displayChanged || previousEndpointDamageable !== nextEndpointDamageable;
    let addedActivePath = false;
    if (!this.activeBeamPathIds.has(id)) {
      this.activeBeamPathIds.add(id);
      this.markRenderListsDirty();
      addedActivePath = true;
    }
    if (displayChanged || addedActivePath) {
      this.refreshLineRenderStateAndSpatialIndex(entity, id);
      this.markLineProjectilesChanged();
    }
  }

  applyBeamUpdate(update: NetworkServerSnapshotBeamUpdate, now = performance.now()): void {
    const entity = this.options.entities.get(update.id);
    if (entity === undefined) return;
    const srcPts = update.points;
    const target = this.getBeamUpdateTarget(
      entity,
      update.id,
      now,
    );
    if (target === null) return;
    target.wirePointRowLength = 0;
    target.wireObstructionT = null;
    target.wireEndpointDamageable = null;
    let changed = this.applyBeamUpdateHeader(
      target,
      update.obstructionT,
      update.endpointDamageable,
      srcPts.length,
    );
    const dstTarget = target.points;
    for (let i = 0; i < srcPts.length; i++) {
      const sp = srcPts[i];
      const x = deqProjPos(sp.x);
      const y = deqProjPos(sp.y);
      const z = deqProjPos(sp.z);
      const vx = deqVel(sp.vx);
      const vy = deqVel(sp.vy);
      const vz = deqVel(sp.vz);
      const normalX = sp.normalX === null ? null : deqNormal(sp.normalX);
      const normalY = sp.normalY === null ? null : deqNormal(sp.normalY);
      const normalZ = sp.normalZ === null ? null : deqNormal(sp.normalZ);
      let dp = dstTarget[i];
      if (dp === undefined) {
        dp = ensureBeamPoint(dstTarget, i);
        changed = true;
      } else if (
        dp.x !== x || dp.y !== y || dp.z !== z ||
        dp.vx !== vx || dp.vy !== vy || dp.vz !== vz ||
        dp.reflectorEntityId !== sp.reflectorEntityId ||
        dp.reflectorKind !== sp.reflectorKind ||
        dp.reflectorPlayerId !== sp.reflectorPlayerId ||
        dp.normalX !== normalX ||
        dp.normalY !== normalY ||
        dp.normalZ !== normalZ
      ) {
        changed = true;
      } else {
        continue;
      }
      dp.x = x; dp.y = y; dp.z = z;
      dp.vx = vx; dp.vy = vy; dp.vz = vz;
      dp.reflectorEntityId = sp.reflectorEntityId;
      dp.reflectorKind = sp.reflectorKind;
      dp.reflectorPlayerId = sp.reflectorPlayerId;
      dp.normalX = normalX;
      dp.normalY = normalY;
      dp.normalZ = normalZ;
    }
    if (!changed && this.activeBeamPathIds.has(update.id) && !target.initialSnapPending) return;
    this.finishBeamUpdate(entity, update.id, target);
  }

  applyBeamUpdateWireFields(
    id: EntityId,
    obstructionT: number | null,
    endpointDamageable: boolean | null,
    pointValues: Float64Array,
    pointOffset: number,
    pointCount: number,
    now = performance.now(),
  ): void {
    const cachedTarget = this.beamPathTargets.get(id);
    if (
      cachedTarget !== undefined &&
      !cachedTarget.initialSnapPending &&
      this.activeBeamPathIds.has(id) &&
      this.beamWireRowsMatchTarget(
        cachedTarget,
        obstructionT,
        endpointDamageable,
        pointValues,
        pointOffset,
        pointCount,
      )
    ) {
      cachedTarget.updatedAtMs = now;
      return;
    }
    const entity = this.options.entities.get(id);
    if (entity === undefined) return;
    const target = this.getBeamUpdateTarget(
      entity,
      id,
      now,
    );
    if (target === null) return;
    let changed = this.applyBeamUpdateHeader(
      target,
      obstructionT,
      endpointDamageable,
      pointCount,
    );
    target.wireObstructionT = obstructionT;
    target.wireEndpointDamageable = endpointDamageable;
    const expectedWireLength = pointCount * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
    const canReuseCachedRows = target.wirePointRowLength === expectedWireLength;
    if (target.wirePointRows.length < expectedWireLength) {
      target.wirePointRows = new Float64Array(expectedWireLength);
    }
    target.wirePointRowLength = expectedWireLength;
    const cachedRows = target.wirePointRows;
    const dstTarget = target.points;
    for (let i = 0; i < pointCount; i++) {
      const base = (pointOffset + i) * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
      const cacheBase = i * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
      const existing = dstTarget[i];
      if (
        canReuseCachedRows &&
        existing !== undefined &&
        this.beamWirePointRowMatches(cachedRows, cacheBase, pointValues, base)
      ) {
        continue;
      }
      this.copyBeamWirePointRow(cachedRows, cacheBase, pointValues, base);
      changed = true;
      const flags = pointValues[base + 6];
      const x = deqProjPos(pointValues[base + 0]);
      const y = deqProjPos(pointValues[base + 1]);
      const z = deqProjPos(pointValues[base + 2]);
      const vx = deqVel(pointValues[base + 3]);
      const vy = deqVel(pointValues[base + 4]);
      const vz = deqVel(pointValues[base + 5]);
      let dp = existing;
      if (dp === undefined) {
        dp = ensureBeamPoint(dstTarget, i);
      }
      dp.x = x; dp.y = y; dp.z = z;
      dp.vx = vx; dp.vy = vy; dp.vz = vz;
      dp.reflectorEntityId = (flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0
        ? pointValues[base + 7] as EntityId
        : null;
      dp.reflectorKind = (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND) !== 0
        ? 'shield'
        : null;
      dp.reflectorPlayerId = (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0
        ? pointValues[base + 8] as PlayerId
        : null;
      dp.normalX = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0
        ? deqNormal(pointValues[base + 9])
        : null;
      dp.normalY = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0
        ? deqNormal(pointValues[base + 10])
        : null;
      dp.normalZ = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0
        ? deqNormal(pointValues[base + 11])
        : null;
    }
    if (!changed && this.activeBeamPathIds.has(id) && !target.initialSnapPending) return;
    this.finishBeamUpdate(entity, id, target);
  }

  private beamWireRowsMatchTarget(
    target: BeamPathTarget,
    obstructionT: number | null,
    endpointDamageable: boolean | null,
    pointValues: Float64Array,
    pointOffset: number,
    pointCount: number,
  ): boolean {
    if (
      target.wireObstructionT !== obstructionT ||
      target.wireEndpointDamageable !== endpointDamageable
    ) {
      return false;
    }
    const expectedLength = pointCount * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
    if (target.wirePointRowLength !== expectedLength) return false;
    const cached = target.wirePointRows;
    if (cached.length < expectedLength) return false;
    const sourceBase = pointOffset * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
    for (let i = 0; i < expectedLength; i++) {
      if (cached[i] !== pointValues[sourceBase + i]) return false;
    }
    return true;
  }

  private beamWirePointRowMatches(
    cached: Float64Array,
    cachedBase: number,
    pointValues: Float64Array,
    sourceBase: number,
  ): boolean {
    return cached[cachedBase + 0] === pointValues[sourceBase + 0] &&
      cached[cachedBase + 1] === pointValues[sourceBase + 1] &&
      cached[cachedBase + 2] === pointValues[sourceBase + 2] &&
      cached[cachedBase + 3] === pointValues[sourceBase + 3] &&
      cached[cachedBase + 4] === pointValues[sourceBase + 4] &&
      cached[cachedBase + 5] === pointValues[sourceBase + 5] &&
      cached[cachedBase + 6] === pointValues[sourceBase + 6] &&
      cached[cachedBase + 7] === pointValues[sourceBase + 7] &&
      cached[cachedBase + 8] === pointValues[sourceBase + 8] &&
      cached[cachedBase + 9] === pointValues[sourceBase + 9] &&
      cached[cachedBase + 10] === pointValues[sourceBase + 10] &&
      cached[cachedBase + 11] === pointValues[sourceBase + 11];
  }

  private copyBeamWirePointRow(
    cached: Float64Array,
    cachedBase: number,
    pointValues: Float64Array,
    sourceBase: number,
  ): void {
    cached[cachedBase + 0] = pointValues[sourceBase + 0];
    cached[cachedBase + 1] = pointValues[sourceBase + 1];
    cached[cachedBase + 2] = pointValues[sourceBase + 2];
    cached[cachedBase + 3] = pointValues[sourceBase + 3];
    cached[cachedBase + 4] = pointValues[sourceBase + 4];
    cached[cachedBase + 5] = pointValues[sourceBase + 5];
    cached[cachedBase + 6] = pointValues[sourceBase + 6];
    cached[cachedBase + 7] = pointValues[sourceBase + 7];
    cached[cachedBase + 8] = pointValues[sourceBase + 8];
    cached[cachedBase + 9] = pointValues[sourceBase + 9];
    cached[cachedBase + 10] = pointValues[sourceBase + 10];
    cached[cachedBase + 11] = pointValues[sourceBase + 11];
  }

  markMotionUpdateActive(entity: Entity, id: EntityId): void {
    if (isLineProjectileEntity(entity)) {
      if (!this.activeBeamPathIds.has(id)) {
        this.activeBeamPathIds.add(id);
        this.markRenderListsDirty();
      }
      this.refreshLineRenderStateAndSpatialIndex(entity, id);
      return;
    } else if (!this.activeProjectileMotionIds.has(id)) {
      this.activeProjectileMotionIds.add(id);
      this.markRenderListsDirty();
    }
    const slot = this.renderState.updateProjectilePosition(
      id,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
    );
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderState.getViews(), slot);
    } else {
      this.refreshRenderStateAndSpatialIndex(entity);
    }
  }

  markMotionTargetUpdateActive(entity: Entity, id: EntityId): void {
    if (isLineProjectileEntity(entity)) {
      this.markMotionUpdateActive(entity, id);
      return;
    }
    if (!this.activeProjectileMotionIds.has(id)) {
      this.activeProjectileMotionIds.add(id);
      this.markRenderListsDirty();
    }
  }

  updateRenderSpatialIndex(entity: Entity): void {
    this.refreshRenderStateAndSpatialIndex(entity);
  }

  private rebuildRenderListsIfNeeded(): void {
    if (!this.renderListsDirty) return;
    this.renderListsDirty = false;
    const slotLists = this.cachedRenderSlotLists;
    slotLists.traveling.length = 0;
    slotLists.smokeTrail.length = 0;
    slotLists.line.length = 0;
    slotLists.burnMark.length = 0;
    const views = this.renderState.getViews();

    for (const id of this.activeProjectileMotionIds) {
      const slot = this.refreshProjectileRenderSlotById(id);
      if (slot !== undefined) this.pushSlotRenderLists(slot, views, slotLists);
    }

    for (const id of this.activeBeamPathIds) {
      const slot = this.refreshProjectileRenderSlotById(id);
      if (slot !== undefined) this.pushSlotRenderLists(slot, views, slotLists);
    }
    this.resolveRenderSlotLists(slotLists, this.cachedRenderLists);
  }

  collectRenderLists(
    bounds: FootprintBounds | null,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists {
    if (bounds === null) {
      this.rebuildRenderListsIfNeeded();
      return this.cachedRenderLists;
    }
    const slotLists = this.renderSpatialIndex.queryRenderLists(
      bounds,
      this.cachedRenderSlotLists,
      this.renderState.getViews(),
    );
    return this.resolveRenderSlotLists(slotLists, out);
  }

  clear(): void {
    for (const target of this.beamPathTargets.values()) {
      shrinkBeamPoints(target.points, 0);
    }
    for (const entity of this.options.entities.values()) {
      this.releaseBeamPointsForEntity(entity);
    }
    this.beamPathTargets.clear();
    this.projectileSpawns.clear();
    this.activeProjectileMotionIds.clear();
    this.activeBeamPathIds.clear();
    this.renderSpatialIndex.clear();
    this.renderState.clear();
    this.cachedTravelingProjectiles.length = 0;
    this.cachedSmokeTrailProjectiles.length = 0;
    this.cachedLineProjectiles.length = 0;
    this.cachedBurnMarkProjectiles.length = 0;
    this.cachedTravelingProjectileSlots.length = 0;
    this.cachedSmokeTrailProjectileSlots.length = 0;
    this.cachedLineProjectileSlots.length = 0;
    this.cachedBurnMarkProjectileSlots.length = 0;
    this.renderListsDirty = false;
    this.lineProjectileRenderVersion = 0;
  }

  private refreshProjectileRenderSlotById(id: EntityId): number | undefined {
    const entity = this.options.entities.get(id);
    if (entity === undefined) {
      this.renderState.unsetEntity(id);
      this.renderSpatialIndex.remove(id);
      return undefined;
    }
    return this.refreshRenderStateAndSpatialIndex(entity);
  }

  private refreshRenderStateAndSpatialIndex(entity: Entity): number | undefined {
    const slot = this.renderState.refreshEntity(entity);
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderState.getViews(), slot);
    } else {
      this.renderSpatialIndex.remove(entity.id);
    }
    return slot;
  }

  private refreshLineRenderStateAndSpatialIndex(entity: Entity, id: EntityId): number | undefined {
    const projectile = entity.projectile;
    const slot = projectile === null
      ? undefined
      : this.renderState.updateLineProjectilePath(
          id,
          entity.transform.x,
          entity.transform.y,
          entity.transform.z,
          projectile.points,
        );
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderState.getViews(), slot);
      return slot;
    }
    return this.refreshRenderStateAndSpatialIndex(entity);
  }

  private pushSlotRenderLists(
    slot: number,
    views: ClientProjectileRenderStateViews,
    out: ClientProjectileRenderSlotLists,
  ): void {
    const flags = views.flags[slot];
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING) !== 0) out.traveling.push(slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL) !== 0) out.smokeTrail.push(slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_LINE) !== 0) out.line.push(slot);
    if ((flags & CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK) !== 0) out.burnMark.push(slot);
  }

  private resolveRenderSlotLists(
    slots: ClientProjectileRenderSlotLists,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists {
    this.resolveRenderSlots(slots.traveling, out.traveling);
    this.resolveRenderSlots(slots.smokeTrail, out.smokeTrail);
    this.resolveRenderSlots(slots.line, out.line);
    this.resolveRenderSlots(slots.burnMark, out.burnMark);
    return out;
  }

  private resolveRenderSlots(slots: readonly number[], out: Entity[]): void {
    out.length = 0;
    const views = this.renderState.getViews();
    for (let i = 0; i < slots.length; i++) {
      const entityId = views.entityIds[slots[i]] as EntityId;
      const entity = this.options.entities.get(entityId);
      if (entity !== undefined && entity.projectile !== null) out.push(entity);
    }
  }

  private createProjectileFromSpawn(
    spawn: NetworkServerSnapshotProjectileSpawn,
  ): Entity {
    const sourceTurretBlueprintId = decodeProjectileSourceTurretBlueprintId(spawn);
    const shotBlueprintId = decodeProjectileShotBlueprintId(spawn);
    const config = projectileConfigWithTurretIndex(
      sourceTurretBlueprintId,
      shotBlueprintId,
      spawn.turretIndex,
    );

    const spawnX = deqProjPos(spawn.pos.x);
    const spawnY = deqProjPos(spawn.pos.y);
    const spawnZ = deqProjPos(spawn.pos.z);

    const projectileType = codeToProjectileType(spawn.projectileType);
    if (!projectileType) throw new Error(`Unknown projectile type code: ${spawn.projectileType}`);
    const shotHealth = isProjectileShot(config.shot) ? config.shot.health : 0;
    const spawnHomingTurnRate = spawn.homingTurnRate;
    const homingTurnRate = isProjectileShot(config.shot)
      ? config.shot.homingTurnRate ?? (
          Number.isFinite(spawnHomingTurnRate) && spawnHomingTurnRate !== null && spawnHomingTurnRate > 0
            ? spawnHomingTurnRate
            : null
        )
      : null;

    const entity: Entity = {
      ...createEmptyEntityComponentSlots(),
      id: spawn.id,
      type: 'shot',
      transform: createTransform(spawnX, spawnY, spawnZ, deqRot(spawn.rotation)),
      ownership: { playerId: spawn.playerId },
      projectile: {
        ownerId: spawn.playerId,
        sourceEntityId: spawn.sourceEntityId,
        config,
        shotBlueprintId: shotBlueprintId ?? getEmissionBlueprintId(config.shot),
        shotSource: {
          sourceTurretEntityId: spawn.sourceTurretEntityId,
          sourceHostEntityId: spawn.sourceHostEntityId,
          sourceRootEntityId: spawn.sourceRootEntityId,
          sourcePlayerId: spawn.playerId,
          sourceTeamId: spawn.sourceTeamId,
          sourceTurretBlueprintId: sourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
          sourceShotBlueprintId: shotBlueprintId ?? getEmissionBlueprintId(config.shot),
          spawnTick: spawn.spawnTick,
          parentShotEntityId: spawn.parentShotEntityId,
        },
        sourceTurretBlueprintId: sourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
        ...PROJECTILE_ABSENCE_SLOTS,
        sourceBarrelIndex: spawn.barrelIndex,
        projectileType,
        hp: shotHealth,
        maxHp: shotHealth,
        velocityX: deqVel(spawn.velocity.x),
        velocityY: deqVel(spawn.velocity.y),
        velocityZ: deqVel(spawn.velocity.z),
        timeAlive: 0,
        maxLifespan: spawn.maxLifespan ?? config.shotProfile.runtime.maxLifespan,
        hitEntities: new Set(),
        maxHits: 1,
        isArmed: true,
        shotArmingRadius: 0,
        hasLeftSource: false,
        homingTargetId: NO_ENTITY_ID,
        homingTurnRate,
        endpointDamageable: projectileType !== 'beam' && projectileType !== 'laser',
        segmentLimitReached: false,
        points: spawn.beam ? [
          {
            x: deqProjPos(spawn.beam.start.x),
            y: deqProjPos(spawn.beam.start.y),
            z: deqProjPos(spawn.beam.start.z),
            vx: 0, vy: 0, vz: 0,
            reflectorEntityId: null,
            reflectorKind: null,
            reflectorPlayerId: null,
            normalX: null,
            normalY: null,
            normalZ: null,
          },
          {
            x: deqProjPos(spawn.beam.end.x),
            y: deqProjPos(spawn.beam.end.y),
            z: deqProjPos(spawn.beam.end.z),
            vx: 0, vy: 0, vz: 0,
            reflectorEntityId: null,
            reflectorKind: null,
            reflectorPlayerId: null,
            normalX: null,
            normalY: null,
            normalZ: null,
          },
        ] : null,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = {
        isDGun: true,
        groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
      };
    }
    if (spawn.targetEntityId !== null) {
      entity.projectile!.homingTargetId = spawn.targetEntityId;
    }
    return entity;
  }

  private createProjectileFromSpawnWireFields(
    values: Float64Array,
    base: number,
  ): Entity {
    const flags = values[base + 31] | 0;
    const sourceTurretBlueprintCode = (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0
      ? values[base + 12]
      : null;
    const sourceTurretBlueprintId = sourceTurretBlueprintCode !== null
      ? codeToTurretBlueprintId(sourceTurretBlueprintCode) ?? undefined
      : undefined;
    const resolvedSourceTurretBlueprintId = sourceTurretBlueprintId ??
      codeToTurretBlueprintId(values[base + 10]) ??
      undefined;
    const shotBlueprintId = (flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) !== 0
      ? codeToShotBlueprintId(values[base + 11]) ?? undefined
      : undefined;
    const turretIndex = values[base + 15] | 0;
    const config = projectileConfigWithTurretIndex(
      resolvedSourceTurretBlueprintId,
      shotBlueprintId,
      turretIndex,
    );

    const spawnX = deqProjPos(values[base + 1]);
    const spawnY = deqProjPos(values[base + 2]);
    const spawnZ = deqProjPos(values[base + 3]);

    const projectileTypeCode = values[base + 8];
    const projectileType = codeToProjectileType(projectileTypeCode);
    if (!projectileType) throw new Error(`Unknown projectile type code: ${projectileTypeCode}`);
    const shotHealth = isProjectileShot(config.shot) ? config.shot.health : 0;
    const hasHomingTurnRate = (flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0;
    const spawnHomingTurnRate = hasHomingTurnRate ? values[base + 24] : null;
    const homingTurnRate = isProjectileShot(config.shot)
      ? config.shot.homingTurnRate ?? (
          Number.isFinite(spawnHomingTurnRate) && spawnHomingTurnRate !== null && spawnHomingTurnRate > 0
            ? spawnHomingTurnRate
            : null
        )
      : null;
    const playerId = values[base + 13] as PlayerId;
    const id = values[base + 0] as EntityId;
    const sourceTurretEntityId = (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) !== 0
      ? values[base + 25] as EntityId
      : null;
    const parentShotEntityId = (flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) !== 0
      ? values[base + 30] as EntityId
      : null;
    const hasBeam = (flags & PROJECTILE_SPAWN_FLAG_BEAM) !== 0;

    const entity: Entity = {
      ...createEmptyEntityComponentSlots(),
      id,
      type: 'shot',
      transform: createTransform(spawnX, spawnY, spawnZ, deqRot(values[base + 4])),
      ownership: { playerId },
      projectile: {
        ownerId: playerId,
        sourceEntityId: values[base + 14] as EntityId,
        config,
        shotBlueprintId: shotBlueprintId ?? getEmissionBlueprintId(config.shot),
        shotSource: {
          sourceTurretEntityId,
          sourceHostEntityId: values[base + 26] as EntityId,
          sourceRootEntityId: values[base + 27] as EntityId,
          sourcePlayerId: playerId,
          sourceTeamId: values[base + 28] as PlayerId,
          sourceTurretBlueprintId: resolvedSourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
          sourceShotBlueprintId: shotBlueprintId ?? getEmissionBlueprintId(config.shot),
          spawnTick: values[base + 29],
          parentShotEntityId,
        },
        sourceTurretBlueprintId: resolvedSourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
        ...PROJECTILE_ABSENCE_SLOTS,
        sourceBarrelIndex: values[base + 16] | 0,
        projectileType,
        hp: shotHealth,
        maxHp: shotHealth,
        velocityX: deqVel(values[base + 5]),
        velocityY: deqVel(values[base + 6]),
        velocityZ: deqVel(values[base + 7]),
        timeAlive: 0,
        maxLifespan: (flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0
          ? values[base + 9]
          : config.shotProfile.runtime.maxLifespan,
        hitEntities: new Set(),
        maxHits: 1,
        isArmed: true,
        shotArmingRadius: 0,
        hasLeftSource: false,
        homingTargetId: NO_ENTITY_ID,
        homingTurnRate,
        endpointDamageable: projectileType !== 'beam' && projectileType !== 'laser',
        segmentLimitReached: false,
        points: hasBeam ? [
          {
            x: deqProjPos(values[base + 17]),
            y: deqProjPos(values[base + 18]),
            z: deqProjPos(values[base + 19]),
            vx: 0, vy: 0, vz: 0,
            reflectorEntityId: null,
            reflectorKind: null,
            reflectorPlayerId: null,
            normalX: null,
            normalY: null,
            normalZ: null,
          },
          {
            x: deqProjPos(values[base + 20]),
            y: deqProjPos(values[base + 21]),
            z: deqProjPos(values[base + 22]),
            vx: 0, vy: 0, vz: 0,
            reflectorEntityId: null,
            reflectorKind: null,
            reflectorPlayerId: null,
            normalX: null,
            normalY: null,
            normalZ: null,
          },
        ] : null,
      },
    };
    if ((flags & PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE) !== 0) {
      entity.dgunProjectile = {
        isDGun: true,
        groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
      };
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0) {
      entity.projectile!.homingTargetId = values[base + 23] as EntityId;
    }
    return entity;
  }
}
