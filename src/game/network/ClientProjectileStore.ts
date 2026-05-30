import type { Entity, EntityId } from '../sim/types';
import { createEmptyEntityComponentSlots, createTransform, isProjectileShot, NO_ENTITY_ID, PROJECTILE_ABSENCE_SLOTS } from '../sim/types';
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

type ClientProjectileStoreOptions = {
  entities: Map<EntityId, Entity>;
  clearPredictionAccum: (id: EntityId) => void;
  markEntitySetChanged: (invalidateCaches: boolean | undefined) => void;
};

export class ClientProjectileStore {
  readonly beamPathTargets = new Map<EntityId, BeamPathTarget>();
  readonly activeBeamPathIds = new Set<EntityId>();
  readonly activeProjectilePredictionIds = new Set<EntityId>();
  readonly projectileSpawns = new ProjectileSpawnQueue();

  private lineProjectileRenderVersion = 0;

  constructor(private readonly options: ClientProjectileStoreOptions) {}

  getLineProjectileRenderVersion(): number {
    return this.lineProjectileRenderVersion;
  }

  markLineProjectilesChanged(): void {
    this.lineProjectileRenderVersion = (this.lineProjectileRenderVersion + 1) & 0x3fffffff;
  }

  remove(id: EntityId, wasLineProjectile: boolean): void {
    this.beamPathTargets.delete(id);
    this.projectileSpawns.remove(id);
    this.options.clearPredictionAccum(id);
    this.activeProjectilePredictionIds.delete(id);
    this.activeBeamPathIds.delete(id);
    if (wasLineProjectile) this.markLineProjectilesChanged();
  }

  applySpawn(spawn: NetworkServerSnapshotProjectileSpawn): boolean {
    const { entities } = this.options;
    if (entities.has(spawn.id)) return false;
    try {
      const entity = this.createProjectileFromSpawn(spawn);
      this.options.markEntitySetChanged(false);
      entities.set(spawn.id, entity);
      if (isLineProjectileTypeCode(spawn.projectileType)) {
        this.activeBeamPathIds.add(spawn.id);
        this.markLineProjectilesChanged();
      } else {
        this.activeProjectilePredictionIds.add(spawn.id);
      }
      return true;
    } catch {
      return false;
    }
  }

  applyBeamUpdate(update: NetworkServerSnapshotBeamUpdate, now = performance.now()): void {
    const entity = this.options.entities.get(update.id);
    if (entity === undefined) return;
    const proj = entity.projectile;
    if (proj === null) return;

    let target = this.beamPathTargets.get(update.id);
    if (!target) {
      target = createBeamPathTarget();
      this.beamPathTargets.set(update.id, target);
    }
    target.updatedAtMs = now;
    target.obstructionT = update.obstructionT === null
      ? null
      : deqRot(update.obstructionT);
    target.endpointDamageable = update.endpointDamageable;

    const srcPts = update.points;
    const dstTarget = target.points;
    dstTarget.length = srcPts.length;
    for (let i = 0; i < srcPts.length; i++) {
      const sp = srcPts[i];
      const dp = ensureBeamPoint(dstTarget, i);
      dp.x = deqProjPos(sp.x); dp.y = deqProjPos(sp.y); dp.z = deqProjPos(sp.z);
      dp.vx = deqVel(sp.vx); dp.vy = deqVel(sp.vy); dp.vz = deqVel(sp.vz);
      dp.reflectorEntityId = sp.reflectorEntityId ?? undefined;
      dp.reflectorKind = sp.reflectorKind ?? undefined;
      dp.reflectorPlayerId = sp.reflectorPlayerId ?? undefined;
      dp.normalX = sp.normalX === null ? undefined : deqNormal(sp.normalX);
      dp.normalY = sp.normalY === null ? undefined : deqNormal(sp.normalY);
      dp.normalZ = sp.normalZ === null ? undefined : deqNormal(sp.normalZ);
    }

    const projPts = proj.points ?? (proj.points = []);
    if (projPts.length === 0) {
      projPts.length = srcPts.length;
      for (let i = 0; i < srcPts.length; i++) {
        const sp = dstTarget[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.reflectorEntityId = sp.reflectorEntityId;
        pp.reflectorKind = sp.reflectorKind;
        pp.reflectorPlayerId = sp.reflectorPlayerId;
        pp.normalX = sp.normalX;
        pp.normalY = sp.normalY;
        pp.normalZ = sp.normalZ;
      }
      if (srcPts.length > 0) {
        const start = dstTarget[0];
        entity.transform.x = start.x;
        entity.transform.y = start.y;
        entity.transform.z = start.z;
      }
    } else if (projPts.length !== srcPts.length) {
      const oldLen = projPts.length;
      if (oldLen > srcPts.length) {
        shrinkBeamPoints(projPts, srcPts.length);
      } else {
        projPts.length = srcPts.length;
      }
      for (let i = oldLen; i < srcPts.length; i++) {
        const sp = dstTarget[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.reflectorEntityId = sp.reflectorEntityId;
        pp.reflectorKind = sp.reflectorKind;
        pp.reflectorPlayerId = sp.reflectorPlayerId;
        pp.normalX = sp.normalX;
        pp.normalY = sp.normalY;
        pp.normalZ = sp.normalZ;
      }
    }
    proj.obstructionT = target.obstructionT === null ? undefined : target.obstructionT;
    proj.endpointDamageable = update.endpointDamageable !== false;
    this.activeBeamPathIds.add(update.id);
    this.options.clearPredictionAccum(update.id);
    this.markLineProjectilesChanged();
  }

  markVelocityUpdateActive(entity: Entity, id: EntityId): void {
    if (isLineProjectileEntity(entity)) this.activeBeamPathIds.add(id);
    else this.activeProjectilePredictionIds.add(id);
  }

  collectTraveling(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.options.entities.get(id);
      if (entity === undefined) continue;
      const projectile = entity.projectile;
      if (projectile !== null && projectile.projectileType === 'projectile') out.push(entity);
    }
    return out;
  }

  collectSmokeTrail(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.options.entities.get(id);
      if (entity === undefined) continue;
      const projectile = entity.projectile;
      if (projectile === null || projectile.projectileType !== 'projectile') continue;
      const profile = projectile.config.shotProfile;
      if (
        profile.visual.smokeTrail !== undefined
      ) {
        out.push(entity);
      }
    }
    return out;
  }

  collectLine(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeBeamPathIds) {
      const entity = this.options.entities.get(id);
      if (entity === undefined || entity.projectile === null) continue;
      if (isLineProjectileEntity(entity)) out.push(entity);
    }
    return out;
  }

  collectBurnMark(out: Entity[]): Entity[] {
    this.collectLine(out);
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.options.entities.get(id);
      if (entity === undefined) continue;
      const projectile = entity.projectile;
      const dgunProjectile = entity.dgunProjectile;
      if (
        projectile !== null &&
        projectile.projectileType === 'projectile' &&
        dgunProjectile !== null &&
        dgunProjectile.isDGun
      ) {
        out.push(entity);
      }
    }
    return out;
  }

  clear(): void {
    this.beamPathTargets.clear();
    this.projectileSpawns.clear();
    this.activeProjectilePredictionIds.clear();
    this.activeBeamPathIds.clear();
    this.lineProjectileRenderVersion = 0;
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
        shotBlueprintId: shotBlueprintId ?? config.shot.shotBlueprintId,
        shotSource: {
          sourceTurretEntityId: spawn.sourceTurretEntityId,
          sourceHostEntityId: spawn.sourceHostEntityId,
          sourceRootEntityId: spawn.sourceRootEntityId,
          sourcePlayerId: spawn.playerId,
          sourceTeamId: spawn.sourceTeamId,
          sourceTurretBlueprintId: sourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
          sourceShotBlueprintId: shotBlueprintId ?? config.shot.shotBlueprintId,
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
        hasLeftSource: false,
        homingTargetId: NO_ENTITY_ID,
        endpointDamageable: projectileType !== 'beam' && projectileType !== 'laser',
        segmentLimitReached: false,
        points: spawn.beam ? [
          {
            x: deqProjPos(spawn.beam.start.x),
            y: deqProjPos(spawn.beam.start.y),
            z: deqProjPos(spawn.beam.start.z),
            vx: 0, vy: 0, vz: 0,
          },
          {
            x: deqProjPos(spawn.beam.end.x),
            y: deqProjPos(spawn.beam.end.y),
            z: deqProjPos(spawn.beam.end.z),
            vx: 0, vy: 0, vz: 0,
          },
        ] : undefined,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = {
        isDGun: true,
        groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
      };
    }
    if (spawn.homingTurnRate) {
      entity.projectile!.homingTurnRate = spawn.homingTurnRate;
      if (spawn.targetEntityId !== null) {
        entity.projectile!.homingTargetId = spawn.targetEntityId;
      }
    }
    return entity;
  }
}
