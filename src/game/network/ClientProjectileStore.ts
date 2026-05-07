import type { Entity, EntityId } from '../sim/types';
import type {
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkManager';
import { DGUN_TERRAIN_FOLLOW_HEIGHT, LAND_CELL_SIZE } from '../../config';
import { getSurfaceNormal } from '../sim/Terrain';
import { getUnitGroundZ } from '../sim/unitGeometry';
import { getTurretMountHeight } from '../sim/combat/combatUtils';
import { getBarrelTip, getTurretWorldMount } from '../math';
import { getProjectileConfigForSpawn } from '../sim/projectileConfigs';
import {
  codeToProjectileType,
  isLineProjectileTypeCode,
} from '../../types/network';
import {
  decodeProjectileSourceTurretId,
  ProjectileSpawnQueue,
} from './ProjectileSpawnQueue';
import {
  createBeamPathTarget,
  ensureBeamPoint,
  type BeamPathTarget,
} from './ClientPredictionTargets';
import {
  decodeProjectileShotId,
  isLineProjectileEntity,
} from './ClientProjectileUtils';

type ClientProjectileStoreOptions = {
  entities: Map<EntityId, Entity>;
  getMapWidth: () => number;
  getMapHeight: () => number;
  clearPredictionAccum: (id: EntityId) => void;
  markEntitySetChanged: (invalidateCaches?: boolean) => void;
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

  applyBeamUpdate(update: NetworkServerSnapshotBeamUpdate): void {
    const entity = this.options.entities.get(update.id);
    const proj = entity?.projectile;
    if (!entity || !proj) return;

    let target = this.beamPathTargets.get(update.id);
    if (!target) {
      target = createBeamPathTarget();
      this.beamPathTargets.set(update.id, target);
    }
    target.obstructionT = update.obstructionT;

    const srcPts = update.points;
    const dstTarget = target.points;
    dstTarget.length = srcPts.length;
    for (let i = 0; i < srcPts.length; i++) {
      const sp = srcPts[i];
      const dp = ensureBeamPoint(dstTarget, i);
      dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
      dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
      dp.mirrorEntityId = sp.mirrorEntityId;
    }

    const projPts = proj.points ?? (proj.points = []);
    if (projPts.length === 0) {
      projPts.length = srcPts.length;
      for (let i = 0; i < srcPts.length; i++) {
        const sp = srcPts[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.mirrorEntityId = sp.mirrorEntityId;
      }
      if (srcPts.length > 0) {
        const start = srcPts[0];
        entity.transform.x = start.x;
        entity.transform.y = start.y;
        entity.transform.z = start.z;
      }
    } else if (projPts.length !== srcPts.length) {
      const oldLen = projPts.length;
      projPts.length = srcPts.length;
      for (let i = oldLen; i < srcPts.length; i++) {
        const sp = srcPts[i];
        const pp = ensureBeamPoint(projPts, i);
        pp.x = sp.x; pp.y = sp.y; pp.z = sp.z;
        pp.vx = sp.vx; pp.vy = sp.vy; pp.vz = sp.vz;
        pp.mirrorEntityId = sp.mirrorEntityId;
      }
    }
    proj.obstructionT = update.obstructionT;
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
      if (entity?.projectile?.projectileType === 'projectile') out.push(entity);
    }
    return out;
  }

  collectSmokeTrail(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.options.entities.get(id);
      const profile = entity?.projectile?.config.shotProfile;
      if (
        entity?.projectile?.projectileType === 'projectile' &&
        profile?.visual.smokeTrail
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
      if (entity?.projectile && isLineProjectileEntity(entity)) out.push(entity);
    }
    return out;
  }

  collectBurnMark(out: Entity[]): Entity[] {
    this.collectLine(out);
    for (const id of this.activeProjectilePredictionIds) {
      const entity = this.options.entities.get(id);
      if (entity?.projectile?.projectileType === 'projectile' && entity.dgunProjectile?.isDGun) {
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
    const sourceTurretId = decodeProjectileSourceTurretId(spawn);
    const shotId = decodeProjectileShotId(spawn);
    const config = {
      ...getProjectileConfigForSpawn(sourceTurretId, shotId, spawn.turretIndex),
      turretIndex: spawn.turretIndex,
    };

    let spawnX = spawn.pos.x;
    let spawnY = spawn.pos.y;
    let spawnZ = spawn.pos.z;

    if (
      !isLineProjectileTypeCode(spawn.projectileType) &&
      !spawn.fromParentDetonation
    ) {
      const source = this.options.entities.get(spawn.sourceEntityId);
      const weapon = source?.combat?.turrets?.[spawn.turretIndex];
      if (source && source.unit && weapon) {
        const unitCos = Math.cos(source.transform.rotation);
        const unitSin = Math.sin(source.transform.rotation);
        const sn = getSurfaceNormal(
          source.transform.x, source.transform.y,
          this.options.getMapWidth(), this.options.getMapHeight(), LAND_CELL_SIZE,
        );
        const unitGroundZ = getUnitGroundZ(source);
        const mount = getTurretWorldMount(
          source.transform.x, source.transform.y, unitGroundZ,
          unitCos, unitSin,
          weapon.mount.x, weapon.mount.y, getTurretMountHeight(source, spawn.turretIndex),
          sn,
        );
        const tip = getBarrelTip(
          mount.x, mount.y, mount.z,
          weapon.rotation, weapon.pitch,
          config,
          spawn.barrelIndex,
        );
        spawnX = tip.x;
        spawnY = tip.y;
        spawnZ = tip.z;
      }
    }

    const projectileType = codeToProjectileType(spawn.projectileType);
    if (!projectileType) throw new Error(`Unknown projectile type code: ${spawn.projectileType}`);

    const entity: Entity = {
      id: spawn.id,
      type: 'shot',
      transform: { x: spawnX, y: spawnY, z: spawnZ, rotation: spawn.rotation },
      ownership: { playerId: spawn.playerId },
      projectile: {
        ownerId: spawn.playerId,
        sourceEntityId: spawn.sourceEntityId,
        config,
        shotId: shotId ?? config.shot.id,
        sourceTurretId: sourceTurretId ?? config.sourceTurretId,
        projectileType,
        velocityX: spawn.velocity.x,
        velocityY: spawn.velocity.y,
        velocityZ: spawn.velocity.z,
        timeAlive: 0,
        maxLifespan: spawn.maxLifespan ?? config.shotProfile.runtime.maxLifespan,
        hitEntities: new Set(),
        maxHits: 1,
        points: spawn.beam ? [
          {
            x: spawn.beam.start.x, y: spawn.beam.start.y, z: spawn.beam.start.z,
            vx: 0, vy: 0, vz: 0,
          },
          {
            x: spawn.beam.end.x, y: spawn.beam.end.y, z: spawn.beam.end.z,
            vx: 0, vy: 0, vz: 0,
          },
        ] : undefined,
      },
    };
    if (spawn.isDGun) {
      entity.dgunProjectile = {
        isDGun: true,
        terrainFollow: true,
        groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
      };
    }
    if (spawn.targetEntityId !== undefined && spawn.homingTurnRate) {
      entity.projectile!.homingTargetId = spawn.targetEntityId;
      entity.projectile!.homingTurnRate = spawn.homingTurnRate;
    }
    return entity;
  }
}
