import type { Entity, EntityId, PlayerId } from '../sim/types';
import { createEmptyEntityComponentSlots, createTransform, getEmissionBlueprintId, isProjectileShot, NO_ENTITY_ID, PROJECTILE_ABSENCE_SLOTS } from '../sim/types';
import type { FootprintBounds } from '../ViewportFootprint';
import type {
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkManager';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { getProjectileConfigForSpawn } from '../sim/projectileConfigs';
import {
  codeToProjectileType,
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
} from './stateSerializerProjectiles';

export type { ClientProjectileRenderLists } from './ClientProjectileRenderSpatialIndex';

type ClientProjectileStoreOptions = {
  entities: Map<EntityId, Entity>;
  handleEntityAdded: (entity: Entity) => void;
};

const PROJECTILE_RENDER_SCOPE_PADDING = 250;

export class ClientProjectileStore {
  readonly beamPathTargets = new Map<EntityId, BeamPathTarget>();
  readonly activeBeamPathIds = new ClientEntityIdSet();
  readonly activeProjectilePredictionIds = new ClientEntityIdSet();
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
      this.beamPathTargets.delete(id);
    }
  }

  remove(id: EntityId, wasLineProjectile: boolean, entity?: Entity): void {
    this.releaseBeamTarget(id);
    this.releaseBeamPointsForEntity(entity ?? this.options.entities.get(id));
    this.projectileSpawns.remove(id);
    this.activeProjectilePredictionIds.delete(id);
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
        this.activeProjectilePredictionIds.add(spawn.id);
      }
      this.markRenderListsDirty();
      return true;
    } catch {
      return false;
    }
  }

  private prepareBeamUpdateTarget(
    entity: Entity,
    id: EntityId,
    obstructionT: number | null,
    endpointDamageable: boolean | null,
    pointCount: number,
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
    target.obstructionT = obstructionT === null
      ? null
      : deqRot(obstructionT);
    target.endpointDamageable = endpointDamageable;

    const dstTarget = target.points;
    if (dstTarget.length > pointCount) {
      shrinkBeamPoints(dstTarget, pointCount);
    } else if (dstTarget.length < pointCount) {
      dstTarget.length = pointCount;
    }
    return target;
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
    const target = this.prepareBeamUpdateTarget(
      entity,
      update.id,
      update.obstructionT,
      update.endpointDamageable,
      srcPts.length,
      now,
    );
    if (target === null) return;
    const dstTarget = target.points;
    for (let i = 0; i < srcPts.length; i++) {
      const sp = srcPts[i];
      const dp = ensureBeamPoint(dstTarget, i);
      dp.x = deqProjPos(sp.x); dp.y = deqProjPos(sp.y); dp.z = deqProjPos(sp.z);
      dp.vx = deqVel(sp.vx); dp.vy = deqVel(sp.vy); dp.vz = deqVel(sp.vz);
      dp.reflectorEntityId = sp.reflectorEntityId;
      dp.reflectorKind = sp.reflectorKind;
      dp.reflectorPlayerId = sp.reflectorPlayerId;
      dp.normalX = sp.normalX === null ? null : deqNormal(sp.normalX);
      dp.normalY = sp.normalY === null ? null : deqNormal(sp.normalY);
      dp.normalZ = sp.normalZ === null ? null : deqNormal(sp.normalZ);
    }
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
    const entity = this.options.entities.get(id);
    if (entity === undefined) return;
    const target = this.prepareBeamUpdateTarget(
      entity,
      id,
      obstructionT,
      endpointDamageable,
      pointCount,
      now,
    );
    if (target === null) return;
    const dstTarget = target.points;
    for (let i = 0; i < pointCount; i++) {
      const base = (pointOffset + i) * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
      const flags = pointValues[base + 6];
      const dp = ensureBeamPoint(dstTarget, i);
      dp.x = deqProjPos(pointValues[base + 0]);
      dp.y = deqProjPos(pointValues[base + 1]);
      dp.z = deqProjPos(pointValues[base + 2]);
      dp.vx = deqVel(pointValues[base + 3]);
      dp.vy = deqVel(pointValues[base + 4]);
      dp.vz = deqVel(pointValues[base + 5]);
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
    this.finishBeamUpdate(entity, id, target);
  }

  markVelocityUpdateActive(entity: Entity, id: EntityId): void {
    if (isLineProjectileEntity(entity)) {
      if (!this.activeBeamPathIds.has(id)) {
        this.activeBeamPathIds.add(id);
        this.markRenderListsDirty();
      }
      this.refreshLineRenderStateAndSpatialIndex(entity, id);
      return;
    } else if (!this.activeProjectilePredictionIds.has(id)) {
      this.activeProjectilePredictionIds.add(id);
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

  markVelocityTargetUpdateActive(entity: Entity, id: EntityId): void {
    if (isLineProjectileEntity(entity)) {
      this.markVelocityUpdateActive(entity, id);
      return;
    }
    if (!this.activeProjectilePredictionIds.has(id)) {
      this.activeProjectilePredictionIds.add(id);
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

    for (const id of this.activeProjectilePredictionIds) {
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
    this.activeProjectilePredictionIds.clear();
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
    const config = {
      ...getProjectileConfigForSpawn(sourceTurretBlueprintId, shotBlueprintId, spawn.turretIndex),
      turretIndex: spawn.turretIndex,
    };

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
}
