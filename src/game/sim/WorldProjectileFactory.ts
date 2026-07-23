import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type {
  Entity,
  EntityId,
  PlayerId,
  Projectile,
  ProjectileConfig,
  ProjectileType,
  ShotSource,
  TurretConfig,
} from './types';
import {
  createEmptyEntityComponentSlots,
  createTransform,
  getEmissionBlueprintId,
  isProjectileShot,
  NO_ENTITY_ID,
  PROJECTILE_ABSENCE_SLOTS,
} from './types';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { createProjectileConfigFromTurret } from './projectileConfigs';
import { sanitizeShotArmingRadius } from './combat/shotArming';
import { getShotLocomotionMaxTurnRate } from './shotLocomotion';

export type CreateProjectileProvenance = {
  /** Runtime emission blueprint for this projectile body. Submunitions use child shot blueprint ids here. */
  shotBlueprintId?: string | null;
  /** Immutable source record. Submunitions pass a copy of their parent's source record. */
  shotSource?: ShotSource | null;
  /** Host safety radius copied at launch for projectile arming. */
  shotArmingRadius?: number | null;
};

type WorldProjectileFactoryContext = {
  generateEntityId: () => EntityId;
  getTeamId: (playerId: PlayerId) => number;
  getTick: () => number;
};

export class WorldProjectileFactory {
  private readonly context: WorldProjectileFactoryContext;

  constructor(context: WorldProjectileFactoryContext) {
    this.context = context;
  }

  createDGunProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: TurretConfig,
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const entity = this.createProjectile(
      x, y, velocityX, velocityY, ownerId, sourceEntityId,
      createProjectileConfigFromTurret(config),
      'projectile',
      provenance,
    );

    // Mark as D-gun wave; projectile integration applies gravity plus
    // bounded vertical thrust to ride terrain at this offset.
    entity.dgunProjectile = {
      isDGun: true,
      groundOffset: DGUN_TERRAIN_FOLLOW_HEIGHT,
    };

    // D-gun hits everything (infinite hits).
    if (entity.projectile) {
      entity.projectile.maxHits = Infinity;
      const speed = DMath.hypot(velocityX, velocityY);
      const turretRange = config.turretRange.range;
      if (speed > 1e-6 && Number.isFinite(turretRange) && turretRange > 0) {
        entity.projectile.maxLifespan = (turretRange / speed) * 1000;
      }
    }

    return entity;
  }

  createProjectile(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: ProjectileConfig,
    projectileType: ProjectileType = 'projectile',
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const id = this.context.generateEntityId();

    // Calculate rotation from velocity.
    const rotation = DMath.atan2(velocityY, velocityX);

    // Traveling projectile shots do not carry authored time-to-live values; they
    // terminate through collision/ground physics. Line shots still use
    // this runtime timeout for laser pulse duration.
    const maxLifespan = config.shotProfile.runtime.maxLifespan;
    const shotHealth = isProjectileShot(config.shot) ? config.shot.health : 0;
    const homingTurnRate = isProjectileShot(config.shot)
      ? getShotLocomotionMaxTurnRate(config.shot.shotLocomotion) || null
      : null;

    // Always single hit (DGun overrides maxHits to Infinity after creation).
    const maxHits = 1;
    const shotBlueprintId = provenance !== null && provenance.shotBlueprintId !== undefined && provenance.shotBlueprintId !== null
      ? provenance.shotBlueprintId
      : getEmissionBlueprintId(config.shot);
    const shotSource: ShotSource = provenance !== null && provenance.shotSource !== undefined && provenance.shotSource !== null
      ? { ...provenance.shotSource }
      : {
        sourceTurretEntityId: null,
        sourceHostEntityId: sourceEntityId,
        sourceRootEntityId: sourceEntityId,
        sourcePlayerId: ownerId,
        sourceTeamId: this.context.getTeamId(ownerId),
        sourceTurretBlueprintId: config.sourceTurretBlueprintId,
        sourceShotBlueprintId: shotBlueprintId,
        spawnTick: this.context.getTick(),
        parentShotEntityId: null,
      };
    const authoredShotArmingRadius =
      provenance !== null &&
      provenance.shotArmingRadius !== undefined &&
      provenance.shotArmingRadius !== null
        ? provenance.shotArmingRadius
        : 0;
    const shotArmingRadius = sanitizeShotArmingRadius(authoredShotArmingRadius);

    // Firing paths replace the default z/vz with the authoritative turret
    // center and solved launch vector immediately after construction.
    const projectile: Projectile = {
      ownerId,
      sourceEntityId,
      config,
      shotBlueprintId,
      shotSource,
      sourceTurretBlueprintId: shotSource.sourceTurretBlueprintId ?? config.sourceTurretBlueprintId,
      ...PROJECTILE_ABSENCE_SLOTS,
      projectileType,
      hp: shotHealth,
      maxHp: shotHealth,
      velocityX,
      velocityY,
      velocityZ: 0,
      timeAlive: 0,
      maxLifespan,
      hitEntities: new Set<EntityId>(),
      maxHits,
      // Every physical shot is inert at creation. A zero-radius or
      // missing-host fallback is activated by the first arming update,
      // keeping construction semantics uniform without delaying rays.
      isArmed: projectileType !== 'projectile',
      shotArmingRadius,
      hasLeftSource: false,
      homingTargetId: NO_ENTITY_ID,
      homingTurnRate,
    };

    return {
      ...createEmptyEntityComponentSlots(),
      id,
      type: 'shot',
      transform: createTransform(x, y, 0, rotation),
      ownership: { playerId: ownerId },
      projectile,
    };
  }

  // Create a beam / laser projectile. Beams are instantaneous line
  // weapons — the z coord is the launch-origin altitude at the moment
  // of firing (same altitude for start and end; beams don't droop under
  // gravity). Passing z lets the renderer draw the beam at the right
  // height and lets the damage system's line-sphere test find
  // targets at that altitude instead of assuming z=0.
  createBeam(
    startX: number,
    startY: number,
    beamZ: number,
    endX: number,
    endY: number,
    ownerId: PlayerId,
    sourceEntityId: EntityId,
    config: ProjectileConfig,
    projectileType: 'beam' | 'laser' = 'beam',
    provenance: CreateProjectileProvenance | null = null,
  ): Entity {
    const entity = this.createProjectile(startX, startY, 0, 0, ownerId, sourceEntityId, config, projectileType, provenance);
    entity.transform.z = beamZ;

    if (entity.projectile) {
      // Seed a 2-point open-ended polyline (start, authored range end).
      // The per-tick beam handler will overwrite positions and
      // append/remove reflection vertices each re-trace; we own these
      // objects in place so the array reference is stable across the
      // projectile's lifetime.
      entity.projectile.points = [
        { x: startX, y: startY, z: beamZ, vx: 0, vy: 0, vz: 0, reflectorEntityId: null, reflectorKind: null, reflectorPlayerId: null, normalX: null, normalY: null, normalZ: null },
        { x: endX, y: endY, z: beamZ, vx: 0, vy: 0, vz: 0, reflectorEntityId: null, reflectorKind: null, reflectorPlayerId: null, normalX: null, normalY: null, normalZ: null },
      ];
      entity.projectile.endpointDamageable = false;
      entity.projectile.segmentLimitReached = false;
    }

    return entity;
  }
}
